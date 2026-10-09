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
import {
	conditionallyStructuralNamespaces,
	derivedEnumerableNamespaceName,
	derivedEquatableNamespaceName,
	derivedPrintableNamespaceName,
	structurallyEquatableNamespaces,
} from "../helpers/conformance"
import { openArgumentHoles } from "../helpers/defaults"
import { displayProtocolName } from "../helpers/describe"
import { typeContainsRefinement, withoutRecordNames } from "../helpers/types"
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
import {
	compilerOwnedNames,
	escapeName,
	isJavaScriptIdentifierName,
	mangleName,
} from "./names"
import {
	graphProvidedMethods,
	hoistedCoverageCounter,
	protocolEntryIdentity,
	protocolPreludeNamespaces,
	providedMethodDeclarations,
	providedMethodExports,
	type ProvidedMemberIdentifiers,
	providedMemberIdentifiers,
	providedMethodImports,
} from "./providedMethods"
import { runtimeNamespaceNames } from "./runtimeNamespaces"
import {
	ESSENCE_METHOD_PREFIX,
	essenceMethodIdentifier,
	essenceMethodName,
	essencePropertyName,
	protocolMemberIdentifier,
	mergingNativeShimName,
	nativeFreeFunctionNames,
	nativeShimName,
	type PreludeFreeFunction,
	type PreludeNamespace,
	stdlibFreeFunctions,
	stdlibPrelude,
	withOptimiserOptions,
} from "./stdlibPrelude"

export { runtimeNamespaceNames }

export {
	BUNDLE_TARGET,
	type EmitTarget,
	emitTargetKey,
	RUNTIME_PACKAGE,
} from "./emitTarget"

// One Program in, the JavaScript text of one module out, the same text for
// the same Program. See "A lone Program and a graph" in DEVELOPMENT.md.
export function rewrite(
	program: common.typedSimple.Program,
	// The options the Program was optimised under, which the prelude is
	// optimised under too.
	optimiserOptions: OptimiserOptions = defaultOptimiserOptions,
): string {
	return withOptimiserOptions(optimiserOptions, () => rewriteProgram(program))
}

function rewriteProgram(program: common.typedSimple.Program): string {
	// The Program's own Protocol-provided Methods join the prelude, so one
	// const answers for every conformer.
	const stdlib = stdlibPrelude()
	const prelude = [...stdlib, ...protocolPreludeNamespaces([program], stdlib)]

	return withEmission(
		{
			spellings: new Map(),
			target: BUNDLE_TARGET,
			providedMembers: providedMemberIdentifiers(prelude),
		},
		() => rewriteLoneProgram(program, prelude),
	)
}

