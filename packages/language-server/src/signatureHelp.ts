import {
	caseDefaults,
	parameterDefaults,
	requiredParameterCount,
} from "@essence-lang/compiler/helpers"
import {
	describeSignature,
	type ParameterRange,
	signaturesOf,
	withProtocolSpellings,
} from "@essence-lang/compiler/printType"
import type { common } from "@essence-lang/interfaces"

import type { DocumentAnalysis } from "./analyse"
import { typedAssertionExpressions } from "./assertionChildren"
import { defineExpressions } from "./defineArmChildren"
import { describe, documentationOf } from "./documentation"
import { typedHandlerExpressions } from "./matchHandlerChildren"
import { documentAnalysisOf, enrichProbe } from "./moduleLink"
import { matchingNamespaces } from "./namespaces"
import { contains, isAtOrBefore, isSmaller } from "./positions"
import { probeSourcesFor, stripNoise } from "./probe"
import { documentProtocolSpellings } from "./protocolSpellings"
import { typedProgramNodes } from "./sections"

// Signature Help for the call being typed, found by probing as Completion
// does. See "Signature Help" in DEVELOPMENT.md.

type SignatureHelpInfo = {
	signatures: Array<SignatureInfo>
	activeSignature: number
	activeParameter: number
}

type SignatureInfo = {
	label: string
	documentation: string | null
	parameters: Array<ParameterInfo>
}

type ParameterInfo = {
	range: ParameterRange
	documentation: string | null
}

export function findSignatureHelp(
	documentText: string,
	cursor: common.Cursor,
	documentPath?: string,
	analysis: DocumentAnalysis | null = null,
	// Told of a Compiler throw the help is answered around, for the log.
	onInternalError: (error: unknown) => void = () => {},
): SignatureHelpInfo | null {
	return withProtocolSpellings(documentProtocolSpellings(analysis), () =>
		signatureHelpAt(
			documentText,
			cursor,
			documentPath,
			analysis,
			onInternalError,
		),
	)
}

function signatureHelpAt(
	documentText: string,
	cursor: common.Cursor,
	documentPath: string | undefined,
	analysis: DocumentAnalysis | null,
	onInternalError: (error: unknown) => void,
): SignatureHelpInfo | null {
	// The document's analysis, derived as `findCompletions` derives it.
	let document =
		analysis ??
		documentAnalysisOf(documentText, documentPath, onInternalError)
	let moduleView = document?.module ?? null
	let lines = documentText.split("\n")
	let headText = [
		...lines.slice(0, cursor.line - 1),
		(lines[cursor.line - 1] ?? "").slice(0, cursor.column - 1),
	].join("\n")

	// The end of `headText`, where the probe's padding starts, which differs
	// from the cursor when the cursor is past the end of its line.
	let headLines = headText.split("\n")
	let probeCursor: common.Cursor = {
		line: headLines.length,
		column: (headLines.at(-1) ?? "").length + 1,
	}
	let cursorPoint: common.Position = { start: probeCursor, end: probeCursor }

	let invocation: Invocation | null = null

	// A call in a Parameter default is one of the readings; see `probeSourcesFor`.
	for (let probeSource of probeSourcesFor(headText)) {
		// The probe types the `tests` block too, so a call in a test body has a Node.
		let enrichedProgram = enrichProbe(probeSource, documentPath, moduleView)

		if (enrichedProgram === null) {
			continue
		}

		invocation = findEnclosingInvocation(
			typedProgramNodes(enrichedProgram),
			cursorPoint,
		)

		if (invocation !== null) {
			break
		}
	}

	if (invocation === null) {
		return null
	}

	let activeParameter = countArguments(headText, invocation.arguments.length)
	// The labels written so far, which tell a skipped defaulted Parameter from
	// one being typed. A Method's receiver is not among them.
	let writtenLabels = invocation.arguments.map((argument) => argument.name)

	// A static Method is called through a Lookup (`Thing.show(…)`), so the callee
	// is not always a Function Type.
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
			writtenLabels,
		)
	}

	// `namespace.name` is empty when resolution failed
	// (`resolveFailedMethodInvocation`), as it does while Arguments are incomplete.
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
					writtenLabels,
				)
			}
		}
	}

	let namespaces = matchingNamespaces(
		documentText,
		invocation.base.type,
		null,
		documentPath,
		[],
		document,
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

	// While several Namespaces offer the Method, the label is qualified as
	// `1::<Thing>string(…)` picks one.
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
		activeParameter: activeParameterFor(
			signatures[activeSignatureOf(signatures, null, activeParameter)],
			writtenLabels,
			activeParameter,
		),
	}
}

function help(
	signatures: Array<common.BaseFunction>,
	name: string,
	fallback: common.Documentation | null,
	overloadedMethodIndex: number | null,
	activeArgument: number,
	writtenLabels: Array<string | null>,
): SignatureHelpInfo {
	let activeSignature = activeSignatureOf(
		signatures,
		overloadedMethodIndex,
		activeArgument,
	)

	return {
		signatures: signatures.map((signature) =>
			signatureInfo(signature, name, fallback),
		),
		activeSignature,
		activeParameter: activeParameterFor(
			signatures[activeSignature],
			writtenLabels,
			activeArgument,
		),
	}
}

