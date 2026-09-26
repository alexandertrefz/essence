import type { common } from "@essence-lang/interfaces"

import type { AlgebraicType } from "./Algebraic"
import type { BooleanType } from "./Boolean"
import { is as boolIs, createBoolean } from "./Boolean"
import type { IntegerType } from "./Integer"
import type { ListType } from "./List"
import { createList, itemOfView, viewOf, walkOf } from "./List"
import { formatAsFraction, type RationalType } from "./Rational"
import type { RecordType } from "./Record"
import { is as recordIs } from "./Record"
import { kindOf } from "./registry"
import type { StringType } from "./String"
import { createString, normalisedFormOf } from "./String"
import { getStringRepresentation } from "./Terminal"
import type { TranscendentalType } from "./Transcendental"
import type { AnyType } from "./type"
import { createCase, isValueOfType, typeKeySymbol } from "./type"

export function getInt32(number: IntegerType): number {
	let value = number.value

	// NOTE: `| 0` IS `BigInt.asIntN(32, …)` for an integer a double holds
	// exactly — both keep the low 32 bits and read them signed — without
	// building a bigint to throw away.
	return typeof value === "number"
		? value | 0
		: Number(BigInt.asIntN(32, value))
}

// NOTE: Integer and Rational — the two members of the numeric tower that spell
// the SAME value two ways, which is why they need one comparison between them
// rather than a cell each. `Algebraic` and `Transcendental` need none: each is
// provably irrational and canonically formed, so a value of either can equal
// only a value of its own kind, and every pairing across kinds is decided by
// the tags alone.
function isRationalKind(value: AnyType): value is IntegerType | RationalType {
	return (
		value[typeKeySymbol] === "Integer" ||
		value[typeKeySymbol] === "Rational"
	)
}

function numeratorOf(number: IntegerType | RationalType): bigint {
	return number[typeKeySymbol] === "Integer"
		? BigInt(number.value)
		: number.numerator
}

function denominatorOf(number: IntegerType | RationalType): bigint {
	return number[typeKeySymbol] === "Integer" ? 1n : number.denominator
}

// NOTE: Whether two Strings hold the same CHARACTERS, which is what `String.is`
// decides and what `===` does not: `String.compare` is lexicographic by code
// point over the NFC-normalised String, so an accent written as one code point
// and the same accent written as two are one String. Two NFC Strings are equal
// exactly when their code points match, which is what `===` decides — so
// normalising both sides is the same answer as walking the comparison, without
// importing it.
//
// NOTE: Identical code units are already canonically equivalent, so the
// normal form is only asked for by a pair that differs.
//
// NOTE: And it is ASKED FOR rather than computed — `normalisedFormOf` remembers
// it on the String, under a Symbol key beside its character view. Normalising
// here computed it afresh for BOTH sides of every unequal comparison, which is
// the common case in a search or a filter: one needle against a thousand
// candidates normalised the needle a thousand times, and a pure-ASCII pair
// normalised twice to be handed back what it already held.
//
// NOTE: It is exported because the Compiler emits a call to it:
// `lower-scalar-operations` compiles `a::is(b)` on two Strings to this, rather
// than writing the comparison out at every site. `anyIs` reads it too, so there
// is one answer to the question rather than two that must agree.
export function stringEquals(a: StringType, b: StringType): boolean {
	return a.value === b.value || normalisedFormOf(a) === normalisedFormOf(b)
}

