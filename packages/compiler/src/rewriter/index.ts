import * as path from "node:path"

import { generate } from "@essence-lang/escodegen"
import type { common } from "@essence-lang/interfaces"
import { RUNTIME_DIRECTORY } from "@essence-lang/runtime"
import type * as estree from "estree"

import {
	type ModuleSources,
	moduleSpecifier,
	PRELUDE_SPECIFIER,
} from "../bundler/index"
import { derivedEquatableNamespaceName } from "../enricher/resolvers"
import { openArgumentHoles, typeContainsRefinement } from "../helpers/index"
import {
	defaultOptimiserOptions,
	type OptimiserOptions,
} from "../optimiser/index"
import {
	BUNDLE_TARGET,
	type EmitTarget,
	moduleSpelling,
	RUNTIME_PACKAGE,
	spelledFrom,
} from "./emitTarget"
import { runtimeNamespaceNames } from "./runtimeNamespaces"
import {
	ESSENCE_METHOD_PREFIX,
	essenceMethodIdentifier,
	essenceMethodName,
	essencePropertyName,
	nativeFreeFunctionNames,
	type PreludeFreeFunction,
	type PreludeNamespace,
	stdlibFreeFunctions,
	stdlibPrelude,
	withOptimiserOptions,
} from "./stdlibPrelude"

// NOTE: The builtin Namespaces with a runtime module, re-exported from the file
// that holds the list — every emission site here reads it, and so does
// `pool-constants`, which may not reach this Module without closing a cycle.
export { runtimeNamespaceNames }

// NOTE: The emit target, re-exported from the file that holds it, because this
// is where a caller with a graph to rewrite already is. `esc` keys its cache by
// one before it has decided to emit anything at all, and reaches it through
// `rewriter/emitTarget` instead — a name is not worth loading a Rewriter for.
export {
	BUNDLE_TARGET,
	type EmitTarget,
	emitTargetKey,
	RUNTIME_PACKAGE,
} from "./emitTarget"

// NOTE: The Rewriter is a typed simple Program in, JavaScript source text out —
// no bundling, no minifying, nothing written to disk; that is the Bundler's job.
// It is synchronous and deterministic: the same Program always produces the same
// text. It does read the file system once, indirectly — the standard library
// prelude is built from the sources the loader reads at startup — so "pure" here
// means same input, same output, not "touches nothing".
//
// NOTE: This is the single-file form and stays the DEFAULT: one Program, its
// whole prelude inline, no ESM list either way — a Program's Module sections are
// ignored here, because a lone Program is a bundle of one and has nobody to
// import from or publish to. `rewriteModules` is the other form, and the two
// emit through the same helpers rather than through two copies of them.
export function rewrite(
	program: common.typedSimple.Program,
	// NOTE: The Options the Program was optimised under, so the prelude built
	// below is built under them too — the standard library's bodies are
	// optimised where they are collected, and a Program compiled with a pass
	// turned off must not import a prelude that kept it on.
	optimiserOptions: OptimiserOptions = defaultOptimiserOptions,
): string {
	return withOptimiserOptions(optimiserOptions, () => rewriteProgram(program))
}

function rewriteProgram(program: common.typedSimple.Program): string {
	const prelude = stdlibPrelude()

	// NOTE: The user Program is rewritten FIRST, so that which merged Namespaces
	// it needs can be answered from the finished tree rather than guessed at from
	// the source. Every reference to a Namespace — a plain `Boolean.isNot(…)`
	// call, a conformance witness's `isNot: Boolean.isNot`, a `dispatchMethod`
	// target, an argument to `boundConformance` — is a literal `Identifier` node
	// by this point, however indirectly it was written. A source-level survey
	// would have to know about each of those shapes and would silently drop a
	// Namespace the moment a new one was added.
	const freeFunctions = stdlibFreeFunctions()
	// NOTE: One pool for the whole file, because a lone Program is one emitted
	// Module: the standard library's pooled constants and the Program's own are
	// declared side by side and a constant both of them want is declared once.
	const { value: rewritten, pool } = collectingConstantPool(() => {
		let implementation = rewriteImplementationSection(
			program.implementation,
		)

		return {
			implementation,
			essenceMembers: reachableEssenceMethods(
				prelude,
				implementation,
				freeFunctions,
				[...pooledConstants.values()],
			),
		}
	})
	const bands = essenceMemberBands(rewritten.essenceMembers)
	const constantPool = constantPoolBand(pool, [
		bands.functions,
		bands.values,
		rewritten.implementation,
	])
	const essenceMembers = rewritten.essenceMembers

	const rewrittenProgram: estree.Program = {
		type: "Program",
		sourceType: "module",
		body: [
			// NOTE: Every runtime module, whether this Program names it or not:
			// esbuild shakes an unused `import * as <Name>` away, so the head of
			// a lone Program costs nothing and stays what it always was. A
			// Module of a bundle asks for what it names instead — there are
			// twenty heads to read through there rather than one.
			...runtimeImports(allRuntimeNames()),
			// NOTE: Imports first — an Essence Method's const reads the runtime
			// modules those imports bind. Then the Essence-implemented members,
			// in the two bands `essenceMemberBands` puts them in: the
			// Function-valued ones in any order, and the static Properties, whose
			// values are computed HERE, after them.
			...bands.functions,
			// NOTE: The pooled constants sit BETWEEN the two, and that is the
			// only place they can sit. A pooled conformance witness reads the
			// Function-valued consts above it, and a static Property's value —
			// which runs where its const is emitted — may read a pooled
			// constant, so the band has to stand between what it reads and what
			// reads it.
			...constantPool,
			...bands.values,
			...rewritten.implementation,
		],
	}

	checkEssenceMethodsAreDeclared(
		rewrittenProgram,
		new Set(essenceMembers.keys()),
	)

	return generateProgram(rewrittenProgram)
}

const generateFormat = {
	indent: {
		style: "\t",
		base: 0,
		adjustMultilineComment: false,
	},
	newline: "\n",
	space: " ",
	quotes: "double",
}

// NOTE: What `generateProgram` needs to emit a real source map — the Essence
// text of every Module a `loc.source` can name, keyed by canonical path, so
// the map carries the sources verbatim as `sourcesContent` and a debugger
// needs nothing of the machine that compiled.
export type SourceMapOptions = {
	sourceTexts: ReadonlyMap<string, string>
}

// NOTE: The shape `sourceMapWithCode` answers with. The fork's own
// declarations keep to upstream's documented surface, which predates both the
// `sourceMap: true` mode — each emitted node reads its source off its own
// `loc.source`, which is what lets one Module's map name several real files —
// and this return shape, so the one call is cast, here and nowhere else.
type GeneratedWithSourceMap = {
	code: string
	map: {
		toJSON(): {
			version: number
			sources: Array<string>
			names: Array<string>
			mappings: string
			file?: string
			sourcesContent?: Array<string | null>
		}
	}
}

function generateProgram(
	program: estree.Program,
	sourceMap?: SourceMapOptions,
): string {
	if (sourceMap === undefined) {
		return generate(program, { format: generateFormat })
	}

	let { code, map } = generate(program, {
		format: generateFormat,
		sourceMap: true,
		sourceMapWithCode: true,
	} as never) as unknown as GeneratedWithSourceMap

	let json = map.toJSON()

	json.sourcesContent = json.sources.map(
		(source) => sourceMap.sourceTexts.get(source) ?? null,
	)

	return `${code}\n${sourceMapComment(json)}`
}

// NOTE: The map rides INSIDE the module's text, as an inline data URL —
// esbuild reads a `sourceMappingURL` comment off the contents a plugin serves
// and composes it into the bundle's map, which is the one seam the in-memory
// `essence:` scheme offers; a file next to something that never touches disk
// does not exist.
function sourceMapComment(map: object): string {
	let encoded = Buffer.from(JSON.stringify(map)).toString("base64")

	return `//# sourceMappingURL=data:application/json;base64,${encoded}`
}

// NOTE: The prelude gets no map — not even an empty one, which esbuild
// ignores outright and self-maps anyway. Its lines arrive in the bundle's map
// labelled with the synthetic specifier, and the Bundler's final pass strips
// every source that is not an on-disk `.es` file, prelude and inlined runtime
// alike, so a debugger sees the glue as unmapped code to step over.

// NOTE: One Module of a bundle: the canonical path it is keyed by — which is
// also what the Choices it declares take their identity from — and the Program
// that path parsed into.
export type ModuleInput = {
	filePath: string
	program: common.typedSimple.Program
	// NOTE: The Module's Essence source, verbatim — read only when source maps
	// are emitted, where it becomes the map's `sourcesContent` entry.
	sourceText?: string
}

// NOTE: A whole graph of Modules, emitted as one bundle's worth of JavaScript.
//
// The prelude is what makes this more than N calls to `rewrite`. A Program's
// Essence-implemented standard library Methods are emitted as top-level
// `$es_<Namespace>_<member>` consts, and rewriting each Module on its own would
// give every one of them its own copy — a bundle carrying as many `List::sorted`
// as there are Modules that reach it. So the bodies are rewritten first, the
// existing reachability fixed point is run ONCE over their union, and the
// consts are emitted into one synthetic Module every other one imports what it
// names from.
//
// NOTE: The runtime Namespace imports are per Module and per name here, where a
// single-file Program emits all of them unconditionally. Both answers are
// correct — esbuild shakes an unused `import * as <Name>` away — and this one
// keeps a Module's emitted head to what its body actually reads, which is worth
// having when there are twenty of them to read through.
export function rewriteModules(
	modules: Array<ModuleInput>,
	entryPath: string,
	options?: {
		sourcemap?: boolean
		optimiser?: OptimiserOptions
		emit?: EmitTarget
	},
): ModuleSources {
	return withOptimiserOptions(
		options?.optimiser ?? defaultOptimiserOptions,
		() => rewriteModuleGraph(modules, entryPath, options),
	)
}

function rewriteModuleGraph(
	modules: Array<ModuleInput>,
	entryPath: string,
	options?: { sourcemap?: boolean; emit?: EmitTarget },
): ModuleSources {
	let target = options?.emit ?? BUNDLE_TARGET
	let spellingDirectory = spelledFrom(entryPath, target)
	let spellings = new Map(
		modules.map((module) => [
			module.filePath,
			moduleSpelling(spellingDirectory, module.filePath),
		]),
	)
	let sourceTexts: ReadonlyMap<string, string> | null =
		options?.sourcemap === true
			? new Map(
					modules.flatMap((module) =>
						module.sourceText === undefined
							? []
							: [[module.filePath, module.sourceText] as const],
					),
				)
			: null

	return withEmission({ spellings, target }, () => {
		let prelude = stdlibPrelude()
		let freeFunctions = stdlibFreeFunctions()
		// NOTE: A pool per Module, because a Module's constants are declared in
		// it and a name declared in one Module is not in scope in another. The
		// band is built here, before anything is asked of the Module's names:
		// what a Module READS includes what its pooled constants read, and the
		// runtime imports and the prelude import are both decided by that.
		let bodies = modules.map((module) => {
			let { value: body, pool } = collectingConstantPool(() =>
				withSourcePath(module.filePath, () =>
					rewriteImplementationSection(module.program.implementation),
				),
			)

			return { module, body, pool: constantPoolBand(pool, body) }
		})

		let { value: essenceMembers, pool: preludePool } =
			collectingConstantPool(() =>
				reachableEssenceMethods(
					prelude,
					bodies.flatMap((rewritten) => rewritten.body),
					freeFunctions,
					bodies.map((rewritten) => rewritten.pool),
					// NOTE: A host's prelude holds the WHOLE standard library,
					// because what a graph reaches is a property of the graph
					// and the prelude is served to the host under one name for
					// every graph the build compiles. Two entries would
					// otherwise agree on the name and disagree on what is in
					// it, and whichever the host loaded first would answer for
					// both — the other's Modules importing consts that are not
					// there. Emitting all of them is what makes the answer a
					// function of the standard library alone, and the host
					// shakes away what its own build never names.
					target.mode === "host" ? "whole" : "reached",
				),
			)

		let declared = new Set(essenceMembers.keys())
		let sources = new Map<string, string>()
		let preludeProgram = preludeModule(essenceMembers, preludePool)

		checkEssenceMethodsAreDeclared(preludeProgram, declared)
		sources.set(PRELUDE_SPECIFIER, generateProgram(preludeProgram))

		for (let { module, body, pool } of bodies) {
			let names = referencedNames([body, pool])
			let preludeNames = [...essenceMembers.keys()].filter((name) =>
				names.has(name),
			)

			let moduleProgram: estree.Program = {
				type: "Program",
				sourceType: "module",
				body: [
					...runtimeImports(names),
					...(preludeNames.length === 0
						? []
						: [
								namedImport(
									preludeNames.map((name) => [name, name]),
									PRELUDE_SPECIFIER,
								),
							]),
					...moduleImports(module.program, spellings),
					...pool,
					...body,
					...moduleExports(module.program, spellings),
				],
			}

			checkEssenceMethodsAreDeclared(moduleProgram, declared)
			sources.set(
				moduleSpecifier(spellings.get(module.filePath)!),
				generateProgram(
					moduleProgram,
					sourceTexts === null ? undefined : { sourceTexts },
				),
			)
		}

		return {
			entry: moduleSpecifier(
				spellings.get(entryPath) ??
					moduleSpelling(spellingDirectory, entryPath),
			),
			sources,
		}
	})
}

// NOTE: The shared prelude, as its own Module: the runtime imports its consts
// read, the consts themselves in the two bands `orderEssenceMembers` puts them
// in, and one export list naming every one of them. Every const is exported
// whether or not anything imports it — esbuild shakes the unimported ones away,
// and deciding here which are named would mean running the fixed point once per
// Module to find out.
function preludeModule(
	members: Map<string, EssenceMember>,
	pool: Map<string, PooledConstant>,
): estree.Program {
	let bands = essenceMemberBands(members)
	let constantPool = constantPoolBand(pool, [bands.functions, bands.values])
	let names = [...members.keys()]

	return {
		type: "Program",
		sourceType: "module",
		body: [
			...runtimeImports(
				referencedNames([bands.functions, constantPool, bands.values]),
			),
			...bands.functions,
			...constantPool,
			...bands.values,
			...(names.length === 0
				? []
				: [namedExport(names.map((name) => [name, name]))]),
		],
	}
}

// NOTE: The three runtime modules that are not a builtin Namespace, under the
// aliases every emission site reads them by.
const runtimeModuleAliases = [
	["$_", "functions"],
	["$type", "type"],
	["$helpers", "internalHelpers"],
] as const

function allRuntimeNames(): Set<string> {
	return new Set([
		...runtimeNamespaceNames,
		...runtimeModuleAliases.map(([name]) => name),
	])
}

// NOTE: The `import * as <Name>` head of one emitted module, restricted to the
// runtime modules the given names mention — the whole set for a lone Program,
// what its body reads for a Module of a bundle. `referencedNames` over-collects,
// which is the safe direction: an import nothing reads costs a line esbuild
// removes, while a missing one is a `ReferenceError` out of a Program that
// compiled green.
function runtimeImports(
	names: ReadonlySet<string>,
): Array<estree.ImportDeclaration> {
	let imports: Array<estree.ImportDeclaration> = []

	for (let name of runtimeNamespaceNames) {
		if (names.has(name)) {
			imports.push(internalImport([importNamespaceSpecifier(name)], name))
		}
	}

	for (let [name, fileName] of runtimeModuleAliases) {
		if (names.has(name)) {
			imports.push(
				internalImport([importNamespaceSpecifier(name)], fileName),
			)
		}
	}

	return imports
}

// NOTE: What one Module imports from the others, grouped per Module so the
// emitted head reads like the source's own block. An entry whose name erases —
// a Type Alias, a Choice, a Protocol — contributes nothing to bind, but the
// Module it names still has to RUN before this one, and in the order the source
// states: so a dependency left without a single named binding gets a bare
// `import "…"` instead. Without it a Module whose only export is a Type would
// have its top-level Statements run wherever the bundler happened to place it,
// or not at all.
function moduleImports(
	program: common.typedSimple.Program,
	spellings: ReadonlyMap<string, string>,
): Array<estree.ImportDeclaration> {
	let named = new Map<string, Array<[string, string]>>()
	let mentioned: Array<string> = []

	let mention = (specifier: string): void => {
		if (!named.has(specifier)) {
			named.set(specifier, [])
			mentioned.push(specifier)
		}
	}

	for (let entry of program.imports?.entries ?? []) {
		let specifier = specifierOf(entry.modulePath, spellings)

		if (specifier === null) {
			continue
		}

		mention(specifier)

		if (entry.runtime) {
			named
				.get(specifier)!
				.push([
					escapeName(entry.name),
					escapeName(entry.alias ?? entry.name),
				])
		}
	}

	// NOTE: A re-export names a Module this one never binds anything from, and
	// it is a dependency all the same — a facade whose only mention of a Module
	// is one of these still has to run it.
	for (let entry of program.exports?.entries ?? []) {
		let specifier = specifierOf(entry.modulePath, spellings)

		if (specifier !== null && !entry.runtime) {
			mention(specifier)
		}
	}

	return mentioned.map((specifier) =>
		namedImport(named.get(specifier)!, specifier),
	)
}

// NOTE: What one Module publishes, under the name its export block gave it. A
// re-export forwards straight from the Module it names — it was never bound
// here, so there is nothing local to forward — and an entry whose name erases
// publishes nothing at all: `moduleImports` above is what keeps that Module's
// body running anyway.
function moduleExports(
	program: common.typedSimple.Program,
	spellings: ReadonlyMap<string, string>,
): Array<estree.ExportNamedDeclaration> {
	let local: Array<[string, string]> = []
	let forwarded = new Map<string, Array<[string, string]>>()

	for (let entry of program.exports?.entries ?? []) {
		if (!entry.runtime) {
			continue
		}

		let names: [string, string] = [
			escapeName(entry.name),
			escapeName(entry.alias ?? entry.name),
		]
		let specifier = specifierOf(entry.modulePath, spellings)

		if (specifier === null) {
			local.push(names)

			continue
		}

		let entries = forwarded.get(specifier)

		if (entries === undefined) {
			forwarded.set(specifier, [names])
		} else {
			entries.push(names)
		}
	}

	return [
		...(local.length === 0 ? [] : [namedExport(local)]),
		...[...forwarded].map(([specifier, names]) =>
			namedExport(names, specifier),
		),
	]
}

function specifierOf(
	modulePath: string | null,
	spellings: ReadonlyMap<string, string>,
): string | null {
	if (modulePath === null) {
		return null
	}

	let spelling = spellings.get(modulePath)

	return spelling === undefined ? null : moduleSpecifier(spelling)
}

function namedImport(
	names: Array<[string, string]>,
	specifier: string,
): estree.ImportDeclaration {
	return {
		type: "ImportDeclaration",
		specifiers: names.map(([imported, local]) => ({
			type: "ImportSpecifier",
			imported: { type: "Identifier", name: imported },
			local: { type: "Identifier", name: local },
		})),
		attributes: [],
		source: { type: "Literal", value: specifier },
	}
}

function namedExport(
	names: Array<[string, string]>,
	specifier?: string,
): estree.ExportNamedDeclaration {
	return {
		type: "ExportNamedDeclaration",
		declaration: null,
		specifiers: names.map(([local, exported]) => ({
			type: "ExportSpecifier",
			local: { type: "Identifier", name: local },
			exported: { type: "Identifier", name: exported },
		})),
		attributes: [],
		...(specifier === undefined
			? {}
			: { source: { type: "Literal" as const, value: specifier } }),
	}
}

// NOTE: What is being emitted, for the emission sites that can not be handed it
// — the spellings of every Module of the graph, and the target they were
// spelled for. Empty and `bundle` outside `rewriteModules`: a single-file
// Program's Case tags and Type descriptors come out byte for byte as they did
// before Modules, because a Choice identified by its bare name has no path in
// it to render.
type Emission = {
	spellings: ReadonlyMap<string, string>
	target: EmitTarget
}

let emission: Emission = { spellings: new Map(), target: BUNDLE_TARGET }

// NOTE: `finally`, for the same reason the Namespace scope stack has one: a
// throw out of the emission of one bundle must not leave the next Program in
// this process rendering its tags against a graph it is not part of.
function withEmission<Value>(next: Emission, emit: () => Value): Value {
	emission = next

	try {
		return emit()
	} finally {
		emission = { spellings: new Map(), target: BUNDLE_TARGET }
	}
}

// NOTE: The canonical path of the Module currently being emitted — what a
// node's `loc` names as its source. Null everywhere outside `rewriteModules`'
// per-Module pass: the prelude and the single-file form then attach no `loc`
// and emit no mapping.
let currentSourcePath: string | null = null

function withSourcePath<Value>(
	sourcePath: string | null,
	emit: () => Value,
): Value {
	let previousSourcePath = currentSourcePath
	currentSourcePath = sourcePath

	try {
		return emit()
	} finally {
		currentSourcePath = previousSourcePath
	}
}

// NOTE: What the Compiler emits of its OWN accord, which no source names and
// nothing should map to. It is the same answer `locOf` gives outside a Module —
// no source path, no `loc`, no mapping — asked for deliberately rather than by
// standing where no Module is being emitted.
function unmapped<Value>(emit: () => Value): Value {
	return withSourcePath(null, emit)
}

// NOTE: An Essence Position is 1-based on both axes, while escodegen reads
// estree's convention — 1-based lines, 0-based columns. Undefined whenever the
// node carries no position (the Simplifier synthesized it) or no Module is
// being emitted; escodegen then emits the segment unmapped, which is exactly
// what a debugger should see of code no source was written for.
function locOf(
	position: common.Position | undefined,
): estree.SourceLocation | undefined {
	if (position === undefined || currentSourcePath === null) {
		return undefined
	}

	return {
		source: currentSourcePath,
		start: {
			line: position.start.line,
			column: position.start.column - 1,
		},
		end: {
			line: position.end.line,
			column: position.end.column - 1,
		},
	}
}

// NOTE: One nominal identity as the emitted Modules spell it. A Case tag is
// `<Choice identity>#<Case>` and a Choice identity is `<Module path>#<Choice>`,
// so what arrives here carries the canonical path of the Module that declared
// it — which is a place on the machine that compiled and must not be emitted.
// The path is replaced by the spelling the target decided and nothing else
// changes, so the tag a value is stamped with and the tag a Type descriptor
// compares it against are rendered by this one answer and can not disagree.
//
// NOTE: Every string of an emitted Type descriptor comes through here, not just
// the ones known to be tags. Over-rendering is impossible rather than merely
// unlikely: a Module path is absolute, and no other string a descriptor can
// hold — a Type's `type`, a Namespace's name, a Record member — is.
function renderIdentity(text: string): string {
	for (let [modulePath, spelling] of emission.spellings) {
		if (text.startsWith(`${modulePath}#`)) {
			return `${spelling}${text.slice(modulePath.length)}`
		}
	}

	return text
}

// NOTE: The same answer for a caller that holds one identity and the compile it
// belongs to, and no graph — a host building a Case value has to stamp it with
// the tag the emitted values carry, and that tag is spelled relative to
// something. The rule is stated once, above; this reaches it from outside, and
// takes the target so that a descriptor written beside a host's Modules agrees
// with the Modules rather than with a bundle nobody emitted.
//
// NOTE: Where a Module path ENDS is decided by the last `#` rather than by the
// spellings map, because a Choice name can hold no `#` — the same split
// `displayChoiceName` reads a Choice's name by. An identity with no `#` at all
// is a builtin Choice's bare name (`Optional`, `Ordering`), which is emitted
// verbatim, and a prefix that is not absolute is not a Module path, so neither
// is rewritten.
export function emittedIdentity(
	entryPath: string,
	identity: string,
	target: EmitTarget = BUNDLE_TARGET,
): string {
	let separator = identity.lastIndexOf("#")
	let modulePath = identity.slice(0, separator)

	if (separator === -1 || !path.isAbsolute(modulePath)) {
		return identity
	}

	return `${moduleSpelling(
		spelledFrom(entryPath, target),
		modulePath,
	)}${identity.slice(separator)}`
}

function rewriteImplementationSection(
	implementation: common.typedSimple.ImplementationSectionNode,
): Array<estree.ModuleDeclaration | estree.Statement> {
	// NOTE: The outermost block a user Namespace can be declared in, and a Scope
	// of its own for the same reason every inner block is one — the Enricher
	// refuses a top-level `namespace List` today, but nothing here rests on that.
	return withNamespaceScope(() =>
		implementation.nodes.flatMap((node) => rewriteStatements(node)),
	)
}

// #region Statements

// NOTE: One Statement in, the Statements it emits out — plural, because exactly
// one shape needs two: a Variable Declaration whose value a lowered Match or a
// lowered dispatch computes declares its name BEFORE the block that computes it,
// so the name outlives the block. Every other Statement is one, and each of them
// carries the Position of the Node it came from.
function rewriteStatements(
	node: common.typedSimple.ImplementationNode,
): Array<estree.Statement> {
	let statements =
		node.nodeType === "IntrinsicStatement"
			? rewriteIntrinsicStatement(node)
			: [rewriteStatementByKind(node)]

	return withStatementLocation(statements, node.position)
}

function withStatementLocation(
	statements: Array<estree.Statement>,
	position: common.Position | undefined,
): Array<estree.Statement> {
	let loc = locOf(position)

	if (loc !== undefined) {
		for (let statement of statements) {
			statement.loc = loc
		}
	}

	return statements
}

function rewriteStatementByKind(
	node: Exclude<
		common.typedSimple.ImplementationNode,
		common.typedSimple.IntrinsicStatementNode
	>,
): estree.Statement {
	switch (node.nodeType) {
		case "VariableDeclarationStatement":
			return rewriteVariableDeclarationStatement(node)
		case "NamespaceDefinitionStatement":
			return rewriteNamespaceDefinitionStatement(node)
		case "TypeAliasStatement":
			return rewriteTypeAliasStatement(node)
		case "ProtocolDeclarationStatement":
			return rewriteProtocolDeclarationStatement(node)
		case "ConditionalStatement":
			return rewriteConditionalStatement(node)
		case "ReturnStatement":
			return rewriteReturnStatement(node)
		case "FunctionStatement":
			return rewriteFunctionStatement(node)
		default:
			return rewriteExpressionStatement(node)
	}
}

function rewriteVariableDeclarationStatement(
	node: common.typedSimple.VariableDeclarationStatementNode,
): estree.VariableDeclaration {
	return {
		type: "VariableDeclaration",
		declarations: [
			{
				type: "VariableDeclarator",
				id: rewriteIdentifier(node.name),
				init: rewriteExpression(node.value),
			},
		],
		kind: node.isConstant ? "const" : "let",
	}
}

