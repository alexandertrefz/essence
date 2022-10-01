import { common } from "../interfaces";
import { resolveOverloadedMethodName } from "../helpers";

export const simplify = (
	program: common.typed.Program,
): common.typedSimple.Program => {
	return {
		nodeType: "Program",
		implementation: simplifyImplementationSection(program.implementation),
	};
};

function simplifyImplementationSection(
	implementation: common.typed.ImplementationSectionNode,
): common.typedSimple.ImplementationSectionNode {
	return {
		nodeType: "ImplementationSection",
		nodes: implementation.nodes.map((node) => simplifyImplementationNode(node)),
	};
}

function simplifyImplementationNode(
	node: common.typed.ImplementationNode,
): common.typedSimple.ImplementationNode {
	switch (node.nodeType) {
		case "NativeFunctionInvocation":
		case "MethodInvocation":
		case "FunctionInvocation":
		case "Combination":
		case "RecordValue":
		case "StringValue":
		case "IntegerValue":
		case "FractionValue":
		case "BooleanValue":
		case "FunctionValue":
		case "ListValue":
		case "Lookup":
		case "Identifier":
		case "Self":
		case "MethodLookup":
			return simplifyExpression(node);
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement":
		case "TypeDefinitionStatement":
		case "IfElseStatement":
		case "IfStatement":
		case "ReturnStatement":
		case "FunctionStatement":
			return simplifyStatement(node);
	}
}

// #region Expressions

function simplifyExpression(
	node: common.typed.ExpressionNode,
): common.typedSimple.ExpressionNode {
	switch (node.nodeType) {
		case "NativeFunctionInvocation":
			return simplifyNativeFunctionInvocation(node);
		case "MethodInvocation":
			return simplifyMethodInvocation(node);
		case "FunctionInvocation":
			return simplifyFunctionInvocation(node);
		case "Combination":
			return simplifyCombination(node);
		case "RecordValue":
			return simplifyRecordValue(node);
		case "StringValue":
			return simplifyStringValue(node);
		case "IntegerValue":
			return simplifyIntegerValue(node);
		case "FractionValue":
			return simplifyFractionValue(node);
		case "BooleanValue":
			return simplifyBooleanValue(node);
		case "FunctionValue":
			return simplifyFunctionValue(node);
		case "ListValue":
			return simplifyListValue(node);
		case "Lookup":
			return simplifyLookup(node);
		case "Identifier":
			return simplifyIdentifier(node);
		case "Self":
			return simplifySelf(node);
		case "MethodLookup":
			return simplifyMethodLookup(node);
	}
}

function simplifyNativeFunctionInvocation(
	node: common.typed.NativeFunctionInvocationNode,
): common.typedSimple.NativeFunctionInvocationNode {
	return {
		nodeType: "NativeFunctionInvocation",
		name: simplifyIdentifier(node.name),
		arguments: node.arguments.map((arg) => simplifyArgument(arg)),
		type: node.type,
	};
}

function simplifyMethodInvocation(
	node: common.typed.MethodInvocationNode,
): common.typedSimple.FunctionInvocationNode {
	if (node.overloadedMethodIndex !== null) {
		node.name.member.content = resolveOverloadedMethodName(
			node.name.member.content,
			node.overloadedMethodIndex,
		);
	}

	return {
		nodeType: "FunctionInvocation",
		name: simplifyExpression(node.name),
		arguments: [
			{
				nodeType: "Argument",
				name: "@",
				value: simplifyExpression(node.name.base),
			},
			...node.arguments.map((arg) => simplifyArgument(arg)),
		],
		type: node.type,
	};
}

function simplifyFunctionInvocation(
	node: common.typed.FunctionInvocationNode,
): common.typedSimple.FunctionInvocationNode {
	if (node.overloadedMethodIndex !== null && node.name.nodeType === "Lookup") {
		node.name.member.content = resolveOverloadedMethodName(
			node.name.member.content,
			node.overloadedMethodIndex,
		);
	}

	return {
		nodeType: "FunctionInvocation",
		name: simplifyExpression(node.name),
		arguments: node.arguments.map((arg) => simplifyArgument(arg)),
		type: node.type,
	};
}

function simplifyCombination(
	node: common.typed.CombinationNode,
): common.typedSimple.CombinationNode {
	return {
		nodeType: "Combination",
		lhs: simplifyExpression(node.lhs),
		rhs: simplifyExpression(node.rhs),
		type: node.type,
	};
}

function simplifyRecordValue(
	node: common.typed.RecordValueNode,
): common.typedSimple.RecordValueNode {
	return {
		nodeType: "RecordValue",
		type: node.declaredType !== null ? node.declaredType : node.type,
		members: simplifyMembers(node.members),
	};
}

