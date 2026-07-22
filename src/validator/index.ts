import {
	collectDiagnostics,
	reportError,
	reportWarning,
} from "../diagnostics/index"
import {
	createInferenceContext,
	flattenUnionMembers,
	type MatchableArgument,
	matchArguments,
	matchesType,
} from "../helpers/index"
import type { common } from "../interfaces/index"

type CurrentFunctionContext = common.typed.FunctionDefinitionNode | null

export const validate = (
	program: common.typed.Program,
): Array<common.Diagnostic> => {
	let { diagnostics } = collectDiagnostics(() => {
		for (let node of program.implementation.nodes) {
			// NOTE: Expected errors are reported as Diagnostics and recovered
			// from in place — anything thrown past this point is a Compiler
			// bug. It is reported as a Diagnostic as well, so that a single
			// broken statement can not take down the validation of the
			// remaining Program.
			try {
				validateImplementationNode(node, null)
			} catch (error) {
				reportError(
					`Internal Compiler Error: ${
						error instanceof Error ? error.message : String(error)
					}`,
					node.position,
				)
			}
		}
	})

	return diagnostics
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
		case "RationalValue":
		case "BooleanValue":
		case "NothingValue":
		case "FunctionValue":
		case "ListValue":
		case "Lookup":
		case "Identifier":
		case "Self":
		case "Match":
		case "CaseValue":
			return validateExpression(node)
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement":
		case "TypeAliasStatement":
		case "ChoiceDeclarationStatement":
		case "ProtocolDeclarationStatement":
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
		case "Lookup":
			return validateLookup(node)
		case "Match":
			return validateMatch(node)
		case "CaseValue":
			return validateCaseValue(node)
		case "FunctionValue":
			return validateFunctionValue(node)
		case "RationalValue":
			return validateRationalValue(node)
		case "RecordValue":
			for (let member of Object.values(node.members)) {
				validateNoBoundFunctionValue(member)
			}

			return node
		case "ListValue":
			for (let value of node.values) {
				validateNoBoundFunctionValue(value)
			}

			return node
		case "Combination":
		case "StringValue":
		case "IntegerValue":
		case "BooleanValue":
		case "NothingValue":
		case "Identifier":
		case "Self":
			// these nodes dont need any validation
			return node
	}
}

// NOTE: A value whose Type is a Function with Protocol-bounded Type
// Parameters can not travel — its hidden conformance parameters only exist
// at direct invocations, where the Enricher resolves them from the concrete
// bindings. A stored bounded Function would later be invoked without its
// conformances, so every value position rejects it.
function validateNoBoundFunctionValue(node: common.typed.ExpressionNode): void {
	if (isBoundFunctionType(node.type)) {
		reportError(
			"A Function with Protocol-bound Type Parameters can not be used as a value (yet) — call it directly.",
			node.position,
		)
	}
}

function isBoundFunctionType(type: common.Type): boolean {
	if (
		type.type === "Function" ||
		type.type === "SimpleMethod" ||
		type.type === "StaticMethod"
	) {
		return type.generics.some((generic) => generic.constraint != null)
	}

	if (
		type.type === "OverloadedMethod" ||
		type.type === "OverloadedStaticMethod"
	) {
		return type.overloads.some((overload) =>
			overload.generics.some((generic) => generic.constraint != null),
		)
	}

	return false
}

function validateNativeFunctionInvocation(
	node: common.typed.NativeFunctionInvocationNode,
): common.typed.NativeFunctionInvocationNode {
	const functionType = node.name.type

	for (let argumentNode of node.arguments) {
		validateNoBoundFunctionValue(argumentNode.value)
	}

	if (functionType.type === "Function") {
		validateSimpleFunctionInvocation(
			functionType,
			node.arguments,
			node.position,
		)
	} else if (functionType.type !== "Error") {
		reportError(
			`'${node.name.content}' is not a native function.`,
			node.name.position,
		)
	}

	return node
}

function validateMethodInvocation(
	node: common.typed.MethodInvocationNode,
): common.typed.MethodInvocationNode {
	for (let argumentNode of node.arguments) {
		validateExpression(argumentNode.value)
		validateNoBoundFunctionValue(argumentNode.value)
	}

	validateExpression(node.base)

	return node
}

