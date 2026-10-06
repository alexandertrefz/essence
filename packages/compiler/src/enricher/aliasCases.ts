import type { common, enricher } from "@essence-lang/interfaces"

import {
	flattenUnionMembers,
	genericNamesMentioned,
	matchesTypeWithBindings,
} from "../helpers/types"
import { findTypeInScope } from "./resolvers"

// The Type Parameters a prefixed Case leaves to decide where its prefix is a
// generic Alias of an application, as `Crate#Full` is under `type Crate<V> =
// Box<V>`. Null where the prefix is the Choice itself, or where the Case
// mentions none of them. See "Resolving a Case" in DEVELOPMENT.md.
export function aliasTypeParameters(
	prefix: string,
	caseType: common.CaseType,
	scope: enricher.Scope,
): Array<common.GenericDeclaration> | null {
	let alias = findTypeInScope(prefix, scope)

	if (
		alias?.type !== "GenericAlias" ||
		caseType.choiceGenerics !== undefined
	) {
		return null
	}

	let mentioned = genericNamesMentioned(caseType)

	return alias.generics.some((generic) => mentioned.has(generic.name))
		? alias.generics
		: null
}

// The instantiations of a Case the position offers. Through a generic Alias,
// only those the Alias can write, binding its own Type Parameters: `Boxes#Full`,
// with `type Boxes<A> = Box<List<A>>`, is never a `Box<Integer>`.
export function offeredCases(
	declaredCase: common.CaseType,
	expectedType: common.Type,
	aliasGenerics: Array<common.GenericDeclaration> | null,
): Array<common.CaseType> {
	let arms =
		expectedType.type === "UnionType"
			? flattenUnionMembers(expectedType)
			: [expectedType]

	return arms.filter(
		(member): member is common.CaseType =>
			member.type === "Case" &&
			member.name === declaredCase.name &&
			member.choice === declaredCase.choice &&
			(aliasGenerics === null ||
				matchesTypeWithBindings(declaredCase, member, {
					bindableNames: new Set(
						aliasGenerics.map((generic) => generic.name),
					),
					bindings: new Map(),
				})),
	)
}