function rewriteNamespaceDefinitionStatement(
	node: common.typedSimple.NamespaceDefinitionStatementNode,
): estree.ClassDeclaration {
	// NOTE: Declared BEFORE the body is rewritten, because a Namespace is in
	// scope inside its own Methods — `quadrupledValue` calling `@::doubledValue()`
	// is a reference to the class being declared — so the two have to agree on
	// the escaped name from the first Method onward.
	declareUserNamespace(node.name.name)

	return {
		type: "ClassDeclaration",
		id: {
			type: "Identifier",
			name: namespaceIdentifierName(node.name.name),
		},
		superClass: null,
		body: {
			type: "ClassBody",
			body: [
				...Object.entries(
					node.properties,
				).map<estree.PropertyDefinition>(([name, value]) => {
					return {
						type: "PropertyDefinition",
						key: memberKey(namespaceMemberName(name)),
						value: rewriteExpression(value),
						computed: false,
						static: true,
					}
				}),
				...Object.entries(node.methods).map<estree.MethodDefinition>(
					([name, method]) => {
						return {
							type: "MethodDefinition",
							key: memberKey(namespaceMemberName(name)),
							value: rewriteFunctionExpression(
								method.method.value,
							),
							kind: "method",
							computed: false,
							static: true,
						}
					},
				),
			],
		},
	}
}

// NOTE: One Essence-implemented standard library Method, emitted as its own
// top-level const:
//
//   const $es_Boolean_isNot = function (_self, other) { … }
//
// A native of the same Namespace stays a member read off the plain
// `import * as <Namespace>`, so the two live side by side without either being
// a member of the other — which is the whole point: nothing has to materialise
// a module namespace object, so the natives the Program does not use stay
// shakeable. `builtins.spec` fails a Method implemented in BOTH a runtime export
// and here, so the TypeScript is deleted in the same commit that writes the
// Essence.
//
// NOTE: The member name is taken exactly as the Simplifier produced it, so an
// Overload's const is named for N its position in the METHOD TYPE's Overloads,
// not among the bodied ones — a block that binds Overload 1 to the runtime and
// writes Overload 2 in Essence emits `$es_X_m__overload$2`, and the native's
// `X.m__overload$1` is untouched.
function rewriteEssenceMethod(
	namespaceName: string,
	memberName: string,
	method: common.typedSimple.Method,
): estree.VariableDeclaration {
	return {
		type: "VariableDeclaration",
		kind: "const",
		declarations: [
			{
				type: "VariableDeclarator",
				id: {
					type: "Identifier",
					name: essenceMethodIdentifier(namespaceName, memberName),
				},
				init: rewriteFunctionExpression(method.method.value),
			},
		],
	}
}

// NOTE: One Essence-implemented standard library Property, emitted as its own
// top-level const — the value band's counterpart of `rewriteEssenceMethod`. A
// `static EMPTY: String = ""` becomes:
//
//   const $es_String_EMPTY = String.createString("")
//
// The name is the ONE `essenceMethodIdentifier` spells, so a read of the Property
// and a call of a Method are indistinguishable to everything downstream — which
// is why a Namespace may not spell a Property and a Method alike.
//
// NOTE: What makes this a band of its own rather than another const beside the
// Methods: the initialiser runs where the const is emitted. A value-LESS static
// Property is a native and never reaches here, so a Namespace's constants keep
// binding to the runtime until someone gives one a body.
function rewriteEssenceProperty(
	namespaceName: string,
	memberName: string,
	value: common.typedSimple.ExpressionNode,
): estree.VariableDeclaration {
	return {
		type: "VariableDeclaration",
		kind: "const",
		declarations: [
			{
				type: "VariableDeclarator",
				id: {
					type: "Identifier",
					name: essenceMethodIdentifier(namespaceName, memberName),
				},
				init: rewriteExpression(value),
			},
		],
	}
}

// NOTE: The two edge sets one body draws. `references` is every `$es_…` const it
// names at all, which is what reachability follows — a const named anywhere in an
// emitted body has to be emitted. `evaluatedReferences` is the subset whose value
// the body needs THE MOMENT IT RUNS: a static Property, read for its value, and a
// Function it CALLS rather than hands on. That subset is what orders the value
// band, and it is a subset because a Function named as a value runs later — a
// conformance witness's `{ isNot: Boolean.isNot }` and a
// `static F = Boolean.isNot` alike — so ordering against what its body reads
// would refuse a Program that runs.
export type EssenceMemberReferences = {
	references: Set<string>
	evaluatedReferences: Set<string>
}

// NOTE: One member the emitted Program needs, and the KIND that decides which
// band it is emitted in. The kind can NOT be read back off the declaration or
// the name: a Method's const and a Property's const are both a
// `VariableDeclaration` named `$es_<Namespace>_<member>`, and the Map they arrive
// in is in discovery order, which is the user Program's business rather than the
// library's. The edges come along for the same reason — which Properties a
// Property reads is what orders the value band.
export type EssenceMember = {
	kind: "function" | "value"
	declaration: estree.VariableDeclaration | estree.FunctionDeclaration
} & EssenceMemberReferences

// NOTE: The reachable members in the order they are emitted, in two bands.
//
// A Function-valued member — an Essence Method's const, a bodied free Function's
// declaration — may sit anywhere: its body runs only when something CALLS it,
// long after every const is initialised, so one naming another, or naming
// itself, resolves at call time regardless of declaration order. They keep
// discovery order, which is what makes an ordinary Program's emission
// byte-identical.
//
// A static Property's const holds the value itself, computed the moment the
// const is reached, so the band is ordered: a Property that reads another must
// be emitted below it. That ordering follows a Property's evaluated references
// THROUGH the Function-valued members it calls: a Method called from inside a
// Property's value runs there, in the value band, so every Property that Method
// reads — and every Property read by the Methods it calls in turn — is read
// before this const and has to stand above it. Only the Properties are ordered,
// because only their consts hold a value; the route a Property took to reach one
// is carried along for the refusal below to name.
//
// NOTE: A cycle is refused rather than emitted in some arbitrary order, and a
// SELF-edge is a cycle like any other: a Property that reads itself — directly,
// or through a Method that reads it back — is a temporal dead zone,
// `ReferenceError` at import out of a Program that compiled green, where a
// Method that calls itself is only recursion. Neither shape can be written in a
// standard library source as it stands — a Property's value is enriched where its
// `namespace` is, so it can only read a Namespace already declared, or its OWN,
// and of that one only a Property written above it, which is what the Validator
// refuses to let past — so every edge points backwards. This answers for the day
// that changes, rather than for a mistake anyone has made yet.
export function orderEssenceMembers(
	members: Map<string, EssenceMember>,
): Array<estree.VariableDeclaration | estree.FunctionDeclaration> {
	let bands = essenceMemberBands(members)

	return [...bands.functions, ...bands.values]
}

// NOTE: The same answer with the seam between the two bands still visible,
// because one thing is emitted BETWEEN them: the pooled constants. A pooled
// conformance witness reads the Function-valued consts, and a static Property's
// value — which runs where its const is emitted — may read a pooled constant,
// so the pool has to stand between what it reads and what reads it. Everything
// that does not care asks `orderEssenceMembers` above and reads one list.
export function essenceMemberBands(members: Map<string, EssenceMember>): {
	functions: Array<estree.VariableDeclaration | estree.FunctionDeclaration>
	values: Array<estree.VariableDeclaration | estree.FunctionDeclaration>
} {
	let functions: Array<
		estree.VariableDeclaration | estree.FunctionDeclaration
	> = []
	let ordered: Array<
		estree.VariableDeclaration | estree.FunctionDeclaration
	> = []
	let values = new Map(
		[...members].filter(([, member]) => member.kind === "value"),
	)

	for (let member of members.values()) {
		if (member.kind === "function") {
			functions.push(member.declaration)
		}
	}

	// NOTE: Which Properties a Function-valued member reads once it is called, and
	// the chain of Functions the read sits at the end of. Breadth first, so the
	// chain a refusal names is the shortest one, and memoised per Function because
	// several Properties reach the same Method. Two Methods calling each other is
	// ordinary recursion and no cycle here — this is plain reachability over the
	// Function nodes, which a cycle among them can not disturb.
	let readsThroughFunctions = new Map<string, Map<string, Array<string>>>()

	let readsThrough = (functionName: string): Map<string, Array<string>> => {
		let known = readsThroughFunctions.get(functionName)

		if (known !== undefined) {
			return known
		}

		let reads = new Map<string, Array<string>>()
		let routes = new Map<string, Array<string>>([
			[functionName, [functionName]],
		])
		let pending: Array<string> = [functionName]

		while (pending.length > 0) {
			let current = pending.shift()!
			let route = routes.get(current)!

			for (let target of members.get(current)?.evaluatedReferences ??
				[]) {
				if (values.has(target)) {
					if (!reads.has(target)) {
						reads.set(target, route)
					}
				} else if (
					members.get(target)?.kind === "function" &&
					!routes.has(target)
				) {
					routes.set(target, [...route, target])
					pending.push(target)
				}
			}
		}

		readsThroughFunctions.set(functionName, reads)

		return reads
	}

	// NOTE: The Properties one Property's value reads before its own const is
	// bound, each with the Functions it was reached through — a direct read is
	// reached through none. A reference the value only HANDS ON rather than
	// evaluates is not here, which is what keeps a `static F = Boolean.isNot`
	// from being ordered against everything `isNot` reads when it is eventually
	// called.
	let readsOf = (
		member: EssenceMember,
	): Array<{ target: string; through: Array<string> }> => {
		let reads: Array<{ target: string; through: Array<string> }> = []

		for (let reference of member.evaluatedReferences) {
			if (values.has(reference)) {
				reads.push({ target: reference, through: [] })
			} else if (members.get(reference)?.kind === "function") {
				for (let [target, through] of readsThrough(reference)) {
					reads.push({ target, through })
				}
			}
		}

		return reads
	}

	let finished = new Set<string>()
	let path: Array<string> = []
	let onPath = new Set<string>()

	let walk = (name: string, through: Array<string>): void => {
		let member = values.get(name)!
		let depth = path.length

		path.push(...through, name)
		onPath.add(name)

		for (let read of readsOf(member)) {
			if (onPath.has(read.target)) {
				let cycle = [
					...path.slice(path.indexOf(read.target)),
					...read.through,
					read.target,
				]

				throw new Error(
					`The standard library's static Properties read each other in a cycle, so no order of their consts can initialise them all — one of them is read before it exists:\n\n  ${cycle.join(
						" -> ",
					)}`,
				)
			}

			if (!finished.has(read.target)) {
				walk(read.target, read.through)
			}
		}

		path.length = depth
		onPath.delete(name)
		finished.add(name)
		ordered.push(member.declaration)
	}

	for (let name of values.keys()) {
		if (!finished.has(name)) {
			walk(name, [])
		}
	}

	return { functions, values: ordered }
}

// #region The constant pool

// NOTE: One constant the emitted Module builds once and reads by name ever
// after. `marker` is a placeholder name, not the emitted one: which constants
// are DECLARED is only known when the Module is finished — the search above
// rewrites every candidate standard library body and keeps a fraction of them,
// so a name handed out while rewriting would leave the band numbered in gaps.
// So each site is given a marker, the finished Module is read for the markers
// that survived, and those are numbered `$pool_0` upward and renamed in place.
type PooledConstant = { marker: string; value: estree.Expression }

// NOTE: Ambient, like the source path and the Namespace scopes, and for the
// same reason: a pooled reference is emitted deep inside expression rewriting,
// several layers below anything that knows which Module is being emitted.
let pooledConstants = new Map<string, PooledConstant>()

// NOTE: One pool per emitted Module, because a name declared in one Module is
// not in scope in another. The single-Program form above is one Module, so its
// standard library prelude and its own code share a pool and a constant both
// want is declared once. A BUILD is the other form whatever it is given: one
// file or twenty, it emits the prelude as a Module of its own and each Module
// beside it, so there each has a pool of its own.
function collectingConstantPool<Value>(emit: () => Value): {
	value: Value
	pool: Map<string, PooledConstant>
} {
	let previous = pooledConstants

	pooledConstants = new Map()

	try {
		return { value: emit(), pool: pooledConstants }
	} finally {
		pooledConstants = previous
	}
}

// NOTE: `_` in both, so neither can collide with anything a user writes — the
// Lexer reads `_` as a Symbol, so no Essence identifier holds one, which is the
// same guarantee `$es_` rests on. The marker carries `at` so that a marker and
// a finished name can never be confused for one another either.
const POOL_MARKER_PREFIX = "$pool_at_"
const POOL_NAME_PREFIX = "$pool_"

function pooledReference(
	node: common.typedSimple.PooledReferenceNode,
): estree.Expression {
	let known = pooledConstants.get(node.key)

	if (known === undefined) {
		// NOTE: The value is emitted at MODULE scope, which is where its const
		// stands — a user Namespace shadowing a builtin does so for its own
		// block, and a constant hoisted out of that block is no longer in it.
		// `pool-constants` refuses to pool anything that could read such a name
		// in the first place; this is the other half of the same answer, so
		// that the two can not disagree.
		//
		// NOTE: Rewritten BEFORE it is recorded, because the value may itself
		// hold a pooled reference — a conditional conformance's witnesses are
		// conformances — and recording the inner one first is what puts it
		// above this one in the band.
		//
		// NOTE: And rewritten UNMAPPED. The value still carries the Position of
		// a site it was hoisted out of — whichever site was rewritten first,
		// which is an arbitrary one of however many wrote the same constant —
		// and a debugger stepping the band would be sent to a line the constant
		// has nothing in particular to do with. The band is machinery no source
		// was written for, so it maps to no source; the REFERENCE at each site
		// keeps its own Position, which is where the value is read.
		let value = unmapped(() =>
			atModuleScope(() => rewriteExpression(node.value)),
		)

		known = {
			marker: `${POOL_MARKER_PREFIX}${pooledConstants.size}`,
			value,
		}

		pooledConstants.set(node.key, known)
	}

	return { type: "Identifier", name: known.marker }
}

function atModuleScope<Value>(emit: () => Value): Value {
	let previous = shadowingNamespaceScopes

	shadowingNamespaceScopes = [new Set()]

	try {
		return emit()
	} finally {
		shadowingNamespaceScopes = previous
	}
}

// NOTE: The band, and the renaming that finishes it. `roots` is everything the
// emitted Module will hold apart from the band itself, read for the markers
// that survived — a constant collected while rewriting a standard library
// Method the Program turned out not to reach is not declared, because its
// marker is nowhere. The survivors pull in what THEY read, so a witness kept
// for one site keeps the witnesses curried onto it.
//
// NOTE: The order is the order the constants were recorded, which is the order
// they must be declared in: a value is recorded after everything inside it, so
// a constant reading another always stands below it.
function constantPoolBand(
	pool: Map<string, PooledConstant>,
	roots: unknown,
): Array<estree.VariableDeclaration> {
	if (pool.size === 0) {
		return []
	}

	let constants = [...pool.values()]
	let byMarker = new Map(
		constants.map((constant) => [constant.marker, constant]),
	)
	let used = new Set<string>()
	let pending = [...referencedNames(roots)].filter((name) =>
		byMarker.has(name),
	)

	while (pending.length > 0) {
		let marker = pending.pop()!

		if (used.has(marker)) {
			continue
		}

		used.add(marker)

		for (let name of referencedNames(byMarker.get(marker)!.value)) {
			if (byMarker.has(name)) {
				pending.push(name)
			}
		}
	}

	let names = new Map<string, string>()
	let band: Array<estree.VariableDeclaration> = []

	for (let constant of constants) {
		if (!used.has(constant.marker)) {
			continue
		}

		let name = `${POOL_NAME_PREFIX}${names.size}`

		names.set(constant.marker, name)
		band.push({
			type: "VariableDeclaration",
			kind: "const",
			declarations: [
				{
					type: "VariableDeclarator",
					id: { type: "Identifier", name },
					init: constant.value,
				},
			],
		})
	}

	renamePooledReferences(roots, names)
	renamePooledReferences(band, names)

	return band
}

// NOTE: The markers replaced by the names the band declares, in place. A marker
// can stand nowhere but where this Module put one — no Essence identifier holds
// a `_`, and nothing else in emission spells one — so a name match IS the
// reference, and every position is looked at rather than only the ones a
// reference is expected in.
function renamePooledReferences(
	root: unknown,
	names: ReadonlyMap<string, string>,
): void {
	let visit = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (let entry of node) {
				visit(entry)
			}

			return
		}

		if (node === null || typeof node !== "object") {
			return
		}

		let record = node as Record<string, unknown>

		if (record["type"] === "Identifier") {
			let name = names.get(record["name"] as string)

			if (name !== undefined) {
				record["name"] = name
			}

			return
		}

		for (let value of Object.values(record)) {
			visit(value)
		}
	}

	visit(root)
}

// #endregion

// NOTE: Which Essence-implemented Methods the emitted Program actually needs,
// and the const for each. A const is emitted only where something names it:
// unlike a native, whose unused `import * as <Name>` esbuild shakes away, an
// unused const still names the runtime Methods its body reaches, and once a
// module is in the graph its impure top-level initialisers (`Number.Pi`,
// `Number.Tau`) can no longer be dropped — so an unconditional const would
// charge a Program for a numeric tower it never used. The gate is per-Method,
// finer than the per-Namespace one it replaced.
//
// NOTE: A Method left out costs nothing — nothing references its const and no
// spread was ever emitted, so the text is exactly what a wholly native standard
// library would have produced.
//
// NOTE: The search runs to a FIXED POINT over the consts themselves, not just
// over the user Program: `Boolean.isNot`'s body calls `Boolean.negate` (a
// native, no const) but could equally call another Essence Method, and a
// Method's const reached only through another one must still be pulled in.
// Stopping at the first round would emit a const whose body names one that was
// never declared.
//
// NOTE: A bodied static Property is searched for on exactly the same footing —
// its const is emitted only where something reads it, and its own value may be
// the only thing that reads another one.
//
// NOTE: Exported for the tests. The fixed point is the part of this that can
// silently be wrong — a Method reached only through another one is exactly what
// the standard library will produce more of as the conversion goes on.
export type PreludeReach = "reached" | "whole"

export function reachableEssenceMethods(
	prelude: Array<PreludeNamespace>,
	implementation: Array<estree.ModuleDeclaration | estree.Statement>,
	freeFunctions: Array<PreludeFreeFunction> = [],
	// NOTE: The pooled constants already collected, which are part of what the
	// emitted Module names even though they are not in its body yet: a pooled
	// conformance witness holds the `$es_…` reference that used to stand at the
	// site the witness was hoisted out of, and a search seeded only by the body
	// would lose that edge and emit a Module naming a const nobody declared.
	poolRoots: unknown = null,
	// NOTE: How much of the prelude to keep. `reached` is the search this
	// Function is named for and what every bundle is emitted under; `whole`
	// answers with every candidate and runs no search at all — see the seed
	// below, and `rewriteModuleGraph` for why a host's build asks for it.
	reach: PreludeReach = "reached",
): Map<string, EssenceMember> {
	let reachable = new Map<string, EssenceMember>()

	if (prelude.length === 0 && freeFunctions.length === 0) {
		return reachable
	}

	// NOTE: The pairs this prelude implements in Essence — an edge is drawn only
	// to a Method the prelude actually defines a const for.
	let implemented = new Set(
		prelude.flatMap((namespace) =>
			Object.keys(namespace.node.methods).map(
				(memberName) => `${namespace.name} ${memberName}`,
			),
		),
	)

	// NOTE: The Essence-bodied free Functions this run can emit, by the bare
	// `<name>__overload$N` name a call site resolves to — the free-Function
	// analogue of `implemented`. An edge is drawn to one only when it is in
	// this set, so a native free Function (reached off `$_`) falls out just as
	// a native Method does.
	let implementedFreeFunctions = new Set(
		freeFunctions.map((freeFunction) => freeFunction.name),
	)

	// NOTE: The static Properties this prelude gives a value to — the third
	// table, keyed like `implemented` because a Property read is spelled exactly
	// like a static Method reference and the two are told apart by which table
	// answers. A native Property is in neither, so it stays a member read.
	let implementedProperties = new Set(
		prelude.flatMap((namespace) =>
			Object.keys(namespace.node.properties).map(
				(memberName) => `${namespace.name} ${memberName}`,
			),
		),
	)

	// NOTE: Each candidate carries its declaration AND the other Essence Methods
	// its body calls, read off the TYPED body rather than the emitted const.
	// That matters: `namespaceMember` decides an emitted call's spelling from the
	// process-wide prelude, so a const emitted for a DIFFERENT prelude (only the
	// tests do this) would spell its transitive calls as native member reads and
	// the fixed point would lose the edge. Reading the typed body keeps the
	// reachability answer a property of the prelude it was handed.
	let methodCandidates: Array<[string, EssenceMember]> = prelude.flatMap(
		(namespace) =>
			Object.entries(namespace.node.methods).map(
				([memberName, method]): [string, EssenceMember] => [
					essenceMethodIdentifier(namespace.name, memberName),
					{
						kind: "function",
						declaration: rewriteEssenceMethod(
							namespace.name,
							memberName,
							method,
						),
						...essenceMethodReferences(
							method.method.value,
							implemented,
							implementedFreeFunctions,
							implementedProperties,
						),
					},
				],
			),
	)

	// NOTE: A bodied static Property is a candidate of its own, carrying the KIND
	// that puts its const in the value band. Its value draws edges like any body
	// — it is written in Essence, so it reaches Methods, free Functions and other
	// Properties — and the ones that reach another Property are what order the
	// band.
	let propertyCandidates: Array<[string, EssenceMember]> = prelude.flatMap(
		(namespace) =>
			Object.entries(namespace.node.properties).map(
				([memberName, value]): [string, EssenceMember] => [
					essenceMethodIdentifier(namespace.name, memberName),
					{
						kind: "value",
						declaration: rewriteEssenceProperty(
							namespace.name,
							memberName,
							value,
						),
						...essenceMethodReferences(
							value,
							implemented,
							implementedFreeFunctions,
							implementedProperties,
						),
					},
				],
			),
	)

	// NOTE: A free Function is a candidate exactly as a Method is — its own
	// top-level `function <name>__overload$N(…) {…}` and the edges its body
	// draws — so the two share ONE fixed point. That unity is the point: a
	// Method body that calls a free Function, or a free Function body that calls
	// another one or a Method, must pull the callee in, and only a single search
	// over both kinds can follow an edge that crosses between them.
	let freeFunctionCandidates: Array<[string, EssenceMember]> =
		freeFunctions.map((freeFunction): [string, EssenceMember] => [
			freeFunction.name,
			{
				kind: "function",
				declaration: rewriteFunctionStatement(freeFunction.node),
				...essenceMethodReferences(
					freeFunction.node.value,
					implemented,
					implementedFreeFunctions,
					implementedProperties,
				),
			},
		])

	let candidates = new Map<string, EssenceMember>([
		...methodCandidates,
		...propertyCandidates,
		...freeFunctionCandidates,
	])

	let pending: Array<string> = []

	let include = (names: Set<string>): void => {
		for (let name of names) {
			let candidate = candidates.get(name)

			if (candidate === undefined || reachable.has(name)) {
				continue
			}

			reachable.set(name, candidate)
			pending.push(name)
		}
	}

	// NOTE: The seed is what the emitted user Program names — a plain call, a
	// conformance witness and a `dispatchMethod` target are all bare `$es_…`
	// Identifiers by now, so `referencedNames` finds them all alike. Seeded with
	// every candidate instead, the loop below has nothing left to find and the
	// answer is the whole prelude in candidate order — which is the point: an
	// order that is a property of the standard library rather than of the graph
	// that happened to be compiled.
	include(
		reach === "whole"
			? new Set(candidates.keys())
			: referencedNames([implementation, poolRoots]),
	)

	while (pending.length > 0) {
		include(candidates.get(pending.pop()!)!.references)
	}

	return reachable
}

