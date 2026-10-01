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

// The run-time half of the boundary: every conversion, refusal and call, over
// Descriptors. Nothing here may lead to the compiler. See "The interpreter" in
// DEVELOPMENT.md.

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

	// What a call ANSWERS with, which is the one position asynchronous
	// work crosses at — `Future<T>` and `Started<T>` come back as a `Promise` of
	// what they answer with, and everywhere else they are refused. The rule is
	// here rather than in `buildOut` because it is a rule about the POSITION: a
	// Function's answer is where a Program said work would be handed over, and a
	// Record's member is where it said a value would be.
	//
	// Every other shape goes to the ordinary door, memo table and all —
	// this is one branch in front of it, not a second reading of anything.
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

	// The compiled way out for a Descriptor, or the value-directed walk
	// where a position declared nothing — the one place the two doors meet, so
	// that a piece whose shape was declared is read through its own rule and a
	// piece whose shape was not is still read.
	function out(expected: Descriptor | null): Outbound {
		return expected === null ? anyOut : compileOut(expected)
	}

	function anyOut(value: unknown, at: Path | null, step: Step): unknown {
		return toJS(value, at, step, null)
	}

	// The members of a Record or the payload of a Case, each compiled —
	// twice over, in the two ways a member is looked for. Memoised against the
	// members object itself, because the general walk below reaches for it per
	// value.
	//
	// The names IN THE TYPE'S ORDER beside the readers, because a value the
	// Module built against this Type carries its members in that order — so the
	// reader a position wants is almost always the one standing at the same
	// position, found by comparing two names rather than by hashing one. And the
	// map for every other value: a Record of another shape entirely, a member the
	// Type does not name, a payload written in another order. Both spellings
	// answer the same thing, because they are built out of the same members.
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

	// A signature's half of a call, compiled — the half that is fixed the
	// moment the Module declares the Function, which is everything but the
	// Function itself and the name an Error calls it. Memoised against the
	// FunctionDescriptor, because a Function is the one Essence value whose
	// crossing BUILDS something: a Module Function answering with a closure
	// wraps a new one on every call, and a host reading a constant that holds
	// one wraps a new one on every property read, since a constant is marshalled
	// where it is read. Without this, that crossing walks the Parameters four
	// times over and spells every `argument N` again for each.
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
				// The same Array where no labels may be written, rather
				// than a second one holding the same strings — `readCall`
				// answers the Arguments it was passed where it did not reorder
				// them, and the two spellings are then told apart by identity.
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

	// A whole Array of one shape rather than one value of it — the items of
	// a List, walked by the loop the ITEM's kind picks, picked once where the
	// List is compiled and never looked at again.
	//
	// This is the ONE place where compiling to closures costs something
	// interpreting did not, and so the one place a rule is written twice. A loop
	// that calls a converter it was handed can not see what it is calling: every
	// List in a Module reaches the SAME loop, whose one call is made against
	// Integers here, Strings there and whole Lists one level up — so an engine
	// that would have folded a leaf's two checks into the loop is left making an
	// out-of-line call per item, and decided differently about it from run to
	// run, which is worse than deciding badly. The 8191-value call `BENCH.md`
	// measures took 126 µs on one run and 198 µs on the next through one loop for
	// everything; 124 µs every time through a loop that walks leaves alone; and
	// 111 µs every time through these.
	//
	// So a leaf's admission is spelled here as well as in the branch of
	// `buildIn` that compiles the leaf on its own, and the two say the same
	// thing. They are two spellings of ONE rule rather than two rules — a value
	// met on its own and the same value met inside a List are the same value —
	// so a difference between a loop here and its branch there is a bug and never
	// a decision.
	//
	// A Rational is walked by the loop at the bottom with everything else.
	// Its admission is three branches, a read of a double's bits and two
	// allocations, and a call per item is a small part of that — where an
	// Integer's is two type checks that the call itself outweighs.
	//
	// A hole in an Array is read as the `undefined` it holds, and admitted
	// only where the ITEM's shape admits absence. An Array with a gap in it is
	// not a List with a gap: `[1, , 3]` is refused where the items are Integers,
	// and crosses with `#Empty` in the middle where they are `Optional<Integer>`
	// — because every position of a List holds a value, and the position a hole
	// is at holds nothing.
	function runIn(
		item: Descriptor,
	): (source: Array<unknown>, at: Path) => Array<EssenceValue> {
		let shown = item.shown
		let read = compileIn(item)

		if (item.kind === "integer") {
			return (source, at) => {
				let count = source.length
				// The argument is the answer's LENGTH. The rule below suggests
				// `Array.from({ length })` instead, which fills through an iterator —
				// the very turn-by-turn work a walk written out like this avoids.
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

		// And everything else through its own converter, which is every
		// shape whose items are worth more than the call that reaches them —
		// a List of Lists, of Records, of Cases, of anything the two checks
		// above do not settle.
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

	// What a JavaScript value has to become to be this shape, as one
	// Function. Every branch is the branch the interpreter took per value, with
	// everything it could have decided without the value decided here instead: a
	// nested `Optional` is a refusal compiled to a throw, a Case's tag and the
	// two spellings it answers to are strings built once, and a Record's members
	// are an Array of readers in the order they are read.
	function buildIn(expected: Descriptor): Inbound {
		let shown = expected.shown

		switch (expected.kind) {
			case "integer":
				return (value, at, step) => {
					// Both kinds go in AS THEY ARE — the bridge's
					// `createInteger` canonicalises, so a bigint that fits a
					// double arrives as a number and a number that does not
					// arrives as a bigint, and neither caller has to know which
					// side of 2⁵³ its value sits.
					if (typeof value === "bigint") {
						return makeInteger(value)
					}

					// A number is admitted only where it is exactly an
					// integer a double can hold — `2 ** 53` is not one, and
					// taking it would hand the Module a value already off by
					// whatever the double had lost before it ever arrived.
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

					// Normalised on the way in, because String equality in
					// Essence is normalised — a composed `é` and a decomposed one
					// are one value there — and letting both spellings through
					// would put two values into the Module that it insists are
					// the same.
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

					// `bridge.list` copies what it is handed, so the Array
					// built here is copied once more before a List holds it. The
					// alternative was to bridge the runtime's own `createList`,
					// which takes ownership — and then this call would be safe
					// while a host's identical-looking one, on an Array the host
					// kept, would silently share a run with Essence.
					return makeList(items(value, { at, step }))
				}
			}
			// A `Map` and nothing else. Every key Type crosses, so what
			// is read is the entries rather than any spelling of a key — in
			// the order the Map holds them, which is the order a Dictionary
			// holds its own.
			//
			// The entries are marshalled HERE and the Dictionary is
			// built THERE. Which slot a key lands in, whether two keys are
			// one, and what a key encodes to are the runtime's own and stay
			// there: this side hands over an Array of pairs it does not keep,
			// exactly as it hands `bridge.list` an Array of items.
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
						// An object is what a host reaches for first
						// where the keys are Strings, so it is answered with
						// the shape to write instead of with the Type it
						// already named — see `objectSpelledDictionary`.
						throw plainObject(value) === null
							? mismatch(value, shown, at, step)
							: objectSpelledDictionary(shown, at, step)
					}

					let inside: Path = { at, step }
					// oxlint-disable-next-line unicorn/no-new-array -- the length, as above
					let entries: Array<Entry> = new Array(value.size)
					let position = 0

					// One place per ENTRY, which both halves of it are
					// spelled below — `argument 1 → [2].value`. A Map has no
					// accessor that names one entry, so what an Error names is
					// the entry's position and the half of it that is wrong,
					// which is the vocabulary the language reads an entry by.
					for (let [key, held] of value) {
						let where: Path = { at: inside, step: position }

						entries[position] = [
							readKey(key, where, "key"),
							readValue(held, where, "value"),
						]
						position++
					}

					let built = build(entries)

					// The position of an entry whose key the Dictionary
					// already holds — two Map keys that are one key here. It
					// is answered rather than thrown because the place is this
					// side's to name; see `createDictionaryFrom`.
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
				// The members the callee's own default fills in, which a
				// host may therefore leave out. Absence has to reach the built
				// Record as a MISSING KEY rather than as an `undefined` one: the
				// callee reads `options.retries ?? 3`, and a key holding
				// `undefined` is exactly as absent to that as no key at all —
				// but `ownRecord` would carry it, and everything downstream
				// reads a Record's own keys.
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
					// The keys the value carries against the members the
					// Type names, IN ORDER — which answers both questions a
					// Record asks at once, wherever the two lists agree. A host
					// writing an object against a declaration writes the members
					// it declares in the order it declares them, and two lists of
					// the same length whose names match position by position name
					// the same set: every declared member is an own key of the
					// value, and the value carries no key the Type does not name.
					// So the members below are read straight off, and neither the
					// own-key check nor the search for an undeclared member has
					// anything left to find.
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

					// And every value the two lists did not settle, read
					// the long way — a member left out, a member the Type does
					// not name, or the very same members written in another
					// order.
					//
					// An absent key IS a value here — `undefined`, which is
					// exactly what an `Optional` member is spelled as — so what
					// the key holds is read and the member's own shape decides.
					// Refusing absence up front reported "expected
					// Optional<String>, got nothing" for a Type whose whole point
					// is that it accepts nothing, and made a Record that had been
					// through JSON — which drops an `undefined`-valued key —
					// impossible to hand back. A member that is not Optional
					// still fails, with the same sentence, where the sentence is
					// true.
					//
					// An OWN key, because an absent `toString` read plainly
					// finds `Object.prototype`'s — a function where the rule above
					// promises `undefined`.
					//
					// Unless the member is one the callee fills in, whose
					// absence is not a value at all — it is the caller saying
					// nothing, which is what the default is for. A key that IS
					// written goes to the reader like any other, `undefined` and
					// all: writing a member is writing it, and an Optional
					// member written `undefined` is `#Empty` exactly as it was.
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

					// Closed, unlike the Matcher a `case` narrows with. A
					// key the Type does not name is a mistake in the making — a
					// misspelled member, or a value from somewhere else entirely
					// — and taking it silently drops it, which is how a `widht`
					// gets as far as production.
					//
					// Looked for AFTER the members are read, so that a
					// value which is wrong in both ways is named by the member
					// that is wrong rather than by the one that is extra.
					let undeclared = undeclaredOf(given, declared, false)

					if (undeclared !== null) {
						throw undeclaredMembers(shown, undeclared, at, step)
					}

					return ownRecord(fields)
				}
			}
			case "optional": {
				// The refusal `toJS` makes for the same pair, made here
				// too: `#Value(#Empty)` and `#Empty` would both be `undefined`,
				// and Essence is explicit that they are two values. It is a fact
				// about the SHAPE rather than about any value of it, so a shape
				// that has it compiles to the refusal itself.
				if (admitsAbsence(expected.of)) {
					return (_value, at, step) => {
						throw nestedOptional(at, step)
					}
				}

				let item = compileIn(expected.of)

				// `Optional` is spelled by its ABSENCE on this side — `T |
				// undefined` — so it reads the value itself rather than a `$case`
				// on it. `null` is admitted beside `undefined` because JSON has
				// only the one of them; `undefined` is what comes back.
				//
				// This is the Union of `#Value` and `#Empty` with its two
				// arms run through: absence is the `#Empty` arm, anything else is
				// the `#Value` arm, and a refusal that got INSIDE the value is the
				// one the Union would have kept — `#Empty` never reaches inside
				// anything, so it can never be that one.
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
				// Before any arm is tried, because a nested Optional is
				// refused rather than answered and an arm's refusal is something
				// the next arm gets to overrule. A Union that offers an `Optional`
				// among its arms would otherwise let a later arm take the
				// `undefined` an earlier one had just refused — turning a shape
				// with no JavaScript spelling into a confident wrong answer.
				let item = optionalItemOf(expected)

				if (item !== null && admitsAbsence(item)) {
					return (_value, at, step) => {
						throw nestedOptional(at, step)
					}
				}

				// And the second shape a Union can be in that no
				// JavaScript value could be read into: a unit Choice's Case
				// crosses as its bare name, so `"Up"` standing beside a String
				// — or beside another Choice's `#Up` — is one string two arms
				// would both take. Asked BEFORE the arms are compiled, for the
				// reason the nested `Optional` above is: an arm that took the
				// value would be an arm that had already decided, and what is
				// wrong here is that there is nothing to decide it WITH.
				//
				// Refused rather than decided, which is the one place the
				// "first arm wins" stance the arms below are compiled under
				// does not reach. Deciding would hand a String `"Up"` back out
				// as a `Direction#Up`, and losing the value it was given is the
				// single thing this boundary may not do.
				let collision = bareCaseCollision(expected)

				if (collision !== null) {
					return (_value, at, step) => {
						throw ambiguousBareCase(shown, collision, at, step)
					}
				}

				let arms = expected.arms.map((arm) => compileIn(arm))
				let count = arms.length
				// Which JavaScript families each arm could take at all,
				// so that an arm is only TRIED where it could succeed. An arm
				// says no by throwing, and a thrown Error captures a stack —
				// which is nothing against a value that fits the first arm and
				// everything against a tree of ten thousand values whose fit is
				// the third: two refusals built and discarded per value, and
				// most of a call spent inside the Error constructor. Skipping
				// an arm the family already rules out changes no answer: such
				// an arm never recognised the value, so it could neither have
				// taken it nor have been the one refusal worth reporting.
				let families = expected.arms.map((arm) => familiesOf(arm))

				// A Union of bare Cases and nothing else — a unit Choice
				// as a value of it is declared, which is the shape a status or
				// a kind is — is a lookup and no search: every string it can
				// take is known when the reader is compiled, under both of its
				// spellings, and answers the one shared instance. What is not
				// in the table falls through to the arms, so a miss is refused
				// in exactly the words it always was.
				let named = bareCaseTable(expected)

				// And the same for the Cases that cross as objects: which
				// arm a `$case` names is known when the reader is compiled, so
				// an object that names one is handed to that arm and no other.
				// The arm's own refusal — a payload member wrong under a
				// recognised tag — is then the ONE refusal, which is what the
				// search below would have concluded after trying the rest.
				let tagged = caseArmTable(expected)

				// In declaration order, and the first arm that admits the
				// value is the one it becomes. Overlapping arms are therefore
				// DECIDED rather than ambiguous: `Optional<String> | Integer`
				// makes a String out of `"7"` because `Optional<String>` is
				// written first, not because anything weighed the two.
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

					// Built on the first refusal rather than before the
					// first arm — an arm that takes the value is the whole of
					// what usually happens, and it should leave nothing behind.
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
			// Work can not be BUILT from a JavaScript value. A Future is a
			// description of Essence work and a Started is one run of it, and
			// what a host holds instead is a `Promise` — an answer that has not
			// arrived, which describes nothing and can not be run again. The one
			// place a host says "work" is a callback the Module calls: the
			// callback is the description, and `buildCallbackIn` is where that
			// is read.
			case "future":
			case "started":
				return (_value, at, step) => {
					throw asynchronyFromHost(shown, at, step)
				}
			// Everything the boundary has no mapping for, refused in the
			// words the Compiler wrote when it still had the Type to name.
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

		// One of `Optional`'s own Cases, met without the other — which is
		// what `constant thing = Optional<Integer>#Value(3)` infers, a Case
		// rather than the Union an annotation would have named. The pair is
		// collapsed into an `optional` before it ever reaches here, so this is
		// the lone arm, read by the rule the pair is read by.
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

			// A `#Value` carrying nothing, and a `#Value` carrying another
			// absence — neither is a shape any value has, so both are the whole
			// of what this Case compiles to.
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

		// A Case of a unit Choice is the STRING of its own name and
		// nothing else — `"Up"`, or the `"Direction#Up"` the source itself
		// would write. Both spellings, exactly as the object form below takes
		// both; the difference is that they are the value rather than a member
		// on it, which is the whole ergonomic point of the rule.
		//
		// The object form is not kept as a second spelling. One shape has
		// one spelling here: a position that took `{ $case: 'Up' }` as well
		// would be a position two different JavaScript values cross into, while
		// the way out can only ever hand one of them back — so a round trip
		// through it would silently rewrite what a host wrote.
		if (expected.unitChoice) {
			let named = expected.name
			let spelled = `${expected.choice}#${expected.name}`

			return (value, at, step) => {
				if (value === named || value === spelled) {
					// No payload at all, for the reason the payload-less
					// branch below gives — `createCase` hands out one shared
					// instance per unit Case tag, and a fresh `{}` would not be
					// the Module's own `#Up`.
					return makeCase(tag)
				}

				// The spelling this Case used to cross as, met where the
				// string is now the only one. Worth a sentence of its own,
				// because "expected Direction#Up, got an object with '$case'"
				// is true and says nothing about what to write instead.
				//
				// Marked as having reached INSIDE the value, so that a
				// Union of the Choice's Cases answers with this sentence rather
				// than with the Choice — exactly one arm can match a given
				// `$case`, which is the condition that rule asks for.
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

		// Either spelling of the same Case, both built here. `Shape#Circle`
		// is what `toJS` writes, and so what a round trip hands back; the bare
		// `Circle` is what the Essence source itself writes, where a `#Circle`
		// needs no Choice in front of it.
		let bare = expected.name
		let qualified = `${expected.choice}#${expected.name}`
		let colliding = Object.hasOwn(expected.payload, "$case")
		let names = Object.keys(expected.payload)
		let readers = names.map((name) => compileIn(expected.payload[name]!.of))
		// The value each member the Case's own default fills in is filled
		// WITH, built once here. Where a Record Parameter's default is written in
		// by the callee — the boundary leaves the key out and the Function's
		// prologue writes it — a Case has no callee: a constructor writes the tag
		// onto what it was handed and marshals nothing, so this is the only place
		// between a host's object and the Case it becomes.
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

			// The refusal `toJS` makes for the same Case, made here too.
			// The tag is written under `$case`, so a payload member of that name
			// has nowhere to sit: read it and the tag string becomes the member's
			// value, silently, and there is no way to pass any other. Coming out
			// it is refused; going in it has to be refused, or the boundary
			// accepts a value it can not then describe.
			if (colliding) {
				throw collidingCase(at, step, true)
			}

			let payload: Record<string, EssenceValue> = {}
			let inside: Path = { at, step }

			// The keys the value carries against the payload the Case
			// declares, IN ORDER, with the tag at one end or the other — the
			// two layouts a value of this Case is written in: `{ ...payload,
			// $case }` is what a constructor and `toJS` build, `{ $case,
			// ...payload }` is what a host writes by hand. Where the lists
			// agree, both questions are already answered — every declared
			// member is an own key and nothing undeclared is present — so the
			// members are read straight off, as the Record branch reads its own.
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
				// No payload at all rather than an empty one —
				// `createCase` hands out one shared instance per unit Case tag,
				// and passing `{}` would build a fresh object each time that the
				// Module's own `#Blank` is not.
				return makeCase(tag)
			}

			// An absent key is read as `undefined` — through an OWN-key
			// check, past what `Object.prototype` holds — and the member's own
			// shape decides, for the reasons the Record branch above states.
			//
			// Unless the Case's own default fills that member in, whose
			// absence is not a value at all but the host saying nothing, which
			// is what the default is for. A key that IS written goes to the
			// reader like any other, `undefined` and all — writing a member is
			// writing it — exactly as at a Record Parameter.
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

	// One JavaScript Function as an Essence one — the mirror image of
	// `wrapFunction`, and the only place the boundary is crossed by a call the
	// MODULE makes. What the Module hands the callback are its own values, so
	// they cross OUT; what the callback answers with is built against the
	// declared return, so it crosses IN. Every rule of both directions is the
	// same rule as everywhere else, applied at a call site the host wrote.
	//
	// Positionally, and never by label. A labelled call is how Essence
	// writes its own calls and how a host may write one INTO the Module; a
	// JavaScript Function takes its Arguments in order, and handing one an
	// object of labels would be this package inventing a calling convention
	// for code it did not write.
	//
	// The path a refusal inside the callback is spelled from is the path
	// the callback itself arrived at — `argument 2 → return value` — because
	// that is where a reader has to go to fix it. The Function that failed is
	// the one they passed at `argument 2`, not one of the Module's. It is
	// spelled once, where the callback arrives, rather than on every call the
	// Module then makes to it.
	function buildCallbackIn(signature: FunctionDescriptor): Inbound {
		let shown = signature.shown
		let count = signature.parameters.length
		let handed = signature.parameters.map((parameter) =>
			compileOut(parameter.of),
		)
		// A callback the Module calls for WORK rather than for a value —
		// declared `-> Future<T>`, which is the one way asynchronous work
		// crosses INTO a Module. What the host writes is an ordinary Function
		// answering a `Promise`; what the Module gets is a Future, and the two
		// differ in WHEN the host is called: a Future is a description, so the
		// call is made at every start and not one moment sooner. A host's
		// `(url) => fetch(url)` handed to a Parameter of this shape is therefore
		// a request that has not been made, and `::attempt(times 3)` over it
		// makes three.
		//
		// A `Started` answer is not a door of its own. A Started is one
		// run of the Module's own work and a host has no way to start one, so it
		// falls to the refusal in `buildIn` like every other position — see
		// `asynchronyFromHost`.
		let work =
			signature.returns.kind === "future" ? signature.returns : null
		let back = compileIn(work === null ? signature.returns : work.of)
		let makeWork = makeFuture

		return (value, at, step) => {
			if (typeof value !== "function") {
				throw mismatch(value, shown, at, step)
			}

			// Asked where the callback ARRIVES rather than where it is
			// called, because that is where a host can still be told what to do
			// about it: a refusal out of a call the Module made names a Function
			// the host passed pages earlier.
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

			// The Arguments cross when the MODULE calls the callback, and
			// the host is called when the work is STARTED. They are two moments
			// and the values belong to the first of them: the Module handed them
			// over when it built the future, and a start that read them again
			// would be reading values the Module may have moved on from.
			//
			// The context is not passed on. A host Function takes what its
			// own declaration says it takes, and handing it a fourth Argument it
			// never asked for would be this package inventing a calling
			// convention for code it did not write — the same reason a callback
			// is called positionally. A host that wants to be stopped can close
			// over an `AbortController` of its own; the README says so.
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

	// The way out compiled, and it is NOT the mirror of the way in. A value
	// coming out SAYS what it is, so what a Descriptor buys here is only the
	// expectation: the tag is read and compared against the one shape this
	// position declared, and where the two agree everything below is already
	// decided. Where they do not — a value the Module built out of an arm this
	// Descriptor did not name, a Type with no compiled rule — the general walk
	// below takes over with the same Descriptor and answers exactly as it did
	// before there was a compile step, which is what makes this an optimisation
	// rather than a second reading.
	function buildOut(expected: Descriptor): Outbound {
		switch (expected.kind) {
			// ALWAYS a bigint on the way out, whichever of its two
			// representations the Integer arrived in. An Integer holds a
			// JavaScript number while its value fits one and a bigint beyond that,
			// and handing that split across the boundary would make the TYPE of
			// what an embedding receives depend on the SIZE of the answer:
			// `total` would be a number until the day it crossed 2⁵³ and every `+`
			// on it started throwing. One kind out is the contract, and bigint is
			// the one that can carry every Integer.
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

				// An Optional is transparent — `Optional<T>` IS `T |
				// undefined` on this side — so the Case does not appear in the
				// answer, and the path gains no segment for it either. A host
				// reading `.item` off what came back would be reading the
				// Module's bookkeeping rather than its value.
				return (value, at, step) => {
					if (tagged(value, OPTIONAL_VALUE)) {
						let held = (value as { item: unknown }).item

						// Absence does not nest. `#Value(#Empty)` and
						// `#Empty` would both be `undefined` here, and Essence is
						// explicit that they are two values — so the pair is
						// refused rather than collapsed into the one of them a
						// round trip would hand back.
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
				// One of `Optional`'s own two Cases, met WITHOUT the other
				// — which is what `constant thing = Optional<Integer>#Value(3)`
				// infers, a Case rather than the Union an annotation would have
				// named. It is
				// spelled by ABSENCE on this side, so it is read by the walk
				// that owns that rule: reading it as a Case here would hand back
				// `{ $case: 'Optional#Value' }` where the boundary, the way in
				// and the generated declaration all promise the item itself.
				// The same exclusion `collectCases` makes for the arms of a
				// Union, made for the arm met alone.
				if (expected.optional) {
					return (value, at, step) => toJS(value, at, step, expected)
				}

				let tag = expected.tag

				// A unit Choice's Case IS its name on this side, so the
				// whole of the way out is that name: no payload to read, no
				// `$case` to write, nothing to walk. The tag still decides —
				// a value carrying another one is handed to the general walk
				// exactly as every other compiled reader hands it over.
				if (expected.unitChoice) {
					let named = expected.name

					return (value, at, step) =>
						tagged(value, tag)
							? named
							: toJS(value, at, step, expected)
				}

				// The Case as a host spells it, cut out of the tag once
				// here rather than out of every value that carries it.
				let name = caseName(tag)
				let members = compiledMembers(expected.payload)

				return (value, at, step) =>
					tagged(value, tag)
						? casedFields(value as object, at, step, members, name)
						: toJS(value, at, step, expected)
			}
			case "union": {
				// The same refusal the way in makes, in the same words
				// and before anything else is compiled. It is a fact about the
				// SHAPE rather than about any value of it — the position has no
				// unambiguous JavaScript spelling — so it holds whichever
				// direction the position is crossed in. Letting values out of a
				// position the way in refuses would be worse than refusing
				// both: a host would be handed `"Up"` and then told it can not
				// hand it back.
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

				// A Union names more than one shape and the VALUE says
				// which, so what is compiled is the CHOOSING: one reader per Case
				// the Union offers, under the tag its values carry. That is how a
				// Choice reaches this side and what a host meets on every answer
				// a `match` gives. Everything else among the arms — a List, a
				// Record, an `Optional`, which is spelled by absence rather than
				// by a tag — is left to the general walk, which decides between
				// them exactly as it did.
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
			// The one untagged Essence value, and the one place a Descriptor
			// decides the way out rather than merely confirming it — a Function is
			// emitted as a bare JavaScript function, so only what its position
			// declared can say what a call to one means.
			case "function":
				return (value, at, step) =>
					typeof value === "function"
						? wrapFunction(
								value as EssenceFunction,
								expected,
								spell(at, step),
							)
						: toJS(value, at, step, expected)
			// Work met somewhere other than a call's answer, which is the
			// one position it crosses at — see `compileAnswerOut`, which is the
			// door, and `asynchronyInsideValue`, which is the sentence. A fact
			// about the SHAPE rather than about any value of it, so it compiles
			// to the refusal itself.
			case "future":
			case "started":
				return (_value, at, step) => {
					throw asynchronyInsideValue(expected.shown, at, step)
				}
			// A Type the way IN has no mapping for is still a value on the
			// way out, and its tag says what it is — `Optional<Algebraic>` hands
			// back an Algebraic's own refusal rather than the Type Parameter's.
			case "refused":
				return (value, at, step) => toJS(value, at, step, expected)
		}
	}

	// A call's answer that has not run — the whole of the asynchrony door,
	// and the only place this boundary starts anything.
	//
	// A FUTURE is started here, once per call: what a Function answers with is a
	// description, and a host holding a `Promise` is holding a run. Each call
	// starts its own, which is what a Future means — two calls are two runs —
	// and the run belongs to a ROOT context made for it, with the host's own
	// signal above that root where the binding was given one.
	//
	// A STARTED is already in flight, and nothing here starts it again: what
	// crosses is the promise it holds. The host's signal is deliberately NOT
	// linked to one — `Started::within` states the same rule from inside the
	// language: a run belongs to whoever started it and may be waited for from
	// anywhere, so a deadline or a stop written by one holder may not stop the
	// work the others are waiting for.
	//
	// The value inside is marshalled when it ARRIVES, so a refusal of it
	// comes back as a rejected promise rather than as a throw at the call. There
	// is nowhere else for it to go: the value does not exist yet when the call
	// answers, which is the whole reason the position is a promise.
	//
	// The promise gains no segment of its own in the path. It is
	// transparent on this side exactly as an `Optional` is — a host awaiting a
	// call's answer reads the value, not a box around it — so a refusal inside
	// one is spelled from where the answer was.
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

			// A host that has already pulled its stop is a host that wants
			// nothing started. A Future has not run yet — the call above only
			// BUILT it — so there is nothing here to stop: it is simply not
			// started, and what the host holds is the promise a stopped run
			// answers with, which is none at all.
			//
			// A Started is not declined, for the reason it is not linked either:
			// the run was put in flight before this boundary saw it, and it
			// belongs to whoever started it.
			if (!started && hostSignal?.aborted === true) {
				return new Promise(() => {})
			}

			// A Started is waited for under a context of its own that
			// nothing reads — the runtime answers one with the promise it
			// already holds — so there is nothing to unlink afterwards either.
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

	// The context a run the boundary started belongs to: a root of its
	// own, with the host's signal linked above it where the binding was given
	// one. Per CALL, because two calls are two runs and one may not stop the
	// other — which is exactly what the Rewriter emits at a Program's top level,
	// a fresh root per site.
	//
	// `release` is what takes the link off again once the run is over, and
	// it is why the link is not simply left in place: a host signal lives as
	// long as the host does, and a listener per call on it would be a listener
	// per call that outlives the call. It is the same bookkeeping `childOf`
	// keeps in the runtime, kept here for the one link this side makes.
	function rootContext(makeContext: () => FutureContext): {
		context: FutureContext
		release: () => void
	} {
		let context = makeContext()

		if (hostSignal === undefined) {
			return { context, release: nothing }
		}

		// A signal that is aborted ALREADY aborts this context before
		// anything is run under it. The run is declined outright one level up,
		// where the answer is built — see `buildAnswerOut` — and this is what
		// makes a run that somehow reaches here read a signal that is already
		// pulled.
		//
		// What a MID-RUN abort does is cooperative, and the word for it is
		// signalled rather than stopped. Work suspended in a native that reads
		// the signal — `Async.sleep`, `Http.send`, and `::within` and `::race`
		// over either — stops there and answers nothing at all. Work already
		// running to its end runs to its end and answers: there is no point in
		// it at which anything could be taken away, because nothing between two
		// Statements reads a signal.
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

	// Every Case a Union offers, under the tag its values carry — nested
	// Unions walked in the order `caseFor` reads them and the first one under a
	// tag winning, so the compiled dispatch answers with the arm the general
	// walk would have found.
	//
	// `Optional`'s own two Cases are left out. They are spelled by ABSENCE
	// on this side rather than by a `$case`, which is a rule of the general walk
	// and not of the Case that carries the tag — dispatching to one would hand
	// back `{ $case: 'Optional#Value' }` where the boundary promises the value
	// itself.
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

	// The walk a value directs — what is left when a position declared
	// nothing, and what every compiled reader falls back to when the tag it met
	// is not the tag it expected. It is the same switch it always was, and it is
	// the whole of the door `marshaller.toJS(value)` opens.
	function toJS(
		value: unknown,
		at: Path | null,
		step: Step,
		expected: Descriptor | null,
	): unknown {
		// The one untagged Essence value — a Function is emitted as a bare
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
					spell(at, step),
				)
			}

			// A Union of two signatures says two things a call could mean,
			// and an untagged value can not say which — refused rather than
			// wrapped as whichever was written first and misdispatched.
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
			// Work met where nothing declared any — a Record member the
			// boundary never named, a `toJS` with no Type over it. It is refused
			// in the words a declared position is refused in, because it is the
			// same refusal: work crosses as a call's answer and nowhere else,
			// and a walk that reached one here reached it inside a value.
			case "Future":
			case "Started":
				throw asynchronyInsideValue(tag, at, step)
		}

		if (tag.includes("#")) {
			// The one fact about a Case that its VALUE does not carry.
			// A `Direction#Up` and a `Shape#Blank` are the same object with the
			// same emptiness under two tags, and which of them crosses as a
			// string is a property of the CHOICE — so it is asked of what was
			// DECLARED here, and of the Module's own Descriptor below where the
			// position declared nothing.
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

			// Nothing was declared, so the Module is asked instead — the
			// table it was built with is the same Descriptor every declared
			// position was cut out of, which is what keeps a value crossing
			// with nothing over it and the same value crossing a Parameter
			// spelled alike. A tag the table does not hold is a Case this
			// Module never named, and it crosses as the object it is.
			let named = bareCases.get(tag)

			if (named !== undefined) {
				return named
			}

			return casedFields(value, at, step, noMembers, caseName(tag))
		}

		// A value that IS this Module's and still has no mapping — the
		// numeric tower above Rational, for now. Saying so beats telling its owner
		// it came from somewhere else, which is what the wording below would have
		// claimed.
		let where = spell(at, step)

		throw new EssenceMarshalError(
			`${where}: ${tag} values can not be marshalled yet.`,
			where,
		)
	}

	// Whether the value in hand carries THIS tag — the whole of what a
	// compiled reader checks before it trusts the shape its Descriptor promised.
	// Read through the bridge's key like every other tag, so a value from another
	// bundle fails it and is handed to the general walk, which says so properly.
	function tagged(value: unknown, tag: string): boolean {
		return (
			typeof value === "object" &&
			value !== null &&
			(value as Record<symbol, unknown>)[typeKey] === tag
		)
	}

	// Read through the bridge's key like every other tag, so a value from
	// another bundle is not mistaken for one of this Module's Optionals.
	function isOptionalValue(value: unknown): boolean {
		if (value === null || typeof value !== "object") {
			return false
		}

		let tag = (value as Record<symbol, unknown>)[typeKey]

		return tag === OPTIONAL_VALUE || tag === OPTIONAL_EMPTY
	}

	// The items a List holds, in the order it holds them — the front run
	// backwards, then the back run — each read by the item's own compiled reader,
	// into an Array of this side's own.
	//
	// The counts are fixed before the first item crosses, which is the rule
	// the runtime's natives are written under as well: a run Array is shared, and
	// nothing may read its `length` again once a walk has started. Nothing here
	// can grow one — the way out only reads — but a walk that asked twice would
	// still be a walk that could be made to disagree with itself, and the one
	// idiom is worth more than the branch it saves.
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

	// The entries a Dictionary holds, in the order it holds them, as a
	// `Map` of this side's own. It is read through the BRIDGE, unlike the List
	// above: what a box holds is decided by version stamps against a generation,
	// and reading that here would be a second copy of a rule rather than a
	// second reading of a layout — `liveEntriesOf` is where the runtime states
	// it, and every native of its own reads it there too.
	//
	// The two halves of an entry are marshalled independently, each by the
	// reader its own slot was compiled to, and the Map is filled in the order
	// the walk answers — which is the order the Dictionary holds its entries,
	// and the order a `Map` gives back.
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

		// The one way this direction can lose something, asked once at the
		// end rather than per key. A Map tells its keys apart by `===` and a
		// Dictionary by the key Type's own `is`, and where a Namespace wrote
		// that `is` the two can disagree — two keys the Module holds apart
		// landing on one JavaScript value, and an entry quietly gone. A count
		// that does not match is the whole of what that looks like.
		if (answer.size !== entries.length) {
			throw collidingKeys(at, step, entries.length, answer.size)
		}

		return answer
	}

	// The VALUE's own members rather than the Descriptor's, because a
	// Record in Essence is structural — a value of `{ width, height, depth }`
	// crosses where `{ width, height }` was declared, and dropping the member the
	// declaration did not name would be this side deciding what the Module meant.
	// What the Descriptor decides is how each member it DOES name is read.
	//
	// Own, enumerable and string-keyed, which is exactly the members — the
	// Type key is a Symbol, and is skipped here by the same rule that makes it
	// hidden inside Essence.
	//
	// Each member read by the reader its name was compiled to, looked for
	// at the position it was DECLARED at first — see `compiledMembers`, which is
	// where both ways of looking are built and why the first one almost always
	// answers. A member no name of the shape matches is read by the walk the
	// value itself directs, which is the whole of how a structural Record keeps
	// the member its position never named.
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

	// A Case as a host reads one — its payload, and WHICH Case it is under
	// `$case`. The tag is written last and wins the collision: which Case a value
	// is is part of the value, and a payload member actually named `$case` would
	// be dropped by that. Dropping one silently is the single thing a lossless
	// boundary may not do, so it is refused instead of quietly lost.
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

	// Everything a caller can get wrong before the first Argument is even
	// looked at is an `EssenceCallError`; everything about a value is an
	// `EssenceMarshalError`. The two are told apart because they are fixed in
	// different places.
	//
	// The answer is marshalled back through the compiled reader for the
	// DECLARED return, so a Function a call answers with comes back callable too.
	//
	// Everything about a call that does not depend on its Arguments is
	// settled before it: which labels the call may be written with, what an Error
	// calls each Argument either way, the reader for every Parameter and the
	// reader for the answer. All of it is settled by the SIGNATURE alone, so
	// `compiledCall` settles it once for every Function that will ever be wrapped
	// against that signature, and what is left here is reading the Arguments and
	// making the call.
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

			// A slot the call left out is handed on as `undefined`, which
			// is precisely what fires the emitted JavaScript default parameter
			// — and nothing is marshalled for it, because there is nothing to
			// marshal. The unrolled arities below skip it the same way, which
			// is why the reads go through one helper rather than being written
			// out three times.
			let read = (position: number): EssenceValue =>
				ordered[position] === OMITTED
					? (undefined as unknown as EssenceValue)
					: readers[position]!(
							ordered[position],
							null,
							places[position]!,
						)

			// The Arguments a Function of this many Parameters takes,
			// passed as that many Arguments. Everything below one line is the
			// same call written out at the two arities almost every Function
			// has, because handing an Array over to be spread builds a call
			// frame out of it — which is most of what a small call costs.
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

	// Whether a refusal got INSIDE the value before making it — a Case whose
	// `$case` named this arm and whose payload was then wrong, rather than an arm
	// that never took the value at all. `Optional<Box>` handed a Box with a String
	// `height` fails at `.height`, where `#Empty` fails at the value itself. Where
	// exactly one arm of a Union got that far, its Error is the useful one, and
	// answering with the Union instead would throw away the only sentence that
	// says what is actually wrong.
	//
	// A deeper path is the usual sign of that, and not the only one: a Case
	// whose `$case` matched and whose PAYLOAD is then wrong refuses the value
	// itself, at this very path, and says so — so it marks itself instead. Without
	// that, every misspelled payload member of every Choice reads as "expected
	// Shape", while the same mistake in a Record names the member.
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

	// The one shape `Optional<T> ↔ T | undefined` can not describe, in both
	// directions, worded the same way. `null` is no help — JSON turns an
	// `undefined` into one, so it is the same absence wearing another name — and
	// there is no third spelling of nothing to spend on the second level.
	function nestedOptional(at: Path | null, step: Step): EssenceMarshalError {
		let where = spell(at, step)

		return new EssenceMarshalError(
			`${where}: an Optional inside an Optional has no JavaScript spelling — both levels would be 'undefined', and '#Value(#Empty)' is not '#Empty'.`,
			where,
		)
	}

	// The other shape with no JavaScript spelling, worded the way
	// `nestedOptional` is and refused in both directions for the same reason.
	// What COLLIDES is named by `bare-cases.ts`, which is the one copy of that
	// rule and the one the generated declarations read too; the frame is here,
	// because only the marshaller knows that a value was about to cross.
	//
	// The way out of it is a change to the Essence source rather than to
	// the JavaScript, so the sentence ends with the two that work: a Record
	// around one side gives it a shape of its own, and a payload on the Case
	// puts it back into the object form. Renaming the Case works as well and is
	// left unsaid — it is the one fix a reader thinks of unprompted.
	//
	// Marked as having reached INSIDE the value, which is what keeps the
	// sentence where an `Optional` stands around the position — that branch
	// answers with its own Type for anything a value could have got right, and
	// this is a refusal no value could have avoided. `reachedInside` is the
	// question "is this the useful Error", and a refusal of the SHAPE is always
	// the useful one.
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

	// The spelling a bare Case used to cross as, met on the way in. It is
	// told apart from every other wrong value because it is the one that is
	// RIGHT about which Case it means and wrong only about how to write it —
	// so it is answered with the string to write instead, rather than with the
	// Type it already named.
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

	// The shape a Dictionary crosses as, met where a host wrote the OTHER
	// object JavaScript has. It is told apart from every other wrong value the
	// way `objectSpelledCase` is: it is the one that is right about what it
	// means and wrong only about how to write it, so it is answered with the
	// shape to write rather than with the Type it already named.
	//
	// A plain object is not a second spelling on the way in, though every
	// key of a `Dictionary<String, V>` would fit one. One shape has one spelling
	// here: a position that took an object as well would be a position two
	// different JavaScript values cross into, while the way out can hand back
	// only one of them — and an object hands its integer-looking keys back
	// first, whatever order they were written in, which is the one thing a
	// Dictionary promises about its entries.
	//
	// Marked as having reached INSIDE the value, so that a Union holding a
	// Dictionary answers with this sentence rather than with the Union — for the
	// reason `objectSpelledCase` is marked: it is the refusal that says what to
	// do about it.
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

	// Two entries of one Map that are one entry of the Dictionary they
	// were going to become — `1` and `1n` are two Map keys and one Integer, and
	// a String written twice in its two Unicode spellings is one String. Which
	// entry it was is the runtime's answer; the place it stands at is this
	// side's, which is the whole of why the two halves are apart.
	function duplicateKey(at: Path | null, step: Step): EssenceMarshalError {
		let where = spell(at, step)

		return new EssenceMarshalError(
			`${where}: this key is already held — a Map tells its keys apart by '===' where a Dictionary tells them apart by the key Type's own equality, so two entries of this Map are one entry of it.`,
			where,
		)
	}

	// The same disagreement met from the other side: keys the Module holds
	// apart that are one JavaScript value, which only an `is` a Namespace wrote
	// can arrange. Refused rather than handed over short, because a Map with an
	// entry missing is the one thing a lossless boundary may not answer with.
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

	// A Dictionary met where the bundle carries no door for one. The door
	// is conditional — 15 kB of store and key encoding a boundary that names no
	// Dictionary does not pay for — and it is decided from the boundary the
	// Module DECLARES: its exported values and its exported Types. So this is
	// reachable from one compile after all, and the reason it names is the
	// truthful one rather than a stale pair. A Record is structurally open and
	// the outbound walk reads the VALUE's members, so a member the boundary
	// never declared can carry a Dictionary the door question could not see.
	//
	// Said out loud for the reason `runtimeBridgeOf` says its own: a
	// `TypeError` about `undefined` from inside a walk names nothing a reader
	// can act on.
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

	// Work met anywhere but a call's answer, in both directions and in the
	// same words, because it is one rule: a Future is a DESCRIPTION of work and
	// the boundary starts it where it crosses, so a position that holds one has
	// to be a position that says when it should run. A call's answer says so —
	// the call is what asked for the work. A Record's member, a List's item and
	// a Case's payload say nothing of the kind: starting one to spell it would
	// run work nobody asked for, every time the value crossed, and handing the
	// description over unstarted would hand over a JavaScript object that
	// describes nothing.
	//
	// Marked as having reached INSIDE the value, so that a Union holding
	// work answers with this sentence rather than with the Union — it is a
	// refusal of the SHAPE, which `reachedInside` calls the useful one.
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

	// The same rule met from the other side: a host handing work IN. It is
	// worded apart from the refusal above because the way out of it is different
	// — there is no JavaScript value that is a Future, whatever position it is
	// written at, so the fix is never "move it" but always "hand over what it
	// answers with, or let the Module do the starting".
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

	// Work met where the bundle carries no door for it. Unlike the
	// Dictionary's, this one is not reachable from a boundary the Compiler
	// described: work at an undeclared position is refused by
	// `asynchronyInsideValue` before any door is asked for, so a Descriptor that
	// names a Future while the bundle carries none is a Descriptor and a bundle
	// that did not come from one compile.
	//
	// Said out loud for the reason `runtimeBridgeOf` says its own: a
	// `TypeError` about `undefined` from inside a walk names nothing a reader
	// can act on.
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

	// What the value IS, in one clause, for the second half of an Error.
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

		// A Promise, named as one. It has no own keys either, so the clause
		// at the bottom would call it an empty object — and of every value a
		// host is likely to hand the wrong door, this is the one whose mistake is
		// worth naming: it is an answer that has not arrived, and the Module has
		// somewhere to put one only where it declared work.
		if (value instanceof Promise) {
			return "a Promise, which crosses only where the Module declared a Future"
		}

		// Named as the Map it is rather than read for members it has none
		// of — `Object.keys` answers nothing at all for one, so the clause below
		// would call a Map of a thousand entries an empty object.
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

		// An Essence value, named by its own tag — read through the bridge's
		// key like every other tag, so a value from ANOTHER bundle is described as
		// the plain object it is from here rather than misreported as one of this
		// Module's.
		let tag = (value as Record<symbol, unknown>)[typeKey]

		if (typeof tag === "string") {
			// A Case is named the way a host reads it — `Shape#Circle`,
			// with the Module the tag carries taken back off, which is the
			// spelling `caseName` below hands out everywhere else on this
			// boundary. A refusal that named the compiling machine's path told
			// its reader nothing they could act on.
			return `an Essence ${tag.includes("#") ? caseName(tag) : tag} value`
		}

		// Tagged, but by another copy of the runtime — see
		// `mintedTypeKeys`. Named as the Essence value it is, and as one this
		// Module can not accept, because "an object with 'value'" is true and
		// sends the host looking in the wrong place entirely.
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
		// A NULLISH Descriptor rather than an absent one, because a host
		// that has none to pass reaches for either spelling — `undefined` from a
		// caller that left the Argument off, `null` from one that had a variable
		// holding no Descriptor — and both say the same thing: nothing was
		// declared here, so read the value by what it says it is.
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

// The keys of a value that the shape it is crossing as does not name, or
// `null` where there are none — the Array is built on the first of them, because
// a value that fits declares nothing extra and should leave nothing behind.
//
// Reached for a Record only where its keys were not the members
// themselves — see the two lists compared where the members are read, which is
// what answers this without a walk at all for a value written as its Type reads.
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

// The Module's exports as things a host can USE — a Function it can call, a
// Namespace it can reach a Method on — rather than the tagged values the bundle
// binds. Marshalling says what a value crossing the boundary becomes; this says
// which name is bound to what.
export type ModuleBindings = {
	// JavaScript all the way down: values marshalled, Functions callable
	// with JavaScript Arguments, Namespaces plain objects of the same.
	exports: Readonly<Record<string, unknown>>
	// The bundle's own bindings under the names their author wrote, and
	// nothing else done to them.
	raw: Readonly<Record<string, unknown>>
}

export type BindOptions = {
	// THIS bundle's own Type key and value constructors. Not optional and
	// not discoverable: every Essence value carries its Type on a Symbol minted
	// when a bundle was evaluated, so a bridge belongs to one bundle and binding
	// against another's would build values the Module can not read.
	bridge: RuntimeBridge
	// The host's own stop, which becomes the ROOT of every run this
	// binding starts — see `InterpreterOptions`.
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
		// An Overload set binds nothing under its own name, so it is the
		// one export whose binding is not read off `raw` — it is bound to the
		// refusal that says why, and where its Overloads are instead.
		if (entry.kind === "overloaded") {
			exports[name] = overloadedCall(entry.overloads, name)

			continue
		}

		// And a Choice binds nothing at all — its Cases are Types, which
		// are erased before a byte is emitted. What goes under the name is
		// built here instead of read off the bundle.
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

// The Module's exports under the names they were WRITTEN under. The
// Rewriter escapes a name JavaScript can not spell — `ok?` is bound as
// `$user_ok_3f_` — and a Descriptor carries what it emitted, so the two spellings
// can not drift apart.
//
// A name the Descriptor lists that the bundle does not bind would be a
// Compiler bug, and is left out rather than bound to `undefined` — reading it
// then says "no such export" instead of handing back nothing.
function bindRaw(
	bundle: Record<string, unknown>,
	descriptor: ModuleDescriptor,
): Readonly<Record<string, unknown>> {
	let raw: Record<string, unknown> = {}

	for (let [name, entry] of Object.entries(descriptor.exports)) {
		// An Overload set binds no name of its own — each Overload is its
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

		// A Choice is not on `raw` under any name, because the bundle
		// binds none: its constructors are this side's answer to a Type that was
		// erased, and `raw` promises the bundle's own bindings and nothing else.
		if (entry.kind === "choice") {
			continue
		}

		if (entry.emitted in bundle) {
			raw[name] = bundle[entry.emitted]
		}
	}

	return Object.freeze(raw)
}

// One way to spell each Case of a Choice, under the Case's own name. A
// Case with a payload is a Function of it — `Shape.Circle({ radius: 3n })` — and
// one without is the value itself: there is nothing to pass, and `Shape.Blank()`
// would be a call whose only purpose is to look like the others.
//
// And a Case of a unit Choice is the STRING it crosses as, so
// `Direction.Up` and `"Up"` are the same value rather than two spellings of
// one. A host that writes the constructor gets what it would have written by
// hand, which is what makes the name worth offering at all: it is a place to
// read the Cases off and to have a typo caught, not a wrapper around the
// value.
//
// Nothing here marshals or checks. What comes back is the plain object the
// boundary already accepts, so a constructor is a SPELLING and the deciding
// stays where every other decision is — at the crossing, once, with the path and
// the Type to say it in. The tag is written last for the reason `toJS` writes it
// last: which Case a value is is part of the value, and a payload member of that
// name is refused where the value crosses rather than silently taking it over.
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

// A constant is marshalled ON READ rather than at bind time, for two
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
// What was declared rides along for the one value a tag does not describe —
// a Function inside the constant, which the way out wraps against it. The
// Descriptor is walked once HERE, where the export is bound, so that reading the
// name a hundred times walks it none.
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

// WHICH Overload a call means is a question only the Compiler answers — it
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

// A Namespace is emitted as a class of static Methods, so it comes back as
// a plain object of the same names — a host writes `Rectangle.of(…)` either way.
// An INSTANCE Method keeps the receiver it is emitted with as its first Argument,
// `Point.shifted(point, 4n)`, because there is no `::` on this side to put it
// before the name.
//
// OWN members, because a Namespace is emitted as a class and a class
// inherits `name`, `length`, `call` and `bind` from `Function` — an `in` would
// answer for a Method the bundle does not bind and hand back JavaScript's own.
//
// A static constant is bound ON READ for the reasons `defineConstant`
// states — a constant is a constant wherever it sits, and one the boundary has no
// mapping for would otherwise take the whole Namespace with it.
function bindNamespace(
	value: unknown,
	descriptor: NamespaceDescriptor,
	interpreter: Interpreter,
): Readonly<Record<string, unknown>> {
	let namespace = value as Record<string, unknown>
	let bound: Record<string, unknown> = {}

	// The constructors of the Choice this Namespace shares its name with,
	// where there is one. They are written FIRST so that a Method or a static
	// constant of the same name — which the bundle really does bind — wins:
	// what a Module declares outranks what this side offers.
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

// The Arguments in the order the emitted Function takes them, whichever way
// the caller wrote the call.
//
// A Function whose every Parameter carries a label may be called with one object
// instead — `Rectangle.of({ width: 3n, height: 4n })` — because that is the call
// Essence itself writes, and dropping to positional Arguments at the boundary
// would lose the one thing the Declaration insisted on. The keys have to be
// EXACTLY the labels: a labelled call with a missing or a misspelled one is a
// mistake, not a positional call that happens to pass an object.
//
// The answer is the Array the call is made from, and WHICH Array it is says
// how the call was written: a labelled call is read into one of its own, so
// `ordered !== args` is that an Argument has a label to be named by in an Error.
// One object less per call than a field saying the same thing, and there was
// never anything else the field meant.
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

					// A key that is absent and a key written as
					// `undefined` are the same call. The `.d.ts` this generator
					// writes types an omittable label as `label?: T`, and
					// TypeScript's `?` admits an explicit `undefined` — so
					// refusing one here would refuse a call the declaration it
					// was given says is legal.
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
