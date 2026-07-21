import * as path from "node:path"

import { generate } from "escodegen"
import type * as estree from "estree"

import type { common } from "../interfaces/index"

// NOTE: The Rewriter is pure: a typed simple Program in, JavaScript source
// text out. Turning that text into a file — bundling the runtime into it,
// minifying, writing it to disk — is the Bundler's job, which keeps this stage
// synchronous and testable without touching a file system.
export function rewrite(program: common.typedSimple.Program): string {
	const rewrittenProgram: estree.Program = {
		type: "Program",
		sourceType: "module",
		body: [
			internalImport([importNamespaceSpecifier("String")], "String"),
			internalImport([importNamespaceSpecifier("Integer")], "Integer"),
			internalImport([importNamespaceSpecifier("Fraction")], "Fraction"),
			internalImport([importNamespaceSpecifier("Number")], "Number"),
			internalImport([importNamespaceSpecifier("Boolean")], "Boolean"),
			internalImport([importNamespaceSpecifier("Nothing")], "Nothing"),
			internalImport([importNamespaceSpecifier("Ordering")], "Ordering"),
			internalImport([importNamespaceSpecifier("Record")], "Record"),
			internalImport([importNamespaceSpecifier("List")], "List"),
			internalImport([importNamespaceSpecifier("$_")], "functions"),
			internalImport([importNamespaceSpecifier("$type")], "type"),
			internalImport(
				[importNamespaceSpecifier("$helpers")],
				"internalHelpers",
			),
			...rewriteImplementationSection(program.implementation),
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
		case "ChoiceStatement":
			return rewriteChoiceStatement(node)
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

function rewriteChoiceStatement(
	node: common.typedSimple.ChoiceStatementNode,
): estree.IfStatement {
	let alternate: estree.Statement | null = null

	if (node.falseBody.length > 0) {
		if (
			node.falseBody.length === 1 &&
			node.falseBody[0].nodeType === "ChoiceStatement"
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
		case "FractionValue":
			return rewriteFractionValue(node)
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
	}
}

// NOTE: A conformance value is an object literal that maps each Protocol
// Method's emitted name onto the conforming Namespace's fulfilling Method —
// `{ compareTo: Integer.compareTo, … }`. This works uniformly for user
// Namespaces (classes with static Methods) and builtin runtime modules, and
// decouples the Protocol's method names from the Namespace's layout.
function rewriteConformanceValue(
	node: common.typedSimple.ConformanceValueNode,
): estree.ObjectExpression {
	return {
		type: "ObjectExpression",
		properties: Object.entries(node.methodMap).map(
			([protocolMethodName, namespaceMethodName]): estree.Property => ({
				type: "Property",
				key: { type: "Identifier", name: protocolMethodName },
				value: {
					type: "MemberExpression",
					object: { type: "Identifier", name: node.namespaceName },
					property: {
						type: "Identifier",
						name: namespaceMethodName,
					},
					computed: false,
					optional: false,
				},
				kind: "init",
				method: false,
				shorthand: false,
				computed: false,
			}),
		),
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

function rewriteMethodInvocation(
	node: common.typedSimple.MethodInvocationNode,
): estree.CallExpression {
	return {
		type: "CallExpression",
		optional: false,
		callee: {
			type: "MemberExpression",
			optional: false,
			object: rewriteExpression(node.base),
			property: {
				type: "Identifier",
				name: node.member.name,
			},
			computed: false,
		},
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
							{
								type: "MemberExpression",
								optional: false,
								object: {
									type: "Identifier",
									name: dispatchCase.namespaceName,
								},
								property: {
									type: "Identifier",
									name: dispatchCase.methodName,
								},
								computed: false,
							},
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

function rewriteFractionValue(
	node: common.typedSimple.FractionValueNode,
): estree.CallExpression {
	return {
		type: "CallExpression",
		optional: false,
		callee: {
			type: "MemberExpression",
			optional: false,
			object: {
				type: "Identifier",
				name: "Fraction",
			},
			property: {
				type: "Identifier",
				name: "createFraction",
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

function rewriteLookup(
	node: common.typedSimple.LookupNode,
): estree.MemberExpression {
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
