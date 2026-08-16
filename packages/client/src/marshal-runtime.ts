import { bareCaseCollision } from "./bare-cases"
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
// `descriptor.spec.ts` reads this file back to say so. `bare-cases.ts` is the
// one VALUE import that is not `errors` or `rational`, and it holds a RULE
// rather than a tool — it reads a Descriptor's shape and names `./descriptor`
// under an `import type` of its own, so nothing followable leads out of it
// either. It is imported rather than written out here because the generated
// declarations read the same rule, and a second copy is the only way the two
// could come to disagree about which positions this boundary refuses. That is
// the whole of what "one marshaller" costs — a boundary that ships to a browser
// has to be a boundary that does not bring a Compiler with it, and there is
// exactly one of them either way.
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
// is decided by what the Module DECLARED — so the way in is built out of the
// Descriptor. That is what makes the boundary lossless in both directions rather
// than merely plausible.
//
// A Function goes in as well as out, and it is the one value whose two directions
// turn around inside it: a callback the Module calls is handed the Module's own
// values, which cross OUT, and answers with one that crosses IN. So both
// directions are reached from both, and every rule below is written once for both
// callers.
//
// NOTE: Every rule is COMPILED rather than asked on every value. A Descriptor is
// fixed long before the first value crosses against it — it is written when the
// Module is built — so every question this file puts to a shape has one answer
// for the whole life of a binding: which branch a `list` takes, whether an
// `Optional` holds another one, what a Case's tag is spelled as, which Parameter
// is named `argument 2`. `compileIn` and `compileOut` ask them ONCE per
// Descriptor node and hand back the closure that is the answer, so a call runs
// closures and touches no Descriptor at all.
//
// The switch did not move, it moved a line up: each branch used to compute a
// value and now returns the Function that computes it, out of the same rule
// written in the same place. That is the whole of the change — there is still
// ONE marshaller, rather than an interpreter and a compiler that would have to
// be kept agreeing.
//
// NOTE: Nothing here guesses at the runtime. The Symbol every tag is read through
// and every constructor a value is built by come out of the BUNDLE, through the
// bridge — a value built any other way carries a Symbol the Module has never seen,
// and every Method it reaches would find it untyped.
//
// NOTE: A value the way in builds is admitted by the Descriptor it was built
// against BY CONSTRUCTION — each member is built against the member's own
// Descriptor and each arm of a Union is the arm that took the value — so the
// runtime's own `isValueOfType` is not asked afterwards. Asking would mean
// handing it a Type descriptor whose Case identities are the canonical paths of
// the machine that compiled, while the values' tags are entry-relative;
// rendering a whole descriptor tree to match would be a SECOND copy of the rule
// `emittedIdentity` states, and a second copy is the only way the two could ever
// disagree. What is worth checking is checked where the value is built.

// NOTE: The two tags the runtime's own `Optional` carries. Every other Choice
// belongs to a Module, and a Module's tags are spelled relative to the entry —
// which is why a Descriptor bakes those and not these. `Optional` is declared
// where no Module path can qualify it, so its two Cases are spelled the same in
// every bundle there will ever be.
const OPTIONAL_VALUE = "Optional#Value"
const OPTIONAL_EMPTY = "Optional#Empty"

// NOTE: Where the value under discussion sits, for an Error to name. The root is
// what the caller called it — `argument 2`, `PI`, `return value` — and every step
// below it is a JavaScript accessor, so a failure deep inside a List of Records
// reads `argument 2 → .items[0].width` rather than `expected Integer`.
//
// NOTE: A CHAIN rather than a string, and a converter is handed the place it is
// INSIDE plus the one step from there to the value it was given —
// `(value, at, step)`. Spelling is the one piece of work the boundary would
// otherwise do on every value and needs on almost none, so it is done where an
// Error is thrown and nowhere else. A leaf therefore builds nothing at all: only
// a container, which has children to name themselves to, links a place of its
// own, and the root of a walk is spelled by its step alone with nothing above it.
type Path = { at: Path | null; step: Step }

// NOTE: A member name or a position in a List — `.width` and `[3]` — and at the
// root, the whole of what the caller called the value.
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

// NOTE: A place of its own INSIDE the value at this one — a callback's own
// Arguments and its answer, which are not parts of the Function the way a member
// is part of a Record. Everything reached from there is spelled below the whole
// of where the callback was, so a refusal reads `argument 2 → return value →
// .width` and names the Function the caller actually passed. What comes back is
// a ROOT, because nothing above it is the Module's to name.
function within(at: string, what: string): string {
	return `${at} → ${what}`
}

