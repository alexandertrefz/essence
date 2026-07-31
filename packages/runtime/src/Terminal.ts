import { toString as algebraicToString } from "./Algebraic"
import { toString as integerToString } from "./Integer"
import { formatAsRational } from "./Rational"
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
// readers ask it the same question outside a Program: `Record.toString`, which
// is the structural rendering of a Record, and the Debug Adapter, whose
// variables pane shows a value the way a `Terminal.inspect` would.

const singleLineMaxLength = 60

export function getStringRepresentation(obj: AnyType, indentLevel = 0): string {
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
						`${key} = ${getStringRepresentation(value, 0)}`,
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
							)}`,
					)
					.join(`,\n${contentIndent}`)}\n${baseIndent}}`
			}
		} else {
			return "{}"
		}
	} else if (obj[typeKeySymbol] === "List") {
		if (obj.value.length > 0) {
			let singleLineString = `[ ${obj.value
				.map((value) => getStringRepresentation(value, 0))
				.join(", ")} ]`

			if (singleLineString.length < singleLineMaxLength) {
				return singleLineString
			} else {
				return `[\n${contentIndent}${obj.value
					.map((value) =>
						getStringRepresentation(value, indentLevel + 1),
					)
					.join(`,\n${contentIndent}`)}\n${baseIndent}]`
			}
		} else {
			return "[]"
		}
	} else if (obj[typeKeySymbol] === "Rational") {
		// NOTE: `Rational.toString` is implemented in Essence now — this is
		// the same lowest-terms fraction form it answers with.
		return formatAsRational(obj)
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
		return `"${obj.value}"`
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
			)})`
		}

		let payload = {
			...Object.fromEntries(payloadEntries),
			[typeKeySymbol]: "Record",
		}

		return `${obj[typeKeySymbol]} ${getStringRepresentation(
			payload as never,
			indentLevel,
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

// NOTE: `write(_ text: String, to stream: Stream)` — the second Overload entry,
// so the mangled name the Rewriter binds is `write__overload$2`. It is the ONE
// primitive under everything a Program writes: no newline, no quotes, nothing
// added. `print` puts the newline in the String it hands over, in Essence, which
// is what keeps this honest about writing exactly what it was given.
//
// NOTE: `process.stdout.write`/`process.stderr.write` rather than
// `console.log`/`console.error`, which both append a newline of their own —
// there is no way to spell "no newline" through them, and a `write` that added
// one would not be the primitive `print` is built on.
export function write__overload$2(
	text: StringType,
	stream: StreamType,
): RecordType {
	if (stream[typeKeySymbol] === "Stream#Error") {
		process.stderr.write(text.value)
	} else {
		process.stdout.write(text.value)
	}

	return unit
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
export function inspect<Value extends AnyType>(value: Value): Value {
	console.log(getStringRepresentation(value))

	return value
}
