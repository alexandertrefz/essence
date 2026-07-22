import type { BooleanType } from "./Boolean"
import { createBoolean } from "./Boolean"
import type { IntegerType } from "./Integer"
import { createInteger } from "./Integer"
import type { ListType } from "./List"
import { createList } from "./List"
import type { NothingType } from "./Nothing"
import { createNothing } from "./Nothing"
import type { OrderingType } from "./Ordering"
import { equal, greater, less } from "./Ordering"
import { typeKeySymbol } from "./type"

export type StringType = { [typeKeySymbol]: "String"; value: string }

export function createString(value: string): StringType {
	return { [typeKeySymbol]: "String", value }
}

export function isEmpty(originalString: StringType): BooleanType {
	return createBoolean(originalString.value.length === 0)
}

export function hasAnyContent(originalString: StringType): BooleanType {
	return createBoolean(originalString.value.length !== 0)
}

export function is(
	originalString: StringType,
	otherString: StringType,
): BooleanType {
	return createBoolean(originalString.value === otherString.value)
}

export function isNot(
	originalString: StringType,
	otherString: StringType,
): BooleanType {
	return createBoolean(originalString.value !== otherString.value)
}

export function prepend(
	originalString: StringType,
	otherString: StringType,
): StringType {
	return createString(otherString.value + originalString.value)
}

export function append(
	originalString: StringType,
	otherString: StringType,
): StringType {
	return createString(originalString.value + otherString.value)
}

export function splitOn(
	originalString: StringType,
	splitterString: StringType,
): ListType<StringType> {
	// NOTE: A non-empty splitter is matched as a substring, which lands on
	// code-point boundaries and so is already correct. Splitting on the empty
	// String means "between every character" — `String.split("")` reads that
	// as every UTF-16 code unit, tearing an astral character into two lone
	// surrogates, so that one case splits by code point instead. This keeps
	// `splitOn("")` identical to `characters()`.
	let parts =
		splitterString.value === ""
			? Array.from(originalString.value)
			: originalString.value.split(splitterString.value)

	return createList(parts.map((chunk) => createString(chunk)))
}

export function contains(
	originalString: StringType,
	otherString: StringType,
): BooleanType {
	return createBoolean(originalString.value.includes(otherString.value))
}

export function doesNotContain(
	originalString: StringType,
	otherString: StringType,
): BooleanType {
	return createBoolean(!originalString.value.includes(otherString.value))
}

// biome-ignore lint/suspicious/noShadowRestrictedNames: This is a runtime function
export function toString(originalString: StringType): StringType {
	return originalString
}

// NOTE: Character-level Methods work over Unicode code points — `Array.from`
// splits a String into code points, not UTF-16 code units — so an astral
// character stays whole and `characterAt` never yields a lone surrogate.
// Substring Methods below match on the raw String, which is correct either
// way.

export function length(originalString: StringType): IntegerType {
	return createInteger(BigInt(Array.from(originalString.value).length))
}

export function characters(originalString: StringType): ListType<StringType> {
	return createList(
		Array.from(originalString.value).map((character) =>
			createString(character),
		),
	)
}

export function characterAt(
	originalString: StringType,
	index: IntegerType,
): StringType | NothingType {
	let codePoints = Array.from(originalString.value)

	if (index.value > -1 && index.value < BigInt(codePoints.length)) {
		return createString(codePoints[Number(index.value)])
	} else {
		return createNothing()
	}
}

export function uppercased(originalString: StringType): StringType {
	return createString(originalString.value.toUpperCase())
}

export function lowercased(originalString: StringType): StringType {
	return createString(originalString.value.toLowerCase())
}

export function trimmed(originalString: StringType): StringType {
	return createString(originalString.value.trim())
}

export function trimmedAtStart(originalString: StringType): StringType {
	return createString(originalString.value.trimStart())
}

export function trimmedAtEnd(originalString: StringType): StringType {
	return createString(originalString.value.trimEnd())
}

export function startsWith(
	originalString: StringType,
	prefix: StringType,
): BooleanType {
	return createBoolean(originalString.value.startsWith(prefix.value))
}