function rewriteLoneProgram(
	program: common.typedSimple.Program,
	prelude: Array<PreludeNamespace>,
): string {
	// The Program is rewritten first, so reachability reads the finished
	// tree. See "A lone Program and a graph" in DEVELOPMENT.md.
	const freeFunctions = stdlibFreeFunctions()
	// One pool for the whole file, shared by the prelude and the Program.
	const { value: rewritten, pool } = collectingConstantPool(() => {
		let implementation = rewriteImplementationSection(
			program.implementation,
		)
		// Tests share the pool and the reachability of the implementation.
		let tests =
			program.tests === null ? [] : rewriteTestsSection(program.tests)

		return {
			implementation,
			tests,
			essenceMembers: reachableEssenceMethods(
				prelude,
				[...implementation, ...tests],
				freeFunctions,
				[...pooledConstants.values()],
			),
		}
	})
	const bands = essenceMemberBands(rewritten.essenceMembers)
	const constantPool = constantPoolBand(
		pool,
		[
			bands.functions,
			bands.values,
			rewritten.implementation,
			rewritten.tests,
		],
		rewritten.implementation,
	)
	const essenceMembers = rewritten.essenceMembers

	const rewrittenProgram: estree.Program = {
		type: "Program",
		sourceType: "module",
		body: [
			// See "Module layout" in DEVELOPMENT.md.
			...runtimeImports(lonelyRuntimeNames(program)),
			...(program.coverage === null
				? []
				: coverageHead(program.coverage, null)),
			...bands.functions,
			...constantPool,
			...bands.values,
			...rewritten.implementation,
			...rewritten.tests,
			...(program.tests === null ? [] : [testEntryPointsExport()]),
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

// The Essence text of every Module a `loc.source` can name, keyed by
// canonical path. See "Source maps" in DEVELOPMENT.md.
export type SourceMapOptions = {
	sourceTexts: ReadonlyMap<string, string>
}

// The shape `sourceMapWithCode` answers with. The escodegen fork's
// declarations omit this mode and this shape, so the call is cast.
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

// The map rides inside the module's text, since esbuild composes an inline
// map a plugin serves. See "Source maps" in DEVELOPMENT.md.
function sourceMapComment(map: object): string {
	let encoded = Buffer.from(JSON.stringify(map)).toString("base64")

	return `//# sourceMappingURL=data:application/json;base64,${encoded}`
}

// One Module of a bundle: its canonical path, which its Choices take their
// identity from, and its Program.
export type ModuleInput = {
	filePath: string
	program: common.typedSimple.Program
	// The Module's Essence source, read only for a source map.
	sourceText?: string
}

// A whole graph of Modules, emitted as one bundle's worth of JavaScript with
// a shared prelude Module. See "A lone Program and a graph" in DEVELOPMENT.md.
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

	// A Module declares its own Protocols' provided Methods, so the prelude
	// holds the standard library alone. See "Provided Methods in a graph" in
	// DEVELOPMENT.md.
	let prelude = stdlibPrelude()
	let { protocols, providedMembers, homes } = graphProvidedMethods(
		modules,
		prelude,
	)

	return withEmission({ spellings, target, providedMembers }, () => {
		let freeFunctions = stdlibFreeFunctions()
		// A pool per Module, since a Module's names are not in scope in
		// another. It is built first, because its constants' reads decide the
		// Module's imports.
		let bodies = modules.map((module) => {
			let { value: body, pool } = collectingConstantPool(() =>
				withSourcePath(module.filePath, () => [
					...providedMethodDeclarations(
						protocols.get(module.filePath)!,
						providedMembers,
						withoutConstantPool,
					),
					...rewriteImplementationSection(
						module.program.implementation,
					),
					// Tests share the Module's pool.
					...(module.program.tests === null
						? []
						: rewriteTestsSection(module.program.tests)),
				]),
			)

			let band = constantPoolBand(pool, body, body)
			let imports = providedMethodImports(
				referencedNames([body, band]),
				module.filePath,
				homes,
			)

			return { module, body, pool: band, imports }
		})
		let exported = providedMethodExports(
			homes,
			bodies.map(({ imports }) => imports),
		)

		let { value: essenceMembers, pool: preludePool } =
			collectingConstantPool(() =>
				reachableEssenceMethods(
					prelude,
					bodies.flatMap((rewritten) => rewritten.body),
					freeFunctions,
					bodies.map((rewritten) => rewritten.pool),
					// A host's prelude holds the whole standard library. See
					// "Emit targets" in DEVELOPMENT.md.
					target.mode === "host" ? "whole" : "reached",
				),
			)

		let declared = new Set(essenceMembers.keys())
		// A provided Method is declared by one Module and imported by the rest.
		let reachable = new Set([...declared, ...homes.keys()])
		let sources = new Map<string, string>()
		let preludeProgram = preludeModule(essenceMembers, preludePool)

		checkEssenceMethodsAreDeclared(preludeProgram, declared)
		sources.set(PRELUDE_SPECIFIER, generateProgram(preludeProgram))

		// The entry exports the test entry points whenever any Module has
		// tests, because a bundle exports what its entry exports.
		let testRegistry = modules.some(
			(module) => module.program.tests !== null,
		)

		for (let { module, body, pool, imports } of bodies) {
			let provides = exported.get(module.filePath) ?? []
			let published = [
				...moduleExports(module.program, spellings),
				...(provides.length === 0
					? []
					: [namedExport(provides.map((name) => [name, name]))]),
				...(testRegistry && module.filePath === entryPath
					? [testEntryPointsExport()]
					: []),
			]
			// Built before `referencedNames`, because the coverage head names
			// `$testing`.
			let head =
				module.program.coverage === null
					? []
					: coverageHead(
							module.program.coverage,
							module.filePath,
							protocols.get(module.filePath)!.length > 0,
						)
			let names = referencedNames([body, pool, published, head])
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
					...[...imports].map(([home, imported]) =>
						namedImport(
							imported.map((name) => [name, name]),
							moduleSpecifier(spellings.get(home)!),
						),
					),
					// Above everything else, so a top-level Statement's counter
					// finds its name bound.
					...head,
					...pool,
					...body,
					...published,
				],
			}

			checkEssenceMethodsAreDeclared(moduleProgram, reachable)
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

// The shared prelude as its own Module, exporting every const it holds.
// See "A lone Program and a graph" in DEVELOPMENT.md.
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

// The runtime modules emitted code reads under an alias of the compiler's own
// rather than as a builtin Namespace.
const runtimeModuleAliases = [
	["$_", "functions"],
	["$type", "type"],
	["$helpers", "internalHelpers"],
	// The test runtime, which only a test or coverage compile names.
	["$testing", "Testing"],
	// Also the `Future` Namespace's runtime module. `start` and `complete`
	// emit through this alias.
	["$future", "Future"],
] as const

// What a lone Program's head imports: every runtime module, and the test
// runtime when the Program has tests or coverage.
function lonelyRuntimeNames(program: common.typedSimple.Program): Set<string> {
	let names = allRuntimeNames()

	if (program.tests !== null || program.coverage !== null) {
		names.add(TESTING_MODULE)
	}

	return names
}

// Every runtime module but the test runtime, whose import would claim the
// Program has tests. See "Runtime imports" in DEVELOPMENT.md.
function allRuntimeNames(): Set<string> {
	return new Set([
		...runtimeNamespaceNames,
		...runtimeModuleAliases
			.map(([name]) => name)
			.filter((name) => name !== TESTING_MODULE),
	])
}

// The `import * as <Name>` head of one emitted module, for the runtime
// modules `names` mentions.
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

// What one Module imports from the others, grouped per Module in source
// order. A dependency that binds nothing still gets a bare `import "…"`, so it
// runs first. See "Module layout" in DEVELOPMENT.md.
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

	// A re-exported Module is a dependency too.
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

// What one Module publishes, under the names its export block gave. A
// re-export forwards straight from the Module it names, and an erased name
// publishes nothing.
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

// What is being emitted, for emission sites too deep to be handed it: the
// graph's Module spellings and their target. Empty and `bundle` outside
// `rewriteModules`.
type Emission = {
	spellings: ReadonlyMap<string, string>
	target: EmitTarget
	providedMembers: ProvidedMemberIdentifiers
}

let emission: Emission = {
	spellings: new Map(),
	target: BUNDLE_TARGET,
	providedMembers: new Map(),
}

// Restored in `finally`, so a throw out of one bundle can not leave the next
// rendering its tags against another graph.
function withEmission<Value>(next: Emission, emit: () => Value): Value {
	let outer = emission

	emission = next

	try {
		return emit()
	} finally {
		emission = outer
	}
}

// The canonical path of the Module being emitted, which a node's `loc`
// names. Null outside a Module's pass in `rewriteModules`, so nothing is mapped.
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

// Emits code the compiler writes of its own accord without a mapping.
function unmapped<Value>(emit: () => Value): Value {
	return withSourcePath(null, emit)
}

// An Essence Position counts columns from 1, estree from 0. Undefined for a
// node with no Position or outside a Module's pass, which leaves it unmapped.
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

// One nominal identity as the emitted Modules spell it, with the declaring
// Module's path replaced by its spelling. See "Case tags and identities" in
// DEVELOPMENT.md.
function renderIdentity(text: string): string {
	for (let [modulePath, spelling] of emission.spellings) {
		if (text.startsWith(`${modulePath}#`)) {
			return `${spelling}${text.slice(modulePath.length)}`
		}
	}

	return text
}

// `renderIdentity` for a caller with one identity and no graph, such as a
// host building a Case value. See "Case tags and identities" in
// DEVELOPMENT.md.
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
	// The outermost block a user Namespace can be declared in is a Scope like
	// every inner block.
	return withNamespaceScope(() =>
		implementation.nodes.flatMap((node) => rewriteStatements(node)),
	)
}

// #region Statements

// One Statement in, its emitted Statements out, each carrying the node's
// Position. An intrinsic Statement and a looped Function's turn emit several.
function rewriteStatements(
	node: common.typedSimple.ImplementationNode,
): Array<estree.Statement> {
	let statements =
		node.nodeType === "IntrinsicStatement"
			? rewriteIntrinsicStatement(node)
			: node.nodeType === "TailCallStatement"
				? rewriteTailCallStatement(node)
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
		| common.typedSimple.IntrinsicStatementNode
		| common.typedSimple.TailCallStatementNode
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
		case "TestAssertionStatement":
			return rewriteTestAssertion(node)
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
	// Declared before the body, because a Namespace is in scope inside its own
	// Methods: `quadrupledValue` calling `@::doubledValue()` names this class.
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

// One bodied standard library Method as its own top-level const, named as
// the Simplifier mangled it:
//
//   const $es_Boolean_isNot = function (_self, other) { … }
//
// `builtins.spec.ts` fails a bodied Method that the runtime also exports.
function rewriteEssenceMember(
	name: string,
	method: common.typedSimple.Method,
): estree.VariableDeclaration {
	return {
		type: "VariableDeclaration",
		kind: "const",
		declarations: [
			{
				type: "VariableDeclarator",
				id: { type: "Identifier", name },
				init: rewriteFunctionExpression(method.method.value),
			},
		],
	}
}

// The frame a native Method's default is evaluated in, as its own const:
//
//   const $es_String_trim = (_self, side = $type.createCase("Side#BothEnds")) =>
//       String.trim(_self, side)
//
// It passes every Parameter on, so the native's contract is unchanged. The
// callee is spelled by hand, since `namespaceMember` would answer with the shim.
function rewriteNativeShim(
	namespaceName: string,
	shim: common.typedSimple.NativeShimNode,
): estree.VariableDeclaration {
	let native = memberRead(
		{ type: "Identifier", name: namespaceIdentifierName(namespaceName) },
		isBuiltinNamespaceReference(namespaceName)
			? shim.memberName
			: namespaceMemberName(shim.memberName),
	)

	let call: estree.CallExpression = {
		type: "CallExpression",
		optional: false,
		callee: native,
		arguments: shim.parameters.map((parameter) =>
			rewriteIdentifier(parameter.internalName),
		),
	}

	return {
		type: "VariableDeclaration",
		kind: "const",
		declarations: [
			{
				type: "VariableDeclarator",
				id: {
					type: "Identifier",
					name: essenceMethodIdentifier(
						namespaceName,
						shim.memberName,
					),
				},
				init: {
					type: "ArrowFunctionExpression",
					// A block only where a Record default is merged in first.
					expression: shim.prologue.length === 0,
					params: shim.parameters.map((parameter) =>
						rewriteParameter(parameter),
					),
					body:
						shim.prologue.length === 0
							? call
							: {
									type: "BlockStatement",
									body: [
										...shim.prologue.flatMap((statement) =>
											rewriteStatements(statement),
										),
										{
											type: "ReturnStatement",
											argument: call,
										},
									],
								},
				},
			},
		],
	}
}

// One standard library static Property with a value, as its own const in
// the value band. `static EMPTY: String = ""` becomes:
//
//   const $es_String_EMPTY = String.createString("")
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

// The `$es_` consts a body names, which reachability follows, and the subset
// it needs as soon as it runs. See "Prelude emission order" in DEVELOPMENT.md.
export type EssenceMemberReferences = {
	references: Set<string>
	evaluatedReferences: Set<string>
}

// One member the emitted Program needs, with the kind that picks its band.
// The kind can not be read off the declaration.
export type EssenceMember = {
	kind: "function" | "value"
	declaration: estree.VariableDeclaration | estree.FunctionDeclaration
} & EssenceMemberReferences

// The bands of `essenceMemberBands` as one list, for the tests.
export function orderEssenceMembers(
	members: Map<string, EssenceMember>,
): Array<estree.VariableDeclaration | estree.FunctionDeclaration> {
	let bands = essenceMemberBands(members)

	return [...bands.functions, ...bands.values]
}

// The reached members in emission order: Function-valued members in
// discovery order, then static Properties ordered by what they read. Returned
// apart, since the pool stands between them. See "Prelude emission order" in
// DEVELOPMENT.md.
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

	// The Properties a Function reads once called, each with the chain of
	// Functions leading to it. Breadth first, so an error names the shortest
	// chain.
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

	// The Properties a Property's value reads before its const is bound, each
	// with the Functions it was reached through. A reference only handed on is
	// not a read.
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

// One constant the emitted module builds once. `marker` is a placeholder
// until `constantPoolBand` names the survivors. See "The constant pool" in
// DEVELOPMENT.md.
type PooledConstant = { marker: string; value: estree.Expression }

// Module state, because a pooled reference is emitted deep inside expression
// rewriting.
let pooledConstants = new Map<string, PooledConstant>()

// Unset while a graph's provided Method is emitted, which may run before its
// Module does. See "Provided Methods in a graph" in DEVELOPMENT.md.
let poolingConstants = true

function withoutConstantPool(
	method: common.typedSimple.Method,
): estree.FunctionExpression {
	let outer = poolingConstants

	poolingConstants = false

	try {
		return rewriteFunctionExpression(method.method.value)
	} finally {
		poolingConstants = outer
	}
}

// One pool per emitted module, since a name declared in one module is not in
// scope in another.
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

// No Essence identifier contains `_`, so neither prefix collides with a
// user's name, and `at` keeps a marker apart from a finished name.
const POOL_MARKER_PREFIX = "$pool_at_"
const POOL_NAME_PREFIX = "$pool_"

function pooledReference(
	node: common.typedSimple.PooledReferenceNode,
): estree.Expression {
	if (!poolingConstants) {
		return rewriteExpression(node.value)
	}

	let known = pooledConstants.get(node.key)

	if (known === undefined) {
		// Rewritten at module scope, before recording and unmapped. See
		// "The constant pool" in DEVELOPMENT.md.
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

// The band, in recording order, of the constants whose markers survive in
// `roots`, and what those read. Renames every marker in place.
function constantPoolBand(
	pool: Map<string, PooledConstant>,
	roots: unknown,
	// The module's own Statements, into which `deferredPoolPositions`'
	// constants are spliced in place, so `roots` still reaches them. Null for
	// the prelude Module.
	body: Array<estree.ModuleDeclaration | estree.Statement> | null = null,
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
	let deferred = deferredPoolPositions(constants, used, body)
	let deferredBands = new Map<number, Array<estree.VariableDeclaration>>()

	for (let constant of constants) {
		if (!used.has(constant.marker)) {
			continue
		}

		let name = `${POOL_NAME_PREFIX}${names.size}`

		names.set(constant.marker, name)

		let declaration: estree.VariableDeclaration = {
			type: "VariableDeclaration",
			kind: "const",
			declarations: [
				{
					type: "VariableDeclarator",
					id: { type: "Identifier", name },
					init: constant.value,
				},
			],
		}

		let after = deferred.get(constant.marker)

		if (after === undefined) {
			band.push(declaration)

			continue
		}

		let standing = deferredBands.get(after)

		if (standing === undefined) {
			standing = []
			deferredBands.set(after, standing)
		}

		standing.push(declaration)
	}

	// Back to front, so each index still names its Statement when spliced.
	if (body !== null) {
		for (let index of [...deferredBands.keys()].sort((a, b) => b - a)) {
			body.splice(index + 1, 0, ...deferredBands.get(index)!)
		}
	}

	renamePooledReferences(roots, names)
	renamePooledReferences(band, names)

	return band
}

// The constants that read a top-level declaration of the module, each with
// the index of the Statement it must follow. See "The constant pool" in
// DEVELOPMENT.md.
function deferredPoolPositions(
	constants: Array<PooledConstant>,
	used: ReadonlySet<string>,
	body: Array<estree.ModuleDeclaration | estree.Statement> | null,
): Map<string, number> {
	let deferred = new Map<string, number>()

	if (body === null) {
		return deferred
	}

	let declaredAt = topLevelDeclarationIndices(body)

	if (declaredAt.size === 0) {
		return deferred
	}

	for (let constant of constants) {
		if (!used.has(constant.marker)) {
			continue
		}

		let below: number | null = null

		for (let name of referencedNames(constant.value)) {
			let index = declaredAt.get(name) ?? deferred.get(name) ?? null

			if (index !== null && (below === null || index > below)) {
				below = index
			}
		}

		if (below !== null) {
			deferred.set(constant.marker, below)
		}
	}

	return deferred
}

// The names each top-level Statement of the emitted module binds, by index,
// read off the emitted JavaScript.
function topLevelDeclarationIndices(
	body: Array<estree.ModuleDeclaration | estree.Statement>,
): Map<string, number> {
	let declaredAt = new Map<string, number>()

	for (let [index, statement] of body.entries()) {
		if (statement.type === "VariableDeclaration") {
			for (let declarator of statement.declarations) {
				if (declarator.id.type === "Identifier") {
					declaredAt.set(declarator.id.name, index)
				}
			}
		} else if (
			(statement.type === "FunctionDeclaration" ||
				statement.type === "ClassDeclaration") &&
			statement.id !== null
		) {
			declaredAt.set(statement.id.name, index)
		}
	}

	return declaredAt
}

// Replaces the markers with the band's names, in place. Only a pool reference
// can match a marker, so every Identifier is checked.
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

export type PreludeReach = "reached" | "whole"

// The prelude consts the emitted code needs, found by a fixed point over the
// candidates' own references. See "Prelude reachability" in DEVELOPMENT.md.
export function reachableEssenceMethods(
	prelude: Array<PreludeNamespace>,
	implementation: Array<estree.ModuleDeclaration | estree.Statement>,
	freeFunctions: Array<PreludeFreeFunction> = [],
	// The pooled constants collected so far, whose values hold `$es_`
	// references the module's body no longer does.
	poolRoots: unknown = null,
	// `whole` keeps every candidate, for a host's build. See "Emit targets"
	// in DEVELOPMENT.md.
	reach: PreludeReach = "reached",
): Map<string, EssenceMember> {
	let reachable = new Map<string, EssenceMember>()

	if (prelude.length === 0 && freeFunctions.length === 0) {
		return reachable
	}

	// Protocols and Namespaces are separate tables, so a Protocol spelled
	// like a Namespace can not draw the other's edge.
	let protocols = prelude.filter((entry) => entry.protocol === true)
	let namespaces = prelude.filter((entry) => entry.protocol !== true)
	let provided = providedMemberIdentifiers(protocols)

	// The bodied Methods, the only Methods an edge can reach.
	let implemented = new Set(
		namespaces.flatMap((namespace) =>
			Object.keys(namespace.node.methods).map(
				(memberName) => `${namespace.name} ${memberName}`,
			),
		),
	)

	// The bodied free Functions, by the mangled name a call site resolves to.
	let implementedFreeFunctions = new Set(
		freeFunctions.map((freeFunction) => freeFunction.name),
	)

	// The natives with a shim, reached by a call that leaves an Argument out.
	let shimmed = new Set(
		namespaces.flatMap((namespace) =>
			namespace.node.nativeShims.map(
				(shim) => `${namespace.name} ${shim.memberName}`,
			),
		),
	)

	// The shims that merge a Record default, which every call reaches.
	let mergingShimmed = new Set(
		namespaces.flatMap((namespace) =>
			namespace.node.nativeShims
				.filter((shim) => shim.prologue.length > 0)
				.map((shim) => `${namespace.name} ${shim.memberName}`),
		),
	)

	// The static Properties with a value. A Property read looks like a static
	// Method reference, so which table answers tells them apart.
	let implementedProperties = new Set(
		namespaces.flatMap((namespace) =>
			Object.keys(namespace.node.properties).map(
				(memberName) => `${namespace.name} ${memberName}`,
			),
		),
	)

	// Each candidate's edges come from its typed body, not its emitted const.
	// See "Prelude reachability" in DEVELOPMENT.md.
	let methodCandidates: Array<[string, EssenceMember]> = namespaces.flatMap(
		(namespace) =>
			Object.entries(namespace.node.methods).map(
				([memberName, method]): [string, EssenceMember] => [
					essenceMethodIdentifier(namespace.name, memberName),
					{
						kind: "function",
						declaration: rewriteEssenceMember(
							essenceMethodIdentifier(namespace.name, memberName),
							method,
						),
						...essenceMethodReferences(
							method.method.value,
							implemented,
							implementedFreeFunctions,
							implementedProperties,
							shimmed,
							provided,
							mergingShimmed,
						),
					},
				],
			),
	)

	// A static Property with a value belongs in the value band.
	let propertyCandidates: Array<[string, EssenceMember]> = namespaces.flatMap(
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
							shimmed,
							provided,
							mergingShimmed,
						),
					},
				],
			),
	)

	// A bodied free Function shares the fixed point, since edges cross
	// between kinds.
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
					shimmed,
					provided,
					mergingShimmed,
				),
			},
		])

	// A native shim, whose edges are whatever its defaults reach.
	let shimCandidates: Array<[string, EssenceMember]> = namespaces.flatMap(
		(namespace) =>
			namespace.node.nativeShims.map((shim): [string, EssenceMember] => [
				essenceMethodIdentifier(namespace.name, shim.memberName),
				{
					kind: "function",
					declaration: rewriteNativeShim(namespace.name, shim),
					...essenceMethodReferences(
						// A Record default stands in the prologue instead.
						[shim.parameters, shim.prologue],
						implemented,
						implementedFreeFunctions,
						implementedProperties,
						shimmed,
						provided,
						mergingShimmed,
					),
				},
			]),
	)

	// A Protocol's provided Methods, under their names from `provided`.
	let protocolCandidates: Array<[string, EssenceMember]> = protocols.flatMap(
		(protocol) =>
			Object.entries(protocol.node.methods).map(
				([memberName, method]): [string, EssenceMember] => [
					provided
						.get(protocolEntryIdentity(protocol))!
						.get(memberName)!,
					{
						kind: "function",
						declaration: rewriteEssenceMember(
							provided
								.get(protocolEntryIdentity(protocol))!
								.get(memberName)!,
							method,
						),
						...essenceMethodReferences(
							method.method.value,
							implemented,
							implementedFreeFunctions,
							implementedProperties,
							shimmed,
							provided,
							mergingShimmed,
						),
					},
				],
			),
	)

	let candidates = new Map<string, EssenceMember>([
		...methodCandidates,
		...protocolCandidates,
		...propertyCandidates,
		...freeFunctionCandidates,
		...shimCandidates,
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

	// Seeded from the names the emitted code holds, or under `whole` with
	// every candidate, in candidate order.
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

// The prelude consts a typed body names, and which of them it evaluates.
// INVARIANT: it recognises every shape `namespaceMember` emits as a `$es_`
// Identifier. See "Prelude reachability" in DEVELOPMENT.md.
export function essenceMethodReferences(
	root: unknown,
	implemented: Set<string>,
	implementedFreeFunctions: Set<string> = new Set(),
	implementedProperties: Set<string> = new Set(),
	// The natives with a shim, asked only where a call left an Argument out.
	shimmed: Set<string> = new Set(),
	// The consts of Protocols' provided Methods, asked only where
	// `providedBy` says a Protocol answered.
	provided: ProvidedMemberIdentifiers = new Map(),
	// The natives whose shim merges a Record default, asked where a call
	// left nothing out.
	mergingShims: Set<string> = new Set(),
): EssenceMemberReferences {
	let references = new Set<string>()
	let evaluatedReferences = new Set<string>()

	let considerProvided = (
		protocolName: unknown,
		memberName: unknown,
	): void => {
		let name =
			typeof protocolName === "string" && typeof memberName === "string"
				? provided.get(protocolName)?.get(memberName)
				: undefined

		if (name !== undefined) {
			references.add(name)
			evaluatedReferences.add(name)
		}
	}

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

	// `isStored` is true where a Function reference is only handed on, and
	// false under any call, which may run it at once. See "Prelude
	// reachability" in DEVELOPMENT.md.
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
		let isUpdatingDictionary =
			record["nodeType"] === "Combination" &&
			isDictionaryUpdate(
				(record["lhs"] as { type?: common.Type } | undefined)?.type,
			)

		if (
			record["nodeType"] === "MethodInvocation" ||
			record["nodeType"] === "UnionMethodInvocation" ||
			record["nodeType"] === "FunctionInvocation" ||
			isUpdatingDictionary ||
			(record["nodeType"] === "Intrinsic" &&
				record["kind"] === "dispatch-chain") ||
			// An inlined loop runs its bodies, as the call it replaced did.
			record["kind"] === "inline-loop"
		) {
			isStored = false
		}

		if (record["nodeType"] === "MethodInvocation") {
			let base = record["base"] as Record<string, unknown> | undefined
			let member = record["member"] as Record<string, unknown> | undefined

			// The node, not the name, picks the table, as in `namespaceMember`.
			if (record["providedBy"] !== undefined) {
				considerProvided(record["providedBy"], member?.["name"])
			} else {
				consider(base?.["name"], member?.["name"], implemented, true)
			}

			if (record["omitsArguments"] === true) {
				consider(base?.["name"], member?.["name"], shimmed, true)
			} else {
				consider(base?.["name"], member?.["name"], mergingShims, true)
			}
		} else if (record["nodeType"] === "UnionMethodInvocation") {
			for (let dispatch of (record["cases"] as Array<
				Record<string, unknown>
			>) ?? []) {
				if (dispatch["providedBy"] !== undefined) {
					considerProvided(
						dispatch["providedBy"],
						dispatch["methodName"],
					)
				} else {
					consider(
						dispatch["namespaceName"],
						dispatch["methodName"],
						implemented,
						true,
					)
				}

				consider(
					dispatch["namespaceName"],
					dispatch["methodName"],
					(dispatch["omittedParameterIndices"] as Array<number>)
						?.length > 0
						? shimmed
						: mergingShims,
					true,
				)
			}
		} else if (record["nodeType"] === "Intrinsic") {
			// The optimiser's intrinsics draw the edges of the nodes they
			// replaced: `dispatch-chain` a Union dispatch's cases, `direct-method`
			// a devirtualised witness's Method, which its site calls.
			if (record["kind"] === "dispatch-chain") {
				for (let dispatchCase of (record["cases"] as Array<
					Record<string, unknown>
				>) ?? []) {
					if (dispatchCase["providedBy"] !== undefined) {
						considerProvided(
							dispatchCase["providedBy"],
							dispatchCase["methodName"],
						)
					} else {
						consider(
							dispatchCase["namespaceName"],
							dispatchCase["methodName"],
							implemented,
							true,
						)
					}

					consider(
						dispatchCase["namespaceName"],
						dispatchCase["methodName"],
						(
							dispatchCase[
								"omittedParameterIndices"
							] as Array<number>
						)?.length > 0
							? shimmed
							: mergingShims,
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
				consider(
					record["namespaceName"],
					record["memberName"],
					mergingShims,
					true,
				)
			}
		} else if (record["nodeType"] === "Lookup") {
			// A Namespace member only where the base's Type is a Namespace, or
			// the Lookup names one. A local named like a Namespace is a Record.
			let base = record["base"] as Record<string, unknown> | undefined
			let member = record["member"] as Record<string, unknown> | undefined
			let namespaceName =
				record["namespaceName"] ??
				(base?.["nodeType"] === "Identifier" &&
				(base["type"] as Record<string, unknown> | undefined)?.[
					"type"
				] === "Namespace"
					? base["name"]
					: undefined)

			if (namespaceName !== undefined) {
				// A provided member is the Protocol's const.
				if (record["providedBy"] !== undefined) {
					considerProvided(record["providedBy"], member?.["name"])
				} else {
					// A static Method is evaluated where called; a Property
					// wherever it is named.
					consider(
						namespaceName,
						member?.["name"],
						implemented,
						!isStored,
					)
					consider(
						namespaceName,
						member?.["name"],
						implementedProperties,
						true,
					)
					// A bare reference to a merging native is its shim too.
					consider(
						namespaceName,
						member?.["name"],
						mergingShims,
						!isStored,
					)
				}
			}
		} else if (isUpdatingDictionary) {
			let rhs = record["rhs"] as Record<string, unknown> | undefined
			let memberName =
				rhs?.["nodeType"] === "DictionaryValue"
					? dictionarySetName
					: dictionaryMergeName

			consider("Dictionary", memberName, implemented, true)
			consider("Dictionary", memberName, mergingShims, true)
		} else if (record["nodeType"] === "ConformanceValue") {
			let methodMap = record["methodMap"] as
				| Record<string, unknown>
				| undefined

			// A witness is called at full arity, so a merging shim counts.
			for (let namespaceMethodName of Object.values(methodMap ?? {})) {
				consider(
					record["namespaceName"],
					namespaceMethodName,
					implemented,
					!isStored,
				)
				consider(
					record["namespaceName"],
					namespaceMethodName,
					mergingShims,
					!isStored,
				)
			}

			// A provided Method is the shared const of the Protocol that wrote
			// it.
			let providedMethods = record["providedMethods"] as
				| Record<string, unknown>
				| undefined

			for (let [memberName, protocolName] of Object.entries(
				providedMethods ?? {},
			)) {
				considerProvided(protocolName, memberName)
			}
		} else if (record["nodeType"] === "FunctionInvocation") {
			// A bare free-Function call, already mangled, names its const by
			// that name when the Function is bodied.
			let callee = record["name"] as Record<string, unknown> | undefined

			if (
				callee?.["nodeType"] === "Identifier" &&
				typeof callee["name"] === "string" &&
				implementedFreeFunctions.has(callee["name"])
			) {
				references.add(callee["name"])
				evaluatedReferences.add(callee["name"])
			}

			// Only the call knows whether it left an Argument out, which sends
			// it to the shim.
			if (
				record["omitsArguments"] === true &&
				callee?.["nodeType"] === "Lookup"
			) {
				let base = callee["base"] as Record<string, unknown> | undefined
				let member = callee["member"] as
					| Record<string, unknown>
					| undefined

				consider(base?.["name"], member?.["name"], shimmed, true)
			}
		}

		// `type` and `position` hold no edge but most of the object graph.
		// See "Prelude reachability" in DEVELOPMENT.md.
		for (let [key, value] of Object.entries(record)) {
			if (key === "type" || key === "position") {
				continue
			}

			visit(value, isStored)
		}
	}

	visit(root, true)

	return { references, evaluatedReferences }
}

// Every Identifier in the tree, bindings included, but no non-computed member
// or key: `{ isNot: Boolean.isNot }` names only `Boolean`. Over-collecting is
// the safe direction.
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

// Throws when the finished tree names a `$es_` const that was not emitted.
// It reads the emitted JavaScript, while reachability reads typed bodies, so a
// shape `essenceMethodReferences` misses fails the compile instead of the run.
// It answers only for `$es_` names. A bodied free Function's const carries its
// bare name, which a user's Function may share, so a missed free-Function
// edge is not caught here.
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

// An Essence Boolean is an object, so the test reads its `value`, unless
// `unbox-conditions` left a raw JavaScript boolean.
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
		// A completing free Function answers with a Future, like a Method.
		body: completingBodyOf(node.value),
	}
}

// An Expression written for its effects. A call, an assignment or an `await`
// stands as it is. Any other value is bound in a block of its own. See
// "Discarded values" in DEVELOPMENT.md.
function discardedExpressionStatement(
	expression: estree.Expression,
): estree.Statement {
	// An `await` is a `complete` written for its effects; the wait is the
	// point.
	if (
		expression.type === "CallExpression" ||
		expression.type === "AssignmentExpression" ||
		expression.type === "AwaitExpression"
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

// A Function the compiler wraps around what JavaScript can not say in an
// Expression position, called at once. When its body awaits, the wrapper is
// made `async` and its call awaited. See "Awaiting through wrappers" in
// DEVELOPMENT.md.
function calledWrapper(
	callee: estree.FunctionExpression | estree.ArrowFunctionExpression,
	args: Array<estree.Expression>,
): estree.Expression {
	let call: estree.CallExpression = {
		type: "CallExpression",
		optional: false,
		callee,
		arguments: args,
	}

	if (!holdsAwait(callee.body)) {
		return call
	}

	callee.async = true

	return { type: "AwaitExpression", argument: call }
}

// Whether an `await` stands in this emitted JavaScript outside any Function
// of its own. It walks every field, so new node shapes need no listing.
function holdsAwait(node: unknown): boolean {
	if (Array.isArray(node)) {
		return node.some(holdsAwait)
	}

	if (node === null || typeof node !== "object") {
		return false
	}

	let type = (node as { type?: unknown }).type

	if (type === "AwaitExpression") {
		return true
	}

	if (
		type === "FunctionExpression" ||
		type === "ArrowFunctionExpression" ||
		type === "FunctionDeclaration"
	) {
		return false
	}

	return Object.values(node).some(holdsAwait)
}

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
		case "DictionaryValue":
			return rewriteDictionaryValue(node)
		case "Lookup":
			return rewriteLookup(node)
		case "Identifier":
			return rewriteIdentifier(node)
		case "Match":
			return rewriteMatch(node)
		case "Define":
			return rewriteDefine(node)
		case "ConformanceValue":
			return rewriteConformanceValue(node)
		case "CaseValue":
			return rewriteCaseValue(node)
		case "TestTrace":
			return rewriteTestTrace(node)
		case "CoverageCounter":
			return rewriteCoverageCounter(node)
		case "Start":
			return rewriteStart(node)
		case "Complete":
			return rewriteComplete(node)
		case "Intrinsic":
			return rewriteIntrinsic(node)
	}
}

// The Optimiser's intrinsics, each emitted as the JavaScript a runtime
// constructor or check would run, written out at the site.
function rewriteIntrinsic(
	node: common.typedSimple.IntrinsicNode,
): estree.Expression {
	switch (node.kind) {
		// The tag goes through `renderIdentity`, like every written tag. An
		// optional read answers `undefined` for a missing member, which is no
		// tag, so the test fails without throwing.
		case "tag-test":
			return {
				type: "BinaryExpression",
				operator: node.negated ? "!==" : "===",
				left: typeKeyRead(rewriteExpression(node.value), node.optional),
				right: { type: "Literal", value: renderIdentity(node.tag) },
			}
		// The general check, with the descriptor in an Expression position so
		// it can be pooled.
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
		// The `.value` of an Essence Boolean, where a raw operand belongs.
		case "raw-boolean":
			return memberRead(rewriteExpression(node.value), "value")
		case "raw-boolean-op":
			// `&&` and `||` may skip their right-hand side, unlike the call
			// they replace. `lower-scalar-operations` builds one only where
			// skipping changes nothing.
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
		// JavaScript's `<`, `>`, `<=` and `>=` order a number against a bigint
		// exactly, so either representation of an Integer compares unguarded.
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
		// Through `namespaceMember`, so a devirtualised Method is spelled as
		// its witness spelled it.
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
				// The payload is spread first and the tag written over its
				// `"Record"` brand, as `createCase` does.
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
			// The spread of the left-hand Record carries the Type key.
			return node.rhs === null
				? {
						type: "ObjectExpression",
						properties: [
							{
								type: "SpreadElement",
								argument: rewriteExpression(node.lhs),
							},
							...memberProperties(node.members),
						],
					}
				: projectedCombination(node.lhs, node.rhs, node.rhsMembers)
		// `options.retries ?? 3`, one member of a rebuilt Record default. `??`
		// rather than `||`, since `false` and `0` are values.
		case "member-or-default":
			return {
				type: "LogicalExpression",
				operator: "??",
				left: memberPathRead(
					rewriteExpression(node.base),
					node.path,
					node.optional,
				),
				right: rewriteExpression(node.fallback),
			}
		case "dispatch-chain":
			return dispatchChain(node)
		// The hole a call leaves for a defaulted Parameter followed by another
		// Argument. The callee's parameter default consumes it.
		case "omitted-argument":
			return omittedArgument()
		// A walk in an Expression position, wrapped in an arrow to hold its
		// `while`. In a Statement position it is an intrinsic Statement instead.
		case "inline-loop":
			return inlineLoopExpression(node)
		// `build-lists-in-place` puts a build only where an inlined walk
		// writes its answer, which never reaches this switch.
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

// A Union dispatch decided in place, one conditional per tested case:
//
//   value[$type.typeKeySymbol] === "Shape#Circle"
//     ? Shapes.area(value)
//     : Shapes.area(value)
//
// A case without a test is the answer from there on. Only a tested last case
// falls through to `$type.noDispatchCaseMatched()`.
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

	// Values the branches read more than once become an arrow's Parameters,
	// evaluated once and in order, since no `let` fits an Expression position.
	return calledWrapper(
		{
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
		node.temporaries.map((temporary) => rewriteExpression(temporary.value)),
	)
}

// One branch's call: the resolved Method, given the receiver, the shared
// Arguments with this branch's overrides, and this branch's witnesses.
function dispatchCaseCall(
	node: common.typedSimple.DispatchChainNode,
	dispatchCase: common.typedSimple.DispatchChainCase,
): estree.CallExpression {
	let values = [...node.arguments]

	for (let contextual of dispatchCase.contextualArguments) {
		values[contextual.index] = contextual.value
	}

	// Branches may leave out different Parameters, so each opens its own
	// holes, after the overrides.
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
			dispatchCase.omittedParameterIndices.length > 0,
			dispatchCase.providedBy,
			undefined,
			dispatchCase.derivedMembers,
		),
		arguments: openOmittedArguments(
			[receiver],
			written,
			dispatchCase.omittedParameterIndices,
			conformances,
		),
	}
}

// `void 0` rather than `undefined`, which a Program may bind:
// `constant undefined = 99` is legal Essence.
function omittedArgument(): estree.UnaryExpression {
	return {
		type: "UnaryExpression",
		operator: "void",
		prefix: true,
		argument: { type: "Literal", value: 0 },
	}
}

// The Simplifier's `expandOmittedArguments` for a dispatch branch, whose
// Argument list is only assembled here.
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

// The runtime field a scalar wrapper holds its JavaScript value in.
function valueRead(object: estree.Expression): estree.MemberExpression {
	return memberRead(object, "value")
}

// `Number.MAX_SAFE_INTEGER` as a literal, because emitted code imports the
// language's `Number` Namespace over the global.
const SAFE_INTEGER = 9007199254740991

// Integers compare with `===`, which the canonical invariant makes exact.
// Strings go through the normalising runtime helper. See "Hybrid Integers" in
// DEVELOPMENT.md.
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

// `+`, `-` and `*` inline: both operands held as numbers and the answer in
// the safe range, or else the runtime's bigint path. See "Hybrid Integers" in
// DEVELOPMENT.md.
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

	// The guard reads each operand more than once, so an operand that can
	// not be repeated goes to the runtime whole.
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

// An Integer around a value already known to be canonical, built as the
// runtime's constructor would build it.
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

// The Integers walks build where they answer, by identity, so an enclosing
// walk can read the value without the box. See "Hybrid Integers" in
// DEVELOPMENT.md.
const exitBoxes = new WeakMap<estree.Expression, estree.Expression>()

function exitBox(value: estree.Expression): estree.Expression {
	let box = createdInteger(value)

	exitBoxes.set(box, value)

	return box
}

// One Integer-valued Expression read for the value it holds, through both
// arms of a guarded arithmetic. See "Hybrid Integers" in DEVELOPMENT.md.
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

// The value inside an Integer object `boxedInteger` wrote, or null.
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

	// `boxedInteger` wrote an Expression here, never a Pattern.
	return held.value as estree.Expression
}

