import { toString as algebraicToString } from "./Algebraic"
import { toString__overload$1 as integerToString } from "./Integer"
import { materialise } from "./List"
import { createEmpty, createValue, type OptionalType } from "./Optional"
import { formatAsRational, type RationalType } from "./Rational"
import type { RecordType } from "./Record"
import { caseText, kindOf, singleLineMaxLength } from "./registry"
import type { StreamType } from "./Stream"
import { createString, quotedText, type StringType } from "./String"
import { toString as transcendentalToString } from "./Transcendental"
import { type AnyType, typeKeySymbol } from "./type"

// The natives of `Terminal`, and the renderer behind `inspect`. See "Terminal"
// in DEVELOPMENT.md.

// A rendering at indent zero, re-indented after each newline. Every arm writes
// only indentation after a newline, so a child is rendered once and reused.
function indented(text: string, indent: string): string {
	return text.includes("\n") ? text.replaceAll("\n", `\n${indent}`) : text
}

// The structural rendering by default. `Record.toString` hands in the
// printable Rational form and no List padding. See "The structural rendering"
// in DEVELOPMENT.md.
export function getStringRepresentation(
	obj: AnyType,
	indentLevel = 0,
	rationalForm: (rational: RationalType) => string = formatAsRational,
	listPadding = " ",
	// Renderers for the declared members a Record routes to their own
	// `toString`, used in the Record arm only and not passed down. `??` keeps
	// an empty rendering, which is not nullish.
	memberRenderers?: Record<string, (value: AnyType) => string>,
): string {
	const baseIndent = " ".repeat(4 * indentLevel)
	const contentIndent = " ".repeat(4 * (indentLevel + 1))

	// A Function carries no Type key, so it is answered before anything reads
	// one. It renders as one fixed word, since its source says nothing to a reader.
	if (typeof obj === "function") {
		return "Function"
	}

	if (obj[typeKeySymbol] === "Record") {
		let entries = Object.entries(obj)

		if (entries.length > 0) {
			let members = entries.map(
				([key, value]) =>
					`${key} = ${
						memberRenderers?.[key]?.(value) ??
						getStringRepresentation(
							value,
							0,
							rationalForm,
							listPadding,
						)
					}`,
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
		// `materialise` answers the logical items, not the backing Array.
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
		return rationalForm(obj)
	} else if (obj[typeKeySymbol] === "Algebraic") {
		return algebraicToString(obj).value
	} else if (obj[typeKeySymbol] === "Transcendental") {
		return transcendentalToString(obj).value
	} else if (obj[typeKeySymbol] === "Integer") {
		return integerToString(obj).value
	} else if (obj[typeKeySymbol] === "Boolean") {
		// `Boolean.toString` is written in Essence, so its rendering is spelled
		// out here.
		return obj.value ? "true" : "false"
	} else if (obj[typeKeySymbol] === "String") {
		// A String inside a structure is quoted, as `List.toString` quotes it.
		return quotedText(obj.value)
	} else if (obj[typeKeySymbol] === "Randomness") {
		// A generator's state says nothing to a reader and differs between runs.
		return "Randomness"
	} else if (obj[typeKeySymbol].includes("#")) {
		// `Choice#Case`, with `caseText` dropping the Module the tag carries.
		let payloadEntries = Object.entries(obj)
		let tag = caseText(obj[typeKeySymbol])

		if (payloadEntries.length === 0) {
			return tag
		}

		// One member prints bare in parentheses, as the language writes
		// `#Value(5)` for `#Value({ item = 5 })`.
		if (payloadEntries.length === 1) {
			return `${tag}(${getStringRepresentation(
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

		return `${tag} ${getStringRepresentation(
			payload as never,
			indentLevel,
			rationalForm,
			listPadding,
		)}`
	} else {
		// Kinds no arm names may be registered. See "The kind registry" in
		// DEVELOPMENT.md.
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

		// Unreachable for any value the Compiler emits. Answered rather than
		// thrown, since a printer that crashes takes the Program with it.
		return `<unknown value: ${String(obj[typeKeySymbol])}>`
	}
}

// The unit value every writing entry answers with. Built here, since
// `Record.ts` imports this module and `createRecord` would close a cycle.
const unit: RecordType = { [typeKeySymbol]: "Record" }

// The stream a piece of output went to, as a plain word.
export type OutputStream = "output" | "error"

// Where a Program's output goes when the test runtime captures it.
export type OutputSink = (text: string, stream: OutputStream) => void

// Installed for the length of one call by `withOutputSink`. A runner that ran
// tests in parallel in one realm would need `AsyncLocalStorage` here.
let outputSink: OutputSink | null = null

// Installs the sink for one call, and until the promise it answers settles.
// See "Output sinks and input sources" in DEVELOPMENT.md.
export function withOutputSink<Value>(
	sink: OutputSink | null,
	run: () => Value,
): Value {
	let previous = outputSink

	outputSink = sink

	let answered: Value

	try {
		answered = run()
	} catch (thrown) {
		outputSink = previous

		throw thrown
	}

	if (!isPending(answered)) {
		outputSink = previous

		return answered
	}

	return answered.then(
		(value: unknown) => {
			outputSink = previous

			return value
		},
		(thrown: unknown) => {
			outputSink = previous

			throw thrown
		},
	) as Value
}

// A `then` is the whole test, since an `async` emitted Function answers a
// real promise.
function isPending(value: unknown): value is Promise<unknown> {
	return (
		typeof (value as { then?: unknown } | null | undefined)?.then ===
		"function"
	)
}

// `write(_ text: String, to stream: Stream)`, the primitive under all output.
// It writes exactly the text. See "Writing to the host" in DEVELOPMENT.md.
export function write(text: StringType, stream: StreamType): RecordType {
	let toError = stream[typeKeySymbol] === "Stream#Error"

	// A sink takes the text before any host does.
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

// Looked up on every write rather than once at load, so the lookup can be
// shaken out and the specs can swap the streams.
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

// Exactly one newline comes off, so `print("")` stays a blank line.
function asConsoleLine(text: string): string {
	return text.endsWith("\n") ? text.slice(0, -1) : text
}

// `inspect` answers the value it was handed, so it can wrap any Expression.
// It writes through `console.log`, where the harnesses capture it.
export function inspect<Value extends AnyType>(value: Value): Value {
	let rendering = getStringRepresentation(value)

	if (outputSink !== null) {
		outputSink(`${rendering}\n`, "output")
	} else {
		console.log(rendering)
	}

	return value
}

// The structural rendering as a String. Kept apart from `inspect`, so that
// `inspect` keeps writing through `console.log`.
export function describe<Value extends AnyType>(value: Value): StringType {
	return createString(getStringRepresentation(value))
}

// The one buffer over the input. See "Reading input" in DEVELOPMENT.md.
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

// Stages the input for one call, scoped as `withOutputSink` is. `null` reads
// the host's own input from the start.
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

	let answered: Value

	try {
		answered = run()
	} catch (thrown) {
		input = previous

		throw thrown
	}

	if (!isPending(answered)) {
		input = previous

		return answered
	}

	return answered.then(
		(value: unknown) => {
			input = previous

			return value
		},
		(thrown: unknown) => {
			input = previous

			throw thrown
		},
	) as Value
}

// Reads some bytes into the buffer, answering how many, and zero at the end.
type ByteReader = (into: Uint8Array) => number

// Deno's `readSync` answers `null` at the end where the others answer zero.
type DenoHost = {
	stdin?: { readSync?: (into: Uint8Array) => number | null }
}

// Bun and Node reach `node:fs` through `process.getBuiltinModule`, since a
// static import would have to resolve in a bundle built for the browser.
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

// Looked up on every pull, for the reasons `hostStream` gives.
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

// Reads descriptor 0. `EOF` is a Windows console's end of input, and `EAGAIN`
// is a non-blocking descriptor, which waits and reads again.
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

// Waits ten milliseconds so a pending read does not spin a core. A host
// without `SharedArrayBuffer` retries at once.
let napBuffer: Int32Array | null = null

function napBriefly(): void {
	if (typeof SharedArrayBuffer === "undefined") {
		return
	}

	napBuffer ??= new Int32Array(new SharedArrayBuffer(4))

	Atomics.wait(napBuffer, 0, 0, 10)
}

// Allocated once and kept. A read answers what the host has, so a large
// buffer never waits for more input than a call asked for.
const INPUT_BUFFER_LENGTH = 65536

let inputBuffer: Uint8Array | null = null

// Whether a read reached the host's own input rather than a staged one. A
// runner that remembers results asks, since the host's input is in no key.
let hostInputRead = false

export function hasReadHostInput(): boolean {
	return hostInputRead
}

// One read into the buffer. A chunk ending mid-character adds nothing, so
// callers ask again rather than assume progress.
function pull(): void {
	let reader = hostReader()

	if (reader === undefined) {
		input.ended = true

		return
	}

	hostInputRead = true
	inputBuffer ??= new Uint8Array(INPUT_BUFFER_LENGTH)
	input.decoder ??= new TextDecoder()

	let count = reader(inputBuffer)

	if (count <= 0) {
		// Flushes a character the input ended inside, as the replacement
		// character.
		input.pending += input.decoder.decode()
		input.ended = true

		return
	}

	input.pending += input.decoder.decode(inputBuffer.subarray(0, count), {
		stream: true,
	})
}

// The first `\n` or `\r` from `from` on. The search resumes where the last
// stopped, so a long line arriving over many reads stays linear.
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

// The next line without its break, or `#Empty` at the end of the input. A
// final `\r` waits for the next byte, which may make it `\r\n`.
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

// Everything left, final break included, so echoing input writes it unchanged.
export function readAll(): StringType {
	while (!input.ended) {
		pull()
	}

	let text = input.pending

	input.pending = ""
	input.scanned = 0

	return createString(text)
}
