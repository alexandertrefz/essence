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
// NOTE: And a fifth question, asked of the same rules by
// `compile-record-members`: what is left of a check the three above could only
// answer `descriptor` for. `recordMatcherTests` is that answer — the members of
// a Record Matcher that a value's static Type does NOT already decide, which is
// a decision tree rather than a residual and is therefore its own function
// rather than a fourth `MatcherResidual`. The three above go on reading exactly
// what they read before, which is what keeps the pass that emits the tree
// something a reader can turn off on its own.
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
	//
	// NOTE: This is the answer `recordMatcherTests` below tries to do better
	// than for a Record Matcher, and the one it falls back to.
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

// NOTE: ONE test of the decision tree a Record Matcher's check becomes — the
// member spine it reads, and what it asks of what it finds there. A tree is a
// run of these, ANDed in the order they are given, and each is a question the
// runtime's own walk would have asked of the same value.
export type MatcherMemberTest = {
	// NOTE: The member names reaching the value this asks about, read from the
	// matched value down. Empty is the matched value itself, which is where the
	// "is it a Record at all" test stands.
	path: ReadonlyArray<string>
	// NOTE: A tag comparison, or the general check over this Type — the same
	// two things `compile-type-tests` writes a Matcher's own check into, asked
	// one level down. A `descriptor` here is the walk moved from the whole value
	// onto the ONE member that still needed it.
	//
	// NOTE: `optional` is whether the value this reads may not be THERE — a
	// member of a Record Matcher that the arriving Types do not all declare,
	// which openness allows a value to reach the test without. The read is made
	// through `?.` and the comparison answers false for a value that is absent,
	// which is exactly what the `Object.hasOwn` the runtime asks first answers
	// for it. It stands on the `tag` arm rather than beside `check` because a
	// walk handed `undefined` would throw and there is nothing for `undefined`
	// to be walked against. Beside `check` that would be an invariant a comment
	// asserts; on the arm it is one the shape refuses to hold.
	check:
		| { kind: "tag"; tag: string; optional: boolean }
		| { kind: "descriptor"; matcher: common.Type }
}