// NOTE: The Essence Methods a typed Method body reaches, restricted to the ones
// a given prelude implements. This MUST recognise every shape `namespaceMember`
// turns into a bare `$es_…` Identifier, because those are the four emission
// sites the seed's `referencedNames` will find in the finished tree — if the two
// disagree, a Method reached only through a shape missing here is named in the
// emitted body but its const is never pulled in, a `ReferenceError` at run time
// that compiles green. The shapes, one per `namespaceMember` call site:
//
//   MethodInvocation        `@::m(…)`            — base.name, member.name
//   UnionMethodInvocation    a Union receiver    — each case's namespaceName +
//                            methodName (the case's conformance Arguments are
//                            ConformanceValues and its own Arguments are
//                            ordinary Expressions, both reached by the
//                            recursion below)
//   Lookup (Identifier base) a static call OR a bare static reference —
//                            base.name, member.name
//   ConformanceValue         a witness `{ m: X.m }` — namespaceName + each
//                            methodMap value; a conditional one nests more
//                            ConformanceValues in `conditions`, reached below
//   dispatch-chain           a compiled Union dispatch — each branch's
//                            namespaceName + methodName, the same edges the
//                            Invocation it replaced drew
//   direct-method            a devirtualised witness — namespaceName +
//                            memberName, the one Method of the witness it
//                            stands in for
//
// The last two are the Optimiser's, and are here because the Optimiser rewrites
// the PRELUDE's bodies as well as a Program's: a Method reached only through a
// shape a pass introduced is a Method this search would otherwise stop drawing
// an edge to the moment that pass was turned on.
//
// One more shape draws a free-Function edge rather than a Method one: a
// `FunctionInvocation` off a bare Identifier — `loop__overload$2(…)` by the time
// the Simplifier has mangled it — is an edge to that free Function's own const,
// filtered by `implementedFreeFunctions` the way the Method shapes are by
// `implemented`. It is what lets a Method body reach a free Function, and a free
// Function body reach either kind, inside the one fixed point.
//
// A `Lookup` draws one more edge for the same reason it draws the Method one: a
// read of a static Property the prelude gives a VALUE to is that Property's
// const, filtered by `implementedProperties`. It is the same Node shape as a
// static Method reference, so both tables are asked and either may answer.
//
// Over-collecting stays safe, as everywhere in the search: a pair neither table
// implements is filtered out (so a Record field or a native Property read falls
// away), and one they do only emits a const that is read. Exported for a unit
// test that feeds it each shape directly.
//
// NOTE: Each shape also answers WHETHER this body evaluates what it names, which
// is what `orderEssenceMembers` orders the value band by — see
// `EssenceMemberReferences`. A call evaluates its target, a Property read
// evaluates the Property, and a Function this body only hands on does not.
export function essenceMethodReferences(
	root: unknown,
	implemented: Set<string>,
	implementedFreeFunctions: Set<string> = new Set(),
	implementedProperties: Set<string> = new Set(),
): EssenceMemberReferences {
	let references = new Set<string>()
	let evaluatedReferences = new Set<string>()

	let consider = (
		namespaceName: unknown,
		memberName: unknown,
		members: Set<string>,
		isEvaluated: boolean,
	): void => {
		if (
			typeof namespaceName === "string" &&
			typeof memberName === "string" &&
			members.has(`${namespaceName} ${memberName}`)
		) {
			let name = essenceMethodIdentifier(namespaceName, memberName)

			references.add(name)

			if (isEvaluated) {
				evaluatedReferences.add(name)
			}
		}
	}

	// NOTE: `isStored` says what a Function-valued reference found HERE would be:
	// a value this body hands on rather than runs. It holds at the root — a
	// Property whose value IS `Boolean.isNot`, a Method that returns it, both only
	// pass the Function along — and is cleared for everything under an invocation,
	// because a Function given to a call is a Function that call may run at once
	// (`items::map(Boolean.isNot)`, and every callback the natives take). Calls are
	// the only shape that can run a body, which is the same closed list the edge
	// shapes above are, so a Node kind added later inherits the safe answer:
	// evaluated, which can only over-order the value band, never under-order it.
	let visit = (node: unknown, isStored: boolean): void => {
		if (Array.isArray(node)) {
			for (let entry of node) {
				visit(entry, isStored)
			}

			return
		}

		if (node === null || typeof node !== "object") {
			return
		}

		let record = node as Record<string, unknown>

		if (
			record["nodeType"] === "MethodInvocation" ||
			record["nodeType"] === "UnionMethodInvocation" ||
			record["nodeType"] === "FunctionInvocation" ||
			(record["nodeType"] === "Intrinsic" &&
				record["kind"] === "dispatch-chain") ||
			// NOTE: An inlined loop RUNS the bodies it holds, which is what the
			// call it replaced did with the closures it was handed — so a
			// Function-valued reference inside one is evaluated, exactly as it
			// was when it stood under the call.
			record["kind"] === "inline-loop"
		) {
			isStored = false
		}

		if (record["nodeType"] === "MethodInvocation") {
			let base = record["base"] as Record<string, unknown> | undefined
			let member = record["member"] as Record<string, unknown> | undefined

			consider(base?.["name"], member?.["name"], implemented, true)
		} else if (record["nodeType"] === "UnionMethodInvocation") {
			for (let dispatch of (record["cases"] as Array<
				Record<string, unknown>
			>) ?? []) {
				consider(
					dispatch["namespaceName"],
					dispatch["methodName"],
					implemented,
					true,
				)
			}
		} else if (record["nodeType"] === "Intrinsic") {
			// NOTE: The two intrinsics that name a Namespace member — a
			// compiled dispatch's per-branch call and a devirtualised witness's
			// Method — both of which the Optimiser writes INTO a prelude body,
			// where this search is what pulls the const in. They are the same
			// edges the Nodes they replace drew: `dispatch-chain` for a
			// `UnionMethodInvocation`'s cases, `direct-method` for the one
			// Method of the `ConformanceValue` it stood in for. A witness
			// handed on rather than called keeps `isStored`, so a
			// devirtualised one — which is a Function reference at a site that
			// calls it — says evaluated.
			if (record["kind"] === "dispatch-chain") {
				for (let dispatchCase of (record["cases"] as Array<
					Record<string, unknown>
				>) ?? []) {
					consider(
						dispatchCase["namespaceName"],
						dispatchCase["methodName"],
						implemented,
						true,
					)
				}
			} else if (record["kind"] === "direct-method") {
				consider(
					record["namespaceName"],
					record["memberName"],
					implemented,
					true,
				)
			}
		} else if (record["nodeType"] === "Lookup") {
			// NOTE: A `Lookup` off an Identifier whose TYPE is a Namespace is a
			// static-Method reference or a static-Property read — as a call's
			// callee or a bare value both — and is the only spelling
			// `rewriteLookup` sends through `namespaceMember`. The Type is what
			// decides it there, so it decides it here: a local named after a
			// Namespace (`constant Optional = { otherwise = 5 }`) is a Record
			// field read, and drawing an edge from it would emit a const nothing
			// names.
			let base = record["base"] as Record<string, unknown> | undefined
			let member = record["member"] as Record<string, unknown> | undefined

			if (
				base?.["nodeType"] === "Identifier" &&
				(base["type"] as Record<string, unknown> | undefined)?.[
					"type"
				] === "Namespace"
			) {
				// NOTE: A static Method is evaluated where it is CALLED, a
				// Property wherever it is named at all — reading its const is what
				// yields the value, so there is no handing it on.
				consider(base["name"], member?.["name"], implemented, !isStored)
				consider(
					base["name"],
					member?.["name"],
					implementedProperties,
					true,
				)
			}
		} else if (record["nodeType"] === "ConformanceValue") {
			let methodMap = record["methodMap"] as
				| Record<string, unknown>
				| undefined

			for (let namespaceMethodName of Object.values(methodMap ?? {})) {
				consider(
					record["namespaceName"],
					namespaceMethodName,
					implemented,
					!isStored,
				)
			}
		} else if (record["nodeType"] === "FunctionInvocation") {
			// NOTE: A bare free-Function call — `loop__overload$2(…)` by now,
			// the Simplifier having mangled the overloaded callee — is an edge
			// to that Function's const when this run implements it in Essence.
			// A native free Function is a read off `$_` and is not in the set,
			// so it falls out exactly as a native Method does. The reference key
			// IS the bare name, which is the free Function's candidate key.
			let callee = record["name"] as Record<string, unknown> | undefined

			if (
				callee?.["nodeType"] === "Identifier" &&
				typeof callee["name"] === "string" &&
				implementedFreeFunctions.has(callee["name"])
			) {
				references.add(callee["name"])
				evaluatedReferences.add(callee["name"])
			}
		}

		for (let value of Object.values(record)) {
			visit(value, isStored)
		}
	}

	visit(root, true)

	return { references, evaluatedReferences }
}

// NOTE: Every name the given tree READS. A dotted member and an object
// literal's key are text rather than references — `{ isNot: Boolean.isNot }`
// names `Boolean` and nothing else — so an emitted Record member that happens
// to be spelled like a Namespace does not drag it in. Everything else is
// collected, bindings included: over-collecting only emits a const that is never
// read, while under-collecting emits a Program that crashes.
function referencedNames(root: unknown): Set<string> {
	let names = new Set<string>()

	let visit = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (let entry of node) {
				visit(entry)
			}

			return
		}

		if (node === null || typeof node !== "object") {
			return
		}

		let record = node as Record<string, unknown>

		if (
			record["type"] === "Identifier" &&
			typeof record["name"] === "string"
		) {
			names.add(record["name"])

			return
		}

		for (let [key, value] of Object.entries(record)) {
			if (
				record["computed"] === false &&
				(key === "property" || key === "key")
			) {
				continue
			}

			visit(value)
		}
	}

	visit(root)

	return names
}

// NOTE: The last word on the fixed point above, read off the FINISHED tree: a
// `$es_…` name is emitted only where a standard library Method is called, and
// every one of them must have had its const pulled in. The two answers are
// arrived at differently on purpose — the fixed point follows the TYPED bodies,
// this reads the emitted JavaScript — so a shape `essenceMethodReferences` does
// not know about shows up here as a Diagnostic instead of as a `ReferenceError`
// out of a Program that compiled green.
//
// NOTE: Only `$es_…` names can be answered for. A free Function's const is
// emitted under its bare name, which is indistinguishable from a user's own
// binding, and the prefix is what makes this sweep safe: `_` is a Symbol to the
// Lexer, so no name a Program can write ever starts with one.
//
// NOTE: Exported for a unit test, which is the only way to see it fire — while
// the Rewriter is right, no Program reaches it.
export function checkEssenceMethodsAreDeclared(
	program: estree.Program,
	declared: ReadonlySet<string>,
): void {
	for (let name of referencedNames(program.body)) {
		if (name.startsWith(ESSENCE_METHOD_PREFIX) && !declared.has(name)) {
			throw new Error(
				`The emitted Program names '${name}', but no const was emitted for it. This is a bug in the Compiler.`,
			)
		}
	}
}

function rewriteTypeAliasStatement(
	_node: common.typedSimple.TypeAliasStatementNode,
): estree.EmptyStatement {
	return { type: "EmptyStatement" }
}

function rewriteProtocolDeclarationStatement(
	_node: common.typedSimple.ProtocolDeclarationStatementNode,
): estree.EmptyStatement {
	return { type: "EmptyStatement" }
}

function rewriteConditionalStatement(
	node: common.typedSimple.ConditionalStatementNode,
): estree.IfStatement {
	let alternate: estree.Statement | null = null

	if (node.falseBody.length > 0) {
		if (
			node.falseBody.length === 1 &&
			node.falseBody[0].nodeType === "ConditionalStatement"
		) {
			let nested = node.falseBody[0]

			alternate = withStatementLocation(
				[rewriteConditionalStatement(nested)],
				nested.position,
			)[0]!
		} else {
			alternate = rewriteBlockStatement(node.falseBody)
		}
	}

	return {
		type: "IfStatement",
		test: conditionTest(node),
		consequent: rewriteBlockStatement(node.trueBody),
		alternate,
	}
}

// NOTE: What JavaScript is asked. An Essence Boolean is an object, and every
// object is true, so the question is the `value` it holds — unless
// `lower-matches-to-statements` found the question already asked in JavaScript's
// own terms, in which case the Expression IS the question and reading `.value`
// off a raw boolean would be `undefined`.
function conditionTest(
	node: common.typedSimple.ConditionalStatementNode,
): estree.Expression {
	let condition = rewriteExpression(node.condition)

	return node.conditionIsRaw ? condition : valueRead(condition)
}

function rewriteReturnStatement(
	node: common.typedSimple.ReturnStatementNode,
): estree.ReturnStatement {
	return {
		type: "ReturnStatement",
		argument: rewriteExpression(node.expression),
	}
}

function rewriteFunctionStatement(
	node: common.typedSimple.FunctionStatementNode,
): estree.FunctionDeclaration {
	return {
		type: "FunctionDeclaration",
		id: rewriteIdentifier(node.name),
		params: node.value.parameters.map((param) => rewriteParameter(param)),
		body: rewriteBlockStatement(node.value.body),
	}
}

// NOTE: An Expression the Program wrote for its effects, and the one shape that
// may not be emitted as JavaScript writes it. A call and an assignment are what
// every Statement of this kind actually is, and neither can be taken away by an
// engine — the call may print and the assignment is the mutation.
//
// NOTE: Anything ELSE here is a value the Program computes and drops, and a
// value in this language can BE an object literal: `collapse-construction`
// builds `{ [$type.typeKeySymbol]: "Record", … }`, whose hidden Type key is a
// computed SYMBOL. An engine that decides such a literal is unused is free to
// take it away, and Bun's does — while still evaluating the key as a property
// name, which converts the Symbol to a string and THROWS, out of a Statement
// that did nothing. So the value is bound to a name in a block of its own: it is
// computed exactly as it was, and nothing about it is unused any more. The block
// is what keeps the name from colliding with a sibling's, and the `_` in the
// name is what keeps it clear of the Program's own: `$` is a legal Essence
// identifier character and `_` is not, so `$discarded` is a name a Program can
// write — and one that, bound here around an Expression READING it, would be
// read before it is initialised.
function discardedExpressionStatement(
	expression: estree.Expression,
): estree.Statement {
	if (
		expression.type === "CallExpression" ||
		expression.type === "AssignmentExpression"
	) {
		return { type: "ExpressionStatement", expression }
	}

	return {
		type: "BlockStatement",
		body: [
			{
				type: "VariableDeclaration",
				kind: "let",
				declarations: [
					{
						type: "VariableDeclarator",
						id: { type: "Identifier", name: discardedValueName },
						init: expression,
					},
				],
			},
		],
	}
}

const discardedValueName = "$discarded_value"

function rewriteExpressionStatement(
	node:
		| common.typedSimple.ExpressionNode
		| common.typedSimple.VariableAssignmentStatementNode,
): estree.Statement {
	return discardedExpressionStatement(rewriteExpression(node))
}

// #endregion

// #region Expressions

function rewriteExpression(
	node:
		| common.typedSimple.ExpressionNode
		| common.typedSimple.VariableAssignmentStatementNode,
): estree.Expression {
	let expression = rewriteExpressionByKind(node)
	let loc = locOf(node.position)

	if (loc !== undefined) {
		expression.loc = loc
	}

	return expression
}

function rewriteExpressionByKind(
	node:
		| common.typedSimple.ExpressionNode
		| common.typedSimple.VariableAssignmentStatementNode,
): estree.Expression {
	switch (node.nodeType) {
		case "VariableAssignmentStatement":
			return rewriteVariableAssignmentStatement(node)
		case "FunctionInvocation":
			return rewriteFunctionInvocation(node)
		case "MethodInvocation":
			return rewriteMethodInvocation(node)
		case "UnionMethodInvocation":
			return rewriteUnionMethodInvocation(node)
		case "Combination":
			return rewriteCombination(node)
		case "RecordValue":
			return rewriteRecordValue(node)
		case "StringValue":
			return rewriteStringValue(node)
		case "InterpolatedStringValue":
			return rewriteInterpolatedStringValue(node)
		case "IntegerValue":
			return rewriteIntegerValue(node)
		case "RationalValue":
			return rewriteRationalValue(node)
		case "BooleanValue":
			return rewriteBooleanValue(node)
		case "FunctionValue":
			return rewriteFunctionValue(node)
		case "ListValue":
			return rewriteListValue(node)
		case "Lookup":
			return rewriteLookup(node)
		case "Identifier":
			return rewriteIdentifier(node)
		case "Match":
			return rewriteMatch(node)
		case "ConformanceValue":
			return rewriteConformanceValue(node)
		case "CaseValue":
			return rewriteCaseValue(node)
		case "Intrinsic":
			return rewriteIntrinsic(node)
	}
}

// NOTE: The Nodes the Optimiser rewrites Expressions into, and the one place
// they are emitted. Each stands for a shape the runtime's own constructor would
// have built — so the JavaScript below is what that constructor does, written
// out at the site instead of called. The switch is exhaustive: an intrinsic kind
// added without a case here does not compile.
function rewriteIntrinsic(
	node: common.typedSimple.IntrinsicNode,
): estree.Expression {
	switch (node.kind) {
		// NOTE: The tag as the value carries it — through `renderIdentity`, like
		// every other place a tag is written, so a Choice declared in a Module
		// is asked about under the same spelling it was stamped with.
		//
		// NOTE: An OPTIONAL read is `?.[…]`, which answers `undefined` for a
		// member that is not there — and `undefined` is not a tag, so the
		// comparison answers false without the read throwing. That is the
		// `Object.hasOwn` the runtime's own check asks first, folded into the
		// comparison after it; `compile-record-members` says what it rests on.
		case "tag-test":
			return {
				type: "BinaryExpression",
				operator: node.negated ? "!==" : "===",
				left: typeKeyRead(rewriteExpression(node.value), node.optional),
				right: { type: "Literal", value: renderIdentity(node.tag) },
			}
		// NOTE: The general check, byte for byte what a Match Handler emitted
		// before there was a pass to compile one — the descriptor stands in an
		// Expression position now, which is what lets it be pooled, and that is
		// the whole of the difference.
		case "type-test":
			return {
				type: "CallExpression",
				optional: false,
				callee: memberRead(
					{ type: "Identifier", name: "$type" },
					"isValueOfType",
				),
				arguments: [
					rewriteExpression(node.value),
					rewriteExpression(node.descriptor),
				],
			}
		case "type-descriptor":
			return typeDescriptorExpression(
				node.descriptor,
				"a pooled Type descriptor",
			)
		case "pooled-reference":
			return pooledReference(node)
		case "essence-boolean":
			return {
				type: "ConditionalExpression",
				test: rewriteExpression(node.value),
				consequent: memberRead(
					{ type: "Identifier", name: "Boolean" },
					"trueInstance",
				),
				alternate: memberRead(
					{ type: "Identifier", name: "Boolean" },
					"falseInstance",
				),
			}
		// NOTE: The read back off an Essence Boolean — the same `.value` an
		// emitted condition performs, standing where a raw operand belongs.
		case "raw-boolean":
			return memberRead(rewriteExpression(node.value), "value")
		case "raw-boolean-op":
			// NOTE: `&&` and `||` do not evaluate their right-hand side when
			// the left decides, which is a difference from the Method call
			// they replace — `lower-scalar-operations` is what proves the
			// right-hand side has nothing to say, and only builds one of these
			// where it does.
			return node.other === null
				? {
						type: "UnaryExpression",
						operator: "!",
						prefix: true,
						argument: rewriteExpression(node.operand),
					}
				: {
						type: "LogicalExpression",
						operator: node.operator === "and" ? "&&" : "||",
						left: rewriteExpression(node.operand),
						right: rewriteExpression(node.other),
					}
		// NOTE: What each Integer holds, compared by JavaScript's own operator.
		// `<`, `>`, `<=` and `>=` are defined ACROSS a number and a bigint and
		// decide the mathematical order without converting either side, so one
		// comparison answers for all four pairings of the hybrid Integer's two
		// representations — which is why this site needs nothing from the
		// canonical invariant and no guard.
		case "raw-compare":
			return {
				type: "BinaryExpression",
				operator: node.operator,
				left: unboxedInteger(rewriteExpression(node.left)),
				right: unboxedInteger(rewriteExpression(node.right)),
			}
		case "raw-equals":
			return rawEquals(node)
		case "raw-arithmetic":
			return rawArithmetic(node)
		// NOTE: Through the one function every reference to a standard library
		// member routes through, so a devirtualised Method is spelled exactly
		// as the witness spelled it — an Essence-implemented one as its own
		// const, a native one as a read off the runtime module, and a Choice's
		// derived equality as the runtime helper.
		case "direct-method":
			return namespaceMember(
				node.namespaceName,
				node.memberName,
				node.derivedDescriptor,
			)
		case "direct-record":
			return {
				type: "ObjectExpression",
				properties: [
					typeKeyProperty("Record"),
					...memberProperties(node.members),
				],
			}
		case "direct-case":
			return {
				type: "ObjectExpression",
				// NOTE: The payload is spread FIRST and the tag written over it,
				// exactly as `createCase` does — a payload Record carries the
				// `"Record"` brand of its own, and whichever of the two is
				// written last is the one the value ends up with.
				properties: [
					...(node.payload === null
						? []
						: [
								{
									type: "SpreadElement" as const,
									argument: rewriteExpression(node.payload),
								},
							]),
					typeKeyProperty(renderIdentity(node.tag)),
					...memberProperties(node.members),
				],
			}
		case "spread-combination":
			// NOTE: No brand of its own — the hidden Type key rides along on the
			// spread of the left-hand side, which is a Record and carries it.
			return {
				type: "ObjectExpression",
				properties: [
					{
						type: "SpreadElement",
						argument: rewriteExpression(node.lhs),
					},
					...(node.rhs === null
						? []
						: [
								{
									type: "SpreadElement" as const,
									argument: rewriteExpression(node.rhs),
								},
							]),
					...memberProperties(node.members),
				],
			}
		case "dispatch-chain":
			return dispatchChain(node)
		// NOTE: The one place "no Argument given" is written into emitted code
		// on purpose — the hole a call leaves where a Parameter took its
		// default and something after it still has to be passed. It is consumed
		// by the callee's parameter binding before the first Statement runs, so
		// it never becomes a value.
		case "omitted-argument":
			return omittedArgument()
		// NOTE: A walk written where it stands, wrapped in an arrow because an
		// Expression position has nowhere to write a `while`. Where it stands in
		// a Statement position the Optimiser lifted it to the Statement form
		// above, and there is no arrow at all.
		case "inline-loop":
			return inlineLoopExpression(node)
		// NOTE: A build is not an Expression that can stand anywhere: it names
		// the Array a walk is filling, and there is no way to answer with one
		// without saying whether the walk is finished with it. The walks that
		// build read it where their answer is written and never reach here, so
		// this names the Compiler rather than the reader — the Node exists only
		// where `build-lists-in-place` put it, and it put one nowhere else.
		case "list-build":
			throw new Error(
				"Internal Compiler Error: a list build reached an ordinary Expression position — a build may only stand where an inlined walk writes its answer.",
			)
		case "direct-list":
			return {
				type: "ObjectExpression",
				properties: [
					typeKeyProperty("List"),
					{
						type: "Property",
						key: { type: "Identifier", name: "value" },
						value: {
							type: "ArrayExpression",
							elements: node.values.map((value) =>
								rewriteExpression(value),
							),
						},
						kind: "init",
						computed: false,
						method: false,
						shorthand: false,
					},
				],
			}
	}
}

// NOTE: A Union dispatch decided where it stands — a conditional for each case
// that still has a question, and the call the Compiler resolved for it:
//
//   value[$type.typeKeySymbol] === "Shape#Circle"
//     ? Shapes.area(value)
//     : Shapes.area(value)
//
// The cases are folded back to front, so each conditional becomes the
// `alternate` of the one before it and the first case is tested first. A case
// with no test IS the answer from there on: it stands where the alternate would
// have gone, and whatever the Optimiser left after it — nothing, since it drops
// what such a case makes unreachable — goes with it.
//
// NOTE: The chain ends in `$type.noDispatchCaseMatched()` only where the LAST
// case still has a test, which is the same throw the runtime's own search ends
// with. Where the Optimiser could elide that test the last call is simply the
// alternate, and the throw is gone with the question it answered.
function dispatchChain(
	node: common.typedSimple.DispatchChainNode,
): estree.Expression {
	let chain: estree.Expression | null = null

	for (let index = node.cases.length - 1; index >= 0; index--) {
		let dispatchCase = node.cases[index]!
		let call = dispatchCaseCall(node, dispatchCase)

		chain =
			dispatchCase.test === null
				? call
				: {
						type: "ConditionalExpression",
						test: rewriteExpression(dispatchCase.test),
						consequent: call,
						alternate: chain ?? noDispatchCaseMatched(),
					}
	}

	let answer = chain ?? noDispatchCaseMatched()

	if (node.temporaries.length === 0) {
		return answer
	}

	// NOTE: The Expressions the branches read more than once, held for the
	// length of the chain — as the Parameters of an arrow the chain is the body
	// of, called at once with them. JavaScript evaluates a call's Arguments left
	// to right and before the call, which is the order and the once-ness the
	// dispatch's own Argument array had; a `let` would say the same thing and
	// can not be said in an Expression position, which is where a Method
	// Invocation stands.
	return {
		type: "CallExpression",
		optional: false,
		callee: {
			type: "ArrowFunctionExpression",
			expression: true,
			params: node.temporaries.map(
				(temporary): estree.Pattern => ({
					type: "Identifier",
					name: temporary.name,
				}),
			),
			body: answer,
		},
		arguments: node.temporaries.map((temporary) =>
			rewriteExpression(temporary.value),
		),
	}
}

// NOTE: One branch's call — the Method the Compiler resolved for this member
// Type, spelled through the one function every reference to a Namespace member
// goes through, and given the receiver, the shared Arguments and this case's
// own hidden conformance Arguments, in the order the runtime handed them over.
// An Argument this branch overrides stands in the position it stands in for,
// where the search wrote it into a COPY of the shared array; the copy is what
// kept one branch's Arguments from becoming another's, and writing each branch's
// call out is what makes it unnecessary.
function dispatchCaseCall(
	node: common.typedSimple.DispatchChainNode,
	dispatchCase: common.typedSimple.DispatchChainCase,
): estree.CallExpression {
	let values = [...node.arguments]

	for (let contextual of dispatchCase.contextualArguments) {
		values[contextual.index] = contextual.value
	}

	// NOTE: The shared list is what the call WROTE — the branches need not agree
	// on which Parameters they leave out — so the holes are opened here, in the
	// branch that makes the call, and after the overrides above, which stand at
	// the positions the call wrote.
	let written = values.map((value) => rewriteExpression(value))
	let receiver = rewriteExpression(node.receiver)
	let conformances = dispatchCase.conformanceArguments.map((value) =>
		rewriteExpression(value),
	)

	return {
		type: "CallExpression",
		optional: false,
		callee: namespaceMember(
			dispatchCase.namespaceName,
			dispatchCase.methodName,
			dispatchCase.derivedDescriptor,
		),
		arguments: openOmittedArguments(
			[receiver],
			written,
			dispatchCase.omittedParameterIndices,
			conformances,
		),
	}
}

// NOTE: `void 0` rather than the Identifier `undefined`, which is a name a
// Program may bind: `constant undefined = 99` is legal Essence and emits a
// `const undefined`, and every hole in that Module would then have been passed
// its value. `void 0` is the same value under a spelling nothing can rebind.
function omittedArgument(): estree.UnaryExpression {
	return {
		type: "UnaryExpression",
		operator: "void",
		prefix: true,
		argument: { type: "Literal", value: 0 },
	}
}

// NOTE: The emitted counterpart of the Simplifier's `expandOmittedArguments`,
// for the one Argument list the Simplifier could not build: a dispatch branch's,
// which is assembled here because the branches share one written list and each
// takes its own defaults out of it. Both go through `openArgumentHoles`.
function openOmittedArguments(
	leading: Array<estree.Expression>,
	written: Array<estree.Expression>,
	omittedParameterIndices: Array<number>,
	trailing: Array<estree.Expression>,
): Array<estree.Expression> {
	return openArgumentHoles<estree.Expression>(
		leading,
		written,
		omittedParameterIndices,
		trailing,
		omittedArgument,
	)
}

function noDispatchCaseMatched(): estree.CallExpression {
	return {
		type: "CallExpression",
		optional: false,
		callee: memberRead(
			{ type: "Identifier", name: "$type" },
			"noDispatchCaseMatched",
		),
		arguments: [],
	}
}

// NOTE: The value a scalar wrapper holds — the number or bigint under an
// Integer, the JavaScript boolean under a Boolean. Not a member the language
// has: it is the runtime's own field, read here exactly as every runtime Method
// reads it.
function valueRead(object: estree.Expression): estree.MemberExpression {
	return memberRead(object, "value")
}

// NOTE: `Number.MAX_SAFE_INTEGER`, written as the literal the guard below
// compares against rather than reached for by name: `Number` is a Namespace of
// the language, and an emitted Module that opens with `import * as Number` would
// shadow the global this took it from. `Integer.ts` in the runtime holds the
// same bound; `src/tests/hybridIntegers.spec.ts` holds the two to each other.
const SAFE_INTEGER = 9007199254740991

// NOTE: Two Strings are equal when their CHARACTERS are, which is not what
// `===` decides — the same accent written as one code point and as two is one
// String — so the runtime helper that normalises decides it, and the double
// normalisation stays in the one place that has always performed it.
//
// NOTE: An Integer is `===` on what it holds, and THE CANONICAL INVARIANT is
// what makes that the whole answer. An Integer holds a number while its value is
// one a double holds exactly and a bigint beyond that, never the other way
// round, so one mathematical Integer has exactly one representation. Two equal
// values therefore meet as two numbers or as two bigints, where `===` is exact
// either way; two unequal ones answer false in those pairings, and in the mixed
// pairing `===` answers false between a number and a bigint without comparing —
// which is right, because a mixed pairing can only be values whose magnitudes
// put them on opposite sides of safe range. Every construction site canonicalises
// (`Integer.createInteger` is the one place it happens), so the invariant is what
// this site depends on and what `runtime/src/tests/hybridIntegers.spec.ts` is
// there to keep true.
function rawEquals(node: common.typedSimple.RawEqualsNode): estree.Expression {
	if (node.scalar === "Integer") {
		return {
			type: "BinaryExpression",
			operator: node.negated ? "!==" : "===",
			left: unboxedInteger(rewriteExpression(node.left)),
			right: unboxedInteger(rewriteExpression(node.right)),
		}
	}

	let equals: estree.Expression = {
		type: "CallExpression",
		optional: false,
		callee: memberRead(
			{ type: "Identifier", name: "$helpers" },
			"stringEquals",
		),
		arguments: [
			rewriteExpression(node.left),
			rewriteExpression(node.right),
		],
	}

	return node.negated
		? {
				type: "UnaryExpression",
				operator: "!",
				prefix: true,
				argument: equals,
			}
		: equals
}

