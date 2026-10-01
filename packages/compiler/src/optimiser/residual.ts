import type { common } from "@essence-lang/interfaces"

// What a Matcher's run-time Type check reduces to, given the Type of the value
// it tests. Where the compiler can not prove a cheaper check agrees, it answers
// `descriptor`. See "Matcher residuals" in DEVELOPMENT.md.

export type MatcherResidual =
	// The value's Type key alone decides it.
	| { kind: "tag"; tag: string }
	// The check passes every value that can reach it, as for `case _`.
	| { kind: "always" }
	// The check stands as written, since no tag answers it.
	| { kind: "descriptor" }

export function matcherResidual(
	matcher: common.Type,
	valueType: common.Type,
): MatcherResidual {
	return matcherResidualOverMembers(matcher, unionMembersOf(valueType))
}

// The same question asked of the members of what can arrive, as a dispatch
// holds them. `matcherResidual` flattens a Type into these.
export function matcherResidualOverMembers(
	matcher: common.Type,
	members: ReadonlyArray<common.Type>,
): MatcherResidual {
	let tag = lowerableTagOf(matcher)

	if (tag !== null) {
		// Some Matchers are a tag test whatever can arrive.
		if (checkIsTagAlone(matcher)) {
			return { kind: "tag", tag }
		}

		let claimant = soleClaimantOf(tag, members)

		if (claimant !== null && checkIsImplied(matcher, claimant)) {
			return { kind: "tag", tag }
		}
	}

	// Any member may arrive, so each has to imply the Matcher.
	if (members.every((member) => checkIsImplied(matcher, member))) {
		return { kind: "always" }
	}

	return { kind: "descriptor" }
}

// One test of a Record Matcher's decision tree, which ANDs its tests in order.
export type MatcherMemberTest = {
	// The member names from the matched value down. Empty is the value itself.
	path: ReadonlyArray<string>
	// A tag comparison, or the walk over this member alone. `optional` reads
	// through `?.` a member that may be absent, which only a tag test can do.
	check:
		| { kind: "tag"; tag: string; optional: boolean }
		| { kind: "descriptor"; matcher: common.Type }
}

// The tests left of a Record Matcher's check, or null where the walk has to
// stay. See "Record Matcher decision trees" in DEVELOPMENT.md.
export function recordMatcherTests(
	matcher: common.Type,
	valueType: common.Type,
): Array<MatcherMemberTest> | null {
	if (matcher.type !== "Record") {
		return null
	}

	let tests: Array<MatcherMemberTest> = []

	if (!planRecordTests(matcher, unionMembersOf(valueType), [], tests, [])) {
		return null
	}

	return orderedTests(tests)
}

// One level's plan. A nested level plans into its own array and is spliced in
// only once it holds.
function planRecordTests(
	matcher: common.RecordType,
	members: ReadonlyArray<common.Type>,
	path: ReadonlyArray<string>,
	tests: Array<MatcherMemberTest>,
	visiting: Array<common.Type>,
): boolean {
	if (visiting.includes(matcher)) {
		return false
	}

	let records: Array<common.RecordType> = []
	let carriesOtherTags = false

	for (let member of members) {
		if (runtimeTagOf(member) === null) {
			return false
		}

		if (member.type === "Record") {
			records.push(member)
		} else {
			carriesOtherTags = true
		}
	}

	if (carriesOtherTags) {
		tests.push({
			path,
			check: { kind: "tag", tag: "Record", optional: false },
		})
	}

	visiting.push(matcher)

	try {
		for (let [name, required] of Object.entries(matcher.members)) {
			let memberPath = [...path, name]
			// What every arriving Record declares for the member. Where one declares
			// nothing, openness leaves the member unconstrained.
			let declared: Array<common.Type> = []
			let isCarried = true

			for (let record of records) {
				let memberType = declaredMemberOf(record.members, name)

				if (memberType === undefined) {
					isCarried = false

					break
				}

				declared.push(...unionMembersOf(memberType))
			}

			if (!isCarried) {
				let residual = matcherResidualOverMembers(required, [
					{ type: "Unknown" },
				])

				if (residual.kind !== "tag") {
					return false
				}

				tests.push({
					path: memberPath,
					check: { kind: "tag", tag: residual.tag, optional: true },
				})

				continue
			}

			// Vacuously true where no Record can arrive, which the tag test then fails.
			if (declared.every((type) => checkIsImplied(required, type))) {
				continue
			}

			let residual = matcherResidualOverMembers(required, declared)

			if (residual.kind === "tag") {
				tests.push({
					path: memberPath,
					check: { kind: "tag", tag: residual.tag, optional: false },
				})

				continue
			}

			let nested: Array<MatcherMemberTest> = []

			if (
				required.type === "Record" &&
				planRecordTests(
					required,
					declared,
					memberPath,
					nested,
					visiting,
				)
			) {
				tests.push(...nested)

				continue
			}

			tests.push({
				path: memberPath,
				check: { kind: "descriptor", matcher: required },
			})
		}
	} finally {
		visiting.pop()
	}

	return true
}

