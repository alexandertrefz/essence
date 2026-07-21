import { enrich } from "../enricher/index"
import type { common } from "../interfaces/index"
import { parseWithDiagnostics } from "../parser/index"
import { describe, documentationOf } from "./documentation"
import { matchingNamespaces } from "./namespaces"
import { contains, isSmaller } from "./positions"
import {
	describeSignature,
	type ParameterRange,
	signaturesOf,
} from "./printType"
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
//
// Labels carry the callee's name, so what is shown is the whole contract of
// the call being written — `append(_ String) -> String`, not a bare signature.

export type SignatureHelpInfo = {
	signatures: Array<SignatureInfo>
	activeSignature: number
	activeParameter: number
}

export type SignatureInfo = {
	label: string
	documentation: string | null
	parameters: Array<ParameterInfo>
}

export type ParameterInfo = {
	range: ParameterRange
	documentation: string | null
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

	// NOTE: A Static Method is invoked through a Lookup (`Thing.show(…)`), so
	// the callee is not always a plain Function Type.
	if (invocation.nodeType === "FunctionInvocation") {
		let signatures = signaturesOf(invocation.name.type)

		if (signatures === null) {
			return null
		}

		return help(
			signatures,
			calleeName(invocation.name),
			documentationOf(invocation.name.type),
			invocation.overloadedMethodIndex,
			activeParameter,
		)
	}

	// NOTE: `namespace.name` is empty exactly when resolution failed (see
	// `resolveFailedMethodInvocation` in the Enricher) — the common case
	// while Arguments are still incomplete.
	if (invocation.namespace.name !== "") {
		let methodType =
			invocation.namespace.type.methods[invocation.member.name]

		if (methodType !== undefined) {
			let signatures = signaturesOf(methodType)

			if (signatures !== null) {
				return help(
					signatures,
					invocation.member.name,
					documentationOf(methodType),
					invocation.overloadedMethodIndex,
					activeParameter,
				)
			}
		}
	}

	let namespaces = matchingNamespaces(
		documentText,
		invocation.base.type,
		null,
	)

	let candidates: Array<{
		namespaceName: string
		signature: common.BaseFunction
		fallback: common.Documentation | null
	}> = []

	for (let namespace of namespaces) {
		let methodType = namespace.methods[invocation.member.name]

		if (methodType === undefined) {
			continue
		}

		for (let signature of signaturesOf(methodType) ?? []) {
			candidates.push({
				namespaceName: namespace.name,
				signature,
				fallback: documentationOf(methodType),
			})
		}
	}

	if (candidates.length === 0) {
		return null
	}

	// NOTE: Several Namespaces can offer the same Method for one receiver, and
	// `1::<Thing>string(…)` is how a call site picks between them — so the
	// label is qualified the same way, but only while the choice is open.
	let isAmbiguous =
		new Set(candidates.map((candidate) => candidate.namespaceName)).size > 1

	let signatures = candidates.map((candidate) => candidate.signature)

	return {
		signatures: candidates.map((candidate) =>
			signatureInfo(
				candidate.signature,
				isAmbiguous
					? `<${candidate.namespaceName}>${invocation.member.name}`
					: invocation.member.name,
				candidate.fallback,
			),
		),
		activeSignature: activeSignatureOf(signatures, null, activeParameter),
		activeParameter,
	}
}

function help(
	signatures: Array<common.BaseFunction>,
	name: string,
	fallback: common.Documentation | null,
	overloadedMethodIndex: number | null,
	activeParameter: number,
): SignatureHelpInfo {
	return {
		signatures: signatures.map((signature) =>
			signatureInfo(signature, name, fallback),
		),
		activeSignature: activeSignatureOf(
			signatures,
			overloadedMethodIndex,
			activeParameter,
		),
		activeParameter,
	}
}

// NOTE: A Parameter's own text is shown next to that Parameter, so the
// signature's own Documentation is reduced to its description — repeating the
// `@param` sections underneath would say everything twice. An Overload
// without text of its own falls back to whatever documents the set.
function signatureInfo(
	signature: common.BaseFunction,
	name: string,
	fallback: common.Documentation | null,
): SignatureInfo {
	let described = describeSignature(signature, name)
	let documentation = signature.documentation ?? fallback

	return {
		label: described.label,
		documentation: describe(documentation) || null,
		parameters: described.parameters.map((range, index) => ({
			range,
			documentation:
				signature.parameterTypes[index]?.documentation ?? null,
		})),
	}
}

// NOTE: An Overload the Arguments already resolved to stays active, but only
// while it still has room for the Argument being typed — resolution runs on
// the half written call, so `combine(2, ` resolves to the one Parameter
// Overload that the second Argument has already ruled out. Otherwise the
// first Overload that can still take the Argument wins.
function activeSignatureOf(
	signatures: Array<common.BaseFunction>,
	overloadedMethodIndex: number | null,
	activeParameter: number,
): number {
	if (overloadedMethodIndex !== null) {
		let resolved = signatures[overloadedMethodIndex]

		if (
			resolved !== undefined &&
			resolved.parameterTypes.length > activeParameter
		) {
			return overloadedMethodIndex
		}
	}

	let match = signatures.findIndex(
		(signature) => signature.parameterTypes.length > activeParameter,
	)

	return match === -1 ? 0 : match
}

// NOTE: Static Methods are called through a Lookup, so the callee's name is
// the path written at the call site rather than a single Identifier.
function calleeName(node: common.typed.ImplementationNode): string {
	switch (node.nodeType) {
		case "Identifier":
			return node.content
		case "Lookup":
			return `${calleeName(node.base)}.${node.member.content}`
		default:
			return ""
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
			case "CaseValue":
				if (node.value !== null) {
					visitNode(node.value)
				}

				return
			case "TypeAliasStatement":
			case "ChoiceDeclarationStatement":
			case "Identifier":
			case "Self":
			case "StringValue":
			case "IntegerValue":
			case "RationalValue":
			case "BooleanValue":
			case "NothingValue":
				return
		}
	}

	visitBody(nodes)

	return best
}