// The runtime entry each operator escapes to, taking the two raw values.
const escapedArithmetic: Record<"+" | "-" | "*", string> = {
	"+": "sum",
	"-": "difference",
	"*": "product",
}

// Which representation an Integer's value is in, asked with `typeof`.
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

// A number as a literal. The emitter refuses a negative literal, so a
// negative value is written as a negation.
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

// Whether an emitted Expression may be written more than once. Emitted values
// have no accessors, so a literal, a name or member reads over one may.
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

// The hidden Type key every runtime value carries. It is a Symbol, so
// `Object.keys` does not see it.
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

// The Type key read off a value. `optional` reads `?.[…]`, for a member an
// open Record Matcher names that may be missing; ESTree wraps it in a
// `ChainExpression`.
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

// Member names go through `memberKey`, like every emitted Record member.
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

// A Case is its payload Record with the tag on the hidden Type key, so
// `@.left` reads the payload directly.
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

// Whether this is an `Equatable` witness, fulfilling exactly `is` and
// `isNot`, of a Namespace on the structural lists in `helpers/conformance.ts`.
// A conditional one needs the conditional list: `boundConformance` keeps the
// brand wherever every condition is structural, which is right only for those
// Namespaces. A shadowing user Namespace never counts.
function isStructurallyEquatable(
	node: common.typedSimple.ConformanceValueNode,
): boolean {
	let named =
		node.conditions.length > 0
			? conditionallyStructuralNamespaces.has(node.namespaceName)
			: structurallyEquatableNamespaces.has(node.namespaceName)

	if (!named || isShadowingUserNamespace(node.namespaceName)) {
		return false
	}

	let fulfilled = new Set([
		...Object.keys(node.methodMap),
		...Object.keys(node.providedMethods ?? {}),
	])

	return fulfilled.size === 2 && fulfilled.has("is") && fulfilled.has("isNot")
}

