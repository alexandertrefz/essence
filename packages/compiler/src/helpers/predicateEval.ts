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
	// Whether the position binds the Type Parameters it names, as an
	// Argument's does. See "Generic refinements" in DEVELOPMENT.md.
	binds: boolean = true,
): common.Type | null {
	if (expected.type === "Refinement") {
		let asked = binds ? refinementDecidedBy(expected, value.type) : expected

		return asked !== null && admittedByEvaluation(asked, value)
			? asked
			: null
	}

	if (
		expected.type === "Dictionary" &&
		value.nodeType === "DictionaryValue"
	) {
		return admittedDictionaryTypeOf(expected, value, binds)
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
		let decided = admittedTypeOf(expected.itemType, item, binds)

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
	binds: boolean,
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
		let key = admittedTypeOf(expected.keyType, entry.key, binds)
		let held = admittedTypeOf(expected.valueType, entry.value, binds)

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
// position measuring a value against a Type it did not resolve asks this, and
// binds no Type Parameter unless told to.
export function fitsWritten(
	expected: common.Type,
	value: common.typed.ExpressionNode,
	binds: boolean = false,
): boolean {
	return (
		matchesType(expected, value.type) ||
		admittedTypeOf(expected, value, binds) !== null
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

// A written part that did not fit and the question it left unanswered. `part`
// lets a Diagnostic call a key a key.
type UnadmittedWrittenPart = {
	value: common.typed.ExpressionNode
	refinement: common.RefinementType
	part: "item" | "key" | "value"
}

// The first written part that did not answer its position's question, or null
// where the refusal is about the container itself. Each part is asked as an
// Argument's would be, so a part an inferred `Item` could take is passed over.
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
			if (!fitsWritten(container.keyType, entry.key, true)) {
				return unadmittedWrittenPart(
					container.keyType,
					entry.key,
					"key",
				)
			}

			if (!fitsWritten(container.valueType, entry.value, true)) {
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
		if (fitsWritten(container.itemType, item, true)) {
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

// Whether a value's Type is one the refinement's base takes, binding the base's
// Type Parameters as the value decides them. A value outside the base is
// refused before its predicate is asked.
export function fitsRefinementBase(
	refinement: common.RefinementType,
	value: common.typed.ExpressionNode,
): boolean {
	let parameters = genericNamesMentioned(refinement.base)

	return parameters.size === 0
		? fitsWritten(refinement.base, value)
		: matchesTypeWithBindings(refinement.base, value.type, {
				bindableNames: parameters,
				bindings: new Map(),
			})
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

// The refinement a written value is asked about while the position's Type
// Parameters are undecided, or null where the value leaves one open. See
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

// The comparisons over Integers and Rationals, keyed by the Namespace whose
// conformance answered, whether a member wrote the entry or `Orderable`
// provides it. The standard library compares the two kinds by value, so each
// entry reads either kind of value and bound exactly.
const NUMERIC_COMPARISONS: Record<string, PredicateEvaluator> = {
	is: numericComparison((value, other) => compareExact(value, other) === 0),
	isLessThan: numericComparison(
		(value, other) => compareExact(value, other) < 0,
	),
	isGreaterThan: numericComparison(
		(value, other) => compareExact(value, other) > 0,
	),

	// Both bounds included, in either order, as the standard library's body reads.
	isBetween: (value, args) => {
		let number = exactLiteral(value)

		if (number === null || args.length !== 2) {
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
			compareExact(number, lower) >= 0 && compareExact(number, upper) <= 0
		)
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

// Rational's own question.
const RATIONAL_QUESTIONS: Record<string, PredicateEvaluator> = {
	// Rational's body reads the lowest-terms denominator, so `4/2` is whole.
	isWholeNumber: rationalQuestion((value) => value.denominator === 1n),
}

function numericComparison(
	compare: (value: ExactValue, other: ExactValue) => boolean,
): PredicateEvaluator {
	return (value, args) => {
		let number = exactLiteral(value)
		let other = args.length === 1 ? rationalScalar(args[0]) : null

		return number === null || other === null ? null : compare(number, other)
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

// An Integer read as `n/1`, so one comparison reads both kinds.
function exactLiteral(value: LiteralItem): ExactValue | null {
	return value.kind === "Integer"
		? { numerator: value.value, denominator: 1n }
		: rationalLiteral(value)
}

// Reads a numeric bound, written as digits with a slash, or as bare digits for
// an Integer bound read as `n/1`.
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

// The lowest-terms form with the sign on the numerator, as the runtime keeps a
// Rational, so two spellings of one number are one value.
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

// `gcd(0, d)` is `d`, so every zero reduces to `0/1`.
function greatestCommonDivisor(magnitude: bigint, denominator: bigint): bigint {
	while (denominator !== 0n) {
		;[magnitude, denominator] = [denominator, magnitude % denominator]
	}

	return magnitude
}

// The spelling a conjunct keeps for a written Rational: its lowest terms, so
// `@::isNot(0/1)` and `@::isNot(0/2)` are one question. An unreadable pair is
// kept as written, for the Validator to refuse.
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

// Keyed as `Namespace::method`. No written name holds a `:`, so no key meets a
// property an Object carries of its own.
const PREDICATES: Record<string, PredicateEvaluator> = {
	...keyedByNamespace("Integer", NUMERIC_COMPARISONS),
	...keyedByNamespace("Number", NUMERIC_COMPARISONS),
	...keyedByNamespace("Integer", INTEGER_QUESTIONS),
	...keyedByNamespace("Rational", NUMERIC_COMPARISONS),
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

// The negation flag applies to the answer, so a question the table declines
// stays undecided either way round.
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

// These take an item, so an opaque item is refused as any wrong kind is.
function integerLiteral(value: LiteralItem): bigint | null {
	return value.kind === "Integer" ? value.value : null
}

function stringLiteral(value: LiteralItem): string | null {
	return value.kind === "String" ? value.value : null
}

// An Integer Literal keeps its digits as a String. Any other spelling is no
// Integer.
function integerScalar(scalar: string | boolean): bigint | null {
	return typeof scalar === "string" && /^-?\d+$/.test(scalar)
		? BigInt(scalar)
		: null
}

// A conjunct keeps a String bound as JSON, quotes included, which tells it
// from digits. Anything else is another kind of Argument.
function stringScalar(scalar: string | boolean): string | null {
	if (typeof scalar !== "string" || !scalar.startsWith('"')) {
		return null
	}

	let parsed: unknown = JSON.parse(scalar)

	return typeof parsed === "string" ? parsed : null
}

// One bracket list's entries, each half read as an item, for a Literal and for
// an update alike.
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
		// Read as the number, so `2/4` is `1/2`. A zero denominator is no Rational, and
		// the Validator reports it.
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
		// Never null: the brackets say how many items there are.
		case "ListValue":
			return {
				kind: "List",
				items: value.values.map(
					(item) => literalValueOf(item) ?? OPAQUE_ITEM,
				),
			}
		// Never null, for the same reason.
		case "DictionaryValue":
			return {
				kind: "Dictionary",
				entries: entriesOf(value),
				whole: true,
			}
		// `[ages with "kim" = 7]` sets entries over a base nothing reads, so it is read
		// as those entries and marked not `whole`. `[ages with others]` merges a whole
		// Dictionary in, which says nothing countable.
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
