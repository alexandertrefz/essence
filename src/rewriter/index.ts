import * as path from "node:path"

import { generate } from "escodegen"
import type * as estree from "estree"

import { type BuildResult, build } from "esbuild"

import type { common } from "../interfaces"

export async function rewrite(
	program: common.typedSimple.Program,
	flags: { inputFileName: string; outputFileName: string; debug: boolean },
): Promise<BuildResult> {
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
			internalImport([importNamespaceSpecifier("Record")], "Record"),
			internalImport([importNamespaceSpecifier("List")], "List"),
			internalImport([importNamespaceSpecifier("$_")], "functions"),
			internalImport([importNamespaceSpecifier("$type")], "type"),
			...rewriteImplementationSection(program.implementation),
		],
	}

	const programText = generate(rewrittenProgram, {
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

	const __dirname = import.meta.dir

	return build({
		stdin: {
			contents: programText,
			loader: "ts",
			resolveDir: __dirname,
			sourcefile: flags.inputFileName,
		},

		tsconfig: `${__dirname}/__internal/tsconfig.json`,
		minify: false,
		treeShaking: true,
		bundle: true,
		format: "esm",
		outfile: flags.outputFileName,
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

	const valueExpression = rewriteExpression(node.value)
	const selfParameter: estree.Identifier = {
		type: "Identifier",
		name: "_self",
	}

	let previousIfStatement: estree.IfStatement | undefined = undefined
	let finalIfStatement: estree.IfStatement

	for (let i = node.handlers.length - 1; i >= 0; i--) {
		const currentHandler = node.handlers[i]

		if (i > 0) {
			previousIfStatement = {
				type: "IfStatement",
				test: callIsValueOfType(selfParameter, currentHandler.matcher),
				consequent: rewriteBlockStatement(currentHandler.body),
			}
		} else {
			finalIfStatement = {
				type: "IfStatement",
				test: callIsValueOfType(selfParameter, currentHandler.matcher),
				consequent: rewriteBlockStatement(currentHandler.body),
			}

			if (previousIfStatement) {
				finalIfStatement.alternate = previousIfStatement
			}
		}
	}

	return {
		type: "CallExpression",
		callee: {
			type: "FunctionExpression",
			body: {
				type: "BlockStatement",
				// biome-ignore lint/style/noNonNullAssertion: We can guarantee that this will always be set
				body: [finalIfStatement!],
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
	node:
		| common.typedSimple.FunctionDefinitionNode
		| common.typedSimple.GenericFunctionDefinitionNode,
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
	const __dirname = import.meta.dir

	return {
		type: "ImportDeclaration",
		specifiers,
		source: {
			type: "Literal",
			value: `${path.resolve(__dirname, "./__internal", fileName)}.ts`,
			raw: `"${path.resolve(__dirname, "./__internal", fileName)}.ts"`,
		},
	}
}

function importSpecifier(variableName: string): estree.ImportSpecifier {
	return {
		type: "ImportSpecifier",
		local: {
			type: "Identifier",
			name: variableName,
		},
		imported: {
			type: "Identifier",
			name: variableName,
		},
	}
}

function importDefaultSpecifier(
	variableName: string,
): estree.ImportDefaultSpecifier {
	return {
		type: "ImportDefaultSpecifier",
		local: {
			type: "Identifier",
			name: variableName,
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

function convertObjectToObjectExpression(
	object: object,
): estree.ObjectExpression {
	return {
		type: "ObjectExpression",
		properties: Object.entries(object).map<estree.Property>(
			([key, value]) => {
				if (value !== null && typeof value === "object") {
					value = convertObjectToObjectExpression(value)
				} else {
					value = { type: "Literal", value } as estree.Literal
				}

				return {
					type: "Property",
					key: {
						type: "Identifier",
						name: key,
					},
					value,
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