// A witness key, spelled by `namespaceMemberName` like every read of one.
function witnessKey(methodName: string): estree.Identifier | estree.Literal {
	return memberKey(namespaceMemberName(methodName))
}

// A witness maps each Protocol Method's name onto the conformer's Method,
// as in `{ compare: Integer.compare, … }`.
function rewriteConformanceValue(
	node: common.typedSimple.ConformanceValueNode,
): estree.ObjectExpression | estree.CallExpression {
	if (node.providedWitnesses !== undefined) {
		return rewriteWitnessGroup(node, node.providedWitnesses)
	}

	let witness = rewriteWitnessMethods(node)
	let provided = Object.entries(node.providedMethods ?? {})

	if (provided.length === 0) {
		return witness
	}

	// Outside `boundConformance`: a provided const takes only `Self`'s
	// witness, while the conditions belong to the Methods the Namespace wrote.
	return {
		type: "CallExpression",
		optional: false,
		callee: {
			type: "MemberExpression",
			optional: false,
			object: { type: "Identifier", name: "$type" },
			property: { type: "Identifier", name: "providedConformance" },
			computed: false,
		},
		arguments: [
			witness,
			{
				type: "ObjectExpression",
				properties: provided.map(
					([memberName, protocolName]): estree.Property => ({
						type: "Property",
						key: witnessKey(memberName),
						value: {
							type: "Identifier",
							name: providedMemberIdentifier(
								protocolName,
								memberName,
							),
						},
						kind: "init",
						method: false,
						shorthand: false,
						computed: false,
					}),
				),
			},
		],
	}
}

// A conformer's witnesses, built in one call so each provided body names the
// witness it is curried with. Each condition is built once:
// `$type.providedConformances(methods, provided, conditions, curried, shared)`.
function rewriteWitnessGroup(
	node: common.typedSimple.ConformanceValueNode,
	others: Array<common.typedSimple.ConformanceValueNode>,
): estree.CallExpression {
	let group = [node, ...others]
	let conditions = [...node.conditions, ...(node.groupConditions ?? [])]

	return {
		type: "CallExpression",
		optional: false,
		callee: {
			type: "MemberExpression",
			optional: false,
			object: { type: "Identifier", name: "$type" },
			property: { type: "Identifier", name: "providedConformances" },
			computed: false,
		},
		arguments: [
			{
				type: "ArrayExpression",
				elements: group.map(witnessMethodMap),
			},
			{
				type: "ArrayExpression",
				elements: group.map(
					(member, index): estree.ObjectExpression => ({
						type: "ObjectExpression",
						properties: Object.entries(
							member.providedMethods ?? {},
						).map(
							([memberName, protocolName]): estree.Property => ({
								type: "Property",
								key: witnessKey(memberName),
								value: {
									type: "ArrayExpression",
									elements: [
										{
											type: "Identifier",
											name: providedMemberIdentifier(
												protocolName,
												memberName,
											),
										},
										{
											type: "Literal",
											value: curriedIndexOf(
												member,
												memberName,
												index,
											),
										},
									],
								},
								kind: "init",
								method: false,
								shorthand: false,
								computed: false,
							}),
						),
					}),
				),
			},
			...(conditions.length === 0
				? []
				: [
						{
							type: "ArrayExpression" as const,
							elements: conditions.map((condition) =>
								rewriteExpression(condition),
							),
						},
						{
							type: "ArrayExpression" as const,
							elements: group.map(
								(member, index): estree.ArrayExpression => ({
									type: "ArrayExpression",
									elements: (index === 0
										? node.conditions.map((_, at) => at)
										: (member.conditionIndices ?? [])
									).map((value) => ({
										type: "Literal",
										value,
									})),
								}),
							),
						},
					]),
			...(node.sharedConditions === undefined
				? []
				: [
						{
							type: "ArrayExpression" as const,
							elements: node.sharedConditions.map(
								(shared): estree.ArrayExpression => ({
									type: "ArrayExpression",
									elements: [
										{
											type: "Literal",
											value: shared.condition,
										},
										{
											type: "Literal",
											value: shared.witness,
										},
									],
								}),
							),
						},
					]),
		],
	}
}

// The witness a provided body is curried with, by its index in the group.
// `Object.hasOwn`, since a body named `toString` would read the prototype's.
function curriedIndexOf(
	member: common.typedSimple.ConformanceValueNode,
	memberName: string,
	own: number,
): number {
	return member.curriedWith !== undefined &&
		Object.hasOwn(member.curriedWith, memberName)
		? member.curriedWith[memberName]!
		: own
}

// The witness's own Methods, with the conditions curried on: everything
// but its provided bodies.
function rewriteWitnessMethods(
	node: common.typedSimple.ConformanceValueNode,
): estree.ObjectExpression | estree.CallExpression {
	let methodMap = witnessMethodMap(node)

	// A conditional witness is `$type.boundConformance(<map>, [<witnesses>])`,
	// which curries each condition on.
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

// The witness's own Methods as the object literal that maps them, before
// any condition is curried on.
function witnessMethodMap(
	node: common.typedSimple.ConformanceValueNode,
): estree.ObjectExpression {
	let methodMap: estree.ObjectExpression = {
		type: "ObjectExpression",
		properties: Object.entries(node.methodMap).map(
			([protocolMethodName, namespaceMethodName]): estree.Property => ({
				type: "Property",
				key: witnessKey(protocolMethodName),
				value: namespaceMember(
					node.namespaceName,
					namespaceMethodName,
					node.derivedDescriptor,
					false,
					undefined,
					node.derivedCases,
					node.derivedMembers,
				),
				kind: "init",
				method: false,
				shorthand: false,
				computed: false,
			}),
		),
	}

	// The `structural` brand lets a Dictionary encode keys into one Map lookup,
	// as `encodeKey` does; without it every lookup scans with `is`. It rides on
	// the map so `providedConformance` and `boundConformance` carry it.
	if (isStructurallyEquatable(node)) {
		methodMap.properties.push({
			type: "Property",
			key: memberKey("structural"),
			value: { type: "Literal", value: true },
			kind: "init",
			method: false,
			shorthand: false,
			computed: false,
		})
	}

	return methodMap
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

// A native free Function, read off the runtime `functions` module as
// `$_.<name>`.
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
	// A native free Function's callee is a bare, already mangled Identifier.
	let callee: estree.Expression =
		node.name.nodeType === "Identifier" &&
		nativeFreeFunctionNames().has(node.name.name)
			? functionsModuleMember(node.name.name)
			: calleeExpression(node)

	return {
		type: "CallExpression",
		optional: false,
		callee,
		arguments: node.arguments.map((arg) => rewriteArgument(arg)),
	}
}

// The callee of `Namespace.member(…)`. Only the call knows whether it left an
// Argument out, which decides between the native and its shim.
function calleeExpression(
	node: common.typedSimple.FunctionInvocationNode,
): estree.Expression {
	if (
		node.omitsArguments === true &&
		node.name.nodeType === "Lookup" &&
		node.name.base.nodeType === "Identifier" &&
		node.name.base.type.type === "Namespace"
	) {
		let callee = namespaceMember(
			node.name.base.name,
			node.name.member.name,
			undefined,
			true,
		)
		// Built outside `rewriteExpression`, so its `loc` is attached here, or
		// a debugger would step past the call.
		let loc = locOf(node.name.position)

		if (loc !== undefined) {
			callee.loc = loc
		}

		return callee
	}

	return rewriteExpression(node.name)
}

// The runtime helper each routed Record Method answers to. `isNot` is
// `Equatable`'s provided body, which reads the routed `is`.
const recordRoutingHelperNames: Record<string, string> = {
	is: "boundRecordIs",
	toString: "boundRecordToString",
}

// One reference to a Namespace member, for every emission site. See "Naming
// a Namespace member" in DEVELOPMENT.md.
function namespaceMember(
	namespaceName: string,
	memberName: string,
	derivedDescriptor?: common.DerivedEquatableDescriptor,
	// Set only where the call left an Argument out, which routes a native to
	// its shim.
	omitsArguments: boolean = false,
	// The Protocol that provided this Method, since a Namespace may share its
	// name.
	providedBy?: string,
	// The Case tags a derived `Enumerable::cases` is curried with.
	derivedCases?: Array<string>,
	// The declared member names a Record routes, in declaration order.
	derivedMembers?: Array<string>,
): estree.Expression {
	// Asked first, because every later question is asked by name.
	if (providedBy !== undefined) {
		return {
			type: "Identifier",
			name: providedMemberIdentifier(providedBy, memberName),
		}
	}

	// A Record routing members through their own conformances. The helper
	// is curried with the member names, and the member witnesses arrive as its
	// trailing Parameters.
	if (
		derivedMembers !== undefined &&
		namespaceName === "Record" &&
		!isShadowingUserNamespace(namespaceName)
	) {
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
					name: recordRoutingHelperNames[memberName] ?? memberName,
				},
			},
			arguments: [jsonExpression(derivedMembers)],
		}
	}

	// A Choice's derived equality names a Namespace that exists nowhere.
	if (namespaceName === derivedEquatableNamespaceName) {
		// A generic Choice's helper is curried with the descriptor its
		// payloads follow; the witnesses arrive as trailing Parameters.
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

	// Curried with the tags, since a static Method has no receiver.
	if (namespaceName === derivedEnumerableNamespaceName) {
		return {
			type: "CallExpression",
			optional: false,
			callee: {
				type: "MemberExpression",
				optional: false,
				computed: false,
				object: { type: "Identifier", name: "$helpers" },
				property: { type: "Identifier", name: "choiceCases" },
			},
			arguments: [jsonExpression(derivedCases ?? [])],
		}
	}

	// Every Case of such a Choice is payload-free, so the tag answers.
	if (namespaceName === derivedPrintableNamespaceName) {
		return {
			type: "MemberExpression",
			optional: false,
			computed: false,
			object: { type: "Identifier", name: "$helpers" },
			property: { type: "Identifier", name: "choiceName" },
		}
	}

	// A `$es_` const belongs to the standard library's Namespace, never to a
	// user Namespace that shadows its name.
	let essenceName = isShadowingUserNamespace(namespaceName)
		? null
		: (essenceMethodName(namespaceName, memberName) ??
			essencePropertyName(namespaceName, memberName))

	if (essenceName !== null) {
		return { type: "Identifier", name: essenceName }
	}

	// A call that left an Argument out needs the shim, and so does every call
	// of a native whose shim merges a Record default.
	if (!isShadowingUserNamespace(namespaceName)) {
		let shimName = omitsArguments
			? nativeShimName(namespaceName, memberName)
			: mergingNativeShimName(namespaceName, memberName)

		if (shimName !== null) {
			return { type: "Identifier", name: shimName }
		}
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
			node.omitsArguments === true,
			node.providedBy,
			undefined,
			node.derivedMembers,
		),
		arguments: node.arguments.map((arg) => rewriteArgument(arg)),
	}
}

