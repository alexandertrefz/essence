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

// NOTE: A source of random values, and the one Essence value that CHANGES. Every
// other value in this runtime is immutable; a source answers a different value
// every time it is read. That is what `Generatable::generate` needs — a body
// asking for a name and then for a score must not be handed the same number
// twice — and it is why `Randomness` is a bare tag rather than a Choice: a Case
// would carry a payload a Program could read, and the state is the runner's
// business.
//
// NOTE: One tag, two kinds. A SEEDED source holds four 32 bit words that every
// answer advances, so one seed answers one sequence — what `--seed` replays. An
// ENTROPY source holds nothing and reads the machine instead; what cannot be
// told apart cannot be replayed, so a property run draws from the first kind,
// and the second is for what must NOT repeat, beginning with the run's own
// made-up seed.
//
// NOTE: The mutation is invisible to everything that reasons about Essence
// values. The Optimiser's purity table is an ALLOWLIST keyed by Namespace name
// (`packages/compiler/src/optimiser/purity.ts`), and `Randomness` has no entry,
// so no pass pools, hoists or drops a call on one.
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

// NOTE: sfc32 — four words of state, one shift and three adds per answer. It is
// chosen over a 64 bit generator because a bigint per draw costs a heap
// allocation, and a property run draws hundreds of thousands of times. It
// passes PractRand at the sizes a test run reaches, which is the whole of what
// is asked of it: nothing here is a source of secrets, and the Documentation
// says so. An entropy source has no words of its own and is handed the
// machine's instead, so every draw below serves both kinds unchanged.
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

// NOTE: The door every SEEDED source is built through: `seeded` below, which a
// Program calls, and the test runtime, which builds a property run's source
// from the seed it prints.
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

// NOTE: The machine's words, read through `globalThis.crypto` — the one door
// every host a bundle runs on owns: Bun, Node, Deno and the browsers the client
// package reaches, where importing `node:crypto` would sink the bundle. They
// are read 256 at a time into one buffer, because what a `getRandomValues` call
// costs is the crossing into the host rather than the bytes; the buffer stays
// far under the 65536 byte ceiling the host puts on one call.
const ENTROPY_WORDS = new Uint32Array(256)

let entropyCursor = ENTROPY_WORDS.length

function entropyWord(): number {
	if (entropyCursor >= ENTROPY_WORDS.length) {
		globalThis.crypto.getRandomValues(ENTROPY_WORDS)
		entropyCursor = 0
	}

	let word = ENTROPY_WORDS[entropyCursor] ?? 0

	entropyCursor += 1

	return word
}