export function anyIs(a: AnyType, b: AnyType): boolean {
	// NOTE: A value is equal to itself, whatever kind it is, so the one
	// comparison that costs nothing is asked first. This is not a shortcut past
	// a different answer: equality here is structural and therefore reflexive,
	// there is no float in the language and so no NaN to be unequal to itself,
	// and a Function is compared by identity anyway. What it skips is the whole
	// recursive walk of a Record, a List or a Case payload compared against
	// itself.
	//
	// NOTE: It earns its place because identical operands are ORDINARY rather
	// than freakish: the two Boolean values, every unit Case and — once the
	// Optimiser pools them — every literal are one shared instance each, so a
	// comparison that used to be two objects is now one object twice.
	if (a === b) {
		return true
	}

	// NOTE: A Function is the one runtime value carrying no Type key — it is
	// emitted as a bare JavaScript function, not a tagged object — so it is
	// answered before anything reads that key. Without this, comparing a
	// Record that merely HOLDS a Function threw on the missing key rather than
	// answering, which made `value is value` a crash instead of `true`.
	//
	// NOTE: Identity, not structure. Two Functions written the same are still
	// two Functions, and deciding otherwise is not decidable — but a Function
	// IS equal to itself, which is the promise `is` makes everywhere else.
	if (typeof a === "function" || typeof b === "function") {
		return a === b
	}

	// NOTE: Each tag read ONCE, and dispatched on rather than walked past. This
	// used to be a ladder of nine cells, each asking both values what kind they
	// were, so deciding that two Records were Records read twelve tags to
	// answer a question two reads settle — and every comparison of a Record's
	// members comes back through here.
	const aTag = a[typeKeySymbol]
	const bTag = b[typeKeySymbol]

	// NOTE: THE ONE PAIRING THAT SURVIVES DIFFERING TAGS, and the reason this
	// stands in front of the dispatch rather than inside it. Integer and
	// Rational spell the SAME value two ways, and that is what the language
	// promises: `Number.is` is `compare(other)::is(#Equal)` over the covering
	// order, and it answers by VALUE — `1 is 1/1` holds. Answering `false` for
	// differing tags first would take that away silently, and take it away only
	// where the comparison went through here: a value would stop being equal to
	// its equal the moment either was wrapped in a Record or a Case payload.
	// Ordinary arithmetic reaches the mixed pair too, since an Integer beside a
	// Rational is what widening leaves.
	//
	// NOTE: Every OTHER cross-kind pairing really is decided by the tags alone.
	// `Algebraic` and `Transcendental` need no cell each: both are provably
	// irrational and canonically formed, so a value of either can equal only a
	// value of its own kind.
	//
	// NOTE: Cross-multiplication, which is what `Number.compare` does for this
	// pairing — it answers for unreduced parts and for either sign, and it is
	// not the covering `compare` itself because EVERY emitted Program imports
	// this module: reading the covering order here dragged π's interval
	// arithmetic and the algebraic sign routines into Programs holding no
	// Numbers at all (measured at ~11 kB on one that only compares Records of
	// Strings).
	if (aTag !== bTag) {
		return (
			isRationalKind(a) &&
			isRationalKind(b) &&
			numeratorOf(a) * denominatorOf(b) ===
				numeratorOf(b) * denominatorOf(a)
		)
	}

	switch (aTag) {
		case "Boolean":
			return boolIs(a as BooleanType, b as BooleanType).value
		case "String":
			// NOTE: String.is is written in Essence now — it reads `compare`,
			// which is lexicographic by code point over the NFC-normalised
			// String, so it answers `Equal` for any two canonically equivalent
			// Strings (an accent composed or decomposed). `stringEquals` above
			// is that same answer without importing the whole comparison.
			// Comparing the RAW representations, as this did, made the same
			// pair of Strings equal on their own and unequal inside a Record.
			return stringEquals(a as StringType, b as StringType)
		case "Integer":
			// NOTE: Two Integers by `===` on what they hold, which is the whole
			// answer under the canonical invariant: one mathematical Integer
			// has one representation, so equal values compare equal and
			// unequal ones can not — a number and a bigint are unequal to
			// `===` and are, since their magnitudes must differ to be spelled
			// differently. It is answered here rather than by falling into the
			// Rational cell below so that comparing two Integers — which is
			// most comparisons — costs neither a bigint nor a multiplication.
			return a.value === (b as IntegerType).value
		case "Rational":
			// NOTE: The same cross-multiplication the differing tags reached,
			// for a Rational against a Rational — a Rational holds the parts it
			// was BUILT with, so two spellings of one value meet here as well.
			return (
				numeratorOf(a as IntegerType | RationalType) *
					denominatorOf(b as IntegerType | RationalType) ===
				numeratorOf(b as IntegerType | RationalType) *
					denominatorOf(a as IntegerType | RationalType)
			)
		case "Algebraic": {
			// NOTE: Algebraic.is is written in Essence now — it reads
			// `compare`, which decides the sign of the difference
			// symbolically, and this has to answer what that answers.
			// Comparing the REPRESENTATION does not: the radicand is not
			// canonical, because `extractSquarePart` trial-divides only up to
			// 2^16 and leaves a `p²·q` whose p and q are both past that bound
			// as written — so √(65537²·65539) and 65537·√65539 are one number
			// held two ways. Compared field by field they came out unequal,
			// while `is` called them equal: the same pair was equal on its own
			// and unequal inside a Record, a Case or a List, and a Dictionary
			// keyed by such a Record opened two slots for the one number.
			//
			// NOTE: `a + b·√d` is `a' + b'·√e` exactly when the rational parts
			// are equal and `b·√d = b'·√e`. The coefficients are never zero and
			// the radicands never 1, so that second half is the coefficients
			// sharing a sign and `b²·d = b'²·e` — squaring is exact over two
			// non-negative sides, and over the stored parts it is
			// `bn²·b'd²·d = b'n²·bd²·e`. Denominators are positive by
			// `reduced`'s invariant, so both cross-multiplications keep their
			// sign, and the whole test is bigint multiplication: none of the
			// interval arithmetic `compare` needs is imported here, which is
			// what keeps this file out of a Program's bundle.
			const other = b as AlgebraicType

			return (
				a.rationalPartNumerator * other.rationalPartDenominator ===
					other.rationalPartNumerator * a.rationalPartDenominator &&
				a.radicalCoefficientNumerator < 0n ===
					other.radicalCoefficientNumerator < 0n &&
				a.radicalCoefficientNumerator ** 2n *
					other.radicalCoefficientDenominator ** 2n *
					a.radicand ===
					other.radicalCoefficientNumerator ** 2n *
						a.radicalCoefficientDenominator ** 2n *
						other.radicand
			)
		}
		case "Transcendental": {
			// NOTE: The test the native `Transcendental.is` makes: every
			// component is held in canonical form, so two Transcendentals are
			// equal when their rational parts and term lists agree.
			const other = b as TranscendentalType

			return (
				a.rationalPartNumerator === other.rationalPartNumerator &&
				a.rationalPartDenominator === other.rationalPartDenominator &&
				a.terms.length === other.terms.length &&
				a.terms.every((term, index) => {
					const otherTerm = other.terms[index]!

					return (
						term.base === otherTerm.base &&
						term.coefficientNumerator ===
							otherTerm.coefficientNumerator &&
						term.coefficientDenominator ===
							otherTerm.coefficientDenominator
					)
				})
			)
		}
		case "Record":
			return recordIs(a, b as RecordType).value
		case "List": {
			// NOTE: List.is takes a conformance witness now — equality of a
			// List is its items' own equality — and there is no witness to hand
			// it here. Recurse through this same universal comparison instead,
			// which is what the native did before the witness arrived.
			//
			// NOTE: Through a view rather than off the Arrays, exactly as
			// `List.is` does it — a List holds its items in two runs, and the
			// two sides may be in different representations while holding the
			// same items.
			let first = viewOf(a)
			let second = viewOf(b as ListType<AnyType>)

			if (first.total !== second.total) {
				return false
			}

			for (let index = 0; index < first.total; index++) {
				if (
					!anyIs(itemOfView(first, index), itemOfView(second, index))
				) {
					return false
				}
			}

			return true
		}
		default: {
			// NOTE: A kind no cell above names may still have said how two of
			// its values compare — the registry in `registry.ts` is where a
			// container's own module leaves that, and probing it HERE is what
			// keeps this ladder the whole cost of equality for a Program that
			// holds none of them. A Dictionary is one such kind: it is compared
			// by the entries it holds rather than by the slots, versions and
			// generation a box is made of, so falling through to the structural
			// comparison below would have made a Dictionary unequal to its own
			// copy.
			let kind = kindOf(aTag)

			if (kind !== undefined) {
				return kind.equals(a, b, anyIs)
			}

			// NOTE: Case values (`Ordering#Less`, `CalculatorOperation#Add`) —
			// the tag decides the Case (nominal) and it has already decided,
			// since the two tags are the same one; the payload members compare
			// structurally like a Record's. A tag carrying no `#` is no Case,
			// and there is nothing left for it to be.
			return aTag.includes("#")
				? recordIs(
						a as unknown as RecordType,
						b as unknown as RecordType,
					).value
				: false
		}
	}
}

