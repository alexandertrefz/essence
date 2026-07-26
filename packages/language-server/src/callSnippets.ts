import { printSignature, signaturesOf } from "@essence/compiler/printType"
import type { common } from "@essence/interfaces"

// NOTE: Accepting a callable writes the call the way Essence spells it: a
// labelled Argument is `label value`, with NO colon, so the label belongs to
// the inserted text and only the value is a tabstop. A Parameter declared `_`
// has no label to write and contributes the tabstop alone.

export type CallSnippet = {
	snippet: string
	// NOTE: The signature without its name — what tells two Overloads apart in
	// a Completion list, where they deliberately share a label.
	signature: string
}

export function buildCallSnippet(
	name: string,
	signature: common.BaseFunction,
): string {
	let parameters = signature.parameterTypes.map((parameter, index) => {
		let tabstop = `\${${index + 1}}`

		return parameter.name === null
			? tabstop
			: `${escapeSnippet(parameter.name)} ${tabstop}`
	})

	return `${escapeSnippet(name)}(${parameters.join(", ")})`
}

// NOTE: One CallSnippet per Overload rather than one for a "primary" pick —
// Overloads differ in exactly the labels this inserts, so a single pick would
// write the wrong call half the time. Null for anything not callable, which is
// also what a failed Enrichment looks like: the caller then falls back to the
// bare name.
export function callSnippetsFor(
	name: string,
	type: common.Type,
): Array<CallSnippet> | null {
	return snippetsFrom(name, signaturesOf(type))
}

// NOTE: A Namespace's Methods are also reachable through `.` on the Namespace
// itself, where the receiver rides along as the first Argument —
// `Number.isBetween(5, 1, and 10)`. That call site passes the Self Parameter
// `signaturesOf` strips for a `::` one, so it is kept here.
export function qualifiedCallSnippetsFor(
	name: string,
	type: common.Type,
): Array<CallSnippet> | null {
	switch (type.type) {
		case "Function":
		case "SimpleMethod":
		case "StaticMethod":
			return snippetsFrom(name, [type])
		case "OverloadedMethod":
		case "OverloadedStaticMethod":
			return snippetsFrom(name, type.overloads)
		default:
			return null
	}
}

function snippetsFrom(
	name: string,
	signatures: Array<common.BaseFunction> | null,
): Array<CallSnippet> | null {
	if (signatures === null || signatures.length === 0) {
		return null
	}

	return signatures.map((signature) => ({
		snippet: buildCallSnippet(name, signature),
		signature: printSignature(signature),
	}))
}

// NOTE: `$` opens a tabstop and `}` closes one, and neither is a Symbol the
// Lexer knows — both are ordinary Identifier characters, so a name or a label
// may carry one, and an unescaped one would turn the rest of the call into
// snippet syntax. Exported because the Server's fallback insert text is also
// snippet-formatted and has to spell a name the same way this does.
export function escapeSnippet(text: string): string {
	return text.replace(/[$}\\]/g, "\\$&")
}
