import { toString as algebraicToString } from "./Algebraic"
import { toString__overload$1 as integerToString } from "./Integer"
import { materialise } from "./List"
import { createEmpty, createValue, type OptionalType } from "./Optional"
import { formatAsRational, type RationalType } from "./Rational"
import type { RecordType } from "./Record"
import { kindOf, singleLineMaxLength } from "./registry"
import type { StreamType } from "./Stream"
import { createString, quotedText, type StringType } from "./String"
import { toString as transcendentalToString } from "./Transcendental"
import { type AnyType, typeKeySymbol } from "./type"

// NOTE: The native half of `packages/standard-library/sources/Terminal.es` —
// everything a Program puts in front of a person, and everything a person hands
// back. Five of the Namespace's entries are native: `write(_:to:)`, because a
// stream has to be reached somehow, `inspect` and `describe`, because the
// structural rendering below is what they ARE, and `readLine`/`readAll`,
// because a descriptor has to be read somehow. `print` and `ask` are written in
// Essence on top of those.
//
// NOTE: `getStringRepresentation` lives here rather than in `functions.ts`
// because `inspect` is its only caller in the language — `functions.ts` keeps
// the `loop` drivers and nothing else now. It stays EXPORTED because two other
// readers ask it a question of the same shape outside a Program:
// `Record.toString`, which asks for the printable form, and the Debug Adapter,
// whose variables pane shows a value the way a `Terminal.inspect` would.

// NOTE: Two readers, one walk. `Terminal.inspect` asks for the STRUCTURAL
// rendering — what a value IS — and `Record.toString` asks for the PRINTABLE
// one, since a Record conforms to `Printable` and `Terminal.print` goes through
// it. The two differ in TWO pieces, and a caller hands in both: the Rational,
// where `Record.toString` passes `formatAsFraction` and a whole Rational prints
// its numerator alone, and the padding inside a List's brackets, where it
// passes none, so that a List member reads `[1, 2]` — the form `List.toString`
// answers and a Program writes a List down in. The rest of the rendering is the
// same for both, quoted Strings included, and `Record.es` says so at its own
// `toString`.
//
// NOTE: A Function rather than a mode for the Rational, so that a Program which
// never prints a Record never carries the second formatter. Naming
// `formatAsFraction` inside this walk puts it in every Program that prints
// anything at all, and measured 331 bytes of `Irrational.es` against the 139
// the handed-in Function costs. The padding is a String rather than a Function
// because there is nothing behind it to carry.
// NOTE: What a rendering at indent zero becomes at a deeper one. Every arm of
// the walk below writes its own newlines followed by four spaces per level and
// nothing else — a String is quoted, so its own newlines and control characters
// are escaped rather than written — which makes a rendering at any level the
// rendering at zero with the level's indent after each newline. That is what
// lets a child be rendered ONCE, for the single-line pass, and re-used for the
// nested one. Rendering it twice made the walk double per level of nesting: a
// chain of single-member Records measured 1.1, 15, 62, 260 and 1,153 ms at
// depths 12, 16, 18, 20 and 22, against 0.03 ms at depth 22 this way.
function indented(text: string, indent: string): string {
	return text.includes("\n") ? text.replaceAll("\n", `\n${indent}`) : text
}

