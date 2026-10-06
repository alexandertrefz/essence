import type { common } from "@essence-lang/interfaces"

import { eraseRefinements } from "../helpers/eraseRefinements"
import { flattenUnionMembers, matchesType } from "../helpers/types"

// Whether the check emitted for `matcher` accepts every value of
// `memberType`. See "Runtime overlap" in DEVELOPMENT.md. Exported for the spec
// that holds it to the runtime's `isValueOfType`.
export function acceptsAllAtRuntime(
	matcher: common.Type,
	memberType: common.Type,
): boolean {
	// A refinement's predicate never reaches the runtime, so both sides are
	// unwrapped first.
	if (matcher.type === "Refinement" || memberType.type === "Refinement") {
		return acceptsAllAtRuntime(
			eraseRefinements(matcher),
			eraseRefinements(memberType),
		)
	}

	if (matcher.type === "GenericUse" || matcher.type === "Unknown") {
		return true
	}

	if (matchesType(matcher, memberType)) {
		return true
	}

	// Every arm of a matched Union has to pass. A Union Matcher passes a value
	// as soon as one of its arms does.
	if (memberType.type === "UnionType") {
		return flattenUnionMembers(memberType).every((armType) =>
			acceptsAllAtRuntime(matcher, armType),
		)
	}

	if (matcher.type === "UnionType") {
		return flattenUnionMembers(matcher).some((armType) =>
			acceptsAllAtRuntime(armType, memberType),
		)
	}

	if (matcher.type === "Function") {
		return memberType.type === "Function"
	}

	// Structural and open: the value carries every member the Matcher names.
	if (matcher.type === "Record" && memberType.type === "Record") {
		return membersAcceptAllAtRuntime(matcher.members, memberType.members)
	}

	// The Record check after the tag. The payload tells `Box<Integer>#Full`
	// from `Box<String>#Full`.
	if (matcher.type === "Case" && memberType.type === "Case") {
		return (
			matcher.choice === memberType.choice &&
			matcher.name === memberType.name &&
			membersAcceptAllAtRuntime(matcher.members, memberType.members)
		)
	}

	// A List Matcher is answered by the items a value holds. A bare `List`
	// takes every List, and a List of undecided items is not all of anything.
	if (isRuntimeList(matcher) && isRuntimeList(memberType)) {
		let matcherItemType = runtimeItemType(matcher)
		let memberItemType = runtimeItemType(memberType)

		if (matcherItemType.type === "Unknown") {
			return true
		}

		return (
			memberItemType.type !== "Unknown" &&
			acceptsAllAtRuntime(matcherItemType, memberItemType)
		)
	}

	// A Dictionary Matcher is answered by the entries a value holds, slot by
	// slot.
	if (isRuntimeDictionary(matcher) && isRuntimeDictionary(memberType)) {
		return (
			slotAcceptsAllAtRuntime(
				runtimeKeyType(matcher),
				runtimeKeyType(memberType),
			) &&
			slotAcceptsAllAtRuntime(
				runtimeValueType(matcher),
				runtimeValueType(memberType),
			)
		)
	}

	return false
}

// Whether the check emitted for `matcher` accepts some value of
// `memberType`, empty containers included. See "Runtime overlap" in
// DEVELOPMENT.md.
export function overlapsAtRuntime(
	matcher: common.Type,
	memberType: common.Type,
): boolean {
	// Unwrapped as in `acceptsAllAtRuntime`.
	if (matcher.type === "Refinement" || memberType.type === "Refinement") {
		return overlapsAtRuntime(
			eraseRefinements(matcher),
			eraseRefinements(memberType),
		)
	}

	if (acceptsAllAtRuntime(matcher, memberType)) {
		return true
	}

	// A Type Parameter member is not counted as an overlap; sorting its values
	// out is what the Handlers are for.
	if (memberType.type === "UnionType") {
		return flattenUnionMembers(memberType).some((armType) =>
			overlapsAtRuntime(matcher, armType),
		)
	}

	if (matcher.type === "UnionType") {
		return flattenUnionMembers(matcher).some((armType) =>
			overlapsAtRuntime(armType, memberType),
		)
	}

	if (matcher.type === "Function") {
		return memberType.type === "Function"
	}

	if (matcher.type === "Record" && memberType.type === "Record") {
		return membersOverlapAtRuntime(matcher.members, memberType.members)
	}

	if (matcher.type === "Case" && memberType.type === "Case") {
		return (
			matcher.choice === memberType.choice &&
			matcher.name === memberType.name &&
			membersOverlapAtRuntime(matcher.members, memberType.members)
		)
	}

	// The empty List, whatever the two item Types are.
	if (isRuntimeList(matcher) && isRuntimeList(memberType)) {
		return true
	}

	// And the empty Dictionary.
	if (isRuntimeDictionary(matcher) && isRuntimeDictionary(memberType)) {
		return true
	}

	return false
}

