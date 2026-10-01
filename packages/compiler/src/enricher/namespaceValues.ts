import type { common, enricher, parser } from "@essence-lang/interfaces"

import { primary, reportError } from "../diagnostics/index"
import type { NameContext } from "./resolvers"

// A standard library Namespace written where a value goes, as in
// `Terminal.inspect(String)`. Emission binds it to nothing, while a Program's
// own Namespace is a class. A Lookup base and a call are answered elsewhere.
export function reportedBuiltinNamespaceValue(
	node: parser.IdentifierNode,
	type: common.Type,
	scope: enricher.Scope,
	context: NameContext,
): boolean {
	let name = node.content

	if (
		type.type !== "Namespace" ||
		context.readMember !== undefined ||
		context.applied === true ||
		!isPreludeName(name, scope)
	) {
		return false
	}

	reportError(
		`Namespace '${name}' can not be used as a value`,
		node.position,
		{
			code: "namespace-as-value",
			labels: [
				primary(
					node.position,
					"this names a standard library Namespace",
				),
			],
			notes: [
				"A standard library Namespace holds Methods and statics, and has no value of its own while the Program runs.",
			],
			helps: [
				`Read one of its members, as in '${name}.…', or name another value in its place.`,
			],
		},
	)

	return true
}

// Whether the nearest binding of `name` is the prelude's. A Program's
// declaration of the name shadows it, and the standard library's own load has
// no prelude at all.
function isPreludeName(name: string, scope: enricher.Scope): boolean {
	for (
		let searchScope: enricher.Scope | null = scope;
		searchScope !== null;
		searchScope = searchScope.parent
	) {
		if (Object.hasOwn(searchScope.members, name)) {
			return searchScope.preludeNames?.has(name) === true
		}
	}

	return false
}