// Tag comparisons before walks, then shallower before deeper, so every test
// follows those on its path's prefixes. See "Record Matcher decision trees" in
// DEVELOPMENT.md.
function orderedTests(
	tests: Array<MatcherMemberTest>,
): Array<MatcherMemberTest> {
	return tests
		.map((test, index) => ({ test, index }))
		.sort(
			(left, right) =>
				costOf(left.test) - costOf(right.test) ||
				left.test.path.length - right.test.path.length ||
				left.index - right.index,
		)
		.map((entry) => entry.test)
}

function costOf(test: MatcherMemberTest): number {
	return test.check.kind === "descriptor" ? 1 : 0
}

// Whether the check fails for every value that can arrive. See "Refutation"
// in DEVELOPMENT.md.
export function matcherIsRefuted(
	matcher: common.Type,
	valueType: common.Type,
): boolean {
	let members = unionMembersOf(valueType)

	// Unreachable, since a Type is its own member, but no members proves nothing.
	return (
		members.length > 0 &&
		members.every((member) => checkIsRefuted(matcher, member))
	)
}

// Two different nameable tags fail before anything else is read. A tag that can
// not be named, or one two Types share, refutes nothing.
function checkIsRefuted(matcher: common.Type, valueType: common.Type): boolean {
	if (matcher.type === "Unknown" || matcher.type === "GenericUse") {
		return false
	}

	// Every member of the value's Union has to be refuted, and every arm of the
	// Matcher's, since the runtime asks `some` of a Union descriptor.
	if (valueType.type === "UnionType") {
		return valueType.types.every((member) =>
			checkIsRefuted(matcher, member),
		)
	}

	if (matcher.type === "UnionType") {
		return matcher.types.every((member) =>
			checkIsRefuted(member, valueType),
		)
	}

	// The tags values carry, not `lowerableTagOf`, which refuses a Function
	// Matcher that refutation may still use.
	let matcherTag = runtimeTagOf(matcher)
	let valueTag = runtimeTagOf(valueType)

	return matcherTag !== null && valueTag !== null && matcherTag !== valueTag
}

// The Type key a value of this Type carries, or null for a Type Parameter or
// `Unknown`. A Function carries none, and its `"Function"` matches no tag.
function runtimeTagOf(type: common.Type): string | null {
	switch (type.type) {
		case "Boolean":
		case "String":
		case "Integer":
		case "Rational":
		case "Algebraic":
		case "Transcendental":
		case "Randomness":
		// The runtime checks only the key of either asynchronous kind.
		case "Future":
		case "Started":
		case "Record":
			return type.type
		case "List":
		case "GenericList":
			return "List"
		case "Dictionary":
		case "GenericDictionary":
			return "Dictionary"
		case "Function":
			return "Function"
		case "Case":
			return `${type.choice}#${type.name}`
		default:
			return null
	}
}

// The tag a Matcher may be lowered to. A Function Matcher's check is
// `typeof`, not a key read.
function lowerableTagOf(matcher: common.Type): string | null {
	if (matcher.type === "Function") {
		return null
	}

	return runtimeTagOf(matcher)
}

// Whether the tag comparison is this Matcher's whole check for every value.
function checkIsTagAlone(matcher: common.Type): boolean {
	switch (matcher.type) {
		case "Boolean":
		case "String":
		case "Integer":
		case "Rational":
		case "Algebraic":
		case "Transcendental":
		case "Randomness":
		case "Future":
		case "Started":
		case "GenericList":
		case "GenericDictionary":
			return true
		case "List":
			return matcher.itemType.type === "Unknown"
		// Either slot that names a Type is a walk of the entries.
		case "Dictionary":
			return (
				matcher.keyType.type === "Unknown" &&
				matcher.valueType.type === "Unknown"
			)
		// The unit Type `{}` and a payload-less Case have nothing under the tag.
		case "Record":
		case "Case":
			return Object.keys(matcher.members).length === 0
		default:
			return false
	}
}

