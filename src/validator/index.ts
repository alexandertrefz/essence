import { matchesType } from "../helpers"
import { common } from "../interfaces"

type CurrentFunctionContext =
	| common.typed.FunctionDefinitionNode
	| common.typed.GenericFunctionDefinitionNode
	| null

export const validate = (
	program: common.typed.Program,
): common.typed.Program => {
	program.implementation.nodes.map((node) =>
		validateImplementationNode(node, null),
	)

	return program
}

function validateImplementationNode(
	node: common.typed.ImplementationNode,
	currentFunctionContext: CurrentFunctionContext,
): common.typed.ImplementationNode {
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
		case "NothingValue":
		case "FunctionValue":
		case "ListValue":
		case "Lookup":
		case "Identifier":
		case "Self":
		case "MethodLookup":
		case "Match":
			return validateExpression(node)
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement":
		case "TypeDefinitionStatement":
		case "NamespaceDefinitionStatement":
		case "IfElseStatement":
		case "IfStatement":
		case "ReturnStatement":
		case "FunctionStatement":
			return validateStatement(node, currentFunctionContext)
	}
}

// #region Expressions

function validateExpression(
	node: common.typed.ExpressionNode,
): common.typed.ExpressionNode {
	switch (node.nodeType) {
		case "NativeFunctionInvocation":
			return validateNativeFunctionInvocation(node)
		case "MethodInvocation":
			return validateMethodInvocation(node)
		case "FunctionInvocation":
			return validateFunctionInvocation(node)
		case "MethodLookup":
			return validateMethodLookup(node)
		case "Lookup":
			return validateLookup(node)
		case "Match":
			return validateMatch(node)
		case "Combination":
		case "RecordValue":
		case "StringValue":
		case "IntegerValue":
		case "FractionValue":
		case "BooleanValue":
		case "NothingValue":
		case "FunctionValue":
		case "ListValue":
		case "Identifier":
		case "Self":
			// these nodes dont need any validation
			return node
	}
}

function validateNativeFunctionInvocation(
	node: common.typed.NativeFunctionInvocationNode,
): common.typed.NativeFunctionInvocationNode {
	const functionType = node.name.type

	if (
		functionType.type === "Function" ||
		functionType.type === "GenericFunction"
	) {
		validateSimpleFunctionInvocation(functionType, node.arguments)
	} else {
		throw new Error("NativeFunctionInvocation: Identifier isn't a function")
	}

	return node
}

function validateMethodInvocation(
	node: common.typed.MethodInvocationNode,
): common.typed.MethodInvocationNode {
	const methodType = node.name.type
	const methodArguments = [
		{ name: null, type: node.name.base.type },
		...node.arguments,
	]

	if (
		methodType.type !== "SimpleMethod" &&
		methodType.type !== "OverloadedMethod"
	) {
		throw new Error("MethodInvocation: Identifier isn't a function")
	}

	for (let argumentNode of node.arguments) {
		validateExpression(argumentNode.value)
	}

	validateMethodLookup(node.name)

	if (methodType.type === "OverloadedMethod") {
		let lastIterationHadError = false
		let index = 0

		for (let overload of methodType.overloads) {
			lastIterationHadError = false

			if (overload.parameterTypes.length !== methodArguments.length) {
				lastIterationHadError = true
				index++
				continue
			}

			for (let i = 0; i < overload.parameterTypes.length; i++) {
				if (
					overload.parameterTypes[i].name !== methodArguments[i].name ||
					!matchesType(overload.parameterTypes[i].type, methodArguments[i].type)
				) {
					lastIterationHadError = true
					break
				}
			}

			if (lastIterationHadError === false) {
				break
			}

			index++
		}

		if (lastIterationHadError) {
			throw new Error(
				"MethodInvocation: Passed arguments do not match any overload",
			)
		} else {
			node.overloadedMethodIndex = index
		}
	} else {
		if (methodType.parameterTypes.length !== methodArguments.length) {
			throw new Error("MethodInvocation: Amount of arguments doesn't match")
		}

		for (let i = 0; i < methodType.parameterTypes.length; i++) {
			if (
				methodType.parameterTypes[i].name !== methodArguments[i].name ||
				!matchesType(methodType.parameterTypes[i].type, methodArguments[i].type)
			) {
				if (i === 0) {
					throw new Error("MethodInvocation: BaseType mismatch")
				} else {
					throw new Error(
						`MethodInvocation: ArgumentType mismatch at argument ${i}`,
					)
				}
			}
		}
	}

	return node
}

