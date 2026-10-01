// The run-time half of the boundary: every conversion, refusal and call, over
// Descriptors. Nothing here may lead to the compiler. See "The interpreter" in
// DEVELOPMENT.md.

import { bareCaseCollision } from "./bare-cases"
import type { EssenceValue, FutureContext, RuntimeBridge } from "./bridge"
import type {
	CaseDescriptor,
	Descriptor,
	Fill,
	FunctionDescriptor,
	// Renamed, since `Members` here names the compiled readers of a shape.
	Members as DescribedMembers,
	ModuleDescriptor,
	NamespaceDescriptor,
	OverloadDescriptor,
} from "./descriptor"
import { EssenceCallError, EssenceMarshalError } from "./errors"
import { EssenceRational } from "./rational"

// The tags of the runtime's own `Optional`, which no Module path qualifies, so
// they are the same in every bundle. A Descriptor carries every other tag.
const OPTIONAL_VALUE = "Optional#Value"
const OPTIONAL_EMPTY = "Optional#Empty"

// Where a value sits, for an Error to name, as in `argument 2 → .items[0].width`.
// A converter gets the place it is inside and one step, `(value, at, step)`.
// The chain is spelled only when an Error is thrown, and only a container links
// a place of its own.
type Path = { at: Path | null; step: Step }

// A member name or a List position, as `.width` and `[3]`. At the root, the
// caller's name for the value.
type Step = string | number

function spell(at: Path | null, step: Step): string {
	if (at === null) {
		return step as string
	}

	let trail = accessor(step)
	let place = at

	while (place.at !== null) {
		trail = accessor(place.step) + trail
		place = place.at
	}

	let root = place.step as string

	return root === "" ? trail : `${root} → ${trail}`
}

function accessor(step: Step): string {
	return typeof step === "number" ? `[${step}]` : `.${step}`
}

// A new root inside a callback, for its Arguments and its answer, so a refusal
// reads `argument 2 → return value → .width`.
function within(at: string, what: string): string {
	return `${at} → ${what}`
}

// How many names an Error spells out before it starts counting.
const NAMES_SHOWN = 5

// Every Type key an interpreter in this process was built over. A value from
// another load or another bundle would otherwise read as a plain object, so a
// refusal names it as such. A Symbol described as `$type` from an unbound copy of
// the runtime counts too. Only an Error reads these.
const mintedTypeKeys = new Set<symbol>()
const TYPE_KEY_DESCRIPTION = "$type"

// The tag a value carries under a foreign Type key, or `null`. It runs only
// after a refusal.
function foreignTag(value: object, own: symbol): string | null {
	for (let key of Object.getOwnPropertySymbols(value)) {
		if (
			key !== own &&
			(mintedTypeKeys.has(key) ||
				key.description === TYPE_KEY_DESCRIPTION)
		) {
			let tag = (value as Record<symbol, unknown>)[key]

			return typeof tag === "string" ? tag : null
		}
	}

	return null
}

export type EssenceFunction = (...args: Array<EssenceValue>) => EssenceValue

// A Dictionary entry as the bridge hands it over and takes it back, the shape a
// `Map` iterates and its constructor reads.
type Entry = [EssenceValue, EssenceValue]

// One Descriptor node's rule, compiled, for each direction.
type Inbound = (value: unknown, at: Path | null, step: Step) => EssenceValue

type Outbound = (value: unknown, at: Path | null, step: Step) => unknown

// Releases a link that was never made, so a release needs no `null` test.
function nothing(): void {}

// The compiled readers of a Record's or payload's members, by name and in
// declared order. See `compiledMembers`.
type Members = {
	names: Array<string>
	readers: Array<Outbound>
	named: Map<string, Outbound>
}

// What a signature settles about a call: its labels, the readers for each
// Parameter and the answer, and each Argument's name in an Error. It is
// compiled once per signature, by `compiledCall`.
type Call = {
	arity: number
	labels: Array<string> | null
	readers: Array<Inbound>
	answer: Outbound
	positional: Array<string>
	named: Array<string>
}

export type Interpreter = {
	// An Essence value out, as the JavaScript it maps to. `path` is what an
	// Error calls the value. `expected` matters for a Function, which carries no
	// Type.
	toJS: (value: unknown, path?: string, expected?: Descriptor) => unknown
	// A JavaScript value in, as the shape it is being handed to.
	fromJS: (
		value: unknown,
		expected: Descriptor,
		path?: string,
	) => EssenceValue
	// The same two doors for a caller that crosses one shape many times. The
	// Descriptor is walked once, and the answer takes the value alone.
	compileIn: (
		expected: Descriptor,
		path?: string,
	) => (value: unknown) => EssenceValue
	compileOut: (
		expected: Descriptor,
		path?: string,
	) => (value: unknown) => unknown
	// One Essence Function as a JavaScript one. Arguments are marshalled against
	// the declared Parameters and passed by position, as every Essence call is
	// emitted.
	wrapFunction: (
		target: EssenceFunction,
		signature: FunctionDescriptor,
		name: string,
	) => (...args: Array<unknown>) => unknown
}

// A List box as the runtime lays it out, read and never written. See "List
// boxes" in DEVELOPMENT.md.
export type ListBox = {
	value: Array<unknown>
	length?: number
	front?: Array<unknown>
	frontLen?: number
	writes?: {
		log: {
			version: number
			positions: Array<number>
			items: Array<unknown>
		}
		seen: number
	}
}

// The back run as this box sees it, with later writes undone in a copy. See
// "List boxes" in DEVELOPMENT.md.
export function backRunSeenBy(list: ListBox): Array<unknown> {
	let writes = list.writes

	if (writes === undefined || writes.seen === writes.log.version) {
		return list.value
	}

	let count = list.length ?? list.value.length
	let own = list.value.slice(0, count)
	let positions = writes.log.positions
	let items = writes.log.items

	for (
		let version = writes.log.version - 1;
		version >= writes.seen;
		version--
	) {
		let position = positions[version]

		if (position < count) {
			own[position] = items[version]
		}
	}

	return own
}

export type InterpreterOptions = {
	// The host's stop, the root context of every run this binding starts.
	// Aborting it stops them as `::within` and `::race` stop their losers.
	signal?: AbortSignal
}

