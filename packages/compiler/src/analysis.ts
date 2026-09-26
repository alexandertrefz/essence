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

// NOTE: What every stage of the Compiler has to say about one source, in one
// list, in the order the lines are written.
//
// ONE description of that, because there are two programs that show it — `esc`
// and the Language Server — and a reader who fixes what their editor underlines
// and then runs `essence check` is owed the same list. Two descriptions were
// two answers: the editor showed syntax and Type errors together while the CLI
// stopped at the first stage that failed, so a syntax error hid every Type
// error from the command line and a Type error hid every Validator Diagnostic
// from both.
//
// EVERY stage runs, always. The Parser recovers and hands on the Program it
// could read; the Enricher types what is left and writes an Error where it
// could not; the Validator judges what the two of them established and stands
// down wherever they did not — see `ValidateOptions`. What that buys is one
// run per mistake instead of one run per stage.

export type Analysis = {
	program: common.typed.Program
	diagnostics: Array<common.Diagnostic>
	annotations: Array<common.TypeAnnotation>
}

export type AnalysisOptions = CompileMode & {
	// NOTE: Only the Language Server sets this, for Hovers over a written Type.
	annotations?: boolean
	// NOTE: The document's own text. Only a test analysis reads it, and only to
	// compile the `@example` blocks of a `§§` block — see `enrichDocument`.
	source?: string
}

// NOTE: One source, from text to verdict — the way in for a caller holding a
// file and nothing else. A Program that writes a Module section is NOT analysed
// through this: what a name it imports resolves to is a question about the
// graph, and `analyseLinkedModules` is where that is answered.
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

// NOTE: The same verdict for a caller that ran the two stages itself. The
// Language Server enriches through a counted door of its own — "how many times
// did answering this request compile something" is what tells a cache that
// works from one that merely exists — so what is shared is the JUDGEMENT rather
// than the calling: what the Validator is told to stand down on, and the order
// the three stages' Diagnostics come out in.
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

// NOTE: Every Module of a linked graph, judged: its own Diagnostics, then the
// Validator's, then what its dependencies came to. The Diagnostics of a Module
// depend on that Module and on what IT reaches — never on the entry the graph
// was loaded from — which is what lets a caller keep the answer for every
// Module one graph touched rather than only for the one that was asked about.
//
// Two passes, because a Module can only be told it depends on a broken one once
// every Module has been judged, and a cycle means a Module may depend on one
// that comes after it.
//
// NOTE: Null when the work was abandoned. A cancelled analysis produces NOTHING
// — half a pass is a Module judged against dependencies that were never judged,
// and a Diagnostic list is not a thing that can be half right.
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

// NOTE: Whether an importer's dependency did not compile: it has errors of its
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

	// NOTE: Every Module with some path to a failed one, so that no walk from a
	// dependency enters a part of the graph that compiled.
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

// NOTE: The Validator, run over a Program that may be nothing like whole — and
// told so. `reported` takes the Compiler's own invariant rails out of the way,
// because every one of them is about what the emitter will be handed and
// nothing is emitted from a Program with an Error in it; the Parser's
// `recovery` takes the checks about a construct being complete out of the way
// of the lines it abandoned. See `ValidateOptions`.
//
// NOTE: A throw is caught here rather than left to the caller. The Validator
// walks a Program two recovering stages built, and a Compiler bug met there
// must cost the reader the Validator's half of the report — not the half that
// already explains what went wrong.
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

// NOTE: Structurally the LSP's own CancellationToken, so a handler can pass the
// one it was handed straight down without wrapping it. Read rather than awaited:
// every stage is synchronous, so the only thing a token can do is stop the NEXT
// one from starting.
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

// NOTE: One Diagnostic per broken dependency rather than per entry naming it:
// six names imported from one file is one thing to go and fix, and six
// underlines saying so is the report burying itself. Reported on the specifier
// of the FIRST entry that names it, in written order, since that is the one a
// reader's eye lands on.
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