function validateFunctionInvocation(
	node: common.typed.FunctionInvocationNode,
): common.typed.FunctionInvocationNode {
	const functionType = node.name.type

	for (let argumentNode of node.arguments) {
		validateExpression(argumentNode.value)
	}

	if (
		functionType.type !== "Function" &&
		functionType.type !== "SimpleMethod" &&
		functionType.type !== "StaticMethod" &&
		functionType.type !== "OverloadedMethod" &&
		functionType.type !== "OverloadedStaticMethod"
	) {
		throw new Error("FunctionInvocation: Identifier isn't a Function or Method")
	}

	if (
		functionType.type === "Function" ||
		functionType.type === "StaticMethod"
	) {
		validateSimpleFunctionInvocation(functionType, node.arguments)
	} else {
		// Dynamic methods, being called in a manually via `.` are being validated here,
		// as opposed to methods that are being called with `::` which get validated by `validateMethodInvocation`
		if (
			functionType.type === "OverloadedMethod" ||
			functionType.type === "OverloadedStaticMethod"
		) {
			let lastIterationHadError = false
			let index = 0

			for (let overload of functionType.overloads) {
				lastIterationHadError = false

				if (overload.parameterTypes.length !== node.arguments.length) {
					lastIterationHadError = true
					index++
					continue
				}

				for (let i = 0; i < overload.parameterTypes.length; i++) {
					if (
						overload.parameterTypes[i].name !== node.arguments[i].name ||
						!matchesType(
							overload.parameterTypes[i].type,
							node.arguments[i].type,
						)
					) {
						lastIterationHadError = true
						break
					}
				}

				if (lastIterationHadError === false) {
					break
				}

				index++
			}

			if (lastIterationHadError) {
				throw new Error(
					"MethodInvocation: Passed arguments do not match any overload",
				)
			} else {
				node.overloadedMethodIndex = index
			}
		} else {
			if (functionType.parameterTypes.length !== node.arguments.length) {
				throw new Error("FunctionInvocation: Amount of arguments doesn't match")
			}

			for (let i = 0; i < functionType.parameterTypes.length; i++) {
				if (
					functionType.parameterTypes[i].name !== node.arguments[i].name ||
					!matchesType(
						functionType.parameterTypes[i].type,
						node.arguments[i].type,
					)
				) {
					throw new Error(
						`FunctionInvocation: ArgumentType mismatch at argument ${i + 1}`,
					)
				}
			}
		}
	}

	return node
}

function validateGenericFunctionDefinition(
	node: common.typed.GenericFunctionDefinitionNode,
): common.typed.GenericFunctionDefinitionNode {
	node.body.map((bodyNode) => validateImplementationNode(bodyNode, node))

	return node
}

function validateFunctionDefinition(
	node: common.typed.FunctionDefinitionNode,
): common.typed.FunctionDefinitionNode {
	node.body.map((bodyNode) => validateImplementationNode(bodyNode, node))

	return node
}

function validateLookup(
	node: common.typed.LookupNode,
): common.typed.LookupNode {
	validateExpression(node.base)

	return node
}

function validateMethodLookup(
	node: common.typed.MethodLookupNode,
): common.typed.MethodLookupNode {
	validateExpression(node.base)

	return node
}

function validateMatch(node: common.typed.MatchNode): common.typed.MatchNode {
	validateExpression(node.value)

	if (node.value.type.type !== "UnionType") {
		throw new Error("You can only use Match-Expressions on Union Types.")
	}

	for (let handler of node.handlers) {
		for (let bodyNode of handler.body) {
			validateImplementationNode(bodyNode, {
				nodeType: "FunctionDefinition",
				parameters: [],
				body: handler.body,
				returnType: handler.returnType,
			})
		}
	}

	return node
}

// #endregion

// #region Statements

