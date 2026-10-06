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

// The member path at which the values crossing from `memberType` into
// `matcher` are the empty ones of a container of `kind`, or null. An empty
// path is the value itself.
function emptyContainerPath(
	matcher: common.Type,
	memberType: common.Type,
	kind: EmptyCrossover,
): Array<string> | null {
	if (matcher.type === "Refinement" || memberType.type === "Refinement") {
		return emptyContainerPath(
			eraseRefinements(matcher),
			eraseRefinements(memberType),
			kind,
		)
	}

	let isContainer = kind === "List" ? isRuntimeList : isRuntimeDictionary

	if (isContainer(matcher) && isContainer(memberType)) {
		return acceptsAllAtRuntime(matcher, memberType) ? null : []
	}

	if (memberType.type === "UnionType") {
		return firstPath(flattenUnionMembers(memberType), (armType) =>
			emptyContainerPath(matcher, armType, kind),
		)
	}

	if (matcher.type === "UnionType") {
		return firstPath(flattenUnionMembers(matcher), (armType) =>
			emptyContainerPath(armType, memberType, kind),
		)
	}

	if (
		(matcher.type === "Record" && memberType.type === "Record") ||
		(matcher.type === "Case" && memberType.type === "Case")
	) {
		for (let [name, memberMatcher] of Object.entries(matcher.members)) {
			let path = Object.hasOwn(memberType.members, name)
				? emptyContainerPath(
						memberMatcher,
						memberType.members[name],
						kind,
					)
				: null

			if (path !== null) {
				return [name, ...path]
			}
		}
	}

	return null
}

function firstPath(
	arms: Array<common.Type>,
	pathOf: (arm: common.Type) => Array<string> | null,
): Array<string> | null {
	for (let arm of arms) {
		let path = pathOf(arm)

		if (path !== null) {
			return path
		}
	}

	return null
}

// Which container's empty value crosses, and at which member path, or null. A
// List is asked about first.
type EmptyCrossover = "List" | "Dictionary"

export function emptyCrossover(
	matcher: common.Type,
	memberType: common.Type,
): { kind: EmptyCrossover; path: Array<string> } | null {
	for (let kind of ["List", "Dictionary"] as const) {
		let path = emptyContainerPath(matcher, memberType, kind)

		if (path !== null) {
			return { kind, path }
		}
	}

	return null
}

// A Case of one application whose values a Matcher's Case of another
// application of the same Choice accepts.
export type ApplicationCrossing = {
	member: common.CaseType
	matcher: common.CaseType
}

// The first Case of `memberType` that reaches `matcher` only through a Case of
// another application, or null. A Matcher arm that takes the Case as written
// leaves nothing to cross. See "Runtime overlap" in DEVELOPMENT.md.
export function crossingApplication(
	matcher: common.Type,
	memberType: common.Type,
): ApplicationCrossing | null {
	if (memberType.type === "UnionType") {
		for (let armType of flattenUnionMembers(memberType)) {
			let crossing = crossingApplication(matcher, armType)

			if (crossing !== null) {
				return crossing
			}
		}

		return null
	}

	if (memberType.type !== "Case" || memberType.typeArguments === undefined) {
		return null
	}

	let arms =
		matcher.type === "UnionType" ? flattenUnionMembers(matcher) : [matcher]
	let crossing: ApplicationCrossing | null = null

	for (let arm of arms) {
		if (
			arm.type === "Case" &&
			arm.choice === memberType.choice &&
			arm.name === memberType.name &&
			!namesApplication(arm, memberType)
		) {
			if (crossing === null && overlapsAtRuntime(arm, memberType)) {
				crossing = { member: memberType, matcher: arm }
			}
		} else if (acceptsAllAtRuntime(arm, memberType)) {
			return null
		}
	}

	return crossing
}

// The crossing Cases at one member path of a Record or a Case.
export type NestedCrossing = {
	path: Array<string>
	crossings: Array<ApplicationCrossing>
}

