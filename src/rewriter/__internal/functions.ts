import { toString as algebraicToString } from "./Algebraic"
import type { BooleanType } from "./Boolean"
import {
	createInteger,
	type IntegerType,
	toString as integerToString,
} from "./Integer"
import { toString__overload$1 as rationalToString } from "./Rational"
import type { StepType } from "./Step"
import { toString as transcendentalToString } from "./Transcendental"
import { type AnyType, typeKeySymbol } from "./type"

const singleLineMaxLength = 60

export function getStringRepresentation(obj: AnyType, indentLevel = 0): string {
	const baseIndent = " ".repeat(4 * indentLevel)
	const contentIndent = " ".repeat(4 * (indentLevel + 1))

	if (obj[typeKeySymbol] === "Record") {
		let keyValuePairs: Array<string> = []

		if (Object.entries(obj).length > 0) {
			let singleLineString = ""

			for (let [key, value] of Object.entries(obj)) {
				keyValuePairs.push(
					`${key} = ${getStringRepresentation(value, 0)}`,
				)
			}

			singleLineString = `{ ${keyValuePairs.join(", ")} }`

			if (singleLineString.length < singleLineMaxLength) {
				return singleLineString
			} else {
				for (let [key, value] of Object.entries(obj)) {
					keyValuePairs.push(
						`${key} = ${getStringRepresentation(
							value,
							indentLevel + 1,
						)}`,
					)
				}

				return `{\n${contentIndent}${keyValuePairs.join(
					`,\n${contentIndent}`,
				)}\n${baseIndent}}`
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
		return rationalToString(obj).value
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

// NOTE: The one native free Function, declared in `src/stdlib/Print.es` as
// `__print<Item>(_ value: Item) -> Item` and bound here by that name. It is
// generic — it answers with the very value it was handed — so the runtime
// signature is generic too, which is also exactly what the generated native
// contract (`natives.generated.ts`) asserts this export against.
export function __print<Item extends AnyType>(message: Item): Item {
	console.log(getStringRepresentation(message))

	return message
}

// NOTE: The `loop` family — the native drivers behind the four `loop` Overloads
// declared in `src/stdlib/Loop.es`. Each is a free Function, bound by its
// mangled `loop__overload$N` name to the Overload it implements; the order here
// is the order the entries are written there. A loop can not be written in
// Essence — it would need a loop to write — so these stay native, each a plain
// JavaScript loop threading the State the callback hands back.

// NOTE: The counted loop — one turn per Integer from `start` through `end`, both
// included, threading the State. Counts DOWN when `start` is the greater, the
// same direction `List.of(integersFrom:through:)` counts, so the two agree on
// what an inverted range means. The index is handed to the callback as an
// `Integer` value, freshly wrapped from the bigint the loop counts with.
export function loop__overload$1<State extends AnyType>(
	start: IntegerType,
	end: IntegerType,
	state: State,
	advance: (index: IntegerType, state: State) => State,
): State {
	if (start.value <= end.value) {
		for (let value = start.value; value <= end.value; value++) {
			state = advance(createInteger(value), state)
		}
	} else {
		for (let value = start.value; value >= end.value; value--) {
			state = advance(createInteger(value), state)
		}
	}

	return state
}

// NOTE: The `while` loop — steps while the condition holds, checked BEFORE each
// step, so a condition false on the seed returns it unchanged.
export function loop__overload$2<State extends AnyType>(
	state: State,
	condition: (state: State) => BooleanType,
	advance: (state: State) => State,
): State {
	while (condition(state).value) {
		state = advance(state)
	}

	return state
}

// NOTE: The `until` loop — the negation of the `while` loop, stepping while the
// condition is `false` and stopping the moment it turns `true`.
export function loop__overload$3<State extends AnyType>(
	state: State,
	condition: (state: State) => BooleanType,
	advance: (state: State) => State,
): State {
	while (!condition(state).value) {
		state = advance(state)
	}

	return state
}

// NOTE: The general loop — each step answers with a `Step`. `#Done` stops the
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
