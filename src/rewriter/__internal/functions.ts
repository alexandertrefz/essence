import { toString as algebraicToString } from "./Algebraic"
import { toString as integerToString } from "./Integer"
import { toString__overload$1 as rationalToString } from "./Rational"
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