// The one member that carries this tag, or null where several share it or one
// has no nameable tag.
function soleClaimantOf(
	tag: string,
	members: ReadonlyArray<common.Type>,
): common.Type | null {
	let claimant: common.Type | null = null

	for (let member of members) {
		let memberTag = runtimeTagOf(member)

		if (memberTag === null) {
			return null
		}

		if (memberTag !== tag) {
			continue
		}

		if (claimant !== null) {
			return null
		}

		claimant = member
	}

	return claimant
}

// `Object.hasOwn`, as the runtime reads members, so `toString` is not found on
// `Object.prototype`.
export function declaredMemberOf(
	members: Record<string, common.Type>,
	name: string,
): common.Type | undefined {
	return Object.hasOwn(members, name) ? members[name] : undefined
}

// A Union's members, flattened. Any other Type is its own one member.
export function unionMembersOf(type: common.Type): Array<common.Type> {
	if (type.type !== "UnionType") {
		return [type]
	}

	return type.types.flatMap((member) => unionMembersOf(member))
}

// Whether the check passes every value of `valueType`, following
// `isValueOfType` clause for clause.
function checkIsImplied(matcher: common.Type, valueType: common.Type): boolean {
	// The runtime passes any value for these without reading it.
	if (matcher.type === "Unknown" || matcher.type === "GenericUse") {
		return true
	}

	// Every member of the value's Union, but one arm of the Matcher's.
	if (valueType.type === "UnionType") {
		return valueType.types.every((member) =>
			checkIsImplied(matcher, member),
		)
	}

	if (matcher.type === "UnionType") {
		return matcher.types.some((member) => checkIsImplied(member, valueType))
	}

	switch (matcher.type) {
		case "Boolean":
		case "String":
		case "Integer":
		case "Rational":
		case "Algebraic":
		case "Transcendental":
		case "Randomness":
		// By kind alone for the asynchronous Types, as the runtime checks them.
		case "Future":
		case "Started":
			return valueType.type === matcher.type
		case "Function":
			return valueType.type === "Function"
		// An unapplied List or one of `Unknown` checks only the kind.
		case "GenericList":
			return valueType.type === "List" || valueType.type === "GenericList"
		case "List":
			if (matcher.itemType.type === "Unknown") {
				return (
					valueType.type === "List" ||
					valueType.type === "GenericList"
				)
			}

			// Otherwise the runtime walks every item, so a `GenericList` value can not be
			// promised to pass.
			return (
				valueType.type === "List" &&
				checkIsImplied(matcher.itemType, valueType.itemType)
			)
		// The unapplied Dictionary checks only the kind.
		case "GenericDictionary":
			return (
				valueType.type === "Dictionary" ||
				valueType.type === "GenericDictionary"
			)
		case "Dictionary": {
			// Slot by slot. An `Unknown` slot is not walked, and a checked slot can not be
			// promised for a value whose own slot is unknown.
			let keysImplied =
				matcher.keyType.type === "Unknown" ||
				(valueType.type === "Dictionary" &&
					checkIsImplied(matcher.keyType, valueType.keyType))
			let valuesImplied =
				matcher.valueType.type === "Unknown" ||
				(valueType.type === "Dictionary" &&
					checkIsImplied(matcher.valueType, valueType.valueType))

			return (
				(valueType.type === "Dictionary" ||
					valueType.type === "GenericDictionary") &&
				keysImplied &&
				valuesImplied
			)
		}
		// Structural and open: the value must declare every member the Matcher names.
		case "Record":
			return (
				valueType.type === "Record" &&
				membersAreImplied(matcher.members, valueType.members)
			)
		// Nominal first, then structural over the closed payload.
		case "Case":
			return (
				valueType.type === "Case" &&
				valueType.choice === matcher.choice &&
				valueType.name === matcher.name &&
				membersAreImplied(matcher.members, valueType.members)
			)
		default:
			return false
	}
}

function membersAreImplied(
	matcherMembers: Record<string, common.Type>,
	valueMembers: Record<string, common.Type>,
): boolean {
	return Object.entries(matcherMembers).every(([name, memberType]) => {
		let valueMember = declaredMemberOf(valueMembers, name)

		return (
			valueMember !== undefined && checkIsImplied(memberType, valueMember)
		)
	})
}
