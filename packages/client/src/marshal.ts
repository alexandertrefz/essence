import { displayChoiceName } from "@essence-lang/compiler/helpers"
import { printType } from "@essence-lang/compiler/printType"
import { emittedIdentity } from "@essence-lang/compiler/rewriter"
import type { common } from "@essence-lang/interfaces"

import type { EssenceValue, RuntimeBridge } from "./bridge"
import { EssenceMarshalError } from "./errors"
import { EssenceRational } from "./rational"

// NOTE: The two directions across the boundary, and they are not mirror images.
//
// Coming OUT, a value says what it is: every Essence value but a Function
// carries its Type on the bundle's own hidden key, so `toJS` reads the tag and
// answers. No Type is needed and none is asked for.
//
// Going IN, a JavaScript value says nothing. `7` could be an Integer, a
// Rational, an `Optional<Integer>` or one arm of a Union, and which of them it
// has to become is decided by the Type the Module DECLARED — so `fromJS` walks
// the `common.Type` off the Export Surface and builds against it. That is what
// makes the boundary lossless in both directions rather than merely plausible.
//
// NOTE: Nothing here guesses at the runtime. The Symbol every tag is read
// through and every constructor a value is built by come out of the BUNDLE,
// through the bridge — a value built any other way carries a Symbol the Module
// has never seen, and every Method it reaches would find it untyped.
//
// NOTE: A value `fromJS` builds is admitted by the Type it was built against
// BY CONSTRUCTION — each member is built against the member's own Type and each
// arm of a Union is the arm that took the value — so the runtime's own
// `isValueOfType` is not asked afterwards. Asking would mean handing it the
// Surface's Type descriptor, whose Case identities are the canonical paths of
// the machine that compiled while the values' tags are entry-relative; rendering
// a whole descriptor tree to match would be a SECOND copy of the rule
// `emittedIdentity` states, and a second copy is the only way the two could ever
// disagree. What is worth checking is checked where the value is built.

// NOTE: Where the value under discussion sits, for an Error to name. The root is
// what the caller called it — `argument 2`, `PI`, `return value` — and the trail
// is the JavaScript accessor path from there, so a failure deep inside a List of
// Records reads `argument 2 → .items[0].width` rather than `expected Integer`.
type Path = { root: string; trail: string }

function spell(at: Path): string {
	if (at.trail === "") {
		return at.root
	}

	return at.root === "" ? at.trail : `${at.root} → ${at.trail}`
}

function member(at: Path, name: string): Path {
	return { root: at.root, trail: `${at.trail}.${name}` }
}

function index(at: Path, position: number): Path {
	return { root: at.root, trail: `${at.trail}[${position}]` }
}

// NOTE: How many names an Error spells out before it starts counting.
const NAMES_SHOWN = 5

export type Marshaller = {
	// NOTE: An Essence value out, as the JavaScript it maps to. The optional
	// name is what an Error calls the value — a caller marshalling a return
	// value or a constant says which — and everything below it is spelled
	// relative to that.
	toJS: (value: unknown, path?: string) => unknown
	// NOTE: A JavaScript value in, as the Essence Type it is being handed to.
	fromJS: (
		value: unknown,
		expected: common.Type,
		path?: string,
	) => EssenceValue
}

export type MarshallerOptions = {
	// NOTE: The canonical path of the entry the bridge's bundle was emitted for.
	// A Case tag is spelled relative to the entry INSIDE a bundle, so building
	// one takes the entry as well as the Type — see `emittedIdentity`.
	entryPath: string
}

