import type { common, enricher } from "@essence-lang/interfaces"

import {
	applyGenericBindings,
	flattenUnionMembers,
	genericNamesMentioned,
	matchesType,
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

// The Case an Alias's payload writes, where the position offers the Case only
// in applications the Alias can not write. The position then refuses it as it
// would `Boxes<Integer>#Full([1])`. See "Resolving a Case" in DEVELOPMENT.md.
export function payloadCase(
	declaredCase: common.CaseType,
	expectedType: common.Type,
	payloadUnder: (under: common.Type) => common.typed.ExpressionNode | null,
	aliasGenerics: Array<common.GenericDeclaration> | null,
): common.CaseType | null {
	if (
		aliasGenerics === null ||
		genericNamesMentioned(expectedType).size > 0 ||
		offeredCases(declaredCase, expectedType, null).length === 0
	) {
		return null
	}

	let payload = payloadUnder(declaredCase)
	let members = Object.values(declaredCase.members)
	let context = {
		bindableNames: new Set(aliasGenerics.map((generic) => generic.name)),
		bindings: new Map(),
	}
	let bound =
		payload !== null &&
		(matchesTypeWithBindings(
			{ type: "Record", members: declaredCase.members },
			payload.type,
			context,
		) ||
			(members.length === 1 &&
				matchesTypeWithBindings(members[0]!, payload.type, context)))
	let written = bound
		? (applyGenericBindings(
				declaredCase,
				context.bindings,
			) as common.CaseType)
		: null

	return written !== null &&
		aliasGenerics.every((generic) => context.bindings.has(generic.name)) &&
		!matchesType(expectedType, written)
		? written
		: null
}