function validateFunctionInvocation(
	node: common.typed.FunctionInvocationNode,
): common.typed.FunctionInvocationNode {
	const functionType = node.name.type

	for (let argumentNode of node.arguments) {
		validateExpression(argumentNode.value)
		validateNoBoundFunctionValue(argumentNode.value)
	}

	if (
		functionType.type !== "Function" &&
		functionType.type !== "SimpleMethod" &&
		functionType.type !== "StaticMethod" &&
		functionType.type !== "OverloadedMethod" &&
		functionType.type !== "OverloadedStaticMethod"
	) {
		if (functionType.type !== "Error") {
			reportError("This expression is not a Function.", node.position)
		}

		return node
	}

	if (
		functionType.type === "Function" ||
		functionType.type === "StaticMethod"
	) {
		validateSimpleFunctionInvocation(
			functionType,
			node.arguments,
			node.position,
		)
	} else {
		// Dynamic methods, being called in a manually via `.` are being validated here,
		// as opposed to methods that are being called with `::` which get validated by `validateMethodInvocation`
		if (
			functionType.type === "OverloadedMethod" ||
			functionType.type === "OverloadedStaticMethod"
		) {
			let matchableArguments = matchableArgumentsFromTypedNodes(
				node.arguments,
			)

			let overloadMatched = true
			let index = 0

			for (let overload of functionType.overloads) {
				overloadMatched =
					matchArguments(
						overload.parameterTypes,
						matchableArguments,
						{
							inference: createInferenceContext(
								overload.generics,
							),
						},
					).type === "Match"

				if (overloadMatched) {
					break
				}

				index++
			}

			if (!overloadMatched) {
				reportError(
					"Passed arguments do not match any overload.",
					node.position,
				)
			} else {
				node.overloadedMethodIndex = index
			}
		} else {
			let matchResult = matchArguments(
				functionType.parameterTypes,
				matchableArgumentsFromTypedNodes(node.arguments),
				{
					collectAllMismatches: true,
					inference: createInferenceContext(functionType.generics),
				},
			)

			if (matchResult.type === "ArityMismatch") {
				reportError(
					"Amount of passed arguments doesn't match the signature.",
					node.position,
				)

				return node
			}

			if (matchResult.type === "ArgumentMismatch") {
				for (let i of matchResult.mismatchedArgumentIndices) {
					reportError(
						`Argument ${i + 1} doesn't match its declared parameter.`,
						node.arguments[i].value.position,
					)
				}
			}
		}
	}

	return node
}

function validateFunctionDefinition(
	node: common.typed.FunctionDefinitionNode,
	position: common.Position,
): common.typed.FunctionDefinitionNode {
	node.body.map((bodyNode) => validateImplementationNode(bodyNode, node))

	validateDefiniteReturn(node, position)

	return node
}

function validateLookup(
	node: common.typed.LookupNode,
): common.typed.LookupNode {
	validateExpression(node.base)

	return node
}

function validateMatch(node: common.typed.MatchNode): common.typed.MatchNode {
	validateExpression(node.value)

	if (node.value.type.type === "UnionType") {
		// NOTE: Flattened, so that a Union member that is itself a Union — a
		// Choice composed as `CalculatorOperation | Nothing`, or `Number |
		// Nothing` — is discharged by Handlers for its *members* rather than
		// demanding one Handler for the nested Union as a whole.
		let memberTypes = flattenUnionMembers(node.value.type)

		for (let memberType of memberTypes) {
			// NOTE: A Handler with a literal Matcher or a Guard covers only
			// part of its Type — `case 0` leaves every other Integer, and a
			// Guard can decline outright — so neither can discharge a member
			// of the Union. Only an unconditional Handler makes a Match
			// exhaustive.
			let isHandled = node.handlers.some(
				(handler) =>
					handler.literal === null &&
					handler.memberLiterals === null &&
					handler.guard === null &&
					matchesType(handler.matcher, memberType),
			)

			if (!isHandled) {
				reportError(
					`Match Expression does not handle Type '${describeType(
						memberType,
					)}'.`,
					node.position,
					{ code: "missing-case" },
				)
			}
		}

		for (let handler of node.handlers) {
			let isReachable = memberTypes.some((memberType) =>
				matchesType(handler.matcher, memberType),
			)

			if (!isReachable) {
				// NOTE: Tagged `unnecessary` so that clients grey the case out
				// instead of underlining it — it is dead, not wrong.
				reportWarning(
					`Type '${describeType(
						handler.matcher,
					)}' is not a member of the matched Union — this case can never match.`,
					node.position,
					{ code: "unreachable-case", tags: ["unnecessary"] },
				)
			}
		}
	} else if (node.value.type.type !== "Error") {
		reportError(
			"You can only use Match-Expressions on Union Types.",
			node.value.position,
		)
	}

	for (let handler of node.handlers) {
		// NOTE: Synthetic — a Match handler is validated as if it were a
		// Function body so that its `<-` Statements are checked against the
		// Match's Type. It has no Parameter list of its own, so nothing here
		// is ever inferred or hinted.
		let handlerContext: common.typed.FunctionDefinitionNode = {
			nodeType: "FunctionDefinition",
			generics: [],
			parameters: [],
			body: handler.body,
			returnType: node.type,
			inferredReturnType: null,
			parameterListPosition: node.position,
		}

		for (let bodyNode of handler.body) {
			validateImplementationNode(bodyNode, handlerContext)
		}

		validateDefiniteReturn(handlerContext, node.position)
	}

	return node
}

