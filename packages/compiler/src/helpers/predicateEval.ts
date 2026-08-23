import type { common } from "@essence-lang/interfaces"

import {
	applyGenericBindings,
	buildUnion,
	type GenericBindings,
	genericNamesMentioned,
	matchesType,
	matchesTypeWithBindings,
	provenConjuncts,
} from "./index"

// NOTE: Whether a value is admitted into a refinement by DECIDING its predicate
// here, while compiling. A refinement normally needs a branch in front of it —
// something has to have asked the question — but a value written DOWN needs
// nobody to ask: `constant d: NonZeroInteger = 3` is a NonZeroInteger because 3
// is not zero, and the Compiler can see that as plainly as a reader can. The
// same question is asked of an Argument, of a returned value, and of a declared
// Property.
//
// Nothing here reports. A value that is not admitted is a value the ordinary
// mismatch belongs to, and that Diagnostic is written where the value stands,
// with `describePredicate` below naming what went unanswered.
//
// NOTE: Only a written LITERAL is admitted. Anything else would have to be
// evaluated, and evaluating Essence while compiling means an interpreter, a fuel
// budget and a second implementation of every native — so what is here instead
// is an ALLOWLIST: a table of predicates whose meaning is written out over
// JavaScript scalars, keyed by the Namespace that answered and the Method. A
// conjunct the table does not name is not admitted, and that is the whole of the
// failure mode: the Program says what it always said, and the value goes through
// a branch.
//
// NOTE: The key can be trusted because the Namespaces it names are the standard
// library's and a Program can not redeclare one — `namespace Integer for
// Integer` is refused for the name alone, which is already declared. So an
// `Integer::isNot` conjunct is the standard library's `isNot` and no other, and
// the meanings below are its meanings, read off its bodies.
//
// The Overload is no part of a conjunct at all. An Overload is told apart by the
// Arguments it takes, and an entry that can not decode the Arguments it was
// given refuses — which is how `@::isLessThan(1/2)`, Integer's Rational
// Overload, falls out here rather than being compared as though the bound were
// an Integer.
//
// NOTE: The table is over the PRIMITIVES alone, because a conjunct is stored
// resolved: `isZero` arrives as `is`, `hasCharacters` as a negated `isEmpty`,
// `isGreaterThanOrEqualTo` as a negated `isLessThan` over the bound the call
// wrote. Every Method the standard library writes on another one is gone by the
// time a value is asked about it, and what is left is the handful of questions
// that read a value directly.
//
// Which Methods those are is read off their BODIES rather than named anywhere,
// so the list is not a promise this file may keep on its own: the census in
// `stdlibLoader.spec.ts` is the whole of it, and a body rewritten to stop
// forwarding puts a question here that nothing can decide.
export function admittedByEvaluation(
	refinement: common.RefinementType,
	value: common.typed.ExpressionNode,
): boolean {
	return admissionOfWrittenValue(value)?.(refinement) ?? false
}

// NOTE: The Type a written value is admitted AT, given the Type its position
// asks for — which is the question every site below really has, since a position
// naming a refinement wants the refinement back to match its Parameter by.
// `null` is "nothing here was decided": the position asks for no evidence, or
// the value did not answer what it asked.
//
// NOTE: A written LIST is asked item by item. The two List predicates read the
// count and nothing else, so `[[1], [2, 3]]` is a `List<NonEmptyList<Integer>>`
// for the same reason `[1]` is a `NonEmptyList<Integer>` — the brackets are
// right there, one pair per item. What comes back is a List of what the ITEMS
// decided rather than of what the position asked, so a position whose item Type
// is still binding Type Parameters gets the instantiation the values made.
//
// An item that decides nothing has to fit as it stands, which is what refuses
// an empty one and refuses an opaque one BY TYPE: `[[1], made()]` is admitted
// exactly when `made()` already answers a `NonEmptyList`.
export function admittedTypeOf(
	expected: common.Type,
	value: common.typed.ExpressionNode,
): common.Type | null {
	if (expected.type === "Refinement") {
		let asked = refinementDecidedBy(expected, value.type)

		return asked !== null && admittedByEvaluation(asked, value)
			? asked
			: null
	}

	if (
		expected.type !== "List" ||
		value.nodeType !== "ListValue" ||
		!refinementInside(expected.itemType)
	) {
		return null
	}

	let itemTypes: Array<common.Type> = []

	for (let item of value.values) {
		let decided = admittedTypeOf(expected.itemType, item)

		if (decided === null && !matchesType(expected.itemType, item.type)) {
			return null
		}

		itemTypes.push(decided ?? item.type)
	}

	// NOTE: The empty written List decides nothing and needs to: its item Type
	// is Unknown, which every List Type already accepts.
	return itemTypes.length === 0
		? null
		: { type: "List", itemType: buildUnion(itemTypes) }
}