export function doesNotStartWith(
	originalString: StringType,
	prefix: StringType,
): BooleanType {
	return createBoolean(!originalString.value.startsWith(prefix.value))
}

export function endsWith(
	originalString: StringType,
	suffix: StringType,
): BooleanType {
	return createBoolean(originalString.value.endsWith(suffix.value))
}

export function doesNotEndWith(
	originalString: StringType,
	suffix: StringType,
): BooleanType {
	return createBoolean(!originalString.value.endsWith(suffix.value))
}

export function replaceEvery(
	originalString: StringType,
	part: StringType,
	replacement: StringType,
): StringType {
	return createString(
		originalString.value.replaceAll(part.value, replacement.value),
	)
}

export function repeated(
	originalString: StringType,
	count: IntegerType,
): StringType {
	if (count.value < 1n) {
		return createString("")
	}

	return createString(originalString.value.repeat(Number(count.value)))
}

export function reversed(originalString: StringType): StringType {
	return createString(Array.from(originalString.value).reverse().join(""))
}

export function slice(
	originalString: StringType,
	from: IntegerType,
	to: IntegerType,
): StringType {
	// NOTE: Half-open [from, to) over code points, each end clamped to the
	// String — clamped on the bigint, since a position past 2³¹ would wrap
	// negative once narrowed.
	let codePoints = Array.from(originalString.value)
	let count = BigInt(codePoints.length)
	let start = from.value < 0n ? 0n : from.value > count ? count : from.value
	let end = to.value < 0n ? 0n : to.value > count ? count : to.value

	if (end <= start) {
		return createString("")
	}

	return createString(codePoints.slice(Number(start), Number(end)).join(""))
}

export function firstIndexOf(
	originalString: StringType,
	part: StringType,
): IntegerType | NothingType {
	let codeUnitIndex = originalString.value.indexOf(part.value)

	if (codeUnitIndex < 0) {
		return createNothing()
	}

	// NOTE: `indexOf` counts code units; the match begins on a code-point
	// boundary, so counting the code points before it gives the code-point
	// position the character Methods use.
	return createInteger(
		BigInt(Array.from(originalString.value.slice(0, codeUnitIndex)).length),
	)
}

// NOTE: Padding counts by code point too, so `paddedAtStart(to 5, …)` reaches
// five characters however wide they are. An empty pad String, or a target the
// String already meets, leaves it unchanged.
function padded(
	originalString: StringType,
	target: IntegerType,
	pad: StringType,
	atStart: boolean,
): StringType {
	let codePoints = Array.from(originalString.value)
	let padChars = Array.from(pad.value)

	if (padChars.length === 0 || target.value <= BigInt(codePoints.length)) {
		return originalString
	}

	let needed = Number(target.value - BigInt(codePoints.length))
	let padding: Array<string> = []

	while (padding.length < needed) {
		padding.push(padChars[padding.length % padChars.length])
	}

	let padString = padding.join("")

	return createString(
		atStart
			? padString + originalString.value
			: originalString.value + padString,
	)
}

export function paddedAtStart(
	originalString: StringType,
	target: IntegerType,
	pad: StringType,
): StringType {
	return padded(originalString, target, pad, true)
}

export function paddedAtEnd(
	originalString: StringType,
	target: IntegerType,
	pad: StringType,
): StringType {
	return padded(originalString, target, pad, false)
}

export function compareTo(
	originalString: StringType,
	otherString: StringType,
): OrderingType {
	// NOTE: Lexicographic by code point, so the order agrees with the
	// code-point view the character Methods take — not JS's UTF-16 `<`.
	let first = Array.from(originalString.value)
	let second = Array.from(otherString.value)
	let shared = Math.min(first.length, second.length)

	for (let index = 0; index < shared; index++) {
		let firstPoint = first[index].codePointAt(0) as number
		let secondPoint = second[index].codePointAt(0) as number

		if (firstPoint < secondPoint) {
			return less
		} else if (firstPoint > secondPoint) {
			return greater
		}
	}

	if (first.length < second.length) {
		return less
	} else if (first.length > second.length) {
		return greater
	} else {
		return equal
	}
}
