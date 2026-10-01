import { type BigRational, reduced } from "./bigRational"
import type { BooleanType } from "./Boolean"
import { createBoolean } from "./Boolean"
import type { IntegerType } from "./Integer"
import { createInteger } from "./Integer"
import type { ListType } from "./List"
import { createList, ownItemsOf, runsOf, viewOf } from "./List"
import type { RationalType } from "./Rational"
import { createRational } from "./Rational"
import type { StringType } from "./String"
import { createString } from "./String"
import { type AnyType, typeKeySymbol } from "./type"

// A source of random values, the one Essence value that changes. A seeded
// source replays, and an entropy source reads the machine. See "Randomness" in
// DEVELOPMENT.md.
export type RandomnessType = SeededRandomnessType | EntropyRandomnessType

type SeededRandomnessType = {
	[typeKeySymbol]: "Randomness"
	seeded: true
	a: number
	b: number
	c: number
	d: number
}

type EntropyRandomnessType = {
	[typeKeySymbol]: "Randomness"
	seeded: false
}

// sfc32 for a seeded source, the machine's words for an entropy one. See
// "Seeding a source" in DEVELOPMENT.md.
export function nextWord(source: RandomnessType): number {
	if (!source.seeded) {
		return entropyWord()
	}

	let t = (source.a + source.b) | 0

	source.a = source.b ^ (source.b >>> 9)
	source.b = (source.c + (source.c << 3)) | 0
	source.c = (source.c << 21) | (source.c >>> 11)
	source.d = (source.d + 1) | 0
	t = (t + source.d) | 0
	source.c = (source.c + t) | 0

	return t >>> 0
}

// splitmix32, which spreads one seed word into four unrelated ones.
function scramble(state: number): { state: number; word: number } {
	let next = (state + 0x9e3779b9) | 0
	let word = next

	word = Math.imul(word ^ (word >>> 16), 0x21f0aaad)
	word = Math.imul(word ^ (word >>> 15), 0x735a2d97)

	return { state: next, word: (word ^ (word >>> 15)) >>> 0 }
}

// Any seed text as one word, through a 32-bit FNV-1a hash.
export function seedOf(text: string): number {
	let hash = 0x811c9dc5

	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index)
		hash = Math.imul(hash, 0x01000193)
	}

	return hash >>> 0
}

// Every seeded source is built here, by `seeded` and by the test runtime.
export function createRandomness(seed: number): RandomnessType {
	let state = seed | 0
	let first = scramble(state)
	let second = scramble(first.state)
	let third = scramble(second.state)
	let fourth = scramble(third.state)

	let source: RandomnessType = {
		[typeKeySymbol]: "Randomness",
		seeded: true,
		a: first.word,
		b: second.word,
		c: third.word,
		d: fourth.word,
	}

	for (let index = 0; index < 12; index++) {
		nextWord(source)
	}

	return source
}

// The machine's words, read from `globalThis.crypto` a buffer at a time.
const ENTROPY_WORDS = new Uint32Array(256)

let entropyCursor = ENTROPY_WORDS.length

// Whether a draw has read the machine, which a result cache must know.
let entropyDrawn = false

export function hasDrawnEntropy(): boolean {
	return entropyDrawn
}

function entropyWord(): number {
	entropyDrawn = true

	if (entropyCursor >= ENTROPY_WORDS.length) {
		globalThis.crypto.getRandomValues(ENTROPY_WORDS)
		entropyCursor = 0
	}

	let word = ENTROPY_WORDS[entropyCursor] ?? 0

	entropyCursor += 1

	return word
}

// The one entropy source, since two could not be told apart.
const ENTROPY: EntropyRandomnessType = {
	[typeKeySymbol]: "Randomness",
	seeded: false,
}

// A whole number in `[0, bound)`. A word past the last whole multiple of the
// bound is rejected, so the answer stays uniform.
export function below(source: RandomnessType, bound: number): number {
	if (bound <= 1) {
		return 0
	}

	// A bound wider than a word has no whole multiple inside one.
	if (bound > 4294967296) {
		return Number(bigBetween(source, 0n, BigInt(bound) - 1n))
	}

	let limit = 4294967296 - (4294967296 % bound)

	while (true) {
		let word = nextWord(source)

		if (word < limit) {
			return word % bound
		}
	}
}

// A whole number in `[low, high]`, built 32 bits at a time under the rule
// `below` follows.
export function bigBetween(
	source: RandomnessType,
	low: bigint,
	high: bigint,
): bigint {
	if (high <= low) {
		return low
	}

	let span = high - low + 1n

	if (span <= 4294967296n) {
		return low + BigInt(below(source, Number(span)))
	}

	let words = 0
	let ceiling = 1n

	while (ceiling < span) {
		ceiling = ceiling << 32n
		words++
	}

	let limit = ceiling - (ceiling % span)

	while (true) {
		let drawn = 0n

		for (let index = 0; index < words; index++) {
			drawn = (drawn << 32n) | BigInt(nextWord(source))
		}

		if (drawn < limit) {
			return low + (drawn % span)
		}
	}
}

