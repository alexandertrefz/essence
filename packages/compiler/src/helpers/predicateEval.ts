import type { common } from "@essence-lang/interfaces"

import {
	applyGenericBindings,
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
// The Overload is NOT part of the key. An Overload is told apart by the
// Arguments it takes, and an entry that can not decode the Arguments it was
// given refuses — which is how `@::isLessThan(1/2)`, Integer's Rational
// Overload, falls out here rather than being compared as though the bound were
// an Integer.
export function admittedByEvaluation(
	refinement: common.RefinementType,
	value: common.typed.ExpressionNode,
): boolean {
	let literal = literalValueOf(value)

	// NOTE: The base is asked as well as the predicate. `["a"]::hasItems()` is
	// true of a List of Strings and says nothing whatever about the
	// `List<Integer>` a refinement of that base demands — the conjuncts alone
	// would admit it.
	if (literal === null || !matchesType(refinement.base, value.type)) {
		return false
	}

	return provenConjuncts(refinement).every(
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
	return `@::${conjunct.methodName}(${conjunct.args
		.map(spellScalar)
		.join(", ")})`
}

// NOTE: A String Argument is printed quoted and everything else bare. The
// scalars a conjunct keeps are the written value's own characters, and a
// String's are the only ones a reader could mistake for a number's digits.
function spellScalar(scalar: string | boolean): string {
	return typeof scalar === "boolean" || /^-?\d+(\/-?\d+)?$/.test(scalar)
		? String(scalar)
		: JSON.stringify(scalar)
}

// NOTE: A written value as the JavaScript the table below compares — a bigint
// for an Integer, because that is what an Integer is at run time and what its
// digits mean.
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

// NOTE: The comparisons are declared once over the whole numeric tower and AGAIN
// on Integer, where the same-kind entry is written on the same-kind native — a
// performance stratification the standard library explains at length — so an
// Integer receiver's `isLessThan` is answered by Integer while its `isBetween`,
// which Integer does not declare, is answered by Number. Both spellings are the
// same question about the same two integers, so both are keyed to these.
const NUMERIC_COMPARISONS: Record<string, PredicateEvaluator> = {
	is: integerComparison((value, other) => value === other),
	isNot: integerComparison((value, other) => value !== other),
	isLessThan: integerComparison((value, other) => value < other),
	isLessThanOrEqualTo: integerComparison((value, other) => value <= other),
	isGreaterThan: integerComparison((value, other) => value > other),
	isGreaterThanOrEqualTo: integerComparison((value, other) => value >= other),

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

// NOTE: Integer's alone — `Number` declares none of the five over the tower.
const INTEGER_QUESTIONS: Record<string, PredicateEvaluator> = {
	isZero: integerQuestion((value) => value === 0n),
	isPositive: integerQuestion((value) => value > 0n),
	isNegative: integerQuestion((value) => value < 0n),

	// NOTE: A negative remainder is still a remainder — `-3 % 2` is `-1` in
	// JavaScript — so evenness is asked as "the remainder is zero" and oddness as
	// its negation, which is also how Integer writes the two.
	isEven: integerQuestion((value) => value % 2n === 0n),
	isOdd: integerQuestion((value) => value % 2n !== 0n),
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
	isNot: stringComparison((value, other) => value !== other),

	// NOTE: `isEmpty` is `@::length()::is(0)`, and `length` counts grapheme
	// clusters — a String has no clusters exactly when it has no code units, so
	// the JavaScript length answers the emptiness question, and only that one.
	isEmpty: stringQuestion((value) => value.length === 0),
	hasAnyContent: stringQuestion((value) => value.length > 0),
}

const LIST_PREDICATES: Record<string, PredicateEvaluator> = {
	isEmpty: listQuestion((items) => items.length === 0),
	hasItems: listQuestion((items) => items.length > 0),
}

// NOTE: One flat table, keyed the way a conjunct is: the Namespace, a COLON, the
// Method. The Lexer reads `:` as a Symbol so no name a Program can write holds
// one — which is also what keeps every key here away from the property names an
// Object carries of its own accord.
const PREDICATES: Record<string, PredicateEvaluator> = {
	...keyedByNamespace("Integer", NUMERIC_COMPARISONS),
	...keyedByNamespace("Number", NUMERIC_COMPARISONS),
	...keyedByNamespace("Integer", INTEGER_QUESTIONS),
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

function evaluateConjunct(
	conjunct: common.PredicateConjunct,
	value: LiteralValue,
): boolean | null {
	let evaluator =
		PREDICATES[`${conjunct.namespaceName}::${conjunct.methodName}`]

	return evaluator === undefined ? null : evaluator(value, conjunct.args)
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
		let other =
			args.length === 1 && typeof args[0] === "string" ? args[0] : null

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
// way, a Rational's `1/2` or a Boolean, is refused right here. That is what keeps
// a Rational bound out of a comparison between integers.
function integerScalar(scalar: string | boolean): bigint | null {
	return typeof scalar === "string" && /^-?\d+$/.test(scalar)
		? BigInt(scalar)
		: null
}

function literalValueOf(
	value: common.typed.ExpressionNode,
): LiteralValue | null {
	switch (value.nodeType) {
		case "IntegerValue": {
			let integer = integerScalar(value.value)

			return integer === null ? null : { kind: "Integer", value: integer }
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