// Whether the values crossing from `memberType` into `matcher` are the empty
// ones of a container of `kind`.
function overlapsThroughEmptyContainer(
	matcher: common.Type,
	memberType: common.Type,
	kind: EmptyCrossover,
): boolean {
	if (matcher.type === "Refinement" || memberType.type === "Refinement") {
		return overlapsThroughEmptyContainer(
			eraseRefinements(matcher),
			eraseRefinements(memberType),
			kind,
		)
	}

	let isContainer = kind === "List" ? isRuntimeList : isRuntimeDictionary

	if (isContainer(matcher) && isContainer(memberType)) {
		return !acceptsAllAtRuntime(matcher, memberType)
	}

	if (memberType.type === "UnionType") {
		return flattenUnionMembers(memberType).some((armType) =>
			overlapsThroughEmptyContainer(matcher, armType, kind),
		)
	}

	if (matcher.type === "UnionType") {
		return flattenUnionMembers(matcher).some((armType) =>
			overlapsThroughEmptyContainer(armType, memberType, kind),
		)
	}

	if (
		(matcher.type === "Record" && memberType.type === "Record") ||
		(matcher.type === "Case" && memberType.type === "Case")
	) {
		return Object.entries(matcher.members).some(
			([name, memberMatcher]) =>
				Object.hasOwn(memberType.members, name) &&
				overlapsThroughEmptyContainer(
					memberMatcher,
					memberType.members[name],
					kind,
				),
		)
	}

	return false
}

// Which container's empty value crosses, or null. A List is asked about first.
type EmptyCrossover = "List" | "Dictionary"

export function emptyCrossoverKind(
	matcher: common.Type,
	memberType: common.Type,
): EmptyCrossover | null {
	if (overlapsThroughEmptyContainer(matcher, memberType, "List")) {
		return "List"
	}

	if (overlapsThroughEmptyContainer(matcher, memberType, "Dictionary")) {
		return "Dictionary"
	}

	return null
}

function membersAcceptAllAtRuntime(
	matcherMembers: Record<string, common.Type>,
	memberTypes: Record<string, common.Type>,
): boolean {
	// `Object.hasOwn`, so a member named like an `Object.prototype` property
	// is not read off the prototype.
	return Object.entries(matcherMembers).every(
		([name, memberMatcher]) =>
			Object.hasOwn(memberTypes, name) &&
			acceptsAllAtRuntime(memberMatcher, memberTypes[name]),
	)
}

function membersOverlapAtRuntime(
	matcherMembers: Record<string, common.Type>,
	memberTypes: Record<string, common.Type>,
): boolean {
	return Object.entries(matcherMembers).every(
		([name, memberMatcher]) =>
			Object.hasOwn(memberTypes, name) &&
			overlapsAtRuntime(memberMatcher, memberTypes[name]),
	)
}

// The Types the runtime's List check answers: `List<X>` and the bare `List`,
// which names no item Type.
function isRuntimeList(type: common.Type): boolean {
	return type.type === "List" || type.type === "GenericList"
}

function runtimeItemType(type: common.Type): common.Type {
	return type.type === "List" ? type.itemType : { type: "Unknown" }
}

// The same for the Dictionary, whose bare spelling reads both slots as
// Unknown.
function isRuntimeDictionary(type: common.Type): boolean {
	return type.type === "Dictionary" || type.type === "GenericDictionary"
}

function runtimeKeyType(type: common.Type): common.Type {
	return type.type === "Dictionary" ? type.keyType : { type: "Unknown" }
}

function runtimeValueType(type: common.Type): common.Type {
	return type.type === "Dictionary" ? type.valueType : { type: "Unknown" }
}

// One slot of a Dictionary, asked as a List's items are. Both slots must
// answer, so the keys alone never decide.
function slotAcceptsAllAtRuntime(
	matcherSlot: common.Type,
	memberSlot: common.Type,
): boolean {
	if (matcherSlot.type === "Unknown") {
		return true
	}

	return (
		memberSlot.type !== "Unknown" &&
		acceptsAllAtRuntime(matcherSlot, memberSlot)
	)
}