function validateStatement(
	node: common.typed.StatementNode,
	currentFunctionContext: CurrentFunctionContext,
): common.typed.StatementNode {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
			return validateConstantDeclarationStatement(node)
		case "VariableDeclarationStatement":
			return validateVariableDeclarationStatement(node)
		case "VariableAssignmentStatement":
			return validateVariableAssignmentStatement(node)
		case "TypeDefinitionStatement":
			return validateTypeDefinitionStatement(node)
		case "NamespaceDefinitionStatement":
			return validateNamespaceDefinitionStatement(node)
		case "IfElseStatement":
			return validateIfElseStatementNode(node, currentFunctionContext)
		case "IfStatement":
			return validateIfStatement(node, currentFunctionContext)
		case "ReturnStatement":
			return validateReturnStatement(node, currentFunctionContext)
		case "FunctionStatement":
			return validateFunctionStatement(node)
	}
}

function validateConstantDeclarationStatement(
	node: common.typed.ConstantDeclarationStatementNode,
): common.typed.ConstantDeclarationStatementNode {
	if (node.declaredType !== null) {
		if (!matchesType(node.declaredType, node.value.type)) {
			throw new Error(
				`Wrong Assignment Value Type for Constant ${node.name.content}`,
			)
		}
	}

	validateExpression(node.value)

	return node
}

function validateVariableDeclarationStatement(
	node: common.typed.VariableDeclarationStatementNode,
): common.typed.VariableDeclarationStatementNode {
	if (node.declaredType !== null) {
		if (!matchesType(node.declaredType, node.value.type)) {
			throw new Error(
				`Wrong Assignment Value Type for Variable ${node.name.content}
Expected

${Bun.inspect(node.declaredType)}

but received

${Bun.inspect(node.value.type)}

`,
			)
		}
	}

	validateExpression(node.value)

	return node
}

function validateVariableAssignmentStatement(
	node: common.typed.VariableAssignmentStatementNode,
): common.typed.VariableAssignmentStatementNode {
	if (!matchesType(node.name.type, node.value.type)) {
		throw new Error(
			`Wrong Assignment Value Type for Variable ${node.name.content}
Expected

${Bun.inspect(node.name.type)}

but received

${Bun.inspect(node.value.type)}

`,
		)
	}

	validateExpression(node.value)

	return node
}

function validateTypeDefinitionStatement(
	node: common.typed.TypeDefinitionStatementNode,
): common.typed.TypeDefinitionStatementNode {
	for (let methodName in node.methods) {
		let method = node.methods[methodName]

		if (
			method.nodeType === "SimpleMethod" ||
			method.nodeType === "StaticMethod"
		) {
			if (method.method.value.nodeType === "FunctionDefinition") {
				validateFunctionDefinition(method.method.value)
			} else {
				validateGenericFunctionDefinition(method.method.value)
			}
		} else {
			method.methods.map((overloadedMethod) => {
				if (overloadedMethod.value.nodeType === "FunctionDefinition") {
					validateFunctionDefinition(overloadedMethod.value)
				} else {
					validateGenericFunctionDefinition(overloadedMethod.value)
				}
			})
		}
	}

	return node
}

function validateNamespaceDefinitionStatement(
	node: common.typed.NamespaceDefinitionStatementNode,
): common.typed.NamespaceDefinitionStatementNode {
	for (let methodName in node.methods) {
		let method = node.methods[methodName]

		if (method.nodeType === "StaticMethod") {
			if (method.method.value.nodeType === "FunctionDefinition") {
				validateFunctionDefinition(method.method.value)
			} else {
				validateGenericFunctionDefinition(method.method.value)
			}
		} else {
			method.methods.map((overloadedMethod) => {
				if (overloadedMethod.value.nodeType === "FunctionDefinition") {
					validateFunctionDefinition(overloadedMethod.value)
				} else {
					validateGenericFunctionDefinition(overloadedMethod.value)
				}
			})
		}
	}

	return node
}