export function createMarshaller(
	bridge: RuntimeBridge,
	options: MarshallerOptions,
): Marshaller {
	// #region Out

	function toJS(value: unknown, at: Path): unknown {
		// NOTE: The one untagged Essence value — a Function is emitted as a bare
		// JavaScript function, and a Namespace as a class, which is one too.
		// Both pass through as they are; giving a Function an Essence-shaped
		// call is a separate job from marshalling one.
		if (typeof value === "function") {
			return value
		}

		if (value === null || typeof value !== "object") {
			throw foreignValue(value, at)
		}

		let tag = (value as Record<symbol, unknown>)[bridge.typeKey]

		if (typeof tag !== "string") {
			throw foreignValue(value, at)
		}

		switch (tag) {
			case "Integer":
				return (value as { value: bigint }).value
			case "Rational": {
				let parts = value as { numerator: bigint; denominator: bigint }

				return new EssenceRational(parts.numerator, parts.denominator)
			}
			case "String":
				return (value as { value: string }).value
			case "Boolean":
				return (value as { value: boolean }).value
			case "List":
				return (value as { value: Array<unknown> }).value.map(
					(item, position) => toJS(item, index(at, position)),
				)
			case "Record":
				return fieldsOf(value, at)
			// NOTE: An Optional is transparent — `Optional<T>` IS `T | undefined`
			// on this side — so the Case does not appear in the answer, and the
			// path gains no segment for it either. A host reading `.item` off
			// what came back would be reading the Module's bookkeeping rather
			// than its value.
			case "Optional#Value": {
				let item = (value as { item: unknown }).item

				// NOTE: Absence does not nest. `#Value(#Empty)` and `#Empty`
				// would both be `undefined` here, and Essence is explicit that
				// they are two values — so the pair is refused rather than
				// collapsed into the one of them a round trip would hand back.
				if (isOptionalValue(item)) {
					throw nestedOptional(at)
				}

				return toJS(item, at)
			}
			case "Optional#Empty":
				return undefined
		}

		if (tag.includes("#")) {
			let fields = fieldsOf(value, at)

			// NOTE: WHICH Case a value is is part of the value, so the tag is
			// written last and wins the collision. A payload member actually
			// named `$case` would be dropped by that, and dropping one silently
			// is the single thing a lossless boundary may not do — so it is
			// refused instead of quietly lost.
			if ("$case" in fields) {
				throw collidingCase(at)
			}

			return { ...fields, $case: caseName(tag) }
		}

		// NOTE: A value that IS this Module's and still has no mapping — the
		// numeric tower above Rational, for now. Saying so beats telling its
		// owner it came from somewhere else, which is what the wording below
		// would have claimed.
		throw new EssenceMarshalError(
			`${spell(at)}: ${tag} values can not be marshalled yet.`,
			spell(at),
		)
	}

	// NOTE: Read through the bridge's key like every other tag, so a value from
	// another bundle is not mistaken for one of this Module's Optionals.
	function isOptionalValue(value: unknown): boolean {
		if (value === null || typeof value !== "object") {
			return false
		}

		let tag = (value as Record<symbol, unknown>)[bridge.typeKey]

		return tag === "Optional#Value" || tag === "Optional#Empty"
	}

	function fieldsOf(value: object, at: Path): Record<string, unknown> {
		let fields: Record<string, unknown> = {}

		// NOTE: Own, enumerable and string-keyed, which is exactly the members —
		// the Type key is a Symbol, and is skipped here by the same rule that
		// makes it hidden inside Essence.
		for (let [name, field] of Object.entries(value)) {
			fields[name] = toJS(field, member(at, name))
		}

		return fields
	}

	// #endregion

	// #region In

	function fromJS(
		value: unknown,
		expected: common.Type,
		at: Path,
	): EssenceValue {
		switch (expected.type) {
			case "Integer": {
				if (typeof value === "bigint") {
					return bridge.integer(value)
				}

				// NOTE: A number is admitted only where it is exactly an integer
				// a double can hold — `2 ** 53` is not one, and taking it would
				// hand the Module a value already off by whatever the double had
				// lost before it ever arrived.
				if (typeof value === "number" && Number.isSafeInteger(value)) {
					return bridge.integer(BigInt(value))
				}

				throw mismatch(value, expected, at)
			}
			case "Rational": {
				if (value instanceof EssenceRational) {
					return bridge.rational(value.numerator, value.denominator)
				}

				if (typeof value === "bigint") {
					return bridge.rational(value, 1n)
				}

				if (typeof value === "number" && Number.isFinite(value)) {
					let exact = EssenceRational.fromNumber(value)

					return bridge.rational(exact.numerator, exact.denominator)
				}

				throw mismatch(value, expected, at)
			}
			case "String": {
				if (typeof value !== "string") {
					throw mismatch(value, expected, at)
				}

				// NOTE: Normalised on the way in, because String equality in
				// Essence is normalised — a composed `é` and a decomposed one
				// are one value there — and letting both spellings through would
				// put two values into the Module that it insists are the same.
				return bridge.string(value.normalize("NFC"))
			}
			case "Boolean": {
				if (typeof value !== "boolean") {
					throw mismatch(value, expected, at)
				}

				return bridge.boolean(value)
			}
			case "List": {
				if (!Array.isArray(value)) {
					throw mismatch(value, expected, at)
				}

				return bridge.list(
					value.map((item, position) =>
						fromJS(item, expected.itemType, index(at, position)),
					),
				)
			}
			case "Record": {
				let given = plainObject(value)

				if (given === null) {
					throw mismatch(value, expected, at)
				}

				let fields: Record<string, EssenceValue> = {}

				// NOTE: An absent key IS a value here — `undefined`, which is
				// exactly what an `Optional` member is spelled as — so what the
				// key holds is read and the member's own Type decides. Refusing
				// absence up front reported "expected Optional<String>, got
				// nothing" for a Type whose whole point is that it accepts
				// nothing, and made a Record that had been through JSON — which
				// drops an `undefined`-valued key — impossible to hand back. A
				// member that is not Optional still fails, with the same
				// sentence, where the sentence is true.
				for (let [name, memberType] of Object.entries(
					expected.members,
				)) {
					fields[name] = fromJS(
						given[name],
						memberType,
						member(at, name),
					)
				}

				// NOTE: Closed, unlike the Matcher a `case` narrows with. A key
				// the Type does not name is a mistake in the making — a
				// misspelled member, or a value from somewhere else entirely —
				// and taking it silently drops it, which is how a `widht` gets
				// as far as production.
				let undeclared = Object.keys(given).filter(
					(name) => !Object.hasOwn(expected.members, name),
				)

				if (undeclared.length > 0) {
					throw undeclaredMembers(expected, undeclared, at)
				}

				return bridge.record(fields)
			}
			case "Case":
				return caseFromJS(value, expected, at)
			case "UnionType": {
				// NOTE: Before any arm is tried, because a nested Optional is
				// refused rather than answered and an arm's refusal is something
				// the next arm gets to overrule. `Optional<Optional<Integer>>`
				// reaches here as the Union of its two Cases, and `#Empty` would
				// take the `undefined` that `#Value` had just refused — turning
				// a Type with no JavaScript spelling into a confident wrong
				// answer.
				let item = optionalItemOf(expected)

				if (item !== null && admitsAbsence(item)) {
					throw nestedOptional(at)
				}

				// NOTE: In declaration order, and the first arm that admits the
				// value is the one it becomes. Overlapping arms are therefore
				// DECIDED rather than ambiguous: `Optional<String> | Integer`
				// makes a String out of `"7"` because `Optional<String>` is
				// written first, not because anything weighed the two.
				let refused: Array<EssenceMarshalError> = []

				for (let arm of expected.types) {
					try {
						return fromJS(value, arm, at)
					} catch (thrown) {
						if (!(thrown instanceof EssenceMarshalError)) {
							throw thrown
						}

						refused.push(thrown)
					}
				}

				// NOTE: An arm that got INSIDE the value before refusing it is an
				// arm the value was plainly meant for — `Optional<Box>` handed a
				// Box with a String `height` fails at `.height`, where `#Empty`
				// fails at the value itself. Where exactly one arm reached that
				// far, its Error is the useful one, and answering with the Union
				// instead would throw away the only sentence that says what is
				// actually wrong. Where two did, the value fits none of them
				// clearly and naming the Union is the honest answer.
				//
				// NOTE: A deeper path is the usual sign of that, and not the only
				// one: a Case whose `$case` named this arm and whose PAYLOAD is
				// then wrong refuses the value itself, at this very path, and says
				// so — so it marks itself instead. Without that, every misspelled
				// payload member of every Choice reads as "expected Shape", while
				// the same mistake in a Record names the member.
				let reached = refused.filter(
					(failure) => failure.inside || failure.path !== spell(at),
				)

				if (reached.length === 1) {
					throw reached[0]
				}

				throw mismatch(value, expected, at)
			}
			// TODO: A checked refinement's predicate is NOT checked here — the
			// value is built against the base Type and handed over unproven. The
			// refinement work lives on a branch of its own; when it lands this is
			// where the predicate has to run, because a host is exactly the place
			// a value the Compiler never saw comes from.
			case "Refinement":
				return fromJS(value, expected.base, at)
			// NOTE: An APPLIED Alias is already substituted by the time it
			// reaches an Export Surface — `Pair<Integer>` arrives as the Record
			// it aliases, and `Optional<Integer>` as the Union of its two Cases —
			// so what is left to meet here is the unapplied form, whose body
			// still mentions its own Type Parameters. Recursing into it lands on
			// a `GenericUse` and says so.
			case "GenericAlias":
				return fromJS(value, expected.aliasedType, at)
			case "GenericUse":
				throw new EssenceMarshalError(
					`${spell(at)}: ${printType(
						expected,
					)} is a Type Parameter — there is no shape to build a value against until it is applied.`,
					spell(at),
				)
			case "Function":
			case "SimpleMethod":
			case "StaticMethod":
			case "OverloadedMethod":
			case "OverloadedStaticMethod":
			case "Namespace":
				throw new EssenceMarshalError(
					`${spell(at)}: callbacks are not supported yet — ${printType(
						expected,
					)} can not be built from a JavaScript value.`,
					spell(at),
				)
			default:
				throw new EssenceMarshalError(
					`${spell(at)}: ${printType(
						expected,
					)} can not be marshalled yet.`,
					spell(at),
				)
		}
	}

	function caseFromJS(
		value: unknown,
		expected: common.CaseType,
		at: Path,
	): EssenceValue {
		let tag = `${emittedIdentity(options.entryPath, expected.choice)}#${
			expected.name
		}`

		// NOTE: `Optional` is spelled by its ABSENCE on this side — `T |
		// undefined` — so its two Cases read the value itself rather than a
		// `$case` on it. A Union tries `#Value` before `#Empty`, so `undefined`
		// falls through the first (nothing is a `T`) into the second, and
		// everything else is wrapped. `null` is admitted beside `undefined`
		// because JSON has only the one of them; `undefined` is what comes back.
		if (expected.choice === "Optional") {
			if (expected.name === "Empty") {
				if (value !== undefined && value !== null) {
					throw mismatch(value, expected, at)
				}

				return bridge.case(tag)
			}

			let item = expected.members.item

			if (item === undefined) {
				throw mismatch(value, expected, at)
			}

			// NOTE: The same refusal the Union above makes, for the Case reached
			// on its own — `#Value(#Empty)` is not `#Empty`, and both are
			// `undefined` here.
			if (admitsAbsence(item)) {
				throw nestedOptional(at)
			}

			if (value === undefined || value === null) {
				throw mismatch(value, expected, at)
			}

			return bridge.case(tag, { item: fromJS(value, item, at) })
		}

		let given = plainObject(value)

		if (given === null || !admitsCase(given.$case, expected)) {
			throw mismatch(value, expected, at)
		}

		// NOTE: The refusal `toJS` makes for the same Case, made here too. The
		// tag is written under `$case`, so a payload member of that name has
		// nowhere to sit: read it and the tag string becomes the member's value,
		// silently, and there is no way to pass any other. Coming out it is
		// refused; going in it has to be refused, or the boundary accepts a
		// value it can not then describe.
		if (Object.hasOwn(expected.members, "$case")) {
			throw collidingCase(at, true)
		}

		let members = Object.entries(expected.members)
		let undeclared = Object.keys(given).filter(
			(name) =>
				name !== "$case" && !Object.hasOwn(expected.members, name),
		)

		if (undeclared.length > 0) {
			throw undeclaredMembers(expected, undeclared, at, true)
		}

		if (members.length === 0) {
			// NOTE: No payload at all rather than an empty one — `createCase`
			// hands out one shared instance per unit Case tag, and passing `{}`
			// would build a fresh object each time that the Module's own
			// `#Blank` is not.
			return bridge.case(tag)
		}

		let payload: Record<string, EssenceValue> = {}

		// NOTE: An absent key is read as `undefined` and the member's Type
		// decides, for the reason the Record branch above states.
		for (let [name, memberType] of members) {
			payload[name] = fromJS(given[name], memberType, member(at, name))
		}

		return bridge.case(tag, payload)
	}

	// #endregion

	// #region Errors

	function mismatch(
		value: unknown,
		expected: common.Type,
		at: Path,
	): EssenceMarshalError {
		return new EssenceMarshalError(
			`${spell(at)}: expected ${printType(expected)}, got ${describe(
				value,
			)}.`,
			spell(at),
		)
	}

	function undeclaredMembers(
		expected: common.Type,
		names: Array<string>,
		at: Path,
		inside = false,
	): EssenceMarshalError {
		return new EssenceMarshalError(
			`${spell(at)}: expected ${printType(expected)}, got an object with ${
				names.length === 1 ? "a member" : "members"
			} it does not declare — ${quoted(names)}.`,
			spell(at),
			inside,
		)
	}

	// NOTE: The one shape `Optional<T> ↔ T | undefined` can not describe, in
	// both directions, worded the same way. `null` is no help — JSON turns an
	// `undefined` into one, so it is the same absence wearing another name — and
	// there is no third spelling of nothing to spend on the second level.
	function nestedOptional(at: Path): EssenceMarshalError {
		return new EssenceMarshalError(
			`${spell(
				at,
			)}: an Optional inside an Optional has no JavaScript spelling — both levels would be 'undefined', and '#Value(#Empty)' is not '#Empty'.`,
			spell(at),
		)
	}

	function collidingCase(at: Path, inside = false): EssenceMarshalError {
		return new EssenceMarshalError(
			`${spell(
				at,
			)}: this Case can not be marshalled — its payload declares a member named '$case', which is the name the Case tag is carried under.`,
			spell(at),
			inside,
		)
	}

	function foreignValue(value: unknown, at: Path): EssenceMarshalError {
		return new EssenceMarshalError(
			`${spell(at)}: this value did not come from this Module — ${describe(
				value,
			)}.`,
			spell(at),
		)
	}

	// NOTE: What the value IS, in one clause, for the second half of an Error.
	// Never the value itself past a bounded length: what is being described is a
	// value a host got wrong, which is exactly the sort that turns out to be a
	// megabyte of JSON.
	function describe(value: unknown): string {
		if (value === undefined) {
			return "nothing"
		}

		if (value === null) {
			return "null"
		}

		if (value instanceof EssenceRational) {
			return `the Rational ${value.toString()}`
		}

		if (Array.isArray(value)) {
			return value.length === 0
				? "an empty array"
				: `an array of ${value.length} item${
						value.length === 1 ? "" : "s"
					}`
		}

		switch (typeof value) {
			case "string":
				return `the string ${JSON.stringify(shortened(value))}`
			case "number":
			case "bigint":
				return `the ${typeof value} ${value}`
			case "boolean":
				return `the boolean ${value}`
			case "symbol":
				return "a symbol"
			case "function":
				return "a function"
		}

		// NOTE: An Essence value, named by its own tag — read through the
		// bridge's key like every other tag, so a value from ANOTHER bundle is
		// described as the plain object it is from here rather than misreported
		// as one of this Module's.
		let tag = (value as Record<symbol, unknown>)[bridge.typeKey]

		if (typeof tag === "string") {
			return `an Essence ${tag} value`
		}

		let keys = Object.keys(value)

		return keys.length === 0
			? "an empty object"
			: `an object with ${quoted(keys)}`
	}

	// #endregion

	// #region Wording

	// NOTE: Bounded, for the reason the note above `describe` gives: the object
	// being described is one a host got wrong, and a parsed JSON document with a
	// thousand keys is exactly that. The first few name the mistake as well as
	// all of them would.
	function quoted(names: Array<string>): string {
		let shown = names
			.slice(0, NAMES_SHOWN)
			.map((name) => `'${name}'`)
			.join(", ")

		return names.length <= NAMES_SHOWN
			? shown
			: `${shown} and ${names.length - NAMES_SHOWN} more`
	}

	// #endregion

	return {
		toJS: (value, path = "value") => toJS(value, { root: path, trail: "" }),
		fromJS: (value, expected, path = "value") =>
			fromJS(value, expected, { root: path, trail: "" }),
	}
}