// A fraction in `[0, 1)` with 32 bits of resolution.
export function fraction(source: RandomnessType): number {
	return nextWord(source) / 4294967296
}

// #region Natives

// A Program holding this in a Constant still reads the machine at every draw.
export function entropy(): RandomnessType {
	return ENTROPY
}

export function seeded(seed: StringType): RandomnessType {
	return createRandomness(seedOf(seed.value))
}

// Reads the top bit, the better bit of an sfc32 word.
export function drawBoolean__overload$1(source: RandomnessType): BooleanType {
	return createBoolean(nextWord(source) >= 2147483648)
}

// Drawn over the chance's own denominator, so the chance holds exactly. A
// chance outside `[0, 1]` is clamped. See "Drawing uniformly" in
// DEVELOPMENT.md.
export function drawBoolean__overload$2(
	source: RandomnessType,
	chance: RationalType,
): BooleanType {
	if (chance.numerator <= 0n) {
		return createBoolean(false)
	}

	if (chance.numerator >= chance.denominator) {
		return createBoolean(true)
	}

	return createBoolean(
		bigBetween(source, 0n, chance.denominator - 1n) < chance.numerator,
	)
}

// Both bounds included, naming one range in either order.
export function drawInteger__overload$1(
	source: RandomnessType,
	low: IntegerType,
	high: IntegerType,
): IntegerType {
	let first = BigInt(low.value)
	let second = BigInt(high.value)
	let lowest = first <= second ? first : second
	let highest = first <= second ? second : first

	return createInteger(bigBetween(source, lowest, highest))
}

// Half-open, as an index wants. The bound's proof erases, so a bound of one or
// less answers zero.
export function drawInteger__overload$2(
	source: RandomnessType,
	bound: IntegerType,
): IntegerType {
	let limit = BigInt(bound.value)

	if (limit <= 1n) {
		return createInteger(0n)
	}

	return createInteger(bigBetween(source, 0n, limit - 1n))
}

// The denominators a drawn Rational takes, ones a reader recognises.
const DENOMINATORS = [1n, 2n, 3n, 4n, 5n, 6n, 8n, 10n, 12n, 16n, 100n, 1000n]

// The bounds name one range in either order.
export function drawRational__overload$1(
	source: RandomnessType,
	low: RationalType,
	high: RationalType,
): RationalType {
	return overDenominator(
		source,
		low,
		high,
		DENOMINATORS[below(source, DENOMINATORS.length)] ?? 1n,
	)
}

// The same draw over a named denominator. Its proof erases, so a denominator of
// zero or less counts as one.
export function drawRational__overload$2(
	source: RandomnessType,
	low: RationalType,
	high: RationalType,
	denominator: IntegerType,
): RationalType {
	let scale = BigInt(denominator.value)

	return overDenominator(source, low, high, scale > 0n ? scale : 1n)
}

function overDenominator(
	source: RandomnessType,
	low: RationalType,
	high: RationalType,
	denominator: bigint,
): RationalType {
	let exchanged =
		low.numerator * high.denominator > high.numerator * low.denominator
	let lowerBound = exchanged ? high : low
	let upperBound = exchanged ? low : high
	// Rounded inwards, so every answer lies in the range. A range holding no
	// multiple of the denominator answers its lower bound.
	let lowest = ceilingOf(
		lowerBound.numerator * denominator,
		lowerBound.denominator,
	)
	let highest = floorOf(
		upperBound.numerator * denominator,
		upperBound.denominator,
	)

	if (highest < lowest) {
		return createRational(lowerBound.numerator, lowerBound.denominator)
	}

	return createRational(bigBetween(source, lowest, highest), denominator)
}

// ASCII and four characters that break String assumptions. See "Drawing
// uniformly" in DEVELOPMENT.md.
const CHARACTERS = [
	..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ",
	"é",
	"ß",
	"👋",
	"🇩🇪",
]

// One character, for a generator that builds a String to a minimum length.
export function character(source: RandomnessType): string {
	return CHARACTERS[below(source, CHARACTERS.length)] ?? "a"
}

// At most `upTo` characters. A bound below one, or past what a number holds,
// answers the empty String.
export function drawString(
	source: RandomnessType,
	upTo: IntegerType,
): StringType {
	let bound = Number(upTo.value)

	if (!Number.isFinite(bound) || bound <= 0) {
		return createString("")
	}

	let length = below(source, bound + 1)
	let characters: Array<string> = []

	for (let index = 0; index < length; index++) {
		characters.push(CHARACTERS[below(source, CHARACTERS.length)] ?? "a")
	}

	return createString(characters.join(""))
}