// NOTE: Whether a written value fits where it stands — assignability, plus the
// evidence a written value carries of its own. Every position that measures a
// value against a Type it did not resolve asks this rather than `matchesType`.
export function fitsWritten(
	expected: common.Type,
	value: common.typed.ExpressionNode,
): boolean {
	return (
		matchesType(expected, value.type) ||
		admittedTypeOf(expected, value) !== null
	)
}

// NOTE: Whether a position asks a written value for evidence at all — the one
// cheap question every Argument is asked before anything is read or memoised.
// Down the List spine only: an item is a position a written List has a Node
// for, and a Record's or a Case's member is one this would have to learn to
// read before it could ask.
export function refinementInside(type: common.Type): boolean {
	return (
		type.type === "Refinement" ||
		(type.type === "List" && refinementInside(type.itemType))
	)
}

// NOTE: The first written item that did not answer the question its position
// asks, and that question — what a Diagnostic points at when a List is refused
// for something one item in it did not prove. `null` where the refusal is about
// the List itself, which is what every site already reports.
export function unadmittedWrittenItem(
	expected: common.Type,
	value: common.typed.ExpressionNode,
): {
	value: common.typed.ExpressionNode
	refinement: common.RefinementType
} | null {
	let listType = expected.type === "Refinement" ? expected.base : expected

	if (
		listType.type !== "List" ||
		value.nodeType !== "ListValue" ||
		!refinementInside(listType.itemType)
	) {
		return null
	}

	for (let item of value.values) {
		if (fitsWritten(listType.itemType, item)) {
			continue
		}

		return (
			unadmittedWrittenItem(listType.itemType, item) ??
			(listType.itemType.type === "Refinement"
				? { value: item, refinement: listType.itemType }
				: null)
		)
	}

	return null
}

// NOTE: The same question asked of MANY refinements at once, with the value read
// only once. A Method receiver is the one position nothing hands an expected
// Type — it is typed bottom-up and Namespace lookup runs from whatever that came
// to — so it asks every refinement in scope instead of one, and reading a written
// List's items again per candidate is work the answer does not depend on.
//
// `null` is "not a value the Compiler can see written", which is the receiver's
// first question and the cheapest: a receiver the table can not read costs one
// switch and no candidate walk at all.
export function admissionOfWrittenValue(
	value: common.typed.ExpressionNode,
): ((refinement: common.RefinementType) => boolean) | null {
	let literal = literalValueOf(value)

	if (literal === null) {
		return null
	}

	// NOTE: The base is asked as well as the predicate. `["a"]::hasItems()` is
	// true of a List of Strings and says nothing whatever about the
	// `List<Integer>` a refinement of that base demands — the conjuncts alone
	// would admit it.
	//
	// NOTE: Asked as a WRITTEN value, so a base that names a refinement of its
	// own reaches the items — `NonEmptyList<NonEmptyList<Integer>>` proves its
	// own count here and asks the base for each item's. A base naming no
	// refinement costs the one `matchesType` it always cost.
	return (refinement) =>
		fitsWritten(refinement.base, value) &&
		provenConjuncts(refinement).every(
			(conjunct) => evaluateConjunct(conjunct, literal) === true,
		)
}