export function getStringRepresentation(
	obj: AnyType,
	indentLevel = 0,
	rationalForm: (rational: RationalType) => string = formatAsRational,
	listPadding = " ",
): string {
	const baseIndent = " ".repeat(4 * indentLevel)
	const contentIndent = " ".repeat(4 * (indentLevel + 1))

	// NOTE: A Function is the one runtime value carrying no Type key — it is
	// emitted as a bare JavaScript function, not a tagged object — so it is
	// answered before anything reads that key, exactly as `anyIs` answers it.
	// Without this, printing a Function, or anything merely HOLDING one, read
	// `undefined.includes` and threw.
	//
	// NOTE: One fixed word, and no more. A Function's Type is erased by the
	// time it reaches here, and its source text is a JavaScript rendering of a
	// simplified body — neither is something a Program should print. The name
	// stays stable so a Record holding a Function renders the same every time.
	if (typeof obj === "function") {
		return "Function"
	}

	if (obj[typeKeySymbol] === "Record") {
		let entries = Object.entries(obj)

		if (entries.length > 0) {
			let members = entries.map(
				([key, value]) =>
					`${key} = ${getStringRepresentation(value, 0, rationalForm, listPadding)}`,
			)
			let singleLineString = `{ ${members.join(", ")} }`

			if (singleLineString.length < singleLineMaxLength) {
				return singleLineString
			} else {
				return `{\n${contentIndent}${members
					.map((member) => indented(member, contentIndent))
					.join(`,\n${contentIndent}`)}\n${baseIndent}}`
			}
		} else {
			return "{}"
		}
	} else if (obj[typeKeySymbol] === "List") {
		// NOTE: A List holds its items in two runs with a view into each — see
		// `List.ts` — so what is rendered is the LOGICAL items rather than
		// whatever the backing Array happens to hold. `materialise` is what
		// answers those, and the box it collapses reads the same afterwards.
		let items = materialise(obj)

		if (items.length > 0) {
			let members = items.map((value) =>
				getStringRepresentation(value, 0, rationalForm, listPadding),
			)
			let singleLineString = `[${listPadding}${members.join(", ")}${listPadding}]`

			if (singleLineString.length < singleLineMaxLength) {
				return singleLineString
			} else {
				return `[\n${contentIndent}${members
					.map((member) => indented(member, contentIndent))
					.join(`,\n${contentIndent}`)}\n${baseIndent}]`
			}
		} else {
			return "[]"
		}
	} else if (obj[typeKeySymbol] === "Rational") {
		// NOTE: The one value the two renderings disagree about. The
		// structural one keeps the lowest-terms pair; the printable one
		// answers what `Rational::toString` answers, where a whole Rational is
		// its numerator alone.
		return rationalForm(obj)
	} else if (obj[typeKeySymbol] === "Algebraic") {
		return algebraicToString(obj).value
	} else if (obj[typeKeySymbol] === "Transcendental") {
		return transcendentalToString(obj).value
	} else if (obj[typeKeySymbol] === "Integer") {
		return integerToString(obj).value
	} else if (obj[typeKeySymbol] === "Boolean") {
		// NOTE: `Boolean.toString` is implemented in Essence now, so the
		// rendering it does is spelled out here rather than called.
		return obj.value ? "true" : "false"
	} else if (obj[typeKeySymbol] === "String") {
		// NOTE: The same quoting `List.toString` and `Optional.toString` reach
		// for, out of `String.ts` — a String is quoted inside a structure
		// wherever the structure is rendered, and this walk is one of the
		// places that renders one.
		return quotedText(obj.value)
	} else if (obj[typeKeySymbol] === "Randomness") {
		// NOTE: One fixed word, like a Function's. What a source holds is four
		// words of generator state, which say nothing to a reader and would
		// differ between two runs of one Program.
		return "Randomness"
	} else if (obj[typeKeySymbol].includes("#")) {
		// NOTE: Case values print as their tag, with the payload spelled out
		// like a Record when the Case carries one.
		let payloadEntries = Object.entries(obj)

		if (payloadEntries.length === 0) {
			return obj[typeKeySymbol]
		}

		// NOTE: A ONE-member Case prints its payload bare, in parentheses,
		// because that is how the language already writes one: `#Value(5)`
		// stands for `#Value({ item = 5 })`, and the member's name is decided
		// by the Case rather than chosen at the construction. Spelling it as a
		// Record here would print a name the writer never wrote — and every
		// `Optional` in a Program is one of these, so the noise would be
		// everywhere.
		if (payloadEntries.length === 1) {
			return `${obj[typeKeySymbol]}(${getStringRepresentation(
				payloadEntries[0]![1] as never,
				indentLevel,
				rationalForm,
				listPadding,
			)})`
		}

		let payload = {
			...Object.fromEntries(payloadEntries),
			[typeKeySymbol]: "Record",
		}

		return `${obj[typeKeySymbol]} ${getStringRepresentation(
			payload as never,
			indentLevel,
			rationalForm,
			listPadding,
		)}`
	} else {
		// NOTE: A kind the walk above does not know may still have said how it
		// is rendered — the registry in `registry.ts` is where a container's
		// own module leaves that, and probing it HERE is what keeps the arms
		// above the whole cost of printing for a Program that holds none. A
		// Dictionary is the one such kind today, and its arm cost every Program
		// that printed anything 1,281 bytes before it moved.
		let kind = kindOf(obj[typeKeySymbol])

		if (kind !== undefined) {
			return kind.render(
				obj,
				indentLevel,
				rationalForm,
				listPadding,
				getStringRepresentation,
			)
		}

		// NOTE: Unreachable for any value the Compiler emits — every Essence
		// value carries one of the tags above. It answers rather than throws
		// because a printer that crashes takes the Program with it, and what a
		// reader needs then is the tag it did not recognise.
		return `<unknown value: ${String(obj[typeKeySymbol])}>`
	}
}