// NOTE: How many names an Error spells out before it starts counting.
const NAMES_SHOWN = 5

export type EssenceFunction = (...args: Array<EssenceValue>) => EssenceValue

// NOTE: One shape's rule, compiled — the way in and the way out of a single
// Descriptor node, as the Function each of them is. Everything a call does is
// one of these being run.
type Inbound = (value: unknown, at: Path | null, step: Step) => EssenceValue

type Outbound = (value: unknown, at: Path | null, step: Step) => unknown

// NOTE: The members of one Record or one Case's payload, compiled — the readers
// under the names a value carries them under, and the same readers in the order
// the Type declares them. Which of the two answers is asked first is the whole
// of the difference between them; see `compiledMembers`.
type Members = {
	names: Array<string>
	readers: Array<Outbound>
	named: Map<string, Outbound>
}

// NOTE: Everything about a call that its SIGNATURE settles: which labels it may
// be written with, the reader for every Parameter and for the answer, and what
// an Error calls each Argument written either way. None of it depends on the
// Function it wraps or on the name that Function was met under, so all of it is
// settled once per FunctionDescriptor rather than once per value that crosses;
// see `compiledCall`.
type Call = {
	arity: number
	labels: Array<string> | null
	readers: Array<Inbound>
	answer: Outbound
	positional: Array<string>
	named: Array<string>
}

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
	// NOTE: The same two doors for a caller that will cross the SAME shape more
	// than once — a constant read again and again, a host's own hot loop. The
	// Descriptor is walked here and never again; what comes back takes the value
	// alone.
	compileIn: (
		expected: Descriptor,
		path?: string,
	) => (value: unknown) => EssenceValue
	compileOut: (
		expected: Descriptor,
		path?: string,
	) => (value: unknown) => unknown
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