// NOTE: The spelling a Case is known by on this side — the Choice as it was
// DECLARED and the Case, with the Module path a bundle qualifies its tags with
// taken back off. `./Geometry.es#Shape#Circle` is `Shape#Circle` here: a host
// writes what it reads in the Essence source, and never where the file happened
// to sit on the machine that compiled it.
function caseName(tag: string): string {
	let separator = tag.lastIndexOf("#")

	return `${displayChoiceName(tag.slice(0, separator))}#${tag.slice(
		separator + 1,
	)}`
}

// NOTE: What an `Optional` holds, or `null` where the Type is not one. A
// `Optional<T>` reaches a Surface as the Union of its two Cases, so the question
// is asked of the Union: the `#Value` arm's `item` is the answer.
function optionalItemOf(type: common.Type): common.Type | null {
	switch (type.type) {
		case "Case":
			return type.choice === "Optional" && type.name === "Value"
				? (type.members.item ?? null)
				: null
		case "UnionType": {
			for (let arm of type.types) {
				let item = optionalItemOf(arm)

				if (item !== null) {
					return item
				}
			}

			return null
		}
		case "Refinement":
			return optionalItemOf(type.base)
		case "GenericAlias":
			return optionalItemOf(type.aliasedType)
		default:
			return null
	}
}

