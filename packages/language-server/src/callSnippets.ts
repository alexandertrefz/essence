import { lastRequiredParameterIndex } from "@essence-lang/compiler/helpers"
import { printSignature, signaturesOf } from "@essence-lang/compiler/printType"
import type { common } from "@essence-lang/interfaces"

// Accepting a callable writes the call as Essence spells it. A labelled
// Argument is `label value`, so the label is text and only the value a
// tabstop. A Parameter declared `_` contributes the tabstop alone.

export type CallSnippet = {
	snippet: string
	// The signature without its name, which tells two Overloads apart.
	signature: string
}

export function buildCallSnippet(
	name: string,
	signature: common.BaseFunction,
): string {
	// The trailing run of Parameters with defaults is left out, giving the
	// shortest call. A defaulted Parameter before a required one stays, since the
	// next Argument's label follows it.
	let lastRequired = lastRequiredParameterIndex(signature.parameterTypes)
	let parameters = signature.parameterTypes
		.slice(0, lastRequired + 1)
		.map((parameter, index) => {
			let tabstop = `\${${index + 1}}`

			return parameter.name === null
				? tabstop
				: `${escapeSnippet(parameter.name)} ${tabstop}`
		})

	return `${escapeSnippet(name)}(${parameters.join(", ")})`
}

// One CallSnippet per Overload, since Overloads differ in the labels this
// writes. Null for anything not callable, or after a failed enrichment.
export function callSnippetsFor(
	name: string,
	type: common.Type,
): Array<CallSnippet> | null {
	return snippetsFrom(name, signaturesOf(type))
}

// Through `.` on the Namespace, as in `Number.isBetween(5, 1, and 10)`, the
// receiver is the first Argument, so the Self Parameter is kept.
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

// `$`, `}` and `\` are snippet syntax, and `$` may occur in a name, so all
// three are escaped. Exported for the Server's fallback insert text.
export function escapeSnippet(text: string): string {
	return text.replace(/[$}\\]/g, "\\$&")
}
