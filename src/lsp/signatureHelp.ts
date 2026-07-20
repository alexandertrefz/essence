import { enrich } from "../enricher/index"
import type { common } from "../interfaces/index"
import { parseWithDiagnostics } from "../parser/index"
import { matchingNamespaces } from "./namespaces"
import { contains, isSmaller } from "./positions"
import { printSignature, printType, withoutSelf } from "./printType"
import { buildProbeSource, stripNoise } from "./probe"

// NOTE: Signature Help resolves the enclosing invocation the same way
// Completion resolves a receiver: the document text up to the cursor is
// padded back into a valid Program (`probe.ts`), enriched, and the smallest
// FunctionInvocation or MethodInvocation node that now contains the padded
// cursor point is the one being typed into — this also handles nested calls
// for free, since the innermost one wins.
//
// The active Parameter is *not* read off the parsed Arguments — a call like
// `greet(1, )` drops the empty trailing slot entirely, so it is counted
// directly from the raw text instead: top level commas between the call's
// opening bracket and the cursor.
//
// A Method Invocation only resolves a Namespace once its Arguments already
// match an Overload — which is exactly what is missing while Signature Help
// is being shown. When that resolution failed, every Namespace whose target
// Type matches the receiver (independent of Arguments) is offered instead,
// mirroring Completion's `::` listing.

export type SignatureHelpInfo = {
	signatures: Array<SignatureInfo>
	activeSignature: number
	activeParameter: number
}

export type SignatureInfo = {
	label: string
	parameters: Array<string>
}

export function findSignatureHelp(
	documentText: string,
	cursor: common.Cursor,
): SignatureHelpInfo | null {
	let lines = documentText.split("\n")
	let headText = [
		...lines.slice(0, cursor.line - 1),
		(lines[cursor.line - 1] ?? "").slice(0, cursor.column - 1),
	].join("\n")

	let probeSource = buildProbeSource(headText)
	let cursorPoint: common.Position = { start: cursor, end: cursor }

	let enrichedProgram: common.typed.Program | null = null

	try {
		let { program } = parseWithDiagnostics(probeSource)
		enrichedProgram = enrich(program).program
	} catch {
		return null
	}

	let invocation = findEnclosingInvocation(
		enrichedProgram.implementation.nodes,
		cursorPoint,
	)

	if (invocation === null) {
		return null
	}

	let activeParameter = countArguments(headText, invocation.arguments.length)

	if (invocation.nodeType === "FunctionInvocation") {
		let calleeType = invocation.name.type

		if (calleeType.type !== "Function") {
			return null
		}

		return {
			signatures: [signatureOf(calleeType)],
			activeSignature: 0,
			activeParameter,
		}
	}

	// NOTE: `namespace.name` is empty exactly when resolution failed (see
	// `resolveFailedMethodInvocation` in the Enricher) — the common case
	// while Arguments are still incomplete.
	if (invocation.namespace.name !== "") {
		let methodType =
			invocation.namespace.type.methods[invocation.member.name]

		if (methodType !== undefined) {
			return signatureHelpForMethod(
				methodType,
				invocation.overloadedMethodIndex,
				activeParameter,
			)
		}
	}

	let namespaces = matchingNamespaces(
		documentText,
		invocation.base.type,
		null,
	)

	let candidates: Array<common.BaseFunction> = []

	for (let namespace of namespaces) {
		let methodType = namespace.methods[invocation.member.name]

		if (methodType === undefined) {
			continue
		}

		switch (methodType.type) {
			case "SimpleMethod":
				candidates.push(withoutSelf(methodType))
				break
			case "StaticMethod":
				candidates.push(methodType)
				break
			case "OverloadedMethod":
				candidates.push(...methodType.overloads.map(withoutSelf))
				break
			case "OverloadedStaticMethod":
				candidates.push(...methodType.overloads)
				break
		}
	}

	if (candidates.length === 0) {
		return null
	}

	return {
		signatures: candidates.map(signatureOf),
		activeSignature: 0,
		activeParameter,
	}
}

function signatureHelpForMethod(
	methodType: common.MethodType,
	overloadedMethodIndex: number | null,
	activeParameter: number,
): SignatureHelpInfo {
	if (methodType.type === "SimpleMethod") {
		return {
			signatures: [signatureOf(withoutSelf(methodType))],
			activeSignature: 0,
			activeParameter,
		}
	}

	if (methodType.type === "StaticMethod") {
		return {
			signatures: [signatureOf(methodType)],
			activeSignature: 0,
			activeParameter,
		}
	}

	// NOTE: With an Overload already resolved (arguments so far matched one
	// candidate) it is shown alone — otherwise every Overload is offered.
	let overloads =
		methodType.type === "OverloadedMethod"
			? methodType.overloads.map(withoutSelf)
			: methodType.overloads

	return {
		signatures: overloads.map(signatureOf),
		activeSignature: Math.max(overloadedMethodIndex ?? 0, 0),
		activeParameter,
	}
}