export function createInterpreter(
	bridge: RuntimeBridge,
	module: ModuleDescriptor,
	options: InterpreterOptions = {},
): Interpreter {
	// The bundle's Type key and constructors, read off the bridge once. See
	// "Values from the bundle" in DEVELOPMENT.md.
	let typeKey = bridge.typeKey
	let makeCase = bridge.case

	mintedTypeKeys.add(typeKey)

	// Tags an object this reader built in place, rather than copying it through
	// the bridge. See "Values from the bundle" in DEVELOPMENT.md.
	function ownRecord(fields: Record<string, EssenceValue>): EssenceValue {
		;(fields as Record<symbol, unknown>)[typeKey] = "Record"

		return fields
	}

	function ownCase(
		tag: string,
		payload: Record<string, EssenceValue>,
	): EssenceValue {
		;(payload as Record<symbol, unknown>)[typeKey] = tag

		return payload
	}

	// A Case payload default, built once when the reader is compiled and shared.
	// See "Values from the bundle" in DEVELOPMENT.md.
	function buildFill(fill: Fill): EssenceValue {
		switch (fill.kind) {
			case "integer":
				return makeInteger(BigInt(fill.value))
			case "rational":
				return makeRational(
					BigInt(fill.numerator),
					BigInt(fill.denominator),
				)
			case "string":
				return makeString(fill.value)
			case "boolean":
				return makeBoolean(fill.value)
			case "list":
				return makeList(fill.items.map(buildFill))
			case "record":
				return ownRecord(buildFillMembers(fill.members))
			case "case":
				return fill.payload === null
					? makeCase(fill.tag)
					: ownCase(fill.tag, buildFillMembers(fill.payload))
		}
	}

	function buildFillMembers(
		members: Record<string, Fill>,
	): Record<string, EssenceValue> {
		let built: Record<string, EssenceValue> = {}

		for (let [name, fill] of Object.entries(members)) {
			built[name] = buildFill(fill)
		}

		return built
	}
	let makeInteger = bridge.integer
	let makeRational = bridge.rational
	let makeString = bridge.string
	let makeBoolean = bridge.boolean
	let makeList = bridge.list
	// The Dictionary door, undefined where the boundary names no Dictionary.
	// See "Values from the bundle" in DEVELOPMENT.md.
	let makeDictionary = bridge.dictionary
	let dictionaryEntries = bridge.dictionaryEntries
	// The Future door, undefined where the boundary names no work.
	let makeFuture = bridge.future
	let makeFutureContext = bridge.futureContext
	let futureAnswer = bridge.futureAnswer
	let hostSignal = options.signal
	// Every unit Choice Case the Module names, by tag. See "Bare Case names" in
	// DEVELOPMENT.md.
	let bareCases = bareCaseNames(module)

	// #region Compiling

	// One compiled rule per Descriptor node. See "Compiled rules" in
	// DEVELOPMENT.md.
	let inbound = new WeakMap<Descriptor, Inbound>()
	let outbound = new WeakMap<Descriptor, Outbound>()
	// An answer reads a Future differently, so it has a table of its own.
	let answers = new WeakMap<Descriptor, Outbound>()
	let outboundMembers = new WeakMap<DescribedMembers, Members>()
	let calls = new WeakMap<FunctionDescriptor, Call>()
	// The members of a position that declared nothing, each read by the walk
	// the value directs. It spares the loop a `null` test.
	let noMembers: Members = { names: [], readers: [], named: new Map() }

	function compileIn(expected: Descriptor): Inbound {
		let compiled = inbound.get(expected)

		if (compiled === undefined) {
			compiled = buildIn(expected)
			inbound.set(expected, compiled)
		}

		return compiled
	}

	function compileOut(expected: Descriptor): Outbound {
		let compiled = outbound.get(expected)

		if (compiled === undefined) {
			compiled = buildOut(expected)
			outbound.set(expected, compiled)
		}

		return compiled
	}

	// A call's answer, the one position where `Future<T>` and `Started<T>` cross,
	// as a `Promise`. The rule is about the position, so it stands in front of
	// `buildOut`, and every other shape goes through `compileOut`.
	function compileAnswerOut(expected: Descriptor): Outbound {
		if (expected.kind !== "future" && expected.kind !== "started") {
			return compileOut(expected)
		}

		let compiled = answers.get(expected)

		if (compiled === undefined) {
			compiled = buildAnswerOut(expected)
			answers.set(expected, compiled)
		}

		return compiled
	}

	// The compiled way out, or the walk the value directs where a position
	// declared nothing.
	function out(expected: Descriptor | null): Outbound {
		return expected === null ? anyOut : compileOut(expected)
	}

	function anyOut(value: unknown, at: Path | null, step: Step): unknown {
		return toJS(value, at, step, null)
	}

	// A Record's or payload's member readers, kept per members object. A value the
	// Module built carries its members in the declared order, so a reader is found
	// by comparing names. The map serves every other value.
	function compiledMembers(members: DescribedMembers): Members {
		let compiled = outboundMembers.get(members)

		if (compiled === undefined) {
			let names = Object.keys(members)
			let readers = names.map((name) => compileOut(members[name]!.of))
			let named = new Map<string, Outbound>()

			for (let position = 0; position < names.length; position++) {
				named.set(names[position]!, readers[position]!)
			}

			compiled = { names, readers, named }
			outboundMembers.set(members, compiled)
		}

		return compiled
	}

	// A signature's half of a call, kept per signature. A Function is wrapped
	// anew each time it crosses, so this work would otherwise repeat per value.
	function compiledCall(signature: FunctionDescriptor): Call {
		let compiled = calls.get(signature)

		if (compiled === undefined) {
			let parameters = signature.parameters
			let labels = labelsOf(signature)
			let positional = parameters.map((parameter, position) =>
				argumentPath(parameter.label, position, false),
			)

			compiled = {
				arity: parameters.length,
				labels,
				readers: parameters.map((parameter) => compileIn(parameter.of)),
				answer: compileAnswerOut(signature.returns),
				positional,
				// The same Array where no labels may be written, so `readCall`
				// can tell the two spellings apart by identity.
				named:
					labels === null
						? positional
						: parameters.map((parameter, position) =>
								argumentPath(parameter.label, position, true),
							),
			}
			calls.set(signature, compiled)
		}

		return compiled
	}

	// #endregion

	// #region In

	// A List's items, read by a loop picked by the item's kind. Each leaf loop
	// repeats the leaf's branch in `buildIn`, and the two must agree. See "List
	// loops" in DEVELOPMENT.md.
	function runIn(
		item: Descriptor,
	): (source: Array<unknown>, at: Path) => Array<EssenceValue> {
		let shown = item.shown
		let read = compileIn(item)

		if (item.kind === "integer") {
			return (source, at) => {
				let count = source.length
				// The answer's length. `Array.from({ length })` would fill it
				// through an iterator, which this walk avoids.
				// oxlint-disable-next-line unicorn/no-new-array -- the answer's length
				let items: Array<EssenceValue> = new Array(count)

				for (let position = 0; position < count; position++) {
					let held = source[position]

					if (typeof held === "bigint") {
						items[position] = makeInteger(held)
					} else if (
						typeof held === "number" &&
						Number.isSafeInteger(held)
					) {
						items[position] = makeInteger(held)
					} else {
						throw mismatch(held, shown, at, position)
					}
				}

				return items
			}
		}

		if (item.kind === "string") {
			return (source, at) => {
				let count = source.length
				// oxlint-disable-next-line unicorn/no-new-array -- the length, as above
				let items: Array<EssenceValue> = new Array(count)

				for (let position = 0; position < count; position++) {
					let held = source[position]

					if (typeof held !== "string") {
						throw mismatch(held, shown, at, position)
					}

					items[position] = makeString(held.normalize("NFC"))
				}

				return items
			}
		}

		if (item.kind === "boolean") {
			return (source, at) => {
				let count = source.length
				// oxlint-disable-next-line unicorn/no-new-array -- the length, as above
				let items: Array<EssenceValue> = new Array(count)

				for (let position = 0; position < count; position++) {
					let held = source[position]

					if (typeof held !== "boolean") {
						throw mismatch(held, shown, at, position)
					}

					items[position] = makeBoolean(held)
				}

				return items
			}
		}

		// Every other kind through its own converter.
		return (source, at) => {
			let count = source.length
			// oxlint-disable-next-line unicorn/no-new-array -- the length, as above
			let items: Array<EssenceValue> = new Array(count)

			for (let position = 0; position < count; position++) {
				items[position] = read(source[position], at, position)
			}

			return items
		}
	}

	// The way in for one shape. Whatever does not depend on the value is decided
	// here, once.
	function buildIn(expected: Descriptor): Inbound {
		let shown = expected.shown

		switch (expected.kind) {
			case "integer":
				return (value, at, step) => {
					// Both kinds go in as they are, since the bridge's integer
					// constructor canonicalises either.
					if (typeof value === "bigint") {
						return makeInteger(value)
					}

					// Only a safe integer, since a larger double may already
					// have lost the value it was written as.
					if (
						typeof value === "number" &&
						Number.isSafeInteger(value)
					) {
						return makeInteger(value)
					}

					throw mismatch(value, shown, at, step)
				}
			case "rational":
				return (value, at, step) => {
					if (value instanceof EssenceRational) {
						return makeRational(value.numerator, value.denominator)
					}

					if (typeof value === "bigint") {
						return makeRational(value, 1n)
					}

					if (typeof value === "number" && Number.isFinite(value)) {
						let exact = EssenceRational.fromNumber(value)

						return makeRational(exact.numerator, exact.denominator)
					}

					throw mismatch(value, shown, at, step)
				}
			case "string":
				return (value, at, step) => {
					if (typeof value !== "string") {
						throw mismatch(value, shown, at, step)
					}

					// Normalised, because Essence compares Strings normalised,
					// and two spellings of one String must not both get in.
					return makeString(value.normalize("NFC"))
				}
			case "boolean":
				return (value, at, step) => {
					if (typeof value !== "boolean") {
						throw mismatch(value, shown, at, step)
					}

					return makeBoolean(value)
				}
			case "list": {
				let items = runIn(expected.of)

				return (value, at, step) => {
					if (!Array.isArray(value)) {
						throw mismatch(value, shown, at, step)
					}

					// `bridge.list` copies its Array. A bridged constructor that
					// took ownership would let a host's own call share a run with
					// Essence.
					return makeList(items(value, { at, step }))
				}
			}
			// A `Map` only, read entry by entry in its order. The runtime builds
			// the Dictionary and decides whether two keys are one.
			case "dictionary": {
				let build = makeDictionary

				if (build === undefined) {
					return (_value, at, step) => {
						throw noDictionaryDoor(at, step)
					}
				}

				let readKey = compileIn(expected.key)
				let readValue = compileIn(expected.value)

				return (value, at, step) => {
					if (!(value instanceof Map)) {
						// A plain object is refused with the shape to write
						// instead, by `objectSpelledDictionary`.
						throw plainObject(value) === null
							? mismatch(value, shown, at, step)
							: objectSpelledDictionary(shown, at, step)
					}

					let inside: Path = { at, step }
					// oxlint-disable-next-line unicorn/no-new-array -- the length, as above
					let entries: Array<Entry> = new Array(value.size)
					let position = 0

					// An Error names the entry's position and the wrong half,
					// as in `argument 1 → [2].value`.
					for (let [key, held] of value) {
						let where: Path = { at: inside, step: position }

						entries[position] = [
							readKey(key, where, "key"),
							readValue(held, where, "value"),
						]
						position++
					}

					let built = build(entries)

					// A number is the position of a key the Dictionary already
					// holds, which this side names. See `createDictionaryFrom`.
					if (typeof built === "number") {
						throw duplicateKey({ at: inside, step: built }, "key")
					}

					return built
				}
			}
			case "record": {
				let names = Object.keys(expected.members)
				let readers = names.map((name) =>
					compileIn(expected.members[name]!.of),
				)
				// The members the callee's default fills in, which a host may
				// leave out. Their absence must reach the Record as a missing key,
				// since everything downstream reads its own keys.
				let defaulted = names.map(
					(name) => expected.members[name]!.optional === true,
				)
				let count = names.length
				let declared = new Set(names)

				return (value, at, step) => {
					let given = plainObject(value)

					if (given === null) {
						throw mismatch(value, shown, at, step)
					}

					let fields: Record<string, EssenceValue> = {}
					let inside: Path = { at, step }
					// Keys matching the declared members in order prove at once
					// that every member is present and no other key is.
					let keys = Object.keys(given)
					let asDeclared = keys.length === count

					if (asDeclared) {
						for (let position = 0; position < count; position++) {
							if (keys[position] !== names[position]) {
								asDeclared = false

								break
							}
						}
					}

					if (asDeclared) {
						for (let position = 0; position < count; position++) {
							let name = names[position]!

							fields[name] = readers[position]!(
								given[name],
								inside,
								name,
							)
						}

						return ownRecord(fields)
					}

					// Otherwise each member is read from its own key, an absent
					// key as `undefined`, and the member's shape decides. So a
					// Record from JSON, which drops `undefined` keys, still crosses.
					// A defaulted member left out stays out. An own key, since a
					// plain read of an absent `toString` finds `Object.prototype`'s.
					for (let position = 0; position < count; position++) {
						let name = names[position]!
						let written = Object.hasOwn(given, name)

						if (!written && defaulted[position]) {
							continue
						}

						fields[name] = readers[position]!(
							written ? given[name] : undefined,
							inside,
							name,
						)
					}

					// Closed, unlike the Matcher a `case` narrows with, so a
					// misspelled member is refused rather than dropped. Asked after
					// the members, so a wrong member is named before an extra one.
					let undeclared = undeclaredOf(given, declared, false)

					if (undeclared !== null) {
						throw undeclaredMembers(shown, undeclared, at, step)
					}

					return ownRecord(fields)
				}
			}
			case "optional": {
				// `#Value(#Empty)` and `#Empty` would both be `undefined`, so
				// the shape compiles to a refusal, as in `toJS`.
				if (admitsAbsence(expected.of)) {
					return (_value, at, step) => {
						throw nestedOptional(at, step)
					}
				}

				let item = compileIn(expected.of)

				// Spelled by absence, `undefined` or `null`. See "Reading a
				// Union" in DEVELOPMENT.md.
				return (value, at, step) => {
					if (value === undefined || value === null) {
						return makeCase(OPTIONAL_EMPTY)
					}

					try {
						return makeCase(OPTIONAL_VALUE, {
							item: item(value, at, step),
						})
					} catch (thrown) {
						if (!(thrown instanceof EssenceMarshalError)) {
							throw thrown
						}

						if (reachedInside(thrown, at, step)) {
							throw thrown
						}

						throw mismatch(value, shown, at, step)
					}
				}
			}
			case "case":
				return buildCaseIn(expected)
			case "union": {
				// Two shapes are refused before any arm is compiled. See
				// "Reading a Union" in DEVELOPMENT.md.
				let item = optionalItemOf(expected)

				if (item !== null && admitsAbsence(item)) {
					return (_value, at, step) => {
						throw nestedOptional(at, step)
					}
				}

				let collision = bareCaseCollision(expected)

				if (collision !== null) {
					return (_value, at, step) => {
						throw ambiguousBareCase(shown, collision, at, step)
					}
				}

				let arms = expected.arms.map((arm) => compileIn(arm))
				let count = arms.length
				// The kinds each arm could take, a table for bare Cases and a
				// table for `$case` tags. None of them changes an answer. See
				// "Reading a Union" in DEVELOPMENT.md.
				let families = expected.arms.map((arm) => familiesOf(arm))

				let named = bareCaseTable(expected)

				let tagged = caseArmTable(expected)

				// The first arm in declaration order that admits the value
				// takes it.
				return (value, at, step) => {
					let family = typeof value

					if (named !== null && family === "string") {
						let tag = named.get(value as string)

						if (tag !== undefined) {
							return makeCase(tag)
						}
					}

					if (
						tagged !== null &&
						family === "object" &&
						value !== null
					) {
						let spelled = (value as Record<string, unknown>).$case

						if (typeof spelled === "string") {
							let position = tagged.get(spelled)

							if (position !== undefined) {
								return arms[position]!(value, at, step)
							}
						}
					}

					// Built on the first refusal, so the usual success allocates
					// nothing.
					let refused: Array<EssenceMarshalError> | null = null

					for (let position = 0; position < count; position++) {
						let admits = families[position]!

						if (admits !== null && !admits.has(family)) {
							continue
						}

						try {
							return arms[position]!(value, at, step)
						} catch (thrown) {
							if (!(thrown instanceof EssenceMarshalError)) {
								throw thrown
							}

							if (refused === null) {
								refused = []
							}

							refused.push(thrown)
						}
					}

					if (refused !== null) {
						let reached = refused.filter((failure) =>
							reachedInside(failure, at, step),
						)

						if (reached.length === 1) {
							throw reached[0]
						}
					}

					throw mismatch(value, shown, at, step)
				}
			}
			case "function":
				return buildCallbackIn(expected)
			// Work can not be built from a JavaScript value, since a `Promise`
			// describes no work and can not run again. A host hands work over as a
			// callback, which `buildCallbackIn` reads.
			case "future":
			case "started":
				return (_value, at, step) => {
					throw asynchronyFromHost(shown, at, step)
				}
			// What has no mapping, refused in the compiler's words.
			case "refused": {
				let why = expected.why

				return (_value, at, step) => {
					let where = spell(at, step)

					throw new EssenceMarshalError(`${where}: ${why}`, where)
				}
			}
		}
	}

	function buildCaseIn(expected: CaseDescriptor): Inbound {
		let shown = expected.shown
		let tag = expected.tag

		// A lone Case of `Optional`, as an unannotated constant infers it, read
		// by the rule the pair is read by.
		if (expected.optional) {
			if (expected.name === "Empty") {
				return (value, at, step) => {
					if (value !== undefined && value !== null) {
						throw mismatch(value, shown, at, step)
					}

					return makeCase(tag)
				}
			}

			let item = expected.payload.item

			// A `#Value` carrying nothing, or another absence, is a shape no
			// value has.
			if (item === undefined) {
				return (value, at, step) => {
					throw mismatch(value, shown, at, step)
				}
			}

			if (admitsAbsence(item.of)) {
				return (_value, at, step) => {
					throw nestedOptional(at, step)
				}
			}

			let held = compileIn(item.of)

			return (value, at, step) => {
				if (value === undefined || value === null) {
					throw mismatch(value, shown, at, step)
				}

				return makeCase(tag, { item: held(value, at, step) })
			}
		}

		// A unit Choice's Case is the string `"Up"` or `"Direction#Up"`, and no
		// object. The way out hands back one spelling, so a second object
		// spelling would not survive a round trip.
		if (expected.unitChoice) {
			let named = expected.name
			let spelled = `${expected.choice}#${expected.name}`

			return (value, at, step) => {
				if (value === named || value === spelled) {
					// No payload, so `createCase` answers the shared instance.
					return makeCase(tag)
				}

				// An object spelling gets a sentence saying what to write
				// instead. It is marked as inside, so a Union reports it.
				let given = plainObject(value)

				if (
					given !== null &&
					(given.$case === named || given.$case === spelled)
				) {
					throw objectSpelledCase(shown, named, at, step)
				}

				throw mismatch(value, shown, at, step)
			}
		}

		// The tag `toJS` writes, `Shape#Circle`, and the bare `Circle` the
		// source writes are both accepted.
		let bare = expected.name
		let qualified = `${expected.choice}#${expected.name}`
		let colliding = Object.hasOwn(expected.payload, "$case")
		let names = Object.keys(expected.payload)
		let readers = names.map((name) => compileIn(expected.payload[name]!.of))
		// The payload defaults, built once. A Case has no callee to fill them
		// in. See "Values from the bundle" in DEVELOPMENT.md.
		let fills = names.map((name) => {
			let fill = expected.payload[name]!.fill

			return fill === undefined ? null : buildFill(fill)
		})
		let count = names.length
		let declared = new Set(names)

		return (value, at, step) => {
			let given = plainObject(value)

			if (given === null) {
				throw mismatch(value, shown, at, step)
			}

			let named = given.$case

			if (named !== bare && named !== qualified) {
				throw mismatch(value, shown, at, step)
			}

			// A payload member called `$case` would collide with the tag, so it
			// is refused in both directions.
			if (colliding) {
				throw collidingCase(at, step, true)
			}

			let payload: Record<string, EssenceValue> = {}
			let inside: Path = { at, step }

			// The declared members in order, with `$case` first, as a host
			// writes it, or last, as a constructor and `toJS` build it. A match
			// proves every member present and no other key there.
			let keys = Object.keys(given)

			if (keys.length === count + 1) {
				let offset = keys[0] === "$case" ? 1 : 0
				let asDeclared = offset === 1 || keys[count] === "$case"

				if (asDeclared) {
					for (let position = 0; position < count; position++) {
						if (keys[position + offset] !== names[position]) {
							asDeclared = false

							break
						}
					}
				}

				if (asDeclared) {
					if (count === 0) {
						return makeCase(tag)
					}

					for (let position = 0; position < count; position++) {
						let name = names[position]!

						payload[name] = readers[position]!(
							given[name],
							inside,
							name,
						)
					}

					return ownCase(tag, payload)
				}
			}

			let undeclared = undeclaredOf(given, declared, true)

			if (undeclared !== null) {
				throw undeclaredMembers(shown, undeclared, at, step, true)
			}

			if (count === 0) {
				// No payload, so `createCase` answers the shared instance the
				// Module's own `#Blank` is.
				return makeCase(tag)
			}

			// Read as a Record's members are, from own keys, since a plain read of
			// an absent `toString` finds `Object.prototype`'s. A default fills a
			// member left out.
			for (let position = 0; position < count; position++) {
				let name = names[position]!
				let written = Object.hasOwn(given, name)
				let fill = fills[position]

				if (!written && fill !== null) {
					payload[name] = fill

					continue
				}

				payload[name] = readers[position]!(
					written ? given[name] : undefined,
					inside,
					name,
				)
			}

			return ownCase(tag, payload)
		}
	}

	// A JavaScript Function as an Essence one, called by the Module. See
	// "Callbacks" in DEVELOPMENT.md.
	function buildCallbackIn(signature: FunctionDescriptor): Inbound {
		let shown = signature.shown
		let count = signature.parameters.length
		let handed = signature.parameters.map((parameter) =>
			compileOut(parameter.of),
		)
		// A callback declared `-> Future<T>`, whose host Function is called at
		// every start of the work.
		let work =
			signature.returns.kind === "future" ? signature.returns : null
		let back = compileIn(work === null ? signature.returns : work.of)
		let makeWork = makeFuture

		return (value, at, step) => {
			if (typeof value !== "function") {
				throw mismatch(value, shown, at, step)
			}

			// Asked on arrival, while the host can still be told.
			if (work !== null && makeWork === undefined) {
				throw noFutureDoor(at, step)
			}

			let target = value as (...args: Array<unknown>) => unknown
			let arrived = spell(at, step)
			// oxlint-disable-next-line unicorn/no-new-array -- the length, as above
			let places: Array<string> = new Array(count)

			for (let position = 0; position < count; position++) {
				places[position] = within(arrived, `argument ${position + 1}`)
			}

			let answered = within(arrived, "return value")

			if (work === null) {
				return (...args: Array<EssenceValue>): EssenceValue => {
					// oxlint-disable-next-line unicorn/no-new-array -- the length, as above
					let given: Array<unknown> = new Array(count)

					for (let position = 0; position < count; position++) {
						given[position] = handed[position]!(
							args[position],
							null,
							places[position]!,
						)
					}

					return back(target(...given), null, answered)
				}
			}

			let build = makeWork!

			// The Arguments cross when the Module calls the callback, and the
			// host is called when the work starts. The run's context is not passed.
			return (...args: Array<EssenceValue>): EssenceValue => {
				// oxlint-disable-next-line unicorn/no-new-array -- the length, as above
				let given: Array<unknown> = new Array(count)

				for (let position = 0; position < count; position++) {
					given[position] = handed[position]!(
						args[position],
						null,
						places[position]!,
					)
				}

				return build(() =>
					Promise.resolve(target(...given)).then((held) =>
						back(held, null, answered),
					),
				)
			}
		}
	}

	// #endregion

	// #region Out

	// The way out for one shape: the tag is checked, and a value with another
	// tag goes to `toJS`. See "The way out" in DEVELOPMENT.md.
	function buildOut(expected: Descriptor): Outbound {
		switch (expected.kind) {
			// Always a bigint, whichever form the runtime holds.
			case "integer":
				return (value, at, step) =>
					tagged(value, "Integer")
						? BigInt((value as { value: number | bigint }).value)
						: toJS(value, at, step, expected)
			case "rational":
				return (value, at, step) => {
					if (!tagged(value, "Rational")) {
						return toJS(value, at, step, expected)
					}

					let parts = value as {
						numerator: bigint
						denominator: bigint
					}

					return new EssenceRational(
						parts.numerator,
						parts.denominator,
					)
				}
			case "string":
				return (value, at, step) =>
					tagged(value, "String")
						? (value as { value: string }).value
						: toJS(value, at, step, expected)
			case "boolean":
				return (value, at, step) =>
					tagged(value, "Boolean")
						? (value as { value: boolean }).value
						: toJS(value, at, step, expected)
			case "list": {
				let item = compileOut(expected.of)

				return (value, at, step) =>
					tagged(value, "List")
						? itemsOf(value as object, at, step, item)
						: toJS(value, at, step, expected)
			}
			case "dictionary": {
				let key = compileOut(expected.key)
				let held = compileOut(expected.value)

				return (value, at, step) =>
					tagged(value, "Dictionary")
						? mapOf(value as object, at, step, key, held)
						: toJS(value, at, step, expected)
			}
			case "record": {
				let members = compiledMembers(expected.members)

				return (value, at, step) =>
					tagged(value, "Record")
						? fieldsOf(value as object, at, step, members)
						: toJS(value, at, step, expected)
			}
			case "optional": {
				let item = compileOut(expected.of)

				// Transparent: no Case in the answer, and no path segment.
				return (value, at, step) => {
					if (tagged(value, OPTIONAL_VALUE)) {
						let held = (value as { item: unknown }).item

						// `#Value(#Empty)` and `#Empty` would both be
						// `undefined`, so the pair is refused.
						if (isOptionalValue(held)) {
							throw nestedOptional(at, step)
						}

						return item(held, at, step)
					}

					if (tagged(value, OPTIONAL_EMPTY)) {
						return undefined
					}

					return toJS(value, at, step, expected)
				}
			}
			case "case": {
				// A lone `Optional` Case is spelled by absence, which `toJS`
				// owns, as `collectCases` leaves a Union's `Optional` arms.
				if (expected.optional) {
					return (value, at, step) => toJS(value, at, step, expected)
				}

				let tag = expected.tag

				// A unit Choice's Case comes out as its name.
				if (expected.unitChoice) {
					let named = expected.name

					return (value, at, step) =>
						tagged(value, tag)
							? named
							: toJS(value, at, step, expected)
				}

				// The Case's name, cut from the tag once.
				let name = caseName(tag)
				let members = compiledMembers(expected.payload)

				return (value, at, step) =>
					tagged(value, tag)
						? casedFields(value as object, at, step, members, name)
						: toJS(value, at, step, expected)
			}
			case "union": {
				// Refused as the way in refuses it, so a host is never handed a
				// value it could not hand back.
				let collision = bareCaseCollision(expected)

				if (collision !== null) {
					return (_value, at, step) => {
						throw ambiguousBareCase(
							expected.shown,
							collision,
							at,
							step,
						)
					}
				}

				// One reader per Case the Union offers, by tag. Every other arm
				// goes through `toJS`.
				let arms = new Map<string, Outbound>()

				collectCases(expected, arms)

				return (value, at, step) => {
					if (typeof value === "object" && value !== null) {
						let tag = (value as Record<symbol, unknown>)[typeKey]

						if (typeof tag === "string") {
							let arm = arms.get(tag)

							if (arm !== undefined) {
								return arm(value, at, step)
							}
						}
					}

					return toJS(value, at, step, expected)
				}
			}
			// A Function carries no tag, so its position's Descriptor decides.
			case "function":
				return (value, at, step) =>
					typeof value === "function"
						? wrapFunction(
								value as EssenceFunction,
								expected,
								spell(at, step),
							)
						: toJS(value, at, step, expected)
			// Work anywhere but a call's answer compiles to a refusal.
			case "future":
			case "started":
				return (_value, at, step) => {
					throw asynchronyInsideValue(expected.shown, at, step)
				}
			// A Type the way in can not build still comes out by its tag.
			case "refused":
				return (value, at, step) => toJS(value, at, step, expected)
		}
	}

	// A call's answer that is work, as a `Promise`. A Future is started here,
	// once per call. See "Work crossing out" in DEVELOPMENT.md.
	function buildAnswerOut(
		expected: Extract<Descriptor, { kind: "future" | "started" }>,
	): Outbound {
		let answer = futureAnswer
		let makeContext = makeFutureContext

		if (answer === undefined || makeContext === undefined) {
			return (_value, at, step) => {
				throw noFutureDoor(at, step)
			}
		}

		let tag = expected.kind === "future" ? "Future" : "Started"
		let started = expected.kind === "started"
		let item = compileOut(expected.of)

		return (value, at, step) => {
			if (!tagged(value, tag)) {
				return toJS(value, at, step, expected)
			}

			// An aborted host starts no Future, and gets a promise that never
			// settles. A Started belongs to whoever started it.
			if (!started && hostSignal?.aborted === true) {
				return new Promise(() => {})
			}

			// The runtime answers a Started with the promise it holds, so its
			// context is never read and nothing needs unlinking.
			let root = started
				? { context: makeContext(), release: nothing }
				: rootContext(makeContext)
			let answered = answer(value as EssenceValue, root.context)

			return Promise.resolve(answered).then(
				(held) => {
					root.release()

					return item(held, at, step)
				},
				(thrown) => {
					root.release()

					throw thrown
				},
			)
		}
	}

	// A root context for one run, linked to the host's signal until `release`.
	// See "Work crossing out" in DEVELOPMENT.md.
	function rootContext(makeContext: () => FutureContext): {
		context: FutureContext
		release: () => void
	} {
		let context = makeContext()

		if (hostSignal === undefined) {
			return { context, release: nothing }
		}

		// A signal aborted already aborts the context before anything runs. A
		// later abort is cooperative.
		if (hostSignal.aborted) {
			context.controller.abort(hostSignal.reason)

			return { context, release: nothing }
		}

		let signal = hostSignal
		let forward = (): void => context.controller.abort(signal.reason)

		signal.addEventListener("abort", forward, { once: true })

		return {
			context,
			release: () => signal.removeEventListener("abort", forward),
		}
	}

	// Every Case a Union offers, by tag, in the order `caseFor` reads them, so
	// the first under a tag is the arm `toJS` would find. `Optional`'s Cases are
	// left to `toJS`, which spells them by absence.
	function collectCases(
		descriptor: Descriptor,
		found: Map<string, Outbound>,
	): void {
		switch (descriptor.kind) {
			case "case":
				if (!descriptor.optional && !found.has(descriptor.tag)) {
					found.set(descriptor.tag, compileOut(descriptor))
				}

				break
			case "union":
				for (let arm of descriptor.arms) {
					collectCases(arm, found)
				}

				break
			default:
				break
		}
	}

	// The walk a value directs, for a position that declared nothing and for a
	// compiled reader that met an unexpected tag.
	function toJS(
		value: unknown,
		at: Path | null,
		step: Step,
		expected: Descriptor | null,
	): unknown {
		// A Function, or a Namespace emitted as a class, carries no tag. It is
		// wrapped where its position declares one signature, and passes through
		// where it declares none.
		if (typeof value === "function") {
			let signatures = callableSignatures(expected)

			if (signatures.length === 1) {
				return wrapFunction(
					value as EssenceFunction,
					signatures[0]!,
					spell(at, step),
				)
			}

			// Two signatures, and no tag to choose between them.
			if (signatures.length > 1) {
				throw undecidableSignature(expected!.shown, at, step)
			}

			return value
		}

		if (value === null || typeof value !== "object") {
			throw foreignValue(value, at, step)
		}

		let tag = (value as Record<symbol, unknown>)[typeKey]

		if (typeof tag !== "string") {
			throw foreignValue(value, at, step)
		}

		switch (tag) {
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
				return itemsOf(value, at, step, out(listItemOf(expected)))
			case "Dictionary": {
				let parts = dictionaryPartsOf(expected)

				return mapOf(
					value,
					at,
					step,
					out(parts === null ? null : parts.key),
					out(parts === null ? null : parts.value),
				)
			}
			case "Record": {
				let members = recordMembersOf(expected)

				return fieldsOf(
					value,
					at,
					step,
					members === null ? noMembers : compiledMembers(members),
				)
			}
			case OPTIONAL_VALUE: {
				let item = (value as { item: unknown }).item

				if (isOptionalValue(item)) {
					throw nestedOptional(at, step)
				}

				return out(expected === null ? null : optionalItemOf(expected))(
					item,
					at,
					step,
				)
			}
			case OPTIONAL_EMPTY:
				return undefined
			// Work inside a value, refused as at a declared position.
			case "Future":
			case "Started":
				throw asynchronyInsideValue(tag, at, step)
		}

		if (tag.includes("#")) {
			// Whether a Case crosses as a string belongs to its Choice, which
			// the value does not carry. The declared position is asked first.
			let described = caseFor(expected, tag)

			if (described !== null) {
				if (described.unitChoice) {
					return described.name
				}

				return casedFields(
					value,
					at,
					step,
					compiledMembers(described.payload),
					caseName(tag),
				)
			}

			// Then the Module's table. A Case the Module never named crosses as
			// an object.
			let named = bareCases.get(tag)

			if (named !== undefined) {
				return named
			}

			return casedFields(value, at, step, noMembers, caseName(tag))
		}

		// This Module's value with no mapping yet, such as an Algebraic, which
		// is not foreign.
		let where = spell(at, step)

		throw new EssenceMarshalError(
			`${where}: ${tag} values can not be marshalled yet.`,
			where,
		)
	}

	// Whether the value carries this tag under this bundle's key. A value from
	// another bundle fails, and `toJS` names it.
	function tagged(value: unknown, tag: string): boolean {
		return (
			typeof value === "object" &&
			value !== null &&
			(value as Record<symbol, unknown>)[typeKey] === tag
		)
	}

	// Read through this bundle's key, so another bundle's value is no Optional.
	function isOptionalValue(value: unknown): boolean {
		if (value === null || typeof value !== "object") {
			return false
		}

		let tag = (value as Record<symbol, unknown>)[typeKey]

		return tag === OPTIONAL_VALUE || tag === OPTIONAL_EMPTY
	}

	// A List's items, the front run backwards and then the back run, into an
	// Array of this side's own. As in the runtime, the counts are fixed before the
	// walk, since run Arrays are shared.
	function itemsOf(
		value: object,
		at: Path | null,
		step: Step,
		item: Outbound,
	): Array<unknown> {
		let list = value as ListBox
		let back = backRunSeenBy(list)
		let backCount = list.length ?? back.length
		let front = list.front
		let frontCount =
			front === undefined ? 0 : (list.frontLen ?? front.length)
		let total = frontCount + backCount
		// oxlint-disable-next-line unicorn/no-new-array -- the length, as above
		let items: Array<unknown> = new Array(total)
		let inside: Path = { at, step }

		for (let position = 0; position < total; position++) {
			items[position] = item(
				position < frontCount
					? front![frontCount - 1 - position]
					: back[position - frontCount],
				inside,
				position,
			)
		}

		return items
	}

	// A Dictionary's entries in its order, as a `Map` of this side's own. They
	// are read through the bridge, since which entries are live is a rule the
	// runtime states in `liveEntriesOf`.
	function mapOf(
		value: object,
		at: Path | null,
		step: Step,
		key: Outbound,
		held: Outbound,
	): Map<unknown, unknown> {
		if (dictionaryEntries === undefined) {
			throw noDictionaryDoor(at, step)
		}

		let entries = dictionaryEntries(value)
		let answer = new Map<unknown, unknown>()
		let inside: Path = { at, step }

		for (let position = 0; position < entries.length; position++) {
			let entry = entries[position]!
			let where: Path = { at: inside, step: position }

			answer.set(
				key(entry[0], where, "key"),
				held(entry[1], where, "value"),
			)
		}

		// A Namespace's own `is` may hold apart two keys that are one
		// JavaScript value. The lost entry shows as a smaller count.
		if (answer.size !== entries.length) {
			throw collidingKeys(at, step, entries.length, answer.size)
		}

		return answer
	}

	// The value's own members, since a Record is structural and may hold more
	// than its position names. `Object.keys` skips the Symbol Type key. A member
	// the shape does not name is read by the walk the value directs.
	function fieldsOf(
		value: object,
		at: Path | null,
		step: Step,
		members: Members,
	): Record<string, unknown> {
		let fields: Record<string, unknown> = {}
		let held = value as Record<string, unknown>
		let keys = Object.keys(value)
		let count = keys.length
		let declared = members.names
		let readers = members.readers
		let named = members.named
		let inside: Path = { at, step }

		for (let position = 0; position < count; position++) {
			let name = keys[position]!
			let member =
				name === declared[position]
					? readers[position]!
					: (named.get(name) ?? anyOut)

			fields[name] = member(held[name], inside, name)
		}

		return fields
	}

	// A Case's payload with `$case` added. A payload member called `$case`
	// would be lost under the tag, so it is refused.
	function casedFields(
		value: object,
		at: Path | null,
		step: Step,
		members: Members,
		name: string,
	): Record<string, unknown> {
		let fields = fieldsOf(value, at, step, members)

		if ("$case" in fields) {
			throw collidingCase(at, step)
		}

		fields.$case = name

		return fields
	}

	// #endregion

	// #region Calls

	// A mistake in the call's shape is an `EssenceCallError`, and one in a value
	// an `EssenceMarshalError`. The answer is read against the declared return,
	// so a Function answered comes back callable.
	function wrapFunction(
		target: EssenceFunction,
		signature: FunctionDescriptor,
		name: string,
	): (...args: Array<unknown>) => unknown {
		let { arity, labels, readers, answer, positional, named } =
			compiledCall(signature)

		return (...args: Array<unknown>): unknown => {
			let ordered = readCall(args, signature, labels, name)
			let places = ordered === args ? positional : named

			// A slot the call left out passes `undefined`, which fires the
			// emitted default. Every arity reads through this helper.
			let read = (position: number): EssenceValue =>
				ordered[position] === OMITTED
					? (undefined as unknown as EssenceValue)
					: readers[position]!(
							ordered[position],
							null,
							places[position]!,
						)

			// The common arities are written out, since spreading an Array
			// builds a call frame, most of a small call's cost.
			if (arity === 1) {
				return answer(target(read(0)), null, "return value")
			}

			if (arity === 2) {
				let first = read(0)
				let second = read(1)

				return answer(target(first, second), null, "return value")
			}

			// oxlint-disable-next-line unicorn/no-new-array -- the length, as above
			let marshalled: Array<EssenceValue> = new Array(arity)

			for (let position = 0; position < arity; position++) {
				marshalled[position] = read(position)
			}

			return answer(target(...marshalled), null, "return value")
		}
	}

	// #endregion

	// #region Errors

	// Whether a refusal got inside the value, by a deeper path or its own mark.
	// See "Reading a Union" in DEVELOPMENT.md.
	function reachedInside(
		failure: EssenceMarshalError,
		at: Path | null,
		step: Step,
	): boolean {
		return failure.inside || failure.path !== spell(at, step)
	}

	function mismatch(
		value: unknown,
		shown: string,
		at: Path | null,
		step: Step,
	): EssenceMarshalError {
		let where = spell(at, step)

		return new EssenceMarshalError(
			`${where}: expected ${shown}, got ${describe(value)}.`,
			where,
		)
	}

	function undeclaredMembers(
		shown: string,
		names: Array<string>,
		at: Path | null,
		step: Step,
		inside = false,
	): EssenceMarshalError {
		let where = spell(at, step)

		return new EssenceMarshalError(
			`${where}: expected ${shown}, got an object with ${
				names.length === 1 ? "a member" : "members"
			} it does not declare — ${quoted(names)}.`,
			where,
			inside,
		)
	}

	// An `Optional` inside an `Optional`, refused in both directions. `null` is
	// no second spelling, since JSON turns `undefined` into it.
	function nestedOptional(at: Path | null, step: Step): EssenceMarshalError {
		let where = spell(at, step)

		return new EssenceMarshalError(
			`${where}: an Optional inside an Optional has no JavaScript spelling — both levels would be 'undefined', and '#Value(#Empty)' is not '#Empty'.`,
			where,
		)
	}

	// A Union of colliding bare Cases, as `bareCaseCollision` describes it. The
	// fix is in the Essence source. Marked as inside, since no value could avoid
	// a refusal of the shape.
	function ambiguousBareCase(
		shown: string,
		collision: string,
		at: Path | null,
		step: Step,
	): EssenceMarshalError {
		let where = spell(at, step)

		return new EssenceMarshalError(
			`${where}: '${shown}' has no unambiguous JavaScript spelling — ${collision}. Wrap one side in a Record or give the Case a payload.`,
			where,
			true,
		)
	}

	// A bare Case written as a `$case` object, answered with the string to
	// write instead.
	function objectSpelledCase(
		shown: string,
		named: string,
		at: Path | null,
		step: Step,
	): EssenceMarshalError {
		let where = spell(at, step)

		return new EssenceMarshalError(
			`${where}: expected ${shown}, which crosses as the string "${named}" rather than as a '$case' object.`,
			where,
			true,
		)
	}

	// A Dictionary written as a plain object, answered with the shape to write.
	// An object is no second spelling: it puts integer-looking keys first,
	// whatever order they were written in.
	function objectSpelledDictionary(
		shown: string,
		at: Path | null,
		step: Step,
	): EssenceMarshalError {
		let where = spell(at, step)

		return new EssenceMarshalError(
			`${where}: expected ${shown}, which crosses as a Map rather than as a plain object — 'new Map(Object.entries(…))' builds one.`,
			where,
			true,
		)
	}

	// Two Map keys that are one Dictionary key, as `1` and `1n` are, or a String
	// in two Unicode spellings.
	function duplicateKey(at: Path | null, step: Step): EssenceMarshalError {
		let where = spell(at, step)

		return new EssenceMarshalError(
			`${where}: this key is already held — a Map tells its keys apart by '===' where a Dictionary tells them apart by the key Type's own equality, so two entries of this Map are one entry of it.`,
			where,
		)
	}

	// Dictionary keys that are one JavaScript value, refused rather than
	// handed over short.
	function collidingKeys(
		at: Path | null,
		step: Step,
		held: number,
		spelled: number,
	): EssenceMarshalError {
		let where = spell(at, step)

		return new EssenceMarshalError(
			`${where}: this Dictionary's ${held} keys are ${spelled} JavaScript value${
				spelled === 1 ? "" : "s"
			} — a Map tells its keys apart by '===' where the Module tells them apart by the key Type's own 'is', so a Map of it would not hold them all.`,
			where,
		)
	}

	// A Dictionary where the bundle carries no door for one. See "Values from
	// the bundle" in DEVELOPMENT.md.
	function noDictionaryDoor(
		at: Path | null,
		step: Step,
	): EssenceMarshalError {
		let where = spell(at, step)

		return new EssenceMarshalError(
			`${where}: this bundle carries no Dictionary door — it was built for a boundary that declares none, so a Dictionary can only have reached this position through something the boundary does not name. Declare it: give the member a Type, or export a Dictionary somewhere on the boundary.`,
			where,
		)
	}

	// Work anywhere but a call's answer, which alone says when it should run.
	// Marked as inside, since it refuses the shape.
	function asynchronyInsideValue(
		shown: string,
		at: Path | null,
		step: Step,
	): EssenceMarshalError {
		let where = spell(at, step)

		return new EssenceMarshalError(
			`${where}: a ${shown} is work rather than a value, and work crosses only as a call's answer — inside a value there is nothing to say when it should run. Answer it from a Function, or complete it and hand the value over.`,
			where,
			true,
		)
	}

	// Work handed in by a host. No JavaScript value is a Future, so the advice
	// differs from `asynchronyInsideValue`.
	function asynchronyFromHost(
		shown: string,
		at: Path | null,
		step: Step,
	): EssenceMarshalError {
		let where = spell(at, step)

		return new EssenceMarshalError(
			`${where}: a ${shown} can not be built from a JavaScript value — a Promise is an answer that has not arrived, not a description that can be run. Work crosses INTO a Module as a callback declared to answer one, which is called at every start; pass such a Function, or hand the value over.`,
			where,
			true,
		)
	}

	// Work where the bundle carries no door for it. Undeclared work meets
	// `asynchronyInsideValue` first, so here the Descriptor and the bundle come
	// from two compiles.
	function noFutureDoor(at: Path | null, step: Step): EssenceMarshalError {
		let where = spell(at, step)

		return new EssenceMarshalError(
			`${where}: this bundle carries no asynchrony door — it was built for a boundary that names no Future and no Started, so it is not the bundle this Descriptor was written for. Build the two together: 'loadModule', a bundler plugin, or 'esc build --embed'.`,
			where,
		)
	}

	function collidingCase(
		at: Path | null,
		step: Step,
		inside = false,
	): EssenceMarshalError {
		let where = spell(at, step)

		return new EssenceMarshalError(
			`${where}: this Case can not be marshalled — its payload declares a member named '$case', which is the name the Case tag is carried under.`,
			where,
			inside,
		)
	}

	function foreignValue(
		value: unknown,
		at: Path | null,
		step: Step,
	): EssenceMarshalError {
		let where = spell(at, step)

		return new EssenceMarshalError(
			`${where}: this value did not come from this Module — ${describe(
				value,
			)}.`,
			where,
		)
	}

	function undecidableSignature(
		shown: string,
		at: Path | null,
		step: Step,
	): EssenceMarshalError {
		let where = spell(at, step)

		return new EssenceMarshalError(
			`${where}: a Function carries no Type of its own, and ${shown} declares more than one signature it could be — which of them to marshal a call against is undecidable.`,
			where,
		)
	}

	// What the value is, in one clause, for an Error. Never the whole value,
	// which may be huge.
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

		// A Promise has no own keys, and would read as an empty object.
		if (value instanceof Promise) {
			return "a Promise, which crosses only where the Module declared a Future"
		}

		// A Map has no own keys either.
		if (value instanceof Map) {
			return value.size === 0
				? "an empty Map"
				: `a Map of ${value.size} ${value.size === 1 ? "entry" : "entries"}`
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

		// An Essence value of this bundle, named by its tag.
		let tag = (value as Record<symbol, unknown>)[typeKey]

		if (typeof tag === "string") {
			// A Case as a host reads it, `Shape#Circle`, without the Module.
			return `an Essence ${tag.includes("#") ? caseName(tag) : tag} value`
		}

		// Tagged by another copy of the runtime (`mintedTypeKeys`).
		let foreign = foreignTag(value, typeKey)

		if (foreign !== null) {
			return `an Essence ${foreign} value from another copy of the runtime — a previous load of this Module, or a different bundle — which this Module can not recognise`
		}

		let keys = Object.keys(value)

		return keys.length === 0
			? "an empty object"
			: `an object with ${quoted(keys)}`
	}

	// #endregion

	return {
		// `undefined` and `null` both mean nothing was declared.
		toJS: (value, path = "value", expected) =>
			expected === undefined || expected === null
				? toJS(value, null, path, null)
				: compileOut(expected)(value, null, path),
		fromJS: (value, expected, path = "value") =>
			compileIn(expected)(value, null, path),
		compileIn: (expected, path = "value") => {
			let read = compileIn(expected)

			return (value) => read(value, null, path)
		},
		compileOut: (expected, path = "value") => {
			let read = compileOut(expected)

			return (value) => read(value, null, path)
		},
		wrapFunction,
	}
}