// NOTE: The refinement a written value is asked ABOUT, where the position it
// stands at has not finished saying what it is. A Parameter written
// `NonEmptyList<Item>` in a signature that infers `Item` is not a Type until
// something decides that Parameter, and while an Argument is being matched
// nothing has: the base is `List<Item>`, which no written List is ever of, so the
// question above could not be asked at all and every literal was refused.
//
// So it is asked of the refinement the value itself DECIDES — the declared base
// unified against the value's own Type, substituted through. `["a"]` decides
// `Item` as String and answers `hasItems` about a `List<String>`, which is the
// same question a `NonEmptyList<String>` Parameter would have asked outright.
//
// A unification that leaves one Parameter undecided is no question to ask: an
// empty List's `List<Unknown>` is accepted by `List<Item>` without saying what
// `Item` is — the Unknown is a slot nothing has filled — and a refinement over a
// base nobody decided would hand the call a Type nobody wrote. The same rule
// `instantiatedRefinementFor` establishes a narrowing by, for the same reason.
//
// The Parameters asked about are the ones the BASE names, which is what a value
// can decide anything about. An Alias' Parameter the base does not mention is
// nothing this value was ever going to answer for — it stays open, and the call
// reports it uninferable exactly as it does for an unrefined signature. A
// narrowing demands all of them because there is no call behind it to report
// anything: the branch either establishes a whole Type or none.
//
// NOTE: This is what the value is asked about and NOT what it may answer with.
// The bindings are worked out in a Map of this call's own, so a losing Overload
// probe leaves nothing behind; and the instantiation is handed back to
// `matchTypes` against the Parameter as DECLARED, which binds an `infer`
// Parameter through the base — never to the refinement, the v1 rule — and refuses
// an opaque one outright. A `Filled<Item>` whose `Item` belongs to the enclosing
// Declaration accepts no `Filled<String>`, so a written value proves nothing
// there, exactly as it should not.
export function refinementDecidedBy(
	refinement: common.RefinementType,
	valueType: common.Type,
): common.RefinementType | null {
	let parameters = genericNamesMentioned(refinement.base)

	// NOTE: Every non-generic refinement, which comes back as ITSELF — the
	// question a `NonZeroInteger` Parameter asks is the one it was written as.
	if (parameters.size === 0) {
		return refinement
	}

	let bindings: GenericBindings = new Map()

	if (
		!matchesTypeWithBindings(refinement.base, valueType, {
			bindableNames: parameters,
			bindings,
		}) ||
		[...parameters].some((parameter) => !bindings.has(parameter))
	) {
		return null
	}

	let instantiated = applyGenericBindings(refinement, bindings)

	return instantiated.type === "Refinement" ? instantiated : null
}

// NOTE: The predicate spelled back out of the conjuncts, for the Diagnostic that
// has to name the question a value did not answer. The typed predicate
// Expression lives on the Type Alias Statement it was written on, and nothing
// reporting about a refinement has that Node in hand, so what is printed is the
// CANONICAL form: the conjuncts in the order they are compared, joined the way a
// chain is written.
//
// An Argument LABEL is not part of what makes two conjuncts the same question,
// so it is not kept and a labelled Method prints its Arguments bare —
// `@::isBetween(0, 9)` for a clause written `@::isBetween(0, and 9)`. The text
// names the question; it is not offered as something to paste.
//
// NOTE: A leaf is stored RESOLVED — `@::hasCharacters()` is `String::isEmpty`
// negated — and what is printed is the name it was WRITTEN as, which the leaf
// carries for this one purpose. A reader is told the predicate they wrote and
// not the Method the standard library wrote it on top of. A leaf nobody wrote
// carries no spelling, and those are exactly the synthesized ones — a
// complement, a Matcher's `case 0` — which no Diagnostic ever names.
// NOTE: Folded from the FIRST conjunct rather than from a seed, because a
// refinement proving nothing does not exist: a predicate spells one leaf or a
// conjunction of leaves, so the set is never empty, and the unresolved case is
// refused by `provenConjuncts` before it gets here. A seeded fold would have to
// name a `first` that the Type system, with no index checking, calls a String
// whether one is there or not — and would answer the Diagnostic the text
// "undefined" for a refinement nobody can write.
export function describePredicate(refinement: common.RefinementType): string {
	return provenConjuncts(refinement)
		.map(spellConjunct)
		.reduce((chain, conjunct) => `${chain}::and(${conjunct})`)
}

