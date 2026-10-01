import type { common } from "@essence-lang/interfaces"

// Documentation as Markdown, with the tagged sections put back. Signature Help
// shows a Parameter's text beside it, so it asks for the description alone.

export function documentationOf(
	type: common.Type | undefined,
): common.Documentation | null {
	switch (type?.type) {
		case "Function":
		case "SimpleMethod":
		case "StaticMethod":
		case "OverloadedMethod":
		case "OverloadedStaticMethod":
			return type.documentation ?? null
		default:
			return null
	}
}

export function describe(documentation: common.Documentation | null): string {
	return documentation === null ? "" : documentation.description
}

export function renderDocumentation(
	documentation: common.Documentation | null,
): string | null {
	if (documentation === null) {
		return null
	}

	let sections = [documentation.description]

	// In Parameter order. The name is the one the signature shows, which names a
	// positional Parameter written `_`.
	for (let parameter of documentation.parameters) {
		sections.push(`**${parameter.name}** — ${parameter.text}`)
	}

	if (documentation.returns !== null) {
		sections.push(`**Returns** — ${documentation.returns}`)
	}

	let rendered = sections.filter((section) => section !== "").join("\n\n")

	return rendered === "" ? null : rendered
}
