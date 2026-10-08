import type { common, enricher, parser } from "@essence-lang/interfaces"

import { primary, reportError, secondary } from "../diagnostics/index"
import { describeType, withArticle } from "../helpers/describe"
import { closestMatch } from "../helpers/suggest"
import { otherApplicationNotes } from "./otherApplications"
import { declarationWasAbandoned, unimportedNamespacesOf } from "./scope"

// The `::<Name>` specifiers the lookup in `resolvers.ts` refused. A caller
// then does not report the empty lookup behind `::<total>append("!")` again.
let refusedSpecifiers = new WeakSet<parser.IdentifierNode>()

export function specifierWasRefused(
	identifier: parser.IdentifierNode | null | undefined,
): boolean {
	return identifier != null && refusedSpecifiers.has(identifier)
}

// A call whose lookup found no Namespace for the receiver. `writers` are the
// Namespaces that answer the Method for a call without the specifier, provided
// and derived ones included, and `helps` the caller's own. `member` is the
// member of a Union receiver the lookup found nothing for. `compilesWithout`
// asks whether the call compiles once the specifier is dropped.
export function reportEmptyLookup(
	node: parser.MethodInvocationNode,
	baseType: common.Type,
	scope: enricher.Scope,
	writers: Map<string, common.NamespaceType>,
	helps: Array<string>,
	member: common.Type = baseType,
	compilesWithout: () => boolean = () => true,
): void {
	let methodName = node.member.content
	let written = [...writers]
		.filter(([, namespace]) => Object.hasOwn(namespace.methods, methodName))
		.map(([name]) => name)

	let wording = namespaceLookupWording(node, member, scope, written)

	// Dropping the specifier is offered only where the call then compiles.
	// Otherwise its Arguments do not fit the Method a Namespace writes.
	if (written.length > 0 && !compilesWithout()) {
		wording.helps = [
			`Drop the Namespace specifier, and pass '${methodName}' the Arguments '${written[0]}::${methodName}' takes.`,
		]
	}

	reportError(
		`No Namespace provides Methods for this value`,
		node.base.position,
		{
			code: "no-namespace-for-value",
			labels: [
				primary(
					node.base.position,
					`this is ${withArticle(describeType(baseType))}`,
				),
				secondary(
					node.member.position,
					`'${methodName}' is looked up in its Namespaces`,
				),
			],
			notes: wording.notes,
			helps: [...wording.helps, ...helps],
		},
	)
}

// What `no-namespace-for-value` says of the lookup. A specifier narrowed it, so
// other Namespaces may well target the value, and dropping it helps only where
// one answers the Method.
function namespaceLookupWording(
	node: parser.MethodInvocationNode,
	baseType: common.Type,
	scope: enricher.Scope,
	written: Array<string>,
): { notes: Array<string>; helps: Array<string> } {
	let specifier = node.namespaceSpecifier

	if (specifier === null) {
		return {
			notes: [
				`No Namespace in scope targets ${describeType(baseType)}.`,
				...otherApplicationNotes(
					node.member.content,
					[baseType],
					scope,
				),
			],
			helps: [],
		}
	}

	let named = nearestEntry(
		scope,
		(current) => current.members,
		specifier.content,
	)
	let note = `The specifier limits the lookup to '${specifier.content}', which provides no '${node.member.content}' for ${describeType(baseType)}.`

	// A Type Parameter's Methods come through its Protocol alone, whatever the
	// Namespace targets.
	if (named?.type === "Namespace" && baseType.type !== "GenericUse") {
		note =
			named.targetType === null
				? `'${specifier.content}' targets no Type, so no value reaches its Methods.`
				: `'${specifier.content}' targets ${describeType(named.targetType)}, which ${withArticle(describeType(baseType))} is not.`
	}

	return {
		notes: [note],
		helps: written.length > 0 ? ["Drop the Namespace specifier."] : [],
	}
}