function spellConjunct(conjunct: common.PredicateConjunct): string {
	let written = conjunct.spelling ?? conjunct
	let call = `@::${written.methodName}(${written.args
		.map(spellScalar)
		.join(", ")})`

	// NOTE: A spelling is written the way it was asked, so the flag is already
	// in the name and adding anything would be saying it twice. Only a leaf
	// nobody wrote can reach the negation here, and it prints as the Essence a
	// reader would have to write for it.
	return conjunct.negated && conjunct.spelling === undefined
		? `${call}::negate()`
		: call
}

// NOTE: A String Argument arrives already quoted — that is what tells `1` from
// `"1"` in the key — and every other scalar is bare digits, a fraction or a
// Boolean. So the scalar IS its own spelling, and the only one that has to be
// made into text is the Boolean.
function spellScalar(scalar: string | boolean): string {
	return typeof scalar === "boolean" ? String(scalar) : scalar
}

// NOTE: A written value as the JavaScript the table below compares — a bigint
// for an Integer, because that is what an Integer is at run time and what its
// digits mean, and a PAIR of them for a Rational, kept in lowest terms with the
// sign on the numerator, because that is what a Rational is at run time and
// what `1/2` and `2/4` both mean.
//
// A List is admitted by its LENGTH. `[x, y]` holds exactly two items whatever
// `x` and `y` turn out to be: a List literal is a bracketed list of
// Expressions, the grammar has no spread, and so nothing a Program can write
// makes a written List's length depend on what stands inside it. The two List
// predicates are `isEmpty` and `hasItems`, which read that count and nothing
// else. So an item is KEPT where it is written out and stands OPAQUE where it
// is not, and the List around it counts the same either way.
//
// This was once "a List counts as written when its items are written too",
// which refused `[{ x = 1 }]` for holding a Record — a value written down as
// plainly as any other, in a position where nothing was ever going to ask what
// was in it. What that rule was really guarding is still guarded, and by the
// Type rather than by care: `Opaque` is a kind of its own, every reader below
// asks for the kind it wants, and so a predicate that ever reads an ITEM
// answers `null` for an opaque one and refuses — exactly as it does for a value
// of the wrong shape.
//
// NOTE: Only an ITEM is ever opaque. `literalValueOf` answers `null` for an
// Expression it can not read, and `admittedByEvaluation` refuses on that before
// a single conjunct is asked: a value the Compiler can not see at all is not a
// value it may decide anything about, and a List is the one shape it can see
// something about without seeing the whole of it.
type LiteralValue =
	| { kind: "Integer"; value: bigint }
	| { kind: "Rational"; numerator: bigint; denominator: bigint }
	| { kind: "String"; value: string }
	| { kind: "Boolean"; value: boolean }
	| { kind: "List"; items: Array<LiteralItem> }

type LiteralItem = LiteralValue | { kind: "Opaque" }

const OPAQUE_ITEM: LiteralItem = { kind: "Opaque" }

// NOTE: `null` is "not a shape this entry can decide" — the wrong kind of value,
// or Arguments it can not read — and is what makes the table refusable entry by
// entry rather than by a second list of shapes each entry accepts.
type PredicateEvaluator = (
	value: LiteralValue,
	args: Array<string | boolean>,
) => boolean | null

