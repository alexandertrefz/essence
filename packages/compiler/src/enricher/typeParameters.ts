import type { common, enricher, parser } from "@essence-lang/interfaces"

import { primary, reportError, secondary } from "../diagnostics/index"
import { oneBoundOnly } from "../helpers/bounds"

// A Function's own Type Parameter that neither `infer` nor a default decides.
// A call writes no Type Arguments, so nothing at one can bind it. A name the
// enclosing Namespace declares is a Method bound, answered where Methods are.
function isUndecided(
	generic: parser.GenericDeclarationNode,
	namespaceNames: ReadonlySet<string>,
): boolean {
	return (
		!generic.inferred &&
		generic.defaultType === null &&
		!namespaceNames.has(generic.name.content)
	)
}

// The names of the Type Parameters of the Namespace a Method is written in.
// Only a Method's own `<…>` may name them, so other Functions pass none.
export function namespaceParameterNames(
	scope: enricher.Scope,
): ReadonlySet<string> {
	for (
		let searchScope: enricher.Scope | null = scope;
		searchScope !== null;
		searchScope = searchScope.parent
	) {
		if (searchScope.namespace !== undefined) {
			return new Set(
				searchScope.namespace.type.generics.map(
					(generic) => generic.name,
				),
			)
		}
	}

	return new Set()
}

export function refuseUndecidedTypeParameters(
	generics: Array<parser.GenericDeclarationNode>,
	namespaceNames: ReadonlySet<string>,
): void {
	for (let generic of generics) {
		if (!isUndecided(generic, namespaceNames)) {
			continue
		}

		let name = generic.name.content

		reportError(
			`Type Parameter '${name}' needs 'infer' or a default`,
			generic.position,
			{
				code: "uninferred-type-parameter",
				labels: [
					primary(
						generic.position,
						"nothing can ever bind this Parameter",
					),
				],
				notes: [
					"A Function's Type Parameters are worked out from the Arguments at every call, which is what 'infer' says, or taken from a default. A call writes no Type Arguments.",
				],
				helps: [`Write 'infer ${name}'.`],
			},
		)
	}
}

// The resolved Type Parameters with each refused one read as `infer`. A call
// is then checked as the Help would have it, and reports nothing more.
export function inferringRefused(
	resolved: Array<common.GenericDeclaration>,
	written: Array<parser.GenericDeclarationNode>,
	namespaceNames: ReadonlySet<string>,
): Array<common.GenericDeclaration> {
	return resolved.map((generic, index) =>
		written[index] !== undefined &&
		isUndecided(written[index], namespaceNames)
			? { ...generic, infer: true }
			: generic,
	)
}

// One `<…>` naming a Type Parameter twice. Readers key a Generic list by name
// and the last writing wins, so `<Item is Comparable, Item is Printable>` would
// drop a bound silently. Checked here, not in the Parser, so the formatter
// still handles the file. A Method's list is checked as written.
export function refuseDuplicateTypeParameters(
	generics: Array<parser.GenericDeclarationNode>,
): void {
	if (generics.length < 2) {
		return
	}

	let first = new Map<string, parser.GenericDeclarationNode>()

	for (let entry of generics) {
		let name = entry.name.content
		let seen = first.get(name)

		if (seen === undefined) {
			first.set(name, entry)

			continue
		}

		// Two bounds on one Parameter is a different mistake: the language has
		// no spelling for both. `oneBoundOnly` words it.
		let carried = seen.constraint?.content ?? null
		let wanted = entry.constraint?.content ?? null
		let bothBounded = carried !== null && wanted !== null

		reportError(
			`Type Parameter '${name}' is declared twice`,
			entry.position,
			{
				code: "duplicate-type-parameter",
				labels: [
					primary(
						entry.position,
						bothBounded
							? "this bound replaces the one above"
							: "declared a second time here",
					),
					secondary(seen.position, "first declared here"),
				],
				notes: bothBounded ? oneBoundOnly(name, carried!, wanted!) : [],
				helps: bothBounded
					? [
							`Keep the one the body needs: write '<${name} is ${carried}>' or '<${name} is ${wanted}>', not both.`,
						]
					: [
							`Remove the second '${name}', or give it a name of its own.`,
						],
			},
		)
	}
}