// NOTE: The three exact operations, written INLINE around a guard rather than as
// a call — a call is what `lower-scalar-operations` took this site away from,
// and putting one back would give the saving away.
//
// NOTE: A hybrid Integer holds a number or a bigint, and JavaScript's `+`, `-`
// and `*` THROW on a mix of the two, so the two operands have to be known to be
// numbers before they meet. That is asked with `typeof` rather than with the
// range test the canonical invariant would also allow: the two decide the same
// question, but a range test compares a bigint against a double, which is a real
// comparison and measured ~10ns a side, while `typeof` is a tag read. On values
// that HAVE escaped — where the guard exists only to be refused — the range test
// cost 21ns a turn against 0.3, and it bought about 1ns a turn on values that had
// not.
//
// NOTE: The ANSWER is then checked against safe range, which is what keeps the
// result canonical, and the check is EXACT rather than a conservative
// approximation. IEEE 754 `+`, `-` and `*` are correctly rounded, so the double
// answer is the nearest double to the true result. Rounding is monotone and 2⁵³
// is itself a double, so a true result of magnitude ≥ 2⁵³ can only round to a
// double of magnitude ≥ 2⁵³ and fails the check; a true result inside safe range
// is exactly representable and rounds to itself. The check therefore passes
// exactly when the double IS the true result. Multiplication is the case worth
// stating: two factors well inside safe range can have a product far outside it,
// and the rounded product can not sneak back INSIDE — which is why the operands
// need no bound of their own beyond being numbers at all.
//
// NOTE: The escape arm hands the two RAW values to the runtime, which redoes the
// guard and falls to bigint. It is reached by an operation that left safe range
// and by one whose operands had already left it, and both are cold.
//
// NOTE: Every operand here is read through `unboxedInteger` rather than through
// `valueRead` — `unboxed-operand`, which is what keeps a CHAIN from building the
// Integer its next operation immediately takes apart.
function rawArithmetic(
	node: common.typedSimple.RawArithmeticNode,
): estree.Expression {
	let left = rewriteExpression(node.left)
	let right = rewriteExpression(node.right)
	let escaped: estree.Expression = {
		type: "CallExpression",
		optional: false,
		callee: memberRead(
			{ type: "Identifier", name: "Integer" },
			escapedArithmetic[node.operator],
		),
		arguments: [unboxedInteger(left), unboxedInteger(right)],
	}

	// NOTE: The guard reads each operand twice and the answer three times, so
	// an operand it can not read twice — anything with a call in it — is handed
	// to the runtime whole instead. What is left is what the hot sites are: a
	// name, a Record member, a pooled constant.
	if (!isRepeatable(left) || !isRepeatable(right)) {
		return escaped
	}

	let leftValue = valueRead(left)
	let rightValue = valueRead(right)
	let answer: estree.Expression = {
		type: "BinaryExpression",
		operator: node.operator,
		left: leftValue,
		right: rightValue,
	}

	return {
		type: "ConditionalExpression",
		test: allOf([
			heldAsNumber(leftValue),
			heldAsNumber(rightValue),
			...withinSafeRange(answer),
		]),
		consequent: boxedInteger(answer),
		alternate: escaped,
	}
}

// NOTE: An Integer around a value, written as the object the runtime's own
// constructor would have built. Reached only where the value is already
// canonical — the guard above IS what establishes that — so nothing here
// converts, and `Integer.createInteger` is what a value nothing is known about
// goes through instead.
function boxedInteger(value: estree.Expression): estree.ObjectExpression {
	return {
		type: "ObjectExpression",
		properties: [
			typeKeyProperty("Integer"),
			{
				type: "Property",
				key: { type: "Identifier", name: "value" },
				value,
				kind: "init",
				computed: false,
				method: false,
				shorthand: false,
			},
		],
	}
}

// NOTE: The Integer a walk builds where it ANSWERS, remembered by identity so
// that a walk nested in another does not build one only for the enclosing walk
// to take it apart on the same line. Its argument is a value the raw slot's own
// invariant has already made canonical, which is what makes taking it apart the
// identity.
//
// NOTE: By IDENTITY and not by shape, which is the whole reason this exists.
// `Integer.createInteger` is also how a counted walk boxes its index, and that
// index is a bigint spelling of a value a double holds exactly wherever the
// bounds straddle safe range — a call recognised by its shape would strip the
// canonicalisation that site is there to perform.
const exitBoxes = new WeakMap<estree.Expression, estree.Expression>()

function exitBox(value: estree.Expression): estree.Expression {
	let box = createdInteger(value)

	exitBoxes.set(box, value)

	return box
}

// NOTE: One Integer-valued Expression, read as the VALUE it holds. Written as a
// rewrite of the finished JavaScript rather than as a second emission mode,
// because what decides whether a slot is unboxed at all is a question about the
// emitted body — see `heldRaw` — and the answer is not known until that body
// exists. The text is the text either way.
//
// NOTE: A guarded arithmetic is read through both of its arms: the box the
// guarded arm would have built is never written, and the escaped arm reads the
// value off the Integer the runtime built. Both arms are values of one Integer,
// so reading both is the same rewrite twice. Anything else — a name, a call, a
// member — is read through as it stands.
//
// NOTE: Every site that reads an Integer for its value reads it through here and
// not through `valueRead`: the operands of an operation that escaped, the two
// sides of a comparison, the two sides of an equality, and the value a raw slot
// takes. `valueRead` is what is left where the Expression is not an Integer or
// where the read is the runtime's own — a Boolean's, a List's count, a bound.
function unboxedInteger(value: estree.Expression): estree.Expression {
	let held = exitBoxes.get(value)

	if (held !== undefined) {
		return held
	}

	if (value.type === "ConditionalExpression") {
		let guarded = boxedValue(value.consequent)

		if (guarded !== null) {
			return {
				type: "ConditionalExpression",
				test: value.test,
				consequent: guarded,
				alternate: valueRead(value.alternate),
			}
		}
	}

	return valueRead(value)
}

// NOTE: The value an emitted Integer LITERAL holds, and null for everything
// else. `boxedInteger` above is the one site that writes this shape, and the
// test is what it wrote: the hidden Type key answering `"Integer"` and one
// member named `value`. It can not answer yes for anything that is not an
// Integer — nothing else in the language carries that Type key — so a caller
// reading BOTH arms of a Conditional through it reads two Integers.
function boxedValue(node: estree.Expression): estree.Expression | null {
	if (node.type !== "ObjectExpression" || node.properties.length !== 2) {
		return null
	}

	let [tag, held] = node.properties

	if (
		tag?.type !== "Property" ||
		tag.value.type !== "Literal" ||
		tag.value.value !== "Integer" ||
		held?.type !== "Property" ||
		held.computed ||
		held.key.type !== "Identifier" ||
		held.key.name !== "value"
	) {
		return null
	}

	// NOTE: A Property's value is an Expression or a Pattern, and only a
	// destructuring writes the latter — this one was written by `boxedInteger`,
	// three lines up, out of an Expression.
	return held.value as estree.Expression
}

// NOTE: The runtime entry each operator escapes to. Each takes the two raw
// values, not the Integers around them — the guard already read them, and
// neither side wants an Integer built to be taken apart again.
const escapedArithmetic: Record<"+" | "-" | "*", string> = {
	"+": "sum",
	"-": "difference",
	"*": "product",
}

// NOTE: Which of its two representations a value an Integer holds is in — the
// one question about a hybrid Integer that a comparison can not ask, since `<`
// and `>` read both alike. Asked here as the tag read it is rather than as the
// range test the canonical invariant would also answer it with, because that
// test compares a bigint against a double whenever the answer is `false`.
function heldAsNumber(value: estree.Expression): estree.Expression {
	return typeIs(value, "===")
}

function heldAsBigInt(value: estree.Expression): estree.Expression {
	return typeIs(value, "!==")
}

function typeIs(
	value: estree.Expression,
	operator: "===" | "!==",
): estree.Expression {
	return {
		type: "BinaryExpression",
		operator,
		left: {
			type: "UnaryExpression",
			operator: "typeof",
			prefix: true,
			argument: value,
		},
		right: { type: "Literal", value: "number" },
	}
}

function withinSafeRange(
	value: estree.Expression,
): [estree.Expression, estree.Expression] {
	return [
		{
			type: "BinaryExpression",
			operator: ">=",
			left: value,
			right: numberLiteral(-SAFE_INTEGER),
		},
		{
			type: "BinaryExpression",
			operator: "<=",
			left: value,
			right: numberLiteral(SAFE_INTEGER),
		},
	]
}

// NOTE: A JavaScript number as a literal expression. JavaScript has no negative
// numeric literal — `-1` is a negation of `1`, and the emitter says so by
// refusing one — so a negative value is written as the negation it is.
function numberLiteral(value: number): estree.Expression {
	return value < 0
		? {
				type: "UnaryExpression",
				operator: "-",
				prefix: true,
				argument: { type: "Literal", value: -value },
			}
		: { type: "Literal", value }
}

function allOf(tests: Array<estree.Expression>): estree.Expression {
	return tests.reduce((left, right) => ({
		type: "LogicalExpression",
		operator: "&&",
		left,
		right,
	}))
}

// NOTE: Whether an emitted expression may be written into the output more than
// once. A name and a chain of plain member reads over one are: every value the
// Rewriter emits is a plain object, there are no accessors anywhere in the
// runtime or in what a Program can build, so reading `state.total.value` twice
// costs two loads and observes nothing. Everything else — a call above all — is
// evaluated once and once only.
function isRepeatable(node: estree.Expression): boolean {
	switch (node.type) {
		case "Identifier":
		case "Literal":
			return true
		case "MemberExpression":
			return (
				!node.computed &&
				!node.optional &&
				node.object.type !== "Super" &&
				isRepeatable(node.object)
			)
		default:
			return false
	}
}

// NOTE: The hidden Type key every runtime value carries, as emitted code
// reaches it: `$type.typeKeySymbol`, off the module alias every Program already
// imports. It is a Symbol, so it is invisible to `Object.keys` — which is what
// Record equality, the printer and the runtime Type checks read with — and a
// value branded here is indistinguishable from one the runtime branded.
function typeKey(): estree.MemberExpression {
	return memberRead({ type: "Identifier", name: "$type" }, "typeKeySymbol")
}

function typeKeyProperty(tag: string): estree.Property {
	return {
		type: "Property",
		key: typeKey(),
		value: { type: "Literal", value: tag },
		kind: "init",
		computed: true,
		method: false,
		shorthand: false,
	}
}

// NOTE: The same key, read off a value — what the runtime's own Type checks ask
// and what a `tag-test` is.
//
// NOTE: `optional` makes it `?.[…]`, for the one reader that asks about a value
// which may not be there at all: a Record Matcher is open, so a member it names
// can be missing from a value that reaches the test, and a read of a missing
// member is `undefined`. Optional chaining answers `undefined` for it instead of
// throwing, and `undefined` equals no tag.
//
// NOTE: And it is WRAPPED, because an optional read is a `ChainExpression` in
// ESTree and a bare `MemberExpression` carrying `optional` is not a tree the
// grammar has — the chain is the Node that says where the short circuit stops.
// It prints the same either way, so this is the shape being right rather than
// the output changing.
function typeKeyRead(
	object: estree.Expression,
	optional = false,
): estree.Expression {
	let read: estree.MemberExpression = {
		type: "MemberExpression",
		optional,
		computed: true,
		object,
		property: typeKey(),
	}

	return optional ? { type: "ChainExpression", expression: read } : read
}

// NOTE: Member names go through the same `memberKey` quoting every other
// emitted Record member does — an Essence name JavaScript can not spell becomes
// a string key, and the read of it agrees because both positions ask this one
// question.
function memberProperties(
	members: Record<string, common.typedSimple.ExpressionNode>,
): Array<estree.Property> {
	return Object.entries(members).map(([name, value]) => ({
		type: "Property",
		key: memberKey(name),
		value: rewriteExpression(value),
		kind: "init",
		computed: false,
		method: false,
		shorthand: false,
	}))
}

// NOTE: A Case is its payload Record with a nominal tag riding along on the
// hidden Type key — `$type.createCase` copies the payload and stamps the tag,
// which is what lets `@.left`-style member access work on the Case value
// directly.
function rewriteCaseValue(
	node: common.typedSimple.CaseValueNode,
): estree.CallExpression {
	let args: Array<estree.Expression> = [
		{ type: "Literal", value: renderIdentity(node.tag) },
	]

	if (node.value !== null) {
		args.push(rewriteExpression(node.value))
	}

	return {
		type: "CallExpression",
		optional: false,
		callee: {
			type: "MemberExpression",
			optional: false,
			object: { type: "Identifier", name: "$type" },
			property: { type: "Identifier", name: "createCase" },
			computed: false,
		},
		arguments: args,
	}
}

// NOTE: A conformance value is an object literal that maps each Protocol
// Method's emitted name onto the conforming Namespace's fulfilling Method —
// `{ compare: Integer.compare, … }`. This works uniformly for user
// Namespaces (classes with static Methods) and builtin runtime modules, and
// decouples the Protocol's method names from the Namespace's layout.
function rewriteConformanceValue(
	node: common.typedSimple.ConformanceValueNode,
): estree.ObjectExpression | estree.CallExpression {
	let methodMap: estree.ObjectExpression = {
		type: "ObjectExpression",
		properties: Object.entries(node.methodMap).map(
			([protocolMethodName, namespaceMethodName]): estree.Property => ({
				type: "Property",
				key: memberKey(protocolMethodName),
				value: namespaceMember(
					node.namespaceName,
					namespaceMethodName,
					node.derivedDescriptor,
				),
				kind: "init",
				method: false,
				shorthand: false,
				computed: false,
			}),
		),
	}

	// NOTE: An unconditional conformance is exactly the plain method-map object
	// literal — kept byte-identical so its emit snapshots do not churn. A
	// conditional one wraps it in `$type.boundConformance(<map>, [<witnesses>])`,
	// which curries each `where` condition's witness onto every Method so the
	// bounded runtime helpers receive them as hidden trailing Arguments.
	if (node.conditions.length === 0) {
		return methodMap
	}

	return {
		type: "CallExpression",
		optional: false,
		callee: {
			type: "MemberExpression",
			optional: false,
			object: { type: "Identifier", name: "$type" },
			property: { type: "Identifier", name: "boundConformance" },
			computed: false,
		},
		arguments: [
			methodMap,
			{
				type: "ArrayExpression",
				elements: node.conditions.map((condition) =>
					rewriteExpression(condition),
				),
			},
		],
	}
}

function rewriteVariableAssignmentStatement(
	node: common.typedSimple.VariableAssignmentStatementNode,
): estree.AssignmentExpression {
	return {
		type: "AssignmentExpression",
		operator: "=",
		left: rewriteIdentifier(node.name),
		right: rewriteExpression(node.value),
	}
}

// NOTE: A read off the runtime `functions` module (`$_.<name>`) — the one place
// a free Function bound to the runtime is reached. The `$_` import is emitted
// unconditionally at the top of every Program.
function functionsModuleMember(name: string): estree.MemberExpression {
	return {
		type: "MemberExpression",
		optional: false,
		object: {
			type: "Identifier",
			name: "$_",
		},
		property: {
			type: "Identifier",
			name,
		},
		computed: false,
	}
}

function rewriteFunctionInvocation(
	node: common.typedSimple.FunctionInvocationNode,
): estree.CallExpression {
	// NOTE: A native free Function is a read off the runtime `functions` module,
	// exactly as a native Method is a read off its Namespace import. Its callee is
	// a bare Identifier — already `__overload$N`-mangled by the Simplifier when it
	// was overloaded — so the native set is consulted by that emitted name. Every
	// other callee (a user Function, an Essence-bodied one, a Function-valued
	// Expression) stays whatever `rewriteExpression` makes of it.
	let callee: estree.Expression =
		node.name.nodeType === "Identifier" &&
		nativeFreeFunctionNames().has(node.name.name)
			? functionsModuleMember(node.name.name)
			: rewriteExpression(node.name)

	return {
		type: "CallExpression",
		optional: false,
		callee,
		arguments: node.arguments.map((arg) => rewriteArgument(arg)),
	}
}

// NOTE: One reference to a member of a standard library Namespace, in the one
// place every emission site routes through. A native member — Method or static
// Property — stays a read off the plain `import * as <Namespace>`, which esbuild
// rewrites to a direct symbol reference and can therefore tree-shake, while an
// Essence-implemented one is not a member of anything: it is its own top-level
// const, reached by a bare `$es_<Namespace>_<member>` Identifier, so nothing has
// to materialise the module namespace object to get at it. The literal constructors
// (`String.createString`, `List.createList`, …) do NOT come through here: they
// name their Namespace directly and are not declared in `packages/standard-library/sources`, so they
// can never be Essence-implemented.
function namespaceMember(
	namespaceName: string,
	memberName: string,
	derivedDescriptor?: common.DerivedEquatableDescriptor,
): estree.Expression {
	// NOTE: A Choice's derived equality names a Namespace that exists nowhere —
	// the Enricher fabricates it per receiver and nothing is ever emitted for
	// it — so the one reference to it becomes the runtime helper directly.
	// Every emission site (a plain call, a dispatch branch, a conformance
	// witness) routes through here, so this one redirect covers all three.
	if (namespaceName === derivedEquatableNamespaceName) {
		// NOTE: A *generic* Choice widens to the descriptor-driven helper, curried
		// with the plan its payloads follow — the hidden conformance Arguments
		// then arrive as its trailing Parameters. A non-generic Choice carries no
		// descriptor and stays the byte-identical flat helper, so its emission
		// never churns.
		if (derivedDescriptor !== undefined) {
			return {
				type: "CallExpression",
				optional: false,
				callee: {
					type: "MemberExpression",
					optional: false,
					computed: false,
					object: { type: "Identifier", name: "$helpers" },
					property: {
						type: "Identifier",
						name:
							memberName === "isNot"
								? "boundChoiceIsNot"
								: "boundChoiceIs",
					},
				},
				arguments: [jsonExpression(derivedDescriptor)],
			}
		}

		return {
			type: "MemberExpression",
			optional: false,
			computed: false,
			object: { type: "Identifier", name: "$helpers" },
			property: {
				type: "Identifier",
				name: memberName === "isNot" ? "choiceIsNot" : "choiceIs",
			},
		}
	}

	// NOTE: The `$es_<Namespace>_<member>` const belongs to the STANDARD LIBRARY's
	// Namespace of that name, so a user Namespace shadowing it must not be routed
	// to one: `namespace List for Integer { contains(…) }` emitted
	// `$es_List_contains(5, 5)` — the library's List.contains, run against an
	// Integer — where the user's own class Method was written. The same lexical
	// answer decides it as decides the Identifier below.
	let essenceName = isShadowingUserNamespace(namespaceName)
		? null
		: (essenceMethodName(namespaceName, memberName) ??
			essencePropertyName(namespaceName, memberName))

	if (essenceName !== null) {
		return { type: "Identifier", name: essenceName }
	}

	return memberRead(
		{ type: "Identifier", name: namespaceIdentifierName(namespaceName) },
		isBuiltinNamespaceReference(namespaceName)
			? memberName
			: namespaceMemberName(memberName),
	)
}

function rewriteMethodInvocation(
	node: common.typedSimple.MethodInvocationNode,
): estree.CallExpression {
	return {
		type: "CallExpression",
		optional: false,
		callee: namespaceMember(
			node.base.name,
			node.member.name,
			node.derivedDescriptor,
		),
		arguments: node.arguments.map((arg) => rewriteArgument(arg)),
	}
}

// NOTE: A Method Invocation on a Union-typed receiver — emitted as
// `$type.dispatchMethod(receiver, [args…], [[descriptor, Namespace.method,
// [conformances…], [[index, argument], …]], …])`. The helper evaluates receiver
// and Arguments once and runs the first case whose member Type descriptor
// accepts the receiver; the Enricher ordered the cases most specific first and
// guarantees one matches.
//
// NOTE: The fourth element is omitted where a branch has no Argument of its own
// — which is every dispatch that passes no contextually typed Function literal
// — so what such a call emits is unchanged, byte for byte.
function rewriteUnionMethodInvocation(
	node: common.typedSimple.UnionMethodInvocationNode,
): estree.CallExpression {
	return {
		type: "CallExpression",
		optional: false,
		callee: {
			type: "MemberExpression",
			optional: false,
			object: { type: "Identifier", name: "$type" },
			property: { type: "Identifier", name: "dispatchMethod" },
			computed: false,
		},
		arguments: [
			rewriteExpression(node.base),
			{
				type: "ArrayExpression",
				elements: node.arguments.map((arg) => rewriteArgument(arg)),
			},
			{
				type: "ArrayExpression",
				elements: node.cases.map(
					(dispatchCase): estree.ArrayExpression => ({
						type: "ArrayExpression",
						elements: [
							typeDescriptorExpression(
								dispatchCase.memberType,
								"a Union dispatch case",
							),
							namespaceMember(
								dispatchCase.namespaceName,
								dispatchCase.methodName,
								dispatchCase.derivedDescriptor,
							),
							{
								type: "ArrayExpression",
								elements: dispatchCase.conformanceArguments.map(
									(arg) => rewriteArgument(arg),
								),
							},
							...(dispatchCase.contextualArguments.length === 0 &&
							dispatchCase.omittedParameterIndices.length === 0
								? []
								: [
										contextualArgumentOverrides(
											dispatchCase.contextualArguments,
										),
									]),
							// NOTE: The Parameters THIS branch leaves out, as
							// the runtime takes them — a fifth case element,
							// emitted only where there are any, so a dispatch
							// that omits nothing emits exactly what it always
							// did. The fourth element has to stand for the
							// fifth to be reachable, which is why an omission
							// forces an (often empty) override array in front
							// of it.
							...(dispatchCase.omittedParameterIndices.length ===
							0
								? []
								: [
										{
											type: "ArrayExpression" as const,
											elements:
												dispatchCase.omittedParameterIndices.map(
													(
														index,
													): estree.Expression => ({
														type: "Literal",
														value: index,
													}),
												),
										},
									]),
						],
					}),
				),
			},
		],
	}
}

// NOTE: The Arguments one dispatch branch is given in place of the shared ones,
// as the runtime takes them: a pair per Argument, naming the position it stands
// in for. The position is the Argument's own index in the Invocation, which the
// receiver — passed separately — is not part of.
function contextualArgumentOverrides(
	contextualArguments: common.typedSimple.UnionMethodDispatchCase["contextualArguments"],
): estree.ArrayExpression {
	return {
		type: "ArrayExpression",
		elements: contextualArguments.map(
			(contextualArgument): estree.ArrayExpression => ({
				type: "ArrayExpression",
				elements: [
					{ type: "Literal", value: contextualArgument.index },
					rewriteArgument(contextualArgument.argument),
				],
			}),
		),
	}
}

function rewriteCombination(
	node: common.typedSimple.CombinationNode,
): estree.CallExpression {
	return {
		type: "CallExpression",
		optional: false,
		callee: {
			type: "MemberExpression",
			optional: false,
			computed: false,
			object: {
				type: "Identifier",
				name: "Object",
			},
			property: {
				type: "Identifier",
				name: "assign",
			},
		},
		arguments: [
			{
				type: "ObjectExpression",
				properties: [],
			},
			rewriteExpression(node.lhs),
			rewriteExpression(node.rhs),
		],
	}
}

function rewriteRecordValue(
	node: common.typedSimple.RecordValueNode,
): estree.CallExpression {
	return {
		type: "CallExpression",
		optional: false,
		callee: {
			type: "MemberExpression",
			optional: false,
			object: {
				type: "Identifier",
				name: "Record",
			},
			property: {
				type: "Identifier",
				name: "createRecord",
			},
			computed: false,
		},
		arguments: [
			{
				type: "ObjectExpression",
				properties: Object.entries(node.members).map<estree.Property>(
					([key, value]) => {
						return {
							type: "Property",
							key: memberKey(key),
							value: rewriteExpression(value),
							kind: "init",
							computed: false,
							method: false,
							shorthand: false,
						}
					},
				),
			},
		],
	}
}

function rewriteStringValue(
	node: common.typedSimple.StringValueNode,
): estree.CallExpression {
	return {
		type: "CallExpression",
		optional: false,
		callee: {
			type: "MemberExpression",
			optional: false,
			object: {
				type: "Identifier",
				name: "String",
			},
			property: {
				type: "Identifier",
				name: "createString",
			},
			computed: false,
		},
		arguments: [
			{
				type: "Literal",
				value: node.value,
			},
		],
	}
}

// NOTE: An interpolated String folds into one `String.createString(<concat>)`,
// where the concatenation `+`-joins the text runs (plain JS string Literals)
// with each hole rendered by its witness — `<witness>.toString(<hole>).value`,
// the JS string the Printable conformance produces. The whole thing is string
// concatenation because `segments` always begins with a text run (`""` when the
// first thing written is a hole), so the fold starts from a Literal. No runtime
// helper is added: this is the same `toString` call `List::join` makes at run
// time, inlined per hole.
// NOTE: What renders one hole — `<witness>.toString` read off the method map,
// and the Method ITSELF where `devirtualise-witnesses` has already said which
// one it is. This is the one emission site that consumes a witness rather than
// passing it on, which is why it is the one site that pass has anything to do.
function holeRenderer(
	witness: common.typedSimple.ExpressionNode,
): estree.Expression {
	if (witness.nodeType === "Intrinsic" && witness.kind === "direct-method") {
		return rewriteExpression(witness)
	}

	return memberRead(rewriteExpression(witness), "toString")
}

function rewriteInterpolatedStringValue(
	node: common.typedSimple.InterpolatedStringValueNode,
): estree.CallExpression {
	let parts: Array<estree.Expression> = node.segments.map((segment) => {
		if (segment.kind === "text") {
			return { type: "Literal", value: segment.value }
		}

		return memberRead(
			{
				type: "CallExpression",
				optional: false,
				callee: holeRenderer(segment.witness),
				arguments: [rewriteExpression(segment.expression)],
			},
			"value",
		)
	})

	let concatenated = parts.reduce(
		(left, right): estree.Expression => ({
			type: "BinaryExpression",
			operator: "+",
			left,
			right,
		}),
	)

	return {
		type: "CallExpression",
		optional: false,
		callee: memberRead(
			{ type: "Identifier", name: "String" },
			"createString",
		),
		arguments: [concatenated],
	}
}