// The keys the shape does not name, or `null`. The Array is built on the first,
// so a fitting value allocates nothing.
function undeclaredOf(
	given: Record<string, unknown>,
	declared: Set<string>,
	cased: boolean,
): Array<string> | null {
	let undeclared: Array<string> | null = null

	for (let name of Object.keys(given)) {
		if (declared.has(name) || (cased && name === "$case")) {
			continue
		}

		if (undeclared === null) {
			undeclared = []
		}

		undeclared.push(name)
	}

	return undeclared
}

// #region Binding

// The Module's exports for a host to use, and the bundle's own bindings.
export type ModuleBindings = {
	// Marshalled values, callable Functions, and Namespaces as plain objects.
	exports: Readonly<Record<string, unknown>>
	// The bundle's own bindings under the names their author wrote.
	raw: Readonly<Record<string, unknown>>
}

export type BindOptions = {
	// This bundle's Type key and value constructors. Another bundle's bridge
	// would build values this Module can not read.
	bridge: RuntimeBridge
	// The host's stop, the root of every run this binding starts.
	signal?: AbortSignal
}

type Callable = (...args: Array<unknown>) => unknown

export function bind(
	bundle: Record<string, unknown>,
	descriptor: ModuleDescriptor,
	options: BindOptions,
): ModuleBindings {
	let interpreter = createInterpreter(options.bridge, descriptor, {
		signal: options.signal,
	})
	let raw = bindRaw(bundle, descriptor)
	let exports: Record<string, unknown> = {}

	for (let [name, entry] of Object.entries(descriptor.exports)) {
		// An Overload set binds no name, so it is bound to a refusal that
		// says where its Overloads are.
		if (entry.kind === "overloaded") {
			exports[name] = overloadedCall(entry.overloads, name)

			continue
		}

		// A Choice binds nothing either, so its constructors are built here.
		if (entry.kind === "choice") {
			exports[name] = caseConstructors(entry.cases)

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

// The bundle's bindings under their written names, read through the emitted
// names the Descriptor carries. A name the bundle does not bind is left out
// rather than bound to `undefined`.
function bindRaw(
	bundle: Record<string, unknown>,
	descriptor: ModuleDescriptor,
): Readonly<Record<string, unknown>> {
	let raw: Record<string, unknown> = {}

	for (let [name, entry] of Object.entries(descriptor.exports)) {
		// Each Overload is bound under a name of its own, and so is each put
		// on `raw`.
		if (entry.kind === "overloaded") {
			for (let overload of entry.overloads) {
				if (overload.emitted in bundle) {
					raw[overload.name] = bundle[overload.emitted]
				}
			}

			continue
		}

		// A Choice binds nothing in the bundle, so `raw` has nothing for it.
		if (entry.kind === "choice") {
			continue
		}

		if (entry.emitted in bundle) {
			raw[name] = bundle[entry.emitted]
		}
	}

	return Object.freeze(raw)
}

// Each Case of a Choice under its own name: a Function of its payload, the
// value itself, or for a unit Choice the string it crosses as. Nothing is
// checked here, since the crossing checks. The tag is written last.
function caseConstructors(
	cases: Array<CaseDescriptor>,
): Readonly<Record<string, unknown>> {
	let constructors: Record<string, unknown> = {}

	for (let descriptor of cases) {
		let tag = `${descriptor.choice}#${descriptor.name}`

		constructors[descriptor.name] = descriptor.unitChoice
			? descriptor.name
			: Object.keys(descriptor.payload).length === 0
				? Object.freeze({ $case: tag })
				: (payload: Record<string, unknown>) => ({
						...payload,
						$case: tag,
					})
	}

	return Object.freeze(constructors)
}

// A constant is marshalled on each read. An unmappable one then refuses only
// itself, and each read hands back a fresh value a host may change freely. The
// Descriptor is compiled once, here.
function defineConstant(
	target: Record<string, unknown>,
	key: string,
	read: () => unknown,
	descriptor: Descriptor,
	name: string,
	interpreter: Interpreter,
): void {
	let marshal = interpreter.compileOut(descriptor, name)

	Object.defineProperty(target, key, {
		get: () => marshal(read()),
		enumerable: true,
	})
}

// Only the compiler can pick an Overload, from the Argument Types. The name is
// bound to a refusal that lists the Overloads.
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

// A Namespace, emitted as a class, as a plain object of its statics. An
// instance Method takes its receiver first, as in `Point.shifted(point, 4n)`.
// Own members only, since a class inherits `name` and `call` from `Function`.
function bindNamespace(
	value: unknown,
	descriptor: NamespaceDescriptor,
	interpreter: Interpreter,
): Readonly<Record<string, unknown>> {
	let namespace = value as Record<string, unknown>
	let bound: Record<string, unknown> = {}

	// The constructors of a Choice of the same name, first, so a member the
	// Module declares replaces one.
	for (let [name, constructor] of Object.entries(
		caseConstructors(descriptor.cases ?? []),
	)) {
		bound[name] = constructor
	}

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

// The Arguments in the emitted Function's order. A Function with every
// Parameter labelled also takes one object keyed by exactly the labels. A
// labelled call answers a new Array, so `ordered !== args` marks it.
function readCall(
	args: Array<unknown>,
	signature: FunctionDescriptor,
	labels: Array<string> | null,
	name: string,
): Array<unknown> {
	if (labels !== null && args.length === 1) {
		let given = plainObject(args[0])

		if (given !== null) {
			let keys = Object.keys(given)

			if (sameNames(keys, labels, signature.parameters)) {
				let count = labels.length
				// oxlint-disable-next-line unicorn/no-new-array -- the length, as above
				let ordered: Array<unknown> = new Array(count)

				for (let position = 0; position < count; position++) {
					let label = labels[position]!
					let optional =
						signature.parameters[position]?.optional === true

					// An absent key and one written `undefined` are the same
					// call, as TypeScript's `label?: T` allows.
					ordered[position] =
						Object.hasOwn(given, label) &&
						!(optional && given[label] === undefined)
							? given[label]
							: OMITTED
				}

				return ordered
			}

			// One object that is not a labelled call is only a positional
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

	let total = signature.parameters.length

	// A positional call may stop early only where every Parameter it stops
	// BEFORE carries a default. Counting the omittable ones instead would admit
	// `cut(7n)` against `(from: Integer = 1, to: Integer)` — one Argument, one
	// default, the count agrees — and pad the REQUIRED `to` with a hole, which
	// the native then reads as `undefined`. Which Parameters are left out is the
	// question, never how many.
	if (args.length > total || !omittableFrom(signature, args.length)) {
		throw new EssenceCallError(
			`${callShape(signature, labels, name)}; ${count(
				args.length,
				"Argument",
			)} ${args.length === 1 ? "was" : "were"} passed.`,
		)
	}

	// The holes are filled here so that the bridge below reads one Array of
	// the signature's own length however the call was written — a Parameter the
	// call stopped before, and one written as an explicit `undefined`, which the
	// `.d.ts` admits for an omittable slot and which means the same thing.
	let holes = args.length < total

	for (let position = 0; !holes && position < total; position++) {
		holes =
			args[position] === undefined &&
			signature.parameters[position]!.optional === true
	}

	if (!holes) {
		return args
	}

	// oxlint-disable-next-line unicorn/no-new-array -- the signature's length
	let filled: Array<unknown> = new Array(total)

	for (let position = 0; position < total; position++) {
		filled[position] =
			position >= args.length ||
			(args[position] === undefined &&
				signature.parameters[position]!.optional === true)
				? OMITTED
				: args[position]
	}

	return filled
}

// Whether a positional call that wrote `written` Arguments may stop there
// — which is whether every Parameter from that position on carries a default.
function omittableFrom(
	signature: FunctionDescriptor,
	written: number,
): boolean {
	for (
		let position = written;
		position < signature.parameters.length;
		position++
	) {
		if (signature.parameters[position]!.optional !== true) {
			return false
		}
	}

	return true
}

// How the Function may be called, as the first half of every refusal — the
// signature it was declared with, and both ways of writing a call to it. The
// caller who got one wrong is reading it to find the other.
//
// The name goes in FRONT of the signature, which is where `printSignature`
// writes one — a Descriptor carries the nameless print precisely so that the same
// signature can be named `labelled` here and `Point.shifted` one Namespace over.
function callShape(
	signature: FunctionDescriptor,
	labels: Array<string> | null,
	name: string,
): string {
	let total = signature.parameters.length
	let required = requiredCount(signature)
	let positions =
		required === total
			? count(total, "Argument")
			: `${required} to ${total} Arguments`

	return labels === null
		? `${name}${signature.shown} takes ${positions}`
		: `${name}${
				signature.shown
			} takes ${positions} positionally, or one object with the labels ${quoted(
				labels,
			)}`
}

// The labels a call may be written with, or `null` where it may not be
// written that way at all. Every Parameter has to carry one: a Function with a
// single `_` among its Parameters can not be called by label in Essence either,
// and half a labelled call is no call.
//
// A Function of ONE Parameter an object can inhabit is positional whatever
// its label says. Both readings take an object, and the Parameter is the one that
// can hold any shape at all — so `describe({ width: 3n, height: 4n })` passes the
// Rectangle rather than looking for a label named `width`, and a Union or an
// `Optional` with a Record among what it admits reads the same way. This is the
// whole of the ambiguity: with two Parameters or more the key set decides, since
// a labelled call's keys are the labels and a positional call passes no object.
export function labelsOf(signature: FunctionDescriptor): Array<string> | null {
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

// What an Error calls the Argument that went wrong. A labelled call has no
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

// Key-set equality is only right where every Parameter must be written.
// Once one carries a default the rule becomes "every REQUIRED label present, no
// key that is not a label" — which is exactly what an Essence call is held to,
// and which is still key-set equality for every signature that has no default.
function sameNames(
	given: Array<string>,
	expected: Array<string>,
	parameters: FunctionDescriptor["parameters"],
): boolean {
	if (given.length > expected.length) {
		return false
	}

	for (let name of given) {
		if (!expected.includes(name)) {
			return false
		}
	}

	for (let [position, label] of expected.entries()) {
		if (parameters[position]?.optional !== true && !given.includes(label)) {
			return false
		}
	}

	return true
}

// The value standing where a call left an Argument out — a slot it stopped
// before, or an omittable one written as an explicit `undefined`, which the
// generated `.d.ts` admits and which means the same thing. On a REQUIRED slot an
// `undefined` is a value the host passed and a Type error like any other, and
// stays one. The bridge hands `undefined` on for a slot holding this, which is
// precisely what fires the emitted JavaScript default parameter, and marshals
// nothing for it: there is nothing to marshal.
const OMITTED: unique symbol = Symbol("omitted")

// How many Arguments a call MUST write, which is where the range in
// `callShape` starts. Exported because the declaration generator asks the same
// question of the same Descriptor — see `lastRequiredIndex`.
export function requiredCount(signature: FunctionDescriptor): number {
	return signature.parameters.filter(
		(parameter) => parameter.optional !== true,
	).length
}

// The last Parameter a call has to write, and `-1` when there is none —
// where the TRAILING run a call may leave out entirely begins, and therefore the
// only run TypeScript lets a `?` be written on.
export function lastRequiredIndex(
	parameters: FunctionDescriptor["parameters"],
): number {
	let last = -1

	for (let [index, parameter] of parameters.entries()) {
		if (parameter.optional !== true) {
			last = index
		}
	}

	return last
}

// #endregion

// #region Wording

// Bounded, for the reason the note above `describe` gives: the object being
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

// The spelling a Case is known by on this side — the Choice as it was
// DECLARED and the Case, with the Module path a bundle qualifies its tags with
// taken back off. `./Geometry.es#Shape#Circle` is `Shape#Circle` here: a host
// writes what it reads in the Essence source, and never where the file happened
// to sit on the machine that compiled it.
//
// Read off the VALUE's tag rather than off a Descriptor, because a value
// coming out is met by its tag alone — this is the same rule `displayChoiceName`
// states, applied to the Choice half of a tag.
function caseName(tag: string): string {
	let separator = tag.lastIndexOf("#")
	let choice = tag.slice(0, separator)

	return `${choice.slice(choice.lastIndexOf("#") + 1)}#${tag.slice(
		separator + 1,
	)}`
}

// What an `Optional` holds, or `null` where the shape is not one. The
// sibling of `dts.ts`'s `optionalItem`, with `admitsAbsence` beside it — that is
// the copy a change to the Optional rule has to be kept in step with, since it
// decides what a DECLARATION says about the same shape. The Compiler's
// `describeUnion` states the rule a third time, from the other side of the seam:
// it is where the pair of Cases becomes the one node both of these read. All
// three are asked of a Union because a lone `#Value` arm can reach one.
function optionalItemOf(descriptor: Descriptor): Descriptor | null {
	switch (descriptor.kind) {
		case "optional":
			return descriptor.of
		case "case":
			return descriptor.optional && descriptor.name === "Value"
				? (descriptor.payload.item?.of ?? null)
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

// Whether `undefined` is a value of this shape — which is exactly whether
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

// Whether a plain object could BE a value of this shape — a Record anywhere
// it reaches without a tag in the way: itself, an arm of a Union, the item of an
// `Optional`, which is transparent on this side. A Case does not count, because
// its object spelling always carries `$case`, which no set of labels is — and a
// unit Choice's Case is not an object at all, being the string it crosses as.
// What it decides is whether a single labelled Parameter's labelled call is
// ambiguous — see `labelsOf`.
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
				admitsRecord(descriptor.payload.item.of)
			)
		case "union":
			return descriptor.arms.some(admitsRecord)
		default:
			return false
	}
}

// The signatures a shape declares a Function to have, for the way OUT — one
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

// What a container's pieces were DECLARED as, where the Descriptor says —
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

// The two slots a Dictionary's pieces were DECLARED as, read for the same
// reason `listItemOf` reads a List's item and answering `null` under the same
// rule: a Union offering two Dictionaries does not decide, and the entries still
// cross as their own tags say.
function dictionaryPartsOf(
	descriptor: Descriptor | null,
): { key: Descriptor; value: Descriptor } | null {
	if (descriptor === null) {
		return null
	}

	switch (descriptor.kind) {
		case "dictionary":
			return { key: descriptor.key, value: descriptor.value }
		case "union": {
			let candidates = descriptor.arms
				.map(dictionaryPartsOf)
				.filter(
					(parts): parts is { key: Descriptor; value: Descriptor } =>
						parts !== null,
				)

			return candidates.length === 1 ? candidates[0]! : null
		}
		default:
			return null
	}
}

function recordMembersOf(
	descriptor: Descriptor | null,
): DescribedMembers | null {
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
					(members): members is DescribedMembers => members !== null,
				)

			return candidates.length === 1 ? candidates[0]! : null
		}
		default:
			return null
	}
}

// The Case a value's own tag names, where what was declared carries that
// Case — its payload, so a Function inside one crosses out wrapped like any
// other member, and whether it is a unit Choice's Case, which nothing but a
// Descriptor knows. Both tags are the bundle's spelling, because a Descriptor
// bakes the one `emittedIdentity` writes.
function caseFor(
	descriptor: Descriptor | null,
	tag: string,
): CaseDescriptor | null {
	if (descriptor === null) {
		return null
	}

	switch (descriptor.kind) {
		case "case":
			return descriptor.tag === tag ? descriptor : null
		case "union": {
			for (let arm of descriptor.arms) {
				let found = caseFor(arm, tag)

				if (found !== null) {
					return found
				}
			}

			return null
		}
		default:
			return null
	}
}

// The `typeof` families a Descriptor's reader could take a value from,
// or `null` for one that has to be tried to be known. Conservative on purpose:
// a family named here is one the arm MIGHT take, and a family left out is one
// it can not — a bare Case names `object` as well as `string`, because the
// `$case` object it used to cross as is met there and refused in a sentence of
// its own, and that sentence is the arm's to give.
function familiesOf(descriptor: Descriptor): Set<string> | null {
	switch (descriptor.kind) {
		case "integer":
			return new Set(["bigint", "number"])
		case "rational":
			return new Set(["bigint", "number", "object"])
		case "string":
			return new Set(["string"])
		case "boolean":
			return new Set(["boolean"])
		case "list":
		case "dictionary":
		case "record":
			return new Set(["object"])
		case "case":
			return descriptor.optional
				? null
				: descriptor.unitChoice
					? new Set(["string", "object"])
					: new Set(["object"])
		case "optional": {
			let inner = familiesOf(descriptor.of)

			if (inner === null) {
				return null
			}

			return new Set([...inner, "undefined", "object"])
		}
		case "union": {
			let found = new Set<string>()

			for (let arm of descriptor.arms) {
				let inner = familiesOf(arm)

				if (inner === null) {
					return null
				}

				for (let family of inner) {
					found.add(family)
				}
			}

			return found
		}
		case "function":
			return new Set(["function"])
		// Neither can take a value at all on the way in, and both are
		// answered the way `refused` is rather than with an empty Set: an arm
		// that has to be TRIED is an arm whose own sentence is the one a reader
		// gets, and "work can not be built from a JavaScript value" is worth
		// more than the Union's own mismatch.
		case "future":
		case "started":
		case "refused":
			return null
	}
}

// Every string a Union of bare Cases takes, under the tag it answers —
// both spellings of every Case — or `null` where the Union holds anything
// else, which is a Union that has to be searched. Nested Unions of bare Cases
// are read through, since that is how a Choice's Cases reach a Union that
// names the Choice beside another.
function bareCaseTable(descriptor: Descriptor): Map<string, string> | null {
	let table = new Map<string, string>()

	return collectBareCaseTable(descriptor, table) ? table : null
}

function collectBareCaseTable(
	descriptor: Descriptor,
	table: Map<string, string>,
): boolean {
	switch (descriptor.kind) {
		case "case":
			if (!descriptor.unitChoice) {
				return false
			}

			table.set(descriptor.name, descriptor.tag)
			table.set(`${descriptor.choice}#${descriptor.name}`, descriptor.tag)

			return true
		case "union":
			return descriptor.arms.every((arm) =>
				collectBareCaseTable(arm, table),
			)
		default:
			return false
	}
}

// Which arm of a Union of CASES each `$case` a host could write names —
// both spellings of every Case that crosses as an object — or `null` where any
// arm is something else. Cases only, because the search below lets the FIRST
// arm that takes a value win, and an arm that is not a Case is one whose
// answer for an object carrying a `$case` can not be read off the tag; a Choice
// is the shape this is for, and a Choice is Cases and nothing else. A tag
// written twice keeps its first arm, as the search would.
function caseArmTable(descriptor: {
	arms: Array<Descriptor>
}): Map<string, number> | null {
	let table = new Map<string, number>()

	for (let [position, arm] of descriptor.arms.entries()) {
		if (arm.kind !== "case" || arm.optional) {
			return null
		}

		if (arm.unitChoice) {
			continue
		}

		for (let spelling of [arm.name, `${arm.choice}#${arm.name}`]) {
			if (!table.has(spelling)) {
				table.set(spelling, position)
			}
		}
	}

	return table.size === 0 ? null : table
}

// Every Case of a unit Choice a whole Module names, under its tag and
// answering the bare string it crosses as. Read ONCE, when an interpreter is
// built, because it is a property of the declarations rather than of anything
// that happens afterwards — and read at all because the general walk has no
// other way to learn it: `caseFor` above can only answer where the position
// being crossed declared the Case, and a `toJS` with nothing declared is the
// door a host reaches for exactly when it has no Type to hand over.
//
// The whole Descriptor rather than its Choice exports alone. A Choice a
// Module does not export by name still reaches a host through the Type of
// something it does — a Function's return, a Record's member, a Namespace's
// property — and a table holding only the named ones would spell those Cases
// one way at a declared position and another way at an undeclared one, which is
// the disagreement this table exists to prevent.
function bareCaseNames(module: ModuleDescriptor): Map<string, string> {
	let found = new Map<string, string>()

	for (let entry of Object.values(module.exports)) {
		switch (entry.kind) {
			case "constant":
			case "function":
				collectBareCases(entry.of, found)

				break
			case "overloaded":
				for (let overload of entry.overloads) {
					collectBareCases(overload.of, found)
				}

				break
			case "choice":
				for (let descriptor of entry.cases) {
					collectBareCases(descriptor, found)
				}

				break
			case "namespace":
				for (let property of Object.values(entry.properties)) {
					collectBareCases(property.of, found)
				}

				for (let method of Object.values(entry.methods)) {
					if (method.kind === "function") {
						collectBareCases(method.of, found)

						continue
					}

					for (let overload of method.overloads) {
						collectBareCases(overload.of, found)
					}
				}

				for (let descriptor of entry.cases ?? []) {
					collectBareCases(descriptor, found)
				}

				break
		}
	}

	return found
}

// No guard against walking a node twice, because a Descriptor is a TREE —
// `describe` answers a Type that reaches itself with a `refused` node rather
// than following it — which is the same reason compiling a node's children
// while compiling the node terminates.
function collectBareCases(
	descriptor: Descriptor,
	found: Map<string, string>,
): void {
	switch (descriptor.kind) {
		// A Future and a Started are walked THROUGH, because what they
		// answer with is a value that crosses: a `Future<Direction>` answered by
		// a Function puts that Choice's Cases on this boundary exactly as a
		// `List<Direction>` does.
		case "list":
		case "optional":
		case "future":
		case "started":
			collectBareCases(descriptor.of, found)

			return
		case "dictionary":
			collectBareCases(descriptor.key, found)
			collectBareCases(descriptor.value, found)

			return
		case "record":
			for (let member of Object.values(descriptor.members)) {
				collectBareCases(member.of, found)
			}

			return
		case "union":
			for (let arm of descriptor.arms) {
				collectBareCases(arm, found)
			}

			return
		case "case":
			if (descriptor.unitChoice) {
				found.set(descriptor.tag, descriptor.name)
			}

			for (let member of Object.values(descriptor.payload)) {
				collectBareCases(member.of, found)
			}

			return
		case "function":
			for (let parameter of descriptor.parameters) {
				collectBareCases(parameter.of, found)
			}

			collectBareCases(descriptor.returns, found)

			return
		default:
			return
	}
}

// A JavaScript object with members, and nothing that merely is one: an
// Array is a List's shape, an `EssenceRational` is a Rational's and a `Map` is a
// Dictionary's, so admitting any of them as a Record would make the shape that
// named it unreachable.
//
// A labelled call asks the very same question of its one Argument — an
// `EssenceRational` passed to a Function whose labels happen to be `numerator`
// and `denominator` is a Rational, not a labelled call — which is why `readCall`
// reads through this rather than through a spelling of its own.
function plainObject(value: unknown): Record<string, unknown> | null {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		value instanceof EssenceRational ||
		value instanceof Map
	) {
		return null
	}

	return value as Record<string, unknown>
}

// #endregion
