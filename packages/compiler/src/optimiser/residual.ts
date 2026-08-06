import type { common } from "@essence-lang/interfaces"

// NOTE: What a Matcher's runtime Type check REDUCES TO once the Type of the
// value being tested is taken into account. `$type.isValueOfType(value,
// <descriptor>)` is a general answer to a general question — it walks a
// descriptor tree it was handed and asks about a value it knows nothing about —
// and at almost every site the Compiler already knows which of its branches can
// be taken. The residual is the part it does not know.
//
// NOTE: It is asked by three places and computed in one: `compile-type-tests`
// rewrites a Match Handler's check into it, `elide-final-match-test` asks
// whether a Handler's check is decided by tags at all, and `compile-union-dispatch`
// asks the same question of a dispatch case's member Type. One answer, so the
// three can not drift apart — which matters, because two of them REMOVE a check
// on the strength of what the third emits.
//
// NOTE: A fourth pass asks the opposite question of the same rules —
// `prune-dead-match-arms` reads `matcherIsRefuted` below, which proves a check
// FALSE rather than reducing it. It is written here rather than beside that pass
// for the same reason the three above share one function: what a Matcher can and
// can not accept is one reading of `isValueOfType`, and two readings would be
// two chances to disagree with it.
//
// NOTE: Conservative in one direction only. Every rule here narrows a check the
// runtime would have performed to a cheaper one that answers the same, and where
// the Compiler can not prove the two agree it says `descriptor` and the full
// check stays. So a rule that is missing costs speed, and only a rule that is
// WRONG costs correctness — which is why erasure is asked about explicitly
// rather than assumed away.

export type MatcherResidual =
	// NOTE: The value's hidden Type key decides it, on its own: every value that
	// can reach this test and carries this tag passes the Matcher, and every
	// value that does not carry it fails.
	| { kind: "tag"; tag: string }
	// NOTE: Nothing is left to test — the check the runtime would have run
	// answers true for every value that can reach it. A wildcard Handler
	// (`case _`) and a Matcher naming the scrutinee's only Type are both this.
	| { kind: "always" }
	// NOTE: The check stands as written. Either the Matcher asks something no
	// tag can answer — a Record's members, a List's items — or erasure leaves
	// two Types sharing one tag and the payload is what tells them apart.
	| { kind: "descriptor" }

export function matcherResidual(
	matcher: common.Type,
	valueType: common.Type,
): MatcherResidual {
	return matcherResidualOverMembers(matcher, unionMembersOf(valueType))
}

// NOTE: The same question asked of the MEMBERS themselves, for a caller holding
// them rather than the Union they were read out of. A Union dispatch is that
// caller: the Enricher built one case per member of the receiver's Union, so
// the case list IS the set of values that can arrive, and reading the Union's
// spelling a second time would be asking a second source for an answer the
// cases already give.
//
// NOTE: `matcherResidual` is this function with the members flattened out of a
// Type, and the two therefore can not drift: what a Match Handler's check
// reduces to and what a dispatch case's check reduces to are decided by the
// same rules in the same order.
export function matcherResidualOverMembers(
	matcher: common.Type,
	members: ReadonlyArray<common.Type>,
): MatcherResidual {
	let tag = lowerableTagOf(matcher)

	if (tag !== null) {
		// NOTE: Some Matchers ARE a tag test, whatever they are asked about —
		// there is nothing under the tag for the runtime to look at — so those
		// need no argument about what can arrive.
		if (checkIsTagAlone(matcher)) {
			return { kind: "tag", tag }
		}

		let claimant = soleClaimantOf(tag, members)

		if (claimant !== null && checkIsImplied(matcher, claimant)) {
			return { kind: "tag", tag }
		}
	}

	// NOTE: Every member, because any of them may arrive — which is the arm
	// `checkIsImplied` takes for a Union-typed value, with the members already
	// in hand.
	if (members.every((member) => checkIsImplied(matcher, member))) {
		return { kind: "always" }
	}

	return { kind: "descriptor" }
}