export function anyIsNot(a: AnyType, b: AnyType): boolean {
	return !anyIs(a, b)
}

// NOTE: The runtime half of a Choice's derived `Equatable` conformance — what
// `Colour::is` compiles to when no Namespace writes one. `anyIs` already
// answers exactly what a derived equality should: the tag decides the Case
// nominally, and a payload compares as the Record it is. These two exist so
// the derived Methods have something with a Method's shape to bind to —
// `anyIs` answers a raw JavaScript boolean, and an Essence `-> Boolean` has to
// hand back a Boolean value.
export function choiceIs(a: AnyType, b: AnyType): BooleanType {
	return createBoolean(anyIs(a, b))
}

export function choiceIsNot(a: AnyType, b: AnyType): BooleanType {
	return createBoolean(!anyIs(a, b))
}

// NOTE: The runtime half of a Choice's derived `Printable` conformance — what
// `Ordering::toString` compiles to when no Namespace writes one. Every Case of
// such a Choice carries no payload, so the tag holds everything there is to
// say: `"Ordering#Less"` answers `"Less"`. One helper serves every Choice of
// every Program, which is the whole of what the derive costs — a `match` over
// the Case names would cost one of those per Choice.
//
// NOTE: Read from the LAST `#`, not the first. A Choice a Program declares is
// identified by its Module as well as its name, so its Cases are tagged
// `"./Colours.es#Colour#Red"`, and only the last part is the Case. A Case name
// can hold no `#` of its own, so the last one is always the right one. A value
// with no `#` at all is no Case; `lastIndexOf` answers -1 for it and the whole
// tag is read, which keeps a Program that somehow reaches here answering a
// String.
export function choiceName(value: AnyType): StringType {
	let tag = String(value[typeKeySymbol])

	return createString(tag.slice(tag.lastIndexOf("#") + 1))
}