// NOTE: A Number Literal is decimal digits and nothing else — Essence has no
// hexadecimal, binary or exponent form — and the Lexer is what refuses the rest,
// with a positioned Diagnostic naming the text the author wrote. This is the
// belt to that braces: `BigInt` is not a decimal parser, it reads `"0xFF"` as
// 255 and THROWS on `"FF"`, so a digit string that ever slipped past the Lexer
// would either compile to a silently different number or abort the Rewriter with
// a JavaScript SyntaxError carrying no source location at all. Keeping the
// leading decimal run — and 0 when there is none — makes the emission total, and
// leaves a well-formed Literal byte-identical.
function decimalDigits(value: string): string {
	let digits = /^-?[0-9]+/.exec(value)?.[0]

	return digits === undefined ? "0" : digits
}

// NOTE: The literal is written in the representation the value CANONICALLY has
// — a JavaScript number where a double holds it exactly, a bigint beyond that —
// so that `createInteger` has nothing to convert and a pooled literal is already
// the shape every comparison against it expects.
function rewriteIntegerValue(
	node: common.typedSimple.IntegerValueNode,
): estree.CallExpression {
	let value = decimalDigits(node.value)
	let held = BigInt(value)

	if (held >= -BigInt(SAFE_INTEGER) && held <= BigInt(SAFE_INTEGER)) {
		return {
			type: "CallExpression",
			optional: false,
			callee: memberRead(
				{ type: "Identifier", name: "Integer" },
				"createInteger",
			),
			arguments: [numberLiteral(Number(held))],
		}
	}

	return {
		type: "CallExpression",
		optional: false,
		callee: {
			type: "MemberExpression",
			optional: false,
			object: {
				type: "Identifier",
				name: "Integer",
			},
			property: {
				type: "Identifier",
				name: "createInteger",
			},
			computed: false,
		},
		arguments: [
			{
				type: "Literal",
				bigint: value,
				value: BigInt(value),
			},
		],
	}
}

function rewriteRationalValue(
	node: common.typedSimple.RationalValueNode,
): estree.CallExpression {
	let numerator = decimalDigits(node.numerator)
	let denominator = decimalDigits(node.denominator)

	return {
		type: "CallExpression",
		optional: false,
		callee: {
			type: "MemberExpression",
			optional: false,
			object: {
				type: "Identifier",
				name: "Rational",
			},
			property: {
				type: "Identifier",
				name: "createRational",
			},
			computed: false,
		},
		arguments: [
			{
				type: "Literal",
				bigint: numerator,
				value: BigInt(numerator),
			},
			{
				type: "Literal",
				bigint: denominator,
				value: BigInt(denominator),
			},
		],
	}
}

function rewriteBooleanValue(
	node: common.typedSimple.BooleanValueNode,
): estree.CallExpression {
	return {
		type: "CallExpression",
		optional: false,
		callee: {
			type: "MemberExpression",
			optional: false,
			object: {
				type: "Identifier",
				name: "Boolean",
			},
			property: {
				type: "Identifier",
				name: "createBoolean",
			},
			computed: false,
		},
		arguments: [
			{
				type: "Literal",
				value: node.value,
			},
		],
	}
}

function rewriteFunctionValue(
	node: common.typedSimple.FunctionValueNode,
): estree.FunctionExpression {
	return rewriteFunctionExpression(node.value)
}

function rewriteListValue(
	node: common.typedSimple.ListValueNode,
): estree.CallExpression {
	return {
		type: "CallExpression",
		optional: false,
		callee: {
			type: "MemberExpression",
			optional: false,
			object: {
				type: "Identifier",
				name: "List",
			},
			property: {
				type: "Identifier",
				name: "createList",
			},
			computed: false,
		},
		arguments: [
			{
				type: "ArrayExpression",
				elements: node.values.map((expr) => rewriteExpression(expr)),
			},
		],
	}
}

// NOTE: A Lookup reaches here for a static Method call (`Number.sum(…)`), a
// static Property read (`Number.Pi`) and a plain Record member access
// (`record.field`). Only the first two name a Namespace, and WHICH of the three
// this is has to be read off the base's resolved Type, not off its spelling: a
// local may be named after a Namespace — `constant Optional = { otherwise = 5 }`
// is a legal Program the Enricher types as a Record — and deciding by the name
// alone sent `Optional.otherwise` through `namespaceMember`, which answered with
// the standard library's `$es_Optional_otherwise` Function in place of the
// field. That miscompiled silently: it type checks, it emits, and the value is
// simply the wrong one. Every other base — a shadowing local, a chained access,
// a call result — keeps the plain member read.
function rewriteLookup(node: common.typedSimple.LookupNode): estree.Expression {
	if (
		node.base.nodeType === "Identifier" &&
		node.base.type.type === "Namespace"
	) {
		return namespaceMember(node.base.name, node.member.name)
	}

	return memberRead(rewriteExpression(node.base), node.member.name)
}

// NOTE: The JavaScript words that can not be a binding or a bare reference —
// `case`, `default`, `new`, `class` — but ARE legal Essence identifiers, so a
// Parameter or Constant can be named one and reach here. `with`, `for`, `if`,
// `case`, `static` are Essence keywords too, yet the Parser still lets them name
// a Parameter's internal name, so the full JavaScript set is what matters. The
// list is the reserved words plus the ones a strict-mode module also forbids
// (`let`, `static`, `implements`, …, `arguments`, `eval`) — emitted code is an
// ES module, so it runs strict.
const reservedJavaScriptWords = new Set([
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"function",
	"if",
	"import",
	"in",
	"instanceof",
	"new",
	"null",
	"return",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"typeof",
	"var",
	"void",
	"while",
	"with",
	"yield",
	"let",
	"static",
	"implements",
	"interface",
	"package",
	"private",
	"protected",
	"public",
	"await",
	"arguments",
	"eval",
])

// NOTE: The names the emitted Program binds — or reads off the host — for its
// OWN purposes: the runtime Namespace imports (`List`, `String`, …), the three
// module aliases beside them, and the global `Object` a Combination's
// `Object.assign` reaches for. None of them is an Essence keyword and none can
// be reported to the author as taken, so a Program is free to bind any of them
// itself — and ordinary JavaScript lexical scoping then rebinds every emitted
// `List.createList(…)`, `$type.isValueOfType(…)` and `Object.assign(…)` below it
// to the user's value. `constant List = 5` beside a List literal is a
// `TypeError` out of a Program that compiled green, and `$type`/`$helpers` are
// worse: `$` is a legal Essence identifier character, so they are names a user
// can write without any way of knowing they are spoken for. Every one of them is
// therefore a name the user half of the Program can not hold — `escapeName`
// mangles it instead, at the binding and at every reference alike.
const compilerOwnedNames = new Set([
	...runtimeNamespaceNames,
	"$_",
	"$type",
	"$helpers",
	"Object",
	// NOTE: A counted walk whose bounds escaped safe range converts its start
	// with it, so a Program declaring its own `BigInt` would take the
	// conversion away from the loop it sits above.
	"BigInt",
])

// NOTE: The builtin Namespaces as a set, for the one question emission asks of
// a Namespace name: is this the `import * as <Name>` the Program opens with, or
// a user's `class`?
const runtimeNamespaceNameSet = new Set(runtimeNamespaceNames)

