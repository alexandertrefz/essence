import type { common, parser } from "@essence-lang/interfaces"

import type { CompileMode } from "./compileMode"
import {
	collectDiagnostics,
	containsErrors,
	inSourceOrder,
	placelessDiagnostic,
	primary,
	reportError,
} from "./diagnostics/index"
import { enrichDocument, parseDocument } from "./documents"
import type { LinkedModule } from "./modules/index"
import { validate } from "./validator/index"

// What every stage has to say about a source, in one list in line order. The
// CLI and the language server both report it, so they show the same list.
//
// Every stage runs, whatever the earlier ones reported. The parser recovers,
// the enricher writes an Error where it can not type, and the validator stands
// down where they did not establish enough. See `ValidateOptions`.

export type Analysis = {
	program: common.typed.Program
	diagnostics: Array<common.Diagnostic>
	annotations: Array<common.TypeAnnotation>
}

export type AnalysisOptions = CompileMode & {
	// Only the Language Server sets this, for Hovers over a written Type.
	annotations?: boolean
	// Only a test analysis reads it, for the `@example` blocks.
	source?: string
}

// One source on its own. A Program with a Module section goes through
// `analyseLinkedModules`, since its imports resolve in the graph.
export function analyseSource(
	source: string,
	documentPath?: string,
	options: AnalysisOptions = {},
): Analysis {
	let parsed = parseDocument(source, documentPath)

	return analyseEnriched(
		parsed.program,
		parsed.diagnostics,
		enrichDocument(parsed.program, documentPath, {
			...options,
			source: options.source ?? source,
		}),
	)
}

// The same verdict for a caller that parsed and enriched itself, as the
// language server and the CLI do. It shares what the validator is told and the
// order of the report.
export function analyseEnriched(
	parsed: parser.Program,
	parserDiagnostics: Array<common.Diagnostic>,
	enriched: {
		program: common.typed.Program
		diagnostics: Array<common.Diagnostic>
		annotations: Array<common.TypeAnnotation>
	},
): Analysis {
	let earlier = [...parserDiagnostics, ...enriched.diagnostics]

	return {
		program: enriched.program,
		diagnostics: inSourceOrder([
			...earlier,
			...validateGuarded(enriched.program, parsed, earlier),
		]),
		annotations: enriched.annotations,
	}
}

// Every Module of a linked graph, judged. A Module's Diagnostics depend only
// on what it reaches, never on the graph's entry, so a caller may keep them
// all.
//
// The second pass reports broken dependencies, which a cycle may place later.
// Null when cancelled, since half a pass would judge against unjudged Modules.
export function analyseLinkedModules(
	modules: Array<LinkedModule>,
	options: { cancellation?: Cancellation } = {},
): Map<string, Array<common.Diagnostic>> | null {
	let failed = new Set<string>()
	let analyses = new Map<string, Array<common.Diagnostic>>()

	for (let module of modules) {
		if (isCancelled(options.cancellation)) {
			return null
		}

		let filePath = module.module.filePath
		let earlier = [...module.diagnostics]
		let diagnostics = [
			...earlier,
			...validateGuarded(module.program, module.module.program, earlier),
		]

		if (containsErrors(diagnostics)) {
			failed.add(filePath)
		}

		analyses.set(filePath, diagnostics)
	}

	let reachesFailure = failureReach(modules, failed)

	for (let module of modules) {
		if (isCancelled(options.cancellation)) {
			return null
		}

		let filePath = module.module.filePath

		analyses.set(
			filePath,
			inSourceOrder([
				...analyses.get(filePath)!,
				...brokenDependencyDiagnostics(
					module.module.program,
					(specifier) => {
						let dependency =
							module.module.resolutions.get(specifier)

						return (
							dependency !== undefined &&
							reachesFailure(filePath, dependency)
						)
					},
				),
			]),
		)
	}

	return analyses
}

// Whether an importer's dependency did not compile: it has errors of its
// own, or it reaches a Module that has. Paths back through the importer do not
// count, so no Module is told about its own failure coming round a cycle.
function failureReach(
	modules: Array<LinkedModule>,
	failed: Set<string>,
): (importer: string, dependency: string) => boolean {
	let dependenciesOf = new Map<string, Array<string>>()
	let importersOf = new Map<string, Array<string>>()

	for (let module of modules) {
		dependenciesOf.set(module.module.filePath, module.module.dependencies)

		for (let dependency of module.module.dependencies) {
			let importers = importersOf.get(dependency) ?? []

			importers.push(module.module.filePath)
			importersOf.set(dependency, importers)
		}
	}

	// Every Module with a path to a failed one. A walk never enters the rest.
	let reaching = new Set(failed)
	let pending = [...failed]

	while (pending.length > 0) {
		for (let importer of importersOf.get(pending.pop()!) ?? []) {
			if (!reaching.has(importer)) {
				reaching.add(importer)
				pending.push(importer)
			}
		}
	}

	return (importer, dependency) => {
		let seen = new Set([importer])
		let walk = [dependency]

		while (walk.length > 0) {
			let current = walk.pop()!

			if (seen.has(current) || !reaching.has(current)) {
				continue
			}

			if (failed.has(current)) {
				return true
			}

			seen.add(current)
			walk.push(...(dependenciesOf.get(current) ?? []))
		}

		return false
	}
}

// The validator, told what the earlier stages could not establish. See
// `ValidateOptions`. A throw becomes an `internal-error`, so a compiler bug
// costs only the validator's part of the report.
function validateGuarded(
	program: common.typed.Program,
	parsed: parser.Program,
	earlier: Array<common.Diagnostic>,
): Array<common.Diagnostic> {
	try {
		return validate(program, {
			recovery: parsed.recovery,
			reported: containsErrors(earlier),
		})
	} catch (error) {
		return [internalError(error)]
	}
}

// Structurally an LSP cancellation token, so a handler passes its own down.
// The stages are synchronous, so a token only stops the next Module.
export type Cancellation = {
	isCancellationRequested: boolean
}

export function isCancelled(cancellation: Cancellation | undefined): boolean {
	return cancellation?.isCancellationRequested === true
}

export function internalError(error: unknown): common.Diagnostic {
	return placelessDiagnostic(
		"error",
		`Internal Compiler Error: ${
			error instanceof Error ? error.message : String(error)
		}`,
		"internal-error",
	)
}

// One Diagnostic per broken dependency, on the first group that names it.
function brokenDependencyDiagnostics(
	program: parser.Program,
	hasErrors: (specifier: string) => boolean,
): Array<common.Diagnostic> {
	let reported = new Set<string>()
	let sources: Array<parser.ModuleSpecifierNode> = [
		...(program.imports?.groups ?? []),
		...(program.exports?.groups ?? []),
	].map((group) => group.source)

	let { diagnostics } = collectDiagnostics(() => {
		for (let source of sources) {
			if (reported.has(source.path) || !hasErrors(source.path)) {
				continue
			}

			reported.add(source.path)

			reportError(
				`${source.path} has errors of its own`,
				source.position,
				{
					code: "dependency-has-errors",
					labels: [
						primary(source.position, "this Module did not compile"),
					],
					notes: [
						"What a Module exports is read off a Module that compiled. Until that one does, a name this file asks for may resolve to an Error, or not resolve at all.",
					],
					helps: [
						`Open ${source.path} — its own Diagnostics say what is wrong there.`,
					],
				},
			)
		}
	})

	return diagnostics
}
