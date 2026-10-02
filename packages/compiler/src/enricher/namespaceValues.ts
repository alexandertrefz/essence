import type { common, enricher, parser } from "@essence-lang/interfaces"

import { primary, reportError } from "../diagnostics/index"
import { isBoundFunctionType } from "../helpers/types"
import { type NameContext, resolveIdentifierType } from "./resolvers"

// The Type of a name read as a value. A declaration's own name and an
// assignment's target are resolved without this.
export function valueTypeOf(
	node: parser.IdentifierNode,
	scope: enricher.Scope,
	context: NameContext,
): common.Type {
	let type = resolveIdentifierType(node, scope, context)

	return reportedNamespaceValue(node, type, context)
		? { type: "Error" }
		: type
}

// A Namespace written where a value goes, as in `Terminal.inspect(Clock)`. No
// Namespace is a value, whoever declared it. A Lookup base and a call are
// answered elsewhere.
function reportedNamespaceValue(
	node: parser.IdentifierNode,
	type: common.Type,
	context: NameContext,
): boolean {
	if (
		type.type !== "Namespace" ||
		context.readMember !== undefined ||
		context.applied === true
	) {
		return false
	}

	let name = node.content
	let member = memberToRead(type)

	reportError(
		`Namespace '${name}' can not be used as a value`,
		node.position,
		{
			code: "namespace-as-value",
			labels: [primary(node.position, "this names a Namespace")],
			notes: [
				"A Namespace holds Methods and statics, and is no value of its own.",
			],
			helps: [
				member === null
					? `Name a value in its place, since '${name}' declares no member to read.`
					: `Read a member off it, as in '${name}.${member}'.`,
			],
		},
	)

	return true
}

// The member a Help reads off the Namespace. A static Property comes first,
// then a Method that is a value as read, static before not. An Overload set or
// a Protocol-bound Method comes last. Null for a Namespace that declares none.
function memberToRead(namespace: common.NamespaceType): string | null {
	let methods = Object.entries(namespace.methods)
	let values = methods.filter(
		([, method]) =>
			(method.type === "StaticMethod" ||
				method.type === "SimpleMethod") &&
			!isBoundFunctionType(method),
	)
	let ranked = [
		...Object.keys(namespace.properties),
		...values.filter(([, method]) => method.type === "StaticMethod"),
		...values,
		...methods,
	].map((entry) => (typeof entry === "string" ? entry : entry[0]))

	return ranked[0] ?? null
}