export function createInterpreter(
	bridge: RuntimeBridge,
	module: ModuleDescriptor,
): Interpreter {
	// NOTE: The bundle's own Type key and constructors, read off the bridge ONCE.
	// Every value that crosses reaches one of them, and a property load on the
	// way to each call is exactly the sort of work the compile step exists to
	// have already done. None of them is a Method — the bridge hands over the
	// runtime's own Functions — so a name held apart from the object it arrived
	// on calls the same way.
	let typeKey = bridge.typeKey
	let makeCase = bridge.case
	let makeInteger = bridge.integer
	let makeRational = bridge.rational
	let makeString = bridge.string
	let makeBoolean = bridge.boolean
	let makeList = bridge.list
	let makeRecord = bridge.record
	// NOTE: Every unit Choice Case the MODULE names, under the tag its values
	// carry. Whether a Case crosses as a bare string is a fact about the Choice
	// and a value carries nothing that says it, so the general walk — which
	// reads a value by what it says it is — could otherwise only answer it
	// where the position that was crossed declared the Case. This is the other
	// place the answer can come from: the whole Descriptor, read once here, so
	// that `toJS` with nothing declared hands back the same string a declared
	// position would have and a host can hand it straight back.
	//
	// NOTE: Bounded by the Descriptor, and complete for what a host can reach:
	// a value only leaves this boundary through an export, and an export names
	// its Type. The Module is required for the same reason — an interpreter
	// built without one would walk a Case into its object form at an undeclared
	// position and into a string at a declared one, which is the disagreement
	// this table exists to prevent.
	let bareCases = bareCaseNames(module)

	// #region Compiling

	// NOTE: One compiled rule per Descriptor NODE, kept against the node itself.
	// A Descriptor outlives every value that crosses against it — a bound Module
	// holds its own for as long as it is bound — so a shape is compiled once and
	// never again, while a Descriptor nobody holds any more takes its closures
	// with it rather than filling a table that only grows.
	//
	// NOTE: A Descriptor is a TREE — `describe` answers a Type that reaches
	// itself with a `refused` node rather than following it — so compiling a
	// node's children while compiling the node terminates, and a call finds every
	// converter below it already built.
	let inbound = new WeakMap<Descriptor, Inbound>()
	let outbound = new WeakMap<Descriptor, Outbound>()
	let outboundMembers = new WeakMap<Record<string, Descriptor>, Members>()
	let calls = new WeakMap<FunctionDescriptor, Call>()
	// NOTE: What a position that declared nothing reads its members by — no
	// names to guess with and no reader to find, so every member of it is read
	// by the walk the VALUE directs. One of them rather than a `null` to branch
	// on, because a Record nothing was declared for is read by the same loop as
	// every other.
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

	// NOTE: The compiled way out for a Descriptor, or the value-directed walk
	// where a position declared nothing — the one place the two doors meet, so
	// that a piece whose shape was declared is read through its own rule and a
	// piece whose shape was not is still read.
	function out(expected: Descriptor | null): Outbound {
		return expected === null ? anyOut : compileOut(expected)
	}

	function anyOut(value: unknown, at: Path | null, step: Step): unknown {
		return toJS(value, at, step, null)
	}

	// NOTE: The members of a Record or the payload of a Case, each compiled —
	// twice over, in the two ways a member is looked for. Memoised against the
	// members object itself, because the general walk below reaches for it per
	// value.
	//
	// NOTE: The names IN THE TYPE'S ORDER beside the readers, because a value the
	// Module built against this Type carries its members in that order — so the
	// reader a position wants is almost always the one standing at the same
	// position, found by comparing two names rather than by hashing one. And the
	// map for every other value: a Record of another shape entirely, a member the
	// Type does not name, a payload written in another order. Both spellings
	// answer the same thing, because they are built out of the same members.
	function compiledMembers(members: Record<string, Descriptor>): Members {
		let compiled = outboundMembers.get(members)

		if (compiled === undefined) {
			let names = Object.keys(members)
			let readers = names.map((name) => compileOut(members[name]!))
			let named = new Map<string, Outbound>()

			for (let position = 0; position < names.length; position++) {
				named.set(names[position]!, readers[position]!)
			}

			compiled = { names, readers, named }
			outboundMembers.set(members, compiled)
		}

		return compiled
	}

	// NOTE: A signature's half of a call, compiled — the half that is fixed the
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
				answer: compileOut(signature.returns),
				positional,
				// NOTE: The same Array where no labels may be written, rather
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

	// NOTE: A whole Array of one shape rather than one value of it — the items of
	// a List, walked by the loop the ITEM's kind picks, picked once where the
	// List is compiled and never looked at again.
	//
	// NOTE: This is the ONE place where compiling to closures costs something
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
	// NOTE: So a leaf's admission is spelled here as well as in the branch of
	// `buildIn` that compiles the leaf on its own, and the two say the same
	// thing. They are two spellings of ONE rule rather than two rules — a value
	// met on its own and the same value met inside a List are the same value —
	// so a difference between a loop here and its branch there is a bug and never
	// a decision.
	//
	// NOTE: A Rational is walked by the loop at the bottom with everything else.
	// Its admission is three branches, a read of a double's bits and two
	// allocations, and a call per item is a small part of that — where an
	// Integer's is two type checks that the call itself outweighs.
	//
	// NOTE: A hole in an Array is read as the `undefined` it holds, and admitted
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
				// NOTE: The argument is the answer's LENGTH. The rule below suggests
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

		// NOTE: And everything else through its own converter, which is every
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

	// NOTE: What a JavaScript value has to become to be this shape, as one
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
					// NOTE: Both kinds go in AS THEY ARE — the bridge's
					// `createInteger` canonicalises, so a bigint that fits a
					// double arrives as a number and a number that does not
					// arrives as a bigint, and neither caller has to know which
					// side of 2⁵³ its value sits.
					if (typeof value === "bigint") {
						return makeInteger(value)
					}

					// NOTE: A number is admitted only where it is exactly an
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

					// NOTE: Normalised on the way in, because String equality in
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

					// NOTE: `bridge.list` copies what it is handed, so the Array
					// built here is copied once more before a List holds it. The
					// alternative was to bridge the runtime's own `createList`,
					// which takes ownership — and then this call would be safe
					// while a host's identical-looking one, on an Array the host
					// kept, would silently share a run with Essence.
					return makeList(items(value, { at, step }))
				}
			}
			case "record": {
				let names = Object.keys(expected.members)
				let readers = names.map((name) =>
					compileIn(expected.members[name]!),
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
					// NOTE: The keys the value carries against the members the
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

						return makeRecord(fields)
					}

					// NOTE: And every value the two lists did not settle, read
					// the long way — a member left out, a member the Type does
					// not name, or the very same members written in another
					// order.
					//
					// NOTE: An absent key IS a value here — `undefined`, which is
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
					// NOTE: An OWN key, because an absent `toString` read plainly
					// finds `Object.prototype`'s — a function where the rule above
					// promises `undefined`.
					for (let position = 0; position < count; position++) {
						let name = names[position]!

						fields[name] = readers[position]!(
							Object.hasOwn(given, name)
								? given[name]
								: undefined,
							inside,
							name,
						)
					}

					// NOTE: Closed, unlike the Matcher a `case` narrows with. A
					// key the Type does not name is a mistake in the making — a
					// misspelled member, or a value from somewhere else entirely
					// — and taking it silently drops it, which is how a `widht`
					// gets as far as production.
					//
					// NOTE: Looked for AFTER the members are read, so that a
					// value which is wrong in both ways is named by the member
					// that is wrong rather than by the one that is extra.
					let undeclared = undeclaredOf(given, declared, false)

					if (undeclared !== null) {
						throw undeclaredMembers(shown, undeclared, at, step)
					}

					return makeRecord(fields)
				}
			}
			case "optional": {
				// NOTE: The refusal `toJS` makes for the same pair, made here
				// too: `#Value(#Empty)` and `#Empty` would both be `undefined`,
				// and Essence is explicit that they are two values. It is a fact
				// about the SHAPE rather than about any value of it, so a shape
				// that has it compiles to the refusal itself.
				if (admitsAbsence(expected.of)) {
					return (value, at, step) => {
						throw nestedOptional(at, step)
					}
				}

				let item = compileIn(expected.of)

				// NOTE: `Optional` is spelled by its ABSENCE on this side — `T |
				// undefined` — so it reads the value itself rather than a `$case`
				// on it. `null` is admitted beside `undefined` because JSON has
				// only the one of them; `undefined` is what comes back.
				//
				// NOTE: This is the Union of `#Value` and `#Empty` with its two
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
				// NOTE: Before any arm is tried, because a nested Optional is
				// refused rather than answered and an arm's refusal is something
				// the next arm gets to overrule. A Union that offers an `Optional`
				// among its arms would otherwise let a later arm take the
				// `undefined` an earlier one had just refused — turning a shape
				// with no JavaScript spelling into a confident wrong answer.
				let item = optionalItemOf(expected)

				if (item !== null && admitsAbsence(item)) {
					return (value, at, step) => {
						throw nestedOptional(at, step)
					}
				}

				// NOTE: And the second shape a Union can be in that no
				// JavaScript value could be read into: a unit Choice's Case
				// crosses as its bare name, so `"Up"` standing beside a String
				// — or beside another Choice's `#Up` — is one string two arms
				// would both take. Asked BEFORE the arms are compiled, for the
				// reason the nested `Optional` above is: an arm that took the
				// value would be an arm that had already decided, and what is
				// wrong here is that there is nothing to decide it WITH.
				//
				// NOTE: Refused rather than decided, which is the one place the
				// "first arm wins" stance the arms below are compiled under
				// does not reach. Deciding would hand a String `"Up"` back out
				// as a `Direction#Up`, and losing the value it was given is the
				// single thing this boundary may not do.
				let collision = bareCaseCollision(expected)

				if (collision !== null) {
					return (value, at, step) => {
						throw ambiguousBareCase(shown, collision, at, step)
					}
				}

				let arms = expected.arms.map((arm) => compileIn(arm))
				let count = arms.length
				// NOTE: Which JavaScript families each arm could take at all,
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

				// NOTE: A Union of bare Cases and nothing else — a unit Choice
				// as a value of it is declared, which is the shape a status or
				// a kind is — is a lookup and no search: every string it can
				// take is known when the reader is compiled, under both of its
				// spellings, and answers the one shared instance. What is not
				// in the table falls through to the arms, so a miss is refused
				// in exactly the words it always was.
				let named = bareCaseTable(expected)

				// NOTE: And the same for the Cases that cross as objects: which
				// arm a `$case` names is known when the reader is compiled, so
				// an object that names one is handed to that arm and no other.
				// The arm's own refusal — a payload member wrong under a
				// recognised tag — is then the ONE refusal, which is what the
				// search below would have concluded after trying the rest.
				let tagged = caseArmTable(expected)

				// NOTE: In declaration order, and the first arm that admits the
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

					// NOTE: Built on the first refusal rather than before the
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
			// NOTE: Everything the boundary has no mapping for, refused in the
			// words the Compiler wrote when it still had the Type to name.
			case "refused": {
				let why = expected.why

				return (value, at, step) => {
					let where = spell(at, step)

					throw new EssenceMarshalError(`${where}: ${why}`, where)
				}
			}
		}
	}

	function buildCaseIn(expected: CaseDescriptor): Inbound {
		let shown = expected.shown
		let tag = expected.tag

		// NOTE: One of `Optional`'s own Cases, met without the other — which is
		// what `constant thing = #Value(3)` infers, a Case rather than the Union
		// an annotation would have named. The pair is collapsed into an `optional`
		// before it ever reaches here, so this is the lone arm, read by the rule
		// the pair is read by.
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

			// NOTE: A `#Value` carrying nothing, and a `#Value` carrying another
			// absence — neither is a shape any value has, so both are the whole
			// of what this Case compiles to.
			if (item === undefined) {
				return (value, at, step) => {
					throw mismatch(value, shown, at, step)
				}
			}

			if (admitsAbsence(item)) {
				return (value, at, step) => {
					throw nestedOptional(at, step)
				}
			}

			let held = compileIn(item)

			return (value, at, step) => {
				if (value === undefined || value === null) {
					throw mismatch(value, shown, at, step)
				}

				return makeCase(tag, { item: held(value, at, step) })
			}
		}

		// NOTE: A Case of a unit Choice is the STRING of its own name and
		// nothing else — `"Up"`, or the `"Direction#Up"` the source itself
		// would write. Both spellings, exactly as the object form below takes
		// both; the difference is that they are the value rather than a member
		// on it, which is the whole ergonomic point of the rule.
		//
		// NOTE: The object form is not kept as a second spelling. One shape has
		// one spelling here: a position that took `{ $case: 'Up' }` as well
		// would be a position two different JavaScript values cross into, while
		// the way out can only ever hand one of them back — so a round trip
		// through it would silently rewrite what a host wrote.
		if (expected.unitChoice) {
			let named = expected.name
			let spelled = `${expected.choice}#${expected.name}`

			return (value, at, step) => {
				if (value === named || value === spelled) {
					// NOTE: No payload at all, for the reason the payload-less
					// branch below gives — `createCase` hands out one shared
					// instance per unit Case tag, and a fresh `{}` would not be
					// the Module's own `#Up`.
					return makeCase(tag)
				}

				// NOTE: The spelling this Case used to cross as, met where the
				// string is now the only one. Worth a sentence of its own,
				// because "expected Direction#Up, got an object with '$case'"
				// is true and says nothing about what to write instead.
				//
				// NOTE: Marked as having reached INSIDE the value, so that a
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

		// NOTE: Either spelling of the same Case, both built here. `Shape#Circle`
		// is what `toJS` writes, and so what a round trip hands back; the bare
		// `Circle` is what the Essence source itself writes, where a `#Circle`
		// needs no Choice in front of it.
		let bare = expected.name
		let qualified = `${expected.choice}#${expected.name}`
		let colliding = Object.hasOwn(expected.payload, "$case")
		let names = Object.keys(expected.payload)
		let readers = names.map((name) => compileIn(expected.payload[name]!))
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

			// NOTE: The refusal `toJS` makes for the same Case, made here too.
			// The tag is written under `$case`, so a payload member of that name
			// has nowhere to sit: read it and the tag string becomes the member's
			// value, silently, and there is no way to pass any other. Coming out
			// it is refused; going in it has to be refused, or the boundary
			// accepts a value it can not then describe.
			if (colliding) {
				throw collidingCase(at, step, true)
			}

			let undeclared = undeclaredOf(given, declared, true)

			if (undeclared !== null) {
				throw undeclaredMembers(shown, undeclared, at, step, true)
			}

			if (count === 0) {
				// NOTE: No payload at all rather than an empty one —
				// `createCase` hands out one shared instance per unit Case tag,
				// and passing `{}` would build a fresh object each time that the
				// Module's own `#Blank` is not.
				return makeCase(tag)
			}

			let payload: Record<string, EssenceValue> = {}
			let inside: Path = { at, step }

			// NOTE: An absent key is read as `undefined` — through an OWN-key
			// check, past what `Object.prototype` holds — and the member's own
			// shape decides, for the reasons the Record branch above states.
			for (let position = 0; position < count; position++) {
				let name = names[position]!

				payload[name] = readers[position]!(
					Object.hasOwn(given, name) ? given[name] : undefined,
					inside,
					name,
				)
			}

			return makeCase(tag, payload)
		}
	}

	// NOTE: One JavaScript Function as an Essence one — the mirror image of
	// `wrapFunction`, and the only place the boundary is crossed by a call the
	// MODULE makes. What the Module hands the callback are its own values, so
	// they cross OUT; what the callback answers with is built against the
	// declared return, so it crosses IN. Every rule of both directions is the
	// same rule as everywhere else, applied at a call site the host wrote.
	//
	// NOTE: Positionally, and never by label. A labelled call is how Essence
	// writes its own calls and how a host may write one INTO the Module; a
	// JavaScript Function takes its Arguments in order, and handing one an
	// object of labels would be this package inventing a calling convention
	// for code it did not write.
	//
	// NOTE: The path a refusal inside the callback is spelled from is the path
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
		let back = compileIn(signature.returns)

		return (value, at, step) => {
			if (typeof value !== "function") {
				throw mismatch(value, shown, at, step)
			}

			let target = value as (...args: Array<unknown>) => unknown
			let arrived = spell(at, step)
			// oxlint-disable-next-line unicorn/no-new-array -- the length, as above
			let places: Array<string> = new Array(count)

			for (let position = 0; position < count; position++) {
				places[position] = within(arrived, `argument ${position + 1}`)
			}

			let answered = within(arrived, "return value")

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
	}

	// #endregion

	// #region Out

	// NOTE: The way out compiled, and it is NOT the mirror of the way in. A value
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
			// NOTE: ALWAYS a bigint on the way out, whichever of its two
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
			case "record": {
				let members = compiledMembers(expected.members)

				return (value, at, step) =>
					tagged(value, "Record")
						? fieldsOf(value as object, at, step, members)
						: toJS(value, at, step, expected)
			}
			case "optional": {
				let item = compileOut(expected.of)

				// NOTE: An Optional is transparent — `Optional<T>` IS `T |
				// undefined` on this side — so the Case does not appear in the
				// answer, and the path gains no segment for it either. A host
				// reading `.item` off what came back would be reading the
				// Module's bookkeeping rather than its value.
				return (value, at, step) => {
					if (tagged(value, OPTIONAL_VALUE)) {
						let held = (value as { item: unknown }).item

						// NOTE: Absence does not nest. `#Value(#Empty)` and
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
				// NOTE: One of `Optional`'s own two Cases, met WITHOUT the other
				// — which is what `constant thing = #Value(3)` infers, a Case
				// rather than the Union an annotation would have named. It is
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

				// NOTE: A unit Choice's Case IS its name on this side, so the
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

				// NOTE: The Case as a host spells it, cut out of the tag once
				// here rather than out of every value that carries it.
				let name = caseName(tag)
				let members = compiledMembers(expected.payload)

				return (value, at, step) =>
					tagged(value, tag)
						? casedFields(value as object, at, step, members, name)
						: toJS(value, at, step, expected)
			}
			case "union": {
				// NOTE: The same refusal the way in makes, in the same words
				// and before anything else is compiled. It is a fact about the
				// SHAPE rather than about any value of it — the position has no
				// unambiguous JavaScript spelling — so it holds whichever
				// direction the position is crossed in. Letting values out of a
				// position the way in refuses would be worse than refusing
				// both: a host would be handed `"Up"` and then told it can not
				// hand it back.
				let collision = bareCaseCollision(expected)

				if (collision !== null) {
					return (value, at, step) => {
						throw ambiguousBareCase(
							expected.shown,
							collision,
							at,
							step,
						)
					}
				}

				// NOTE: A Union names more than one shape and the VALUE says
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
			// NOTE: The one untagged Essence value, and the one place a Descriptor
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
			// NOTE: A Type the way IN has no mapping for is still a value on the
			// way out, and its tag says what it is — `Optional<Algebraic>` hands
			// back an Algebraic's own refusal rather than the Type Parameter's.
			case "refused":
				return (value, at, step) => toJS(value, at, step, expected)
		}
	}

	// NOTE: Every Case a Union offers, under the tag its values carry — nested
	// Unions walked in the order `caseFor` reads them and the first one under a
	// tag winning, so the compiled dispatch answers with the arm the general
	// walk would have found.
	//
	// NOTE: `Optional`'s own two Cases are left out. They are spelled by ABSENCE
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

	// NOTE: The walk a value directs — what is left when a position declared
	// nothing, and what every compiled reader falls back to when the tag it met
	// is not the tag it expected. It is the same switch it always was, and it is
	// the whole of the door `marshaller.toJS(value)` opens.
	function toJS(
		value: unknown,
		at: Path | null,
		step: Step,
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
					spell(at, step),
				)
			}

			// NOTE: A Union of two signatures says two things a call could mean,
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
		}

		if (tag.includes("#")) {
			// NOTE: The one fact about a Case that its VALUE does not carry.
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

			// NOTE: Nothing was declared, so the Module is asked instead — the
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

		// NOTE: A value that IS this Module's and still has no mapping — the
		// numeric tower above Rational, for now. Saying so beats telling its owner
		// it came from somewhere else, which is what the wording below would have
		// claimed.
		let where = spell(at, step)

		throw new EssenceMarshalError(
			`${where}: ${tag} values can not be marshalled yet.`,
			where,
		)
	}

	// NOTE: Whether the value in hand carries THIS tag — the whole of what a
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

	// NOTE: Read through the bridge's key like every other tag, so a value from
	// another bundle is not mistaken for one of this Module's Optionals.
	function isOptionalValue(value: unknown): boolean {
		if (value === null || typeof value !== "object") {
			return false
		}

		let tag = (value as Record<symbol, unknown>)[typeKey]

		return tag === OPTIONAL_VALUE || tag === OPTIONAL_EMPTY
	}

	// NOTE: The items a List holds, in the order it holds them — the front run
	// backwards, then the back run — each read by the item's own compiled reader,
	// into an Array of this side's own.
	//
	// NOTE: The counts are fixed before the first item crosses, which is the rule
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
		let back = list.value
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

	// NOTE: The VALUE's own members rather than the Descriptor's, because a
	// Record in Essence is structural — a value of `{ width, height, depth }`
	// crosses where `{ width, height }` was declared, and dropping the member the
	// declaration did not name would be this side deciding what the Module meant.
	// What the Descriptor decides is how each member it DOES name is read.
	//
	// NOTE: Own, enumerable and string-keyed, which is exactly the members — the
	// Type key is a Symbol, and is skipped here by the same rule that makes it
	// hidden inside Essence.
	//
	// NOTE: Each member read by the reader its name was compiled to, looked for
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

	// NOTE: A Case as a host reads one — its payload, and WHICH Case it is under
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

	// NOTE: Everything a caller can get wrong before the first Argument is even
	// looked at is an `EssenceCallError`; everything about a value is an
	// `EssenceMarshalError`. The two are told apart because they are fixed in
	// different places.
	//
	// NOTE: The answer is marshalled back through the compiled reader for the
	// DECLARED return, so a Function a call answers with comes back callable too.
	//
	// NOTE: Everything about a call that does not depend on its Arguments is
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

			// NOTE: The Arguments a Function of this many Parameters takes,
			// passed as that many Arguments. Everything below one line is the
			// same call written out at the two arities almost every Function
			// has, because handing an Array over to be spread builds a call
			// frame out of it — which is most of what a small call costs.
			if (arity === 1) {
				return answer(
					target(readers[0]!(ordered[0], null, places[0]!)),
					null,
					"return value",
				)
			}

			if (arity === 2) {
				let first = readers[0]!(ordered[0], null, places[0]!)
				let second = readers[1]!(ordered[1], null, places[1]!)

				return answer(target(first, second), null, "return value")
			}

			// oxlint-disable-next-line unicorn/no-new-array -- the length, as above
			let marshalled: Array<EssenceValue> = new Array(arity)

			for (let position = 0; position < arity; position++) {
				marshalled[position] = readers[position]!(
					ordered[position],
					null,
					places[position]!,
				)
			}

			return answer(target(...marshalled), null, "return value")
		}
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

	// NOTE: The one shape `Optional<T> ↔ T | undefined` can not describe, in both
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

	// NOTE: The other shape with no JavaScript spelling, worded the way
	// `nestedOptional` is and refused in both directions for the same reason.
	// What COLLIDES is named by `bare-cases.ts`, which is the one copy of that
	// rule and the one the generated declarations read too; the frame is here,
	// because only the marshaller knows that a value was about to cross.
	//
	// NOTE: The way out of it is a change to the Essence source rather than to
	// the JavaScript, so the sentence ends with the two that work: a Record
	// around one side gives it a shape of its own, and a payload on the Case
	// puts it back into the object form. Renaming the Case works as well and is
	// left unsaid — it is the one fix a reader thinks of unprompted.
	//
	// NOTE: Marked as having reached INSIDE the value, which is what keeps the
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

	// NOTE: The spelling a bare Case used to cross as, met on the way in. It is
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
		let tag = (value as Record<symbol, unknown>)[typeKey]

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
		// NOTE: A NULLISH Descriptor rather than an absent one, because a host
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

