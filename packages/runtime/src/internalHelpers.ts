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

	// `| 0` keeps the low 32 bits signed, as `BigInt.asIntN(32, …)` does,
	// without building a bigint.
	return typeof value === "number"
		? value | 0
		: Number(BigInt.asIntN(32, value))
}

// The two kinds that can spell one value two ways.
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

// What `String::is` answers: the same code units, or failing that the same
// remembered NFC form. Emitted for `a::is(b)` on two Strings. See "Universal
// equality" in DEVELOPMENT.md.
export function stringEquals(a: StringType, b: StringType): boolean {
	return a.value === b.value || normalisedFormOf(a) === normalisedFormOf(b)
}

export function anyIs(a: AnyType, b: AnyType): boolean {
	// Equality is reflexive, and shared instances make identical operands
	// common. See "Universal equality" in DEVELOPMENT.md.
	if (a === b) {
		return true
	}

	// A Function carries no tag and compares by identity.
	if (typeof a === "function" || typeof b === "function") {
		return a === b
	}

	const aTag = a[typeKeySymbol]
	const bTag = b[typeKeySymbol]

	// Only an Integer and a Rational can be equal across tags, so `1` equals
	// `1/1` inside a Record too.
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
			return stringEquals(a as StringType, b as StringType)
		case "Integer":
			// One Integer has one representation, so `===` is the answer.
			return a.value === (b as IntegerType).value
		case "Rational":
			// A Rational holds the parts it was built with, so it
			// cross-multiplies.
			return (
				numeratorOf(a as IntegerType | RationalType) *
					denominatorOf(b as IntegerType | RationalType) ===
				numeratorOf(b as IntegerType | RationalType) *
					denominatorOf(a as IntegerType | RationalType)
			)
		case "Algebraic": {
			// One number can be held over two radicands, so the fields are
			// not compared directly. Equal rational parts, one coefficient sign
			// and `b²·d = b'²·e`. See "Universal equality" in DEVELOPMENT.md.
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
			// Held in canonical form, so the fields compare directly.
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
			// Item by item through `anyIs`, since no witness is in hand. No
			// user code runs, so the views need no seal.
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
			// A container registers its own equality. See "The kind registry"
			// in DEVELOPMENT.md.
			let kind = kindOf(aTag)

			if (kind !== undefined) {
				return kind.equals(a, b, anyIs)
			}

			// A Case: the tags already match, so the payloads compare as
			// Records.
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

// A Choice's derived `is` and `isNot`: `anyIs`, answering a Boolean. See
// "Derived conformances" in DEVELOPMENT.md.
export function choiceIs(a: AnyType, b: AnyType): BooleanType {
	return createBoolean(anyIs(a, b))
}

export function choiceIsNot(a: AnyType, b: AnyType): BooleanType {
	return createBoolean(!anyIs(a, b))
}

// A payload-free Choice's derived `toString`: the Case name after the tag's
// last `#`, since a user Choice's tag carries its Module.
export function choiceName(value: AnyType): StringType {
	let tag = String(value[typeKeySymbol])

	return createString(tag.slice(tag.lastIndexOf("#") + 1))
}

// A Choice's derived `cases`, curried with its tags in declaration order. A
// fresh List per call. `CaseInstanceType` lies outside `AnyType`, so the Cases
// are cast.
export function choiceCases(tags: Array<string>): () => ListType<AnyType> {
	return () =>
		createList(tags.map((tag) => createCase(tag) as unknown as AnyType))
}

// How each payload member of a generic Choice compares, per Case tag. See
// "Derived conformances" in DEVELOPMENT.md.
type DescriptorNode =
	| { k: "eq" }
	| { k: "w"; i: number }
	| { k: "list"; of: DescriptorNode }
	| { k: "dictionary"; key: DescriptorNode; value: DescriptorNode }
	| { k: "record"; m: Record<string, DescriptorNode> }
	| { k: "case"; m: Record<string, DescriptorNode> }
	// `shape` tells apart arms that share a tag, most specific first.
	| { k: "union"; arms: Array<UnionArm> }

type UnionArm = {
	tag: string | null
	shape?: common.Type
	node: DescriptorNode
}

type DerivedEquatableDescriptor = Record<string, Record<string, DescriptorNode>>

// A Record routes printing and equality on separate member lists.
type PrintableWitness = { toString: (value: AnyType) => StringType }

// A conditional witness arrives with its own witnesses curried on.
type EquatableWitness = { is: (a: AnyType, b: AnyType) => BooleanType }

// A generic Choice's derived `is`, with the witnesses as trailing Arguments.
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

// A Record whose routed members compare through their witnesses, curried with
// their names. See "Derived conformances" in DEVELOPMENT.md.
export function boundRecordIs(members: Array<string>) {
	return (
		a: RecordType,
		b: RecordType,
		...witnesses: Array<EquatableWitness>
	): BooleanType => createBoolean(recordRoutesEqual(a, b, members, witnesses))
}

// The printing half, with `Record.toString`'s own Arguments and a renderer per
// routed member.
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

// Built per call, since the witnesses arrive as Arguments. It has no prototype,
// so a member named `toString` finds no renderer of `Object.prototype`'s.
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

// One pass over the left side's keys checks the member sets and compares. No
// `boundRecordIsNot` exists, since `Equatable` negates the routed `is`.
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

// The tag decides the Case first (nominal), then each payload member is
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
			// A witness is user code, so both runs are sealed.
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
			// The kind registry answers, so this walk carries no Dictionary
			// code. A descriptor naming a Dictionary means one was built.
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
			// Both sides must land on one arm. A value no arm claims falls to
			// the generic arm.
			let aArm = node.arms.find((arm) => armClaims(arm, a))
			let bArm = node.arms.find((arm) => armClaims(arm, b))

			if (aArm !== undefined || bArm !== undefined) {
				return aArm === bArm
					? memberEqual(a, b, aArm!.node, witnesses)
					: false
			}

			// INVARIANT: the Enricher leaves at most one arm with nothing to
			// tell it apart.
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

// Whether an arm claims the value, by tag and shape. The generic arm claims
// only when shaped, since it is otherwise the fallback.
function armClaims(arm: UnionArm, value: AnyType): boolean {
	if (arm.tag === null) {
		return arm.shape !== undefined && isValueOfType(value, arm.shape)
	}

	return (
		arm.tag === value[typeKeySymbol] &&
		(arm.shape === undefined || isValueOfType(value, arm.shape))
	)
}