// NOTE: Whether `undefined` is a value of this Type — which is exactly whether
// an `Optional`'s `#Empty` is reachable in it. What it decides here is whether
// an `Optional` is about to be put inside another one, and both levels spelled
// as nothing.
function admitsAbsence(type: common.Type): boolean {
	switch (type.type) {
		case "Case":
			return type.choice === "Optional" && type.name === "Empty"
		case "UnionType":
			return type.types.some(admitsAbsence)
		case "Refinement":
			return admitsAbsence(type.base)
		case "GenericAlias":
			return admitsAbsence(type.aliasedType)
		default:
			return false
	}
}

// NOTE: Either spelling of the same Case. `Shape#Circle` is what `toJS` writes,
// and so what a round trip hands back; the bare `Circle` is what the Essence
// source itself writes, where a `#Circle` needs no Choice in front of it.
function admitsCase(tag: unknown, expected: common.CaseType): boolean {
	if (typeof tag !== "string") {
		return false
	}

	return (
		tag === expected.name ||
		tag === `${displayChoiceName(expected.choice)}#${expected.name}`
	)
}

// NOTE: A JavaScript object with members, and nothing that merely is one: an
// Array is a List's shape and an `EssenceRational` is a Rational's, so admitting
// either as a Record would make the Type that named it unreachable.
//
// NOTE: Exported because a labelled call asks the very same question of its one
// Argument — an `EssenceRational` passed to a Function whose labels happen to be
// `numerator` and `denominator` is a Rational, not a labelled call — and two
// spellings of one rule is exactly how the two would come to disagree.
export function plainObject(value: unknown): Record<string, unknown> | null {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		value instanceof EssenceRational
	) {
		return null
	}

	return value as Record<string, unknown>
}

function shortened(value: string): string {
	return value.length > 32 ? `${value.slice(0, 32)}…` : value
}