// A Method Invocation on a Union-typed receiver, as `$type.dispatchMethod(
// receiver, [args…], [[descriptor, Namespace.method, [conformances…],
// [[index, argument], …]], …])`. It runs the first case whose descriptor
// accepts the receiver; the Enricher orders them most specific first.
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
								dispatchCase.omittedParameterIndices.length > 0,
								dispatchCase.providedBy,
								undefined,
								dispatchCase.derivedMembers,
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
							// The Parameters this branch leaves out, as a
							// fifth element, which needs the fourth in front.
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

// A dispatch branch's own Arguments, as `[index, argument]` pairs. The index
// does not count the receiver.
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

// `{ base with … }` as written, for when `collapse-combinations` is off. See
// "Record and Dictionary updates" in DEVELOPMENT.md.
function rewriteCombination(
	node: common.typedSimple.CombinationNode,
): estree.Expression {
	// The base's Type, without its Refinement, decides which update this is,
	// as in `enrichCombination`.
	if (isDictionaryUpdate(node.lhs.type)) {
		return rewriteDictionaryCombination(node)
	}

	if (!isRecordLiteral(node.rhs) && node.rhs.type.type === "Record") {
		return projectedCombination(
			node.lhs,
			node.rhs,
			Object.keys(node.rhs.type.members),
		)
	}

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

// Whether a Combination with a base of this Type is a Dictionary update.
// `essenceMethodReferences` asks it too, so its edges follow these calls.
function isDictionaryUpdate(lhsType: common.Type | undefined): boolean {
	let baseType = lhsType?.type === "Refinement" ? lhsType.base : lhsType

	return baseType?.type === "Dictionary"
}

// The Dictionary Methods an update is emitted as calls of. `merge`'s first
// entry is the one taking only `with`.
const dictionaryMergeName = "merge__overload$1"
const dictionarySetName = "set"

// A Dictionary update as calls: `set` over `set` for written entries, or
// `merge`. See "Record and Dictionary updates" in DEVELOPMENT.md.
function rewriteDictionaryCombination(
	node: common.typedSimple.CombinationNode,
): estree.Expression {
	// The base's key witness, rewritten per call so no two positions share a
	// node. `null` where the key Type is not yet decided.
	let witness = (): estree.Expression =>
		node.keyConformance === undefined
			? { type: "Literal", value: null }
			: rewriteExpression(node.keyConformance)

	if (node.rhs.nodeType !== "DictionaryValue") {
		return {
			type: "CallExpression",
			optional: false,
			callee: namespaceMember("Dictionary", dictionaryMergeName),
			arguments: [
				rewriteExpression(node.lhs),
				rewriteExpression(node.rhs),
				witness(),
			],
		}
	}

	let built = rewriteExpression(node.lhs)

	for (let entry of node.rhs.entries) {
		built = {
			type: "CallExpression",
			optional: false,
			callee: namespaceMember("Dictionary", dictionarySetName),
			arguments: [
				built,
				rewriteExpression(entry.key),
				rewriteExpression(entry.value),
				witness(),
			],
		}
	}

	return built
}

// A Record Literal, as a `RecordValue` or the `direct-record` that
// `collapse-construction` leaves.
function isRecordLiteral(node: common.typedSimple.ExpressionNode): boolean {
	return (
		node.nodeType === "RecordValue" ||
		(node.nodeType === "Intrinsic" && node.kind === "direct-record")
	)
}

// `{ base with update }` for a non-literal update: the base spread, then one
// read per member the update's Type declares. See "Record and Dictionary
// updates" in DEVELOPMENT.md.
function projectedCombination(
	lhs: common.typedSimple.ExpressionNode,
	rhs: common.typedSimple.ExpressionNode,
	rhsMembers: Array<string> | null,
): estree.Expression {
	if (rhsMembers === null) {
		throw new Error(
			"Internal Compiler Error: a Combination's right-hand side reached emission without the members its Type declares.",
		)
	}

	if (rhs.nodeType === "Identifier") {
		return combinedObject(
			rewriteExpression(lhs),
			rewriteIdentifier(rhs),
			rhsMembers,
		)
	}

	let lhsName: estree.Identifier = { type: "Identifier", name: "_lhs" }
	let rhsName: estree.Identifier = { type: "Identifier", name: "_rhs" }

	return calledWrapper(
		{
			type: "ArrowFunctionExpression",
			expression: true,
			params: [lhsName, rhsName],
			body: combinedObject(lhsName, rhsName, rhsMembers),
		},
		[rewriteExpression(lhs), rewriteExpression(rhs)],
	)
}

// `{ ...lhs, member: rhs.member, … }`, over operands that can be named twice.
// `memberKey` and `memberRead` quote a name like `ok?`.
function combinedObject(
	lhs: estree.Expression,
	rhs: estree.Expression,
	rhsMembers: Array<string>,
): estree.ObjectExpression {
	return {
		type: "ObjectExpression",
		properties: [
			{ type: "SpreadElement", argument: lhs },
			...rhsMembers.map(
				(name): estree.Property => ({
					type: "Property",
					key: memberKey(name),
					value: memberRead(rhs, name),
					kind: "init",
					computed: false,
					method: false,
					shorthand: false,
				}),
			),
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

// What renders one hole: `<witness>.toString`, or the Method itself where
// `devirtualise-witnesses` resolved it.
function holeRenderer(
	witness: common.typedSimple.ExpressionNode,
): estree.Expression {
	if (witness.nodeType === "Intrinsic" && witness.kind === "direct-method") {
		return rewriteExpression(witness)
	}

	return memberRead(rewriteExpression(witness), "toString")
}

// An interpolated String as `String.createString(<concat>)`, joining text
// runs and `<witness>.toString(<hole>).value` with `+`. `segments` always
// starts with a text run, so the fold starts from a string.
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

// The leading decimal digits, or `0`. The Lexer refuses any other number
// form, but `BigInt` would read `"0xFF"` as 255 and throw on `"FF"`.
function decimalDigits(value: string): string {
	let digits = /^-?[0-9]+/.exec(value)?.[0]

	return digits === undefined ? "0" : digits
}

// The literal in its canonical representation, so `createInteger` has
// nothing to convert.
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

// A written Dictionary as its pairs and its key witness. The empty one
// passes `null`, since `createDictionary` reads the witness only per pair.
function rewriteDictionaryValue(
	node: common.typedSimple.DictionaryValueNode,
): estree.CallExpression {
	return {
		type: "CallExpression",
		optional: false,
		callee: memberRead(
			{ type: "Identifier", name: "Dictionary" },
			"createDictionary",
		),
		arguments: [
			{
				type: "ArrayExpression",
				elements: node.entries.map((entry) => ({
					type: "ArrayExpression",
					elements: [
						rewriteExpression(entry.key),
						rewriteExpression(entry.value),
					],
				})),
			},
			node.keyConformance === null
				? { type: "Literal", value: null }
				: rewriteExpression(node.keyConformance),
		],
	}
}

// A static Method, a static Property or a Record member. The base's Type,
// not its spelling, says which, since a local Record may be named like a
// Namespace.
function rewriteLookup(node: common.typedSimple.LookupNode): estree.Expression {
	// A bounded Type Parameter's member reads its witness: `T.cases()` is
	// `T__conformance.cases()`.
	if (node.conformanceName !== undefined) {
		return memberRead(
			{ type: "Identifier", name: node.conformanceName },
			namespaceMemberName(node.member.name),
		)
	}

	// A derived `cases` is a member of no Namespace.
	if (node.derivedCases !== undefined) {
		return namespaceMember(
			derivedEnumerableNamespaceName,
			node.member.name,
			undefined,
			false,
			undefined,
			node.derivedCases,
		)
	}

	// A `cases` written in a Namespace of another name, reached through the
	// Choice.
	if (node.namespaceName !== undefined) {
		return namespaceMember(node.namespaceName, node.member.name)
	}

	// INVARIANT: an Identifier of a Namespace's Type is that Namespace's own
	// name. No Namespace is a value, so no other name can hold one.
	if (
		node.base.nodeType === "Identifier" &&
		node.base.type.type === "Namespace"
	) {
		return namespaceMember(
			node.base.name,
			node.member.name,
			undefined,
			false,
			node.providedBy,
		)
	}

	return memberRead(rewriteExpression(node.base), node.member.name)
}

// The builtin Namespaces, whose names are the module's `import * as <Name>`.
const runtimeNamespaceNameSet = new Set(runtimeNamespaceNames)

function rewriteIdentifier(
	node: common.typedSimple.IdentifierNode,
): estree.Identifier {
	return {
		type: "Identifier",
		name: escapeName(node.name),
	}
}

// Whether a Namespace name is the builtin import rather than a user's class.
// See "Shadowed Namespaces" in DEVELOPMENT.md.
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

// The compiler-owned names a user Namespace took, one set per emitted block,
// innermost last. See "Shadowed Namespaces" in DEVELOPMENT.md.
let shadowingNamespaceScopes: Array<Set<string>> = [new Set()]

// Popped in `finally`, so a throw can not leave the stack deeper for the
// next Program.
function withNamespaceScope<Value>(rewriteScope: () => Value): Value {
	shadowingNamespaceScopes.push(new Set())

	try {
		return rewriteScope()
	} finally {
		shadowingNamespaceScopes.pop()
	}
}

// Outside an emission the table is empty, and the first claimant's name
// is the only one there is.
function providedMemberIdentifier(
	identity: string,
	memberName: string,
): string {
	return (
		emission.providedMembers.get(identity)?.get(memberName) ??
		protocolMemberIdentifier(displayProtocolName(identity), memberName)
	)
}

function declareUserNamespace(namespaceName: string): void {
	if (compilerOwnedNames.has(namespaceName)) {
		shadowingNamespaceScopes.at(-1)!.add(namespaceName)
	}
}

function isShadowingUserNamespace(namespaceName: string): boolean {
	return shadowingNamespaceScopes.some((scope) => scope.has(namespaceName))
}

// A name in key or property position. A reserved word stays as it is, and a
// name JavaScript can not spell, such as `ok?`, becomes a string Literal.
function memberKey(name: string): estree.Identifier | estree.Literal {
	return isJavaScriptIdentifierName(name)
		? { type: "Identifier", name }
		: { type: "Literal", value: name }
}

// A class refuses a static member named `prototype` and a field named
// `constructor`, so a user Namespace's member of either name is mangled.
// Exported so a host's reads agree.
const forbiddenClassMemberNames = new Set(["prototype", "constructor"])

export function namespaceMemberName(name: string): string {
	return forbiddenClassMemberNames.has(name) ? mangleName(name) : name
}

// Shallower spines first, so `payload` is tested before `payload.origin`
// reads through it.
function shallowestFirst(spines: Array<string>): Array<string> {
	return [...spines].sort(
		(left, right) => left.split(".").length - right.split(".").length,
	)
}

// One member read, bracketed where the key had to become a Literal.
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

// `options?.server?.port`, a read into a Record-defaulted Argument. The first
// step is optional only where the whole Argument may be missing. One
// `ChainExpression` wraps the whole read, so `?.` short circuits all of it.
function memberPathRead(
	object: estree.Expression,
	path: ReadonlyArray<string>,
	optional: boolean,
): estree.Expression {
	let read = path.reduce<estree.Expression>(
		(base, name, step) => ({
			type: "MemberExpression",
			optional: step > 0 || optional,
			object: base,
			property: memberKey(name),
			computed: !isJavaScriptIdentifierName(name),
		}),
		object,
	)

	return optional || path.length > 1
		? {
				type: "ChainExpression",
				expression: read as estree.MemberExpression,
			}
		: read
}

function callIsValueOfType(
	value: estree.Expression,
	matcher: common.Type,
): estree.CallExpression {
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

// One Handler's test. See "Handler tests" in DEVELOPMENT.md.
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

	// The payload Pattern's member requirements, before any comparison reads
	// down a spine they establish.
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

	// Member comparisons, keyed by dotted spine, safe once the checks before
	// them passed.
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

// The `else` no Handler owns. See "The end of the chain" in DEVELOPMENT.md.
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

// The matched value's name, which `@` lowers to in a Handler. A fresh node
// each time, since a Position may be written onto one.
function selfIdentifier(): estree.Identifier {
	return { type: "Identifier", name: "_self" }
}

// The matched value's tag, read once for a chain that compares it twice or
// more. See "The bound tag" in DEVELOPMENT.md.
const selfTagName = "$self_tag"

// The Handler's own check where it compares the matched value's tag, or
// null.
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

// Bound from two tag tests, since one read is not worth a name.
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

// A Match's Handlers as an `if` chain, preceded by the tag binding when there
// is one. `bodyOf` writes a Handler's answer for the Expression or Statement
// form. See "Match emission" in DEVELOPMENT.md.
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

	// Only the tested Handlers count; an elided `else` reads no tag.
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

// A Match in an Expression position: a Function of `_self`, called with the
// matched value.
function rewriteMatch(node: common.typedSimple.MatchNode): estree.Expression {
	let value = selfIdentifier()

	return calledWrapper(
		{
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
		[rewriteExpression(node.value)],
	)
}

// A `define` as JavaScript conditionals:
//
//   score.value >= 90 ? "A" : score.value >= 80 ? "B" : "F"
//
// See "Define emission" in DEVELOPMENT.md.
function rewriteDefine(node: common.typedSimple.DefineNode): estree.Expression {
	let chain = rewriteExpression(node.otherwise)

	for (let index = node.arms.length - 1; index >= 0; index--) {
		let arm = node.arms[index]!
		let condition = rewriteExpression(arm.condition)

		chain = {
			type: "ConditionalExpression",
			test: arm.conditionIsRaw ? condition : valueRead(condition),
			consequent: rewriteExpression(arm.value),
			alternate: chain,
		}
	}

	return chain
}

// #endregion

// #region Lowered Statements

// A Match, compiled dispatch or inlined loop written as Statements. A
// declaration's `let` stands before the block. See "Lowered Statements" in
// DEVELOPMENT.md.
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
				// Every way out of the chain passes this assignment.
				resultStatement(result, loopIdentifier(heldAnswerName)),
			],
		},
	]
}

// No Essence name contains `_`. One per block is enough, since a nested
// lowered Statement writes only its own.
const heldAnswerName = "$held_answer"

// Whether a Handler binds the name the answer is written to, in the Scopes
// `redirectedStatements` writes answers into. See "The held answer" in
// DEVELOPMENT.md.
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
			// The Statements that bind a name in their block. A Type Alias and
			// a Protocol are emitted as nothing.
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

// Where a lowered Expression's answer goes, written as the Statement that
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
		// A name the compiler binds, emitted as it is.
		case "temporary":
			return loopAssignment(result.name, answer)
		// A Handler may answer with a value as well as a call.
		case "discard":
			return discardedExpressionStatement(answer)
	}
}

