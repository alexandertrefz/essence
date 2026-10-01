import { requiredParameterCount } from "@essence-lang/compiler/helpers"
import {
	describeSignature,
	type ParameterRange,
	signaturesOf,
	withProtocolSpellings,
} from "@essence-lang/compiler/printType"
import {
	forEachTypedChild,
	type TypedNode,
} from "@essence-lang/compiler/visitor"
import type { common } from "@essence-lang/interfaces"

import type { DocumentAnalysis } from "./analyse"
import { describe, documentationOf } from "./documentation"
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

// The search for the smallest Invocation containing the cursor.
type Search = {
	cursor: common.Position
	best: Invocation | null
}

function findEnclosingInvocation(
	nodes: Array<common.typed.ImplementationNode>,
	cursor: common.Position,
): Invocation | null {
	let search: Search = { cursor, best: null }

	for (let node of nodes) {
		visitNode(node, search)
	}

	return search.best
}

function visitNode(node: TypedNode, search: Search) {
	if (
		(node.nodeType === "FunctionInvocation" ||
			node.nodeType === "MethodInvocation") &&
		encloses(node.position, search.cursor) &&
		(search.best === null || isSmaller(node.position, search.best.position))
	) {
		search.best = node
	}

	forEachTypedChild(node, visitNode, search)
}

// A cursor exactly at an Invocation's end has just closed it, so the call
// around it is the one being written, unlike what `contains` says.
function encloses(position: common.Position, cursor: common.Position) {
	return (
		contains(position, cursor.start) &&
		!isAtOrBefore(position.end, cursor.start)
	)
}