// NOTE: What is left of `isValueOfType(value, <a Record Matcher>)` once the
// static Type of the value is taken into account — the members that actually
// DISCRIMINATE, and null where the argument below does not hold and the walk
// has to stay.
//
// NOTE: THE ARGUMENT. `isValueOfType` against a Record descriptor is a
// conjunction of independent, total, side-effect-free questions: the value's tag
// is `"Record"`, and then, per member the Matcher names, `Object.hasOwn(value,
// name)` and `isValueOfType(value[name], <the member's Type>)`. A Record Matcher
// is structural and OPEN — it names some members, the value may carry more, and
// what it does not name is never looked at — so there is nothing else in the
// check. Every rule below drops one of those questions or replaces it with one
// that answers the same for every value that can arrive, and where a rule can
// not be shown to hold the whole plan is refused rather than narrowed.
//
// NOTE: THE TAG. Dropped exactly where every member of what can arrive carries
// the Record tag, so that every value reaching the test is a Record already; kept
// where some member carries another. A member whose tag can NOT be named — a
// Type Parameter, an `Unknown` — refuses the plan outright rather than merely
// keeping the tag: a value of it may be anything, including a Record carrying
// none of the members below, and the rule that follows would then read a member
// off a value that does not have one.
//
// NOTE: PRESENCE, which the runtime asks with `Object.hasOwn` before every read
// and which openness makes a real question: a Record Type's members are what a
// value of it MUST carry, and a value may carry more, so a member some arriving
// Record declares and another does not may or may not be there. Two cases, and
// they are different claims.
//
// Where EVERY arriving Record declares the member it is there, the read is made
// directly, and the Types those Records declare for it are what can stand there.
//
// Where one does not, nothing is known about the member at all — not that it is
// absent, and not what it holds if it is present, because what openness adds it
// adds unconstrained. So the requirement is measured against `Unknown`, which
// leaves exactly the requirements the runtime answers with ONE tag comparison
// whatever it is handed — a scalar, a payload-less Case, a List whose items are
// not named — and the read is made through `?.`. `value.name?.[<Type key>] ===
// "Integer"` is `Object.hasOwn(value, "name") && isValueOfType(value.name,
// Integer)` exactly: an absent member reads `undefined`, an inherited one (a
// Matcher may name `toString`) reads a Function, and neither holds a Type key.
// Any other requirement — a Record, a payload-carrying Case, a List of a named
// item Type — needs a walk of a value that may not be there, and the plan
// declines instead.
//
// NOTE: WHICH MEMBERS ARE TESTED. A declared one is dropped where the
// requirement is implied by every Type the member can declare among the arriving
// Records, which is `checkIsImplied` — the implication the Matcher's own check is
// decided by, asked one level down. So the tree tests exactly the members the
// static Type does not already settle, and a Matcher every member of which is
// settled is not this function's business at all: `matcherResidualOverMembers`
// answers `always` or a tag for it above. An UNdeclared member is never dropped,
// even where the requirement is implied by everything — a Type Parameter is —
// because the runtime still asks whether the member is THERE, and for such a
// requirement that question is the whole of the test. What is left is a presence
// question with no tag to fold it into, which the tree has no test for: a
// `MatcherMemberTest` asks a tag or asks the walk, and neither is `hasOwn`
// alone. So the plan is REFUSED there — the same refusal every requirement gets
// that `Unknown` does not answer with one comparison — and the walk, which asks
// `hasOwn` itself, is what keeps asking it.
//
// NOTE: ERASURE, case by case. A checked refinement is erased before any pass
// runs, so a refined Type arrives here as the Type it refines and is tested as
// that — there is no run-time notion of a predicate for either this or the walk
// to ask about. A Type Parameter or an `Unknown` is answered from both sides: as
// a REQUIREMENT it is implied by everything, because the runtime answers true
// for one without reading the value, so the member is dropped; as something that
// can ARRIVE it refuses the plan, because neither its tag nor its members can be
// named. A Union-typed member contributes every one of its members to both
// questions — the requirement must be implied by all of them to be dropped, and
// the residual over all of them is what the kept test becomes — which is why a
// nested plan can still need a Record tag test of its own. Two Record Types with
// the same member NAMES and different member Types are the shape this is for:
// both carry the Record tag, and the residual over the two declared Types at the
// member is a tag comparison. Two differing only in a member whose Type is a
// Type Parameter are told apart by nothing the runtime can read, and the plan
// says exactly that: the requirement is implied, the member is dropped, and what
// is left is what the walk would have concluded too.
//
// NOTE: NESTING, and the one ordering rule that is load-bearing. The descent is
// this same argument applied to the value at a member, with that member's
// presence established by the level above it — so a test is sound only when
// every test on a PREFIX of its spine has already passed. The plan emits a
// level's own tag test before descending into it, and `orderedTests` may not
// move a test ahead of its prefix, which is what its order is arranged to keep.
//
// NOTE: The descent is bounded by IDENTITY — a Matcher already being planned is
// not planned again, and the member keeps its walk instead — because this walks
// a TYPE, which may hold a back edge, where the runtime's own walk terminates by
// walking a VALUE, which is finite. It is insurance rather than a rule anything
// reaches today, and it is not the whole story either: a Record whose members
// lead back to it needs a recursive Type declaration, which the Enricher
// refuses, and `checkIsImplied` — which every level here asks first — walks the
// same graph with no guard of its own. What this bounds is THIS descent, so that
// a Type graph the Compiler ever does build can not make a pass loop.
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

// NOTE: The plan for ONE level, appending its tests and answering whether it
// holds. It appends nothing a caller has to undo: a nested level plans into an
// array of its own and is spliced in only once it has held, and a level that
// refuses is refused all the way up, where the whole plan is thrown away.
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
			// NOTE: What the member DECLARES across every arriving Record,
			// flattened, and whether they ALL declare it. Where they do not,
			// what can stand there is unconstrained rather than the union of
			// what some of them said — openness adds a member of any Type at
			// all — so the declarations that were made say nothing and the
			// requirement is measured against `Unknown`.
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

			// NOTE: Vacuously true where no Record can arrive at all, which is
			// right: every value then fails at the tag test above, and that test
			// is the whole tree. The walk fails at its own first comparison for
			// the same reason.
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