// NOTE: The unit value every writing entry answers with. `{}` is the language's
// unit Type, and an empty Record is what one is at runtime — built here rather
// than through `Record.createRecord`, because `Record.ts` reaches BACK into this
// module for `getStringRepresentation` and a runtime cycle between the two would
// be a cost paid on every Program for one object literal.
const unit: RecordType = { [typeKeySymbol]: "Record" }

// NOTE: Which of the two streams a piece of output was written to, as the one
// word every reader outside this module names it by — the runtime's Stream
// Cases are tags on a value, and a capture is not holding one.
export type OutputStream = "output" | "error"

// NOTE: Where a Program's output goes when something other than the terminal is
// asking for it. There is exactly one such caller today — the test runtime,
// which shows what a test wrote WITH that test's report rather than
// interleaved with the reporter's own lines — and this is the seam it reaches
// through, so that `Terminal` stays the one place that knows how a Program
// writes anything.
export type OutputSink = (text: string, stream: OutputStream) => void

// NOTE: A dynamically scoped binding, installed for the length of ONE
// synchronous call and restored by the `finally` below — not a mode something
// switches on and leaves on. That is what makes it safe to say a Program's
// output belongs to whatever `withOutputSink` was wrapped around: nothing
// outside that call can observe it, because nothing else runs during it. Tests
// are synchronous and run one at a time in phase 1, so one test's output can
// not reach another's capture.
//
// The day tasks land, or the runner runs tests in parallel inside one realm,
// this becomes an `AsyncLocalStorage` — the SHAPE stays what it is here, a
// capability resolved where the writing happens rather than a parameter
// threaded through every Method that might print. Workers need nothing: a
// worker is its own realm and holds its own binding.
let outputSink: OutputSink | null = null

export function withOutputSink<Value>(
	sink: OutputSink | null,
	run: () => Value,
): Value {
	let previous = outputSink

	outputSink = sink

	try {
		return run()
	} finally {
		outputSink = previous
	}
}

// NOTE: `write(_ text: String, to stream: Stream)` — one native, with the
// Stream DEFAULTED in `Terminal.es` to `#Output`, so a call that leaves it out
// reaches this same export through the frame the Compiler synthesizes for the
// default. It is the ONE primitive under everything a Program writes: no
// newline, no quotes, nothing added. `print` puts the newline in the String it
// hands over, in Essence, which is what keeps this honest about writing exactly
// what it was given.
//
// NOTE: `process.stdout.write`/`process.stderr.write` rather than
// `console.log`/`console.error`, which both append a newline of their own —
// there is no way to spell "no newline" through them, and a `write` that added
// one would not be the primitive `print` is built on.
//
// NOTE: But only where the host HAS those streams. Bun, Node and Deno do; a
// browser has no `process` at all, and what it offers instead — the console —
// is made of lines. So the stream is looked for first, and where there is none
// the text goes to the console with the one newline `print` appended taken off
// again, which is the newline the console puts back. A `write` that ends
// without one still lands as a line of its own there — the console has no way
// to continue a line — which is the honest cost of a host without streams, and
// not one a Program pays on any host that has them.
export function write(text: StringType, stream: StreamType): RecordType {
	let toError = stream[typeKeySymbol] === "Stream#Error"

	// A sink takes the bytes before any host does: what a Program under test
	// writes belongs to the capture, on a host with streams and on one without.
	if (outputSink !== null) {
		outputSink(text.value, toError ? "error" : "output")

		return unit
	}

	let host = hostStream(toError)

	if (host !== undefined) {
		host.write(text.value)
	} else if (toError) {
		console.error(asConsoleLine(text.value))
	} else {
		console.log(asConsoleLine(text.value))
	}

	return unit
}