// The Cases at a member of `memberType` that `earlier` takes through another
// application while `later` takes them as written. They are found at the first
// member path that has any, or the answer is null. Each pair of Matcher arms
// that share the member's shape is asked on its own. See "Runtime overlap" in
// DEVELOPMENT.md.
export function nestedCrossing(
	earlier: common.Type,
	later: common.Type,
	memberType: common.Type,
): NestedCrossing | null {
	if (memberType.type === "UnionType") {
		return firstNested(flattenUnionMembers(memberType), (armType) =>
			nestedCrossing(earlier, later, armType),
		)
	}

	let earlierArms = armsShaped(earlier, memberType)
	let laterArms = armsShaped(later, memberType)

	for (let [step, memberAt] of slotsOf(memberType)) {
		for (let earlierArm of earlierArms) {
			for (let laterArm of laterArms) {
				let earlierAt = slotOf(earlierArm, step)
				let laterAt = slotOf(laterArm, step)
				let found =
					earlierAt === null || laterAt === null
						? null
						: crossingAt(earlierAt, laterAt, memberAt)

				if (found !== null) {
					return {
						path: [step, ...found.path],
						crossings: found.crossings,
					}
				}
			}
		}
	}

	return null
}

// A path steps into a Record's or a Case's members by name. It steps into a
// List's items or a Dictionary's keys and values by these, which no member can
// be named.
export const ITEM_STEPS = ["[item]", "[key]", "[value]"]

function slotsOf(type: common.Type): Array<[string, common.Type]> {
	if (type.type === "Record" || type.type === "Case") {
		return Object.entries(type.members)
	}

	if (isRuntimeList(type)) {
		return [["[item]", runtimeItemType(type)]]
	}

	if (isRuntimeDictionary(type)) {
		return [
			["[key]", runtimeKeyType(type)],
			["[value]", runtimeValueType(type)],
		]
	}

	return []
}

function slotOf(type: common.Type, step: string): common.Type | null {
	let slot = slotsOf(type).find(([name]) => name === step)

	return slot === undefined ? null : slot[1]
}

// At one member: the Cases `later` takes as written and `earlier` through
// another application, or else those deeper inside it.
function crossingAt(
	earlier: common.Type,
	later: common.Type,
	memberType: common.Type,
): NestedCrossing | null {
	let arms =
		memberType.type === "UnionType"
			? flattenUnionMembers(memberType)
			: [memberType]
	let crossings = arms.flatMap((armType) =>
		armType.type === "Case" &&
		crossingApplication(later, armType) === null &&
		overlapsAtRuntime(later, armType)
			? (crossingApplication(earlier, armType) ?? [])
			: [],
	)

	if (crossings.length > 0) {
		return { path: [], crossings }
	}

	return firstNested(arms, (armType) =>
		nestedCrossing(earlier, later, armType),
	)
}

// The arms of a Matcher that accept some values of `memberType` and share its
// shape. A shape is a Record, a Case of one tag, a List or a Dictionary.
function armsShaped(
	matcher: common.Type,
	memberType: common.Type,
): Array<common.Type> {
	let arms =
		matcher.type === "UnionType" ? flattenUnionMembers(matcher) : [matcher]

	return arms.filter(
		(arm) =>
			sameShape(arm, memberType) && overlapsAtRuntime(arm, memberType),
	)
}

function sameShape(arm: common.Type, memberType: common.Type): boolean {
	switch (memberType.type) {
		case "Record":
			return arm.type === "Record"
		case "Case":
			return (
				arm.type === "Case" &&
				arm.choice === memberType.choice &&
				arm.name === memberType.name
			)
		default:
			return (
				(isRuntimeList(arm) && isRuntimeList(memberType)) ||
				(isRuntimeDictionary(arm) && isRuntimeDictionary(memberType))
			)
	}
}

function firstNested(
	arms: Array<common.Type>,
	crossingOf: (arm: common.Type) => NestedCrossing | null,
): NestedCrossing | null {
	for (let arm of arms) {
		let found = crossingOf(arm)

		if (found !== null) {
			return found
		}
	}

	return null
}

// Whether a Case Matcher's Type Arguments take the member's. A written Case
// Matcher carries none, and takes every application. Refinements erase, as
// everywhere at runtime.
function namesApplication(
	matcher: common.CaseType,
	member: common.CaseType,
): boolean {
	let matcherArguments = matcher.typeArguments
	let memberArguments = member.typeArguments

	if (matcherArguments === undefined || memberArguments === undefined) {
		return true
	}

	return matcherArguments.every(
		(argument, index) =>
			index < memberArguments.length &&
			matchesType(
				eraseRefinements(argument),
				eraseRefinements(memberArguments[index]),
			),
	)
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
