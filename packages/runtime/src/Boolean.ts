import { equal, greater, less, type OrderingType } from "./Ordering"
import { typeKeySymbol } from "./type"

export type BooleanType = { [typeKeySymbol]: "Boolean"; value: boolean }

// NOTE: There are exactly two Boolean values, so there are exactly two Boolean
// objects — built once, at Module load, and handed out ever after. Nothing in
// the language can tell that apart from a fresh one per answer: every runtime
// value is immutable, and Essence has no operator asking whether two values are
// the SAME value, only whether they are EQUAL. What it buys is that every
// comparison, every `and`, every predicate a loop asks stops allocating.
//
// NOTE: Not `Object.freeze`d, for the same reason nothing else in the runtime
// is — immutability here is a convention the whole Module family keeps, and
// freezing would put a check on every read of a value that is read constantly.
export const trueInstance: BooleanType = {
	[typeKeySymbol]: "Boolean",
	value: true,
}

export const falseInstance: BooleanType = {
	[typeKeySymbol]: "Boolean",
	value: false,
}

export function createBoolean(value: boolean): BooleanType {
	return value ? trueInstance : falseInstance
}

export function negate(originalBoolean: BooleanType): BooleanType {
	return createBoolean(!originalBoolean.value)
}

export function is(
	originalBoolean: BooleanType,
	other: BooleanType,
): BooleanType {
	return createBoolean(originalBoolean.value === other.value)
}

// NOTE: `false` before `true` — the order Swift, Rust, Haskell and SQL all sort
// a Boolean key in, and the one `false < true` reads as. The three `Ordering`
// values are shared instances, so this allocates nothing.
export function compare(
	originalBoolean: BooleanType,
	other: BooleanType,
): OrderingType {
	if (originalBoolean.value === other.value) {
		return equal
	}

	return originalBoolean.value ? greater : less
}

export function and(
	originalBoolean: BooleanType,
	other: BooleanType,
): BooleanType {
	return createBoolean(originalBoolean.value && other.value)
}

export function or(
	originalBoolean: BooleanType,
	other: BooleanType,
): BooleanType {
	return createBoolean(originalBoolean.value || other.value)
}

// NOTE: `isNot`, `exclusiveOr` and `toString` are implemented in Essence — see
// `packages/standard-library/sources/Boolean.es`. `negate`, `is`, `and`, `or`
// and `compare` stay native: they are
// the anchors the Essence half is built from, and `or` in particular would cost
// four Method calls through De Morgan where this does one `||`.