// The Parameter an Argument count stands at, walked as the Compiler pairs
// Arguments. A Parameter is taken when the labels agree and skipped when it
// has a default. Without defaults, the count itself.
function activeParameterFor(
	signature: common.BaseFunction | undefined,
	writtenLabels: Array<string | null>,
	activeArgument: number,
): number {
	let parameters = signature?.parameterTypes

	if (
		parameters === undefined ||
		!parameters.some((parameter) => parameter.hasDefault)
	) {
		return activeArgument
	}

	let index = 0

	let stepOverDefaults = (label: string | null): void => {
		while (
			index < parameters.length &&
			parameters[index]!.hasDefault === true &&
			parameters[index]!.name !== label
		) {
			index++
		}
	}

	for (let argument = 0; argument < activeArgument; argument++) {
		stepOverDefaults(writtenLabels[argument] ?? null)
		index++
	}

	// The Argument being typed skips the defaults its own label rules out, once
	// it has one.
	let active = writtenLabels[activeArgument]

	if (active !== undefined) {
		stepOverDefaults(active)
	}

	return Math.min(index, Math.max(parameters.length - 1, 0))
}

// A Parameter's text shows beside it, so the signature's documentation is its
// description alone. An Overload without text uses the set's.
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
			documentation: withOmittableMembers(
				signature.parameterTypes[index],
			),
		})),
	}
}

// The members a Record Parameter's default fills, shown beside the Argument.
// The label's `?` still means only that the whole Argument may go.
function withOmittableMembers(
	parameter: common.Parameter | undefined,
): string | null {
	let documentation = parameter?.documentation ?? null
	let members = parameter?.defaultMembers

	if (members === undefined || members.length === 0) {
		return documentation
	}

	let sentence = `A call may leave ${members
		.map((name) => `'${name}'`)
		.join(", ")} out of this Record.`
	let reaching = Object.keys(parameter?.defaultNesting ?? {})

	// And which of them a path key may reach into: `server.port = 1` merges into
	// what the default wrote.
	if (reaching.length > 0) {
		sentence += ` It may reach into ${reaching
			.map((name) => `'${name}'`)
			.join(", ")} with a path key.`
	}

	return documentation === null ? sentence : `${documentation}\n\n${sentence}`
}

// A resolved Overload stays active while it has room for the Argument being
// typed; `combine(2, ` may have resolved to one already ruled out. Otherwise
// the first Overload that can take the Argument wins.
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

	// An Overload whose required Parameters reach this Argument wins over one
	// reaching it only through defaults.
	let fits = signatures.findIndex(
		(signature) =>
			signature.parameterTypes.length > activeParameter &&
			requiredParameterCount(signature.parameterTypes) > activeParameter,
	)

	if (fits !== -1) {
		return fits
	}

	let match = signatures.findIndex(
		(signature) => signature.parameterTypes.length > activeParameter,
	)

	return match === -1 ? 0 : match
}

// A static Method's name is the path written at the call site.
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

// Counts top level commas only. Strings and comments are blanked out first,
// so their commas and brackets count for nothing.
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

		// A cursor exactly at an Invocation's end has just closed it, so the call
		// around it is the one being written, unlike what `contains` says.
		if (isAtOrBefore(node.position.end, cursor.start)) {
			return
		}

		if (bestPosition === null || isSmaller(node.position, bestPosition)) {
			best = node
			bestPosition = node.position
		}
	}

	// A call in a Parameter's default gets help as one in a body does.
	function visitDefaults(parameters: Array<common.typed.ParameterNode>) {
		for (let defaultValue of parameterDefaults(parameters)) {
			visitNode(defaultValue)
		}
	}

	function visitPresent(node: common.typed.ImplementationNode | null) {
		if (node !== null) {
			visitNode(node)
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
				visitDefaults(node.value.parameters)
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
						visitDefaults(method.value.parameters)
						visitBody(method.value.body)
					}
				}

				for (let shim of node.nativeShims) {
					visitDefaults(shim.parameters)
				}

				return
			case "ProtocolDeclarationStatement":
				for (let member of Object.values(node.methods)) {
					let methods =
						member.nodeType === "OverloadedMethod" ||
						member.nodeType === "OverloadedStaticMethod"
							? member.methods
							: [member.method]

					for (let method of methods) {
						visitDefaults(method.value.parameters)
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
			// A call in an assertion gets help too.
			case "ExpectStatement":
			case "RequireStatement":
				for (let expression of typedAssertionExpressions(node)) {
					visitNode(expression)
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
			case "Start":
			case "Complete":
				visitNode(node.expression)
				return
			case "Match":
				visitNode(node.value)

				for (let handler of node.handlers) {
					for (let expression of typedHandlerExpressions(handler)) {
						visitNode(expression)
					}

					visitBody(handler.body)
				}

				return
			// A call in a `define` arm gets help too.
			case "Define":
				for (let expression of defineExpressions(node)) {
					visitNode(expression)
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
			case "DictionaryValue":
				for (let entry of node.entries) {
					visitNode(entry.key)
					visitNode(entry.value)
				}

				return
			case "InterpolatedStringValue":
				for (let segment of node.segments) {
					if (segment.kind === "expression") {
						visitNode(segment.expression)
					}
				}

				return
			case "FunctionValue":
				visitDefaults(node.value.parameters)
				visitBody(node.value.body)
				return
			case "CaseValue":
				if (node.value !== null) {
					visitNode(node.value)
				}

				return
			case "ChoiceDeclarationStatement":
				// A call in a Case payload's default gets help too.
				for (let defaultValue of caseDefaults(node.cases)) {
					visitNode(defaultValue)
				}

				return
			// A call in a refinement predicate gets help too.
			case "TypeAliasStatement":
				visitPresent(node.predicate)
				return
			case "Identifier":
			case "Self":
			case "StringValue":
			case "IntegerValue":
			case "RationalValue":
			case "BooleanValue":
				return
		}
	}

	visitBody(nodes)

	return best
}