// NOTE: Looked up on every write rather than once at load, for two reasons. A
// top-level read of `process.stdout` is a statement esbuild can not shake, so
// it would sit in every bundle whether or not the Program writes; and the spec
// harnesses swap `process.stdout.write` for the duration of a Program, which a
// stream remembered at load time would never see. The lookup is a `typeof` and
// two property reads, beside a write to a file descriptor.
//
// NOTE: `typeof process`, because a bare `process` in a host without one is a
// ReferenceError, not `undefined`. And the stream's `write` is checked rather
// than the stream's presence: a bundler's `process` shim tends to carry a
// `stdout` that is an empty object, or null.
type HostStream = { write(text: string): unknown }

function hostStream(toError: boolean): HostStream | undefined {
	if (typeof process === "undefined") {
		return undefined
	}

	let candidate: HostStream | null | undefined = toError
		? process.stderr
		: process.stdout

	return typeof candidate?.write === "function" ? candidate : undefined
}

// NOTE: Exactly one newline comes off, never all of them: `print("")` is a
// blank line and has to stay one, and a text that ends in two is a line
// followed by a blank one.
function asConsoleLine(text: string): string {
	return text.endsWith("\n") ? text.slice(0, -1) : text
}

// NOTE: `inspect` — the structural print, for the Program's AUTHOR. It answers
// with the very value it was handed, so it can be wrapped around any Expression
// without changing what that Expression evaluates to, which is why the runtime
// signature is generic. That, and the arity, are exactly what the generated
// native contract (`natives.generated.ts`) asserts this export against.
//
// NOTE: `console.log`, not `process.stdout.write`. A structural rendering is a
// whole line by construction — it is never continued — and going through
// `console.log` is what a value inspected in a Program under test still arrives
// through, which is how the golden and sweep harnesses capture it.
//
// NOTE: A sink is offered the newline `console.log` would have appended, so
// that a capture holds the bytes a terminal would have shown and a `write` and
// an `inspect` compose into one text.
export function inspect<Value extends AnyType>(value: Value): Value {
	let rendering = getStringRepresentation(value)

	if (outputSink !== null) {
		outputSink(`${rendering}\n`, "output")
	} else {
		console.log(rendering)
	}

	return value
}

// NOTE: `describe` — the walk above, handed back rather than written, so that a
// message can carry a value's structure. It is the whole of what `inspect`
// renders and nothing of what `inspect` does, which is why the two are separate
// exports over one Function rather than one export the other is written on: an
// `inspect` written as this and a `write` would move a Program's structural
// output off the console line the golden and sweep harnesses capture it from.
export function describe<Value extends AnyType>(value: Value): StringType {
	return createString(getStringRepresentation(value))
}

// NOTE: The reading half. A Program reads its input a LINE at a time, and a
// descriptor answers bytes at whatever boundary the host happened to have them
// — so what a read pulls and what a read hands out are two different amounts,
// and the difference is held here. `pending` is text the host has already given
// up and no call has taken yet, `ended` is the host saying there is no more,
// and `scanned` is how much of `pending` a search for a break has already been
// over. One buffer and no more: the input is one stream, and a second buffer
// over the same descriptor would take bytes the first one is about to need.
//
// NOTE: The decoder is the state that makes the buffer necessary in the first
// place. A character of three bytes can land across two reads, and a decoder
// told `stream: true` holds the half it has until the rest arrives. Built on
// the first read rather than at load, so that a Program which never reads
// carries no construction — and so that a browser, where there is nothing to
// read, never builds one at all.
type InputState = {
	pending: string
	ended: boolean
	scanned: number
	decoder: TextDecoder | null
}