// NOTE: The comparisons are declared once by `Orderable`, which provides them
// for every numeric kind, and AGAIN on Integer, where the same-kind entry is
// written on the same-kind native — a performance stratification the standard
// library explains at length. Either way the conjunct names the NAMESPACE whose
// conformance answered: an Integer receiver's `isLessThan` is Integer's own
// entry and its `isBetween` is the one Orderable provides through Integer's
// conformance, and both are `Integer::…` here. Both spellings are the same
// question about the same two integers.
const NUMERIC_COMPARISONS: Record<string, PredicateEvaluator> = {
	is: integerComparison((value, other) => value === other),
	isLessThan: integerComparison((value, other) => value < other),
	isGreaterThan: integerComparison((value, other) => value > other),

	// NOTE: Both bounds included, and bounds in the wrong order enclosing
	// nothing — which is what the standard library's own body says, so the answer
	// here is `false` for them rather than unanswerable.
	isBetween: (value, args) => {
		let integer = integerLiteral(value)

		if (integer === null || args.length !== 2) {
			return null
		}

		let lower = integerScalar(args[0])
		let upper = integerScalar(args[1])

		return lower === null || upper === null
			? null
			: integer >= lower && integer <= upper
	},
}

// NOTE: Integer's alone — `Number` declares none of these over the tower.
// `isZero`, `isPositive` and `isNegative` are not here: each is written on a
// comparison above and arrives as that comparison, so the table would be asked
// a question nothing can spell any more.
const INTEGER_QUESTIONS: Record<string, PredicateEvaluator> = {
	// NOTE: A negative remainder is still a remainder — `-3 % 2` is `-1` in
	// JavaScript — so evenness is asked as "the remainder is zero", which is
	// also how Integer writes it. Oddness is the same leaf negated and is
	// decided by the flag rather than by a row of its own.
	isEven: integerQuestion((value) => value % 2n === 0n),
}

// NOTE: Essence's String equality is canonical equivalence: `String.is` is
// `compare(to other)::is(#Equal)` and `compare` orders the NFC-normalised
// Strings, so a composed accent and a decomposed one are the same String. Both
// sides are normalised here for that reason, and `isNot` is why it MUST be —
// comparing the code units as written would admit `isNot` for a pair the Program
// considers equal, which is a proof of something false rather than a missed
// admission.
const STRING_PREDICATES: Record<string, PredicateEvaluator> = {
	is: stringComparison((value, other) => value === other),

	// NOTE: `isEmpty` is `@::length()::is(0)`, and `length` counts grapheme
	// clusters — a String has no clusters exactly when it has no code units, so
	// the JavaScript length answers the emptiness question, and only that one.
	// It is a leaf of its own for that reason: the body reads a chain rather
	// than asking one Method of `@`. `hasCharacters` is this one negated.
	isEmpty: stringQuestion((value) => value.length === 0),
}

const LIST_PREDICATES: Record<string, PredicateEvaluator> = {
	// NOTE: `hasItems` is this one negated, exactly as on a String.
	isEmpty: listQuestion((items) => items.length === 0),
}

// #region Rational literals

// NOTE: A Rational as the pair the entries below compare — the lowest-terms
// form with the sign on the numerator, which is the one form `1/2` and `2/4`
// share. The runtime canonicalises the same way (`createRational` moves a
// negative sign off the denominator, `reduced` divides both parts out), so a
// written Rational is read here as exactly the value it will be.
type ExactValue = { numerator: bigint; denominator: bigint }

// NOTE: The Rational rung of the comparisons, and the PRIMITIVES of it alone:
// `Rational` declares them on its own `compare` and `Orderable` provides
// `isBetween` through its conformance, each keyed as `Rational::…` since a
// conjunct names the Namespace that ANSWERED. `isNot`, `isLessThanOrEqualTo`
// and `isGreaterThanOrEqualTo` are no rows here for the reason no Integer rung
// holds them either — a conjunct arrives resolved, so each of the three is one
// of these three with the flag turned over.
//
// Each takes a Rational OR an Integer bound, because that is what the entries
// take: `Rational::isLessThan` has an Overload for each, and both are the same
// question about the same two exact numbers. An Integer bound is read as `n/1`,
// which is what widening one to a Rational does.
const RATIONAL_COMPARISONS: Record<string, PredicateEvaluator> = {
	is: rationalComparison((value, other) => compareExact(value, other) === 0),
	isLessThan: rationalComparison(
		(value, other) => compareExact(value, other) < 0,
	),
	isGreaterThan: rationalComparison(
		(value, other) => compareExact(value, other) > 0,
	),

	// NOTE: Both bounds included, and bounds in the wrong order enclosing
	// nothing — the Integer entry's rule, and for the same reason: this is what
	// `Orderable::isBetween` says, whichever kind it was provided for.
	isBetween: (value, args) => {
		let rational = rationalLiteral(value)

		if (rational === null || args.length !== 2) {
			return null
		}

		let lower = rationalScalar(args[0])
		let upper = rationalScalar(args[1])

		return lower === null || upper === null
			? null
			: compareExact(rational, lower) >= 0 &&
					compareExact(rational, upper) <= 0
	},
}

