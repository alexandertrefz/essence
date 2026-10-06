import type { common, enricher } from "@essence-lang/interfaces"

import { primary, reportError } from "../diagnostics/index"
import {
	declaredSpelling,
	describeType,
	spellMatcher,
	spellShape,
	withArticle,
} from "../helpers/describe"
import { closestMatch } from "../helpers/suggest"
import { flattenUnionMembers } from "../helpers/types"
import type {
	MemberAccessContext,
	resolveMethodLookupNamespacesForReceiverType,
} from "./resolvers"
import { spellingIn, writtenNameIn } from "./spelling"

type Written = {
	// Null for a member a Pattern names, which writes no `.`.
	access: MemberAccessContext | null
	scope: enricher.Scope | null
	// How a `::` call on a value finds the Namespaces it searches.
	lookup: typeof resolveMethodLookupNamespacesForReceiverType
}

type Method = {
	name: string
	// How many Arguments past the receiver each Overload accepts.
	arities: Array<{ least: number; most: number }>
}

// A member read off a value with no members. Only `@` in a Match arm is
// narrowed, so a Union member that declares the name is matched first.
// Otherwise a Method is offered only where one of the name, or near it, fits.
export function reportTypeWithoutMembers(
	baseType: common.Type,
	memberName: string,
	position: common.Position,
	written: Written,
): void {
	let namespaces =
		written.scope === null
			? new Map<string, common.NamespaceType>()
			: written.lookup(baseType, null, written.scope)
	let arms = armsDeclaring(baseType, memberName, written.scope)
	let method =
		arms.length > 0
			? null
			: methodFor(memberName, namespaces, written.access)
	let searched = [...namespaces.keys()].map((name) => `'${name}'`)

	reportError("This value has no members to look up", position, {
		code: "type-without-members",
		labels: [
			primary(position, `this is ${withArticle(describeType(baseType))}`),
		],
		notes: [
			"Only Records, Cases and Namespaces have members.",
			...(arms.length > 0 || method !== null || searched.length === 0
				? []
				: [
						`Searched ${searched.length === 1 ? "Namespace" : "Namespaces"} ${searched.join(", ")}.`,
					]),
		],
		helps:
			arms.length > 0
				? [
						`Read '@.${memberName}' in a Match arm that narrows the value — ${arms.map((arm) => `'case ${arm} { … }'`).join(" or ")}.`,
					]
				: method === null
					? []
					: [methodHelp(memberName, method, written.access)],
	})
}

function methodHelp(
	memberName: string,
	method: Method,
	access: MemberAccessContext | null,
): string {
	let alone = method.arities.some((arity) => arity.least === 0)
	let call = `'::${method.name}${alone ? "()" : "(…)"}'`

	if (access === null) {
		return `A Pattern takes apart a Record or a Case — bind the whole value instead, and call ${call} on it.`
	}

	return access.isCalled
		? `Write '::${method.name}' in place of '.${memberName}'.`
		: `Write ${call} in place of '.${memberName}' — a Method is called, never read.`
}

// The instance Method of the name, which only a Pattern can have missed, or
// the nearest one. A call keeps its Arguments, so only a Method that accepts
// as many counts there.
function methodFor(
	memberName: string,
	namespaces: Map<string, common.NamespaceType>,
	access: MemberAccessContext | null,
): Method | null {
	let methods = new Map<string, Method>()

	for (let namespace of namespaces.values()) {
		for (let [name, method] of Object.entries(namespace.methods)) {
			let fits = arities(method)

			if (
				fits.length > 0 &&
				(access?.isCalled !== true ||
					fits.some(
						(arity) =>
							arity.least <= access.writtenArguments &&
							access.writtenArguments <= arity.most,
					))
			) {
				methods.set(name, { name, arities: fits })
			}
		}
	}

	let name = methods.has(memberName)
		? memberName
		: closestMatch(memberName, [...methods.keys()])

	return name === null ? null : (methods.get(name) ?? null)
}

// What each Overload of an instance Method accepts past its receiver. A static
// Method has none to offer.
function arities(method: common.Type): Array<{ least: number; most: number }> {
	let overloads =
		method.type === "OverloadedMethod"
			? method.overloads
			: method.type === "SimpleMethod"
				? [method]
				: []

	return overloads.map((overload) => {
		let parameters = overload.parameterTypes.slice(1)

		return {
			least: parameters.filter(
				(parameter) => parameter.hasDefault !== true,
			).length,
			most: parameters.length,
		}
	})
}

// The Matchers of the Union members that declare the name, as a `case` writes
// them. A member no Matcher can name is left out.
function armsDeclaring(
	baseType: common.Type,
	memberName: string,
	scope: enricher.Scope | null,
): Array<string> {
	if (baseType.type !== "UnionType") {
		return []
	}

	let members = flattenUnionMembers(baseType)
	let spell = scope === null ? declaredSpelling : spellingIn(scope)

	// A Record is written by its name where one binds it here, else by its
	// shape. A Case of a Choice bound nowhere here is written bare.
	return members.flatMap((member) =>
		(member.type === "Record" || member.type === "Case") &&
		Object.hasOwn(member.members, memberName)
			? ((member.type === "Record"
					? (recordName(member, scope) ?? spellShape(member))
					: spellMatcher(member, spell, members)) ?? [])
			: [],
	)
}

function recordName(
	record: common.RecordType,
	scope: enricher.Scope | null,
): string | null {
	return record.name === undefined || scope === null
		? null
		: writtenNameIn(record.name, record, scope)
}