// NOTE: The runtime half of a Choice's derived `Enumerable` conformance — what
// `Side.cases()` compiles to when no Namespace writes one. It is CURRIED with
// the Choice's tags, in declaration order, because the Method is static: there
// is no receiver at the call for the Choice to be recovered from, so what the
// Compiler knows has to be carried here instead. That is the same shape the
// widened `boundChoiceIs` takes its descriptor in.
//
// NOTE: A fresh List at every call, rather than one built beside the tags and
// answered again — and what that buys is LOCALITY rather than a bug avoided.
// One shared answer would in fact be safe today, for two reasons that live
// elsewhere: every in-place write to a List's Array, a push by `append` or
// `prepend` or a positional write by `replace`, leaves the Array's other
// holders their items, which is what `List.ts` keeps; and a rewritten walk
// seeded by a CALL copies through `ownItemsOf` rather than editing the seed.
// Both are contracts other files keep, and a shared box would make this one
// depend on every future List operation keeping them too. Fresh costs about
// 12 ns a call and keeps the safety here. The Cases themselves ARE shared and
// are meant to be: `createCase` interns the payload-free ones, so the items
// cost nothing after the first call.
//
// NOTE: The cast is the one `Generators.ts` makes at every Case it builds, and
// for the reason written there: `CaseInstanceType` is deliberately outside
// `AnyType`. These are Cases at run time either way.
export function choiceCases(tags: Array<string>): () => ListType<AnyType> {
	return () =>
		createList(tags.map((tag) => createCase(tag) as unknown as AnyType))
}

// NOTE: The compile-time plan a *generic* Choice's derived equality follows —
// one entry per Case tag mapping each payload member's name to how it compares.
// A member naming no Type Parameter compares structurally (`eq`); a bare
// Parameter routes through the witness at index `i`; the composites recurse.
type DescriptorNode =
	| { k: "eq" }
	| { k: "w"; i: number }
	| { k: "list"; of: DescriptorNode }
	| { k: "dictionary"; key: DescriptorNode; value: DescriptorNode }
	| { k: "record"; m: Record<string, DescriptorNode> }
	| { k: "case"; m: Record<string, DescriptorNode> }
	// NOTE: `shape` is carried by exactly the arms one tag can not tell apart —
	// the Types every Record and every List share a tag with. It is checked with
	// the same `isValueOfType` a Match narrows with, and the Enricher orders the
	// arms most specific first.
	| { k: "union"; arms: Array<UnionArm> }

type UnionArm = {
	tag: string | null
	shape?: common.Type
	node: DescriptorNode
}

type DerivedEquatableDescriptor = Record<string, Record<string, DescriptorNode>>