function signatureOf(fn: common.BaseFunction): SignatureInfo {
	return {
		label: printSignature(fn),
		parameters: fn.parameterTypes.map((parameter) =>
			parameter.name === null
				? `_ ${printType(parameter.type)}`
				: `${parameter.name}: ${printType(parameter.type)}`,
		),
	}
}

// NOTE: Counts top level commas only — nested calls, Lists and Records
// balance their own brackets so a comma inside them does not advance the
// active Parameter of the outer call. String and Comment content is blanked
// out first, so that a comma or an unbalanced bracket inside a String
// Literal argument neither advances the count nor cuts the scan short.
function countArguments(headText: string, parsedArgumentCount: number): number {
	let text = stripNoise(headText)
	let depth = 0
	let commas = 0
	let sawOpenParen = false

	for (let i = text.length - 1; i >= 0; i--) {
		let character = text[i]

		if (character === ")" || character === "]" || character === "}") {
			depth++
		} else if (
			character === "(" ||
			character === "[" ||
			character === "{"
		) {
			if (depth === 0) {
				sawOpenParen = character === "("
				break
			}

			depth--
		} else if (character === "," && depth === 0) {
			commas++
		}
	}

	return sawOpenParen ? commas : Math.max(parsedArgumentCount - 1, 0)
}

/***********/
/* Walkers */
/***********/

type Invocation =
	| common.typed.FunctionInvocationNode
	| common.typed.MethodInvocationNode

function findEnclosingInvocation(
	nodes: Array<common.typed.ImplementationNode>,
	cursor: common.Position,
): Invocation | null {
	let best: Invocation | null = null
	let bestPosition: common.Position | null = null

	function visitBody(body: Array<common.typed.ImplementationNode>) {
		for (let node of body) {
			visitNode(node)
		}
	}

	function consider(node: common.typed.ImplementationNode) {
		if (
			node.nodeType !== "FunctionInvocation" &&
			node.nodeType !== "MethodInvocation"
		) {
			return
		}

		if (!contains(node.position, cursor.start)) {
			return
		}

		if (bestPosition === null || isSmaller(node.position, bestPosition)) {
			best = node
			bestPosition = node.position
		}
	}

	function visitNode(node: common.typed.ImplementationNode) {
		consider(node)

		switch (node.nodeType) {
			case "ConstantDeclarationStatement":
			case "VariableDeclarationStatement":
			case "VariableAssignmentStatement":
				visitNode(node.value)
				return
			case "FunctionStatement":
				visitBody(node.value.body)
				return
			case "NamespaceDefinitionStatement":
				for (let property of Object.values(node.properties)) {
					visitNode(property.value)
				}

				for (let member of Object.values(node.methods)) {
					let methods =
						member.nodeType === "OverloadedMethod" ||
						member.nodeType === "OverloadedStaticMethod"
							? member.methods
							: [member.method]

					for (let method of methods) {
						visitBody(method.value.body)
					}
				}

				return
			case "IfStatement":
				visitNode(node.condition)
				visitBody(node.body)
				return
			case "IfElseStatement":
				visitNode(node.condition)
				visitBody(node.trueBody)
				visitBody(node.falseBody)
				return
			case "ReturnStatement":
				visitNode(node.expression)
				return
			case "NativeFunctionInvocation":
				for (let argument of node.arguments) {
					visitNode(argument.value)
				}

				return
			case "MethodInvocation":
				visitNode(node.base)

				for (let argument of node.arguments) {
					visitNode(argument.value)
				}

				return
			case "FunctionInvocation":
				visitNode(node.name)

				for (let argument of node.arguments) {
					visitNode(argument.value)
				}

				return
			case "Lookup":
				visitNode(node.base)
				return
			case "Combination":
				visitNode(node.lhs)
				visitNode(node.rhs)
				return
			case "Match":
				visitNode(node.value)

				for (let handler of node.handlers) {
					visitBody(handler.body)
				}

				return
			case "RecordValue":
				for (let member of Object.values(node.members)) {
					visitNode(member)
				}

				return
			case "ListValue":
				for (let value of node.values) {
					visitNode(value)
				}

				return
			case "FunctionValue":
				visitBody(node.value.body)
				return
			case "TypeAliasStatement":
			case "Identifier":
			case "Self":
			case "StringValue":
			case "IntegerValue":
			case "FractionValue":
			case "BooleanValue":
			case "NothingValue":
				return
		}
	}

	visitBody(nodes)

	return best
}
