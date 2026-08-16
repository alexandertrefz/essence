import type { EssenceValue, RuntimeBridge } from "./bridge"
import type {
	CaseDescriptor,
	Descriptor,
	FunctionDescriptor,
	ModuleDescriptor,
	NamespaceDescriptor,
	OverloadDescriptor,
} from "./descriptor"
import { EssenceCallError, EssenceMarshalError } from "./errors"
import { EssenceRational } from "./rational"

// NOTE: The RUN-TIME half of the boundary — every conversion, every refusal and
// every call, over Descriptors rather than over Types. It knows nothing about the
// Compiler and can not be made to: the two imports above that reach a file the
// Compiler is in are `import type`, which is erased before anything runs, and
// `descriptor.spec.ts` reads this file back to say so. That is the whole of what
// "one marshaller" costs — a boundary that ships to a browser has to be a
// boundary that does not bring a Compiler with it, and there is exactly one of
// them either way.
//
// NOTE: The two directions across the boundary, and they are not mirror images.
//
// Coming OUT, a value says what it is: every Essence value but a Function carries
// its Type on the bundle's own hidden key, so `toJS` reads the tag and answers.
// The exception is the one untagged value: a Function says nothing, so the
// Descriptor its position DECLARED travels beside it — through the members of a
// Record and the items of a List — and where that Descriptor names exactly one
// signature, the Function crosses as a callable that marshals around its calls
// rather than as the raw emitted one.
//
// Going IN, a JavaScript value says nothing. `7` could be an Integer, a Rational,
// an `Optional<Integer>` or one arm of a Union, and which of them it has to become
// is decided by what the Module DECLARED — so `fromJS` walks the Descriptor and
// builds against it. That is what makes the boundary lossless in both directions
// rather than merely plausible.
//
// NOTE: Nothing here guesses at the runtime. The Symbol every tag is read through
// and every constructor a value is built by come out of the BUNDLE, through the
// bridge — a value built any other way carries a Symbol the Module has never seen,
// and every Method it reaches would find it untyped.
//
// NOTE: A value `fromJS` builds is admitted by the Descriptor it was built against
// BY CONSTRUCTION — each member is built against the member's own Descriptor and
// each arm of a Union is the arm that took the value — so the runtime's own
// `isValueOfType` is not asked afterwards. Asking would mean handing it a Type
// descriptor whose Case identities are the canonical paths of the machine that
// compiled, while the values' tags are entry-relative; rendering a whole
// descriptor tree to match would be a SECOND copy of the rule `emittedIdentity`
// states, and a second copy is the only way the two could ever disagree. What is
// worth checking is checked where the value is built.

// NOTE: The two tags the runtime's own `Optional` carries. Every other Choice
// belongs to a Module, and a Module's tags are spelled relative to the entry —
// which is why a Descriptor bakes those and not these. `Optional` is declared
// where no Module path can qualify it, so its two Cases are spelled the same in
// every bundle there will ever be.
const OPTIONAL_VALUE = "Optional#Value"
const OPTIONAL_EMPTY = "Optional#Empty"

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

export type EssenceFunction = (...args: Array<EssenceValue>) => EssenceValue

export type Interpreter = {
	// NOTE: An Essence value out, as the JavaScript it maps to. The optional name
	// is what an Error calls the value, and everything below it is spelled
	// relative to that; the optional Descriptor is for the one value that carries
	// none of its own.
	toJS: (value: unknown, path?: string, expected?: Descriptor) => unknown
	// NOTE: A JavaScript value in, as the shape it is being handed to.
	fromJS: (
		value: unknown,
		expected: Descriptor,
		path?: string,
	) => EssenceValue
	// NOTE: One Essence Function as a JavaScript one: Arguments marshalled
	// against the Parameters the Module declared, the call made positionally —
	// which is how every Essence call is emitted, labels and all — and the answer
	// marshalled back.
	wrapFunction: (
		target: EssenceFunction,
		signature: FunctionDescriptor,
		name: string,
	) => (...args: Array<unknown>) => unknown
}

// NOTE: A List box as the runtime lays one out, and the only place this package
// knows that layout. `packages/runtime/src/List.ts` is the authority: a List is
// TWO runs and a view into each — the back run stored forward in `value`, the
// front run stored REVERSED in `front` — because the runs are SHARED between the
// boxes of one chain, and what tells those boxes apart is how much of each run
// each one says is its own. So `length` absent means the back view is the whole
// Array, `front` absent means the box never prepended, and reading `value` on its
// own answers neither the right items nor the right number of them.
//
// NOTE: Read, never written back. The runtime's own `materialise` combines the
// two runs and leaves the result ON the box, because the natives will read that
// box again; marshalling reads it once and hands JavaScript an Array of its own,
// so there is nothing here worth caching and no reason for this side of the
// boundary to write into a bundle's values at all. It also may not hand the
// combined Array over — that Array is the box's, and a host that pushed onto it
// would be editing a value the Module still holds.
type ListBox = {
	value: Array<unknown>
	length?: number
	front?: Array<unknown>
	frontLen?: number
}