// NOTE: The question from the other side: whether `isValueOfType(value,
// matcher)` answers FALSE for every value that can arrive — the Matcher not
// merely failing to be implied, but unable to accept anything at all. A Match
// Handler whose Matcher is refuted is one that can never run, which the
// Validator has already reported as `unreachable-case`, and
// `prune-dead-match-arms` is what takes it out of the chain.
//
// NOTE: It is asked separately from `matcherResidual` rather than added to it as
// a fourth answer, so that the three passes reading that function keep reading
// exactly what they read before: a refuted Matcher still compiles to the test it
// always compiled to, and the arm is dropped by the pass whose question this is.
export function matcherIsRefuted(
	matcher: common.Type,
	valueType: common.Type,
): boolean {
	let members = unionMembersOf(valueType)

	// NOTE: No members is no argument. A Union always has some, and a Type that
	// is not one is its own member, so this is unreachable — and answering
	// `true` for it would be answering "nothing can arrive" for a value the
	// Compiler simply could not enumerate.
	return (
		members.length > 0 &&
		members.every((member) => checkIsRefuted(matcher, member))
	)
}

// NOTE: What refutation rests on, and the whole of it: `isValueOfType` compares
// the value's hidden Type key FIRST in every arm it has, and a value of a Type
// whose tag the Compiler can name carries that tag and no other. So two tags
// that differ are a check that fails before it looks at anything else.
//
// NOTE: Everything the Compiler can not name a tag for answers `false` — not
// refuted — which is where erasure is answered from this side. A Type Parameter
// or an `Unknown` stands for a value of any kind, and a Matcher that accepts
// every value without looking (`case _`, a Generic Matcher) refutes nothing at
// all.
//
// NOTE: Two Types SHARING a tag are not refuted either, and that is not a
// conservatism this could be tightened out of: `List<Alpha>` and `List<Beta>`
// are both `"List"` and the empty List passes both, `Box<Integer>#Holding` and
// `Box<String>#Holding` are both `"Box#Holding"`, and two Records differing in
// their members are both `"Record"`. What tells any of those apart is a walk of
// the value, which is a question about the value rather than about its Type.
function checkIsRefuted(matcher: common.Type, valueType: common.Type): boolean {
	if (matcher.type === "Unknown" || matcher.type === "GenericUse") {
		return false
	}

	// NOTE: The value's own Union first, where EVERY member has to be refuted
	// because any of them may arrive. The Matcher's Union after it, where every
	// arm has to be — `isValueOfType` asks `some` of a Union descriptor, so one
	// arm that could accept is the whole Matcher accepting.
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

	// NOTE: The tag a value of each Type CARRIES, on both sides — and not
	// `lowerableTagOf`, which is a narrower question about what a Matcher may
	// be REWRITTEN to. A Record Matcher can not be lowered to a tag test,
	// because every Record carries the same tag and the members are what
	// decide; but a Record Matcher asked about an Integer is refused by that
	// very tag, before any member is looked at. The same holds for a Function
	// Matcher, whose check is `typeof` — no value carrying a Type key is one.
	let matcherTag = runtimeTagOf(matcher)
	let valueTag = runtimeTagOf(valueType)

	return matcherTag !== null && valueTag !== null && matcherTag !== valueTag
}

// NOTE: The hidden Type key a value of this Type carries — what
// `value[$type.typeKeySymbol]` reads, and what `isValueOfType` compares first
// for every Type that has one. `null` means the Compiler can not say: a Type
// Parameter or an `Unknown` stands for a value of any kind at all, so nothing
// may be concluded from a tag not matching OR from one matching.
//
// NOTE: A Function is the one value carrying no key at all, and it is given a
// name here regardless — `"Function"` is not a tag any value can hold (a real
// one is a runtime kind or `<Choice>#<Case>`), so a Function member of a Union
// answers no tag test, which is exactly right. `lowerableTagOf` is what refuses
// to lower a Function MATCHER, whose check is `typeof` rather than a key read.
function runtimeTagOf(type: common.Type): string | null {
	switch (type.type) {
		case "Boolean":
		case "String":
		case "Integer":
		case "Rational":
		case "Algebraic":
		case "Transcendental":
		case "Record":
			return type.type
		case "List":
		case "GenericList":
			return "List"
		case "Function":
			return "Function"
		case "Case":
			return `${type.choice}#${type.name}`
		default:
			return null
	}
}

// NOTE: The tag a MATCHER may be lowered to, which is a shorter list than the
// one above.
//
// A Record Matcher is left alone: its tag says only that the value is a Record,
// and a Match distinguishing Records distinguishes them by their MEMBERS, so
// the tag decides nothing. (Reading the discriminating members directly is a
// decision tree, and a decision tree is a pass of its own — see the note in
// `optimisations.md`.)
//
// A Function Matcher is left alone because callability, not a key, is what the
// runtime asks of one.
function lowerableTagOf(matcher: common.Type): string | null {
	if (matcher.type === "Record" || matcher.type === "Function") {
		return null
	}

	return runtimeTagOf(matcher)
}