// Where an answer goes: a Statement position's result, or a compiler name.
type PlacedTarget =
	| common.typedSimple.StatementResult
	| { kind: "temporary"; name: string }

// A target may also be a writer, for an inlined loop's callback whose answer
// decides whether the walk goes on.
type RedirectTarget =
	| PlacedTarget
	| {
			kind: "answer"
			write: (
				answer: LoopAnswer,
				redirect: ReturnRedirect | null,
			) => Array<estree.Statement>
	  }

// One answer: the node it was written as, so `#Done(…)` is recognised where
// it is built, and its JavaScript. `node` is null for a nested loop's answer.
type LoopAnswer = {
	node: common.typedSimple.ExpressionNode | null
	value: () => estree.Expression
}

// One answer written to its target, then a `break` unless it is in tail
// position.
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

// Where a body's Returns are written instead of a JavaScript Return. It
// travels down nested lowered Statements with the outermost label. See
// "Redirected Returns" in DEVELOPMENT.md.
type ReturnRedirect = {
	result: RedirectTarget
	label: string
	// True where nothing follows the answer, so no `break` is needed.
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

// Where a lowered Statement's answer goes: the held name, else the outer
// redirect's target, else its own result.
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

// `{ const $dispatch_0 = …; return <the chain>; }`. The block keeps each
// chain's numbered names its own.
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

// A Match written as Statements, with `_self` naming the matched value for
// the length of the chain.
function statementMatch(
	node: common.typedSimple.StatementMatchNode,
	redirect: ReturnRedirect | null,
	held: PlacedTarget | null,
): estree.Statement {
	let result = placedResult(node, redirect, held)
	let label = redirect === null ? node.label : redirect.label
	let broke = false
	// A redirected Match breaks out of the outer Match's label, so the outer
	// Match hears of it.
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
							// A Handler's last Statement ends the chain, unless
							// this Match stands before the end of a redirected body.
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

	// The label is emitted only where something breaks out of it, and only by
	// the outermost Match.
	if (!broke || redirect !== null) {
		return body
	}

	return {
		type: "LabeledStatement",
		label: { type: "Identifier", name: label },
		body,
	}
}

// The chain with the matched value bound as `_self` in front of it, in as
// few blocks as needed. See "Binding the matched value" in DEVELOPMENT.md.
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

// A body with each of its own Returns written to the redirect's target. A
// nested Function's Returns are its own. See "Redirected Returns" in
// DEVELOPMENT.md.
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
			// One answering with a Return answers this Match; one answering a
			// name of its own stands as it is.
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

// A branch of a Conditional is in tail position exactly where the
// Conditional is.
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

// A walk written out: the Statements that run it, and the Expression that
// reads what it settled on.
type InlinedWalk = {
	statements: Array<estree.Statement>
	answer: estree.Expression
}

// A walk in an Expression position, as one arrow called at once.
function inlineLoopExpression(
	node: common.typedSimple.InlineLoopNode,
): estree.Expression {
	let walk = inlinedLoop(node)

	return calledWrapper(
		{
			type: "ArrowFunctionExpression",
			expression: false,
			params: [],
			body: loopBlock([
				...walk.statements,
				{ type: "ReturnStatement", argument: walk.answer },
			]),
		},
		[],
	)
}

// A walk in a Statement position, in a block, its answer written where the
// position says.
function inlineLoopStatement(
	node: common.typedSimple.InlineLoopStatementNode,
	redirect: ReturnRedirect | null,
	held: PlacedTarget | null,
): estree.Statement {
	let result = placedResult(node, redirect, held)
	let walk = inlinedLoop(node)

	return loopBlock([
		...walk.statements,
		// The answer is the name the walk settled in, with no node behind it,
		// so a writer reads its value.
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
		// These two build an Array already.
		case "map":
			return mapWalk(loop.name, loop.driver)
		case "keep":
			return keepWalk(loop.name, loop.driver)
	}
}

// `loop(startingWith:while:_)`, checking the predicate before each step, so a
// predicate false on the seed answers the seed. `until` asks the other way.
function conditionWalk(
	loop: common.typedSimple.InlineLoop,
	driver: Extract<common.typedSimple.InlineLoopDriver, { kind: "condition" }>,
): InlinedWalk {
	let prefix = loop.name
	let state = `${prefix}_state`
	let built = builtArray(loop)
	let accumulator = loop.build?.parameter ?? null
	// The predicate and the step share the State, so both decide whether it
	// is carried raw.
	let carried =
		built === null
			? carriedInteger(state, null, 0, [driver.predicate, driver.step])
			: null
	// The seed before the bodies, so pooled constants are collected in source
	// order.
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
					// `while` leaves on false, `until` on true.
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

// `loop(from:through:startingWith:_)` and `loop(from:downTo:startingWith:_)`
// as a `for` over the bounds. See "Counted walks" in DEVELOPMENT.md.
function countedWalk(
	loop: common.typedSimple.InlineLoop,
	driver: Extract<common.typedSimple.InlineLoopDriver, { kind: "counted" }>,
): InlinedWalk {
	let prefix = loop.name
	let from = `${prefix}_from`
	let to = `${prefix}_to`
	let bound = `${prefix}_bound`
	let escaped = `${prefix}_big`
	let delta = `${prefix}_delta`
	let index = `${prefix}_index`
	let held = `${prefix}_held`
	let state = `${prefix}_state`
	// With both bounds written as safe Integers, no bigint machinery is
	// emitted at all.
	let mayEscape = !(safeBound(driver.from) && safeBound(driver.through))
	let built = builtArray(loop)
	// The State is the second Argument, after the counter, and each may be
	// carried raw on its own.
	let carried =
		built === null ? carriedInteger(state, null, 1, [driver.step]) : null
	// The bounds and the seed in call order, before the body.
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
		// The counter as an Integer, which `inlinedCallback` unboxes where
		// the body only reads its value.
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
		// Counting down clamps its end to the start, so the first turn always
		// runs. Counting up tests its end directly.
		...(driver.descending
			? [
					loopDeclaration("const", bound, {
						type: "ConditionalExpression",
						test: {
							type: "BinaryExpression",
							operator: "<=",
							left: loopIdentifier(to),
							right: loopIdentifier(from),
						},
						consequent: loopIdentifier(to),
						alternate: loopIdentifier(from),
					}),
				]
			: []),
		// A bound held as a bigint, which the canonical invariant makes the
		// same as one outside the safe range, sends the counter to bigint.
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
						consequent: countLiteral(driver.descending ? -1n : 1n),
						alternate: steppedBy(driver.descending),
					}
				: steppedBy(driver.descending),
		),
		{
			type: "ForStatement",
			// A bigint walk converts a number start once, since a number
			// stepped by a bigint throws.
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
			// Up to the end, or down to the clamp. The comparison is exact
			// across number and bigint.
			test: driver.descending
				? {
						type: "BinaryExpression",
						operator: ">=",
						left: loopIdentifier(index),
						right: loopIdentifier(bound),
					}
				: {
						type: "BinaryExpression",
						operator: "<=",
						left: loopIdentifier(index),
						right: loopIdentifier(to),
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

// `loop(startingWith:step:)`, whose body answers a `Step` each turn: `#Done`
// stops with its value and `#Continue` carries the next State.
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
		// Labelled only where a `#Done` leaves through it. Without one the
		// walk never ends, as the driver's would not.
		stops ? labelled(prefix, walk) : walk,
	]

	// The answer is the slot a `#Done` writes, never the State, so the exit
	// boxes nothing; a raw State is boxed where `#Done` writes it.
	heldRaw(carried, statements)

	return {
		statements,
		answer: loopIdentifier(answer),
	}
}

// `List.reduce`, both entries. The early-stopping one walks in a labelled
// block and answers the accumulator after it unless a `#Done` left first.
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
	// Apart from `items`, since a fold seeded with its own receiver holds the
	// walked and the built Array at once.
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
	// The receiver, then the seed, in call order. The count is read with the
	// receiver, so a seed that appends to the receiver does not lengthen the
	// walk.
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

	// Asked of the seed and the walk, where the State is written.
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

// `List.map`: an Array built beside the walk and wrapped once at the end.
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

// `List.everyItem`: the same walk, keeping each item the check accepts. The
// item is bound, since both the check and the push read it.
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

// The Array a walk building its List in place pushes into, or null. See
// "Lists built in place" in DEVELOPMENT.md.
function builtArray(loop: common.typedSimple.InlineLoop): string | null {
	return loop.build === undefined ? null : `${loop.name}_built`
}

// The Array the walk starts with: a literal seed's own, or a copy of any
// other seed. See "Lists built in place" in DEVELOPMENT.md.
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

// The items a List Literal wrote, in either of its spellings, or null.
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

// A whole List's items pushed onto an Array the caller owns.
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

// A building walk's answer, written as its pushes. The Array is the State,
// so there is nothing to assign.
function builtTarget(built: string): RedirectTarget {
	return {
		kind: "answer",
		write: (written, redirect) => [
			...builtAdditions(built, written.node),
			...breakOut(redirect),
		],
	}
}

// The same for a body answering a `Step`. `#Done` boxes the Array once, or
// finishes with a value of its own.
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

			// `build-lists-in-place` declines a body whose `Step` is not
			// visible, since it would replace the State whole.
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

// One turn's additions as pushes, in order. A whole List written as a
// literal pushes its items directly.
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

// A body that binds one value and pushes it pushes the value directly. See
// "Lists built in place" in DEVELOPMENT.md.
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
		// Only the walk's own Array and its `push` move ahead of the Argument.
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

// Whether a name is mentioned anywhere in the emitted body, which an elided
// List accumulator must not be.
function mentionsIdentifier(root: unknown, name: string): boolean {
	let found = false
	// Guards against a shared node being walked once per path.
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

// A `Step` answer: `#Continue` assigns the State, `#Done` assigns the answer
// and breaks the walk. See "Step answers" in DEVELOPMENT.md.
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

			// A block of its own, so two such answers in one body do not share
			// the held name.
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

// The builtin `Step`'s Cases: `#Done(x)` carries `value` and `#Continue(x)`
// carries `state`.
const doneTag = "Step#Done"
const continueTag = "Step#Continue"

// A `Step` the Compiler can see being built, as a `CaseValue` or as the
// `direct-case` `collapse-construction` makes of one, or null.
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

// A `Step` payload's one member. A payload with any other member is refused,
// since dropping the Case would drop that member's evaluation.
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

// What a body reads in place of `<first Parameter>.value`, and the binding
// that name needs, emitted only where the swap is taken.
type UnboxedArgument = {
	read: string
	binding: Array<estree.Statement>
}

// One callback's body where the call to it was, its Parameters bound as
// `const`s. See "Callbacks" in DEVELOPMENT.md.
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
			// The body is the block, so its last answer needs no `break`.
			isTail: true,
			broke: () => {
				broke = true
			},
		}),
	])
	let first = callback.parameters[0]
	// One `const` fewer where the accumulator's was elided.
	let bound = callback.parameters.length - (dropped === null ? 0 : 1)
	// The body's own Statements, taken before any swap reshapes `body`.
	let statements = body.slice(bound)

	// The accumulator of a List built in place is not bound, so a surviving
	// mention is a compiler bug.
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

	// The State is swapped by the walk, which may hand it to two bodies.
	if (carried !== null) {
		let held = callback.parameters[carried.parameter]

		if (held !== undefined) {
			carried.bodies.push({
				parameter: rewriteIdentifier(held).name,
				statements,
			})
		}
	}

	// The counter's Integer is never built where the body only reads its
	// value. See "Unboxed counters and States" in DEVELOPMENT.md.
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

	// Last, on the Statements as they will be emitted.
	if (dropped !== null) {
		body = pushedWhereBound(body)
	}

	return broke ? labelled(label, loopBlock(body)) : loopBlock(body)
}

// A walk's State that may be held raw. `bodies` holds each receiving
// callback's Parameter name and Statements; `answer` is a `Step` walk's answer
// slot. See "Unboxed counters and States" in DEVELOPMENT.md.
type CarriedState = {
	name: string
	answer: string | null
	parameter: number
	bodies: Array<{ parameter: string; statements: Array<estree.Statement> }>
}

// A State that may be held raw, or null. Its Type must be exactly Integer in
// every receiving body.
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

// Decides and performs the State swap, answering whether the State is held
// raw. See "Unboxed counters and States" in DEVELOPMENT.md.
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

// How a walk answers with its State: boxed once with `createInteger` where
// it was held raw.
function carriedAnswer(state: string, raw: boolean): estree.Expression {
	return raw ? exitBox(loopIdentifier(state)) : loopIdentifier(state)
}