function simplifyStringValue(
	node: common.typed.StringValueNode,
): common.typedSimple.StringValueNode {
	return {
		nodeType: "StringValue",
		value: node.value,
		type: node.type,
	};
}

function simplifyIntegerValue(
	node: common.typed.IntegerValueNode,
): common.typedSimple.IntegerValueNode {
	return {
		nodeType: "IntegerValue",
		value: node.value,
		type: node.type,
	};
}

function simplifyFractionValue(
	node: common.typed.FractionValueNode,
): common.typedSimple.FractionValueNode {
	return {
		nodeType: "FractionValue",
		numerator: node.numerator,
		denominator: node.denominator,
		type: node.type,
	};
}

function simplifyBooleanValue(
	node: common.typed.BooleanValueNode,
): common.typedSimple.BooleanValueNode {
	return {
		nodeType: "BooleanValue",
		value: node.value,
		type: node.type,
	};
}

function simplifyFunctionValue(
	node: common.typed.FunctionValueNode,
): common.typedSimple.FunctionValueNode {
	let value;

	if (node.value.nodeType === "FunctionDefinition") {
		value = simplifyFunctionDefinition(node.value);
	} else {
		value = simplifyGenericFunctionDefinition(node.value);
	}

	return {
		nodeType: "FunctionValue",
		value,
		type: node.type,
	};
}

function simplifyListValue(
	node: common.typed.ListValueNode,
): common.typedSimple.ListValueNode {
	return {
		nodeType: "ListValue",
		values: node.values.map((expr) => simplifyExpression(expr)),
		type: node.type,
	};
}

function simplifyLookup(
	node: common.typed.LookupNode,
): common.typedSimple.LookupNode {
	return {
		nodeType: "Lookup",
		base: simplifyExpression(node.base),
		member: simplifyIdentifier(node.member),
		type: node.type,
	};
}

function simplifyIdentifier(
	node: common.typed.IdentifierNode,
): common.typedSimple.IdentifierNode {
	return {
		nodeType: "Identifier",
		name: node.content,
		type: node.type,
	};
}

function simplifySelf(
	node: common.typed.SelfNode,
): common.typedSimple.IdentifierNode {
	return {
		nodeType: "Identifier",
		name: "_self",
		type: node.type,
	};
}

function simplifyMethodLookup(
	node: common.typed.MethodLookupNode,
): common.typedSimple.LookupNode {
	return {
		nodeType: "Lookup",
		base: {
			nodeType: "Identifier",
			name: node.baseType.name,
			type: node.baseType,
		},
		member: simplifyIdentifier(node.member),
		type: node.type,
	};
}

// #endregion

// #region Statements

function simplifyStatement(
	node: common.typed.StatementNode,
): common.typedSimple.StatementNode {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
			return simplifyConstantDeclarationStatement(node);
		case "VariableDeclarationStatement":
			return simplifyVariableDeclarationStatement(node);
		case "VariableAssignmentStatement":
			return simplifyVariableAssignmentStatement(node);
		case "TypeDefinitionStatement":
			return simplifyTypeDefinitionStatement(node);
		case "IfElseStatement":
			return simplifyChoice(node);
		case "IfStatement":
			return simplifyChoice(node);
		case "ReturnStatement":
			return simplifyReturnStatement(node);
		case "FunctionStatement":
			return simplifyFunctionStatement(node);
	}
}

function simplifyConstantDeclarationStatement(
	node: common.typed.ConstantDeclarationStatementNode,
): common.typedSimple.VariableDeclarationStatementNode {
	return {
		nodeType: "VariableDeclarationStatement",
		name: simplifyIdentifier(node.name),
		value: simplifyExpression(node.value),
		type: node.type,
		isConstant: true,
	};
}

function simplifyVariableDeclarationStatement(
	node: common.typed.VariableDeclarationStatementNode,
): common.typedSimple.VariableDeclarationStatementNode {
	return {
		nodeType: "VariableDeclarationStatement",
		name: simplifyIdentifier(node.name),
		value: simplifyExpression(node.value),
		type: node.type,
		isConstant: false,
	};
}

function simplifyVariableAssignmentStatement(
	node: common.typed.VariableAssignmentStatementNode,
): common.typedSimple.VariableAssignmentStatementNode {
	return {
		nodeType: "VariableAssignmentStatement",
		name: simplifyIdentifier(node.name),
		value: simplifyExpression(node.value),
	};
}

function simplifyTypeDefinitionStatement(
	node: common.typed.TypeDefinitionStatementNode,
): common.typedSimple.TypeDefinitionStatementNode {
	return {
		nodeType: "TypeDefinitionStatement",
		name: simplifyIdentifier(node.name),
		properties: node.properties,
		methods: simplifyMethods(node.methods, node.type),
		type: node.type,
	};
}