// NOTE: The order the tree is read in, and the whole of what the Compiler
// chooses about it. COST first — every tag comparison, then every walk —
// because the walk is the one test that can still cost a call, and a walk of a
// List's items costs one per item, so a tree reaching it ahead of a comparison
// that would have declined is a tree dearer to run than the walk it replaced.
// The runtime's own check asks the Matcher's members in the order they were
// written and stops at the first that declines, so ordering by anything but
// cost is a way to lose to it.
//
// NOTE: And cost is what keeps every test behind the tests that establish the
// spine it reads, which is what the order has to guarantee. A `descriptor` test
// is a LEAF: `planRecordTests` descends into a member or writes one for that
// member, never both, so no test stands below one — and a test standing on a
// PREFIX of another's spine is therefore always a tag comparison. Cost puts
// every one of those ahead of every walk, and DEPTH orders them among
// themselves, where a proper prefix is strictly shorter than what it guards and
// so can not be moved after it. Walks are leaves and guard nothing, so their
// order among themselves is free; stable, so a Matcher's own member order
// decides it, which is the order the walk would have asked them in.
//
// NOTE: The order is invisible except in time. Every test is a property read of
// an immutable value and a comparison, or a walk that reads only the value it is
// handed: none can fail, allocate or observe anything, so a conjunction of them
// answers the same however it is arranged.
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
	// be REWRITTEN to. A Function Matcher is the difference: its check is
	// `typeof`, so it may not be lowered to a key comparison, while a Function
	// asked about anything carrying a Type key is refused before the check runs.
	// A Record Matcher asked about an Integer is refused by that very tag as
	// well, before any member is looked at.
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
// A Function Matcher is left alone because callability, not a key, is what the
// runtime asks of one.
//
// NOTE: A Record Matcher IS offered here, and the two rules above decide it the
// same way they decide anything else. Its tag says only that the value is a
// Record, so `checkIsTagAlone` refuses one naming any member at all and the tag
// stands alone only for `{}`, the unit Type. What settles the rest is
// `soleClaimantOf`: where exactly ONE member of what can arrive carries the
// Record tag and that member implies the Matcher, every value reaching the test
// either carries the tag and passes the whole check or carries another and fails
// it before a member is read. `{ x: Integer, y: Integer } | String` is that
// shape, and it is the common one — a Record beside Types of other kinds.
//
// NOTE: Two Records in one Union are NOT that shape: both claim the tag, so
// there is no sole claimant, and what tells them apart is their members.
// `compile-record-members` is what reads those, and `recordMatcherTests` below
// is what decides which of them it may read.
function lowerableTagOf(matcher: common.Type): string | null {
	if (matcher.type === "Function") {
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
		// NOTE: A Record naming no member is the unit Type `{}`, which every
		// Record satisfies — so the tag is the whole check, exactly as it is
		// for a payload-less Case. A Record naming any member is not: its tag
		// says only that the value is a Record.
		case "Record":
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

// NOTE: What a Record or a Case DECLARES under a name, and `undefined` where it
// declares nothing — `Object.hasOwn`, never a bare read, for exactly the reason
// `isValueOfType` reads a value's members with it: a members map is an ordinary
// JavaScript object, so `members["toString"]` finds a function on
// `Object.prototype` for a Type that names no such member, and every rule here
// would then be reasoning about a member the value need not carry. A Matcher
// naming `toString` whose requirement is a Type Parameter was answered `always`
// by `checkIsImplied` because of it, which is the answer two passes DROP a check
// on.
export function declaredMemberOf(
	members: Record<string, common.Type>,
	name: string,
): common.Type | undefined {
	return Object.hasOwn(members, name) ? members[name] : undefined
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
		let valueMember = declaredMemberOf(valueMembers, name)

		return (
			valueMember !== undefined && checkIsImplied(memberType, valueMember)
		)
	})
}
