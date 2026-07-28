import { toString as algebraicToString } from "./Algebraic"
import type { BooleanType } from "./Boolean"
import { toString as integerToString } from "./Integer"
import { formatAsRational } from "./Rational"
import type { StepType } from "./Step"
import { toString as transcendentalToString } from "./Transcendental"
import { type AnyType, typeKeySymbol } from "./type"

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

		let payload = {
			...Object.fromEntries(payloadEntries),
			[typeKeySymbol]: "Record",
		}

		return `${obj[typeKeySymbol]} ${getStringRepresentation(
			payload as never,
			indentLevel,
		)}`
	} else {
		return "Nothing"
	}
}

// NOTE: The one native free Function, declared in `packages/stdlib/sources/Print.es` as
// `__print<Item>(_ value: Item) -> Item` and bound here by that name. It is
// generic — it answers with the very value it was handed — so the runtime
// signature is generic too, which is also exactly what the generated native
// contract (`natives.generated.ts`) asserts this export against.
export function __print<Item extends AnyType>(message: Item): Item {
	console.log(getStringRepresentation(message))

	return message
}

// NOTE: The `loop` family — the native drivers behind the `loop` Overloads
// declared in `packages/stdlib/sources/Loop.es`. Each is a free Function, bound by its
// mangled `loop__overload$N` name to the Overload it implements; the order here
// is the order the entries are written there. Only TWO are native: a loop can
// not be written in Essence — it would need a loop to write — so the two
// irreducible drivers stay here, each a plain JavaScript loop threading the
// State the callback hands back. The `until` and counted entries are written in
// Essence on `while` (see `Loop.es`), so they have no driver here.

// NOTE: `$1` is the `while` loop — steps while the condition holds, checked
// BEFORE each step, so a condition false on the seed returns it unchanged. It is
// the predicate primitive the Essence `until` and counted entries build on.
export function loop__overload$1<State extends AnyType>(
	state: State,
	condition: (state: State) => BooleanType,
	advance: (state: State) => State,
): State {
	while (condition(state).value) {
		state = advance(state)
	}

	return state
}

// NOTE: `$4` is the general loop — each step answers with a `Step`. `#Done` stops the
// loop and its `value` is the Result; `#Continue` carries the next State and the
// loop goes again. The tag is read the same way `List.sort` reads an `Ordering`.
export function loop__overload$4<State extends AnyType, Result extends AnyType>(
	state: State,
	advance: (state: State) => StepType<State, Result>,
): Result {
	while (true) {
		let next = advance(state)

		if (next[typeKeySymbol] === "Step#Done") {
			return next.value
		}

		state = next.state
	}
}