function simplifyChoice(
	node: common.typed.IfElseStatementNode | common.typed.IfStatementNode,
): common.typedSimple.ChoiceStatementNode {
	let convertedNode: common.typed.IfElseStatementNode;
	if (node.nodeType === "IfStatement") {
		convertedNode = {
			nodeType: "IfElseStatement",
			condition: node.condition,
			trueBody: node.body,
			falseBody: [],
			position: node.position,
		};
	} else {
		convertedNode = node;
	}

	return {
		nodeType: "ChoiceStatement",
		condition: simplifyExpression(convertedNode.condition),
		trueBody: convertedNode.trueBody.map(
			(node) => simplifyImplementationNode(node),
		),
		falseBody: convertedNode.falseBody.map(
			(node) => simplifyImplementationNode(node),
		),
	};
}

function simplifyReturnStatement(
	node: common.typed.ReturnStatementNode,
): common.typedSimple.ReturnStatementNode {
	return {
		nodeType: "ReturnStatement",
		expression: simplifyExpression(node.expression),
	};
}

function simplifyFunctionStatement(
	node: common.typed.FunctionStatementNode,
): common.typedSimple.FunctionStatementNode {
	return {
		nodeType: "FunctionStatement",
		name: simplifyIdentifier(node.name),
		value: simplifyFunctionDefinition(node.value),
	};
}

// #endregion

// #region Helpers

function simplifyMembers(members: {
	[key: string]: common.typed.ExpressionNode;
}): {
	[key: string]: common.typedSimple.ExpressionNode;
} {
	let result: { [key: string]: common.typedSimple.ExpressionNode } = {};

	for (let [memberKey, memberExpression] of Object.entries(members)) {
		result[memberKey] = simplifyExpression(memberExpression);
	}

	return result;
}

function simplifyMethods(
	methods: common.typed.Methods,
	type: common.Type,
): common.typedSimple.Methods {
	let result: common.typedSimple.Methods = {};

	for (let [memberKey, memberValue] of Object.entries(methods)) {
		if (
			memberValue.nodeType === "OverloadedMethod" ||
			memberValue.nodeType === "OverloadedStaticMethod"
		) {
			memberValue.methods.forEach((method, index) => {
				let newMethod = simplifyFunctionValue(method);

				if (memberValue.nodeType === "OverloadedMethod") {
					newMethod.value.parameters.unshift({
						nodeType: "Parameter",
						externalName: null,
						internalName: {
							nodeType: "Identifier",
							name: "_self",
							type,
						},
					});
				}

				result[resolveOverloadedMethodName(memberKey, index)] = {
					method: newMethod,
					isStatic: memberValue.nodeType === "OverloadedStaticMethod",
				};
			});
		} else {
			let method = simplifyFunctionValue(memberValue.method);

			if (memberValue.nodeType === "SimpleMethod") {
				method.value.parameters.unshift({
					nodeType: "Parameter",
					externalName: null,
					internalName: {
						nodeType: "Identifier",
						name: "_self",
						type,
					},
				});
			}

			result[memberKey] = {
				method,
				isStatic: memberValue.nodeType === "StaticMethod",
			};
		}
	}

	return result;
}

function simplifyParameter(
	node: common.typed.ParameterNode,
): common.typedSimple.ParameterNode {
	return {
		nodeType: "Parameter",
		externalName: node.externalName
			? simplifyIdentifier(node.externalName)
			: null,
		internalName: simplifyIdentifier(node.internalName),
	};
}

function simplifyGenericDeclaration(
	node: common.typed.GenericDeclarationNode,
): common.typedSimple.GenericDeclarationNode {
	return {
		nodeType: "GenericDeclaration",
		name: node.name,
		defaultType: node.defaultType,
	};
}

function simplifyGenericFunctionDefinition(
	node: common.typed.GenericFunctionDefinitionNode,
): common.typedSimple.GenericFunctionDefinitionNode {
	return {
		nodeType: "GenericFunctionDefinition",
		generics: node.generics.map((param) => simplifyGenericDeclaration(param)),
		parameters: node.parameters.map((param) => simplifyParameter(param)),
		body: node.body.map((node) => simplifyImplementationNode(node)),
		returnType: node.returnType,
	};
}

function simplifyFunctionDefinition(
	node: common.typed.FunctionDefinitionNode,
): common.typedSimple.FunctionDefinitionNode {
	return {
		nodeType: "FunctionDefinition",
		parameters: node.parameters.map((param) => simplifyParameter(param)),
		body: node.body.map((node) => simplifyImplementationNode(node)),
		returnType: node.returnType,
	};
}

function simplifyArgument(
	node: common.typed.ArgumentNode,
): common.typedSimple.ArgumentNode {
	return {
		nodeType: "Argument",
		name: node.name,
		value: simplifyExpression(node.value),
	};
}
// #endregion
