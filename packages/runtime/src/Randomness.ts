import type { BooleanType } from "./Boolean"
import { createBoolean } from "./Boolean"
import type { IntegerType } from "./Integer"
import { createInteger } from "./Integer"
import type { ListType } from "./List"
import { viewOf } from "./List"
import type { RationalType } from "./Rational"
import { createRational } from "./Rational"
import type { StringType } from "./String"
import { createString } from "./String"
import { type AnyType, typeKeySymbol } from "./type"

// NOTE: A source of random values, and the one Essence value that CHANGES. Every
// other value in this runtime is immutable; a source holds four 32 bit words
// that every answer advances, so two reads of one source answer two different
// values. That is what `Generatable::generate` needs — a body asking for a name
// and then for a score must not be handed the same number twice — and it is why
// `Randomness` is a bare tag rather than a Choice: a Case would carry a payload
// a Program could read, and the state is the runner's business.
//
// NOTE: The mutation is invisible to everything that reasons about Essence
// values. The Optimiser's purity table is an ALLOWLIST keyed by Namespace name
// (`packages/compiler/src/optimiser/purity.ts`), and `Randomness` has no entry,
// so no pass pools, hoists or drops a call on one.
export type RandomnessType = {
	[typeKeySymbol]: "Randomness"
	a: number
	b: number
	c: number
	d: number
}

// NOTE: sfc32 — four words of state, one shift and three adds per answer. It is
// chosen over a 64 bit generator because a bigint per draw costs a heap
// allocation, and a property run draws hundreds of thousands of times. It
// passes PractRand at the sizes a test run reaches, which is the whole of what
// is asked of it: nothing here is a source of secrets, and the Documentation
// says so.
function nextWord(source: RandomnessType): number {
	let t = (source.a + source.b) | 0

	source.a = source.b ^ (source.b >>> 9)
	source.b = (source.c + (source.c << 3)) | 0
	source.c = (source.c << 21) | (source.c >>> 11)
	source.d = (source.d + 1) | 0
	t = (t + source.d) | 0
	source.c = (source.c + t) | 0

	return t >>> 0
}

// NOTE: splitmix32, which is what turns a seed of a few characters into four
// words that are not obviously related. Seeding sfc32 with the same word four
// times over gives a first few thousand draws with visible structure in them;
// this is the standard answer to that, and the twelve discarded draws below are
// the other half of it.
function scramble(state: number): { state: number; word: number } {
	let next = (state + 0x9e3779b9) | 0
	let word = next

	word = Math.imul(word ^ (word >>> 16), 0x21f0aaad)
	word = Math.imul(word ^ (word >>> 15), 0x735a2d97)

	return { state: next, word: (word ^ (word >>> 15)) >>> 0 }
}

// NOTE: A seed is a hexadecimal String — what `essence test` prints on a failure
// and what `--seed` reads back — so the mapping from text to state has to be
// exact and has to accept any text at all, since a reader can type one. Every
// character is folded in, so two seeds that differ anywhere give two different
// sources.
export function seedOf(text: string): number {
	let hash = 0x811c9dc5

	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index)
		hash = Math.imul(hash, 0x01000193)
	}

	return hash >>> 0
}

// NOTE: THE door every source is built through. `createRandomness` is not a
// native — nothing written in Essence builds a source — so this is reached from
// the test runtime alone.
export function createRandomness(seed: number): RandomnessType {
	let state = seed | 0
	let first = scramble(state)
	let second = scramble(first.state)
	let third = scramble(second.state)
	let fourth = scramble(third.state)

	let source: RandomnessType = {
		[typeKeySymbol]: "Randomness",
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

// NOTE: A whole number in `[0, bound)`, taken from the low bits with the
// rejection loop that keeps the answer uniform. `2 ** 32 % bound` is how much of
// the word's range is left over after the last whole multiple of `bound`; a draw
// that lands in it is thrown away rather than folded, which would make the low
// values likelier.
export function below(source: RandomnessType, bound: number): number {
	if (bound <= 1) {
		return 0
	}

	let limit = 4294967296 - (4294967296 % bound)

	while (true) {
		let word = nextWord(source)

		if (word < limit) {
			return word % bound
		}
	}
}

// NOTE: A whole number in `[low, high]`, over bigints so a range wider than a
// word is drawn as exactly as a narrow one. The word loop below builds the
// answer 32 bits at a time and rejects a draw past the span, which is the same
// rule `below` follows one word at a time.
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

// NOTE: A fraction in `[0, 1)` with 32 bits of resolution, for the weighted
// choices the generator makes about shapes rather than about values.
export function fraction(source: RandomnessType): number {
	return nextWord(source) / 4294967296
}

// #region Natives

// NOTE: `true` or `false`, each half the time. It reads the top bit rather than
// the bottom one, which is the better bit of an sfc32 word.
export function boolean(source: RandomnessType): BooleanType {
	return createBoolean(nextWord(source) >= 2147483648)
}

// NOTE: Both bounds included, and bounds in the wrong order answer the lower
// one — the same reading `Orderable::clamp` gives a pair that encloses nothing.
export function integer(
	source: RandomnessType,
	low: IntegerType,
	high: IntegerType,
): IntegerType {
	let lowest = BigInt(low.value)
	let highest = BigInt(high.value)

	if (highest <= lowest) {
		return createInteger(lowest)
	}

	return createInteger(bigBetween(source, lowest, highest))
}

// NOTE: A Rational is drawn as a denominator and then a numerator, rather than
// as a scaled double, so that what comes out is exact and has a denominator a
// reader recognises. The denominators are the small ones a test wants to meet —
// halves, thirds, and the powers of ten a decimal is written with.
const DENOMINATORS = [1n, 2n, 3n, 4n, 5n, 6n, 8n, 10n, 12n, 16n, 100n, 1000n]

export function rational(
	source: RandomnessType,
	low: RationalType,
	high: RationalType,
): RationalType {
	let denominator = DENOMINATORS[below(source, DENOMINATORS.length)] ?? 1n
	// NOTE: The bounds scaled to that denominator, rounded INWARDS on both
	// sides, so every answer is inside the range the caller wrote. A range too
	// narrow to hold one multiple of the denominator answers the lower bound,
	// which is inside it.
	let lowest = ceilingOf(low.numerator * denominator, low.denominator)
	let highest = floorOf(high.numerator * denominator, high.denominator)

	if (highest < lowest) {
		return createRational(low.numerator, low.denominator)
	}

	return createRational(bigBetween(source, lowest, highest), denominator)
}

// NOTE: The alphabet a String is drawn from. It is ASCII plus four characters
// that are not, because the assumptions a String Method breaks are about
// combining marks, surrogate pairs and case folding rather than about letters.
const CHARACTERS = [
	..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ",
	"é",
	"ß",
	"👋",
	"🇩🇪",
]

// NOTE: A String of at most `upTo` characters, and possibly of none. A negative
// bound answers the empty String, which is the only String shorter than nothing
// asked for.
export function string(source: RandomnessType, upTo: IntegerType): StringType {
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

// NOTE: One item of the List, each equally likely. The List is a
// `NonEmptyList`, so the refinement is what promises there is one to answer
// with; the fallback below is unreachable and is what TypeScript is told
// instead, since a refinement erases before anything runs.
export function pick<ItemType extends AnyType>(
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