// One item, each equally likely. The List is proven to hold one.
export function pick__overload$1<ItemType extends AnyType>(
	source: RandomnessType,
	items: ListType<ItemType>,
): ItemType {
	let view = viewOf(items)
	let index = below(source, view.total)

	if (index < view.frontCount) {
		return view.front[view.frontCount - 1 - index] as ItemType
	}

	return view.back[index - view.frontCount] as ItemType
}

// Above one in this many items drawn, the partial shuffle copies the List
// rather than mapping displaced positions. See "Picking from a List" in
// DEVELOPMENT.md.
const SPARSE_DRAW_SHARE = 25

export function pick__overload$2<ItemType extends AnyType>(
	source: RandomnessType,
	count: IntegerType,
	items: ListType<ItemType>,
): ListType<ItemType> {
	// `runsOf`, since the receiver is read once and needs no trimming.
	let view = runsOf(items)
	let total = view.total
	let wanted = Number(count.value)
	let taken = wanted < 1 ? 1 : wanted

	if (taken > total) {
		taken = total
	}

	if (taken * SPARSE_DRAW_SHARE > total) {
		let drawn = ownItemsOf(items)

		for (let index = 0; index < taken; index++) {
			let choice = index + below(source, total - index)
			let held = drawn[index] as ItemType

			drawn[index] = drawn[choice] as ItemType
			drawn[choice] = held
		}

		drawn.length = taken

		return createList(drawn)
	}

	// The swaps the copy would make, recorded: a position the Map does not
	// name holds its own item. No position before `index` is read again.
	let displaced = new Map<number, number>()
	let picked: Array<ItemType> = []

	for (let index = 0; index < taken; index++) {
		let choice = index + below(source, total - index)
		let chosen = displaced.get(choice) ?? choice

		displaced.set(choice, displaced.get(index) ?? index)
		picked.push(
			(chosen < view.frontCount
				? view.front[view.frontCount - 1 - chosen]
				: view.back[chosen - view.frontCount]) as ItemType,
		)
	}

	return createList(picked)
}

// The weight of an item weighted zero or less. See "Picking from a List" in
// DEVELOPMENT.md.
const NO_WEIGHT: BigRational = { numerator: 0n, denominator: 1n }

export function pick__overload$3<ItemType extends AnyType>(
	source: RandomnessType,
	items: ListType<ItemType>,
	weight: (item: ItemType) => RationalType,
): ItemType {
	let chosen = ownItemsOf(items)
	let parts: Array<BigRational> = []
	let common = 1n

	for (let item of chosen) {
		let drawn = weight(item)
		let part = reduced(drawn.numerator, drawn.denominator)

		if (part.numerator <= 0n) {
			part = NO_WEIGHT
		}

		parts.push(part)
		common = reduced(common, part.denominator).numerator * part.denominator
	}

	let scaled: Array<bigint> = []
	let total = 0n

	for (let part of parts) {
		let value = part.numerator * (common / part.denominator)

		scaled.push(value)
		total += value
	}

	if (total <= 0n) {
		return chosen[below(source, chosen.length)] as ItemType
	}

	let drawn = bigBetween(source, 0n, total - 1n)
	let running = 0n

	for (let index = 0; index < scaled.length; index++) {
		running += scaled[index] ?? 0n

		if (drawn < running) {
			return chosen[index] as ItemType
		}
	}

	return chosen[chosen.length - 1] as ItemType
}

// Fisher and Yates from the back, so every order is equally likely, over an
// Array of its own.
export function shuffle__overload$1<ItemType extends AnyType>(
	source: RandomnessType,
	items: ListType<ItemType>,
): ListType<ItemType> {
	let drawn = ownItemsOf(items)

	for (let index = drawn.length - 1; index > 0; index--) {
		let choice = below(source, index + 1)
		let held = drawn[index] as ItemType

		drawn[index] = drawn[choice] as ItemType
		drawn[choice] = held
	}

	return createList(drawn)
}

// The same Function under the proof, since a reordering keeps every item.
export const shuffle__overload$2 = shuffle__overload$1

// #endregion

function floorOf(numerator: bigint, denominator: bigint): bigint {
	let quotient = numerator / denominator

	return numerator % denominator !== 0n && numerator < 0n
		? quotient - 1n
		: quotient
}

function ceilingOf(numerator: bigint, denominator: bigint): bigint {
	let quotient = numerator / denominator

	return numerator % denominator !== 0n && numerator > 0n
		? quotient + 1n
		: quotient
}