// Unboxes every write of a name: its declaration and its plain assignments.
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

// The key holding the value a node writes to a name, or null. A compound
// assignment is never unboxed.
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

// Whether a name is mentioned anywhere other than as `<name>.value`, keys
// included. `slots` admits the name written whole into one of the walk's slots.
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

// Whether the slot is mentioned other than in the writes `unboxWrites`
// rewrites and the `const` binding a body's Parameter to it.
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

// Boxes `<- #Done(carried)` where it writes the answer slot, which holds
// Integers. It runs once per walk.
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

// Replaces every `<name>.value` with a read of `held`, in place, from the
// parent node.
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

// A List walk's items and their count, read once. See "List walks" in
// DEVELOPMENT.md.
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

// A `for` over the positions of a List's Array, up to the count `heldItems`
// read.
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

// The raw boolean a predicate's answer decides by. A Boolean built from a
// JavaScript test answers that test.
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

// A literal constructor, read off the runtime Namespace import.
function createdInteger(value: estree.Expression): estree.Expression {
	return {
		type: "CallExpression",
		optional: false,
		callee: memberRead(loopIdentifier("Integer"), "createInteger"),
		arguments: [value],
	}
}

// Whether a bound is an Integer Literal held as a number, read through a
// pooled reference. Anything else is decided at run time.
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

// One step of a number counter, up or down by one.
function steppedBy(descending: boolean): estree.Expression {
	return numberLiteral(descending ? -1 : 1)
}

// One step of a bigint counter.
function countLiteral(value: bigint): estree.BigIntLiteral {
	return { type: "Literal", bigint: value.toString(), value }
}

// The turn's counter in its canonical representation, for an unboxed body.
// See "Counted walks" in DEVELOPMENT.md.
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

// The one Array a List's items live in, through the runtime's
// `List.materialise`.
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

// A name an inlined loop binds, emitted as it is. It comes from the loop's
// prefix, which contains `_`.
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
		// One emitted block is one Namespace Scope.
		body: withNamespaceScope(() =>
			nodes
				.flatMap((node) => rewriteStatements(node))
				.filter((value) => !!value),
		),
	}
}

// A default becomes a JavaScript default parameter. A default reading `@`
// reads the `_self` Parameter rather than recomputing the receiver.
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

// Every emitted Function goes through here, so a completing body becomes a
// Function answering a `Future`. See "Completing bodies" in DEVELOPMENT.md.
function rewriteFunctionExpression(
	node: common.typedSimple.FunctionDefinitionNode,
): estree.FunctionExpression {
	return {
		type: "FunctionExpression",
		id: null,
		params: node.parameters.map((param) => rewriteParameter(param)),
		body: completingBodyOf(node),
	}
}

// The body of `rewriteFunctionExpression`, shared with a free Function's
// declaration.
function completingBodyOf(
	node: common.typedSimple.FunctionDefinitionNode,
): estree.BlockStatement {
	if (node.completing !== true) {
		return tailLoopBody(node, rewriteBlockStatement(node.body))
	}

	completingDepth += 1

	let body: estree.BlockStatement

	try {
		body = rewriteBlockStatement(node.body)
	} finally {
		completingDepth -= 1
	}

	return {
		type: "BlockStatement",
		body: [
			{
				type: "ReturnStatement",
				argument: {
					type: "CallExpression",
					optional: false,
					callee: memberRead(futureModule(), "of"),
					arguments: [
						{
							type: "ArrowFunctionExpression",
							async: true,
							expression: false,
							params: [contextIdentifier()],
							body,
						},
					],
				},
			},
		],
	}
}

// `$tail_0: while (true) { … }` around the whole body of a looped Function.
// See "Self tail calls" in DEVELOPMENT.md.
function tailLoopBody(
	node: common.typedSimple.FunctionDefinitionNode,
	body: estree.BlockStatement,
): estree.BlockStatement {
	if (node.tailLoop === undefined) {
		return body
	}

	return {
		type: "BlockStatement",
		body: [
			{
				type: "LabeledStatement",
				label: { type: "Identifier", name: node.tailLoop },
				body: {
					type: "WhileStatement",
					test: { type: "Literal", value: true },
					body,
				},
			},
		],
	}
}

// One turn of a looped Function: held Arguments, Parameter assignments and
// `continue`. See "Self tail calls" in DEVELOPMENT.md.
function rewriteTailCallStatement(
	node: common.typedSimple.TailCallStatementNode,
): Array<estree.Statement> {
	return [
		...node.bindings.map(
			(binding): estree.Statement => ({
				type: "VariableDeclaration",
				kind: "const",
				declarations: [
					{
						type: "VariableDeclarator",
						id: { type: "Identifier", name: binding.name },
						init: rewriteExpression(binding.value),
					},
				],
			}),
		),
		...node.assignments.map(
			(assignment): estree.Statement => ({
				type: "ExpressionStatement",
				expression: {
					type: "AssignmentExpression",
					operator: "=",
					left: { type: "Identifier", name: assignment.name },
					right: rewriteExpression(assignment.value),
				},
			}),
		),
		{
			type: "ContinueStatement",
			label: { type: "Identifier", name: node.label },
		},
	]
}

function futureModule(): estree.Identifier {
	return { type: "Identifier", name: "$future" }
}

// The context a completing body's work runs under.
function contextIdentifier(): estree.Identifier {
	return { type: "Identifier", name: "$ctx" }
}

// `start x`, which puts the future in flight and never waits.
function rewriteStart(
	node: common.typedSimple.StartNode,
): estree.CallExpression {
	return {
		type: "CallExpression",
		optional: false,
		callee: memberRead(futureModule(), "start"),
		arguments: [rewriteExpression(node.expression), contextArgument()],
	}
}

// `complete x`, an `await` of the started run.
function rewriteComplete(
	node: common.typedSimple.CompleteNode,
): estree.AwaitExpression {
	return {
		type: "AwaitExpression",
		argument: {
			type: "CallExpression",
			optional: false,
			callee: memberRead(futureModule(), "complete"),
			arguments: [rewriteExpression(node.expression), contextArgument()],
		},
	}
}

// How many completing bodies lexically enclose the code being emitted, which
// decides whether `$ctx` is in scope.
let completingDepth = 0

// Whether the body being rewritten has used `$ctx`, which `testBody` reads.
let contextTaken = false