// NOTE: A JavaScript IdentifierName, spelled as the specification does — an
// ID_Start (or `$`/`_`) followed by ID_Continue — so an Essence name that is
// already a legal JavaScript one is emitted untouched, accents and all. The
// Lexer ends an Identifier only at one of ITS symbols, and `?`, `+`, `!`, `%`,
// `*`, `&`, `^`, `;` and `'` are not among them, so `ok?` and `a+b` are single
// Identifier Tokens that every stage carries to here. Emitted raw they are not
// JavaScript at all, and the build died in the bundler — an esbuild syntax error
// quoting generated text, at a line number that does not exist in the author's
// file.
const javaScriptIdentifierName =
	/^[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*$/u

function isJavaScriptIdentifierName(name: string): boolean {
	return javaScriptIdentifierName.test(name)
}

// NOTE: The escape hatch for a name JavaScript can not spell, or one the
// compiler has already spoken for. Every character JavaScript accepts unchanged
// is kept, and every other becomes `_<code point in hex>_` — an encoding that is
// injective, because `_` can appear NOWHERE else in the result: the Lexer reads
// `_` as a Symbol, so no Essence identifier contains one, and the kept
// characters are exactly `[A-Za-z0-9$]`. Two different names therefore can not
// mangle alike, and the `$user_` prefix — itself unspellable in Essence, for the
// same reason — keeps the whole space clear of the compiler's own `$es_…`
// consts, `$type`, `$_`, `_self` and the `_`-escaped reserved words.
const mangledNamePrefix = "$user_"
const keptMangledCharacter = /^[A-Za-z0-9$]$/

function mangleName(name: string): string {
	let mangled = mangledNamePrefix

	for (let character of name) {
		mangled += keptMangledCharacter.test(character)
			? character
			: `_${character.codePointAt(0)!.toString(16)}_`
	}

	return mangled
}

// NOTE: One Essence name as the emitted Program binds and reads it. Three things
// can be wrong with it, and a name is left ALONE unless one of them is — which
// is what keeps every ordinary Program's emission byte-identical:
//
//   spelled like the compiler's own    `List`, `$type`   → mangled
//   not a JavaScript IdentifierName    `ok?`, `a+b`      → mangled
//   a JavaScript reserved word         `new`, `default`  → `_`-prefixed
//
// The reserved-word escape stays its own, older answer: `_case` can not be a
// user's own identifier and no reserved word starts with `_`, so it is injective
// on its own, and it does not collide with a mangled name, which always begins
// `$user_`. Member and property positions do NOT come through here — a reserved
// word is a legal property key (`record.case`, `{ case: … }`) and escaping one
// would part it from the key the Record literal wrote. `memberKey` answers for
// those.
//
// NOTE: Exported because a host binding names off an Export Surface has to ask
// the same question — an Essence Module exports `square` and `ok?`, and the
// bundle binds `square` and `$user_ok_3f_`. Answering it a second time
// somewhere else is how the two spellings drift apart.
export function escapeName(name: string): string {
	if (compilerOwnedNames.has(name) || !isJavaScriptIdentifierName(name)) {
		return mangleName(name)
	}

	return reservedJavaScriptWords.has(name) ? `_${name}` : name
}

function rewriteIdentifier(
	node: common.typedSimple.IdentifierNode,
): estree.Identifier {
	return {
		type: "Identifier",
		name: escapeName(node.name),
	}
}

// NOTE: A Namespace's emitted binding. A builtin's name IS the `import * as
// <Name>` the Program opens with, so it is emitted verbatim — escaping it would
// part every reference from the import. Every other Namespace is a user's,
// emitted as a `class <Name>`, and its name is an ordinary Essence identifier:
// `namespace new for Integer` and `namespace Object for Integer` both parse. So
// it is escaped exactly as a Constant is — here, at the class declaration, and
// in `namespaceMember`, at every reference — which is what keeps the two
// agreeing. They did not: the declaration was escaped and the references were
// not, so `constant this = { x = 1 }` bound `_this` and read `this.x`.
//
// NOTE: A user Namespace named after a builtin — `namespace List for Integer` —
// is refused where the Enricher can see it: at the top level `List` is already
// declared, and the answer is 'Variable 'List' is already declared'. A NESTED
// one is accepted, because it declares `List` in an inner Scope where nothing is
// taken yet, and it used to be emitted verbatim as well: the `class List` inside
// the Function then shadowed the `import * as List` for the rest of that block,
// so the List literal two lines below it called the user's class and died with
// `List.createList is not a function` out of a Program that compiled green.
//
// The two ARE tellable apart, and lexically: a name is the user's inside the
// block that declares it and the import everywhere else, which is exactly what
// `shadowingNamespaceScopes` tracks. The user's is mangled — declaration and
// every reference alike — and the import keeps the name it was imported under,
// so a List literal beside a `namespace List` calls the runtime and
// `21::doubledValue()` calls `$user_List`.
function isBuiltinNamespaceReference(namespaceName: string): boolean {
	return (
		runtimeNamespaceNameSet.has(namespaceName) &&
		!isShadowingUserNamespace(namespaceName)
	)
}

function namespaceIdentifierName(namespaceName: string): string {
	return isBuiltinNamespaceReference(namespaceName)
		? namespaceName
		: escapeName(namespaceName)
}

// NOTE: The user Namespaces in lexical scope right now whose name the compiler
// has already spoken for — one Set per emitted block, innermost last. Only a
// name in `compilerOwnedNames` is ever recorded: every other Namespace name
// means the same thing wherever it is written, and `escapeName` already answers
// for it without any scope to consult.
//
// NOTE: The stack mirrors the Enricher's own Scope chain, and that is what makes
// it exact rather than a guess. A nested Namespace does not merely add a name —
// it REPLACES the builtin of that name for the rest of its block, in Method
// resolution ('No Method named 'firstItem'' for a List beside a
// `namespace List`) and in conformance solving alike ('String does not conform
// to 'Comparable'' beside a `namespace String`). So inside the block every
// `List` a Node can carry is the user's, and outside it every one is the
// import — including the ones that arrive as a bare string with no Type to ask,
// a `UnionMethodInvocation`'s dispatch case and a `ConformanceValue`'s witness.
let shadowingNamespaceScopes: Array<Set<string>> = [new Set()]

// NOTE: `finally`, so a throw out of the Rewriter — the one for a Lookup on a
// native invocation, say — can not leave the stack deeper than it found it and
// mangle a Namespace name in the NEXT Program this process compiles.
function withNamespaceScope<Value>(rewriteScope: () => Value): Value {
	shadowingNamespaceScopes.push(new Set())

	try {
		return rewriteScope()
	} finally {
		shadowingNamespaceScopes.pop()
	}
}

function declareUserNamespace(namespaceName: string): void {
	if (compilerOwnedNames.has(namespaceName)) {
		shadowingNamespaceScopes.at(-1)!.add(namespaceName)
	}
}

function isShadowingUserNamespace(namespaceName: string): boolean {
	return shadowingNamespaceScopes.some((scope) => scope.has(namespaceName))
}

// NOTE: A name in KEY or PROPERTY position — a Record field, a Namespace's
// static Method, a Protocol Method in a conformance witness. It is never
// escaped: a reserved word is a legal property key, and the read has to match
// the key the literal wrote. It does still have to be spellable, though, and an
// Essence identifier may hold characters no JavaScript IdentifierName may — so
// such a name becomes a string Literal instead. `{ "ok?": … }` and
// `record["ok?"]` are the same property under a spelling JavaScript accepts, and
// because both positions ask this one question they still agree.
function memberKey(name: string): estree.Identifier | estree.Literal {
	return isJavaScriptIdentifierName(name)
		? { type: "Identifier", name }
		: { type: "Literal", value: name }
}

// NOTE: A user Namespace is a `class`, and a class refuses two member names an
// object literal accepts: no static member may be named `prototype` and no
// field may be named `constructor` — computed keys only move the refusal from
// the parser to a `TypeError` at definition. `namespace Shape for Shape {
// prototype () -> … }` is a legal Program, so such a member is mangled instead,
// at the class body and at every read alike — `namespaceMember` is the one
// place every read routes through, which is what keeps the two agreeing. A
// builtin's members are module exports, not class members, so they keep their
// names.
//
// NOTE: Exported for the same reason `escapeName` is — a host binding reads a
// Namespace's members off the emitted class, so it has to ask the same
// question.
const forbiddenClassMemberNames = new Set(["prototype", "constructor"])

export function namespaceMemberName(name: string): string {
	return forbiddenClassMemberNames.has(name) ? mangleName(name) : name
}

// NOTE: One member read, `computed` iff the key had to become a Literal — the
// dotted form for every ordinary name, the bracketed one for the rest.
// NOTE: A spine before the spines it is a prefix of, so a requirement about
// `payload` is tested before one about `payload.origin` — the second reads
// through what the first established. Sorted by depth rather than by text,
// because that is the property being relied on.
function shallowestFirst(spines: Array<string>): Array<string> {
	return [...spines].sort(
		(left, right) => left.split(".").length - right.split(".").length,
	)
}

function memberRead(
	object: estree.Expression,
	name: string,
): estree.MemberExpression {
	return {
		type: "MemberExpression",
		optional: false,
		object,
		property: memberKey(name),
		computed: !isJavaScriptIdentifierName(name),
	}
}

function callIsValueOfType(
	value: estree.Expression,
	matcher: common.Type,
): estree.CallExpression {
	// TODO: Handle Record Types
	return {
		type: "CallExpression",
		optional: false,
		callee: memberRead(
			{ type: "Identifier", name: "$type" },
			"isValueOfType",
		),
		arguments: [
			value,
			typeDescriptorExpression(matcher, "a Match Handler's Matcher"),
		],
	}
}

function callAnyIs(
	value: estree.Expression,
	literal: estree.Expression,
): estree.CallExpression {
	return {
		type: "CallExpression",
		optional: false,
		callee: memberRead({ type: "Identifier", name: "$helpers" }, "anyIs"),
		arguments: [value, literal],
	}
}

// NOTE: A literal Matcher needs no Type check in front of it — `anyIs`
// already answers false across differing Types. A Guard is ANDed on after
// whichever check the Matcher produced, so it only ever narrows.
//
// NOTE: A Handler carrying a residual test was given one by
// `compile-type-tests`, which found something cheaper that answers what the
// Matcher's check answers — a tag comparison in place of a descriptor, or a
// raw comparison in place of `anyIs` over a scalar literal. It reads the value
// under the same `_self` this binds, so it goes where the call would have gone
// and everything ANDed on after it is unchanged. It is asked FIRST for that
// reason: it stands for whatever the Matcher's own half was, literal or not.
function handlerTest(
	handler: common.typedSimple.MatchHandler,
	value: estree.Identifier,
	tagName: string | null,
): estree.Expression {
	let and = (
		left: estree.Expression,
		right: estree.Expression,
	): estree.Expression => ({
		type: "LogicalExpression",
		operator: "&&",
		left,
		right,
	})

	let test: estree.Expression
	let selfTagTest = selfTagTestOf(handler)

	if (handler.typeTest !== null) {
		test =
			tagName !== null && selfTagTest !== null
				? boundTagTest(tagName, selfTagTest)
				: rewriteExpression(handler.typeTest)
	} else if (handler.literal !== null) {
		test = callAnyIs(value, rewriteExpression(handler.literal))
	} else {
		test = callIsValueOfType(value, handler.matcher)
	}

	// NOTE: The member comparisons come after the Matcher's own check and
	// rely on `&&` short-circuiting — that check is what guarantees the
	// value is a Record carrying every member named here, so reading them
	// is only safe once it has passed.
	//
	// A key is the DOTTED SPINE that reaches the member, so a Pattern that
	// constrains a nested member by value — `{ origin as { x = 0 } }` — reads
	// its way down. A member name can hold no dot, so splitting on one can not
	// mistake anything else for a spine.
	// NOTE: What a Case Matcher's payload Pattern requires of a member, tested
	// behind the Matcher's own check and BEFORE any member comparison. The
	// order is load-bearing rather than tidy: a value comparison may read down
	// a spine — `@.payload.origin.x` — and only these requirements establish
	// that the spine exists. Shallowest first, for the same reason.
	//
	// `memberTests` is what `compile-type-tests` leaves where it has DECIDED a
	// requirement — a tag comparison where the tag decides it, and otherwise the
	// same check over a descriptor `pool-constants` can hoist out of the test.
	// Without that pass the requirement is emitted from its Type instead, which
	// is the same question asked the general way, so a build with the Optimiser
	// off answers what an optimised one answers.
	if (handler.memberTests !== null) {
		for (let path of shallowestFirst(Object.keys(handler.memberTests))) {
			test = and(test, rewriteExpression(handler.memberTests[path]!))
		}
	} else if (handler.memberTypes !== null) {
		for (let path of shallowestFirst(Object.keys(handler.memberTypes))) {
			let read = path.split(".").reduce(memberRead, value)

			test = and(
				test,
				callIsValueOfType(read, handler.memberTypes[path]!),
			)
		}
	}

	if (handler.memberLiterals !== null) {
		for (let [path, literal] of Object.entries(handler.memberLiterals)) {
			let read = path.split(".").reduce(memberRead, value)

			test = and(test, callAnyIs(read, rewriteExpression(literal)))
		}
	}

	if (handler.guard === null) {
		return test
	}

	return and(test, valueRead(rewriteExpression(handler.guard)))
}

// NOTE: The `else` no Handler owns — the one branch taken when every
// Matcher declined. The Validator has already refused a Match that leaves
// a member of its Union unhandled, so this is dead code in a Program that
// compiled clean; it exists because it did NOT used to, and the chain
// ending in nothing was invisible: the wrapper answered `undefined`, which
// is not an Essence value, and the Program failed later and elsewhere —
// with a `TypeError` out of whatever read the missing Type key, or with
// `undefined` flowing on as if it were a result. It is the innermost
// `else` rather than a Statement after the chain on purpose: a Handler
// body is not obliged to return (a Match in Statement position is written
// for its effects), so a Handler that ran and fell through must NOT reach
// it.
function noCaseMatched(value: estree.Identifier): estree.ExpressionStatement {
	return {
		type: "ExpressionStatement",
		expression: {
			type: "CallExpression",
			optional: false,
			callee: memberRead(
				{ type: "Identifier", name: "$type" },
				"noCaseMatched",
			),
			arguments: [value],
		},
	}
}

// NOTE: `_self` is the name a Match binds the matched value to, and the name
// `@` lowers to inside a Handler body — one value under one name, so a test
// written against it reads what the body reads. A fresh Node each time, because
// a Position may be written onto one of them.
function selfIdentifier(): estree.Identifier {
	return { type: "Identifier", name: "_self" }
}

// NOTE: The matched value's tag, read ONCE for a chain that asks about it more
// than once. `_self[$type.typeKeySymbol] === "…"` per Handler is N reads of one
// key off one object, and where the Cases carry different fields — which is what
// a Choice with payloads is — every value has a hidden class of its own and the
// read goes megamorphic: measured on an eight-Case chain over such values, a
// bound tag is a third off the chain, and over uniformly shaped values (a Choice
// of unit Cases) it is exactly as fast as the reads it replaces.
//
// NOTE: This is EMISSION, not a pass, and the difference is what decides where
// it belongs. Nothing about the Program changes: the same key is read off the
// same immutable value, before the same tests, in the same order, and no Node is
// added, removed or reordered. There is no Node to add one with either — a tag
// is a raw JavaScript string, and `typedSimple` has no Expression that holds one
// and no Statement that binds one, so a pass would have to grow both and every
// pass after it would have to learn a shape that exists only to be emitted.
//
// NOTE: And it depends on no pass having run, which is what the registry's
// "any subset must be correct" rule asks of everything around it. The binding is
// made off the `tag-test` Nodes `compile-type-tests` leaves; turn that pass off
// — or the whole phase, with `--no-optimise` — and there are none, so no name is
// bound and the chain is emitted exactly as it was before. It can not make a
// subset of the registry wrong because it reads whatever reached it.
//
// NOTE: One name, not a numbered series. A Match nested inside a Handler binds
// its own inside its own block and SHADOWS this one, which is harmless for the
// reason a nested dispatch's `$dispatch_0` is: a chain reads the tag it bound
// and nothing else's. The `_` is what keeps the name unspellable in Essence —
// the Lexer reads one as a Symbol — exactly as it does for `_self`.
const selfTagName = "$self_tag"

// NOTE: The Handler's own check where it is a tag comparison on the MATCHED
// VALUE, and null for everything else. A literal Matcher is checked by `anyIs`
// and reads no tag; a member test reads its way down a spine, which is a
// different object every time and is left where it stands.
function selfTagTestOf(
	handler: common.typedSimple.MatchHandler,
): common.typedSimple.TagTestNode | null {
	let test = handler.typeTest

	if (handler.literal !== null || test === null) {
		return null
	}

	if (test.nodeType !== "Intrinsic" || test.kind !== "tag-test") {
		return null
	}

	return test.value.nodeType === "Identifier" &&
		test.value.name === selfIdentifier().name
		? test
		: null
}

// NOTE: Two, because one read is not worth a name — and a chain of one tag test
// is what a two-member Union compiles to, which is most of them.
function hoistedTagName(
	handlers: ReadonlyArray<common.typedSimple.MatchHandler>,
): string | null {
	let asked = handlers.filter(
		(handler) => selfTagTestOf(handler) !== null,
	).length

	return asked >= 2 ? selfTagName : null
}

function bindTag(
	tagName: string,
	value: estree.Identifier,
): estree.VariableDeclaration {
	return {
		type: "VariableDeclaration",
		kind: "const",
		declarations: [
			{
				type: "VariableDeclarator",
				id: { type: "Identifier", name: tagName },
				init: typeKeyRead(value),
			},
		],
	}
}

function boundTagTest(
	tagName: string,
	test: common.typedSimple.TagTestNode,
): estree.BinaryExpression {
	return {
		type: "BinaryExpression",
		operator: test.negated ? "!==" : "===",
		left: { type: "Identifier", name: tagName },
		right: { type: "Literal", value: renderIdentity(test.tag) },
	}
}

// NOTE: The chain a Match's Handlers become, and the one place it is built. The
// Handlers are folded BACK TO FRONT, so that each `if` becomes the `else` of
// the one before it — the first Handler ends up at the head of the chain and is
// therefore tested first.
//
// NOTE: What the chain ends in, and the Handlers that are tested to reach it.
// `elide-final-match-test` proved the last Handler is the one taken when every
// other declined, so its body IS the `else` and the fall-through above is gone
// with its test — see that pass for what the proof rests on and what it gives
// up.
//
// NOTE: `bodyOf` is what tells the two forms of a Match apart. In an Expression
// position a Handler's Return Statement is the wrapper Function's Return and the
// body is emitted as written; in a Statement position it is whatever the
// Statement's own answer is, and the caller hands in a body that writes it
// there.
// NOTE: A run of Statements rather than one, because a chain that asks about the
// matched value's tag more than once binds it first — see `selfTagName`. The
// callers splice them into the block they are already building, so the binding
// costs no block of its own wherever one is there.
function matchChain(
	handlers: Array<common.typedSimple.MatchHandler>,
	finalHandlerIsElse: boolean,
	value: estree.Identifier,
	bodyOf: (handler: common.typedSimple.MatchHandler) => estree.BlockStatement,
): Array<estree.Statement> {
	let tested = handlers
	let tail: estree.Statement = {
		type: "BlockStatement",
		body: [noCaseMatched(value)],
	}

	if (finalHandlerIsElse && handlers.length > 0) {
		tested = handlers.slice(0, -1)
		tail = bodyOf(handlers.at(-1)!)
	}

	// NOTE: Asked of the TESTED Handlers alone. The last one is the `else` where
	// `elide-final-match-test` proved it is, and an `else` reads no tag.
	let tagName = hoistedTagName(tested)
	let ifChain: estree.IfStatement | undefined

	for (let index = tested.length - 1; index >= 0; index--) {
		let currentHandler = tested[index]!

		ifChain = {
			type: "IfStatement",
			test: handlerTest(currentHandler, value, tagName),
			consequent: bodyOf(currentHandler),
			alternate: ifChain ?? tail,
		}
	}

	let chain = ifChain ?? tail

	return tagName === null ? [chain] : [bindTag(tagName, value), chain]
}

// NOTE: A Match standing in an Expression position, which is the only place
// JavaScript has no way of saying what a Match says: the chain is Statements,
// and the one Expression that may hold Statements is a Function call. So the
// Handlers become the body of a Function of `_self` and the matched value is its
// Argument — which is also what binds `_self` for the Handlers, shadowing an
// enclosing one for exactly the length of the chain.
//
// NOTE: `lower-matches-to-statements` is what takes the wrapper away wherever
// the Match stands somewhere a Statement may be written instead.
function rewriteMatch(
	node: common.typedSimple.MatchNode,
): estree.CallExpression {
	let value = selfIdentifier()

	return {
		type: "CallExpression",
		callee: {
			type: "FunctionExpression",
			body: {
				type: "BlockStatement",
				body: matchChain(
					node.handlers,
					node.finalHandlerIsElse,
					value,
					(handler) => rewriteBlockStatement(handler.body),
				),
			},
			params: [value],
		},
		arguments: [rewriteExpression(node.value)],
		optional: false,
	}
}

// #endregion

// #region Lowered Statements

// NOTE: The Statement half of the intrinsic family — a Match and a compiled
// Union dispatch written where they stand, with the Function that used to hold
// their Statements gone. `lower-matches-to-statements` is the one pass that
// produces these, and everything below is what it means.
//
// NOTE: Two Statements come out of exactly one shape: a Variable Declaration.
// Its name has to outlive the block that computes its value, so the declaration
// stands before the block and is a `let` — assigned once, by the block, and
// never again.
//
// NOTE: And the answer is written from INSIDE that block, which is a Scope the
// Program writes Statements into: a Handler that binds the very name being
// written to stands in front of it, and the assignment then lands on the
// Handler's own binding rather than on the declaration. Where that is so, the
// answer is written to a name of the Compiler's own first and the Program's
// name is assigned from it once the block has closed — one block deeper than
// the chain, so nothing a Handler binds can reach it and nothing it binds can
// collide with a sibling's.
function rewriteIntrinsicStatement(
	node: common.typedSimple.IntrinsicStatementNode,
): Array<estree.Statement> {
	let result = node.result

	if (result.kind !== "declaration" && result.kind !== "assignment") {
		return [intrinsicStatementBody(node, null, null)]
	}

	let declaration =
		result.kind === "declaration"
			? [
					{
						type: "VariableDeclaration",
						kind: "let",
						declarations: [
							{
								type: "VariableDeclarator",
								id: rewriteIdentifier(result.name),
								init: null,
							},
						],
					} satisfies estree.Statement,
				]
			: []

	if (!bindsAnswerName(node, result.name.name)) {
		return [...declaration, intrinsicStatementBody(node, null, null)]
	}

	let held: PlacedTarget = { kind: "temporary", name: heldAnswerName }

	return [
		...declaration,
		{
			type: "BlockStatement",
			body: [
				loopDeclaration("let", heldAnswerName, null),
				intrinsicStatementBody(node, null, held),
				// NOTE: After the chain and after the label a Handler leaves
				// through, which both end here — so every way out of the chain
				// passes through this one assignment.
				resultStatement(result, loopIdentifier(heldAnswerName)),
			],
		},
	]
}

// NOTE: Unspellable in Essence for the reason every Compiler-bound name is: the
// Lexer reads `_` as a Symbol, so no user identifier holds one. It needs no
// number — the block it is declared in holds exactly one of them, and the only
// blocks nested inside it that declare it again are lowered Statements of their
// own, which write their own answers and never this one's.
const heldAnswerName = "$held_answer"

// NOTE: Whether the name a lowered Statement writes its answer to is a name the
// Statements it holds BIND. Only the Scopes an answer can actually be written
// into are asked, which is the same descent `redirectedStatements` makes: a
// Handler body, a Conditional branch inside one, and a lowered Statement in
// Return position, whose own Handlers answer THIS Statement's question. A
// compiled dispatch holds `const`s of the Compiler's own and an inlined loop
// writes its answer beside them, so neither of those can hold a Program's
// binding where the answer is written.
function bindsAnswerName(
	node: common.typedSimple.IntrinsicStatementNode,
	name: string,
): boolean {
	if (node.kind !== "statement-match") {
		return false
	}

	return node.handlers.some((handler) => bodyBindsName(handler.body, name))
}

function bodyBindsName(
	nodes: Array<common.typedSimple.ImplementationNode>,
	name: string,
): boolean {
	return nodes.some((node) => {
		switch (node.nodeType) {
			// NOTE: The four Statements that bind a name in the block they stand
			// in — a `let`, a `function`, a `class`, and the `let` a lowered
			// Statement in declaration position is emitted as. A Type Alias and a
			// Protocol bind nothing at all: they are emitted as nothing.
			case "VariableDeclarationStatement":
			case "FunctionStatement":
			case "NamespaceDefinitionStatement":
				return node.name.name === name
			case "IntrinsicStatement":
				return node.result.kind === "return"
					? bindsAnswerName(node, name)
					: node.result.kind === "declaration" &&
							node.result.name.name === name
			case "ConditionalStatement":
				return (
					bodyBindsName(node.trueBody, name) ||
					bodyBindsName(node.falseBody, name)
				)
			default:
				return false
		}
	})
}

// NOTE: Where a lowered Expression's answer goes, written as the Statement that
// puts it there.
function resultStatement(
	result: PlacedTarget,
	answer: estree.Expression,
): estree.Statement {
	switch (result.kind) {
		case "return":
			return { type: "ReturnStatement", argument: answer }
		case "declaration":
		case "assignment":
			return {
				type: "ExpressionStatement",
				expression: {
					type: "AssignmentExpression",
					operator: "=",
					left: rewriteIdentifier(result.name),
					right: answer,
				},
			}
		// NOTE: A name the Compiler binds for itself — an inlined loop's State,
		// its answer, the Boolean a predicate settled on. It is emitted verbatim
		// rather than through `rewriteIdentifier`, because it is not a name any
		// Essence Program could have written.
		case "temporary":
			return loopAssignment(result.name, answer)
		// NOTE: Evaluated and dropped — through the same rule every discarded
		// Expression is emitted by, because a Handler may answer with a value as
		// well as with a call. Where evaluating it observes nothing the pass has
		// already taken the Return Statement away.
		case "discard":
			return discardedExpressionStatement(answer)
	}
}

// NOTE: Where an answer GOES, for the answers that go somewhere: a Statement
// position's own result, or a name the Rewriter itself binds.
type PlacedTarget =
	| common.typedSimple.StatementResult
	| { kind: "temporary"; name: string }

// NOTE: And the whole of what an answer may be written as, which is wider by one
// — an inlined loop's callback does not merely PUT its answer somewhere: a
// predicate's answer decides whether the walk goes round again, and a `Step`
// decides both where the answer goes and whether the walk is over. So the target
// may be a writer of its own, handed the answer and the redirect it stands in.
type RedirectTarget =
	| PlacedTarget
	| {
			kind: "answer"
			write: (
				answer: LoopAnswer,
				redirect: ReturnRedirect | null,
			) => Array<estree.Statement>
	  }

// NOTE: One answer, as the two things a writer can need of it: the Node it was
// written as — which is what lets `#Done(…)` be recognised where it is BUILT,
// and the Case never built at all — and the JavaScript it emits, asked for only
// where the Node was not enough. `node` is null where no Node stands behind the
// answer: a nested inlined loop's own answer is read out of the name that walk
// settled in, and the writer falls back to reading the tag.
type LoopAnswer = {
	node: common.typedSimple.ExpressionNode | null
	value: () => estree.Expression
}

// NOTE: One answer, written where its target says — and the way OUT of the body
// it was written in, where the answer was not the last thing in it.
function answerStatements(
	result: RedirectTarget,
	answer: LoopAnswer,
	redirect: ReturnRedirect | null,
): Array<estree.Statement> {
	if (result.kind === "answer") {
		return result.write(answer, redirect)
	}

	return [resultStatement(result, answer.value()), ...breakOut(redirect)]
}

// NOTE: What a lowered Statement standing INSIDE a Handler body is emitted
// against, when that body's Return Statements are being written somewhere other
// than a JavaScript Return. A Match in Statement position holds a Match in
// Return position holds another, and each of them answers the OUTERMOST one's
// question — so the redirect travels down and the label is the outermost one's.
type ReturnRedirect = {
	result: RedirectTarget
	label: string
	// NOTE: True only for the LAST Statement of a Handler's own body, where
	// nothing follows the answer and there is nothing to break out of.
	isTail: boolean
	broke: () => void
}

function intrinsicStatementBody(
	node: common.typedSimple.IntrinsicStatementNode,
	redirect: ReturnRedirect | null,
	held: PlacedTarget | null,
): estree.Statement {
	switch (node.kind) {
		case "statement-match":
			return statementMatch(node, redirect, held)
		case "held-expression":
			return heldExpression(node, redirect, held)
		case "inline-loop":
			return inlineLoopStatement(node, redirect, held)
	}
}

// NOTE: Where a lowered Statement's answer goes: the name the Statement
// position it stood in decides, the outer question it is answering where it
// stands inside one, or a name of the Compiler's own where the Program binds
// the first of those itself.
function placedResult(
	node: common.typedSimple.IntrinsicStatementNode,
	redirect: ReturnRedirect | null,
	held: PlacedTarget | null,
): RedirectTarget {
	if (held !== null) {
		return held
	}

	return redirect === null ? node.result : redirect.result
}

// NOTE: `{ const $dispatch_0 = …; return <the chain>; }` — the names a compiled
// dispatch holds, as the `const`s of a block. The block is what keeps one
// chain's names its own: they are numbered from zero per chain, so two chains
// lifted into one Scope would otherwise declare one name twice.
function heldExpression(
	node: common.typedSimple.HeldExpressionNode,
	redirect: ReturnRedirect | null,
	held: PlacedTarget | null,
): estree.Statement {
	let result = placedResult(node, redirect, held)

	return {
		type: "BlockStatement",
		body: [
			...node.temporaries.map(
				(temporary): estree.Statement => ({
					type: "VariableDeclaration",
					kind: "const",
					declarations: [
						{
							type: "VariableDeclarator",
							id: { type: "Identifier", name: temporary.name },
							init: rewriteExpression(temporary.value),
						},
					],
				}),
			),
			...answerStatements(
				result,
				{
					node: node.expression,
					value: () => rewriteExpression(node.expression),
				},
				redirect,
			),
		],
	}
}

// NOTE: A Match written as the Statements it always was. What the three
// bindings mean is stated where they are declared; what is common to them is
// that `_self` names the matched value for the length of the chain and for
// nothing else.
function statementMatch(
	node: common.typedSimple.StatementMatchNode,
	redirect: ReturnRedirect | null,
	held: PlacedTarget | null,
): estree.Statement {
	let result = placedResult(node, redirect, held)
	let label = redirect === null ? node.label : redirect.label
	let broke = false
	// NOTE: A redirected Match breaks out of the label its redirect names, which
	// is the OUTER Match's — so it is the outer Match that has to hear about it,
	// and the flag below stays false.
	let markBroke =
		redirect === null
			? (): void => {
					broke = true
				}
			: redirect.broke
	let value = selfIdentifier()
	let bodyOf = (
		handler: common.typedSimple.MatchHandler,
	): estree.BlockStatement =>
		result.kind === "return"
			? rewriteBlockStatement(handler.body)
			: {
					type: "BlockStatement",
					body: withNamespaceScope(() =>
						redirectedStatements(handler.body, {
							result,
							label,
							// NOTE: A Handler's last Statement is the end of its
							// branch, and the `if` chain is the end of the block
							// — so its answer needs nothing after it. Unless this
							// Match is itself inside a Handler being redirected
							// somewhere that is NOT the end of ITS body, where
							// the rest of that body follows the chain.
							isTail: redirect === null || redirect.isTail,
							broke: markBroke,
						}),
					),
				}

	let chain = matchChain(
		node.handlers,
		node.finalHandlerIsElse,
		value,
		bodyOf,
	)
	let body = boundChain(node, chain, value)

	// NOTE: The label is emitted only where something breaks out of it, which is
	// where a Handler answered somewhere other than its last Statement. A
	// redirected Match breaks out of the label its redirect names, and that one
	// is the outer Match's to declare.
	if (!broke || redirect !== null) {
		return body
	}

	return {
		type: "LabeledStatement",
		label: { type: "Identifier", name: label },
		body,
	}
}

// NOTE: The chain with the matched value bound in front of it, in as few blocks
// as the binding needs. `chain` is a run of Statements because a chain may bind
// the matched value's tag ahead of itself, and where a block is being built for
// the value anyway the two bindings stand side by side in it. Where none is —
// `match @`, whose value is already `_self` — a chain that bound nothing is
// still the one Statement it always was.
function boundChain(
	node: common.typedSimple.StatementMatchNode,
	chain: Array<estree.Statement>,
	value: estree.Identifier,
): estree.Statement {
	if (node.binding.kind === "self") {
		return chain.length === 1
			? chain[0]!
			: { type: "BlockStatement", body: chain }
	}

	let bind = (
		id: estree.Identifier,
		init: estree.Expression,
	): estree.Statement => ({
		type: "VariableDeclaration",
		kind: "const",
		declarations: [{ type: "VariableDeclarator", id, init }],
	})

	if (node.binding.kind === "block") {
		return {
			type: "BlockStatement",
			body: [bind(value, rewriteExpression(node.value)), ...chain],
		}
	}

	let held: estree.Identifier = {
		type: "Identifier",
		name: node.binding.name,
	}

	return {
		type: "BlockStatement",
		body: [
			bind(held, rewriteExpression(node.value)),
			{
				type: "BlockStatement",
				body: [bind(value, held), ...chain],
			},
		],
	}
}

function breakOut(redirect: ReturnRedirect | null): Array<estree.Statement> {
	if (redirect === null || redirect.isTail) {
		return []
	}

	redirect.broke()

	return [
		{
			type: "BreakStatement",
			label: { type: "Identifier", name: redirect.label },
		},
	]
}

// NOTE: A Handler's body, with every Return Statement in it written where the
// lowered Statement's answer goes instead. Only three kinds of Statement can
// hold one: a Return itself, a Conditional's bodies, and a lowered Statement
// that answers with a Return of its own. Everything else is emitted exactly as
// it always is — a Function declared inside a Handler has Returns of its own and
// they are ITS Returns, which is why this descends by name rather than by
// searching.
function redirectedStatements(
	nodes: Array<common.typedSimple.ImplementationNode>,
	redirect: ReturnRedirect,
): Array<estree.Statement> {
	return nodes.flatMap((node, index) =>
		redirectedStatement(node, {
			...redirect,
			isTail: redirect.isTail && index === nodes.length - 1,
		}),
	)
}

function redirectedStatement(
	node: common.typedSimple.ImplementationNode,
	redirect: ReturnRedirect,
): Array<estree.Statement> {
	switch (node.nodeType) {
		case "ReturnStatement":
			return withStatementLocation(
				answerStatements(
					redirect.result,
					{
						node: node.expression,
						value: () => rewriteExpression(node.expression),
					},
					redirect,
				),
				node.position,
			)
		case "ConditionalStatement":
			return withStatementLocation(
				[redirectedConditional(node, redirect)],
				node.position,
			)
		case "IntrinsicStatement":
			// NOTE: A lowered Statement answering with a Return of its own is
			// answering THIS Match — it stood in the Return position of a Handler
			// body. One that answers a name of its own is answering that name,
			// and is emitted as it stands.
			if (node.result.kind === "return") {
				return withStatementLocation(
					[intrinsicStatementBody(node, redirect, null)],
					node.position,
				)
			}

			break
		default:
			break
	}

	return rewriteStatements(node)
}

// NOTE: A branch of a Conditional is in tail position exactly where the
// Conditional is: an answer written at the end of a branch of a Conditional that
// ends the Handler body has nothing after it either, in the branch or after the
// `if`.
function redirectedConditional(
	node: common.typedSimple.ConditionalStatementNode,
	redirect: ReturnRedirect,
): estree.IfStatement {
	let nested = redirect
	let block = (
		nodes: Array<common.typedSimple.ImplementationNode>,
	): estree.BlockStatement => ({
		type: "BlockStatement",
		body: withNamespaceScope(() => redirectedStatements(nodes, nested)),
	})
	let alternate: estree.Statement | null = null

	if (node.falseBody.length > 0) {
		if (
			node.falseBody.length === 1 &&
			node.falseBody[0].nodeType === "ConditionalStatement"
		) {
			let inner = node.falseBody[0]

			alternate = withStatementLocation(
				[redirectedConditional(inner, nested)],
				inner.position,
			)[0]!
		} else {
			alternate = block(node.falseBody)
		}
	}

	return {
		type: "IfStatement",
		test: conditionTest(node),
		consequent: block(node.trueBody),
		alternate,
	}
}

// #endregion

// #region Inlined loops

// NOTE: A walk written out — the Statements that run it, and the Expression that
// reads what it settled on. Which of the two a caller needs is what the position
// the loop stood in decides: a Statement position holds both as they are, and an
// Expression position has to wrap them in something callable.
type InlinedWalk = {
	statements: Array<estree.Statement>
	answer: estree.Expression
}

// NOTE: An arrow called at once, which is what an Expression position leaves: a
// `while` is a Statement and there is nowhere in an Expression to write one. It
// is ONE closure for the whole walk where the driver called two or three per
// turn of it — and where the loop stands in a Statement position instead, there
// is no closure at all.
function inlineLoopExpression(
	node: common.typedSimple.InlineLoopNode,
): estree.Expression {
	let walk = inlinedLoop(node)

	return {
		type: "CallExpression",
		optional: false,
		callee: {
			type: "ArrowFunctionExpression",
			expression: false,
			params: [],
			body: loopBlock([
				...walk.statements,
				{ type: "ReturnStatement", argument: walk.answer },
			]),
		},
		arguments: [],
	}
}

// NOTE: The same walk with nothing around it, and its answer written where the
// Statement position says. The block is what keeps the names one walk binds its
// own — every one of them is spelled from this loop's prefix, so two walks in
// one Scope can not collide, and the block is there for the reader as much as
// for the Compiler.
function inlineLoopStatement(
	node: common.typedSimple.InlineLoopStatementNode,
	redirect: ReturnRedirect | null,
	held: PlacedTarget | null,
): estree.Statement {
	let result = placedResult(node, redirect, held)
	let walk = inlinedLoop(node)

	return loopBlock([
		...walk.statements,
		// NOTE: No Node stands behind this answer — it is the name the walk
		// settled in — so a writer expecting one reads the value instead. That
		// is the one place a `Step` reaches the tag read rather than being
		// recognised where it was built: a loop answering with a `Step` that
		// another loop then reads.
		...answerStatements(
			result,
			{ node: null, value: () => walk.answer },
			redirect,
		),
	])
}

function inlinedLoop(loop: common.typedSimple.InlineLoop): InlinedWalk {
	switch (loop.driver.kind) {
		case "condition":
			return conditionWalk(loop, loop.driver)
		case "counted":
			return countedWalk(loop, loop.driver)
		case "general":
			return generalWalk(loop, loop.driver)
		case "fold":
			return foldWalk(loop, loop.driver)
		// NOTE: The two walks that build an Array already — which is the
		// emission `build-lists-in-place` extends to the four above, and there
		// is nothing of theirs left to extend it to.
		case "map":
			return mapWalk(loop.name, loop.driver)
		case "keep":
			return keepWalk(loop.name, loop.driver)
	}
}

// NOTE: `loop(startingWith:while:step:)` — the predicate checked BEFORE each
// step, exactly as the driver checks it, so a predicate false on the seed
// answers the seed and the body never runs. `until` is the same walk with the
// answer read the other way round, which is what its own Essence body does by
// negating the Boolean; here the question is simply asked the other way.
function conditionWalk(
	loop: common.typedSimple.InlineLoop,
	driver: Extract<common.typedSimple.InlineLoopDriver, { kind: "condition" }>,
): InlinedWalk {
	let prefix = loop.name
	let state = `${prefix}_state`
	let built = builtArray(loop)
	let accumulator = loop.build?.parameter ?? null
	// NOTE: ONE State and two bodies — the predicate is handed it as well — so
	// both are asked and the swap is taken for both or for neither.
	let carried =
		built === null
			? carriedInteger(state, null, 0, [driver.predicate, driver.step])
			: null
	// NOTE: What the call was given is written out before the bodies are, so
	// that everything the emission collects on the way — a pooled constant above
	// all — is collected in the order the Program says it.
	let seed =
		built === null
			? loopDeclaration("let", state, rewriteExpression(driver.seed))
			: loopDeclaration("const", built, ownedItems(driver.seed))
	let check = inlinedCallback(
		driver.predicate,
		[loopIdentifier(state)],
		`${prefix}_check`,
		{
			kind: "answer",
			write: (answer, redirect) => [
				{
					type: "IfStatement",
					// NOTE: The walk is left where a `while` predicate answers
					// false and where an `until` predicate answers true, which
					// is the whole of the difference between the two entries.
					test: driver.until
						? rawAnswer(answer)
						: negatedAnswer(rawAnswer(answer)),
					consequent: loopBreak(prefix),
					alternate: null,
				},
				...breakOut(redirect),
			],
		},
		null,
		carried,
		accumulator,
	)
	let step = inlinedCallback(
		driver.step,
		[loopIdentifier(state)],
		`${prefix}_body`,
		built === null
			? { kind: "temporary", name: state }
			: builtTarget(built),
		null,
		carried,
		accumulator,
	)
	let statements: Array<estree.Statement> = [
		seed,
		labelled(prefix, {
			type: "WhileStatement",
			test: { type: "Literal", value: true },
			body: loopBlock([check, step]),
		}),
	]

	return {
		statements,
		answer:
			built === null
				? carriedAnswer(state, heldRaw(carried, statements))
				: createdList(loopIdentifier(built)),
	}
}

// NOTE: `loop(from:through:startingWith:step:)`, and the one entry that does not
// go through its driver at all. Its Essence body threads `{ index, carried }`
// through the `while` driver — a Record and an Integer built per turn, a closure
// asking whether the index has passed the end and another advancing it. All of
// it is decided here: the direction once, before the first turn, exactly as that
// body decides it, and then a `for` over what the two bounds hold.
//
// NOTE: The counter counts in NUMBERS wherever both bounds are held as ones,
// which is every loop written over ordinary quantities: a counter between two
// safe bounds never leaves safe range, so counting it as a double is exact, and
// a double `+ 1` is a fraction of the cost of a heap bigint per turn. A bound
// held as a bigint — one past 2⁵³, so a loop of more turns than a Program can
// run — falls back to the bigint counter this always was, and the kind is
// decided ONCE, before the first turn, so no turn asks.
//
// NOTE: The bounds and the seed are evaluated in the order the call passed them,
// which is the order the driver would have evaluated them in. What follows —
// which way the count runs, and in which representation — reads the two bounds
// and observes nothing.
function countedWalk(
	loop: common.typedSimple.InlineLoop,
	driver: Extract<common.typedSimple.InlineLoopDriver, { kind: "counted" }>,
): InlinedWalk {
	let prefix = loop.name
	let from = `${prefix}_from`
	let to = `${prefix}_to`
	let ascending = `${prefix}_up`
	let escaped = `${prefix}_big`
	let delta = `${prefix}_delta`
	let index = `${prefix}_index`
	let held = `${prefix}_held`
	let state = `${prefix}_state`
	// NOTE: Two bounds written as Integers a double holds exactly decide the
	// whole of the bigint half below while compiling, and that is the shape all
	// but a handful of counted walks have. A counter between two safe bounds
	// never leaves safe range, so it counts in numbers, every value it takes is
	// already the canonical spelling of itself, and none of the machinery that
	// asks — the kind test, the two-kind step, the converting start, the per-turn
	// view — is written at all.
	let mayEscape = !(safeBound(driver.from) && safeBound(driver.through))
	let built = builtArray(loop)
	// NOTE: The State is the SECOND Argument here — the counter is the first —
	// and the two elisions are independent: a body that counts into a Record
	// still reads its counter raw, and one that hands its counter on still
	// carries an Integer State raw. A List State is the third such decision, and
	// it is a List rather than an Integer, so at most one of the two can be
	// taken for the same slot.
	let carried =
		built === null ? carriedInteger(state, null, 1, [driver.step]) : null
	// NOTE: The bounds and the seed, in the order the call passed them and
	// before the body is written, so that what the emission collects on the way
	// is collected in the order the Program says it.
	let bounds = [
		loopDeclaration(
			"const",
			from,
			valueRead(rewriteExpression(driver.from)),
		),
		loopDeclaration(
			"const",
			to,
			valueRead(rewriteExpression(driver.through)),
		),
		built === null
			? loopDeclaration("let", state, rewriteExpression(driver.seed))
			: loopDeclaration("const", built, ownedItems(driver.seed)),
	]
	let body = inlinedCallback(
		driver.step,
		// NOTE: The body is handed the counter as the Integer it was always
		// handed — where it used to cost that Integer, the Record around it and
		// two calls — and `inlinedCallback` drops even that where the body only
		// ever reads what the Integer holds.
		[createdInteger(loopIdentifier(index)), loopIdentifier(state)],
		`${prefix}_body`,
		built === null
			? { kind: "temporary", name: state }
			: builtTarget(built),
		mayEscape
			? { read: held, binding: [canonicalCounter(held, index, escaped)] }
			: { read: index, binding: [] },
		carried,
		loop.build?.parameter ?? null,
	)

	let statements: Array<estree.Statement> = [
		...bounds,
		loopDeclaration("const", ascending, {
			type: "BinaryExpression",
			operator: "<=",
			left: loopIdentifier(from),
			right: loopIdentifier(to),
		}),
		// NOTE: Either bound being a bigint is what sends the counter to
		// bigint, and by the canonical invariant that is the same question
		// as either bound being outside safe range.
		...(mayEscape
			? [
					loopDeclaration("const", escaped, {
						type: "LogicalExpression",
						operator: "||",
						left: heldAsBigInt(loopIdentifier(from)),
						right: heldAsBigInt(loopIdentifier(to)),
					}),
				]
			: []),
		loopDeclaration(
			"const",
			delta,
			mayEscape
				? {
						type: "ConditionalExpression",
						test: loopIdentifier(escaped),
						consequent: {
							type: "ConditionalExpression",
							test: loopIdentifier(ascending),
							consequent: countLiteral(1n),
							alternate: countLiteral(-1n),
						},
						alternate: steppedBy(ascending),
					}
				: steppedBy(ascending),
		),
		{
			type: "ForStatement",
			// NOTE: The start has to match the step's kind — a number
			// counter stepped by a bigint throws — so a bigint walk whose
			// lower bound happens to be a number converts it once here.
			init: loopDeclaration(
				"let",
				index,
				mayEscape
					? {
							type: "ConditionalExpression",
							test: loopIdentifier(escaped),
							consequent: {
								type: "CallExpression",
								optional: false,
								callee: loopIdentifier("BigInt"),
								arguments: [loopIdentifier(from)],
							},
							alternate: loopIdentifier(from),
						}
					: loopIdentifier(from),
			),
			// NOTE: Counting up runs while the index has not passed the end
			// from below and counting down while it has not passed it from
			// above — the two predicates the Essence body writes, asked of
			// the counter rather than through a closure and an Ordering.
			// The comparison is exact whichever kind each side is holding.
			test: {
				type: "ConditionalExpression",
				test: loopIdentifier(ascending),
				consequent: {
					type: "BinaryExpression",
					operator: "<=",
					left: loopIdentifier(index),
					right: loopIdentifier(to),
				},
				alternate: {
					type: "BinaryExpression",
					operator: ">=",
					left: loopIdentifier(index),
					right: loopIdentifier(to),
				},
			},
			update: {
				type: "AssignmentExpression",
				operator: "+=",
				left: loopIdentifier(index),
				right: loopIdentifier(delta),
			},
			body: loopBlock([body]),
		},
	]

	return {
		statements,
		answer:
			built === null
				? carriedAnswer(state, heldRaw(carried, statements))
				: createdList(loopIdentifier(built)),
	}
}

// NOTE: `loop(startingWith:step:)` — the walk whose body decides when it is
// over. Each turn answers with a `Step`: `#Done` stops with its value and
// `#Continue` carries the next State, which is what `steppedTarget` writes where
// the answer is written.
function generalWalk(
	loop: common.typedSimple.InlineLoop,
	driver: Extract<common.typedSimple.InlineLoopDriver, { kind: "general" }>,
): InlinedWalk {
	let prefix = loop.name
	let state = `${prefix}_state`
	let answer = `${prefix}_answer`
	let stops = false
	let built = builtArray(loop)
	let carried =
		built === null ? carriedInteger(state, answer, 0, [driver.step]) : null
	let seed =
		built === null
			? loopDeclaration("let", state, rewriteExpression(driver.seed))
			: loopDeclaration("const", built, ownedItems(driver.seed))
	let stop = () => {
		stops = true
	}
	let body = inlinedCallback(
		driver.step,
		[loopIdentifier(state)],
		`${prefix}_body`,
		built === null
			? steppedTarget(prefix, state, answer, stop)
			: steppedBuiltTarget(prefix, built, answer, stop),
		null,
		carried,
		loop.build?.parameter ?? null,
	)
	let walk: estree.Statement = {
		type: "WhileStatement",
		test: { type: "Literal", value: true },
		body: loopBlock([body]),
	}
	let statements: Array<estree.Statement> = [
		seed,
		loopDeclaration("let", answer, null),
		// NOTE: The label is emitted only where something leaves through it.
		// A body that never answers `#Done` is a walk that never ends, which
		// is exactly what the driver does with one.
		stops ? labelled(prefix, walk) : walk,
	]

	// NOTE: Nothing to box at the exit: this walk answers with what a `#Done`
	// carried, never with the State. A `#Done` handed the State ITSELF writes it
	// into the answer slot, and the swap boxes that one write where it stands,
	// which is why the answer this returns is the slot and never the State. What
	// the State is written with — a `#Continue`'s value, or the `state` member of
	// a `Step` the Compiler could not see being built — is unboxed like any other
	// write.
	heldRaw(carried, statements)

	return {
		statements,
		answer: loopIdentifier(answer),
	}
}

// NOTE: `List.reduce`, both entries. The plain fold always runs to the end and
// answers the accumulator; the early-stopping one may leave on a `#Done`, so its
// walk stands in a labelled block with the accumulator written after it — which
// is what "the accumulated value, or the value the first `#Done` carries" means
// written out.
function foldWalk(
	loop: common.typedSimple.InlineLoop,
	driver: Extract<common.typedSimple.InlineLoopDriver, { kind: "fold" }>,
): InlinedWalk {
	let prefix = loop.name
	let items = `${prefix}_items`
	let count = `${prefix}_count`
	let position = `${prefix}_position`
	let state = `${prefix}_state`
	let answer = `${prefix}_answer`
	let stops = false
	// NOTE: A name of its own, and not the `items` above — the Array a fold
	// WALKS and the Array it BUILDS stand in the same Scope, and a fold seeded
	// with its own receiver holds both at once.
	let built = builtArray(loop)
	let carried =
		built === null
			? carriedInteger(state, driver.stepped ? answer : null, 0, [
					driver.step,
				])
			: null
	let stop = () => {
		stops = true
	}
	let target: RedirectTarget =
		built === null
			? driver.stepped
				? steppedTarget(prefix, state, answer, stop)
				: { kind: "temporary", name: state }
			: driver.stepped
				? steppedBuiltTarget(prefix, built, answer, stop)
				: builtTarget(built)
	// NOTE: The receiver before the seed, which is the order the call evaluated
	// them in — a Method's receiver is its first Argument — and both before the
	// body, so that what the emission collects on the way is collected in the
	// order the Program says it. The count goes with the receiver rather than
	// after the seed: the walk covers the items the receiver held when the call
	// began, and a seed that appends to that very receiver — `reduce(startingWith
	// list::append(x), …)` — must not lengthen the walk.
	let held = [
		...heldItems(items, count, rewriteExpression(driver.items)),
		built === null
			? loopDeclaration("let", state, rewriteExpression(driver.seed))
			: loopDeclaration("const", built, ownedItems(driver.seed)),
	]
	let body = inlinedCallback(
		driver.step,
		[loopIdentifier(state), itemAt(items, position)],
		`${prefix}_body`,
		target,
		null,
		carried,
		loop.build?.parameter ?? null,
	)
	let walk = itemsWalk(count, position, [body])

	if (!driver.stepped) {
		let statements = [...held, walk]

		return {
			statements,
			answer:
				built === null
					? carriedAnswer(state, heldRaw(carried, statements))
					: createdList(loopIdentifier(built)),
		}
	}

	// NOTE: Asked of the seed and the walk, which is everywhere the State is
	// WRITTEN — the tail below only reads it, and how it reads it is what the
	// answer decides.
	let raw = built === null ? heldRaw(carried, [...held, walk]) : false
	let tail = [
		walk,
		loopAssignment(
			answer,
			built === null
				? carriedAnswer(state, raw)
				: createdList(loopIdentifier(built)),
		),
	]

	return {
		statements: [
			...held,
			loopDeclaration("let", answer, null),
			...(stops ? [labelled(prefix, loopBlock(tail))] : tail),
		],
		answer: loopIdentifier(answer),
	}
}

// NOTE: `List.map` — the Array built beside the walk and wrapped once at the
// end, which is what the native does with the Array `Array.prototype.map`
// returns.
function mapWalk(
	prefix: string,
	driver: Extract<common.typedSimple.InlineLoopDriver, { kind: "map" }>,
): InlinedWalk {
	let items = `${prefix}_items`
	let count = `${prefix}_count`
	let position = `${prefix}_position`
	let mapped = `${prefix}_mapped`
	let held = heldItems(items, count, rewriteExpression(driver.items))
	let body = inlinedCallback(
		driver.transform,
		[itemAt(items, position)],
		`${prefix}_body`,
		{
			kind: "answer",
			write: (answer, redirect) => [
				pushed(mapped, answer.value()),
				...breakOut(redirect),
			],
		},
	)

	return {
		statements: [
			...held,
			loopDeclaration("const", mapped, {
				type: "ArrayExpression",
				elements: [],
			}),
			itemsWalk(count, position, [body]),
		],
		answer: createdList(loopIdentifier(mapped)),
	}
}

// NOTE: `List.keepEvery` — the same walk, keeping the ITEM where the check
// accepts it. The item is bound first because two places read it: the check is
// handed it, and the Array it is kept in is given the same value.
function keepWalk(
	prefix: string,
	driver: Extract<common.typedSimple.InlineLoopDriver, { kind: "keep" }>,
): InlinedWalk {
	let items = `${prefix}_items`
	let count = `${prefix}_count`
	let position = `${prefix}_position`
	let item = `${prefix}_item`
	let kept = `${prefix}_kept`
	let held = heldItems(items, count, rewriteExpression(driver.items))
	let body = inlinedCallback(
		driver.check,
		[loopIdentifier(item)],
		`${prefix}_body`,
		{
			kind: "answer",
			write: (answer, redirect) => [
				{
					type: "IfStatement",
					test: rawAnswer(answer),
					consequent: pushed(kept, loopIdentifier(item)),
					alternate: null,
				},
				...breakOut(redirect),
			],
		},
	)

	return {
		statements: [
			...held,
			loopDeclaration("const", kept, {
				type: "ArrayExpression",
				elements: [],
			}),
			itemsWalk(count, position, [
				loopDeclaration("const", item, itemAt(items, position)),
				body,
			]),
		],
		answer: createdList(loopIdentifier(kept)),
	}
}

// #region Lists built in place

// NOTE: The Array a walk that builds its List in place pushes into, and null for
// every walk that threads its State the way it always did. The name is spelled
// from the loop's own prefix like every other name a walk binds, and it is not
// `<prefix>_items`: a fold walks one Array and builds another, and the two stand
// in the same Scope.
function builtArray(loop: common.typedSimple.InlineLoop): string | null {
	return loop.build === undefined ? null : `${loop.name}_built`
}

// NOTE: The Array the walk enters with, and the one entry cost the seed decides.
// A seed written as a List LITERAL hands its Array over outright — the literal
// is built where it stands and nobody else has ever held it, which is the same
// licence `collapse-construction` inlines a Case payload under. Every other seed
// is copied ONCE, here, into an Array of the walk's own: a List the Program was
// holding before the walk must never be pushed onto, and the copy is also what
// makes a walk of no turns answer exactly the seed's items. `ownItemsOf` is the
// runtime's copy for it, and it copies a flat box the way `append` did.
function ownedItems(
	seed: common.typedSimple.ExpressionNode,
): estree.Expression {
	let literal = listLiteral(seed)

	if (literal !== null) {
		return {
			type: "ArrayExpression",
			elements: literal.map((value) => rewriteExpression(value)),
		}
	}

	return {
		type: "CallExpression",
		optional: false,
		callee: memberRead(loopIdentifier("List"), "ownItemsOf"),
		arguments: [rewriteExpression(seed)],
	}
}

// NOTE: The items a List LITERAL wrote, for the seed above and for a whole List
// added to a build — both of them Arrays the walk may take rather than box.
//
// NOTE: Read in BOTH of the literal's shapes, because `collapse-construction`
// runs after the pass that asked for this and may be turned off — reading one
// and not the other would make an emission depend on a pass being enabled.
function listLiteral(
	node: common.typedSimple.ExpressionNode,
): Array<common.typedSimple.ExpressionNode> | null {
	if (node.nodeType === "ListValue") {
		return node.values
	}

	return node.nodeType === "Intrinsic" && node.kind === "direct-list"
		? node.values
		: null
}

// NOTE: A whole List's logical items pushed onto an Array the caller owns — the
// runtime's own two-run walk, which is what `append(contentsOf:)` performed.
function pushedItemsOf(
	list: estree.Expression,
	into: estree.Expression,
): estree.CallExpression {
	return {
		type: "CallExpression",
		optional: false,
		callee: memberRead(loopIdentifier("List"), "pushItemsOf"),
		arguments: [list, into],
	}
}

// NOTE: Where a walk that builds its List writes an answer that rebuilt the
// State: as the pushes the rebuilding performs, and nothing else. There is no
// slot to assign — the Array IS the State — so a branch that changes nothing
// writes no Statement at all beyond the way out of the body it stood in.
function builtTarget(built: string): RedirectTarget {
	return {
		kind: "answer",
		write: (written, redirect) => [
			...builtAdditions(built, written.node),
			...breakOut(redirect),
		],
	}
}

// NOTE: And the same for a walk whose body answers with a `Step`. `#Continue`
// adds its items and goes round again, exactly as the plain target does;
// `#Done` may finish with the List the walk built — which is where the Array is
// boxed, once, at that exit edge — or with a value of its own, and then the
// Array simply goes nowhere.
function steppedBuiltTarget(
	prefix: string,
	built: string,
	answer: string,
	stop: () => void,
): RedirectTarget {
	return {
		kind: "answer",
		write: (written, redirect) => {
			let step = stepConstruction(written.node)

			// NOTE: A `Step` this can not see being BUILT would be one read
			// through its tag, and reading one writes the State whole — which a
			// walk holding an Array has no way to do. `build-lists-in-place`
			// declines every such body, so nothing reaches here.
			if (step === null) {
				throw new Error(
					"Internal Compiler Error: a walk that builds its List in place answered with a Step the Compiler can not see being built.",
				)
			}

			if (!step.done) {
				return [
					...builtAdditions(built, step.value),
					...breakOut(redirect),
				]
			}

			stop()

			if (!isListBuild(step.value)) {
				return [
					loopAssignment(answer, rewriteExpression(step.value)),
					loopBreak(prefix),
				]
			}

			return [
				...builtAdditions(built, step.value),
				loopAssignment(answer, createdList(loopIdentifier(built))),
				loopBreak(prefix),
			]
		},
	}
}

// NOTE: One turn's additions, in the order the chain performed them — the same
// `push` the Compiler's own `map` walk writes, and the runtime's two-run walk
// where a whole List was added.
//
// NOTE: A whole List written as a LITERAL is added as its items directly, for
// the reason the seed reads one: the literal is built where it stands, so the
// walk can push what it holds rather than box it and walk the box back out
// again. `push` takes as many as the literal wrote, and an empty one adds
// nothing at all.
function builtAdditions(
	built: string,
	node: common.typedSimple.ExpressionNode | null,
): Array<estree.Statement> {
	if (node === null || !isListBuild(node)) {
		throw new Error(
			"Internal Compiler Error: a walk that builds its List in place answered with something other than a build.",
		)
	}

	return node.additions.flatMap((addition): Array<estree.Statement> => {
		if (!addition.contentsOf) {
			return [pushed(built, rewriteExpression(addition.value))]
		}

		let literal = listLiteral(addition.value)

		if (literal === null) {
			return [
				{
					type: "ExpressionStatement",
					expression: pushedItemsOf(
						rewriteExpression(addition.value),
						loopIdentifier(built),
					),
				},
			]
		}

		return literal.length === 0
			? []
			: [
					pushed(
						built,
						...literal.map((value) => rewriteExpression(value)),
					),
				]
	})
}

function isListBuild(
	node: common.typedSimple.ExpressionNode,
): node is common.typedSimple.ListBuildNode {
	return node.nodeType === "Intrinsic" && node.kind === "list-build"
}

// NOTE: A turn whose whole body is the one push a build performs pushes the
// Argument itself, where the `const` binding it stood. It is the shape a walk
// that only collects has — `<- accumulated::append(item)` and nothing else — and
// with the accumulator's Parameter already elided the binding is the last thing
// the turn writes before the push reads it back.
//
// NOTE: Nothing at all stands between the two, which is what makes this an
// ordering the substitution can not change: the only reads it moves ahead of the
// Argument are the Array the walk owns and `push` on it, and a plain Array the
// Compiler declared has no member a Program could have written. Anything else in
// the body — a second Statement, a pushed value that is more than the Parameter,
// a second addition — keeps its binding, because then there IS something in
// between and this does not try to say what.
//
// NOTE: It is worth a turn's allocation on V8, which stops keeping the loop in
// optimised code once the item is bound before it is stored. A million-turn
// build of the counter measures 76 ms bound and 30 ms pushed where it stands on
// Node, against 33 ms for the copying shape this pass replaces; JavaScriptCore
// measures the two the same, so nothing is traded for it.
function pushedWhereBound(
	body: Array<estree.Statement>,
): Array<estree.Statement> {
	let [binding, push] = body

	if (body.length !== 2 || binding === undefined || push === undefined) {
		return body
	}

	if (
		binding.type !== "VariableDeclaration" ||
		binding.declarations.length !== 1 ||
		push.type !== "ExpressionStatement" ||
		push.expression.type !== "CallExpression" ||
		push.expression.arguments.length !== 1 ||
		// NOTE: The Array under its own name, which is the only thing the
		// substitution moves ahead of the Argument: a name read and `push` read
		// off it, neither of which can run a Program's code.
		push.expression.callee.type !== "MemberExpression" ||
		push.expression.callee.object.type !== "Identifier"
	) {
		return body
	}

	let bound = binding.declarations[0]!
	let argument = push.expression.arguments[0]!
	let init = bound.init ?? null

	if (
		init === null ||
		bound.id.type !== "Identifier" ||
		argument.type !== "Identifier" ||
		argument.name !== bound.id.name
	) {
		return body
	}

	return [
		{
			...push,
			expression: { ...push.expression, arguments: [init] },
		},
	]
}

// NOTE: Whether a name is mentioned anywhere in the emitted body at all, which
// is what an elided Parameter's `const` is held to. It is `mentionsBeyondValue`
// with nothing admitted: a List accumulator has no read of its own the emission
// understands, so any mention is one too many.
function mentionsIdentifier(root: unknown, name: string): boolean {
	let found = false
	// NOTE: The emitted tree is a tree today, and this is what says so has to
	// stay true of it: a Node the emission shared would otherwise be walked once
	// per path that reaches it.
	let seen = new Set<unknown>()

	function visit(node: unknown): void {
		if (
			found ||
			node === null ||
			typeof node !== "object" ||
			seen.has(node)
		) {
			return
		}

		seen.add(node)

		let record = node as Record<string, unknown>

		if (isNamed(record, name)) {
			found = true

			return
		}

		for (let value of Object.values(record)) {
			visit(value)
		}
	}

	visit(root)

	return found
}

// #endregion

// NOTE: What a `Step`-answering body's answer is written as, and the whole of
// what makes the `Step` disappear. Where the Compiler can SEE the Case being
// built at the answering position — `<- #Done(x)`, which is what such a body is
// made of — the walk assigns and leaves, and the Case is never built. Where it
// can not, the tag is read exactly as the driver read it, at that one site: a
// `Step` held under a name, one a Method answers with, one a nested walk
// settled on.
//
// NOTE: `#Continue` is written like any other answer — the State takes the
// value and the body is left through its own label, which is the way out the
// redirect already knows about. `#Done` is not: it leaves the WALK, so it breaks
// the label the walk carries, wherever in the body it stands.
function steppedTarget(
	prefix: string,
	state: string,
	answer: string,
	stop: () => void,
): RedirectTarget {
	return {
		kind: "answer",
		write: (written, redirect) => {
			let step = stepConstruction(written.node)

			if (step !== null) {
				if (!step.done) {
					return [
						loopAssignment(state, rewriteExpression(step.value)),
						...breakOut(redirect),
					]
				}

				stop()

				return [
					loopAssignment(answer, rewriteExpression(step.value)),
					loopBreak(prefix),
				]
			}

			stop()

			// NOTE: A block of its own, so that two answers falling back to the
			// tag read in one body each hold their `Step` under a name of their
			// own.
			let held = `${prefix}_step`

			return [
				loopBlock([
					loopDeclaration("const", held, written.value()),
					{
						type: "IfStatement",
						test: {
							type: "BinaryExpression",
							operator: "===",
							left: typeKeyRead(loopIdentifier(held)),
							right: {
								type: "Literal",
								value: renderIdentity(doneTag),
							},
						},
						consequent: loopBlock([
							loopAssignment(
								answer,
								memberRead(loopIdentifier(held), "value"),
							),
							loopBreak(prefix),
						]),
						alternate: null,
					},
					loopAssignment(
						state,
						memberRead(loopIdentifier(held), "state"),
					),
				]),
				...breakOut(redirect),
			]
		},
	}
}

// NOTE: The two Cases of the builtin `Step`, and the single member each carries
// — `#Done(x)` is `Step#Done { value: x }` and `#Continue(x)` is
// `Step#Continue { state: x }`. Nothing else may be read this way: a `Step` is
// the Type the two drivers take, and the Enricher admits no other value there.
const doneTag = "Step#Done"
const continueTag = "Step#Continue"

// NOTE: A `Step` the Compiler can see being BUILT, and null for every other
// answer. Both shapes of a construction are read, because both can arrive:
// `collapse-construction` runs AFTER the pass that inlines loops and turns a
// Case with a Record payload into the literal it emits, so a body holds a
// `CaseValue` with that pass off and a `direct-case` with it on. Reading one and
// not the other would make an optimisation depend on another being enabled,
// which is the one thing a pass may not do.
function stepConstruction(
	node: common.typedSimple.ExpressionNode | null,
): { done: boolean; value: common.typedSimple.ExpressionNode } | null {
	if (node === null) {
		return null
	}

	if (node.nodeType === "CaseValue") {
		return node.value !== null && node.value.nodeType === "RecordValue"
			? stepPayload(node.tag, node.value.members)
			: null
	}

	if (
		node.nodeType === "Intrinsic" &&
		node.kind === "direct-case" &&
		node.payload === null
	) {
		return stepPayload(node.tag, node.members)
	}

	return null
}

// NOTE: The payload of a `Step`, and the one member each Case declares. A
// payload holding anything MORE than that member is refused rather than read:
// taking the Case away takes the construction of every member with it, and a
// member the walk does not read is one that would stop being evaluated. `Step`
// declares exactly one member per Case today, so this refuses nothing — it is
// what keeps a second member from silently disappearing if one is ever added.
function stepPayload(
	tag: string,
	members: Record<string, common.typedSimple.ExpressionNode>,
): { done: boolean; value: common.typedSimple.ExpressionNode } | null {
	let names = Object.keys(members)

	if (names.length !== 1) {
		return null
	}

	let done = members["value"]
	let carried = members["state"]

	if (tag === doneTag && done !== undefined) {
		return { done: true, value: done }
	}

	if (tag === continueTag && carried !== undefined) {
		return { done: false, value: carried }
	}

	return null
}

// NOTE: What a body may be handed in place of the first Argument's Integer: the
// name it reads where it read `<name>.value`, and whatever has to be bound for
// the turn to establish that name. The binding is emitted ONLY where the swap is
// taken, so a body that keeps its box does not also pay for a view of it, and it
// is empty where the name is already what the body should read.
type UnboxedArgument = {
	read: string
	binding: Array<estree.Statement>
}

// NOTE: One callback's body, where the call to it was. The Parameters are bound
// as the `const`s of a block around it, which is the Scope the closure gave them
// and nothing more: the body reads its Parameters and everything enclosing the
// call under the same names it always did, and a Parameter standing in front of
// an outer binding stands in front of it for exactly the length of the block. No
// name is rewritten, so no name can be rewritten wrongly.
//
// NOTE: The body's Return Statements are what the walk reads, and the redirect
// is what writes them where they go — the same machinery a lowered Match's
// Handlers are written through, so a Match, a Conditional or another lowered
// loop inside a callback answers the walk exactly as a bare Return does. A
// Function DECLARED in the body keeps its own Returns, because that machinery
// descends by name and a Function is not one of the names it descends into.
function inlinedCallback(
	callback: common.typedSimple.InlineLoopCallback,
	args: Array<estree.Expression>,
	label: string,
	result: RedirectTarget,
	unboxable: UnboxedArgument | null = null,
	carried: CarriedState | null = null,
	dropped: number | null = null,
): estree.Statement {
	let broke = false
	let body = withNamespaceScope(() => [
		...callback.parameters.flatMap(
			(parameter, index): Array<estree.Statement> =>
				index === dropped
					? []
					: [
							{
								type: "VariableDeclaration",
								kind: "const",
								declarations: [
									{
										type: "VariableDeclarator",
										id: rewriteIdentifier(parameter),
										init: args[index]!,
									},
								],
							},
						],
		),
		...redirectedStatements(callback.body, {
			result,
			label,
			// NOTE: The body IS the block, so its last Statement has nothing
			// after it to skip — an answer written there needs no way out.
			isTail: true,
			broke: () => {
				broke = true
			},
		}),
	])
	let first = callback.parameters[0]
	// NOTE: One `const` short where the accumulator's was elided, which is what
	// the two slices below count in.
	let bound = callback.parameters.length - (dropped === null ? 0 : 1)
	// NOTE: Taken ONCE, before the swap below reshapes `body` — both questions
	// are about the Statements the callback's own body emitted, and the Array
	// holds the very Statements either swap rewrites in place.
	let statements = body.slice(bound)

	// NOTE: The List the walk builds in place, whose Parameter is not bound at
	// all: `build-lists-in-place` proved that every mention of it is a
	// rebuilding chain, and the target above consumed every one of them as
	// pushes. So a mention that survives is a mention the proof missed, and the
	// `const` this elided would have been what made it read. It can not happen
	// while the pass is right, and it is asked because the cost of it happening
	// silently is an emission that names something nothing declared.
	if (dropped !== null) {
		let accumulator = callback.parameters[dropped]

		if (
			accumulator !== undefined &&
			mentionsIdentifier(statements, rewriteIdentifier(accumulator).name)
		) {
			throw new Error(
				`Internal Compiler Error: the accumulator '${accumulator.name}' of a walk that builds its List in place is still mentioned by the emitted body — every mention should have been a build.`,
			)
		}
	}

	// NOTE: The State, handed to the walk that threads it rather than swapped
	// here: a `while` driver hands one State to TWO bodies, and it is held raw
	// for both of them or for neither. What this body contributes is the name it
	// reads the State under and the Statements the fence is asked of.
	if (carried !== null) {
		let held = callback.parameters[carried.parameter]

		if (held !== undefined) {
			carried.bodies.push({
				parameter: rewriteIdentifier(held).name,
				statements,
			})
		}
	}

	// NOTE: The Integer the first Argument boxes, NEVER BUILT where the body
	// only ever reads what it holds — which is what a counting body does, since
	// every arithmetic and every comparison reads through to the value. It is
	// one allocation a turn, and the walk's own measured cost roughly halves
	// without it.
	//
	// NOTE: What makes the swap safe is that it is refused on ANY other mention
	// of the name. A body that hands the Integer on, stores it, or shadows the
	// name keeps its box, and so does one that merely reads a member called
	// `index` off something else — the test does not try to tell those apart,
	// because being wrong once is worse than optimising every time.
	//
	// NOTE: The counter is a `for` head's `let`, so each turn binds a fresh one
	// and a closure the body builds captures the turn it was built in — which is
	// exactly what capturing the Integer gave it.
	//
	// NOTE: The two elisions are on DIFFERENT Parameters of the one callback
	// that can have both — the counted walk hands the counter first and the
	// State second — so the counter's `const` is still `body[0]` where the
	// State's was dropped, and neither elision has to know about the other.
	if (unboxable !== null && first !== undefined) {
		let name = rewriteIdentifier(first).name

		if (!mentionsBeyondValue(statements, name)) {
			replaceValueReads(statements, name, unboxable.read)
			body = [
				...unboxable.binding,
				...body.slice(1, bound),
				...statements,
			]
		}
	}

	// NOTE: Asked LAST, of whatever the two elisions above left — a build whose
	// turn is one push has neither of them to take, so the three never argue over
	// the same `const`, and asking here means this reads the Statements as they
	// will be emitted rather than as they were written.
	if (dropped !== null) {
		body = pushedWhereBound(body)
	}

	return broke ? labelled(label, loopBlock(body)) : loopBlock(body)
}

// NOTE: A walk's loop-carried State, held as the number or bigint its Integer
// boxes rather than as the Integer. The Integer is the walk's own — nobody
// outside it can hold one — so a walk whose bodies only ever read what it holds
// can carry the value itself and build the Integer once, where the walk answers.
// It is one allocation a TURN against one a walk, and on the two-million turn
// sum the walk's cost falls by roughly half again on top of the counter's.
//
// NOTE: It pays only together with the other half — a body whose arithmetic
// still answers a boxed Integer that the slot then reads back through `.value`
// is SLOWER than leaving the State alone, measured 23.65 ms against 22.06 on
// that sum. So `unboxedInteger` reads the guarded arithmetic through both arms
// and the box is never written at all.
//
// NOTE: `bodies` is what the fence is asked of: one entry per callback the State
// is handed to, holding the name that callback reads it under and the Statements
// it emitted. `answer` is the slot a `Step`-answering walk settles on, and null
// for a walk that answers with the State itself — it is the second place the
// State may be written WHOLE, and the place that write is boxed.
type CarriedState = {
	name: string
	answer: string | null
	parameter: number
	bodies: Array<{ parameter: string; statements: Array<estree.Statement> }>
}

// NOTE: The State of a walk that may be held raw, and null for one that may not.
// The Type has to be EXACTLY Integer in every body — not a Union it is a member
// of, not a Type Parameter that could be one — because the whole swap is that the
// slot holds what an Integer holds, and only an Integer is known to hold that. It
// is the same exactness `lower-scalar-operations` rests on, and it is what leaves
// a Record, a String or a Rational State untouched.
//
// NOTE: A Refinement over Integer IS carried, and there is nothing here that
// says so because there is nothing here that could see one: `eraseRefinements`
// runs at the head of every pipeline, before any pass, so a `NonZeroInteger`
// State reaches this as the Integer it is. That is right — a refinement is a
// promise the Validator kept, not a second representation.
function carriedInteger(
	name: string,
	answer: string | null,
	parameter: number,
	callbacks: Array<common.typedSimple.InlineLoopCallback>,
): CarriedState | null {
	return callbacks.every(
		(callback) => callback.parameters[parameter]?.type.type === "Integer",
	)
		? { name, answer, parameter, bodies: [] }
		: null
}

// NOTE: The swap, asked and taken in one — it answers whether the State is held
// raw, which is what decides how the walk answers with it.
//
// NOTE: The fence is `mentionsBeyondValue`, asked of every body: a body that
// hands the State on, stores it, matches it, asks any Method of it, shadows the
// name or reads a member of that name off something else keeps the box, and so
// does every OTHER body of the same walk, because one State can not be two
// things at once. Two mentions past `.value` are admitted, both of them the State
// written WHOLE into a slot the walk owns and neither of them a value that
// escapes: `<- carried`, which is what an arm that changes nothing writes, and
// `<- #Done(carried)`, which is how a `Step`-answering body ordinarily finishes.
// The first stands in a write that is unboxed with every other; the second stands
// in a write that is BOXED, once, where the walk is leaving anyway.
//
// NOTE: What is rewritten is every WRITE of the State: the `let` its seed
// declares and every assignment to it. They are found by NAME rather than
// recorded as they are emitted, because the name is the Compiler's own and holds
// a `_`, so no Essence Program can write it — and `mentionsBeyondWrites` is what
// makes finding them by name enough. It refuses unless every mention of the slot
// is one this understands, so a write `unboxWrites` would walk past can not be
// there when it runs: the two halves fail closed together rather than the fence
// refusing and the rewriter shrugging.
//
// NOTE: And the reads are redirected LAST, so that a write unboxed into
// `<parameter>.value` is redirected along with the reads the body already had.
function heldRaw(
	state: CarriedState | null,
	statements: Array<estree.Statement>,
): boolean {
	if (state === null) {
		return false
	}

	let slots =
		state.answer === null ? [state.name] : [state.name, state.answer]

	for (let body of state.bodies) {
		if (mentionsBeyondValue(body.statements, body.parameter, slots)) {
			return false
		}
	}

	if (
		mentionsBeyondWrites(
			statements,
			state.name,
			state.bodies.map((body) => body.parameter),
		)
	) {
		return false
	}

	unboxWrites(statements, state.name)

	for (let body of state.bodies) {
		if (state.answer !== null) {
			boxedAnswers(body.statements, state.answer, body.parameter)
		}

		replaceValueReads(body.statements, body.parameter, body.parameter)
	}

	return true
}

// NOTE: How a walk answers with its State: the Integer built once where the walk
// is over, or the State itself where it was one all along. `createInteger` and
// not the literal `boxedInteger` writes, even though every value the raw slot can
// hold is canonical by the invariant below — it is one call at the END of a walk
// rather than one a turn, and an exit that canonicalises does not have to be read
// together with everything that writes the slot to be believed.
//
// NOTE: The invariant the slot holds to is the Integer's own: a value in safe
// range is a number and a value outside it is a bigint. The seed enters as the
// value of an Integer, which is canonical; a guarded arithmetic answers a number
// it has just range-checked; an escaped one answers the value of an Integer the
// runtime built. There is no fourth way into the slot.
function carriedAnswer(state: string, raw: boolean): estree.Expression {
	return raw ? exitBox(loopIdentifier(state)) : loopIdentifier(state)
}

// NOTE: Every write of a name, read as the value the Integer it was given holds.
// Two shapes are written and no others: the `let` a seed is declared as, and the
// plain assignments a walk threads the State with. Anything else standing under
// that name is left alone — there is nothing else today, and a shape this does
// not understand is one it must not rewrite.
function unboxWrites(root: unknown, name: string): void {
	function visit(node: unknown): void {
		if (node === null || typeof node !== "object") {
			return
		}

		let record = node as Record<string, unknown>
		let written = writtenValue(record, name)

		if (written !== null) {
			record[written] = unboxedInteger(
				record[written] as estree.Expression,
			)
		}

		for (let value of Object.values(record)) {
			visit(value)
		}
	}

	visit(root)
}

// NOTE: Which key of a Node holds the value written to a name — `init` of the
// declarator that binds it, `right` of the plain assignment that sets it — and
// null for a Node that writes it some other way or not at all. A compound
// assignment answers null and is therefore never unboxed: the walk emits none,
// and one that appeared would mean something reads the slot this does not know
// about.
function writtenValue(
	record: Record<string, unknown>,
	name: string,
): "init" | "right" | null {
	let type = record["type"]

	if (type === "VariableDeclarator") {
		return isNamed(record["id"], name) && record["init"] !== null
			? "init"
			: null
	}

	return type === "AssignmentExpression" &&
		record["operator"] === "=" &&
		isNamed(record["left"], name)
		? "right"
		: null
}

function isNamed(node: unknown, name: string): boolean {
	if (node === null || typeof node !== "object") {
		return false
	}

	let record = node as Record<string, unknown>

	return record["type"] === "Identifier" && record["name"] === name
}

// NOTE: Whether a name is mentioned anywhere in the emitted body OTHER than as
// `<name>.value`. Every position is read — a property key and a member name
// included, which no reference can be — so the answer is conservative in the one
// direction that matters: a name this says nothing about is a name nothing may
// be assumed of.
//
// NOTE: `slots` widens that by exactly one position per slot, and only for a
// State: the name written WHOLE into a slot the walk owns. `<- carried` answers
// the State unchanged and `<- #Done(carried)` finishes with it, and the writes
// those two stand in are the two the caller rewrites — so each mention becomes a
// value the slot wanted anyway. Nothing else about either write is admitted:
// `<- carried::negate()` puts a call in that position and is a mention like any
// other.
function mentionsBeyondValue(
	root: unknown,
	name: string,
	slots: ReadonlyArray<string> = [],
): boolean {
	let found = false

	function visit(node: unknown): void {
		if (found || node === null || typeof node !== "object") {
			return
		}

		if (isValueRead(node, name)) {
			return
		}

		let record = node as Record<string, unknown>

		if (
			isNamed(record["right"], name) &&
			slots.some((slot) => writtenValue(record, slot) === "right")
		) {
			return
		}

		if (record["type"] === "Identifier" && record["name"] === name) {
			found = true

			return
		}

		for (let value of Object.values(record)) {
			visit(value)
		}
	}

	visit(root)

	return found
}

// NOTE: Whether the SLOT is mentioned anywhere the swap does not understand.
// `mentionsBeyondValue` asks this of the Parameter a body reads the State under;
// this asks it of the name the State is threaded through, and it is what holds
// `unboxWrites` to the same standard the fence holds a body to. Three positions
// are understood and no others: the two `writtenValue` rewrites — the `let` a
// seed declares and the plain assignment an answer is written as — and the
// `const` a turn binds a body's Parameter through, which is the one read of the
// slot the swap is FOR.
//
// NOTE: It is what makes recognising the two admitted writes by their shape
// enough. Every assignment to the slot is one this admitted and one
// `unboxWrites` rewrites, so an assignment standing somewhere the walk did not
// put it — inside a Function a later pass emitted, say — refuses the swap
// instead of being read at a time nobody checked.
function mentionsBeyondWrites(
	root: unknown,
	name: string,
	parameters: ReadonlyArray<string>,
): boolean {
	let found = false

	function visit(node: unknown): void {
		if (found || node === null || typeof node !== "object") {
			return
		}

		let record = node as Record<string, unknown>
		let written = writtenValue(record, name)

		if (written !== null) {
			visit(record[written])

			return
		}

		if (
			record["type"] === "VariableDeclarator" &&
			isNamed(record["init"], name) &&
			parameters.some((parameter) => isNamed(record["id"], parameter))
		) {
			return
		}

		if (record["type"] === "Identifier" && record["name"] === name) {
			found = true

			return
		}

		for (let value of Object.values(record)) {
			visit(value)
		}
	}

	visit(root)

	return found
}

// NOTE: The State written straight into the slot a walk ANSWERS with —
// `<- #Done(carried)`, which is how a `Step`-answering body ordinarily finishes
// — boxed where it is written. That slot holds Integers, because every other
// `#Done` writes one into it, and this is the one write that would otherwise put
// a value there. It is one Integer per WALK and not per turn: a `#Done` is what
// leaves the walk.
function boxedAnswers(root: unknown, answer: string, name: string): void {
	function visit(node: unknown): void {
		if (node === null || typeof node !== "object") {
			return
		}

		let record = node as Record<string, unknown>

		if (
			writtenValue(record, answer) === "right" &&
			isNamed(record["right"], name)
		) {
			record["right"] = createdInteger(
				record["right"] as estree.Expression,
			)

			return
		}

		for (let value of Object.values(record)) {
			visit(value)
		}
	}

	visit(root)
}

// NOTE: The other half, run only once the question above has been answered:
// every `<name>.value` becomes a read of the name holding that value, in place —
// the counter itself for a counted walk's index, and the Parameter itself for a
// State, which is bound to the raw slot and reads it. Written as a walk over the
// PARENT so the read can be replaced where it sits, since a node can not turn
// itself into another kind.
function replaceValueReads(root: unknown, name: string, held: string): void {
	function visit(node: unknown): void {
		if (node === null || typeof node !== "object") {
			return
		}

		let record = node as Record<string, unknown>

		for (let [key, value] of Object.entries(record)) {
			if (isValueRead(value, name)) {
				record[key] = loopIdentifier(held)
			} else {
				visit(value)
			}
		}
	}

	visit(root)
}

function isValueRead(node: unknown, name: string): boolean {
	if (node === null || typeof node !== "object") {
		return false
	}

	let record = node as Record<string, unknown>
	let object = record["object"] as Record<string, unknown> | undefined
	let property = record["property"] as Record<string, unknown> | undefined

	return (
		record["type"] === "MemberExpression" &&
		record["computed"] === false &&
		record["optional"] !== true &&
		object?.["type"] === "Identifier" &&
		object["name"] === name &&
		property?.["type"] === "Identifier" &&
		property["name"] === "value"
	)
}

// NOTE: What an inlined List walk begins with: the items under a name, and how
// many of them there are under another. `List.materialise` answers the Array a
// List's logical items live in — a List that has been prepended to holds two
// runs, and reading `.value` would walk one of them — and caches the work on
// the box, so the second walk over the same List pays nothing.
//
// NOTE: The count is read HERE and never again. A List's backing Array grows
// under an append that finds its receiver at the Array's tip, so a body that
// appends to the very List it walks pushes onto the Array the walk is reading:
// `list::reduce(startingWith list, (acc, item) { <- acc::append(item) })` seeds
// the accumulator with the walked List and does exactly that. The walk covers
// the items the receiver held when it began — which is what it covered when
// every append copied — and only a count fixed before the first turn says so.
function heldItems(
	items: string,
	count: string,
	expression: estree.Expression,
): Array<estree.VariableDeclaration> {
	return [
		loopDeclaration("const", items, materialisedRead(expression)),
		loopDeclaration(
			"const",
			count,
			memberRead(loopIdentifier(items), "length"),
		),
	]
}

// NOTE: The walk every List Method performs — over the positions of the Array
// the List holds, which is the walk the natives perform and the one shape a
// `for` says better than an iterator does. Its bound is the count `heldItems`
// froze, not the Array's own live length.
function itemsWalk(
	count: string,
	position: string,
	body: Array<estree.Statement>,
): estree.Statement {
	return {
		type: "ForStatement",
		init: loopDeclaration("let", position, { type: "Literal", value: 0 }),
		test: {
			type: "BinaryExpression",
			operator: "<",
			left: loopIdentifier(position),
			right: loopIdentifier(count),
		},
		update: {
			type: "UpdateExpression",
			operator: "++",
			prefix: false,
			argument: loopIdentifier(position),
		},
		body: loopBlock(body),
	}
}

function itemAt(items: string, position: string): estree.MemberExpression {
	return {
		type: "MemberExpression",
		optional: false,
		computed: true,
		object: loopIdentifier(items),
		property: loopIdentifier(position),
	}
}

// NOTE: The raw JavaScript boolean a predicate's answer decides by — and, where
// the answer is a Boolean an earlier pass BUILT out of a JavaScript test, the
// test it was built from. It is the same collapse an `if` performs on its
// condition, in the one other place a Boolean is built only to be read back.
function rawAnswer(answer: LoopAnswer): estree.Expression {
	let node = answer.node

	return node !== null &&
		node.nodeType === "Intrinsic" &&
		node.kind === "essence-boolean"
		? rewriteExpression(node.value)
		: valueRead(answer.value())
}

function negatedAnswer(test: estree.Expression): estree.Expression {
	return {
		type: "UnaryExpression",
		operator: "!",
		prefix: true,
		argument: test,
	}
}

// NOTE: The literal constructors, spelled exactly as every other emission site
// spells them — a read off the `import * as <Namespace>` the Program opens with.
function createdInteger(value: estree.Expression): estree.Expression {
	return {
		type: "CallExpression",
		optional: false,
		callee: memberRead(loopIdentifier("Integer"), "createInteger"),
		arguments: [value],
	}
}

// NOTE: Whether a bound is written as an Integer the canonical invariant holds
// as a NUMBER, which is what a counted walk asks of both of its bounds before it
// writes any of the bigint half. Only a Literal answers yes — a folded operation
// is one by the time this reads it, and `pool-constants` has already put every
// Literal behind a reference, so the value is read through that. Anything else
// is a value nothing is known about, and the walk decides at run time.
function safeBound(node: common.typedSimple.ExpressionNode): boolean {
	if (node.nodeType === "Intrinsic" && node.kind === "pooled-reference") {
		return safeBound(node.value)
	}

	if (node.nodeType !== "IntegerValue") {
		return false
	}

	let held = BigInt(decimalDigits(node.value))

	return held >= -BigInt(SAFE_INTEGER) && held <= BigInt(SAFE_INTEGER)
}

// NOTE: One step of the counter, in numbers: up or down by one, which is the
// step of every walk whose bounds a double holds.
function steppedBy(ascending: string): estree.Expression {
	return {
		type: "ConditionalExpression",
		test: loopIdentifier(ascending),
		consequent: numberLiteral(1),
		alternate: numberLiteral(-1),
	}
}

// NOTE: One step of a counter that had to escape to bigint, as the literal an
// Integer past safe range holds.
function countLiteral(value: bigint): estree.BigIntLiteral {
	return { type: "Literal", bigint: value.toString(), value }
}

// NOTE: The turn's counter, in the representation the canonical invariant gives
// it. The KIND is decided once, from the bounds, because a `for` counter can not
// change kind mid-walk — its `+=` would throw — but canonicality is a property
// of each VALUE, and a walk with one bound inside safe range and one outside
// counts in bigint through values a double holds exactly. A bigint spelling of
// one of those is a second spelling of a value that already has one, which is
// exactly what emitted `===` may not be handed — `9007199254740990n` and
// `9007199254740990` are one Integer and compare `false`. The body that keeps
// its Integer is handed a `createInteger` that settles this; the body the box
// was elided out of is handed this.
//
// NOTE: The escaped `const` is asked FIRST, so the walk that counts in numbers —
// every walk over ordinary quantities — reads one loop-invariant `false` and
// then the counter it already had. The call is on the arm no walk a Program can
// finish takes more than a few turns of.
function canonicalCounter(
	held: string,
	index: string,
	escaped: string,
): estree.Statement {
	return loopDeclaration("const", held, {
		type: "ConditionalExpression",
		test: loopIdentifier(escaped),
		consequent: {
			type: "CallExpression",
			optional: false,
			callee: memberRead(loopIdentifier("Integer"), "canonical"),
			arguments: [loopIdentifier(index)],
		},
		alternate: loopIdentifier(index),
	})
}

function createdList(value: estree.Expression): estree.Expression {
	return {
		type: "CallExpression",
		optional: false,
		callee: memberRead(loopIdentifier("List"), "createList"),
		arguments: [value],
	}
}

// NOTE: The Array a List's logical items live in, read off the `import * as
// List` the same way `createdList` reads its constructor. Not a member the
// language has: it is the runtime's own choke point, the one place a List that
// carries its items in two runs is made to carry them in one.
//
// NOTE: It is what the natives WRITTEN AGAINST ONE ARRAY reach for — `slice`,
// `reverse`, `insert`, `sort`, `split`, `pair` — and what an inlined walk
// reaches for because the `for` below indexes one Array rather than two. The
// natives that WALK a List do the opposite deliberately: `map`, `keepEvery`,
// both `reduce` entries, `is`, `compare`, `join` and the rest take a view and
// read the two runs in turn, so that walking a List never collapses it. An
// emitted walk cannot afford that shape, and pays one combining instead.
function materialisedRead(list: estree.Expression): estree.Expression {
	return {
		type: "CallExpression",
		optional: false,
		callee: memberRead(loopIdentifier("List"), "materialise"),
		arguments: [list],
	}
}

function pushed(
	array: string,
	...values: Array<estree.Expression>
): estree.Statement {
	return {
		type: "ExpressionStatement",
		expression: {
			type: "CallExpression",
			optional: false,
			callee: memberRead(loopIdentifier(array), "push"),
			arguments: values,
		},
	}
}

// NOTE: The names an inlined loop binds are the Compiler's own and are emitted
// verbatim — every one of them is spelled from the loop's prefix, which holds a
// `_` and is therefore a name no Essence Program can write.
function loopIdentifier(name: string): estree.Identifier {
	return { type: "Identifier", name }
}

function loopDeclaration(
	kind: "let" | "const",
	name: string,
	init: estree.Expression | null,
): estree.VariableDeclaration {
	return {
		type: "VariableDeclaration",
		kind,
		declarations: [
			{
				type: "VariableDeclarator",
				id: loopIdentifier(name),
				init,
			},
		],
	}
}

function loopAssignment(
	name: string,
	value: estree.Expression,
): estree.Statement {
	return {
		type: "ExpressionStatement",
		expression: {
			type: "AssignmentExpression",
			operator: "=",
			left: loopIdentifier(name),
			right: value,
		},
	}
}

function loopBreak(label: string): estree.Statement {
	return { type: "BreakStatement", label: loopIdentifier(label) }
}

function labelled(label: string, body: estree.Statement): estree.Statement {
	return { type: "LabeledStatement", label: loopIdentifier(label), body }
}

function loopBlock(body: Array<estree.Statement>): estree.BlockStatement {
	return { type: "BlockStatement", body }
}

// #endregion

// #region Helpers

function rewriteBlockStatement(
	nodes: Array<common.typedSimple.ImplementationNode>,
): estree.BlockStatement {
	return {
		type: "BlockStatement",
		// NOTE: One emitted block is one Namespace Scope, so a `namespace List`
		// declared inside a Function is the user's for the rest of that Function
		// and the import again the moment the block closes — which is what lets a
		// sibling Function beside it keep calling the runtime's List.
		body: withNamespaceScope(() =>
			nodes
				.flatMap((node) => rewriteStatements(node))
				.filter((value) => !!value),
		),
	}
}

// NOTE: A Parameter carrying a default becomes an `AssignmentPattern` — the
// JavaScript default parameter, whose semantics are the ones the language
// declares. `@` is `_self`, which is Parameter 0, so a default reading `@`
// reads a BINDING rather than re-computing the receiver expression: that
// property is exactly what filling a default in at the call site could not
// offer, and it is why the language puts the default on the callee.
function rewriteParameter(
	parameter: common.typedSimple.ParameterNode,
): estree.Pattern {
	let name = rewriteIdentifier(parameter.internalName)

	if (parameter.defaultValue === null) {
		return name
	}

	return {
		type: "AssignmentPattern",
		left: name,
		right: rewriteExpression(parameter.defaultValue),
	}
}

function rewriteFunctionExpression(
	node: common.typedSimple.FunctionDefinitionNode,
): estree.FunctionExpression {
	return {
		type: "FunctionExpression",
		id: null,
		params: node.parameters.map((param) => rewriteParameter(param)),
		body: rewriteBlockStatement(node.body),
	}
}

function rewriteArgument(
	node: common.typedSimple.ArgumentNode,
): estree.Expression {
	return rewriteExpression(node.value)
}

function internalImport(
	specifiers: Array<
		| estree.ImportSpecifier
		| estree.ImportDefaultSpecifier
		| estree.ImportNamespaceSpecifier
	>,
	fileName: string,
): estree.ImportDeclaration {
	// NOTE: An absolute path rather than `@essence-lang/runtime/<Name>`, because
	// the emitted module is written to the user's directory and handed to esbuild
	// from there — a package specifier would have to resolve against wherever
	// that is. The Bundler inlines these and they never reach the output.
	//
	// NOTE: A HOST's build is the other way around. Nothing is inlined there —
	// the Modules are handed over one at a time and the host resolves what they
	// import — and an absolute path into this Compiler's own installation is not
	// something a host bundler will read, let alone transpile. The package
	// specifier is: the runtime is a dependency of the client the host already
	// installed, and every Module of every entry importing it BY NAME is what
	// leaves one runtime, and therefore one Type key, in the finished app.
	const specifier =
		emission.target.mode === "host"
			? `${RUNTIME_PACKAGE}/${fileName}`
			: path.join(RUNTIME_DIRECTORY, `${fileName}.ts`)

	return {
		type: "ImportDeclaration",
		specifiers,
		attributes: [],
		source: {
			type: "Literal",
			value: specifier,
			raw: `"${specifier}"`,
		},
	}
}

function importNamespaceSpecifier(
	variableName: string,
): estree.ImportNamespaceSpecifier {
	return {
		type: "ImportNamespaceSpecifier",
		local: {
			type: "Identifier",
			name: variableName,
		},
	}
}

// NOTE: Arrays have to be checked before the general object case — they are
// `typeof "object"` too, and emitting one as an ObjectExpression would turn a
// Union's member list into `{ 0: …, 1: … }`, which no longer has the Array
// Methods the runtime Type check calls on it.
function convertValueToExpression(value: unknown): estree.Expression {
	if (Array.isArray(value)) {
		return {
			type: "ArrayExpression",
			elements: value.map(convertValueToExpression),
		}
	}

	if (value !== null && typeof value === "object") {
		return convertObjectToObjectExpression(value)
	}

	return {
		type: "Literal",
		value: typeof value === "string" ? renderIdentity(value) : value,
	} as estree.Literal
}

// NOTE: A derived-equality descriptor emitted as a plain JSON-shaped literal.
// Its keys are Case tags like `"Choice#Case"` and the payload member names
// underneath them, neither of which a JavaScript IdentifierName is guaranteed
// to spell, so every key here is a string Literal — one rule for the whole
// tree, where `convertObjectToObjectExpression` asks `memberKey` per key and
// leaves the ordinary names unquoted.
function jsonExpression(value: unknown): estree.Expression {
	if (Array.isArray(value)) {
		return {
			type: "ArrayExpression",
			elements: value.map(jsonExpression),
		}
	}

	if (value !== null && typeof value === "object") {
		return {
			type: "ObjectExpression",
			properties: Object.entries(value).map<estree.Property>(
				([key, entry]) => ({
					type: "Property",
					key: { type: "Literal", value: renderIdentity(key) },
					value: jsonExpression(entry),
					kind: "init",
					computed: false,
					method: false,
					shorthand: false,
				}),
			),
		}
	}

	return {
		type: "Literal",
		value: typeof value === "string" ? renderIdentity(value) : value,
	} as estree.Literal
}

// NOTE: A Type descriptor emitted as the object literal the runtime's Type
// check reads. Most of its keys are the descriptor's own fields — `type`,
// `members`, `itemType` — but a Record descriptor's `members` map is keyed by
// Essence member names, and an Essence identifier may hold characters no
// JavaScript IdentifierName may: `case { ok?: Boolean }` emitted
// `members: { ok?: … }`, which no JavaScript parser accepts, so a Program that
// compiled without a single Diagnostic died in the bundler instead. `memberKey`
// is the same answer the Record literal and the member read give, so all three
// spell such a name alike.
function convertObjectToObjectExpression(
	object: object,
): estree.ObjectExpression {
	return {
		type: "ObjectExpression",
		properties: Object.entries(object).map<estree.Property>(
			([key, value]) => {
				return {
					type: "Property",
					key: memberKey(key),
					value: convertValueToExpression(value),
					kind: "init",
					computed: false,
					method: false,
					shorthand: false,
				}
			},
		),
	}
}

// NOTE: A Type SERIALIZED for the runtime, which is every place a Type stops
// being something the Compiler reasons about and becomes data a Program carries.
// A checked refinement may not reach one: its predicate is not a check the
// runtime can make, so an emitted descriptor naming it would ask
// `isValueOfType` a question it has no answer to and quietly claim every value
// fails it.
//
// So this refuses, loudly and at compile time, rather than emitting it. Nothing
// a Program can WRITE gets here — the Optimiser stage erases every refinement
// out of the tree before the Rewriter sees it — which is exactly why this is
// worth having: it is the assertion that the erasure was complete, and it names
// the Compiler, not the reader, when it is not.
function typeDescriptorExpression(
	type: common.Type,
	where: string,
): estree.ObjectExpression {
	if (typeContainsRefinement(type)) {
		throw new Error(
			`Internal Compiler Error: a checked refinement reached ${where} — refinements are erased in the Optimiser stage and can not be emitted.`,
		)
	}

	return convertObjectToObjectExpression(type)
}
// #endregion