// `::<Name>method()` where the nearest `Name` is no Namespace. A Namespace of
// the name further out would not be what the emitted code reaches.
export function reportSpecifierIsNotANamespace(
	identifier: parser.IdentifierNode,
	value: common.Type,
	declarationPosition: common.Position | null,
): void {
	refusedSpecifiers.add(identifier)

	reportError(
		`'${identifier.content}' is not a Namespace`,
		identifier.position,
		{
			code: "not-a-namespace",
			labels: [
				primary(
					identifier.position,
					`this is ${withArticle(describeType(value))}`,
				),
				...(declarationPosition === null
					? []
					: [secondary(declarationPosition, "declared here")]),
			],
			notes: [
				`A Method can only be looked up in a Namespace, and '${identifier.content}' names ${withArticle(describeType(value))} here.`,
			],
			helps: [
				"Drop the Namespace specifier, or rename whatever shadows the Namespace.",
			],
		},
	)
}

// `::<Name>method()` where no value is called `Name`. A Protocol of the name is
// a pick, which `providedMethodNamespacesNamed` reads. A Type is still no
// Namespace, and a name nothing declares gets the near miss among Namespaces.
export function reportSpecifierNamesNoValue(
	identifier: parser.IdentifierNode,
	scope: enricher.Scope,
): void {
	let name = identifier.content

	if (declaresAnywhere(scope, "protocols", name)) {
		return
	}

	refusedSpecifiers.add(identifier)

	if (declarationWasAbandoned(scope, name, identifier.position)) {
		return
	}

	if (declaresAnywhere(scope, "types", name)) {
		reportError(`'${name}' is not a Namespace`, identifier.position, {
			code: "not-a-namespace",
			labels: [primary(identifier.position, "this names a Type")],
			notes: [
				`A Method can only be looked up in a Namespace, and '${name}' names a Type here.`,
			],
			helps: ["Drop the Namespace specifier."],
		})

		return
	}

	// A Namespace another Module exports is what the name likely meant, so its
	// import leads, and the import Quick Fix answers it.
	let unimported = unimportedNamespacesOf(scope).find(
		(candidate) => candidate.name === name,
	)
	let suggestion =
		unimported === undefined
			? closestMatch(name, namespaceNamesIn(scope))
			: null
	let lead =
		unimported !== undefined
			? `'${name}' in ${unimported.specifier} is a Namespace — import it.`
			: suggestion === null
				? null
				: `Did you mean '${suggestion}'?`

	reportError(`'${name}' is not declared`, identifier.position, {
		code: "unknown-name",
		labels: [primary(identifier.position, "no such Namespace")],
		helps:
			lead === null
				? ["Drop the Namespace specifier."]
				: [lead, "Or drop the Namespace specifier."],
		...(suggestion === null
			? {}
			: { data: { kind: "suggestion", suggestion } }),
	})
}

function declaresAnywhere(
	scope: enricher.Scope,
	kind: "types" | "protocols",
	name: string,
): boolean {
	for (
		let current: enricher.Scope | null = scope;
		current !== null;
		current = current.parent
	) {
		if (Object.hasOwn(current[kind], name)) {
			return true
		}
	}

	return false
}

// The nearest Scope's entry of the name, as a named lookup reads it.
export function nearestEntry<Entry>(
	scope: enricher.Scope,
	entries: (current: enricher.Scope) => Record<string, Entry>,
	name: string,
): Entry | null {
	for (
		let current: enricher.Scope | null = scope;
		current !== null;
		current = current.parent
	) {
		if (Object.hasOwn(entries(current), name)) {
			return entries(current)[name]
		}
	}

	return null
}

// Each name as its nearest binding holds it, so a Namespace shadowed by a
// Constant is not offered.
export function namespaceNamesIn(scope: enricher.Scope): Array<string> {
	let seen = new Set<string>()
	let names: Array<string> = []

	for (
		let current: enricher.Scope | null = scope;
		current !== null;
		current = current.parent
	) {
		for (let [name, value] of Object.entries(current.members)) {
			if (!seen.has(name) && value.type === "Namespace") {
				names.push(name)
			}

			seen.add(name)
		}
	}

	return names
}
