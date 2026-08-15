import type { common } from "@essence-lang/interfaces"

import type { BooleanType } from "./Boolean"
import { is as boolIs, createBoolean } from "./Boolean"
import type { IntegerType } from "./Integer"
import type { ListType } from "./List"
import { itemOfView, viewOf } from "./List"
import type { RationalType } from "./Rational"
import type { RecordType } from "./Record"
import { is as recordIs } from "./Record"
import type { StringType } from "./String"
import type { AnyType } from "./type"
import { isValueOfType, typeKeySymbol } from "./type"

export function getInt32(number: IntegerType): number {
	return Number(BigInt.asIntN(32, number.value))
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
	return number[typeKeySymbol] === "Integer" ? number.value : number.numerator
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
// normalisation — which allocates twice — only has to run for a pair that
// differs.
//
// NOTE: It is exported because the Compiler emits a call to it:
// `lower-scalar-operations` compiles `a::is(b)` on two Strings to this, rather
// than writing the double normalisation out at every site. `anyIs` reads it too,
// so there is one answer to the question rather than two that must agree.
export function stringEquals(a: StringType, b: StringType): boolean {
	return (
		a.value === b.value ||
		a.value.normalize("NFC") === b.value.normalize("NFC")
	)
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

	if (a[typeKeySymbol] === "Boolean" && b[typeKeySymbol] === "Boolean") {
		return boolIs(a, b).value
	} else if (
		a[typeKeySymbol] === "String" && //
		b[typeKeySymbol] === "String"
	) {
		// NOTE: String.is is written in Essence now — it reads `compare`,
		// which is lexicographic by code point over the NFC-normalised String,
		// so it answers `Equal` for any two canonically equivalent Strings (an
		// accent composed or decomposed). `stringEquals` above is that same
		// answer without importing the whole comparison. Comparing the RAW
		// representations, as this did, made the same pair of Strings equal on
		// their own and unequal inside a Record.
		return stringEquals(a, b)
	} else if (isRationalKind(a) && isRationalKind(b)) {
		// NOTE: ONE cell for the two rational kinds, because that is what the
		// language promises: `Number.is` is `compare(other)::is(#Equal)` over
		// the covering order, and it answers by VALUE — `1 is 1/1` holds. A cell
		// per kind could not see across the two, so an Integer beside a
		// numerically equal Rational matched nothing and fell to `false`: a
		// value stopped being equal to its equal the moment either was wrapped
		// in a Record or a Case payload. Ordinary arithmetic reaches the mixed
		// pair, too — `createRational` never reduces, so `(1/2)::add(1/2)` is
		// the Rational `4/4` beside anyone else's Integer `1`.
		//
		// NOTE: Cross-multiplication, which is what `Number.compare` does for
		// this pairing — it answers for unreduced parts and for either sign,
		// and it is not the covering `compare` itself because EVERY emitted
		// Program imports this module: reading the covering order here dragged
		// π's interval arithmetic and the algebraic sign routines into Programs
		// holding no Numbers at all (measured at ~11 kB on one that only
		// compares Records of Strings). The pairings that order needs it for are
		// exactly the ones equality can decide by tag — see `isRationalKind`.
		return (
			numeratorOf(a) * denominatorOf(b) ===
			numeratorOf(b) * denominatorOf(a)
		)
	} else if (
		a[typeKeySymbol] === "Algebraic" &&
		b[typeKeySymbol] === "Algebraic"
	) {
		// NOTE: Algebraic.is is written in Essence now — it reads `compare`,
		// which decides the sign of the difference symbolically. Normal forms
		// make that the same answer as comparing the representation directly,
		// which is what the deleted native did. An Algebraic is irrational, so
		// it can equal no Integer, Rational or Transcendental — those pairings
		// need no cell of their own and fall through to `false` below.
		return (
			a.radicand === b.radicand &&
			a.rationalPartNumerator === b.rationalPartNumerator &&
			a.rationalPartDenominator === b.rationalPartDenominator &&
			a.radicalCoefficientNumerator === b.radicalCoefficientNumerator &&
			a.radicalCoefficientDenominator === b.radicalCoefficientDenominator
		)
	} else if (
		a[typeKeySymbol] === "Transcendental" &&
		b[typeKeySymbol] === "Transcendental"
	) {
		// NOTE: Transcendental.is is written in Essence now — it reads the
		// `Number` Union's `is`, whose Transcendental/Transcendental cell is
		// exact. Canonical forms make that the same answer as comparing the
		// representation directly, which is what the deleted native did. A
		// Transcendental equals no value of any other kind, for the same reason
		// an Algebraic does not.
		return (
			a.rationalPartNumerator === b.rationalPartNumerator &&
			a.rationalPartDenominator === b.rationalPartDenominator &&
			a.terms.length === b.terms.length &&
			a.terms.every((term, index) => {
				const other = b.terms[index]!

				return (
					term.base === other.base &&
					term.coefficientNumerator === other.coefficientNumerator &&
					term.coefficientDenominator === other.coefficientDenominator
				)
			})
		)
	} else if (
		a[typeKeySymbol] === "Record" && //
		b[typeKeySymbol] === "Record"
	) {
		return recordIs(a, b).value
	} else if (
		a[typeKeySymbol] === "List" && //
		b[typeKeySymbol] === "List"
	) {
		// NOTE: List.is takes a conformance witness now — equality of a List is
		// its items' own equality — and there is no witness to hand it here.
		// Recurse through this same universal comparison instead, which is what
		// the native did before the witness arrived.
		//
		// NOTE: Through a view rather than off the Arrays, exactly as
		// `List.is` does it — a List holds its items in two runs, and the two
		// sides may be in different representations while holding the same
		// items.
		let first = viewOf(a)
		let second = viewOf(b)

		if (first.total !== second.total) {
			return false
		}

		for (let index = 0; index < first.total; index++) {
			if (!anyIs(itemOfView(first, index), itemOfView(second, index))) {
				return false
			}
		}

		return true
	} else if (
		a[typeKeySymbol].includes("#") &&
		a[typeKeySymbol] === b[typeKeySymbol]
	) {
		// NOTE: Case values (`Ordering#Less`, `CalculatorOperation#Add`) —
		// the tag decides the Case (nominal), the payload members compare
		// structurally like a Record's.
		return recordIs(a as unknown as RecordType, b as unknown as RecordType)
			.value
	} else {
		return false
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

// NOTE: The compile-time plan a *generic* Choice's derived equality follows —
// one entry per Case tag mapping each payload member's name to how it compares.
// A member naming no Type Parameter compares structurally (`eq`); a bare
// Parameter routes through the witness at index `i`; the composites recurse.
type DescriptorNode =
	| { k: "eq" }
	| { k: "w"; i: number }
	| { k: "list"; of: DescriptorNode }
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
			// NOTE: The counts are fixed before the walk, for the reason
			// `List.ts` gives: the item comparison is a witness call and so
			// user code, which may append to a List whose run either side is
			// being read out of.
			let aView = viewOf(a as ListType<AnyType>)
			let bView = viewOf(b as ListType<AnyType>)

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