let input: InputState = {
	pending: "",
	ended: false,
	scanned: 0,
	decoder: null,
}

// NOTE: The reading half of `withOutputSink`, and the same shape: a dynamically
// scoped binding installed for the length of ONE synchronous call and put back
// by the `finally`. `text` is the whole of the input for that call, and `null`
// is the host's own descriptor read from the start. Both replace the buffer
// above, which is what makes a read that is staged repeatable — the state a
// reading Program carries is the one thing a caller can not otherwise reach.
export function withInputSource<Value>(
	text: string | null,
	run: () => Value,
): Value {
	let previous = input

	input = {
		pending: text ?? "",
		ended: text !== null,
		scanned: 0,
		decoder: null,
	}

	try {
		return run()
	} finally {
		input = previous
	}
}

// NOTE: What a host can be asked for: some bytes, into a buffer, answering how
// many arrived and zero at the end of the input. Every host below is reduced to
// this one Function, so that the buffering above is written once.
type ByteReader = (into: Uint8Array) => number

// NOTE: Deno first, because it is the one host that answers with a Method of
// its own — `Deno.stdin.readSync` — rather than through the Node file system.
// It answers `null` at the end of the input where the others answer zero.
type DenoHost = {
	stdin?: { readSync?: (into: Uint8Array) => number | null }
}

// NOTE: Bun and Node reach `readSync` through `process.getBuiltinModule`, which
// is the ONE door to a builtin that costs no import: a static `import "node:fs"`
// here would be a specifier the bundler has to resolve, and every Program's
// bundle is built for the browser, where it resolves to nothing at all. So the
// module is asked for at the moment of the first read, off a global that a
// browser does not have.
type BuiltinModules = {
	getBuiltinModule?: (identifier: string) => unknown
}

type FileSystem = {
	readSync?: (
		descriptor: number,
		into: Uint8Array,
		offset: number,
		length: number,
		position: null,
	) => number
}

// NOTE: Looked up on every pull rather than once, for the reason `hostStream`
// is: a lookup remembered at load would sit in every bundle whether or not the
// Program reads, and the specs stage a host around a call.
function hostReader(): ByteReader | undefined {
	let deno = (globalThis as { Deno?: DenoHost }).Deno
	let denoInput = deno?.stdin

	if (denoInput !== undefined && typeof denoInput.readSync === "function") {
		let readSync = denoInput.readSync

		return (into) => readSync.call(denoInput, into) ?? 0
	}

	if (typeof process === "undefined") {
		return undefined
	}

	let getBuiltinModule = (process as unknown as BuiltinModules)
		.getBuiltinModule

	if (typeof getBuiltinModule !== "function") {
		return undefined
	}

	let fileSystem = getBuiltinModule.call(process, "node:fs") as
		| FileSystem
		| undefined
	let readSync = fileSystem?.readSync

	if (typeof readSync !== "function") {
		return undefined
	}

	return (into) => readDescriptor(readSync, into)
}

// NOTE: Descriptor 0 is the Program's input on every host that has one, and it
// is read rather than `process.stdin`, whose own reading is asynchronous —
// there is nothing for a Method to answer while it waits. Two of the
// descriptor's errors are answers rather than failures. EOF is how a console reports the end of its input on
// Windows, where the others report zero bytes. EAGAIN is a descriptor somebody
// put in non-blocking mode: the mode belongs to the OPEN FILE, so a parent
// process that did it hands it to a child that never asked, and the read has to
// be tried again rather than reported as the end of the input.
function readDescriptor(
	readSync: NonNullable<FileSystem["readSync"]>,
	into: Uint8Array,
): number {
	while (true) {
		try {
			return readSync(0, into, 0, into.length, null)
		} catch (error) {
			let code = (error as { code?: string }).code

			if (code === "EOF") {
				return 0
			}

			if (code !== "EAGAIN") {
				throw error
			}

			napBriefly()
		}
	}
}

