import { common } from "../interfaces"
import * as estree from "estree"

import { generate } from "escodegen"

export default function rewrite(nodes: Array<common.typedSimple.Node>): string {
	const program: estree.Program = {
		type: "Program",
		sourceType: "module",
		body: rewriteProgramNodes(nodes),
	}

	return generate(program, {
		format: {
			indent: {
				style: "	",
				base: 0,
				adjustMultilineComment: false,
			},
			newline: "\n",
			space: " ",
			quotes: "double",
		},
	})
}

function rewriteProgramNodes(
	nodes: Array<common.typedSimple.Node>,
): Array<estree.ModuleDeclaration | estree.Statement> {
	return nodes.map(node => rewriteStatement(node))
}

////////////////
/* Statements */
////////////////

function rewriteStatement(node: common.typedSimple.Node): estree.Statement {
	switch (node.nodeType) {
		case "VariableDeclarationStatement":
			return rewriteVariableDeclarationStatement(node)
		case "TypeDefinitionStatement":
			return rewriteTypeDefinitionStatement(node)
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

function rewriteTypeDefinitionStatement(node: common.typedSimple.TypeDefinitionStatementNode): estree.ClassDeclaration {
	return {
		type: "ClassDeclaration",
		id: rewriteIdentifier(node.name),
		superClass: null,
		body: {
			type: "ClassBody",
			body: Object.entries(node.methods).map<estree.MethodDefinition>(([name, method]) => {
				return {
					type: "MethodDefinition",
					key: {
						type: "Identifier",
						name,
					},
					value: rewriteFunctionExpression(method.method.value),
					kind: "method",
					computed: false,
					static: true,
				}
			}),
		},
	}
}

function rewriteChoiceStatement(node: common.typedSimple.ChoiceStatementNode): estree.IfStatement {
	let alternate

	if (node.falseBody.length === 1 && node.falseBody[0].nodeType === "ChoiceStatement") {
		alternate = rewriteStatement(node.falseBody[0])
	} else {
		alternate = rewriteBlockStatement(node.falseBody)
	}

	return {
		type: "IfStatement",
		test: rewriteExpression(node.condition),
		consequent: rewriteBlockStatement(node.trueBody),
		alternate,
	}
}

function rewriteReturnStatement(node: common.typedSimple.ReturnStatementNode): estree.ReturnStatement {
	return {
		type: "ReturnStatement",
		argument: rewriteExpression(node.expression),
	}
}

function rewriteFunctionStatement(node: common.typedSimple.FunctionStatementNode): estree.FunctionDeclaration {
	return {
		type: "FunctionDeclaration",
		id: rewriteIdentifier(node.name),
		params: node.value.parameters.map(param => rewriteParameter(param)),
		body: rewriteBlockStatement(node.value.body),
	}
}

function rewriteExpressionStatement(
	node: common.typedSimple.ExpressionNode | common.typedSimple.VariableAssignmentStatementNode,
): estree.ExpressionStatement {
	return {
		type: "ExpressionStatement",
		expression: rewriteExpression(node),
	}
}

/////////////////
/* Expressions */
/////////////////

function rewriteExpression(
	node: common.typedSimple.ExpressionNode | common.typedSimple.VariableAssignmentStatementNode,
): estree.Expression {
	switch (node.nodeType) {
		case "VariableAssignmentStatement":
			return rewriteVariableAssignmentStatement(node)
		case "NativeFunctionInvocation":
			return rewriteNativeFunctionInvocation(node)
		case "FunctionInvocation":
			return rewriteFunctionInvocation(node)
		case "Combination":
			return rewriteCombination(node)
		case "RecordValue":
			return rewriteRecordValue(node)
		case "StringValue":
			return rewriteStringValue(node)
		case "NumberValue":
			return rewriteNumberValue(node)
		case "BooleanValue":
			return rewriteBooleanValue(node)
		case "FunctionValue":
			return rewriteFunctionValue(node)
		case "ArrayValue":
			return rewriteArrayValue(node)
		case "Lookup":
			return rewriteLookup(node)
		case "Identifier":
			return rewriteIdentifier(node)
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

function rewriteNativeFunctionInvocation(node: common.typedSimple.NativeFunctionInvocationNode): estree.CallExpression {
	let callee: estree.MemberExpression

	if (node.name.nodeType === "Identifier") {
		callee = {
			type: "MemberExpression",
			object: {
				type: "Identifier",
				name: "__Runtime",
			},
			property: rewriteIdentifier(node.name),
			computed: false,
		}
	} else {
		throw Error("Lookups on NativeFunctionIvocations are not implemented yet.")
	}

	return {
		type: "CallExpression",
		callee,
		arguments: node.arguments.map(arg => rewriteArgument(arg)),
	}
}

function rewriteFunctionInvocation(node: common.typedSimple.FunctionInvocationNode): estree.CallExpression {
	return {
		type: "CallExpression",
		callee: rewriteExpression(node.name),
		arguments: node.arguments.map(arg => rewriteArgument(arg)),
	}
}

function rewriteCombination(node: common.typedSimple.CombinationNode): estree.CallExpression {
	return {
		type: "CallExpression",
		callee: {
			type: "MemberExpression",
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

function rewriteRecordValue(node: common.typedSimple.RecordValueNode): estree.ObjectExpression {
	return {
		type: "ObjectExpression",
		properties: Object.entries(node.members).map<estree.Property>(([key, value]) => {
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
		}),
	}
}

function rewriteStringValue(node: common.typedSimple.StringValueNode): estree.Literal {
	return {
		type: "Literal",
		value: node.value,
	}
}

function rewriteNumberValue(node: common.typedSimple.NumberValueNode): estree.Literal {
	return {
		type: "Literal",
		value: Number.parseFloat(node.value),
	}
}

function rewriteBooleanValue(node: common.typedSimple.BooleanValueNode): estree.Literal {
	return {
		type: "Literal",
		value: node.value,
	}
}

function rewriteFunctionValue(node: common.typedSimple.FunctionValueNode): estree.FunctionExpression {
	return rewriteFunctionExpression(node.value)
}

function rewriteArrayValue(node: common.typedSimple.ArrayValueNode): estree.ArrayExpression {
	return {
		type: "ArrayExpression",
		elements: node.values.map(expr => rewriteExpression(expr)),
	}
}

function rewriteLookup(node: common.typedSimple.LookupNode): estree.MemberExpression {
	let object: estree.Expression

	if (node.base.type.type === "Type" && node.base.type.definition.type === "BuiltIn") {
		object = {
			type: "MemberExpression",
			object: {
				type: "Identifier",
				name: "__Runtime",
			},
			property: rewriteIdentifier(node.base as common.typedSimple.IdentifierNode),
			computed: false,
		}
	} else {
		object = rewriteExpression(node.base)
	}

	return {
		type: "MemberExpression",
		object,
		property: rewriteIdentifier(node.member),
		computed: false,
	}
}

function rewriteIdentifier(node: common.typedSimple.IdentifierNode): estree.Identifier {
	return {
		type: "Identifier",
		name: `$${node.name}`,
	}
}

/////////////
/* Helpers */
/////////////

function rewriteBlockStatement(nodes: Array<common.typedSimple.Node>): estree.BlockStatement {
	return {
		type: "BlockStatement",
		body: nodes.map(node => rewriteStatement(node)).filter(value => !!value),
	}
}

function rewriteParameter(parameter: common.typedSimple.ParameterNode): estree.Pattern {
	return rewriteIdentifier(parameter.internalName)
}

function rewriteFunctionExpression(node: common.typedSimple.FunctionDefinitionNode): estree.FunctionExpression {
	return {
		type: "FunctionExpression",
		id: null,
		params: node.parameters.map(param => rewriteParameter(param)),
		body: rewriteBlockStatement(node.body),
	}
}

function rewriteArgument(node: common.typedSimple.ArgumentNode): estree.Expression {
	return rewriteExpression(node.value)
}