// NOTE: Whether the payload is present and matches is checked here rather
// than in the Enricher — the Case's Type resolves either way, so a wrong
// payload stays a single Diagnostic instead of poisoning the whole
// Expression.
function validateCaseValue(
	node: common.typed.CaseValueNode,
): common.typed.CaseValueNode {
	if (node.value !== null) {
		validateExpression(node.value)
		validateNoBoundFunctionValue(node.value)
	}

	if (node.type.type !== "Case") {
		return node
	}

	let payloadType: common.RecordType = {
		type: "Record",
		members: node.type.members,
	}

	if (Object.keys(node.type.members).length === 0) {
		if (node.value !== null) {
			reportError(
				`Case '#${node.type.name}' does not carry a payload.`,
				node.value.position,
			)
		}
	} else if (node.value === null) {
		reportError(
			`Case '#${node.type.name}' requires a payload of Type '${describeType(payloadType)}'.`,
			node.position,
		)
	} else if (!matchesType(payloadType, node.value.type)) {
		reportError(
			`The payload does not match Case '#${node.type.name}' — expected '${describeType(payloadType)}'.`,
			node.value.position,
		)
	}

	return node
}

function validateFunctionValue(
	node: common.typed.FunctionValueNode,
): common.typed.FunctionValueNode {
	validateFunctionDefinition(node.value, node.position)

	return node
}

function validateRationalValue(
	node: common.typed.RationalValueNode,
): common.typed.RationalValueNode {
	if (BigInt(node.denominator) === 0n) {
		reportError(
			"A Rational can not have a denominator of zero.",
			node.position,
		)
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
		case "TypeAliasStatement":
		case "ChoiceDeclarationStatement":
		case "ProtocolDeclarationStatement":
			return node
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
			reportError(
				`Wrong Assignment Value Type for Constant '${node.name.content}'.`,
				node.value.position,
			)
		}
	}

	validateExpression(node.value)
	validateNoBoundFunctionValue(node.value)

	return node
}

function validateVariableDeclarationStatement(
	node: common.typed.VariableDeclarationStatementNode,
): common.typed.VariableDeclarationStatementNode {
	if (node.declaredType !== null) {
		if (!matchesType(node.declaredType, node.value.type)) {
			reportError(
				`Wrong Assignment Value Type for Variable '${node.name.content}'.`,
				node.value.position,
			)
		}
	}

	validateExpression(node.value)
	validateNoBoundFunctionValue(node.value)

	return node
}

function validateVariableAssignmentStatement(
	node: common.typed.VariableAssignmentStatementNode,
): common.typed.VariableAssignmentStatementNode {
	if (!matchesType(node.name.type, node.value.type)) {
		reportError(
			`Wrong Assignment Value Type for Variable '${node.name.content}'.`,
			node.value.position,
		)
	}

	validateExpression(node.value)
	validateNoBoundFunctionValue(node.value)

	return node
}

function validateNamespaceDefinitionStatement(
	node: common.typed.NamespaceDefinitionStatementNode,
): common.typed.NamespaceDefinitionStatementNode {
	for (let methodName in node.methods) {
		let method = node.methods[methodName]

		if (
			method.nodeType === "SimpleMethod" ||
			method.nodeType === "StaticMethod"
		) {
			validateFunctionDefinition(
				method.method.value,
				method.method.position,
			)
		} else {
			for (let overloadedMethod of method.methods) {
				validateFunctionDefinition(
					overloadedMethod.value,
					overloadedMethod.position,
				)
			}
		}
	}

	return node
}