// NOTE: Ten milliseconds of nothing, so that waiting for a person to type is
// not a core at full tilt. `Atomics.wait` is the one synchronous wait a host
// offers, and it is only reached from the EAGAIN arm above — a browser, where
// the main thread is not allowed to wait, has no descriptor to read in the
// first place. A host without `SharedArrayBuffer` retries at once, which is
// slower to nobody but the machine.
let napBuffer: Int32Array | null = null

function napBriefly(): void {
	if (typeof SharedArrayBuffer === "undefined") {
		return
	}

	napBuffer ??= new Int32Array(new SharedArrayBuffer(4))

	Atomics.wait(napBuffer, 0, 0, 10)
}

// NOTE: 64 KiB per crossing, allocated on the first read and kept: what a read
// costs is the crossing into the host rather than the bytes, and a buffer built
// per call would be 64 KiB of garbage per line. A read answers what the host
// HAS rather than filling the buffer, so a large one does not make a Program
// wait for more input than it asked for.
const INPUT_BUFFER_LENGTH = 65536

let inputBuffer: Uint8Array | null = null

// NOTE: One crossing, and what it produced added to the buffer. A decode of a
// chunk ending mid-character adds nothing at all, which is why every caller
// asks again rather than assuming a pull made progress.
function pull(): void {
	let reader = hostReader()

	if (reader === undefined) {
		input.ended = true

		return
	}

	inputBuffer ??= new Uint8Array(INPUT_BUFFER_LENGTH)
	input.decoder ??= new TextDecoder()

	let count = reader(inputBuffer)

	if (count <= 0) {
		// NOTE: A decode with nothing to decode is what flushes a character the
		// input ended in the middle of, as the replacement character.
		input.pending += input.decoder.decode()
		input.ended = true

		return
	}

	input.pending += input.decoder.decode(inputBuffer.subarray(0, count), {
		stream: true,
	})
}

// NOTE: The three breaks `String::lines` splits on, so that reading a text line
// by line and splitting the same text into lines answer the same lines.
//
// NOTE: The search starts where the last one stopped rather than at the
// beginning of the buffer. A line arrives in as many reads as it needs, and
// searching all of what has arrived after each of them makes ONE long line
// quadratic: a single twenty megabyte line measured 192 ms read with the
// search starting at the beginning and 5.2 ms with it starting here.
function firstBreakIn(text: string, from: number): number {
	let feed = text.indexOf("\n", from)
	let carriage = text.indexOf("\r", from)

	if (feed < 0) {
		return carriage
	}

	if (carriage < 0) {
		return feed
	}

	return feed < carriage ? feed : carriage
}

// NOTE: `readLine()` — the next line, without the break that ends it, and
// `#Empty` when there is no next line. The end of the input is not a failure
// and not an empty line either, which is what the Optional is for.
//
// NOTE: A `\r` at the very end of what has been pulled is the one character
// that can not be read yet: it is a break on its own AND the first half of
// `\r\n`, and which one it is is the next byte's to say. So the loop pulls
// again rather than deciding, and decides once the input has ended.
export function readLine(): OptionalType<StringType> {
	while (true) {
		let breakAt = firstBreakIn(input.pending, input.scanned)

		if (breakAt >= 0) {
			let carriage = input.pending.charCodeAt(breakAt) === 13

			if (
				carriage &&
				breakAt === input.pending.length - 1 &&
				!input.ended
			) {
				pull()

				continue
			}

			let paired =
				carriage && input.pending.charCodeAt(breakAt + 1) === 10
			let line = input.pending.slice(0, breakAt)

			input.pending = input.pending.slice(breakAt + (paired ? 2 : 1))
			input.scanned = 0

			return createValue(createString(line))
		}

		if (input.ended) {
			if (input.pending.length === 0) {
				return createEmpty()
			}

			let line = input.pending

			input.pending = ""
			input.scanned = 0

			return createValue(createString(line))
		}

		input.scanned = input.pending.length

		pull()
	}
}

// NOTE: `readAll()` — everything left, unchanged. The break a text ends with is
// part of the answer, which is what makes this the reading side of `write`: a
// Program that reads its input and writes it back writes what it was given.
export function readAll(): StringType {
	while (!input.ended) {
		pull()
	}

	let text = input.pending

	input.pending = ""
	input.scanned = 0

	return createString(text)
}