// NOTE: The printing witness, whose `toString` answers an Essence String. It is
// read and curried the way `EquatableWitness` is; the two are apart because a
// Record routes each Protocol on its own list of members.
type PrintableWitness = { toString: (value: AnyType) => StringType }

// NOTE: A conformance witness as it arrives at runtime — a method map whose
// `is` answers a Boolean. When the Type it stands for is itself conditional,
// `boundConformance` has already curried its own nested witnesses onto `is`, so
// it is called through plainly, exactly as `List.is` calls its witness.
type EquatableWitness = { is: (a: AnyType, b: AnyType) => BooleanType }

// NOTE: The runtime half of a *generic* Choice's derived `Equatable` — the flat
// `choiceIs` compares every payload structurally, which is wrong once a payload
// is a Type Parameter with its own equality (a `1/2` that must equal `2/4`
// through Rational's `is`, not field by field). `boundChoiceIs(descriptor)`
// returns a function of `(a, b, …witnesses)` because the hidden conformance
// Arguments arrive as trailing Parameters — appended directly at a plain call,
// or curried on by `boundConformance` at a bounded one.
export function boundChoiceIs(descriptor: DerivedEquatableDescriptor) {
	return (
		a: AnyType,
		b: AnyType,
		...witnesses: Array<EquatableWitness>
	): BooleanType => createBoolean(casesEqual(a, b, descriptor, witnesses))
}

export function boundChoiceIsNot(descriptor: DerivedEquatableDescriptor) {
	return (
		a: AnyType,
		b: AnyType,
		...witnesses: Array<EquatableWitness>
	): BooleanType => createBoolean(!casesEqual(a, b, descriptor, witnesses))
}

// NOTE: The runtime half of a RECORD that routes. `Record.is` compares every
// member through `anyIs` — the universal structural rule — which is the right
// answer only while no member's own Namespace writes a different one. Where one
// does, the Compiler hands the member's witness in and curries this with the
// names of the members that take one, in the order the witnesses arrive.
//
// NOTE: The member SETS still have to match, which is the whole difference
// between this and the descriptor's `record` node: that one is a payload of a
// Case, whose members are fixed by the declaration, while a Record has WIDTH —
// a `{ tag: Tag }` value may carry an `extra` the static Type can not see. The
// declared members route; every other member is compared by `anyIs`, which is
// what says a narrow Type's answer may differ from the wide one's. See
// `Record.es`.
//
// NOTE: The names are carried AS THEY WERE CURRIED — an Array, indexed into by
// the walk below — and not turned into a Map of name to slot. The Map was here
// first, on the reasoning that a lookup beats a search; measured, it does not
// at these sizes. A routed Record names one member, or two, or three, so the
// search is one or two comparisons of interned strings against a hash of the
// key and a bucket read, and building the Map cost an allocation per currying
// besides. 2,000,000 comparisons of a `{ tag: Tag, n: Integer }` through
// `List::contains`: 0.145 s with the Map, 0.133 s without, best of five,
// alternated, one world per process.
//
// NOTE: What is left above a hand-written `is` (0.036 s for the same 2,000,000)
// is not here. It is the two `Object.keys` the member-set check allocates, the
// rest Array this signature builds per call, and the two more `boundConformance`
// builds around it at a bounded call — all of them shared with List, Dictionary
// and the Choice helper beside this one, and none of them a Record's to fix
// alone.
export function boundRecordIs(members: Array<string>) {
	return (
		a: RecordType,
		b: RecordType,
		...witnesses: Array<EquatableWitness>
	): BooleanType => createBoolean(recordRoutesEqual(a, b, members, witnesses))
}

// NOTE: And the printing half. `Record.toString` renders every member through
// the structural walk, which is the right answer only while no member's own
// Namespace prints it differently — and far more members do than compare
// differently: every Case (`Door#Open` where `Door::toString` answers `Open`),
// every Optional and Result (`Optional#Value(3)` against `Value(3)`), and every
// Namespace anybody wrote a `toString` for.
//
// NOTE: The Arguments are `Record.toString`'s own — indent zero,
// `formatAsFraction` so a whole Rational member prints its numerator alone, and
// the empty `[` padding that makes a List member read as `List::toString`
// answers it. The layout is not forked: the renderers go IN, and the walk keeps
// the one-line budget, the nesting and the quoting it already had.
export function boundRecordToString(members: Array<string>) {
	return (
		record: RecordType,
		...witnesses: Array<PrintableWitness>
	): StringType =>
		createString(
			getStringRepresentation(
				record,
				0,
				formatAsFraction,
				"",
				renderersOf(members, witnesses),
			),
		)
}

