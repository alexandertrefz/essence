import * as path from "node:path"

import { generate } from "escodegen"
import type * as estree from "estree"

import { derivedEquatableNamespaceName } from "../enricher/resolvers"
import type { common } from "../interfaces/index"
import {
	essenceMethodIdentifier,
	essenceMethodName,
	type PreludeNamespace,
	stdlibPrelude,
} from "./stdlibPrelude"

// NOTE: The builtin Namespaces that have a runtime module in `__internal/`, in
// the order their imports are emitted. Every one is imported unconditionally,
// under its own name, and a Namespace no Program references costs nothing —
// esbuild shakes an unused `import * as <Name>` away entirely. A Method the
// standard library implements in Essence is NOT a member of one of these; it is
// its own `$es_<Namespace>_<member>` const, emitted alongside. Exported so the
// tests cross-check it against the other registration sites — a Namespace here
// but missing a runtime module, or declared in `src/stdlib` but missing here,
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
	const implementation = rewriteImplementationSection(program.implementation)
	const essenceMethods = reachableEssenceMethods(prelude, implementation)

	const rewrittenProgram: estree.Program = {
		type: "Program",
		sourceType: "module",
		body: [
			...runtimeNamespaceNames.map((name) =>
				internalImport([importNamespaceSpecifier(name)], name),
			),
			internalImport([importNamespaceSpecifier("$_")], "functions"),
			internalImport([importNamespaceSpecifier("$type")], "type"),
			internalImport(
				[importNamespaceSpecifier("$helpers")],
				"internalHelpers",
			),
			// NOTE: Imports first — an Essence Method's const reads the runtime
			// modules those imports bind. Among themselves the consts may sit in
			// any order, because each is a Function expression, whose body runs
			// only when the Method is CALLED — long after every const is
			// initialised — so one Essence Method naming another, or naming
			// itself, resolves at call time regardless of declaration order.
			// `buildStdlibPrelude` rejects a bodied Property precisely to keep
			// that true: a Property initialiser would run HERE, in declaration
			// order.
			...essenceMethods.values(),
			...implementation,
		],
	}

	return generate(rewrittenProgram, {
		format: {
			indent: {
				style: "\t",
				base: 0,
				adjustMultilineComment: false,
			},
			newline: "\n",
			space: " ",
			quotes: "double",
		},
	})
}

function rewriteImplementationSection(
	implementation: common.typedSimple.ImplementationSectionNode,
): Array<estree.ModuleDeclaration | estree.Statement> {
	return implementation.nodes.map((node) => rewriteStatement(node))
}

// #region Statements

