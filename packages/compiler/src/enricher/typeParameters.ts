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

// The Help that moves a refused Namespace bound onto the conformances it
// declares, each clause spelled whole. A clause that has a `where` already
// takes the bound as one more condition. One that binds the Type Parameter to
// another Protocol takes no second bound. So that conformance moves to a
// Namespace of its own, as `nonconforming-namespace` asks.
export function conformanceBoundHelps(
	node: parser.NamespaceDefinitionStatementNode,
	parameter: string,
	protocolName: string,
): Array<string> {
	let condition = `${parameter} is ${protocolName}`
	let clauses: Array<string> = []
	let moved: Array<string> = []

	for (let clause of node.conformsTo) {
		let protocol = clause.protocol.content
		let written = clause.conditions.map(
			(each) => `${each.generic.content} is ${each.protocol.content}`,
		)
		let carried = clause.conditions.find(
			(each) => each.generic.content === parameter,
		)?.protocol.content

		if (carried !== undefined && carried !== protocolName) {
			moved.push(
				`A Method that fulfils '${protocol}' can carry no bound of its own, and '${parameter}' already carries '${carried}' on that conformance, which takes one bound per Type Parameter — declare 'is ${protocol} where ${condition}' on a Namespace of its own.`,
			)
		} else {
			clauses.push(
				`'is ${protocol} where ${(carried === undefined ? [...written, condition] : written).join(", ")}'`,
			)
		}
	}

	let bounded =
		clauses.length === 0
			? []
			: clauses.length === 1 && moved.length === 0
				? [
						`A Method that fulfils '${node.conformsTo[0]?.protocol.content}' can carry no bound of its own, so bound it on the conformance instead: ${clauses[0]}.`,
					]
				: [
						`A Method that fulfils a requirement can carry no bound of its own, so bound it on each conformance whose Methods need it: ${clauses.join(", ")}.`,
					]

	return [...bounded, ...moved]
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

// The Namespace Type Parameters whose bound the reader wrote, which is always
// refused. A bound the target Type implies sits in the same field, so the
// written ones are marked apart.
let refusedBounds = new WeakSet<common.GenericDeclaration>()

// A Namespace's Type Parameters, each with the bound the reader wrote or else
// the one its target Type implies. See `impliedTargetBounds`.
export function boundNamespaceGenerics(
	generics: Array<common.GenericDeclaration>,
	impliedBounds: Map<string, string>,
): Array<common.GenericDeclaration> {
	return generics.map((generic) => {
		let constraint = generic.constraint ?? impliedBounds.get(generic.name)

		if (constraint == null) {
			return generic
		}

		let bounded = { ...generic, constraint }

		if (generic.constraint != null) {
			refusedBounds.add(bounded)
		}

		return bounded
	})
}

// A refused bound's Help asks for the same bound as a `where`. Each conformance
// assumes it, so a Method that needs it is not reported again. A `where` on
// that Type Parameter wins. An implied bound is never assumed, since nothing
// refused it.
export function assumeRefusedBounds(
	generics: Array<common.GenericDeclaration>,
	assumptions: Map<string, string>,
): void {
	for (let generic of generics) {
		if (
			refusedBounds.has(generic) &&
			generic.constraint != null &&
			!assumptions.has(generic.name)
		) {
			assumptions.set(generic.name, generic.constraint)
		}
	}
}

// A Namespace's `where` conditions for one Protocol, with each refused bound
// as one more where no `where` names its Type Parameter. A use site solves a
// refused bound as the `where` its Help asks for. So a binding it does not
// hold for is still refused there.
export function conformanceConditionsOf(
	namespace: common.NamespaceType,
	protocolName: string,
): Array<{ generic: string; protocol: string }> {
	let written = namespace.conformanceConditions?.[protocolName] ?? []
	let refused = namespace.generics.flatMap((generic) =>
		refusedBounds.has(generic) &&
		generic.constraint != null &&
		!written.some((condition) => condition.generic === generic.name)
			? [{ generic: generic.name, protocol: generic.constraint }]
			: [],
	)

	return orderConditions([...written, ...refused], namespace.generics)
}

// INVARIANT: `where` conditions are ordered by the Namespace's Type Parameter
// declaration order, the order the simplifier emits the hidden conformance
// Parameters in.
export function orderConditions(
	conditions: Array<{ generic: string; protocol: string }>,
	generics: Array<common.GenericDeclaration>,
): Array<{ generic: string; protocol: string }> {
	let order = generics.map((generic) => generic.name)

	return [...conditions].sort(
		(a, b) => order.indexOf(a.generic) - order.indexOf(b.generic),
	)
}

// The conditions a conformance holds under, in the order they were assumed.
export function conditionsOf(
	assumptions: Map<string, string>,
): Array<{ generic: string; protocol: string }> {
	return [...assumptions].map(([generic, protocol]) => ({
		generic,
		protocol,
	}))
}