// NOTE: Built per CALL rather than at currying: the witnesses arrive as
// Arguments, so there is nothing to build until one is made. A Record is printed
// far less often than it is compared, which is why this one is allowed an
// allocation the comparison would not be.
//
// NOTE: WITH NO PROTOTYPE, because the READER names these keys. A Record member
// may be called `constructor`, `toString`, `valueOf` or `hasOwnProperty`, and
// the walk reads this table by member name — off a plain `{}` those names find
// `Object.prototype`'s own functions, which are not nullish, so the `??` beside
// the read never fires and the member renders as whatever calling one of them
// answers: `[object Object]`, or `false`. It bites the members this table does
// NOT name, which is every other member of a Record that routes something. The
// equality half reads no table at all — it walks the routed names — so it was
// never exposed to this.
function renderersOf(
	members: Array<string>,
	witnesses: Array<PrintableWitness>,
): Record<string, (value: AnyType) => string> {
	let renderers: Record<string, (value: AnyType) => string> =
		Object.create(null)

	for (let [index, name] of members.entries()) {
		let witness = witnesses[index]!

		renderers[name] = (value) => witness.toString(value).value
	}

	return renderers
}

// NOTE: There is no `boundRecordIsNot` beside `boundRecordIs`, and there is no
// room for one: `Record.es` writes `is` and no negation, so
// `record::isNot(other)` is `Equatable`'s own provided body run over the
// Record's witness — it reads the routed `is` off that witness and negates what
// it answers. A helper here would be a second answer to a question that already
// has one.

// NOTE: The same two key Arrays `Record.is` counts with, and for the reason
// written there: a Record carries a Symbol key, which keeps it off the engine's
// fast enumeration path, and `Object.keys` on a shape the engine has seen is
// nearly free where a `for…in` is four times slower.
//
// NOTE: ONE pass, over the LEFT side's keys, which is what makes the member-set
// check and the comparison the same walk: a key the right side does not carry
// ends it, and a key the routed list does not name is compared by `anyIs`, as
// `Record.is` compares every member. `indexOf` over the routed names is the
// slot — see `boundRecordIs` for why a search rather than a lookup.
function recordRoutesEqual(
	a: RecordType,
	b: RecordType,
	routed: Array<string>,
	witnesses: Array<EquatableWitness>,
): boolean {
	let aKeys = Object.keys(a)

	if (aKeys.length !== Object.keys(b).length) {
		return false
	}

	for (let key of aKeys) {
		if (!Object.hasOwn(b, key)) {
			return false
		}

		let slot = routed.indexOf(key)

		if (slot < 0) {
			if (!anyIs(a[key]!, b[key]!)) {
				return false
			}
		} else if (!witnesses[slot]!.is(a[key]!, b[key]!).value) {
			return false
		}
	}

	return true
}

// NOTE: The tag decides the Case first (nominal), then each payload member is
// compared as the descriptor says. A tag the descriptor does not name carries
// no generic payload, so it falls back to the universal structural comparison.
function casesEqual(
	a: AnyType,
	b: AnyType,
	descriptor: DerivedEquatableDescriptor,
	witnesses: Array<EquatableWitness>,
): boolean {
	if (a[typeKeySymbol] !== b[typeKeySymbol]) {
		return false
	}

	let members = descriptor[a[typeKeySymbol]]

	if (members === undefined) {
		return anyIs(a, b)
	}

	return membersEqual(a, b, members, witnesses)
}

function membersEqual(
	a: AnyType,
	b: AnyType,
	members: Record<string, DescriptorNode>,
	witnesses: Array<EquatableWitness>,
): boolean {
	for (let [name, node] of Object.entries(members)) {
		if (
			!memberEqual(
				(a as Record<string, AnyType>)[name],
				(b as Record<string, AnyType>)[name],
				node,
				witnesses,
			)
		) {
			return false
		}
	}

	return true
}