// NOTE: The machine's own randomness, as ONE value. Two entropy sources could
// not be told apart — the machine is one, and the words above are drawn from it
// rather than held — so `entropy` below answers this from every call, and only
// the seeded kind is worth building twice.
const ENTROPY: EntropyRandomnessType = {
	[typeKeySymbol]: "Randomness",
	seeded: false,
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

	// NOTE: A bound WIDER than a word has no whole multiple inside one, so the
	// rejection below would reject every draw and loop for ever. `bigBetween`
	// is the same rule over as many words as the span needs, and it is reached
	// from `string(upTo:)`, whose bound is whatever a caller wrote.
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

// NOTE: The two doors a Program builds a source through, and they are the two
// kinds under the one tag. `entropy` hands over the singleton above, so a
// Program that holds the answer in a Constant still reads the machine at every
// draw and nothing it does is replayable. `seeded` folds the text into a word
// and scrambles four out of it, which is the source `--seed` replays.
export function entropy(): RandomnessType {
	return ENTROPY
}

export function seeded(seed: StringType): RandomnessType {
	return createRandomness(seedOf(seed.value))
}

// NOTE: `true` or `false`, each half the time. It reads the top bit rather than
// the bottom one, which is the better bit of an sfc32 word.
export function drawBoolean__overload$1(source: RandomnessType): BooleanType {
	return createBoolean(nextWord(source) >= 2147483648)
}

// NOTE: `true` exactly as often as the chance says, which is why the draw is
// over the chance's OWN denominator rather than over `fraction`: a chance of
// `1/3` is a third of the time and not a third of 2^32 rounded to a word. The
// parts are read unreduced, since `n/d` and `2n/2d` name one point either way.
// A chance outside `[0, 1]` is clamped rather than refused — every entry here
// answers, and there is no Optional in the signature to answer with.
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

// NOTE: Both bounds included, and the two naming the same range in either
// order — the reading `Orderable::clamp` and `Orderable::isBetween` both give a
// pair, so a draw between them reads it the same way. The bounds are exchanged
// rather than the lower one answered, which is what made this the odd one out.
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

// NOTE: The half open form an index draw wants, where the entry above is the
// closed one a range wants. The bound is proven above zero and the answer is
// proven not to be negative, so neither end needs an Optional; the proof erases
// before anything runs, which is why a bound of one or less is guarded here and
// answers zero.
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

// NOTE: A Rational is drawn as a denominator and then a numerator, rather than
// as a scaled double, so that what comes out is exact and has a denominator a
// reader recognises. The denominators are the small ones a test wants to meet —
// halves, thirds, and the powers of ten a decimal is written with.
const DENOMINATORS = [1n, 2n, 3n, 4n, 5n, 6n, 8n, 10n, 12n, 16n, 100n, 1000n]

// NOTE: The two bounds name the same range in either order, exactly as they do
// for the Integer above. A denominator is positive after `createRational`, so
// the cross-multiplication below orders the pair.
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

// NOTE: The same draw with the lattice named rather than drawn. It is the entry
// for everything the twelve denominators above are wrong for: a draw off a
// hundredth is a draw off a hundredth however often it is asked for. The
// denominator is proven above zero, and the proof erases, so a denominator of
// zero or less is guarded into one whole.
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
	// NOTE: The bounds scaled to that denominator, rounded INWARDS on both
	// sides, so every answer is inside the range the caller wrote. A range too
	// narrow to hold one multiple of the denominator answers the lower bound,
	// which is inside it.
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

// NOTE: One character of that alphabet. It is what the structural generator a
// property test derives builds a String out of, character by character, since
// the one below answers a whole String and can not be told a MINIMUM length.
export function character(source: RandomnessType): string {
	return CHARACTERS[below(source, CHARACTERS.length)] ?? "a"
}

// NOTE: A String of at most `upTo` characters, and possibly of none. A negative
// bound answers the empty String, which is the only String shorter than nothing
// asked for.
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

// NOTE: One item of the List, each equally likely. The List is a
// `NonEmptyList`, so the refinement is what promises there is one to answer
// with; the fallback below is unreachable and is what TypeScript is told
// instead, since a refinement erases before anything runs.
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

// NOTE: Without replacement, as a PARTIAL shuffle: `count` swaps put the drawn
// items at the front of the receiver, each drawn from what is left. Drawing
// again whenever the draw meets an item it already has is the other way to
// spell it, and how long that runs is unbounded as `count` approaches the
// length.
//
// NOTE: A count above the length is the whole List reordered, because there is
// no item left to draw a further one from. It is clamped rather than refused
// for the reason the chance above is: the signature has no Optional in it.
//
// NOTE: Two spellings of that one shuffle, told apart by how much of the
// receiver is drawn. Both issue exactly the same `below(source, total - index)`
// draws in the same order, so a seeded source answers the same items either
// way. A FEW items out of many are drawn through a Map of the positions the
// swaps displaced, which costs the count rather than the length: ten out of a
// million measured 4.9 ms as a whole copy against 3.1 µs this way, and ten out
// of a hundred thousand 540 µs against 1.3 µs. MOST of them are drawn through
// the copy, because the Map is the slower Array once the swaps are dense —
// every item of a million measured 8.8 ms copied against 117 ms mapped. The
// crossover is near a twenty-fifth of the length at every size measured, where
// the two are within a fifth of each other, so that is the line.
const SPARSE_DRAW_SHARE = 25

export function pick__overload$2<ItemType extends AnyType>(
	source: RandomnessType,
	count: IntegerType,
	items: ListType<ItemType>,
): ListType<ItemType> {
	// NOTE: Read through `runsOf` rather than `viewOf`, because nothing here
	// walks the whole receiver and `viewOf` writes its trimmed runs back. The
	// front run is stored reversed, which is what the indexing below undoes.
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

	// NOTE: The swap the copy would perform, recorded instead of carried out:
	// a position the Map does not name still holds its own item. Only the
	// position drawn FROM is written back, since `choice` is never below
	// `index` and no position below `index` is read again.
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

// NOTE: The weights are Rationals and the draw is exact, so the arithmetic is
// over one common denominator rather than over a sum of doubles. It is the
// least common multiple of the reduced denominators, built with `reduced` — the
// gcd of the pair is what it divides out — and every weight scaled to it is a
// whole number. So the draw is one Integer in `[0, total)`, and the walk that
// spends it compares whole numbers. Adding the weights up as they come and
// drawing over the sum's own denominator is the cheaper arithmetic and the
// WRONG one: weights of a half, a half and a third answer 1/2, 1/4 and 1/4
// that way rather than 3/8, 3/8 and 1/4. One pick over a thousand items whose
// denominators run to eight measures 0.20 ms, nearly all of it this scaling.
//
// NOTE: A weight of zero or less is drawn as zero: a negative likelihood is not
// a likelihood, and refusing here would need an Optional the signature has no
// room for. Weights that are all zero leave nothing to weigh the items by, so
// the draw falls back to the even one the entry above makes.
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

// NOTE: Fisher and Yates, walked from the back so that each turn draws from the
// items it has not placed yet — which is what makes every one of the `n!`
// orders equally likely. It reorders an Array of its own rather than the
// receiver's, so the List it was handed is left as it was.
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

// NOTE: The same Function under the proof, for the reason `String.split`'s
// second entry is one: a refinement erases before anything runs, and a
// reordering of a List with something in it has something in it.
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