export function createInterpreter(bridge: RuntimeBridge): Interpreter {
	// #region Out

	function toJS(
		value: unknown,
		at: Path,
		expected: Descriptor | null,
	): unknown {
		// NOTE: The one untagged Essence value — a Function is emitted as a bare
		// JavaScript function, and a Namespace as a class, which is one too. So
		// only what its position declared can say what a call to one means: where
		// that names exactly one signature the Function is wrapped, so a caller
		// calls it as the declaration reads, and where it names none — a direct
		// `toJS` with nothing declared, a Namespace — the value passes through as
		// it is.
		if (typeof value === "function") {
			let signatures = callableSignatures(expected)

			if (signatures.length === 1) {
				return wrapFunction(
					value as EssenceFunction,
					signatures[0]!,
					spell(at),
				)
			}

			// NOTE: A Union of two signatures says two things a call could mean,
			// and an untagged value can not say which — refused rather than
			// wrapped as whichever was written first and misdispatched.
			if (signatures.length > 1) {
				throw undecidableSignature(expected!.shown, at)
			}

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
			// NOTE: ALWAYS a bigint on the way out, whichever of its two
			// representations the Integer arrived in. An Integer holds a
			// JavaScript number while its value fits one and a bigint beyond that,
			// and handing that split across the boundary would make the TYPE of
			// what an embedding receives depend on the SIZE of the answer:
			// `total` would be a number until the day it crossed 2⁵³ and every `+`
			// on it started throwing. One kind out is the contract, and bigint is
			// the one that can carry every Integer.
			case "Integer":
				return BigInt((value as { value: number | bigint }).value)
			case "Rational": {
				let parts = value as { numerator: bigint; denominator: bigint }

				return new EssenceRational(parts.numerator, parts.denominator)
			}
			case "String":
				return (value as { value: string }).value
			case "Boolean":
				return (value as { value: boolean }).value
			case "List":
				return itemsOf(value, at, listItemOf(expected))
			case "Record":
				return fieldsOf(value, at, recordMembersOf(expected))
			// NOTE: An Optional is transparent — `Optional<T>` IS `T | undefined`
			// on this side — so the Case does not appear in the answer, and the
			// path gains no segment for it either. A host reading `.item` off what
			// came back would be reading the Module's bookkeeping rather than its
			// value.
			case OPTIONAL_VALUE: {
				let item = (value as { item: unknown }).item

				// NOTE: Absence does not nest. `#Value(#Empty)` and `#Empty` would
				// both be `undefined` here, and Essence is explicit that they are
				// two values — so the pair is refused rather than collapsed into
				// the one of them a round trip would hand back.
				if (isOptionalValue(item)) {
					throw nestedOptional(at)
				}

				return toJS(
					item,
					at,
					expected === null ? null : optionalItemOf(expected),
				)
			}
			case OPTIONAL_EMPTY:
				return undefined
		}

		if (tag.includes("#")) {
			let fields = fieldsOf(value, at, caseMembersOf(expected, tag))

			// NOTE: WHICH Case a value is is part of the value, so the tag is
			// written last and wins the collision. A payload member actually named
			// `$case` would be dropped by that, and dropping one silently is the
			// single thing a lossless boundary may not do — so it is refused
			// instead of quietly lost.
			if ("$case" in fields) {
				throw collidingCase(at)
			}

			return { ...fields, $case: caseName(tag) }
		}

		// NOTE: A value that IS this Module's and still has no mapping — the
		// numeric tower above Rational, for now. Saying so beats telling its owner
		// it came from somewhere else, which is what the wording below would have
		// claimed.
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

		return tag === OPTIONAL_VALUE || tag === OPTIONAL_EMPTY
	}

	// NOTE: The items a List holds, in the order it holds them — the front run
	// backwards, then the back run — each marshalled against what its position
	// declared, into an Array of this side's own.
	//
	// NOTE: The counts are fixed before the first item crosses, which is the rule
	// the runtime's natives are written under as well: a run Array is shared, and
	// nothing may read its `length` again once a walk has started. Nothing here
	// can grow one — `toJS` only reads — but a walk that asked twice would still
	// be a walk that could be made to disagree with itself, and the one idiom is
	// worth more than the branch it saves.
	function itemsOf(
		value: object,
		at: Path,
		itemType: Descriptor | null,
	): Array<unknown> {
		let list = value as ListBox
		let back = list.value
		let backCount = list.length ?? back.length
		let front = list.front
		let frontCount =
			front === undefined ? 0 : (list.frontLen ?? front.length)
		let total = frontCount + backCount
		let items: Array<unknown> = []

		for (let position = 0; position < total; position++) {
			let item =
				position < frontCount
					? front![frontCount - 1 - position]
					: back[position - frontCount]

			items.push(toJS(item, index(at, position), itemType))
		}

		return items
	}

	function fieldsOf(
		value: object,
		at: Path,
		members: Record<string, Descriptor> | null,
	): Record<string, unknown> {
		let fields: Record<string, unknown> = {}

		// NOTE: Own, enumerable and string-keyed, which is exactly the members —
		// the Type key is a Symbol, and is skipped here by the same rule that
		// makes it hidden inside Essence.
		for (let [name, field] of Object.entries(value)) {
			fields[name] = toJS(
				field,
				member(at, name),
				members !== null && Object.hasOwn(members, name)
					? members[name]!
					: null,
			)
		}

		return fields
	}

	// #endregion

	// #region Calls

	// NOTE: Everything a caller can get wrong before the first Argument is even
	// looked at is an `EssenceCallError`; everything about a value is an
	// `EssenceMarshalError`. The two are told apart because they are fixed in
	// different places.
	//
	// NOTE: The answer is marshalled back through `toJS` WITH the declared return
	// Descriptor, so a Function a call answers with comes back callable too.
	function wrapFunction(
		target: EssenceFunction,
		signature: FunctionDescriptor,
		name: string,
	): (...args: Array<unknown>) => unknown {
		let parameters = signature.parameters
		let labels = labelsOf(signature)

		return (...args: Array<unknown>): unknown => {
			let call = readCall(args, signature, labels, name)
			let marshalled = call.ordered.map((argument, position) =>
				fromJS(argument, parameters[position]!.of, {
					root: argumentPath(
						parameters[position]!.label,
						position,
						call.labelled,
					),
					trail: "",
				}),
			)

			return toJS(
				target(...marshalled),
				{ root: "return value", trail: "" },
				signature.returns,
			)
		}
	}

	// #endregion

	// #region In

	function fromJS(
		value: unknown,
		expected: Descriptor,
		at: Path,
	): EssenceValue {
		switch (expected.kind) {
			case "integer": {
				// NOTE: Both kinds go in AS THEY ARE — the bridge's
				// `createInteger` canonicalises, so a bigint that fits a double
				// arrives as a number and a number that does not arrives as a
				// bigint, and neither caller has to know which side of 2⁵³ its
				// value sits.
				if (typeof value === "bigint") {
					return bridge.integer(value)
				}

				// NOTE: A number is admitted only where it is exactly an integer a
				// double can hold — `2 ** 53` is not one, and taking it would hand
				// the Module a value already off by whatever the double had lost
				// before it ever arrived.
				if (typeof value === "number" && Number.isSafeInteger(value)) {
					return bridge.integer(value)
				}

				throw mismatch(value, expected.shown, at)
			}
			case "rational": {
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

				throw mismatch(value, expected.shown, at)
			}
			case "string": {
				if (typeof value !== "string") {
					throw mismatch(value, expected.shown, at)
				}

				// NOTE: Normalised on the way in, because String equality in
				// Essence is normalised — a composed `é` and a decomposed one are
				// one value there — and letting both spellings through would put
				// two values into the Module that it insists are the same.
				return bridge.string(value.normalize("NFC"))
			}
			case "boolean": {
				if (typeof value !== "boolean") {
					throw mismatch(value, expected.shown, at)
				}

				return bridge.boolean(value)
			}
			case "list": {
				if (!Array.isArray(value)) {
					throw mismatch(value, expected.shown, at)
				}

				// NOTE: `bridge.list` copies what it is handed, so the Array `map`
				// builds here is copied once more before a List holds it. The
				// alternative was to bridge the runtime's own `createList`, which
				// takes ownership — and then this call would be safe while a
				// host's identical-looking one, on an Array the host kept, would
				// silently share a run with Essence.
				return bridge.list(
					value.map((item, position) =>
						fromJS(item, expected.of, index(at, position)),
					),
				)
			}
			case "record": {
				let given = plainObject(value)

				if (given === null) {
					throw mismatch(value, expected.shown, at)
				}

				let fields: Record<string, EssenceValue> = {}

				// NOTE: An absent key IS a value here — `undefined`, which is
				// exactly what an `Optional` member is spelled as — so what the key
				// holds is read and the member's own shape decides. Refusing
				// absence up front reported "expected Optional<String>, got
				// nothing" for a Type whose whole point is that it accepts nothing,
				// and made a Record that had been through JSON — which drops an
				// `undefined`-valued key — impossible to hand back. A member that
				// is not Optional still fails, with the same sentence, where the
				// sentence is true.
				//
				// NOTE: An OWN key, because an absent `toString` read plainly finds
				// `Object.prototype`'s — a function where the rule above promises
				// `undefined`.
				for (let [name, memberType] of Object.entries(
					expected.members,
				)) {
					fields[name] = fromJS(
						Object.hasOwn(given, name) ? given[name] : undefined,
						memberType,
						member(at, name),
					)
				}

				// NOTE: Closed, unlike the Matcher a `case` narrows with. A key the
				// Type does not name is a mistake in the making — a misspelled
				// member, or a value from somewhere else entirely — and taking it
				// silently drops it, which is how a `widht` gets as far as
				// production.
				let undeclared = Object.keys(given).filter(
					(name) => !Object.hasOwn(expected.members, name),
				)

				if (undeclared.length > 0) {
					throw undeclaredMembers(expected.shown, undeclared, at)
				}

				return bridge.record(fields)
			}
			case "optional":
				return optionalFromJS(value, expected.of, expected.shown, at)
			case "case":
				return caseFromJS(value, expected, at)
			case "union": {
				// NOTE: Before any arm is tried, because a nested Optional is
				// refused rather than answered and an arm's refusal is something
				// the next arm gets to overrule. A Union that offers an `Optional`
				// among its arms would otherwise let a later arm take the
				// `undefined` an earlier one had just refused — turning a shape
				// with no JavaScript spelling into a confident wrong answer.
				let item = optionalItemOf(expected)

				if (item !== null && admitsAbsence(item)) {
					throw nestedOptional(at)
				}

				// NOTE: In declaration order, and the first arm that admits the
				// value is the one it becomes. Overlapping arms are therefore
				// DECIDED rather than ambiguous: `Optional<String> | Integer` makes
				// a String out of `"7"` because `Optional<String>` is written
				// first, not because anything weighed the two.
				let refused: Array<EssenceMarshalError> = []

				for (let arm of expected.arms) {
					try {
						return fromJS(value, arm, at)
					} catch (thrown) {
						if (!(thrown instanceof EssenceMarshalError)) {
							throw thrown
						}

						refused.push(thrown)
					}
				}

				let reached = refused.filter((failure) =>
					reachedInside(failure, at),
				)

				if (reached.length === 1) {
					throw reached[0]
				}

				throw mismatch(value, expected.shown, at)
			}
			case "function":
				throw new EssenceMarshalError(
					`${spell(at)}: callbacks are not supported yet — ${
						expected.shown
					} can not be built from a JavaScript value.`,
					spell(at),
				)
			// NOTE: Everything the boundary has no mapping for, refused in the
			// words the Compiler wrote when it still had the Type to name.
			case "refused":
				throw new EssenceMarshalError(
					`${spell(at)}: ${expected.why}`,
					spell(at),
				)
		}
	}

	// NOTE: `Optional` is spelled by its ABSENCE on this side — `T | undefined` —
	// so it reads the value itself rather than a `$case` on it. `null` is admitted
	// beside `undefined` because JSON has only the one of them; `undefined` is
	// what comes back.
	//
	// NOTE: This is the Union of `#Value` and `#Empty` with its two arms run
	// through: absence is the `#Empty` arm, anything else is the `#Value` arm, and
	// a refusal that got INSIDE the value is the one the Union would have kept —
	// `#Empty` never reaches inside anything, so it can never be that one.
	function optionalFromJS(
		value: unknown,
		item: Descriptor,
		shown: string,
		at: Path,
	): EssenceValue {
		// NOTE: The refusal `toJS` makes for the same pair, made here too:
		// `#Value(#Empty)` and `#Empty` would both be `undefined`, and Essence is
		// explicit that they are two values.
		if (admitsAbsence(item)) {
			throw nestedOptional(at)
		}

		if (value === undefined || value === null) {
			return bridge.case(OPTIONAL_EMPTY)
		}

		try {
			return bridge.case(OPTIONAL_VALUE, {
				item: fromJS(value, item, at),
			})
		} catch (thrown) {
			if (!(thrown instanceof EssenceMarshalError)) {
				throw thrown
			}

			if (reachedInside(thrown, at)) {
				throw thrown
			}

			throw mismatch(value, shown, at)
		}
	}

	function caseFromJS(
		value: unknown,
		expected: CaseDescriptor,
		at: Path,
	): EssenceValue {
		// NOTE: One of `Optional`'s own Cases, met without the other — which is
		// what `constant thing = #Value(3)` infers, a Case rather than the Union
		// an annotation would have named. The pair is collapsed into an `optional`
		// before it ever reaches here, so this is the lone arm, read by the rule
		// the pair is read by.
		if (expected.optional) {
			if (expected.name === "Empty") {
				if (value !== undefined && value !== null) {
					throw mismatch(value, expected.shown, at)
				}

				return bridge.case(expected.tag)
			}

			let item = expected.payload.item

			if (item === undefined) {
				throw mismatch(value, expected.shown, at)
			}

			if (admitsAbsence(item)) {
				throw nestedOptional(at)
			}

			if (value === undefined || value === null) {
				throw mismatch(value, expected.shown, at)
			}

			return bridge.case(expected.tag, { item: fromJS(value, item, at) })
		}

		let given = plainObject(value)

		if (given === null || !admitsCase(given.$case, expected)) {
			throw mismatch(value, expected.shown, at)
		}

		// NOTE: The refusal `toJS` makes for the same Case, made here too. The tag
		// is written under `$case`, so a payload member of that name has nowhere
		// to sit: read it and the tag string becomes the member's value, silently,
		// and there is no way to pass any other. Coming out it is refused; going
		// in it has to be refused, or the boundary accepts a value it can not then
		// describe.
		if (Object.hasOwn(expected.payload, "$case")) {
			throw collidingCase(at, true)
		}

		let members = Object.entries(expected.payload)
		let undeclared = Object.keys(given).filter(
			(name) =>
				name !== "$case" && !Object.hasOwn(expected.payload, name),
		)

		if (undeclared.length > 0) {
			throw undeclaredMembers(expected.shown, undeclared, at, true)
		}

		if (members.length === 0) {
			// NOTE: No payload at all rather than an empty one — `createCase`
			// hands out one shared instance per unit Case tag, and passing `{}`
			// would build a fresh object each time that the Module's own `#Blank`
			// is not.
			return bridge.case(expected.tag)
		}

		let payload: Record<string, EssenceValue> = {}

		// NOTE: An absent key is read as `undefined` — through an OWN-key check,
		// past what `Object.prototype` holds — and the member's own shape decides,
		// for the reasons the Record branch above states.
		for (let [name, memberType] of members) {
			payload[name] = fromJS(
				Object.hasOwn(given, name) ? given[name] : undefined,
				memberType,
				member(at, name),
			)
		}

		return bridge.case(expected.tag, payload)
	}

	// #endregion

	// #region Errors

	// NOTE: Whether a refusal got INSIDE the value before making it — a Case whose
	// `$case` named this arm and whose payload was then wrong, rather than an arm
	// that never took the value at all. `Optional<Box>` handed a Box with a String
	// `height` fails at `.height`, where `#Empty` fails at the value itself. Where
	// exactly one arm of a Union got that far, its Error is the useful one, and
	// answering with the Union instead would throw away the only sentence that
	// says what is actually wrong.
	//
	// NOTE: A deeper path is the usual sign of that, and not the only one: a Case
	// whose `$case` matched and whose PAYLOAD is then wrong refuses the value
	// itself, at this very path, and says so — so it marks itself instead. Without
	// that, every misspelled payload member of every Choice reads as "expected
	// Shape", while the same mistake in a Record names the member.
	function reachedInside(failure: EssenceMarshalError, at: Path): boolean {
		return failure.inside || failure.path !== spell(at)
	}

	function mismatch(
		value: unknown,
		shown: string,
		at: Path,
	): EssenceMarshalError {
		return new EssenceMarshalError(
			`${spell(at)}: expected ${shown}, got ${describe(value)}.`,
			spell(at),
		)
	}

	function undeclaredMembers(
		shown: string,
		names: Array<string>,
		at: Path,
		inside = false,
	): EssenceMarshalError {
		return new EssenceMarshalError(
			`${spell(at)}: expected ${shown}, got an object with ${
				names.length === 1 ? "a member" : "members"
			} it does not declare — ${quoted(names)}.`,
			spell(at),
			inside,
		)
	}

	// NOTE: The one shape `Optional<T> ↔ T | undefined` can not describe, in both
	// directions, worded the same way. `null` is no help — JSON turns an
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

	function undecidableSignature(
		shown: string,
		at: Path,
	): EssenceMarshalError {
		return new EssenceMarshalError(
			`${spell(
				at,
			)}: a Function carries no Type of its own, and ${shown} declares more than one signature it could be — which of them to marshal a call against is undecidable.`,
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

		// NOTE: An Essence value, named by its own tag — read through the bridge's
		// key like every other tag, so a value from ANOTHER bundle is described as
		// the plain object it is from here rather than misreported as one of this
		// Module's.
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

	return {
		toJS: (value, path = "value", expected) =>
			toJS(value, { root: path, trail: "" }, expected ?? null),
		fromJS: (value, expected, path = "value") =>
			fromJS(value, expected, { root: path, trail: "" }),
		wrapFunction,
	}
}

// #region Binding

// NOTE: The Module's exports as things a host can USE — a Function it can call, a
// Namespace it can reach a Method on — rather than the tagged values the bundle
// binds. Marshalling says what a value crossing the boundary becomes; this says
// which name is bound to what.
export type ModuleBindings = {
	// NOTE: JavaScript all the way down: values marshalled, Functions callable
	// with JavaScript Arguments, Namespaces plain objects of the same.
	exports: Readonly<Record<string, unknown>>
	// NOTE: The bundle's own bindings under the names their author wrote, and
	// nothing else done to them.
	raw: Readonly<Record<string, unknown>>
}

export type BindOptions = {
	// NOTE: THIS bundle's own Type key and value constructors. Not optional and
	// not discoverable: every Essence value carries its Type on a Symbol minted
	// when a bundle was evaluated, so a bridge belongs to one bundle and binding
	// against another's would build values the Module can not read.
	bridge: RuntimeBridge
}

type Callable = (...args: Array<unknown>) => unknown

export function bind(
	bundle: Record<string, unknown>,
	descriptor: ModuleDescriptor,
	options: BindOptions,
): ModuleBindings {
	let interpreter = createInterpreter(options.bridge)
	let raw = bindRaw(bundle, descriptor)
	let exports: Record<string, unknown> = {}

	for (let [name, entry] of Object.entries(descriptor.exports)) {
		// NOTE: An Overload set binds nothing under its own name, so it is the
		// one export whose binding is not read off `raw` — it is bound to the
		// refusal that says why, and where its Overloads are instead.
		if (entry.kind === "overloaded") {
			exports[name] = overloadedCall(entry.overloads, name)

			continue
		}

		if (!Object.hasOwn(raw, name)) {
			continue
		}

		switch (entry.kind) {
			case "function":
				exports[name] = interpreter.wrapFunction(
					raw[name] as EssenceFunction,
					entry.of,
					name,
				)

				break
			case "namespace":
				exports[name] = bindNamespace(raw[name], entry, interpreter)

				break
			default:
				defineConstant(
					exports,
					name,
					() => raw[name],
					entry.of,
					name,
					interpreter,
				)
		}
	}

	return { exports: Object.freeze(exports), raw }
}

// NOTE: The Module's exports under the names they were WRITTEN under. The
// Rewriter escapes a name JavaScript can not spell — `ok?` is bound as
// `$user_ok_3f_` — and a Descriptor carries what it emitted, so the two spellings
// can not drift apart.
//
// NOTE: A name the Descriptor lists that the bundle does not bind would be a
// Compiler bug, and is left out rather than bound to `undefined` — reading it
// then says "no such export" instead of handing back nothing.
function bindRaw(
	bundle: Record<string, unknown>,
	descriptor: ModuleDescriptor,
): Readonly<Record<string, unknown>> {
	let raw: Record<string, unknown> = {}

	for (let [name, entry] of Object.entries(descriptor.exports)) {
		// NOTE: An Overload set binds no name of its own — each Overload is its
		// own `name__overload$N` — so the whole set is put on `raw` under those
		// names, which are the only ones a host can actually call. (No user Module
		// reaches this today: `overload function` is the standard library's alone,
		// and the `declarations` files that may write it may not export. It is
		// here because `raw` promises the bundle's bindings, and a promise with a
		// hole in it is worse than a branch that waits.)
		if (entry.kind === "overloaded") {
			for (let overload of entry.overloads) {
				if (overload.emitted in bundle) {
					raw[overload.name] = bundle[overload.emitted]
				}
			}

			continue
		}

		if (entry.emitted in bundle) {
			raw[name] = bundle[entry.emitted]
		}
	}

	return Object.freeze(raw)
}

// NOTE: A constant is marshalled ON READ rather than at bind time, for two
// reasons that happen to have one answer.
//
// A value the boundary has no mapping for — the numeric tower above Rational,
// today — would otherwise take the whole Module down: one `constant root =
// 2::squareRoot()` and `exports`, `raw`, `bridge` and `marshaller` are all
// unreachable over an export nobody asked for. Bound this way, the refusal lands
// on the export that caused it, where it can be read and worked around.
//
// And what a read hands back is a fresh value every time, exactly as
// `marshaller.toJS(raw.…)` is. A single marshalled Array shared by every reader
// is one a host can push onto, which changes what every other holder of the same
// Module sees — while `Object.freeze(exports)` says, wrongly, that it cannot.
//
// NOTE: What was declared rides along for the one value a tag does not describe —
// a Function inside the constant, which `toJS` wraps against it.
function defineConstant(
	target: Record<string, unknown>,
	key: string,
	read: () => unknown,
	descriptor: Descriptor,
	name: string,
	interpreter: Interpreter,
): void {
	Object.defineProperty(target, key, {
		get: () => interpreter.toJS(read(), name, descriptor),
		enumerable: true,
	})
}

// NOTE: WHICH Overload a call means is a question only the Compiler answers — it
// reads the Argument Types, and a JavaScript value has none to read. So the name
// is bound to the refusal rather than left off: reaching it says what is wrong
// and where the Overloads are, where a missing name would only say that something
// the Module exports is not there.
function overloadedCall(
	overloads: Array<OverloadDescriptor>,
	name: string,
): Callable {
	let signatures = overloads.map((overload) => `  ${overload.signature}`)

	return () => {
		throw new EssenceCallError(
			`'${name}' is overloaded, and which Overload a call means is decided by the Argument Types — which a JavaScript value does not carry. Call one of its Overloads by name instead:\n${signatures.join(
				"\n",
			)}`,
		)
	}
}

// NOTE: A Namespace is emitted as a class of static Methods, so it comes back as
// a plain object of the same names — a host writes `Rectangle.of(…)` either way.
// An INSTANCE Method keeps the receiver it is emitted with as its first Argument,
// `Point.shifted(point, 4n)`, because there is no `::` on this side to put it
// before the name.
//
// NOTE: OWN members, because a Namespace is emitted as a class and a class
// inherits `name`, `length`, `call` and `bind` from `Function` — an `in` would
// answer for a Method the bundle does not bind and hand back JavaScript's own.
//
// NOTE: A static constant is bound ON READ for the reasons `defineConstant`
// states — a constant is a constant wherever it sits, and one the boundary has no
// mapping for would otherwise take the whole Namespace with it.
function bindNamespace(
	value: unknown,
	descriptor: NamespaceDescriptor,
	interpreter: Interpreter,
): Readonly<Record<string, unknown>> {
	let namespace = value as Record<string, unknown>
	let bound: Record<string, unknown> = {}

	for (let [name, property] of Object.entries(descriptor.properties)) {
		if (Object.hasOwn(namespace, property.emitted)) {
			defineConstant(
				bound,
				name,
				() => namespace[property.emitted],
				property.of,
				`${descriptor.name}.${name}`,
				interpreter,
			)
		}
	}

	for (let [name, method] of Object.entries(descriptor.methods)) {
		let qualified = `${descriptor.name}.${name}`

		if (method.kind === "overloaded") {
			bound[name] = overloadedCall(method.overloads, qualified)

			continue
		}

		if (
			Object.hasOwn(namespace, method.emitted) &&
			typeof namespace[method.emitted] === "function"
		) {
			bound[name] = interpreter.wrapFunction(
				namespace[method.emitted] as EssenceFunction,
				method.of,
				qualified,
			)
		}
	}

	return Object.freeze(bound)
}

// #endregion

// #region Calls

// NOTE: The Arguments a call resolved to, and which of the two ways it was
// written — an Error names an Argument by its label where the caller wrote one,
// and by its position where they counted.
type Call = { ordered: Array<unknown>; labelled: boolean }

// NOTE: The Arguments in the order the emitted Function takes them, whichever way
// the caller wrote the call.
//
// A Function whose every Parameter carries a label may be called with one object
// instead — `Rectangle.of({ width: 3n, height: 4n })` — because that is the call
// Essence itself writes, and dropping to positional Arguments at the boundary
// would lose the one thing the Declaration insisted on. The keys have to be
// EXACTLY the labels: a labelled call with a missing or a misspelled one is a
// mistake, not a positional call that happens to pass an object.
function readCall(
	args: Array<unknown>,
	signature: FunctionDescriptor,
	labels: Array<string> | null,
	name: string,
): Call {
	if (labels !== null && args.length === 1) {
		let given = plainObject(args[0])

		if (given !== null) {
			let keys = Object.keys(given)

			if (sameNames(keys, labels)) {
				return {
					ordered: labels.map((label) => given[label]),
					labelled: true,
				}
			}

			// NOTE: One object that is not a labelled call is only a positional
			// call while the Function takes exactly one Argument. Where it takes
			// more, the caller plainly meant the labels and got them wrong, and
			// saying which is worth more than "takes 2 Arguments, 1 was passed".
			if (signature.parameters.length !== 1) {
				throw new EssenceCallError(
					`${callShape(signature, labels, name)}. It was passed one object with ${
						keys.length === 0 ? "no keys" : quoted(keys)
					}.`,
				)
			}
		}
	}

	if (args.length !== signature.parameters.length) {
		throw new EssenceCallError(
			`${callShape(signature, labels, name)}; ${count(
				args.length,
				"Argument",
			)} ${args.length === 1 ? "was" : "were"} passed.`,
		)
	}

	return { ordered: args, labelled: false }
}

// NOTE: How the Function may be called, as the first half of every refusal — the
// signature it was declared with, and both ways of writing a call to it. The
// caller who got one wrong is reading it to find the other.
//
// NOTE: The name goes in FRONT of the signature, which is where `printSignature`
// writes one — a Descriptor carries the nameless print precisely so that the same
// signature can be named `labelled` here and `Point.shifted` one Namespace over.
function callShape(
	signature: FunctionDescriptor,
	labels: Array<string> | null,
	name: string,
): string {
	let positions = count(signature.parameters.length, "Argument")

	return labels === null
		? `${name}${signature.shown} takes ${positions}`
		: `${name}${
				signature.shown
			} takes ${positions} positionally, or one object with the labels ${quoted(
				labels,
			)}`
}

// NOTE: The labels a call may be written with, or `null` where it may not be
// written that way at all. Every Parameter has to carry one: a Function with a
// single `_` among its Parameters can not be called by label in Essence either,
// and half a labelled call is no call.
//
// NOTE: A Function of ONE Parameter an object can inhabit is positional whatever
// its label says. Both readings take an object, and the Parameter is the one that
// can hold any shape at all — so `describe({ width: 3n, height: 4n })` passes the
// Rectangle rather than looking for a label named `width`, and a Union or an
// `Optional` with a Record among what it admits reads the same way. This is the
// whole of the ambiguity: with two Parameters or more the key set decides, since
// a labelled call's keys are the labels and a positional call passes no object.
function labelsOf(signature: FunctionDescriptor): Array<string> | null {
	let parameters = signature.parameters

	if (parameters.length === 0) {
		return null
	}

	if (parameters.length === 1 && admitsRecord(parameters[0]!.of)) {
		return null
	}

	let labels: Array<string> = []

	for (let parameter of parameters) {
		if (parameter.label === null) {
			return null
		}

		labels.push(parameter.label)
	}

	return labels
}

// NOTE: What an Error calls the Argument that went wrong. A labelled call has no
// positions to count, so it is named the way it was written.
function argumentPath(
	label: string | null,
	position: number,
	labelled: boolean,
): string {
	return labelled && label !== null
		? `argument '${label}'`
		: `argument ${position + 1}`
}

function sameNames(given: Array<string>, expected: Array<string>): boolean {
	return (
		given.length === expected.length &&
		expected.every((name) => given.includes(name))
	)
}

// #endregion

// #region Wording

// NOTE: Bounded, for the reason the note above `describe` gives: the object being
// described is one a host got wrong, and a parsed JSON document with a thousand
// keys is exactly that. The first few name the mistake as well as all of them
// would.
function quoted(names: Array<string>): string {
	let shown = names
		.slice(0, NAMES_SHOWN)
		.map((name) => `'${name}'`)
		.join(", ")

	return names.length <= NAMES_SHOWN
		? shown
		: `${shown} and ${names.length - NAMES_SHOWN} more`
}

function count(amount: number, noun: string): string {
	return `${amount} ${noun}${amount === 1 ? "" : "s"}`
}

function shortened(value: string): string {
	return value.length > 32 ? `${value.slice(0, 32)}…` : value
}

// #endregion

// #region Reading a Descriptor

// NOTE: The spelling a Case is known by on this side — the Choice as it was
// DECLARED and the Case, with the Module path a bundle qualifies its tags with
// taken back off. `./Geometry.es#Shape#Circle` is `Shape#Circle` here: a host
// writes what it reads in the Essence source, and never where the file happened
// to sit on the machine that compiled it.
//
// NOTE: Read off the VALUE's tag rather than off a Descriptor, because a value
// coming out is met by its tag alone — this is the same rule `displayChoiceName`
// states, applied to the Choice half of a tag.
function caseName(tag: string): string {
	let separator = tag.lastIndexOf("#")
	let choice = tag.slice(0, separator)

	return `${choice.slice(choice.lastIndexOf("#") + 1)}#${tag.slice(
		separator + 1,
	)}`
}

// NOTE: Either spelling of the same Case. `Shape#Circle` is what `toJS` writes,
// and so what a round trip hands back; the bare `Circle` is what the Essence
// source itself writes, where a `#Circle` needs no Choice in front of it.
function admitsCase(tag: unknown, expected: CaseDescriptor): boolean {
	if (typeof tag !== "string") {
		return false
	}

	return (
		tag === expected.name || tag === `${expected.choice}#${expected.name}`
	)
}

// NOTE: What an `Optional` holds, or `null` where the shape is not one. The
// sibling of `descriptor.ts`'s `optionalItemOf`, which answers the same question
// of a Type — the two are one rule met on two sides of the seam, and both are
// asked it of a Union because a lone `#Value` arm can reach one.
function optionalItemOf(descriptor: Descriptor): Descriptor | null {
	switch (descriptor.kind) {
		case "optional":
			return descriptor.of
		case "case":
			return descriptor.optional && descriptor.name === "Value"
				? (descriptor.payload.item ?? null)
				: null
		case "union": {
			for (let arm of descriptor.arms) {
				let item = optionalItemOf(arm)

				if (item !== null) {
					return item
				}
			}

			return null
		}
		default:
			return null
	}
}

// NOTE: Whether `undefined` is a value of this shape — which is exactly whether
// an `Optional`'s `#Empty` is reachable in it. What it decides is whether an
// `Optional` is about to be put inside another one, and both levels spelled as
// nothing.
function admitsAbsence(descriptor: Descriptor): boolean {
	switch (descriptor.kind) {
		case "optional":
			return true
		case "case":
			return descriptor.optional && descriptor.name === "Empty"
		case "union":
			return descriptor.arms.some(admitsAbsence)
		default:
			return false
	}
}

// NOTE: Whether a plain object could BE a value of this shape — a Record anywhere
// it reaches without a tag in the way: itself, an arm of a Union, the item of an
// `Optional`, which is transparent on this side. A Case does not count, because
// its object spelling always carries `$case`, which no set of labels is. What it
// decides is whether a single labelled Parameter's labelled call is ambiguous —
// see `labelsOf`.
function admitsRecord(descriptor: Descriptor): boolean {
	switch (descriptor.kind) {
		case "record":
			return true
		case "optional":
			return admitsRecord(descriptor.of)
		case "case":
			return (
				descriptor.optional &&
				descriptor.name === "Value" &&
				descriptor.payload.item !== undefined &&
				admitsRecord(descriptor.payload.item)
			)
		case "union":
			return descriptor.arms.some(admitsRecord)
		default:
			return false
	}
}

// NOTE: The signatures a shape declares a Function to have, for the way OUT — one
// is the wrap, none is the passthrough, and two are a refusal, because an
// untagged value can not say which of them it is.
function callableSignatures(
	descriptor: Descriptor | null,
): Array<FunctionDescriptor> {
	if (descriptor === null) {
		return []
	}

	switch (descriptor.kind) {
		case "function":
			return [descriptor]
		case "union":
			return descriptor.arms.flatMap((arm) => callableSignatures(arm))
		default:
			return []
	}
}

// NOTE: What a container's pieces were DECLARED as, where the Descriptor says —
// asked on the way out only for the sake of the one value that carries no tag of
// its own. A Union offering two Lists (or two Records) does not decide, and `null`
// is the honest answer: the pieces still cross as their tags say, and a Function
// among them passes through raw exactly as it would with nothing declared at all.
function listItemOf(descriptor: Descriptor | null): Descriptor | null {
	if (descriptor === null) {
		return null
	}

	switch (descriptor.kind) {
		case "list":
			return descriptor.of
		case "union": {
			let items = descriptor.arms
				.map(listItemOf)
				.filter((item): item is Descriptor => item !== null)

			return items.length === 1 ? items[0]! : null
		}
		default:
			return null
	}
}

function recordMembersOf(
	descriptor: Descriptor | null,
): Record<string, Descriptor> | null {
	if (descriptor === null) {
		return null
	}

	switch (descriptor.kind) {
		case "record":
			return descriptor.members
		case "union": {
			let candidates = descriptor.arms
				.map(recordMembersOf)
				.filter(
					(members): members is Record<string, Descriptor> =>
						members !== null,
				)

			return candidates.length === 1 ? candidates[0]! : null
		}
		default:
			return null
	}
}

// NOTE: The payload of the Case a value's own tag names, where what was declared
// carries that Case — so a Function inside a payload crosses out wrapped like any
// other member. Both tags are the bundle's spelling, because a Descriptor bakes
// the one `emittedIdentity` writes.
function caseMembersOf(
	descriptor: Descriptor | null,
	tag: string,
): Record<string, Descriptor> | null {
	if (descriptor === null) {
		return null
	}

	switch (descriptor.kind) {
		case "case":
			return descriptor.tag === tag ? descriptor.payload : null
		case "union": {
			for (let arm of descriptor.arms) {
				let members = caseMembersOf(arm, tag)

				if (members !== null) {
					return members
				}
			}

			return null
		}
		default:
			return null
	}
}

// NOTE: A JavaScript object with members, and nothing that merely is one: an
// Array is a List's shape and an `EssenceRational` is a Rational's, so admitting
// either as a Record would make the shape that named it unreachable.
//
// NOTE: A labelled call asks the very same question of its one Argument — an
// `EssenceRational` passed to a Function whose labels happen to be `numerator`
// and `denominator` is a Rational, not a labelled call — which is why `readCall`
// reads through this rather than through a spelling of its own.
function plainObject(value: unknown): Record<string, unknown> | null {
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

// #endregion