// NOTE: Rational's alone, and the whole of it — `isWholeNumber` is the one
// question the Namespace asks of a Rational and nothing else.
const RATIONAL_QUESTIONS: Record<string, PredicateEvaluator> = {
	// NOTE: `@::denominator()::is(1)`, which is Rational's own body, and the
	// denominator it reads is the lowest-terms one — so `4/2` is whole.
	isWholeNumber: rationalQuestion((value) => value.denominator === 1n),
}

// NOTE: The covering Namespace answers for whichever kind stands in front of
// it, so its rung is BOTH tables: an Integer receiver keeps the Integer entry
// it always reached, and a Rational one is read as a Rational. A conjunct
// reaches `Number` where the two operands are of different kinds — an Integer
// bound on a Rational finds no same-kind entry and falls to `Number`'s — and
// where the Method is provided rather than declared, as `isBetween` is over
// Integer bounds.
//
// A Rational RECEIVER is spelled as Rational's own before the key is taken, so
// `1/2::isNot(0)` reaches `Rational::is` negated over `0/1` rather than
// `Number`'s. What is left for this table is an INTEGER receiver whose bound is
// a fraction, which no entry of Integer's own reads.
const NUMBER_COMPARISONS: Record<string, PredicateEvaluator> = eitherTable(
	NUMERIC_COMPARISONS,
	RATIONAL_COMPARISONS,
)

// NOTE: The first entry that can decide the value, which is at most one of
// them: each refuses a value of the kind it does not read, so the two tables
// never both answer and the order between them decides nothing.
function eitherTable(
	first: Record<string, PredicateEvaluator>,
	second: Record<string, PredicateEvaluator>,
): Record<string, PredicateEvaluator> {
	let composed: Record<string, PredicateEvaluator> = { ...first }

	for (let [methodName, evaluator] of Object.entries(second)) {
		let existing = composed[methodName]

		composed[methodName] =
			existing === undefined
				? evaluator
				: (value, args) =>
						existing(value, args) ?? evaluator(value, args)
	}

	return composed
}

function rationalComparison(
	compare: (value: ExactValue, other: ExactValue) => boolean,
): PredicateEvaluator {
	return (value, args) => {
		let rational = rationalLiteral(value)
		let other = args.length === 1 ? rationalScalar(args[0]) : null

		return rational === null || other === null
			? null
			: compare(rational, other)
	}
}

function rationalQuestion(
	ask: (value: ExactValue) => boolean,
): PredicateEvaluator {
	return (value, args) => {
		let rational = rationalLiteral(value)

		return rational === null || args.length !== 0 ? null : ask(rational)
	}
}

// NOTE: A denominator in lowest terms is positive, so the cross-multiplication
// keeps the order and no division is taken anywhere.
function compareExact(value: ExactValue, other: ExactValue): number {
	let left = value.numerator * other.denominator
	let right = other.numerator * value.denominator

	return left < right ? -1 : left > right ? 1 : 0
}

function rationalLiteral(value: LiteralItem): ExactValue | null {
	return value.kind === "Rational" ? value : null
}