// NOTE: Whether this Matcher's whole runtime check is the tag comparison —
// whether `isValueOfType(value, matcher)` and `tagOf(value) === tag` are the
// same expression for EVERY value, so that nothing needs to be known about what
// can arrive.
//
// A scalar is the plainest case: the runtime's answer for `{ type: "Integer" }`
// is one key comparison and no more. A List Matcher naming no item Type stops
// at the kind for the same reason — there is nothing to check the items
// against. And a Case declaring no payload members has none to compare once the
// tag has said which Case it is.
function checkIsTagAlone(matcher: common.Type): boolean {
	switch (matcher.type) {
		case "Boolean":
		case "String":
		case "Integer":
		case "Rational":
		case "Algebraic":
		case "Transcendental":
		case "GenericList":
			return true
		case "List":
			return matcher.itemType.type === "Unknown"
		case "Case":
			return Object.keys(matcher.members).length === 0
		default:
			return false
	}
}

// NOTE: The one member of the value's Type that could carry this tag — and null
// unless there is EXACTLY one, which is where erasure is answered. Two members
// sharing a tag means the tag does not say which of them arrived: `List<Alpha> |
// List<Beta>` are both `"List"`, and `Box<Integer>#Holding` and
// `Box<String>#Holding` are both `"Box#Holding"`, so what tells them apart is
// the payload the full check walks.
//
// NOTE: A member whose tag can not be named at all — a Type Parameter, an
// `Unknown` — refuses the whole question rather than merely failing to claim the
// tag. A value of it can be anything, including something carrying this very
// tag and failing the Matcher's payload check.
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

// NOTE: A Union's members, flattened — a Union of Unions is one set of values
// however it was spelled, and an alias (`Optional<Integer>`) is the Union it
// stands for by the time a Type reaches here. Anything else is one member: its
// own.
export function unionMembersOf(type: common.Type): Array<common.Type> {
	if (type.type !== "UnionType") {
		return [type]
	}

	return type.types.flatMap((member) => unionMembersOf(member))
}

// NOTE: Whether `isValueOfType(value, matcher)` answers TRUE for every value of
// `valueType` — the Matcher's check read against what the Compiler knows the
// value to be, arm by arm, exactly as the runtime would walk it.
//
// NOTE: It follows `isValueOfType` clause for clause, which is what makes it
// checkable against that function rather than against an intention. Where the
// runtime answers true without looking (a Type Parameter, an `Unknown`, a List
// whose item Type is erased) this answers true; where the runtime looks at
// something this can not see, it answers false and the caller keeps the check.
function checkIsImplied(matcher: common.Type, valueType: common.Type): boolean {
	// NOTE: Types erase, so the runtime answers true for both of these without
	// reading the value at all — whatever it is.
	if (matcher.type === "Unknown" || matcher.type === "GenericUse") {
		return true
	}

	// NOTE: The value's own Union first: the Matcher has to accept EVERY member,
	// because any of them may arrive. The Matcher's Union after it, where any
	// ONE accepting arm is enough — `isValueOfType` asks `some` of a Union
	// descriptor.
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
			return valueType.type === matcher.type
		case "Function":
			return valueType.type === "Function"
		// NOTE: The unapplied `List` names no item Type, and a List Matcher
		// whose item Type is `Unknown` is the same question — the runtime stops
		// at the kind for both, so any List passes.
		case "GenericList":
			return valueType.type === "List" || valueType.type === "GenericList"
		case "List":
			if (matcher.itemType.type === "Unknown") {
				return (
					valueType.type === "List" ||
					valueType.type === "GenericList"
				)
			}

			// NOTE: The other way round the item Type is NOT erased — the
			// runtime walks every item — so a value whose items are unknown
			// (`GenericList`) can not be promised to pass.
			return (
				valueType.type === "List" &&
				checkIsImplied(matcher.itemType, valueType.itemType)
			)
		// NOTE: A Record Matcher is structural and OPEN: the value has to carry
		// every member the Matcher names, and may carry more.
		case "Record":
			return (
				valueType.type === "Record" &&
				membersAreImplied(matcher.members, valueType.members)
			)
		// NOTE: A Case Matcher is nominal first — the same Choice and the same
		// Case — and then structural over the payload, which is closed.
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
		let valueMember = valueMembers[name]

		return (
			valueMember !== undefined && checkIsImplied(memberType, valueMember)
		)
	})
}
