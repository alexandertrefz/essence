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
} from "./stdlibPrelude"

// NOTE: The builtin Namespaces that have a runtime module in `@essence-lang/runtime`, in
// the order their imports are emitted. Every one is imported unconditionally,
// under its own name, and a Namespace no Program references costs nothing —
// esbuild shakes an unused `import * as <Name>` away entirely. A Method the
// standard library implements in Essence is NOT a member of one of these; it is
// its own `$es_<Namespace>_<member>` const, emitted alongside. Exported so the
// tests cross-check it against the other registration sites — a Namespace here
// but missing a runtime module, or declared in `packages/stdlib/sources` but missing here,
// emits a call to `undefined`.
export const runtimeNamespaceNames = [
	"String",
	"Integer",
	"Rational",
	"Algebraic",
	"Transcendental",
	"Number",
	"Boolean",
	"Nothing",
	"Optional",
	"Ordering",
	"Side",
	"Case",
	"NormalizationForm",
	"NumberFormat",
	"Record",
	"List",
	"NestedList",
]

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
export function rewrite(program: common.typedSimple.Program): string {
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
	const implementation = rewriteImplementationSection(program.implementation)
	const essenceMembers = reachableEssenceMethods(
		prelude,
		implementation,
		freeFunctions,
	)

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
			// in the two bands `orderEssenceMembers` puts them in: the
			// Function-valued ones in any order, and the static Properties, whose
			// values are computed HERE, after them.
			...orderEssenceMembers(essenceMembers),
			...implementation,
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
	options?: { sourcemap?: boolean },
): ModuleSources {
	let entryDirectory = path.dirname(entryPath)
	let spellings = new Map(
		modules.map((module) => [
			module.filePath,
			moduleSpelling(entryDirectory, module.filePath),
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

	return withModuleSpellings(spellings, () => {
		let prelude = stdlibPrelude()
		let freeFunctions = stdlibFreeFunctions()
		let bodies = modules.map((module) => ({
			module,
			body: withSourcePath(module.filePath, () =>
				rewriteImplementationSection(module.program.implementation),
			),
		}))

		let essenceMembers = reachableEssenceMethods(
			prelude,
			bodies.flatMap((rewritten) => rewritten.body),
			freeFunctions,
		)

		let declared = new Set(essenceMembers.keys())
		let sources = new Map<string, string>()
		let preludeProgram = preludeModule(essenceMembers)

		checkEssenceMethodsAreDeclared(preludeProgram, declared)
		sources.set(PRELUDE_SPECIFIER, generateProgram(preludeProgram))

		for (let { module, body } of bodies) {
			let names = referencedNames(body)
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
					moduleSpelling(entryDirectory, entryPath),
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
function preludeModule(members: Map<string, EssenceMember>): estree.Program {
	let declarations = orderEssenceMembers(members)
	let names = [...members.keys()]

	return {
		type: "Program",
		sourceType: "module",
		body: [
			...runtimeImports(referencedNames(declarations)),
			...declarations,
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

// NOTE: How a Module's canonical path is spelled in emitted output — relative
// to the ENTRY's directory, so a bundle names its own Modules the way the entry
// would have written them and never the machine that compiled. Tags need to
// agree within one bundle only: a bundle is standalone and can exchange no
// value with another at run time.
function moduleSpelling(entryDirectory: string, filePath: string): string {
	let relative = path
		.relative(entryDirectory, filePath)
		.split(path.sep)
		.join("/")

	return relative.startsWith("../") ? relative : `./${relative}`
}

// NOTE: The canonical path of every Module of the bundle being emitted, and how
// each is spelled. Empty for a single-file Program — which is why its Case tags
// and Type descriptors come out byte for byte as they did before Modules: a
// Choice identified by its bare name has no path in it to render.
let moduleSpellings: ReadonlyMap<string, string> = new Map()

// NOTE: `finally`, for the same reason the Namespace scope stack has one: a
// throw out of the emission of one bundle must not leave the next Program in
// this process rendering its tags against a graph it is not part of.
function withModuleSpellings<Value>(
	spellings: ReadonlyMap<string, string>,
	emit: () => Value,
): Value {
	moduleSpellings = spellings

	try {
		return emit()
	} finally {
		moduleSpellings = new Map()
	}
}

// NOTE: The canonical path of the Module currently being emitted — what a
// node's `loc` names as its source. Null everywhere outside `rewriteModules`'
// per-Module pass: the prelude and the single-file form then attach no `loc`
// and emit no mapping.
let currentSourcePath: string | null = null

function withSourcePath<Value>(sourcePath: string, emit: () => Value): Value {
	let previousSourcePath = currentSourcePath
	currentSourcePath = sourcePath

	try {
		return emit()
	} finally {
		currentSourcePath = previousSourcePath
	}
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

// NOTE: One nominal identity as the bundle spells it. A Case tag is
// `<Choice identity>#<Case>` and a Choice identity is `<Module path>#<Choice>`,
// so what arrives here carries the canonical path of the Module that declared
// it — which is a place on the machine that compiled and must not be emitted.
// The path is replaced by the entry-relative spelling and nothing else changes,
// so the tag a value is stamped with and the tag a Type descriptor compares it
// against are rendered by this one answer and can not disagree.
//
// NOTE: Every string of an emitted Type descriptor comes through here, not just
// the ones known to be tags. Over-rendering is impossible rather than merely
// unlikely: a Module path is absolute, and no other string a descriptor can
// hold — a Type's `type`, a Namespace's name, a Record member — is.
function renderIdentity(text: string): string {
	for (let [modulePath, spelling] of moduleSpellings) {
		if (text.startsWith(`${modulePath}#`)) {
			return `${spelling}${text.slice(modulePath.length)}`
		}
	}

	return text
}

function rewriteImplementationSection(
	implementation: common.typedSimple.ImplementationSectionNode,
): Array<estree.ModuleDeclaration | estree.Statement> {
	// NOTE: The outermost block a user Namespace can be declared in, and a Scope
	// of its own for the same reason every inner block is one — the Enricher
	// refuses a top-level `namespace List` today, but nothing here rests on that.
	return withNamespaceScope(() =>
		implementation.nodes.map((node) => rewriteStatement(node)),
	)
}

// #region Statements

function rewriteStatement(
	node: common.typedSimple.ImplementationNode,
): estree.Statement {
	let statement = rewriteStatementByKind(node)
	let loc = locOf(node.position)

	if (loc !== undefined) {
		statement.loc = loc
	}

	return statement
}

function rewriteStatementByKind(
	node: common.typedSimple.ImplementationNode,
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
						key: memberKey(name),
						value: rewriteExpression(value),
						computed: false,
						static: true,
					}
				}),
				...Object.entries(node.methods).map<estree.MethodDefinition>(
					([name, method]) => {
						return {
							type: "MethodDefinition",
							key: memberKey(name),
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
	let ordered: Array<
		estree.VariableDeclaration | estree.FunctionDeclaration
	> = []
	let values = new Map(
		[...members].filter(([, member]) => member.kind === "value"),
	)

	for (let member of members.values()) {
		if (member.kind === "function") {
			ordered.push(member.declaration)
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

	return ordered
}

// NOTE: Which Essence-implemented Methods the emitted Program actually needs,
// and the const for each. A const is emitted only where something names it:
// unlike a native, whose unused `import * as <Name>` esbuild shakes away, an
// unused const still names the runtime Methods its body reaches, and once a
// module is in the graph its impure top-level initialisers (`Number.PI`,
// `Number.TAU`) can no longer be dropped — so an unconditional const would
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
export function reachableEssenceMethods(
	prelude: Array<PreludeNamespace>,
	implementation: Array<estree.ModuleDeclaration | estree.Statement>,
	freeFunctions: Array<PreludeFreeFunction> = [],
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
	// Identifiers by now, so `referencedNames` finds them all alike.
	include(referencedNames(implementation))

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
			record["nodeType"] === "NativeFunctionInvocation"
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
			alternate = rewriteStatement(node.falseBody[0])
		} else {
			alternate = rewriteBlockStatement(node.falseBody)
		}
	}

	return {
		type: "IfStatement",
		test: {
			type: "MemberExpression",
			optional: false,
			object: rewriteExpression(node.condition),
			property: {
				type: "Identifier",
				name: "value",
			},
			computed: false,
		},
		consequent: rewriteBlockStatement(node.trueBody),
		alternate,
	}
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

function rewriteExpressionStatement(
	node:
		| common.typedSimple.ExpressionNode
		| common.typedSimple.VariableAssignmentStatementNode,
): estree.ExpressionStatement {
	return {
		type: "ExpressionStatement",
		expression: rewriteExpression(node),
	}
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
		case "NativeFunctionInvocation":
			return rewriteNativeFunctionInvocation(node)
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
		case "NothingValue":
			return rewriteNothingValue(node)
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
	}
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

function rewriteNativeFunctionInvocation(
	node: common.typedSimple.NativeFunctionInvocationNode,
): estree.CallExpression {
	if (node.name.nodeType !== "Identifier") {
		throw Error(
			"Lookups on NativeFunctionIvocations are not implemented yet.",
		)
	}

	// NOTE: The `__`-sigil name IS the runtime export name now — `__print` binds
	// to `functions.__print`. The prefix used to be stripped here, so the runtime
	// exported a differently-spelled `print`; unifying the two lets `__print`
	// migrate into `packages/stdlib/sources/Print.es` as an ordinary native free Function.
	return {
		type: "CallExpression",
		optional: false,
		callee: functionsModuleMember(node.name.name),
		arguments: node.arguments.map((arg) => rewriteArgument(arg)),
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
// name their Namespace directly and are not declared in `packages/stdlib/sources`, so they
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
		memberName,
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
							convertObjectToObjectExpression(
								dispatchCase.memberType,
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
							...(dispatchCase.contextualArguments.length === 0
								? []
								: [
										contextualArgumentOverrides(
											dispatchCase.contextualArguments,
										),
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
				callee: memberRead(
					rewriteExpression(segment.witness),
					"toString",
				),
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

function rewriteIntegerValue(
	node: common.typedSimple.IntegerValueNode,
): estree.CallExpression {
	let value = decimalDigits(node.value)

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

function rewriteNothingValue(
	_node: common.typedSimple.NothingValueNode,
): estree.CallExpression {
	return {
		type: "CallExpression",
		optional: false,
		callee: {
			type: "MemberExpression",
			optional: false,
			object: {
				type: "Identifier",
				name: "Nothing",
			},
			property: {
				type: "Identifier",
				name: "createNothing",
			},
			computed: false,
		},
		arguments: [],
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
// static Property read (`Number.PI`) and a plain Record member access
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
function escapeName(name: string): string {
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
function namespaceIdentifierName(namespaceName: string): string {
	return runtimeNamespaceNameSet.has(namespaceName) &&
		!isShadowingUserNamespace(namespaceName)
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

// NOTE: One member read, `computed` iff the key had to become a Literal — the
// dotted form for every ordinary name, the bracketed one for the rest.
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

function rewriteMatch(
	node: common.typedSimple.MatchNode,
): estree.CallExpression {
	function callIsValueOfType(
		value: estree.Expression,
		matcher: common.Type,
	): estree.CallExpression {
		let matcherArgument: estree.ObjectExpression

		// TODO: Handle Record Types
		matcherArgument = convertObjectToObjectExpression(matcher)

		return {
			type: "CallExpression",
			optional: false,
			callee: {
				type: "MemberExpression",
				object: { type: "Identifier", name: "$type" },
				property: { type: "Identifier", name: "isValueOfType" },
				optional: false,
				computed: false,
			},
			arguments: [value, matcherArgument],
		}
	}

	function callAnyIs(
		value: estree.Expression,
		literal: estree.Expression,
	): estree.CallExpression {
		return {
			type: "CallExpression",
			optional: false,
			callee: {
				type: "MemberExpression",
				object: { type: "Identifier", name: "$helpers" },
				property: { type: "Identifier", name: "anyIs" },
				optional: false,
				computed: false,
			},
			arguments: [value, literal],
		}
	}

	// NOTE: A literal Matcher needs no Type check in front of it — `anyIs`
	// already answers false across differing Types. A Guard is ANDed on after
	// whichever check the Matcher produced, so it only ever narrows.
	function handlerTest(
		handler: common.typedSimple.MatchNode["handlers"][number],
		value: estree.Identifier,
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

		let test: estree.Expression =
			handler.literal === null
				? callIsValueOfType(value, handler.matcher)
				: callAnyIs(value, rewriteExpression(handler.literal))

		// NOTE: The member comparisons come after the Matcher's own check and
		// rely on `&&` short-circuiting — that check is what guarantees the
		// value is a Record carrying every member named here, so reading them
		// is only safe once it has passed.
		if (handler.memberLiterals !== null) {
			for (let [name, literal] of Object.entries(
				handler.memberLiterals,
			)) {
				test = and(
					test,
					callAnyIs(
						memberRead(value, name),
						rewriteExpression(literal),
					),
				)
			}
		}

		if (handler.guard === null) {
			return test
		}

		return and(test, {
			type: "MemberExpression",
			object: rewriteExpression(handler.guard),
			property: { type: "Identifier", name: "value" },
			optional: false,
			computed: false,
		})
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
	function noCaseMatched(
		value: estree.Identifier,
	): estree.ExpressionStatement {
		return {
			type: "ExpressionStatement",
			expression: {
				type: "CallExpression",
				optional: false,
				callee: {
					type: "MemberExpression",
					object: { type: "Identifier", name: "$type" },
					property: {
						type: "Identifier",
						name: "noCaseMatched",
					},
					optional: false,
					computed: false,
				},
				arguments: [value],
			},
		}
	}

	const valueExpression = rewriteExpression(node.value)
	const selfParameter: estree.Identifier = {
		type: "Identifier",
		name: "_self",
	}

	// NOTE: The Handlers are folded back to front, so that each `if` becomes
	// the `else` of the one before it — the first Handler ends up at the head
	// of the chain and is therefore tested first.
	let ifChain: estree.IfStatement | undefined

	for (let i = node.handlers.length - 1; i >= 0; i--) {
		const currentHandler = node.handlers[i]

		let ifStatement: estree.IfStatement = {
			type: "IfStatement",
			test: handlerTest(currentHandler, selfParameter),
			consequent: rewriteBlockStatement(currentHandler.body),
			alternate: ifChain ?? {
				type: "BlockStatement",
				body: [noCaseMatched(selfParameter)],
			},
		}

		ifChain = ifStatement
	}

	return {
		type: "CallExpression",
		callee: {
			type: "FunctionExpression",
			body: {
				type: "BlockStatement",
				body: [ifChain ?? noCaseMatched(selfParameter)],
			},
			params: [selfParameter],
		},
		arguments: [valueExpression],
		optional: false,
	}
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
				.map((node) => rewriteStatement(node))
				.filter((value) => !!value),
		),
	}
}

function rewriteParameter(
	parameter: common.typedSimple.ParameterNode,
): estree.Pattern {
	return rewriteIdentifier(parameter.internalName)
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
	// NOTE: An absolute path rather than `@essence-lang/runtime/<Name>`, because the
	// emitted module is written to the user's directory and handed to esbuild
	// from there — a package specifier would have to resolve against wherever
	// that is. The Bundler inlines these and they never reach the output.
	const specifier = path.join(RUNTIME_DIRECTORY, `${fileName}.ts`)

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
// #endregion