// NOTE: A conjunct keeps a written Rational as its two runs of DIGITS with a
// slash between them — the form `literalPredicateArgument` writes and
// `spellScalar` prints back. A bare run of digits is read as well, and is an
// Integer bound standing where a Rational is compared: `Rational::isLessThan`
// declares an Overload for each, and `1/2::isLessThan(1)` is the same question
// as `1/2::isLessThan(1/1)`.
//
// This is the one scalar reader that decodes a fraction. `integerScalar` still
// refuses one, which is what keeps a Rational bound out of a comparison between
// integers.
function rationalScalar(scalar: string | boolean): ExactValue | null {
	if (typeof scalar !== "string") {
		return null
	}

	let parts = /^(-?\d+)(?:\/(-?\d+))?$/.exec(scalar)

	if (parts === null) {
		return null
	}

	let numerator = BigInt(parts[1]!)
	let denominator = parts[2] === undefined ? 1n : BigInt(parts[2])

	return denominator === 0n ? null : reducedExact(numerator, denominator)
}

// NOTE: The lowest-terms form with the sign on the numerator, and zero as
// `0/1` — the canonical form `createRational` and `reduced` give a Rational at
// run time, taken here so that two written spellings of one number are one
// value.
function reducedExact(numerator: bigint, denominator: bigint): ExactValue {
	if (denominator < 0n) {
		numerator = -numerator
		denominator = -denominator
	}

	let divisor = greatestCommonDivisor(
		numerator < 0n ? -numerator : numerator,
		denominator,
	)

	return {
		numerator: numerator / divisor,
		denominator: denominator / divisor,
	}
}

// NOTE: Euclid's, over a magnitude that may be zero and a denominator that is
// not — `gcd(0, d)` is `d`, which is what canonicalises every zero as `0/1`.
function greatestCommonDivisor(magnitude: bigint, denominator: bigint): bigint {
	while (denominator !== 0n) {
		;[magnitude, denominator] = [denominator, magnitude % denominator]
	}

	return magnitude
}

// NOTE: The spelling a conjunct KEEPS for a written Rational, which is the
// lowest-terms one. Two refinements are compared by their conjunct sets, and
// `@::isNot(0/1)` and `@::isNot(0/2)` are one question about one number — so
// the number is what the key holds, rather than the characters that were typed.
// A pair this can not read is handed back as it was written: a zero denominator
// is refused by the Validator, and the Diagnostics in between should say what
// stands in the source.
export function reducedRationalSpelling(
	numerator: string,
	denominator: string,
): string {
	let reduced = rationalScalar(`${numerator}/${denominator}`)

	return reduced === null
		? `${numerator}/${denominator}`
		: `${reduced.numerator}/${reduced.denominator}`
}

// #endregion

// NOTE: One flat table, keyed the way a conjunct is: the Namespace, a COLON, the
// Method. The Lexer reads `:` as a Symbol so no name a Program can write holds
// one — which is also what keeps every key here away from the property names an
// Object carries of its own accord.
const PREDICATES: Record<string, PredicateEvaluator> = {
	...keyedByNamespace("Integer", NUMERIC_COMPARISONS),
	...keyedByNamespace("Number", NUMBER_COMPARISONS),
	...keyedByNamespace("Integer", INTEGER_QUESTIONS),
	...keyedByNamespace("Rational", RATIONAL_COMPARISONS),
	...keyedByNamespace("Rational", RATIONAL_QUESTIONS),
	...keyedByNamespace("String", STRING_PREDICATES),
	...keyedByNamespace("List", LIST_PREDICATES),
}

function keyedByNamespace(
	namespaceName: string,
	predicates: Record<string, PredicateEvaluator>,
): Record<string, PredicateEvaluator> {
	return Object.fromEntries(
		Object.entries(predicates).map(([methodName, evaluator]) => [
			`${namespaceName}::${methodName}`,
			evaluator,
		]),
	)
}

// NOTE: The flag is applied to the ANSWER and not to the table, so a question
// the table declines to decide stays undecided either way round: `null` is "not
// a shape this entry can read", and the contrary of something unreadable is not
// `true`.
function evaluateConjunct(
	conjunct: common.PredicateConjunct,
	value: LiteralValue,
): boolean | null {
	let evaluator =
		PREDICATES[`${conjunct.namespaceName}::${conjunct.methodName}`]

	if (evaluator === undefined) {
		return null
	}

	let answer = evaluator(value, conjunct.args)

	return answer === null ? null : answer !== conjunct.negated
}

