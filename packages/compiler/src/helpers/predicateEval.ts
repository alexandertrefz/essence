import type { common } from "@essence-lang/interfaces"

import {
	applyGenericBindings,
	buildUnion,
	type GenericBindings,
	genericNamesMentioned,
	matchesType,
	matchesTypeWithBindings,
	provenConjuncts,
} from "./types"

// Whether a written value is admitted into a refinement by deciding its
// predicate while compiling, through a table of the standard library's
// primitives. See "Deciding a written value" in DEVELOPMENT.md.
function admittedByEvaluation(
	refinement: common.RefinementType,
	value: common.typed.ExpressionNode,
): boolean {
	return admissionOfWrittenValue(value)?.(refinement) ?? false
}

// The Type a written value is admitted at, given the Type its position asks
// for, or null where nothing was decided. Lists and Dictionaries are asked part
// by part. See "Containers" in DEVELOPMENT.md.
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
		expected.type === "Dictionary" &&
		value.nodeType === "DictionaryValue"
	) {
		return admittedDictionaryTypeOf(expected, value)
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

	// An empty written List decides nothing, and its `Unknown` item fits anyway.
	return itemTypes.length === 0
		? null
		: { type: "List", itemType: buildUnion(itemTypes) }
}

// A written Dictionary, asked as a written List is, key and value per entry.
function admittedDictionaryTypeOf(
	expected: common.DictionaryType,
	value: common.typed.DictionaryValueNode,
): common.Type | null {
	if (
		value.entries.length === 0 ||
		!(
			refinementInside(expected.keyType) ||
			refinementInside(expected.valueType)
		)
	) {
		return null
	}

	let keyTypes: Array<common.Type> = []
	let valueTypes: Array<common.Type> = []

	for (let entry of value.entries) {
		let key = admittedTypeOf(expected.keyType, entry.key)
		let held = admittedTypeOf(expected.valueType, entry.value)

		if (
			(key === null && !matchesType(expected.keyType, entry.key.type)) ||
			(held === null &&
				!matchesType(expected.valueType, entry.value.type))
		) {
			return null
		}

		keyTypes.push(key ?? entry.key.type)
		valueTypes.push(held ?? entry.value.type)
	}

	return {
		type: "Dictionary",
		keyType: buildUnion(keyTypes),
		valueType: buildUnion(valueTypes),
	}
}

// Whether a written value fits where it stands: assignable, or admitted. A
// position measuring a value against a Type it did not resolve asks this.
export function fitsWritten(
	expected: common.Type,
	value: common.typed.ExpressionNode,
): boolean {
	return (
		matchesType(expected, value.type) ||
		admittedTypeOf(expected, value) !== null
	)
}

// Whether a position asks a written value for evidence at all, checked before
// anything is read. Only List items and Dictionary slots are looked down.
export function refinementInside(type: common.Type): boolean {
	return (
		type.type === "Refinement" ||
		(type.type === "List" && refinementInside(type.itemType)) ||
		(type.type === "Dictionary" &&
			(refinementInside(type.keyType) ||
				refinementInside(type.valueType)))
	)
}

// A written part that did not fit, the question it left unanswered, and what
// it is in its container, so a Diagnostic calls a key a key.
type UnadmittedWrittenPart = {
	value: common.typed.ExpressionNode
	refinement: common.RefinementType
	part: "item" | "key" | "value"
}

// The first written part that did not answer its position's question, or null
// where the refusal is about the container itself.
export function unadmittedWrittenItem(
	expected: common.Type,
	value: common.typed.ExpressionNode,
): UnadmittedWrittenPart | null {
	let container = expected.type === "Refinement" ? expected.base : expected

	// Entries in written order, each key before its value.
	if (
		container.type === "Dictionary" &&
		value.nodeType === "DictionaryValue"
	) {
		for (let entry of value.entries) {
			if (!fitsWritten(container.keyType, entry.key)) {
				return unadmittedWrittenPart(
					container.keyType,
					entry.key,
					"key",
				)
			}

			if (!fitsWritten(container.valueType, entry.value)) {
				return unadmittedWrittenPart(
					container.valueType,
					entry.value,
					"value",
				)
			}
		}

		return null
	}

	if (
		container.type !== "List" ||
		value.nodeType !== "ListValue" ||
		!refinementInside(container.itemType)
	) {
		return null
	}

	for (let item of value.values) {
		if (fitsWritten(container.itemType, item)) {
			continue
		}

		return unadmittedWrittenPart(container.itemType, item, "item")
	}

	return null
}