function validateIfElseStatementNode(
	node: common.typed.IfElseStatementNode,
	currentFunctionContext: CurrentFunctionContext,
): common.typed.IfElseStatementNode {
	if (
		!(
			node.condition.type.type === "Primitive" &&
			node.condition.type.primitive === "Boolean"
		)
	) {
		throw new Error("If Condition has to be a Boolean")
	}

	validateExpression(node.condition)

	node.trueBody.map((node) =>
		validateImplementationNode(node, currentFunctionContext),
	)
	node.falseBody.map((node) =>
		validateImplementationNode(node, currentFunctionContext),
	)

	return node
}

function validateIfStatement(
	node: common.typed.IfStatementNode,
	currentFunctionContext: CurrentFunctionContext,
): common.typed.IfStatementNode {
	if (
		!(
			node.condition.type.type === "Primitive" &&
			node.condition.type.primitive === "Boolean"
		)
	) {
		throw new Error("If Condition has to be a Boolean")
	}

	validateExpression(node.condition)

	node.body.map((node) =>
		validateImplementationNode(node, currentFunctionContext),
	)

	return node
}

function validateReturnStatement(
	node: common.typed.ReturnStatementNode,
	currentFunctionContext: CurrentFunctionContext,
): common.typed.ReturnStatementNode {
	if (currentFunctionContext === null) {
		throw new Error("Top level returns are not permitted.")
	}

	if (!matchesType(currentFunctionContext.returnType, node.expression.type)) {
		throw new Error(
			"Type of returned expression doesn't match the declared return type.",
		)
	}

	validateExpression(node.expression)

	return node
}

function validateFunctionStatement(
	node: common.typed.FunctionStatementNode,
): common.typed.FunctionStatementNode {
	validateFunctionDefinition(node.value)

	return node
}

// #endregion

// #region Helpers

function validateSimpleFunctionInvocation(
	functionType:
		| common.FunctionType
		| common.StaticMethodType
		| common.GenericFunctionType,
	argumentNodes: common.typed.ArgumentNode[],
) {
	for (let argumentNode of argumentNodes) {
		validateExpression(argumentNode.value)
	}

	if (functionType.type === "GenericFunction") {
		functionType = inferFunctionType(functionType, argumentNodes)
	}

	if (functionType.parameterTypes.length !== argumentNodes.length) {
		throw new Error("FunctionInvocation: Amount of arguments doesn't match")
	}

	for (let i = 0; i < functionType.parameterTypes.length; i++) {
		if (
			functionType.parameterTypes[i].name !== argumentNodes[i].name ||
			!matchesType(functionType.parameterTypes[i].type, argumentNodes[i].type)
		) {
			throw new Error(
				`FunctionInvocation: ArgumentType mismatch at argument ${i + 1}`,
			)
		}
	}
}

// TODO: The enricher should probably replace GenericFunctionNodes with the Resolved Variants so we dont have to duplicate this function
function inferFunctionType(
	genericFunctionType: common.GenericFunctionType,
	argumentTypes: common.typed.ArgumentNode[],
): common.FunctionType {
	let inferredGenerics: Record<string, common.Type> = {}

	let inferredFunctionType: common.FunctionType = {
		type: "Function",
		parameterTypes: structuredClone(genericFunctionType.parameterTypes),
		returnType: structuredClone(genericFunctionType.returnType),
	}

	for (let i = 0; i < genericFunctionType.parameterTypes.length; i++) {
		let parameter = genericFunctionType.parameterTypes[i]
		if (parameter.type.type === "Generic") {
			if (!(parameter.type.name in inferredGenerics)) {
				inferredGenerics[parameter.type.name] = argumentTypes[i].type
			}
		}
	}

	if (
		Object.entries(inferredGenerics).length !==
		genericFunctionType.generics.length
	) {
		throw new Error("Mismatch in amount of defined and declared Generics.")
	}

	for (let i = 0; i < inferredFunctionType.parameterTypes.length; i++) {
		let parameter = inferredFunctionType.parameterTypes[i]

		if (parameter.type.type === "Generic") {
			parameter.type = inferredGenerics[parameter.type.name]
		}
	}

	if (inferredFunctionType.returnType.type === "Generic") {
		inferredFunctionType.returnType =
			inferredGenerics[inferredFunctionType.returnType.name]
	}

	return inferredFunctionType
}
// #endregion