// NOTE: The keys of a value that the shape it is crossing as does not name, or
// `null` where there are none — the Array is built on the first of them, because
// a value that fits declares nothing extra and should leave nothing behind.
//
// NOTE: Reached for a Record only where its keys were not the members
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
	let interpreter = createInterpreter(options.bridge, descriptor)
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

		// NOTE: And a Choice binds nothing at all — its Cases are Types, which
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

		// NOTE: A Choice is not on `raw` under any name, because the bundle
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

// NOTE: One way to spell each Case of a Choice, under the Case's own name. A
// Case with a payload is a Function of it — `Shape.Circle({ radius: 3n })` — and
// one without is the value itself: there is nothing to pass, and `Shape.Blank()`
// would be a call whose only purpose is to look like the others.
//
// NOTE: And a Case of a unit Choice is the STRING it crosses as, so
// `Direction.Up` and `"Up"` are the same value rather than two spellings of
// one. A host that writes the constructor gets what it would have written by
// hand, which is what makes the name worth offering at all: it is a place to
// read the Cases off and to have a typo caught, not a wrapper around the
// value.
//
// NOTE: Nothing here marshals or checks. What comes back is the plain object the
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

	// NOTE: The constructors of the Choice this Namespace shares its name with,
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

// NOTE: The Arguments in the order the emitted Function takes them, whichever way
// the caller wrote the call.
//
// A Function whose every Parameter carries a label may be called with one object
// instead — `Rectangle.of({ width: 3n, height: 4n })` — because that is the call
// Essence itself writes, and dropping to positional Arguments at the boundary
// would lose the one thing the Declaration insisted on. The keys have to be
// EXACTLY the labels: a labelled call with a missing or a misspelled one is a
// mistake, not a positional call that happens to pass an object.
//
// NOTE: The answer is the Array the call is made from, and WHICH Array it is says
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

			if (sameNames(keys, labels)) {
				let count = labels.length
				// oxlint-disable-next-line unicorn/no-new-array -- the length, as above
				let ordered: Array<unknown> = new Array(count)

				for (let position = 0; position < count; position++) {
					ordered[position] = given[labels[position]!]
				}

				return ordered
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

	return args
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

// NOTE: What an `Optional` holds, or `null` where the shape is not one. The
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
// its object spelling always carries `$case`, which no set of labels is — and a
// unit Choice's Case is not an object at all, being the string it crosses as.
// What it decides is whether a single labelled Parameter's labelled call is
// ambiguous — see `labelsOf`.
export function admitsRecord(descriptor: Descriptor): boolean {
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

// NOTE: The Case a value's own tag names, where what was declared carries that
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

// NOTE: The `typeof` families a Descriptor's reader could take a value from,
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
		case "refused":
			return null
	}
}

// NOTE: Every string a Union of bare Cases takes, under the tag it answers —
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

// NOTE: Which arm of a Union of CASES each `$case` a host could write names —
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

// NOTE: Every Case of a unit Choice a whole Module names, under its tag and
// answering the bare string it crosses as. Read ONCE, when an interpreter is
// built, because it is a property of the declarations rather than of anything
// that happens afterwards — and read at all because the general walk has no
// other way to learn it: `caseFor` above can only answer where the position
// being crossed declared the Case, and a `toJS` with nothing declared is the
// door a host reaches for exactly when it has no Type to hand over.
//
// NOTE: The whole Descriptor rather than its Choice exports alone. A Choice a
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

// NOTE: No guard against walking a node twice, because a Descriptor is a TREE —
// `describe` answers a Type that reaches itself with a `refused` node rather
// than following it — which is the same reason compiling a node's children
// while compiling the node terminates.
function collectBareCases(
	descriptor: Descriptor,
	found: Map<string, string>,
): void {
	switch (descriptor.kind) {
		case "list":
		case "optional":
			collectBareCases(descriptor.of, found)

			return
		case "record":
			for (let member of Object.values(descriptor.members)) {
				collectBareCases(member, found)
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
				collectBareCases(member, found)
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