// The deepest thing inside a part that did not fit, named by its own word, or
// the part where the slot named a refinement. Null where the slot named none.
function unadmittedWrittenPart(
	expected: common.Type,
	part: common.typed.ExpressionNode,
	name: "item" | "key" | "value",
): UnadmittedWrittenPart | null {
	return (
		unadmittedWrittenItem(expected, part) ??
		(expected.type === "Refinement"
			? { value: part, refinement: expected, part: name }
			: null)
	)
}

// The admission question for many refinements, reading the value once, for a
// Method receiver. Null where the value is no Literal the table can read.
export function admissionOfWrittenValue(
	value: common.typed.ExpressionNode,
): ((refinement: common.RefinementType) => boolean) | null {
	let literal = literalValueOf(value)

	if (literal === null) {
		return null
	}

	// The base is asked too, as a written value: `["a"]::hasItems()` says nothing
	// about a `List<Integer>` base.
	return (refinement) =>
		fitsWritten(refinement.base, value) &&
		provenConjuncts(refinement).every(
			(conjunct) => evaluateConjunct(conjunct, literal) === true,
		)
}

// The refinement a written value is asked about where the position's own Type
// Parameters are not decided yet, or null where the value leaves one open. See
// "Generic refinements" in DEVELOPMENT.md.
export function refinementDecidedBy(
	refinement: common.RefinementType,
	valueType: common.Type,
): common.RefinementType | null {
	let parameters = genericNamesMentioned(refinement.base)

	// A non-generic refinement comes back as itself.
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

// The predicate spelled back out of its conjuncts for a Diagnostic, as each was
// written, joined as a chain. See "The literal table" in DEVELOPMENT.md.
// INVARIANT: a refinement holds at least one conjunct, so the `reduce` needs no
// seed.
export function describePredicate(refinement: common.RefinementType): string {
	return provenConjuncts(refinement)
		.map(spellConjunct)
		.reduce((chain, conjunct) => `${chain}::and(${conjunct})`)
}

function spellConjunct(conjunct: common.PredicateConjunct): string {
	let written = conjunct.spelling ?? conjunct
	let call = `@::${written.methodName}(${written.args
		.map(spellArgument)
		.join(", ")})`

	// A spelling already carries its negation in its name. Only a conjunct nobody
	// wrote prints `::negate()`.
	return conjunct.negated && conjunct.spelling === undefined
		? `${call}::negate()`
		: call
}

// An Argument as written: its scalar, after its label where it has one.
function spellArgument(
	argument: common.PredicateSpellingArgument | string | boolean,
): string {
	return typeof argument === "object"
		? `${argument.label} ${spellScalar(argument.value)}`
		: spellScalar(argument)
}

// A String Argument arrives quoted, so only a Boolean needs making into text.
function spellScalar(scalar: string | boolean): string {
	return typeof scalar === "boolean" ? String(scalar) : scalar
}

// A written value as the scalars the predicate table compares. A List's or a
// Dictionary's unreadable part is `Opaque`, and `whole` tells a Literal from an
// update. See "The literal table" in DEVELOPMENT.md.
type LiteralValue =
	| { kind: "Integer"; value: bigint }
	| { kind: "Rational"; numerator: bigint; denominator: bigint }
	| { kind: "String"; value: string }
	| { kind: "Boolean"; value: boolean }
	| { kind: "List"; items: Array<LiteralItem> }
	| { kind: "Dictionary"; entries: Array<LiteralEntry>; whole: boolean }

type LiteralItem = LiteralValue | { kind: "Opaque" }

// One written entry, each half read as a List item is.
type LiteralEntry = { key: LiteralItem; value: LiteralItem }

const OPAQUE_ITEM: LiteralItem = { kind: "Opaque" }

// Null where the entry can not decide this value or read these Arguments.
type PredicateEvaluator = (
	value: LiteralValue,
	args: Array<string | boolean>,
) => boolean | null

// The comparisons over Integers, keyed by the Namespace whose conformance
// answered, whether Integer wrote the entry or `Orderable` provides it.
const NUMERIC_COMPARISONS: Record<string, PredicateEvaluator> = {
	is: integerComparison((value, other) => value === other),
	isLessThan: integerComparison((value, other) => value < other),
	isGreaterThan: integerComparison((value, other) => value > other),

	// Both bounds included, in either order, as the standard library's body reads.
	isBetween: (value, args) => {
		let integer = integerLiteral(value)

		if (integer === null || args.length !== 2) {
			return null
		}

		let first = integerScalar(args[0])
		let second = integerScalar(args[1])

		if (first === null || second === null) {
			return null
		}

		let lower = first <= second ? first : second
		let upper = first <= second ? second : first

		return integer >= lower && integer <= upper
	},
}

// Integer's own questions. `isZero` and its kin arrive as comparisons.
const INTEGER_QUESTIONS: Record<string, PredicateEvaluator> = {
	// `-3 % 2` is `-1` in JavaScript, so evenness asks for a zero remainder, as
	// Integer writes it. Oddness is this leaf negated.
	isEven: integerQuestion((value) => value % 2n === 0n),
}

// String equality compares NFC forms, as the runtime's `is` does. An `isNot`
// over raw code units would prove something false.
const STRING_PREDICATES: Record<string, PredicateEvaluator> = {
	is: stringComparison((value, other) => value === other),

	// No grapheme clusters means no code units, so the JavaScript length decides
	// emptiness. `hasCharacters` is this leaf negated.
	isEmpty: stringQuestion((value) => value.length === 0),

	// One grapheme cluster must be counted, as the runtime's `clustersIn` does.
	isOneCharacter: stringQuestion((value) => isOneGrapheme(value)),
}

// Whether the text is one grapheme cluster. The Segmenter is built on first use,
// since building one is slow.
let graphemeSegmenter: Intl.Segmenter | null = null

function isOneGrapheme(value: string): boolean {
	if (value.length === 0) {
		return false
	}

	if (graphemeSegmenter === null) {
		graphemeSegmenter = new Intl.Segmenter(undefined, {
			granularity: "grapheme",
		})
	}

	let segments = 0

	for (let _ of graphemeSegmenter.segment(value.normalize("NFC"))) {
		segments++

		if (segments > 1) {
			return false
		}
	}

	return segments === 1
}

const LIST_PREDICATES: Record<string, PredicateEvaluator> = {
	// `hasItems` is this leaf negated.
	isEmpty: listQuestion((items) => items.length === 0),
}

// `hasEntries` is this leaf negated. An update writing no entry leaves it
// undecided, since its entries are only a lower bound.
const DICTIONARY_PREDICATES: Record<string, PredicateEvaluator> = {
	isEmpty: (value, args) => {
		if (value.kind !== "Dictionary" || args.length !== 0) {
			return null
		}

		if (value.entries.length > 0) {
			return false
		}

		return value.whole ? true : null
	},
}

// #region Rational literals

// A Rational in lowest terms with the sign on the numerator, as the runtime
// canonicalises one, so `1/2` and `2/4` read alike.
type ExactValue = { numerator: bigint; denominator: bigint }

// The comparisons over Rationals, keyed `Rational::…`. Each takes a Rational or
// an Integer bound, read as `n/1`.
const RATIONAL_COMPARISONS: Record<string, PredicateEvaluator> = {
	is: rationalComparison((value, other) => compareExact(value, other) === 0),
	isLessThan: rationalComparison(
		(value, other) => compareExact(value, other) < 0,
	),
	isGreaterThan: rationalComparison(
		(value, other) => compareExact(value, other) > 0,
	),

	// Both bounds included, in either order, as in the Integer entry.
	isBetween: (value, args) => {
		let rational = rationalLiteral(value)

		if (rational === null || args.length !== 2) {
			return null
		}

		let first = rationalScalar(args[0])
		let second = rationalScalar(args[1])

		if (first === null || second === null) {
			return null
		}

		let exchanged = compareExact(first, second) > 0
		let lower = exchanged ? second : first
		let upper = exchanged ? first : second

		return (
			compareExact(rational, lower) >= 0 &&
			compareExact(rational, upper) <= 0
		)
	},
}

// Rational's alone, and the whole of it — `isWholeNumber` is the one
// question the Namespace asks of a Rational and nothing else.
const RATIONAL_QUESTIONS: Record<string, PredicateEvaluator> = {
	// `@::denominator()::is(1)`, which is Rational's own body, and the
	// denominator it reads is the lowest-terms one — so `4/2` is whole.
	isWholeNumber: rationalQuestion((value) => value.denominator === 1n),
}

// The covering Namespace answers for whichever kind stands in front of
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

// The first entry that can decide the value, which is at most one of
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

// A denominator in lowest terms is positive, so the cross-multiplication
// keeps the order and no division is taken anywhere.
function compareExact(value: ExactValue, other: ExactValue): number {
	let left = value.numerator * other.denominator
	let right = other.numerator * value.denominator

	return left < right ? -1 : left > right ? 1 : 0
}

function rationalLiteral(value: LiteralItem): ExactValue | null {
	return value.kind === "Rational" ? value : null
}

// A conjunct keeps a written Rational as its two runs of DIGITS with a
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

// The lowest-terms form with the sign on the numerator, and zero as
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

// Euclid's, over a magnitude that may be zero and a denominator that is
// not — `gcd(0, d)` is `d`, which is what canonicalises every zero as `0/1`.
function greatestCommonDivisor(magnitude: bigint, denominator: bigint): bigint {
	while (denominator !== 0n) {
		;[magnitude, denominator] = [denominator, magnitude % denominator]
	}

	return magnitude
}

// The spelling a conjunct KEEPS for a written Rational, which is the
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

// One flat table, keyed the way a conjunct is: the Namespace, a COLON, the
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
	...keyedByNamespace("Dictionary", DICTIONARY_PREDICATES),
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

// The flag is applied to the ANSWER and not to the table, so a question
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

// These two take an ITEM rather than a value, which is the wider of the
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

// A conjunct keeps a written Integer as its DIGITS, because a value is a
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

// And a written String as the JSON of its characters, quotes and all,
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

// One bracket list's entries, both halves read as items. The literal and
// the update share it because they share the list — an update's key list is a
// literal's, on the same terms and with the same opaque halves.
function entriesOf(
	value: common.typed.DictionaryValueNode,
): Array<LiteralEntry> {
	return value.entries.map((entry) => ({
		key: literalValueOf(entry.key) ?? OPAQUE_ITEM,
		value: literalValueOf(entry.value) ?? OPAQUE_ITEM,
	}))
}

function literalValueOf(
	value: common.typed.ExpressionNode,
): LiteralValue | null {
	switch (value.nodeType) {
		case "IntegerValue": {
			let integer = integerScalar(value.value)

			return integer === null ? null : { kind: "Integer", value: integer }
		}
		// Read as the number rather than as the two runs of digits that
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
		// Never `null`, whatever stands inside it. What the brackets say
		// is how many items there are, and they say it whether or not the
		// Compiler can read one.
		case "ListValue":
			return {
				kind: "List",
				items: value.values.map(
					(item) => literalValueOf(item) ?? OPAQUE_ITEM,
				),
			}
		// Never `null` either, and for the same reason: `[=]` and
		// `["a" = 1]` say how many entries they hold in the brackets, whatever
		// the Compiler can make of the keys and values inside them.
		case "DictionaryValue":
			return {
				kind: "Dictionary",
				entries: entriesOf(value),
				whole: true,
			}
		// `[ages with "kim" = 7]` — the one written shape whose brackets
		// say something about a value they do not hold the whole of. The
		// entries it sets are there in the source, one pair each, exactly as a
		// literal's are, and the base stands behind them unread. So it is read
		// as those entries and marked not whole, which is what lets a
		// Dictionary an update wrote into be proven to hold something and
		// leaves every question about the base unanswered.
		//
		// Only the form that SETS entries. `[ages with others]` merges a whole
		// Dictionary in, and how many entries that one holds is a question
		// about a value rather than about the brackets.
		case "Combination":
			return value.type.type === "Dictionary" &&
				value.rhs.nodeType === "DictionaryValue"
				? {
						kind: "Dictionary",
						entries: entriesOf(value.rhs),
						whole: false,
					}
				: null
		default:
			return null
	}
}