function rewriteStatement(
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
	return {
		type: "ClassDeclaration",
		id: rewriteIdentifier(node.name),
		superClass: null,
		body: {
			type: "ClassBody",
			body: [
				...Object.entries(
					node.properties,
				).map<estree.PropertyDefinition>(([name, value]) => {
					return {
						type: "PropertyDefinition",
						key: {
							type: "Identifier",
							name,
						},
						value: rewriteExpression(value),
						computed: false,
						static: true,
					}
				}),
				...Object.entries(node.methods).map<estree.MethodDefinition>(
					([name, method]) => {
						return {
							type: "MethodDefinition",
							key: {
								type: "Identifier",
								name,
							},
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
// NOTE: Exported for the tests. The fixed point is the part of this that can
// silently be wrong — a Method reached only through another one is exactly what
// the standard library will produce more of as the conversion goes on.
export function reachableEssenceMethods(
	prelude: Array<PreludeNamespace>,
	implementation: Array<estree.ModuleDeclaration | estree.Statement>,
): Map<string, estree.VariableDeclaration> {
	let reachable = new Map<string, estree.VariableDeclaration>()

	if (prelude.length === 0) {
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

	// NOTE: Each candidate carries its declaration AND the other Essence Methods
	// its body calls, read off the TYPED body rather than the emitted const.
	// That matters: `namespaceMember` decides an emitted call's spelling from the
	// process-wide prelude, so a const emitted for a DIFFERENT prelude (only the
	// tests do this) would spell its transitive calls as native member reads and
	// the fixed point would lose the edge. Reading the typed body keeps the
	// reachability answer a property of the prelude it was handed.
	let candidates = new Map<
		string,
		{ declaration: estree.VariableDeclaration; references: Set<string> }
	>(
		prelude.flatMap((namespace) =>
			Object.entries(namespace.node.methods).map(
				([memberName, method]): [
					string,
					{
						declaration: estree.VariableDeclaration
						references: Set<string>
					},
				] => [
					essenceMethodIdentifier(namespace.name, memberName),
					{
						declaration: rewriteEssenceMethod(
							namespace.name,
							memberName,
							method,
						),
						references: essenceMethodReferences(
							method.method.value,
							implemented,
						),
					},
				],
			),
		),
	)

	let pending: Array<string> = []

	let include = (names: Set<string>): void => {
		for (let name of names) {
			let candidate = candidates.get(name)

			if (candidate === undefined || reachable.has(name)) {
				continue
			}

			reachable.set(name, candidate.declaration)
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
//                            ConformanceValues, reached by the recursion below)
//   Lookup (Identifier base) a static call OR a bare static reference —
//                            base.name, member.name
//   ConformanceValue         a witness `{ m: X.m }` — namespaceName + each
//                            methodMap value; a conditional one nests more
//                            ConformanceValues in `conditions`, reached below
//
// Over-collecting stays safe, as everywhere in the search: a pair the prelude
// does not implement is filtered by `implemented` (so a Record field or a
// static Property read falls out), and one it does only emits a const that is
// read. Exported for a unit test that feeds it each shape directly.
export function essenceMethodReferences(
	root: unknown,
	implemented: Set<string>,
): Set<string> {
	let references = new Set<string>()

	let consider = (namespaceName: unknown, memberName: unknown): void => {
		if (
			typeof namespaceName === "string" &&
			typeof memberName === "string" &&
			implemented.has(`${namespaceName} ${memberName}`)
		) {
			references.add(essenceMethodIdentifier(namespaceName, memberName))
		}
	}

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

		if (record["nodeType"] === "MethodInvocation") {
			let base = record["base"] as Record<string, unknown> | undefined
			let member = record["member"] as Record<string, unknown> | undefined

			consider(base?.["name"], member?.["name"])
		} else if (record["nodeType"] === "UnionMethodInvocation") {
			for (let dispatch of (record["cases"] as Array<
				Record<string, unknown>
			>) ?? []) {
				consider(dispatch["namespaceName"], dispatch["methodName"])
			}
		} else if (record["nodeType"] === "Lookup") {
			// NOTE: A `Lookup` off a Namespace Identifier is a static-Method
			// reference — as a call's callee or a bare value both — and is the
			// only spelling `rewriteLookup` sends through `namespaceMember`. A
			// `Lookup` off any other base (a Record field) is filtered by
			// `implemented`.
			let base = record["base"] as Record<string, unknown> | undefined
			let member = record["member"] as Record<string, unknown> | undefined

			if (base?.["nodeType"] === "Identifier") {
				consider(base["name"], member?.["name"])
			}
		} else if (record["nodeType"] === "ConformanceValue") {
			let methodMap = record["methodMap"] as
				| Record<string, unknown>
				| undefined

			for (let namespaceMethodName of Object.values(methodMap ?? {})) {
				consider(record["namespaceName"], namespaceMethodName)
			}
		}

		for (let value of Object.values(record)) {
			visit(value)
		}
	}

	visit(root)

	return references
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
	let args: Array<estree.Expression> = [{ type: "Literal", value: node.tag }]

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
// `{ compareTo: Integer.compareTo, … }`. This works uniformly for user
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
				key: { type: "Identifier", name: protocolMethodName },
				value: namespaceMember(node.namespaceName, namespaceMethodName),
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

function rewriteNativeFunctionInvocation(
	node: common.typedSimple.NativeFunctionInvocationNode,
): estree.CallExpression {
	let callee: estree.MemberExpression

	if (node.name.nodeType === "Identifier") {
		callee = {
			type: "MemberExpression",
			optional: false,
			object: {
				type: "Identifier",
				name: "$_",
			},
			property: {
				type: "Identifier",
				name: node.name.name.slice(2),
			},
			computed: false,
		}
	} else {
		throw Error(
			"Lookups on NativeFunctionIvocations are not implemented yet.",
		)
	}

	return {
		type: "CallExpression",
		optional: false,
		callee,
		arguments: node.arguments.map((arg) => rewriteArgument(arg)),
	}
}

function rewriteFunctionInvocation(
	node: common.typedSimple.FunctionInvocationNode,
): estree.CallExpression {
	return {
		type: "CallExpression",
		optional: false,
		callee: rewriteExpression(node.name),
		arguments: node.arguments.map((arg) => rewriteArgument(arg)),
	}
}

// NOTE: One reference to a member of a standard library Namespace, in the one
// place every emission site routes through. A native Method stays a read off
// the plain `import * as <Namespace>` — which esbuild rewrites to a direct
// symbol reference and can therefore tree-shake — while an Essence-implemented
// Method is not a member of anything: it is its own top-level const, reached by
// a bare `$es_<Namespace>_<member>` Identifier, so nothing has to materialise
// the module namespace object to get at it. The literal constructors
// (`String.createString`, `List.createList`, …) do NOT come through here: they
// name their Namespace directly and are not declared in `src/stdlib`, so they
// can never be Essence-implemented.
function namespaceMember(
	namespaceName: string,
	memberName: string,
): estree.Expression {
	// NOTE: A Choice's derived equality names a Namespace that exists nowhere —
	// the Enricher fabricates it per receiver and nothing is ever emitted for
	// it — so the one reference to it becomes the runtime helper directly.
	// Every emission site (a plain call, a dispatch branch, a conformance
	// witness) routes through here, so this one redirect covers all three.
	if (namespaceName === derivedEquatableNamespaceName) {
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

	let essenceName = essenceMethodName(namespaceName, memberName)

	if (essenceName !== null) {
		return { type: "Identifier", name: essenceName }
	}

	return {
		type: "MemberExpression",
		optional: false,
		computed: false,
		object: { type: "Identifier", name: namespaceName },
		property: { type: "Identifier", name: memberName },
	}
}

function rewriteMethodInvocation(
	node: common.typedSimple.MethodInvocationNode,
): estree.CallExpression {
	return {
		type: "CallExpression",
		optional: false,
		callee: namespaceMember(node.base.name, node.member.name),
		arguments: node.arguments.map((arg) => rewriteArgument(arg)),
	}
}

// NOTE: A Method Invocation on a Union-typed receiver — emitted as
// `$type.dispatchMethod(receiver, [args…], [[descriptor, Namespace.method,
// [conformances…]], …])`. The helper evaluates receiver and Arguments once
// and runs the first case whose member Type descriptor accepts the receiver;
// the Enricher ordered the cases most specific first and guarantees one
// matches.
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
							),
							{
								type: "ArrayExpression",
								elements: dispatchCase.conformanceArguments.map(
									(arg) => rewriteArgument(arg),
								),
							},
						],
					}),
				),
			},
		],
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
							key: {
								type: "Identifier",
								name: key,
							},
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

function rewriteIntegerValue(
	node: common.typedSimple.IntegerValueNode,
): estree.CallExpression {
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
				bigint: node.value,
				value: BigInt(node.value),
			},
		],
	}
}

function rewriteRationalValue(
	node: common.typedSimple.RationalValueNode,
): estree.CallExpression {
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
				bigint: node.numerator,
				value: BigInt(node.numerator),
			},
			{
				type: "Literal",
				bigint: node.denominator,
				value: BigInt(node.denominator),
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
// (`record.field`). Only the first two name a Namespace, so only a Lookup whose
// base is an Identifier routes through `namespaceMember` — and even then the
// member read is unchanged unless the pair is Essence-implemented, which a
// Record field or a Property never is. A base that is any other Expression
// (a chained access, a call result) keeps the plain member read.
function rewriteLookup(node: common.typedSimple.LookupNode): estree.Expression {
	if (node.base.nodeType === "Identifier") {
		return namespaceMember(node.base.name, node.member.name)
	}

	return {
		type: "MemberExpression",
		optional: false,
		object: rewriteExpression(node.base),
		property: rewriteIdentifier(node.member),
		computed: false,
	}
}

function rewriteIdentifier(
	node: common.typedSimple.IdentifierNode,
): estree.Identifier {
	return {
		type: "Identifier",
		name: node.name,
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
						{
							type: "MemberExpression",
							object: value,
							property: { type: "Identifier", name },
							optional: false,
							computed: false,
						},
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
		}

		if (ifChain) {
			ifStatement.alternate = ifChain
		}

		ifChain = ifStatement
	}

	return {
		type: "CallExpression",
		callee: {
			type: "FunctionExpression",
			body: {
				type: "BlockStatement",
				body: ifChain ? [ifChain] : [],
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
		body: nodes
			.map((node) => rewriteStatement(node))
			.filter((value) => !!value),
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
	const __dirname = import.meta.dirname

	return {
		type: "ImportDeclaration",
		specifiers,
		attributes: [],
		source: {
			type: "Literal",
			value: `${path.resolve(__dirname, "./__internal", fileName)}.ts`,
			raw: `"${path.resolve(__dirname, "./__internal", fileName)}.ts"`,
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

	return { type: "Literal", value } as estree.Literal
}

function convertObjectToObjectExpression(
	object: object,
): estree.ObjectExpression {
	return {
		type: "ObjectExpression",
		properties: Object.entries(object).map<estree.Property>(
			([key, value]) => {
				return {
					type: "Property",
					key: {
						type: "Identifier",
						name: key,
					},
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