function contextArgument(): estree.Expression {
	if (completingDepth > 0) {
		contextTaken = true

		return contextIdentifier()
	}

	return {
		type: "CallExpression",
		optional: false,
		callee: memberRead(futureModule(), "root"),
		arguments: [],
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
	// An absolute path for a bundle, which the bundler inlines, and the package
	// specifier for a host. See "Emit targets" in DEVELOPMENT.md.
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

// Arrays first, since they are objects too and must stay Arrays.
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

// A derived-equality descriptor as a JSON-shaped literal. Its keys are Case
// tags and member names, so every key is a string Literal.
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

// A Type descriptor as the object literal the runtime's Type check reads.
// Keys go through `memberKey`, since a Record's members may be named `ok?`.
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

// A Type serialized for the runtime, without a Record's display name. A
// refinement here means the optimiser's erasure missed one, so it throws.
// See "Type descriptors" in DEVELOPMENT.md.
function typeDescriptorExpression(
	type: common.Type,
	where: string,
): estree.ObjectExpression {
	let descriptor = withoutRecordNames(type)

	if (typeContainsRefinement(descriptor)) {
		throw new Error(
			`Internal Compiler Error: a checked refinement reached ${where} — refinements are erased in the Optimiser stage and can not be emitted.`,
		)
	}

	return convertObjectToObjectExpression(descriptor)
}
// #endregion

// #region Tests

// The test runtime's import name and the name of a test's context, both in
// `compilerOwnedNames`.
const TESTING_MODULE = "$testing"
const TEST_CONTEXT = "$context"

// What a bundle exports so a runner reaches every Module's tests. It comes
// from inside the bundle, whose runtime owns its values' Type key.
const TEST_ENTRY_POINTS = "$tests"

function testingModule(): estree.Identifier {
	return { type: "Identifier", name: TESTING_MODULE }
}

function testContext(): estree.Identifier {
	return { type: "Identifier", name: TEST_CONTEXT }
}

function testingCall(
	name: string,
	args: Array<estree.Expression>,
): estree.CallExpression {
	return {
		type: "CallExpression",
		optional: false,
		callee: memberRead(testingModule(), name),
		arguments: args,
	}
}

// The `tests` block as one call registering the Module's manifest. Its `run`
// evaluates the setup a selected test sees afresh, then that test.
function rewriteTestsSection(
	section: common.typedSimple.TestsSectionNode,
): Array<estree.Statement> {
	return [
		{
			type: "ExpressionStatement",
			expression: testingCall("register", [
				{
					type: "ObjectExpression",
					properties: [
						property("module", literalOrNull(section.module)),
						property("spans", testSpans(section.spans)),
						property("tests", testManifest(section.tests)),
						property("run", sectionRun(section)),
					],
				},
			]),
		},
	]
}

// The section as a Function of the per-test context, `async` exactly where
// something inside it waits.
function sectionRun(
	section: common.typedSimple.TestsSectionNode,
): estree.ArrowFunctionExpression {
	let run: estree.ArrowFunctionExpression = {
		type: "ArrowFunctionExpression",
		expression: false,
		params: [testContext()],
		body: {
			type: "BlockStatement",
			body: withNamespaceScope(() => rewriteTestsNodes(section.nodes)),
		},
	}

	if (holdsAwait(run.body)) {
		run.async = true
	}

	return run
}

// One Scope's run of Nodes. A suite gets a block of its own, so its Constants
// stay inside it and may shadow the section's.
function rewriteTestsNodes(
	nodes: Array<common.typedSimple.TestsNode>,
): Array<estree.Statement> {
	return nodes.flatMap((node) => {
		if (node.nodeType === "TestEntry") {
			// In Argument order, so pooled constants are numbered in that order.
			let name = testName(node.name)
			let body = testBody(node.body)

			return withStatementLocation(
				[
					{
						type: "ExpressionStatement",
						// A benchmark is the same call through `benchmark`, whose
						// runtime times the body.
						expression: awaitedRegistration(
							testingCall(
								node.benchmark ? "benchmark" : "entry",
								[
									testContext(),
									numberLiteral(node.index),
									name,
									body,
								],
							),
							body,
						),
					},
				],
				node.position,
			)
		}

		if (node.nodeType === "TestRows") {
			let rowName: estree.Expression =
				node.name === null
					? { type: "Literal", value: null }
					: rowClosure(node.binding, [
							...node.bindings.flatMap((binding) =>
								rewriteStatements(binding),
							),
							{
								type: "ReturnStatement",
								argument: rewriteExpression(node.name),
							},
						])
			let rowBody = rowClosure(node.binding, [
				...node.bindings.flatMap((binding) =>
					rewriteStatements(binding),
				),
				...rewriteBlockStatement(node.body).body,
			])
			let rows: estree.Expression = {
				type: "ArrayExpression",
				elements: node.rows.map((row) => rewriteExpression(row)),
			}

			return withStatementLocation(
				[
					{
						type: "ExpressionStatement",
						// Benchmark rows go through `benchmarkRows`.
						expression: awaitedRegistration(
							testingCall(
								node.benchmark ? "benchmarkRows" : "rows",
								[
									testContext(),
									numberLiteral(node.first),
									rows,
									rowName,
									rowBody,
								],
							),
							rowBody,
						),
					},
				],
				node.position,
			)
		}

		if (node.nodeType === "TestProperties") {
			return withStatementLocation(
				[
					{
						type: "ExpressionStatement",
						expression: testingCall("properties", [
							testContext(),
							numberLiteral(node.index),
							node.name === null
								? { type: "Literal", value: null }
								: rewriteExpression(node.name),
							{
								type: "ArrayExpression",
								elements: node.parameters.map((parameter) => ({
									type: "ObjectExpression",
									properties: [
										property("name", {
											type: "Literal",
											value: parameter.name,
										}),
										property(
											"generator",
											testGenerator(parameter.generator),
										),
									],
								})),
							},
							{
								type: "ArrowFunctionExpression",
								expression: false,
								params: node.parameters.map((parameter) => ({
									type: "Identifier",
									name: escapeName(parameter.name),
								})),
								body: rewriteBlockStatement(node.body),
							},
						]),
					},
				],
				node.position,
			)
		}

		if (node.nodeType === "TestScope") {
			// A call rather than a block, so the runtime can skip a suite the
			// running test is not in.
			let held: estree.ArrowFunctionExpression = {
				type: "ArrowFunctionExpression",
				expression: false,
				params: [],
				body: {
					type: "BlockStatement",
					body: withNamespaceScope(() =>
						rewriteTestsNodes(node.nodes),
					),
				},
			}

			return [
				{
					type: "ExpressionStatement",
					expression: awaitedRegistration(
						testingCall("scope", [
							testContext(),
							numberLiteral(node.first),
							numberLiteral(node.last),
							held,
						]),
						held,
					),
				},
			]
		}

		return rewriteStatements(node)
	})
}

// A generator as plain data, but for the leaves that carry an Expression,
// which become closures of the one name they bind.
function testGenerator(
	generator: common.typedSimple.TestGenerator,
): estree.Expression {
	let properties: Array<estree.Property> = [
		property("kind", { type: "Literal", value: generator.kind }),
	]

	switch (generator.kind) {
		case "list":
			properties.push(property("item", testGenerator(generator.item)))

			break
		case "dictionary":
			properties.push(
				property("key", testGenerator(generator.key)),
				property("value", testGenerator(generator.value)),
			)

			// The key witness every drawn Dictionary is built through, where
			// one was resolved.
			if (generator.keyConformance !== undefined) {
				properties.push(
					property(
						"keyConformance",
						rewriteExpression(generator.keyConformance),
					),
				)
			}

			break
		case "record":
			properties.push(
				property("members", testGeneratorMembers(generator.members)),
			)

			break
		case "case":
			properties.push(
				// Through `renderIdentity`, as `createCase` stamps it.
				property("tag", {
					type: "Literal",
					value: renderIdentity(generator.tag),
				}),
				property("members", testGeneratorMembers(generator.members)),
			)

			break
		case "union":
			properties.push(
				property("members", {
					type: "ArrayExpression",
					elements: generator.members.map((member) =>
						testGenerator(member),
					),
				}),
			)

			break
		case "refined":
			properties.push(
				property("name", { type: "Literal", value: generator.name }),
				property("base", testGenerator(generator.base)),
				property("checks", {
					type: "ArrayExpression",
					elements: generator.checks.map((check) =>
						generatorClosure(generator.binding, check),
					),
				}),
				property("narrowing", testNarrowing(generator.narrowing)),
			)

			break
		case "generated":
			properties.push(
				property("name", { type: "Literal", value: generator.name }),
				property(
					"generate",
					generatorClosure(generator.binding, generator.call),
				),
				// Always emitted: without a written `shrink`, the Protocol's
				// provided one answers an empty List.
				property(
					"shrink",
					generatorClosure(generator.shrinkBinding, generator.shrink),
				),
			)

			break
		default:
			break
	}

	return { type: "ObjectExpression", properties }
}

function testGeneratorMembers(
	members: Array<common.typedSimple.TestGeneratorMember>,
): estree.ArrayExpression {
	return {
		type: "ArrayExpression",
		elements: members.map((member) => ({
			type: "ObjectExpression",
			properties: [
				property("name", { type: "Literal", value: member.name }),
				property("generator", testGenerator(member.generator)),
			],
		})),
	}
}

function testNarrowing(
	narrowing: common.typedSimple.TestNarrowing,
): estree.ObjectExpression {
	let properties: Array<estree.Property> = []

	for (let [name, value] of Object.entries(narrowing)) {
		properties.push(
			property(
				name,
				Array.isArray(value)
					? {
							type: "ArrayExpression",
							elements: value.map((entry) => ({
								type: "Literal" as const,
								value: entry,
							})),
						}
					: { type: "Literal", value },
			),
		)
	}

	return { type: "ObjectExpression", properties }
}

function generatorClosure(
	binding: string,
	value: common.typedSimple.ExpressionNode,
): estree.Expression {
	return {
		type: "ArrowFunctionExpression",
		expression: true,
		params: [{ type: "Identifier", name: escapeName(binding) }],
		body: rewriteExpression(value),
	}
}

// A Function of the row, for a table test's name or body, so only the
// running row is evaluated.
function rowClosure(
	binding: string,
	body: Array<estree.Statement>,
): estree.ArrowFunctionExpression {
	return {
		type: "ArrowFunctionExpression",
		expression: false,
		params: [{ type: "Identifier", name: escapeName(binding) }],
		body: { type: "BlockStatement", body },
	}
}

// An item's interpolated name, or `null` for a plain one in the manifest.
function testName(
	name: common.typedSimple.ExpressionNode | null,
): estree.Expression {
	return name === null
		? { type: "Literal", value: null }
		: rewriteExpression(name)
}

// A test body with a context of its own, aborted when the body settles,
// where the body uses one. `contextTaken` is restored only when the body does
// not throw. See "Test bodies" in DEVELOPMENT.md.
function testBody(
	body: Array<common.typedSimple.ImplementationNode>,
): estree.ArrowFunctionExpression {
	let enclosing = contextTaken

	contextTaken = false
	completingDepth += 1

	let block: estree.BlockStatement

	try {
		block = rewriteBlockStatement(body)
	} finally {
		completingDepth -= 1
	}

	let taken = contextTaken

	contextTaken = enclosing || taken

	if (!taken) {
		return {
			type: "ArrowFunctionExpression",
			expression: false,
			params: [],
			body: block,
		}
	}

	return {
		type: "ArrowFunctionExpression",
		expression: false,
		params: [],
		body: {
			type: "BlockStatement",
			body: [
				{
					type: "VariableDeclaration",
					kind: "let",
					declarations: [
						{
							type: "VariableDeclarator",
							id: contextIdentifier(),
							init: {
								type: "CallExpression",
								optional: false,
								callee: memberRead(futureModule(), "root"),
								arguments: [],
							},
						},
					],
				},
				{
					type: "TryStatement",
					block,
					finalizer: {
						type: "BlockStatement",
						body: [
							{
								type: "ExpressionStatement",
								expression: {
									type: "CallExpression",
									optional: false,
									callee: memberRead(
										memberRead(
											contextIdentifier(),
											"controller",
										),
										"abort",
									),
									arguments: [],
								},
							},
						],
					},
				},
			],
		},
	}
}

// A registration call, made `async` and awaited only where the Function it
// registers awaits. See "Test bodies" in DEVELOPMENT.md.
function awaitedRegistration(
	call: estree.CallExpression,
	handed: estree.ArrowFunctionExpression,
): estree.Expression {
	if (!holdsAwait(handed.body)) {
		return call
	}

	handed.async = true

	return { type: "AwaitExpression", argument: call }
}

// The span table, indexed by point id, so a reader of an event needs no
// compiler.
function testSpans(
	spans: Array<common.typedSimple.TestSpan>,
): estree.ArrayExpression {
	return {
		type: "ArrayExpression",
		elements: spans.map((span) => ({
			type: "ObjectExpression",
			properties: [
				property("start", cursorObject(span.position.start)),
				property("end", cursorObject(span.position.end)),
				property("source", { type: "Literal", value: span.source }),
			],
		})),
	}
}

function testManifest(
	tests: Array<common.typedSimple.TestManifestEntry>,
): estree.ArrayExpression {
	return {
		type: "ArrayExpression",
		elements: tests.map((entry) => ({
			type: "ObjectExpression",
			properties: [
				property("id", { type: "Literal", value: entry.id }),
				property("name", { type: "Literal", value: entry.name }),
				property("interpolated", {
					type: "Literal",
					value: entry.interpolated,
				}),
				property("row", {
					type: "Literal",
					value: entry.row,
				}),
				property("suitePath", {
					type: "ArrayExpression",
					elements: entry.suitePath.map((step) => ({
						type: "Literal" as const,
						value: step,
					})),
				}),
				property("tags", {
					type: "ArrayExpression",
					elements: entry.tags.map((tag) => ({
						type: "Literal" as const,
						value: tag,
					})),
				}),
				property("focused", { type: "Literal", value: entry.focused }),
				property("skipped", literalOrNull(entry.skipped)),
				property("benchmark", {
					type: "Literal",
					value: entry.benchmark,
				}),
				property("cases", { type: "Literal", value: entry.cases }),
				property("key", { type: "Literal", value: entry.key }),
				property("position", rangeObject(entry.position)),
				property("keywordPosition", rangeObject(entry.keywordPosition)),
			],
		})),
	}
}

function rangeObject(position: common.Position): estree.ObjectExpression {
	return {
		type: "ObjectExpression",
		properties: [
			property("start", cursorObject(position.start)),
			property("end", cursorObject(position.end)),
		],
	}
}

function cursorObject(cursor: common.Cursor): estree.ObjectExpression {
	return {
		type: "ObjectExpression",
		properties: [
			property("line", numberLiteral(cursor.line)),
			property("column", numberLiteral(cursor.column)),
		],
	}
}

function literalOrNull(value: string | null): estree.Expression {
	return { type: "Literal", value }
}

function property(name: string, value: estree.Expression): estree.Property {
	return {
		type: "Property",
		kind: "init",
		method: false,
		shorthand: false,
		computed: false,
		key: memberKey(name),
		value,
	}
}

// The test entry points the entry Module exports whenever any Module of the
// graph declared a test.
function testEntryPointsExport(): estree.ExportNamedDeclaration {
	return {
		type: "ExportNamedDeclaration",
		declaration: {
			type: "VariableDeclaration",
			kind: "const",
			declarations: [
				{
					type: "VariableDeclarator",
					id: { type: "Identifier", name: TEST_ENTRY_POINTS },
					init: memberRead(testingModule(), "entryPoints"),
				},
			],
		},
		specifiers: [],
		attributes: [],
	}
}

// The name of a Module's coverage counter, a closure over the Module's own
// counts that every counter in the body calls.
const COVERAGE_COUNTER = "$cover"

function coverageCounter(): estree.Identifier {
	return { type: "Identifier", name: COVERAGE_COUNTER }
}

// Binds the counter by registering the Module's table of points, which says
// what each counter means. It stands above every instrumented Statement. A
// Module that declares provided Methods hoists it, as they do.
function coverageHead(
	section: common.typedSimple.CoverageSectionNode,
	modulePath: string | null,
	hoisted: boolean = false,
): Array<estree.Statement> {
	let counters = testingCall("counters", [
		{
			type: "ObjectExpression",
			properties: [
				property("module", literalOrNull(modulePath)),
				property("points", coveragePoints(section.points)),
				property("choices", coverageChoices(section.choices)),
			],
		},
	])

	return hoisted
		? hoistedCoverageCounter(COVERAGE_COUNTER, counters)
		: [
				{
					type: "VariableDeclaration",
					kind: "const",
					declarations: [
						{
							type: "VariableDeclarator",
							id: coverageCounter(),
							init: counters,
						},
					],
				},
			]
}

function coveragePoints(
	points: Array<common.typedSimple.CoveragePoint>,
): estree.ArrayExpression {
	return {
		type: "ArrayExpression",
		elements: points.map((point) => ({
			type: "ObjectExpression",
			properties: [
				property("kind", { type: "Literal", value: point.kind }),
				property("label", { type: "Literal", value: point.label }),
				property("scope", { type: "Literal", value: point.scope }),
				property("position", rangeObject(point.position)),
				property("refinement", {
					type: "Literal",
					value: point.refinement,
				}),
				property("tag", literalOrNull(point.tag)),
			],
		})),
	}
}

function coverageChoices(
	choices: Array<common.typedSimple.CoverageChoice>,
): estree.ArrayExpression {
	return {
		type: "ArrayExpression",
		elements: choices.map((choice) => ({
			type: "ObjectExpression",
			properties: [
				property("name", { type: "Literal", value: choice.name }),
				property("cases", {
					type: "ArrayExpression",
					elements: choice.cases.map((tag) => ({
						type: "Literal" as const,
						value: tag,
					})),
				}),
				property("position", rangeObject(choice.position)),
			],
		})),
	}
}

// One counter: alone, around a value it passes through, or, where it `leads`,
// counting before the value is built.
function rewriteCoverageCounter(
	node: common.typedSimple.CoverageCounterNode,
): estree.Expression {
	let count = (
		args: Array<estree.Expression>,
	): estree.SimpleCallExpression => ({
		type: "CallExpression",
		optional: false,
		callee: coverageCounter(),
		arguments: args,
	})
	let point = numberLiteral(node.point)

	if (node.value === null) {
		return count([point])
	}

	let value = rewriteExpression(node.value)

	return node.leads
		? { type: "SequenceExpression", expressions: [count([point]), value] }
		: count([point, value])
}

// An instrumented point, answering the value it recorded. A `probe` records
// into the test's buffer rather than the next assertion's.
function rewriteTestTrace(
	node: common.typedSimple.TestTraceNode,
): estree.Expression {
	return testingCall(node.kind === "probe" ? "probe" : "trace", [
		testContext(),
		numberLiteral(node.point),
		rewriteExpression(node.value),
	])
}

// One call for either form. A failed `require` unwinds the test through the
// runtime, since a `return` inside a Match's wrapper would only end the wrapper.
function rewriteTestAssertion(
	node: common.typedSimple.TestAssertionStatementNode,
): estree.Statement {
	// A snapshot hands the runtime the rendered text, its slot and what the
	// slot holds now; only the run knows the stored snapshot.
	if (node.snapshot !== null) {
		return {
			type: "ExpressionStatement",
			expression: testingCall("snapshotted", [
				testContext(),
				numberLiteral(node.point),
				{ type: "Literal", value: node.form },
				{
					type: "ObjectExpression",
					properties: [
						property("name", literalOrNull(node.snapshot.name)),
						property(
							"recorded",
							literalOrNull(node.snapshot.recorded),
						),
						property("slot", numberLiteral(node.snapshot.slot)),
					],
				},
				rewriteExpression(node.value),
			]),
		}
	}

	return {
		type: "ExpressionStatement",
		expression: testingCall(
			node.form === "expect" ? "expected" : "required",
			[
				testContext(),
				numberLiteral(node.point),
				assertionTest(node),
				assertionComparison(node.comparison),
			],
		),
	}
}

// What has to hold, as a raw JavaScript boolean: a Matcher's Handler test, or
// a Boolean's `value`.
function assertionTest(
	node: common.typedSimple.TestAssertionStatementNode,
): estree.Expression {
	let value = rewriteExpression(node.value)

	if (node.matcher === null) {
		return valueRead(value)
	}

	// The test reads the value more than once, so it must be a name. A
	// compiled Matcher reads `_self`, so it, or a value that is no name, is
	// bound by an arrow.
	if (value.type === "Identifier" && !isCompiledHandler(node.matcher)) {
		return handlerTest(node.matcher, value, null)
	}

	return calledWrapper(
		{
			type: "ArrowFunctionExpression",
			expression: true,
			params: [selfIdentifier()],
			body: handlerTest(node.matcher, selfIdentifier(), null),
		},
		[value],
	)
}

// Whether `compile-type-tests` wrote this Handler's checks, which read
// `_self`.
function isCompiledHandler(handler: common.typedSimple.MatchHandler): boolean {
	return handler.typeTest !== null || handler.memberTests !== null
}

function assertionComparison(
	comparison: common.typedSimple.TestComparison | null,
): estree.Expression {
	if (comparison === null) {
		return { type: "Literal", value: null }
	}

	return {
		type: "ObjectExpression",
		properties: [
			property("kind", { type: "Literal", value: comparison.kind }),
			property("left", numberLiteral(comparison.left)),
			property("right", numberLiteral(comparison.right)),
		],
	}
}

// #endregion
