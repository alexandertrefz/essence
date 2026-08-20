import { toString as algebraicToString } from "./Algebraic"
import { toString as integerToString } from "./Integer"
import { materialise } from "./List"
import { formatAsRational, type RationalType } from "./Rational"
import type { RecordType } from "./Record"
import type { StreamType } from "./Stream"
import type { StringType } from "./String"
import { toString as transcendentalToString } from "./Transcendental"
import { type AnyType, typeKeySymbol } from "./type"

// NOTE: The native half of `packages/standard-library/sources/Terminal.es` — everything a
// Program can put in front of a person. Only TWO of the Namespace's entries are
// native: `write(_:to:)`, because a stream has to be reached somehow, and
// `inspect`, because the structural rendering below is what it IS. `print` and
// the stream-less `write` are written in Essence on top of those two.
//
// NOTE: `getStringRepresentation` lives here rather than in `functions.ts`
// because `inspect` is its only caller in the language — `functions.ts` keeps
// the `loop` drivers and nothing else now. It stays EXPORTED because two other
// readers ask it a question of the same shape outside a Program:
// `Record.toString`, which asks for the printable form, and the Debug Adapter,
// whose variables pane shows a value the way a `Terminal.inspect` would.

const singleLineMaxLength = 60

// NOTE: The escapes are the String Literal's own spellings, so what a quoted
// rendering shows is unambiguous: an embedded quote no longer reads as the
// closing one, a backslash as an escape it never was, and a line break no
// longer splits the one value across two lines of output. The remaining
// control characters have no Essence spelling of their own, so they render as
// their code point.
const stringEscapes: { [character: string]: string } = {
	"\\": "\\\\",
	'"': '\\"',
	"\n": "\\n",
	"\r": "\\r",
	"\t": "\\t",
}

function escapeStringContents(value: string): string {
	return value.replace(
		// oxlint-disable-next-line no-control-regex -- matching control characters is this function's job
		/[\\"\n\r\t\u0000-\u001F\u007F-\u009F]/g,
		(character) =>
			stringEscapes[character] ??
			`\\u{${character.charCodeAt(0).toString(16).toUpperCase()}}`,
	)
}

// NOTE: Two readers, one walk. `Terminal.inspect` asks for the STRUCTURAL
// rendering — what a value IS — and `Record.toString` asks for the PRINTABLE
// one, since a Record conforms to `Printable` and `Terminal.print` goes through
// it. The two differ in one place, the Rational, so that is the one piece a
// caller hands in: `Record.toString` passes `formatAsFraction`, where a whole
// Rational prints its numerator alone. The rest of the rendering is the same
// for both, quoted Strings included, and `Record.es` says so at its own
// `toString`.
//
// NOTE: A Function rather than a mode, so that a Program which never prints a
// Record never carries the second formatter. Naming `formatAsFraction` inside
// this walk puts it in every Program that prints anything at all, and measured
// 331 bytes of `Irrational.es` against the 139 the handed-in Function costs.
export function getStringRepresentation(
	obj: AnyType,
	indentLevel = 0,
	rationalForm: (rational: RationalType) => string = formatAsRational,
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
			// NOTE: The pairs are rendered ONCE per layout — the single-line
			// pass at indent zero, and, only if that came out too long, a
			// fresh pass at the nested indent. Pushing the second pass onto
			// the array the first one filled printed every member twice.
			let singleLineString = `{ ${entries
				.map(
					([key, value]) =>
						`${key} = ${getStringRepresentation(value, 0, rationalForm)}`,
				)
				.join(", ")} }`

			if (singleLineString.length < singleLineMaxLength) {
				return singleLineString
			} else {
				return `{\n${contentIndent}${entries
					.map(
						([key, value]) =>
							`${key} = ${getStringRepresentation(
								value,
								indentLevel + 1,
								rationalForm,
							)}`,
					)
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
			let singleLineString = `[ ${items
				.map((value) => getStringRepresentation(value, 0, rationalForm))
				.join(", ")} ]`

			if (singleLineString.length < singleLineMaxLength) {
				return singleLineString
			} else {
				return `[\n${contentIndent}${items
					.map((value) =>
						getStringRepresentation(
							value,
							indentLevel + 1,
							rationalForm,
						),
					)
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
		return `"${escapeStringContents(obj.value)}"`
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
		)}`
	} else {
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
