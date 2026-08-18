import type { common } from "@essence-lang/interfaces"

// NOTE: Documentation reaches an Editor as Markdown. The tagged sections were
// lifted out of the prose when the `§§` block was parsed, so they are put back
// here — but only where there is room for them. Signature Help shows a
// Parameter's own text next to that Parameter, so it asks for the description
// alone; a Hover has no such place and renders everything.

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

	// NOTE: In the order the Parameters stand in, which is the order the
	// `@param` lines were written in. The name is the one the signature shows —
	// a Documentation attached to a resolved signature carries the internal
	// name where the line wrote `_`, so a positional Parameter is named here
	// rather than underlined.
	for (let parameter of documentation.parameters) {
		sections.push(`**${parameter.name}** — ${parameter.text}`)
	}

	if (documentation.returns !== null) {
		sections.push(`**Returns** — ${documentation.returns}`)
	}

	let rendered = sections.filter((section) => section !== "").join("\n\n")

	return rendered === "" ? null : rendered
}
