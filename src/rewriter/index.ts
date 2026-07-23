import * as path from "node:path"

import { generate } from "escodegen"
import type * as estree from "estree"

import type { common } from "../interfaces/index"
import { type PreludeNamespace, stdlibPrelude } from "./stdlibPrelude"

// NOTE: The builtin Namespaces that have a runtime module in `__internal/`, in
// the order their imports are emitted. A Namespace the prelude merges is
// imported under `$native_<Name>` instead and the merged const takes its name —
// everything downstream reads `Boolean.isNot` either way, so no other part of
// the Rewriter knows the difference.
const runtimeNamespaceNames = [
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
	const merged = reachableMergedNamespaces(prelude, implementation)

	const rewrittenProgram: estree.Program = {
		type: "Program",
		sourceType: "module",
		body: [
			...runtimeNamespaceNames.map((name) =>
				internalImport(
					[
						importNamespaceSpecifier(
							merged.has(name) ? `$native_${name}` : name,
						),
					],
					name,
				),
			),
			internalImport([importNamespaceSpecifier("$_")], "functions"),
			internalImport([importNamespaceSpecifier("$type")], "type"),
			internalImport(
				[importNamespaceSpecifier("$helpers")],
				"internalHelpers",
			),
			// NOTE: Imports first — a const spreads the module it was imported
			// from. Among themselves the consts may sit in any order, because
			// the only thing a merged const holds is Methods, and a Method body
			// naming another Namespace reads that name when it is CALLED, long
			// after every const is initialised. `buildStdlibPrelude` rejects a
			// bodied Property precisely to keep that true — a Property
			// initialiser would run HERE, in declaration order.
			...prelude
				.filter((namespace) => merged.has(namespace.name))
				.map((namespace) => merged.get(namespace.name)!),
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

// NOTE: A merged standard library Namespace — the runtime module spread into an
// object literal, with everything written in Essence laid over the top:
//
//   const Boolean = { ...$native_Boolean, isNot: function (_self, other) { … } }
//
// The Essence half WINS where the two collide — the object literal's own key
// overrides what the spread brought in. That is only a safety net, not a
// workflow: `builtins.spec` fails a Method that is implemented in BOTH places,
// so the TypeScript has to be deleted in the same commit that writes the
// Essence. What the precedence buys is that the failure is a red test rather
// than a Method that silently kept running its old implementation.
//
// NOTE: The member names are taken exactly as the Simplifier produced them, so
// an Overload lands under `name__overload$N` for N its position in the METHOD
// TYPE's Overloads — not its position among the bodied ones. A block that binds
// Overload 1 to the runtime and writes Overload 2 in Essence therefore emits
// `isNot__overload$2` over a spread that already carries the native's
// `isNot__overload$1`, and neither shadows the other.
//
// NOTE: A Namespace with no runtime module gets no spread. There is nothing to
// merge with — every member of it is written in Essence — and spreading an
// identifier that was never imported would emit a ReferenceError.
function rewriteMergedNamespace(
	namespace: PreludeNamespace,
	options: { hasRuntimeModule: boolean },
): estree.VariableDeclaration {
	let node = namespace.node
	let properties: Array<estree.Property | estree.SpreadElement> = []

	if (options.hasRuntimeModule) {
		properties.push({
			type: "SpreadElement",
			argument: {
				type: "Identifier",
				name: `$native_${namespace.name}`,
			},
		})
	}

	let property = (
		name: string,
		value: estree.Expression,
	): estree.Property => ({
		type: "Property",
		key: { type: "Identifier", name },
		value,
		kind: "init",
		computed: false,
		method: false,
		shorthand: false,
	})

	// NOTE: Only Methods. A merged Namespace can not carry a bodied static
	// Property — `buildStdlibPrelude` rejects one — because its initialiser
	// would be evaluated inside this very object literal, before the const it
	// names exists. See the NOTE there.
	for (let [name, method] of Object.entries(node.methods)) {
		properties.push(
			property(name, rewriteFunctionExpression(method.method.value)),
		)
	}

	return {
		type: "VariableDeclaration",
		kind: "const",
		declarations: [
			{
				type: "VariableDeclarator",
				id: { type: "Identifier", name: namespace.name },
				init: { type: "ObjectExpression", properties },
			},
		],
	}
}

// NOTE: Which merged Namespaces the emitted Program actually needs, and the
// const for each. A merged const spreads its runtime module, which forces the
// Bundler to materialise the module's namespace object and keep every export it
// has — tree shaking is defeated for a Namespace the const drags in. Emitting
// one unconditionally therefore charged every Program about a kilobyte for a
// Namespace it may never mention, and turned a Program of nothing but comments
// into a twelve kilobyte bundle. So a const is emitted only where something
// names it.
//
// NOTE: A Namespace left out keeps the plain `import * as <Name>` it always had
// — nothing references it, the Bundler shakes it away, and the emitted text is
// what it was before the prelude existed.
//
// NOTE: The search runs to a FIXED POINT over the consts themselves, not just
// over the user Program: `Boolean.isNot`'s body calls `Boolean.negate`, and a
// Method of one merged Namespace may well call into another. Stopping at the
// first round would emit a const whose body names one that was never declared.
//
// NOTE: Exported for the tests. The fixed point is the part of this that can
// silently be wrong — a Namespace reached only through another one is exactly
// what the standard library will produce more of — and it can not be driven
// through `rewrite` today, because only one Namespace is merged.
export function reachableMergedNamespaces(
	prelude: Array<PreludeNamespace>,
	implementation: Array<estree.ModuleDeclaration | estree.Statement>,
): Map<string, estree.VariableDeclaration> {
	let reachable = new Map<string, estree.VariableDeclaration>()

	if (prelude.length === 0) {
		return reachable
	}

	let candidates = new Map<string, estree.VariableDeclaration>(
		prelude.map((namespace) => [
			namespace.name,
			rewriteMergedNamespace(namespace, {
				hasRuntimeModule: runtimeNamespaceNames.includes(
					namespace.name,
				),
			}),
		]),
	)

	let pending: Array<string> = []

	let include = (names: Set<string>): void => {
		for (let name of names) {
			let declaration = candidates.get(name)

			if (declaration === undefined || reachable.has(name)) {
				continue
			}

			reachable.set(name, declaration)
			pending.push(name)
		}
	}

	include(referencedNames(implementation))

	while (pending.length > 0) {
		include(referencedNames(candidates.get(pending.pop()!)!))
	}

	return reachable
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
// place every emission site routes through. Today it is always a member read
// off the plain `import * as <Namespace>`; the next commit lets it emit a bare
// Identifier instead for a Method the standard library implements in Essence,
// so that a native stays tree-shakeable and an Essence-implemented Method needs
// no materialised module namespace object. The literal constructors
// (`String.createString`, `List.createList`, …) do NOT come through here: they
// name their Namespace directly and are not declared in `src/stdlib`, so they
// can never be Essence-implemented.
function namespaceMember(
	namespaceName: string,
	memberName: string,
): estree.Expression {
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
function rewriteLookup(
	node: common.typedSimple.LookupNode,
): estree.Expression {
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