function integerComparison(
	compare: (value: bigint, other: bigint) => boolean,
): PredicateEvaluator {
	return (value, args) => {
		let integer = integerLiteral(value)
		let other = args.length === 1 ? integerScalar(args[0]) : null

		return integer === null || other === null
			? null
			: compare(integer, other)
	}
}

function integerQuestion(ask: (value: bigint) => boolean): PredicateEvaluator {
	return (value, args) => {
		let integer = integerLiteral(value)

		return integer === null || args.length !== 0 ? null : ask(integer)
	}
}

function stringComparison(
	compare: (value: string, other: string) => boolean,
): PredicateEvaluator {
	return (value, args) => {
		let text = stringLiteral(value)
		let other = args.length === 1 ? stringScalar(args[0]!) : null

		return text === null || other === null
			? null
			: compare(text.normalize("NFC"), other.normalize("NFC"))
	}
}

function stringQuestion(ask: (value: string) => boolean): PredicateEvaluator {
	return (value, args) => {
		let text = stringLiteral(value)

		return text === null || args.length !== 0 ? null : ask(text)
	}
}

function listQuestion(
	ask: (items: Array<LiteralItem>) => boolean,
): PredicateEvaluator {
	return (value, args) =>
		value.kind !== "List" || args.length !== 0 ? null : ask(value.items)
}

// NOTE: These two take an ITEM rather than a value, which is the wider of the
// two and costs a caller holding a value nothing. It is what makes an opaque
// item refuse by the same route a Boolean does where an Integer was wanted: the
// kind is not the one asked for, so the answer is `null` and the entry above it
// declines to decide.
function integerLiteral(value: LiteralItem): bigint | null {
	return value.kind === "Integer" ? value.value : null
}

function stringLiteral(value: LiteralItem): string | null {
	return value.kind === "String" ? value.value : null
}

// NOTE: A conjunct keeps a written Integer as its DIGITS, because a value is a
// bigint at run time and JSON has no bigint — so an Argument spelled any other
// way, a Rational's `1/2`, a quoted String or a Boolean, is refused right here.
// That is what keeps a Rational bound out of a comparison between integers.
// `rationalScalar` is the one reader that decodes the fraction, and it is asked
// only where a Rational stands.
function integerScalar(scalar: string | boolean): bigint | null {
	return typeof scalar === "string" && /^-?\d+$/.test(scalar)
		? BigInt(scalar)
		: null
}

// NOTE: And a written String as the JSON of its characters, quotes and all,
// which is the half of the scalar that says it was a String and not the digits
// it may happen to spell. Read back through `JSON.parse`, which is what wrote
// it; anything else is an Argument of another kind and no question this entry
// can decide.
function stringScalar(scalar: string | boolean): string | null {
	if (typeof scalar !== "string" || !scalar.startsWith('"')) {
		return null
	}

	let parsed: unknown = JSON.parse(scalar)

	return typeof parsed === "string" ? parsed : null
}

function literalValueOf(
	value: common.typed.ExpressionNode,
): LiteralValue | null {
	switch (value.nodeType) {
		case "IntegerValue": {
			let integer = integerScalar(value.value)

			return integer === null ? null : { kind: "Integer", value: integer }
		}
		// NOTE: Read as the number rather than as the two runs of digits that
		// were typed, so `2/4` is the value `1/2` is. A zero denominator is
		// refused here and reported by the Validator, which runs after this: it
		// is no Rational, so it is no value to decide anything about.
		case "RationalValue": {
			let rational = rationalScalar(
				`${value.numerator}/${value.denominator}`,
			)

			return rational === null ? null : { kind: "Rational", ...rational }
		}
		case "StringValue":
			return { kind: "String", value: value.value }
		case "BooleanValue":
			return { kind: "Boolean", value: value.value }
		// NOTE: Never `null`, whatever stands inside it. What the brackets say
		// is how many items there are, and they say it whether or not the
		// Compiler can read one.
		case "ListValue":
			return {
				kind: "List",
				items: value.values.map(
					(item) => literalValueOf(item) ?? OPAQUE_ITEM,
				),
			}
		default:
			return null
	}
}
