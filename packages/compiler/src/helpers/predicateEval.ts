import type { common } from "@essence-lang/interfaces"

import { matchesType } from "./index"

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

	return refinement.conjuncts.every(
		(conjunct) => evaluateConjunct(conjunct, literal) === true,
	)
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
export function describePredicate(refinement: common.RefinementType): string {
	let [first, ...rest] = refinement.conjuncts.map(spellConjunct)

	return rest.reduce((chain, conjunct) => `${chain}::and(${conjunct})`, first)
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
// A List counts as written when its items are written too. The two List
// predicates read nothing but the count, which a List of Expressions has as
// well, but a literal is the shape this whole module is about: admitting one
// shape by the count alone would be the first crack in a rule that is otherwise
// exactly "the value is written here".
type LiteralValue =
	| { kind: "Integer"; value: bigint }
	| { kind: "String"; value: string }
	| { kind: "Boolean"; value: boolean }
	| { kind: "List"; items: Array<LiteralValue> }

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
	ask: (items: Array<LiteralValue>) => boolean,
): PredicateEvaluator {
	return (value, args) =>
		value.kind !== "List" || args.length !== 0 ? null : ask(value.items)
}

function integerLiteral(value: LiteralValue): bigint | null {
	return value.kind === "Integer" ? value.value : null
}

function stringLiteral(value: LiteralValue): string | null {
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
		case "ListValue": {
			let items: Array<LiteralValue> = []

			for (let item of value.values) {
				let literal = literalValueOf(item)

				if (literal === null) {
					return null
				}

				items.push(literal)
			}

			return { kind: "List", items }
		}
		default:
			return null
	}
}