function memberEqual(
	a: AnyType,
	b: AnyType,
	node: DescriptorNode,
	witnesses: Array<EquatableWitness>,
): boolean {
	switch (node.k) {
		case "eq":
			return anyIs(a, b)
		case "w":
			return witnesses[node.i].is(a, b).value
		case "list": {
			// NOTE: The counts are fixed before the walk and BOTH runs are
			// sealed, for the reason `List.is` gives: the item comparison is a
			// witness call and so user code, which may append to a List whose
			// run either side is being read out of — or write a position of one
			// in place, which would change an item this walk has yet to reach
			// and answer `false` about two Choices that hold equal Lists.
			// Neither side is the receiver here, so `walkOf` is owed to both.
			let aView = walkOf(a as ListType<AnyType>)
			let bView = walkOf(b as ListType<AnyType>)

			if (aView.total !== bView.total) {
				return false
			}

			for (let index = 0; index < aView.total; index++) {
				if (
					!memberEqual(
						itemOfView(aView, index),
						itemOfView(bView, index),
						node.of,
						witnesses,
					)
				) {
					return false
				}
			}

			return true
		}
		case "dictionary": {
			// NOTE: Answered by the kind registry rather than here, for the
			// reason `anyIs` probes it: this walk is carried by every Program
			// whose Choice or Record holds a Type Parameter, and the
			// order-insensitive matching a Dictionary needs is a dozen lines
			// that belong to the container. `kindOf` can only answer nothing
			// where no Dictionary was ever built, and a descriptor naming one
			// is a Program that builds one.
			let kind = kindOf((a as AnyType)[typeKeySymbol])

			return (
				kind !== undefined &&
				kind.equalsBy(
					a,
					b,
					(first, second) =>
						memberEqual(first, second, node.key, witnesses),
					(first, second) =>
						memberEqual(first, second, node.value, witnesses),
				)
			)
		}
		case "record":
			return membersEqual(a, b, node.m, witnesses)
		case "case":
			if (a[typeKeySymbol] !== b[typeKeySymbol]) {
				return false
			}

			return membersEqual(a, b, node.m, witnesses)
		case "union": {
			// NOTE: An arm claims a value by its `typeKeySymbol` tag, and — when
			// the tag alone can not tell it from another arm — by the shape the
			// Enricher gave it. Both sides must land on the same arm, so a
			// `String` and a `T` value are unequal. Anything no arm claims
			// falls to the one generic arm (`tag: null`) and compares through
			// its witness.
			let aArm = node.arms.find((arm) => armClaims(arm, a))
			let bArm = node.arms.find((arm) => armClaims(arm, b))

			if (aArm !== undefined || bArm !== undefined) {
				return aArm === bArm
					? memberEqual(a, b, aArm!.node, witnesses)
					: false
			}

			// NOTE: The fallback is ONE arm — the Enricher shapes every other
			// Parameter-naming arm with what the receiver's Type Arguments made
			// of it, precisely so that only one is left with nothing to be told
			// apart by. Two of them means the descriptor is wrong rather than
			// the Program: whichever came first would answer for the other's
			// values, which is a `List<T>` compared through T's own witness.
			if (
				node.arms.filter(
					(arm) => arm.tag === null && arm.shape === undefined,
				).length > 1
			) {
				throw new Error(
					"A Union payload descriptor leaves several arms with nothing to tell them apart. This is a bug in the Compiler.",
				)
			}

			let fallback = node.arms.find((arm) => arm.tag === null)

			return fallback === undefined
				? anyIs(a, b)
				: memberEqual(a, b, fallback.node, witnesses)
		}
	}
}

// NOTE: Whether one arm of a Union-typed payload member claims this value. A
// tagged arm claims the values carrying its tag, narrowed by its shape when it
// has one — the arms that share a tag are the ones the Enricher shapes. The
// generic arm carries no tag and claims nothing here: it is the FALLBACK, taken
// above only once no arm claimed. It claims positively only when it was shaped
// too, which happens when the Type Argument refines a concrete arm and has to
// take its own values off it.
function armClaims(arm: UnionArm, value: AnyType): boolean {
	if (arm.tag === null) {
		return arm.shape !== undefined && isValueOfType(value, arm.shape)
	}

	return (
		arm.tag === value[typeKeySymbol] &&
		(arm.shape === undefined || isValueOfType(value, arm.shape))
	)
}