function validateIfElseStatementNode(
	node: common.typed.IfElseStatementNode,
	currentFunctionContext: CurrentFunctionContext,
): common.typed.IfElseStatementNode {
	if (
		node.condition.type.type !== "Boolean" &&
		node.condition.type.type !== "Error"
	) {
		reportError(
			"If Conditions have to be Booleans.",
			node.condition.position,
		)
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
		node.condition.type.type !== "Boolean" &&
		node.condition.type.type !== "Error"
	) {
		reportError(
			"If Conditions have to be Booleans.",
			node.condition.position,
		)
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
		reportError("Top level returns are not permitted.", node.position)
	} else if (
		!matchesType(currentFunctionContext.returnType, node.expression.type)
	) {
		reportError(
			"Type of returned expression doesn't match the declared return type.",
			node.expression.position,
		)
	}

	validateExpression(node.expression)
	validateNoBoundFunctionValue(node.expression)

	return node
}

function validateFunctionStatement(
	node: common.typed.FunctionStatementNode,
): common.typed.FunctionStatementNode {
	validateFunctionDefinition(node.value, node.position)

	return node
}

// #endregion

// #region Helpers

function bodyDefinitelyReturns(
	body: Array<common.typed.ImplementationNode>,
): boolean {
	return body.some(nodeDefinitelyReturns)
}

function nodeDefinitelyReturns(node: common.typed.ImplementationNode): boolean {
	if (node.nodeType === "ReturnStatement") {
		return true
	}

	if (node.nodeType === "IfElseStatement") {
		return (
			bodyDefinitelyReturns(node.trueBody) &&
			bodyDefinitelyReturns(node.falseBody)
		)
	}

	return false
}

function validateDefiniteReturn(
	definition: common.typed.FunctionDefinitionNode,
	position: common.Position,
): void {
	let returnType = definition.returnType

	if (
		returnType.type === "Nothing" ||
		returnType.type === "Unknown" ||
		returnType.type === "Error"
	) {
		return
	}

	if (!bodyDefinitelyReturns(definition.body)) {
		reportError("Not all code paths return a value.", position, {
			code: "missing-return",
		})
	}
}

function describeType(type: common.Type): string {
	switch (type.type) {
		case "UnionType":
			if (type.name !== undefined) {
				return type.name
			}

			return type.types.map(describeType).join(" | ")
		case "Case":
			return `${type.choice}#${type.name}`
		case "List":
			return `List<${describeType(type.itemType)}>`
		case "GenericList":
			return "List"
		case "Record":
			return `{ ${Object.entries(type.members)
				.map(
					([memberName, memberType]) =>
						`${memberName}: ${describeType(memberType)}`,
				)
				.join(", ")} }`
		case "Function":
		case "SimpleMethod":
		case "StaticMethod":
		case "OverloadedMethod":
		case "OverloadedStaticMethod":
			return "Function"
		case "Namespace":
		case "GenericUse":
		case "GenericAlias":
			return type.name
		default:
			return type.type
	}
}

function matchableArgumentsFromTypedNodes(
	argumentNodes: Array<common.typed.ArgumentNode>,
): Array<MatchableArgument> {
	return argumentNodes.map((argumentNode) => ({
		name: argumentNode.name,
		getType: () => argumentNode.type,
	}))
}

function validateSimpleFunctionInvocation(
	functionType: common.FunctionType | common.StaticMethodType,
	argumentNodes: Array<common.typed.ArgumentNode>,
	position: common.Position,
) {
	for (let argumentNode of argumentNodes) {
		validateExpression(argumentNode.value)
	}

	let matchResult = matchArguments(
		functionType.parameterTypes,
		matchableArgumentsFromTypedNodes(argumentNodes),
		{
			collectAllMismatches: true,
			inference: createInferenceContext(functionType.generics),
		},
	)

	if (matchResult.type === "ArityMismatch") {
		reportError(
			"Amount of passed arguments doesn't match the signature.",
			position,
		)

		return
	}

	if (matchResult.type === "ArgumentMismatch") {
		for (let i of matchResult.mismatchedArgumentIndices) {
			reportError(
				`Argument ${i + 1} doesn't match its declared parameter.`,
				argumentNodes[i].value.position,
			)
		}
	}
}

// #endregion
