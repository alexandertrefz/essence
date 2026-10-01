import { createBoolean } from "./Boolean"
import { createDictionary, set as setAt } from "./Dictionary"
import { createInteger } from "./Integer"
import { anyIs } from "./internalHelpers"
import type { EquatableWitness } from "./keyEncoding"
import { createList, runsOf, viewOf } from "./List"
import {
	type RandomnessType,
	below,
	bigBetween,
	character,
	createRandomness,
} from "./Randomness"
import { createRational } from "./Rational"
import { createRecord } from "./Record"
import { createString } from "./String"
import {
	type AnyDictionary,
	type AnyType,
	createCase,
	liveEntriesOf,
	typeKeySymbol,
} from "./type"

// The interpreter of the generator descriptions a property test runs on. See
// "Property-test generators" in DEVELOPMENT.md.

// #region The description

export type Narrowing = {
	// Integer bounds as digits, since a bigint has no JSON number.
	atLeast?: string
	atMost?: string
	notEqualTo?: Array<string>
	// Lengths, in items, characters or entries.
	minimumLength?: number
	maximumLength?: number
}

export type GeneratorMember = { name: string; generator: Generator }

export type Generator =
	| { kind: "boolean" }
	| { kind: "integer" }
	| { kind: "rational" }
	| { kind: "string" }
	| { kind: "list"; item: Generator }
	// `keyConformance` is the key Type's own Equatable witness, which decides
	// which drawn keys are one key.
	| {
			kind: "dictionary"
			key: Generator
			value: Generator
			keyConformance?: EquatableWitness<AnyType>
	  }
	| { kind: "record"; members: Array<GeneratorMember> }
	| { kind: "case"; tag: string; members: Array<GeneratorMember> }
	| { kind: "union"; members: Array<Generator> }
	| {
			kind: "refined"
			name: string
			base: Generator
			checks: Array<(value: AnyType) => { value: boolean }>
			narrowing: Narrowing
	  }
	// A Namespace's own `Generatable` conformance. `shrink` is the Protocol's
	// provided Method where the Namespace writes none, and answers an empty List.
	| {
			kind: "generated"
			name: string
			generate: (source: RandomnessType) => AnyType
			shrink: (value: AnyType) => AnyType
	  }

// The witness a Dictionary is built with where the plan carries none: the
// universal comparison. It can not stand in for a written `is`.
const drawnKeyEquatable: EquatableWitness<AnyType> = {
	is: (a: AnyType, b: AnyType) => createBoolean(anyIs(a, b)),
	isNot: (a: AnyType, b: AnyType) => createBoolean(!anyIs(a, b)),
	structural: true,
}

// The entries of a Dictionary, in insertion order.
function entriesOf(value: AnyType): Array<[AnyType, AnyType]> {
	return liveEntriesOf(value as AnyDictionary)
}

function witnessOf(generator: {
	keyConformance?: EquatableWitness<AnyType>
}): EquatableWitness<AnyType> {
	return generator.keyConformance ?? drawnKeyEquatable
}

function dictionaryOf(
	entries: Array<[AnyType, AnyType]>,
	conformance: EquatableWitness<AnyType>,
): AnyType {
	return createDictionary(entries, conformance) as AnyType
}

// A refinement no draw could satisfy. It fails the run rather than the
// property, since the test asserted nothing.
export class GenerationFailure extends Error {
	constructor(name: string, attempts: number) {
		super(
			attempts === 0
				? `Could not generate a value of '${name}'. Its predicate describes no value at all.`
				: `Could not generate a value of '${name}' in ${attempts} attempts. Its predicate holds for too few values to draw one; declare a 'Generatable' conformance for it.`,
		)
		this.name = "GenerationFailure"
	}
}

// Draws a refinement tries before it gives up. Each attempt is one draw.
const REFINEMENT_ATTEMPTS = 500

// The most items or characters a List or String is drawn with.
const MAXIMUM_LENGTH = 64

// How many keys an added entry, or a smallest Dictionary, draws before giving
// up on a new one. Each attempt draws larger than the last.
const ADDITION_ATTEMPTS = 16

// #endregion

// #region Building a value

// `size` grows with the case number. See "Drawing generated values" in
// DEVELOPMENT.md.
export function generate(
	generator: Generator,
	source: RandomnessType,
	size: number,
	narrowing: Narrowing = {},
): AnyType {
	switch (generator.kind) {
		case "boolean":
			return createBoolean(below(source, 2) === 1)
		case "integer":
			return createInteger(drawWhole(source, size, narrowing))
		case "rational":
			return drawRational(source, size)
		case "string":
			return createString(drawCharacters(source, size, narrowing))
		case "list": {
			let length = drawLength(source, size, narrowing)
			let items: Array<AnyType> = []

			for (let index = 0; index < length; index++) {
				items.push(generate(generator.item, source, size))
			}

			return createList(items)
		}
		// A key drawn twice overwrites, so the Dictionary may be shorter than its
		// draw. The admission check holds a minimum length.
		case "dictionary": {
			let length = drawLength(source, size, narrowing)
			let entries: Array<[AnyType, AnyType]> = []

			for (let index = 0; index < length; index++) {
				entries.push([
					generate(generator.key, source, size),
					generate(generator.value, source, size),
				])
			}

			return dictionaryOf(entries, witnessOf(generator))
		}
		case "record":
			return createRecord(drawMembers(generator.members, source, size))
		case "case":
			return caseValue(
				generator.tag,
				generator.members.length === 0
					? undefined
					: drawMembers(generator.members, source, size),
			)
		case "union":
			return generate(
				generator.members[below(source, generator.members.length)] ??
					generator.members[0]!,
				source,
				size,
				narrowing,
			)
		case "refined": {
			let merged = mergeNarrowing(narrowing, generator.narrowing)

			// A narrowing that contradicts itself describes no value at all.
			if (unsatisfiable(merged)) {
				throw new GenerationFailure(generator.name, 0)
			}

			for (let attempt = 0; attempt < REFINEMENT_ATTEMPTS; attempt++) {
				let candidate = generate(
					generator.base,
					source,
					size + attempt,
					merged,
				)

				if (admitted(generator, merged, candidate)) {
					return candidate
				}
			}

			throw new GenerationFailure(generator.name, REFINEMENT_ATTEMPTS)
		}
		case "generated":
			return generator.generate(source)
	}
}

// Cast, since `CaseInstanceType` stays out of `AnyType`.
function caseValue(tag: string, members?: Record<string, AnyType>): AnyType {
	return (members === undefined
		? createCase(tag)
		: createCase(tag, members)) as unknown as AnyType
}

function drawMembers(
	members: Array<GeneratorMember>,
	source: RandomnessType,
	size: number,
): Record<string, AnyType> {
	let drawn: Record<string, AnyType> = {}

	for (let member of members) {
		drawn[member.name] = generate(member.generator, source, size)
	}

	return drawn
}

// An Integer inside the narrowing's bounds and a window that grows with the
// size. One draw in eight takes a window a hundred times wider, which stays
// bounded because powers and ranges grow with the Integer they are fed.
function drawWhole(
	source: RandomnessType,
	size: number,
	narrowing: Narrowing,
): bigint {
	let span = BigInt(size) * 4n + 8n
	let wide = below(source, 8) === 0
	let reach = wide ? span * 100n : span
	let low = narrowing.atLeast === undefined ? null : BigInt(narrowing.atLeast)
	let high = narrowing.atMost === undefined ? null : BigInt(narrowing.atMost)
	let lowest = low ?? (high === null ? -reach : high - reach)
	let highest = high ?? (low === null ? reach : low + reach)

	if (highest < lowest) {
		highest = lowest
	}

	let excluded = (narrowing.notEqualTo ?? []).map((entry) => BigInt(entry))

	for (let attempt = 0; attempt < 16; attempt++) {
		let drawn = bigBetween(source, lowest, highest)

		if (!excluded.includes(drawn)) {
			return drawn
		}
	}

	// Every draw was excluded, so the range holds little else: walk it. An empty
	// range answers its bound, which the refinement's checks then refuse.
	for (let candidate = lowest; candidate <= highest; candidate += 1n) {
		if (!excluded.includes(candidate)) {
			return candidate
		}
	}

	return lowest
}

// Small denominators, so a counterexample reads as `3/4`.
const DENOMINATORS = [1n, 2n, 3n, 4n, 5n, 8n, 10n, 100n]

function drawRational(source: RandomnessType, size: number): AnyType {
	let denominator = DENOMINATORS[below(source, DENOMINATORS.length)] ?? 1n
	let span = BigInt(size) * 4n + 8n

	return createRational(bigBetween(source, -span, span), denominator)
}

function drawCharacters(
	source: RandomnessType,
	size: number,
	narrowing: Narrowing,
): string {
	let length = drawLength(source, size, narrowing)
	let characters: Array<string> = []

	for (let index = 0; index < length; index++) {
		characters.push(character(source))
	}

	return characters.join("")
}

// The length window draws and neighbours both obey.
function lengthBounds(
	narrowing: Narrowing,
	size: number,
): { lowest: number; highest: number } {
	let lowest = Math.max(0, narrowing.minimumLength ?? 0)
	let highest = Math.min(
		MAXIMUM_LENGTH,
		narrowing.maximumLength ?? lowest + size,
	)

	return { lowest, highest }
}

function drawLength(
	source: RandomnessType,
	size: number,
	narrowing: Narrowing,
): number {
	let { lowest, highest } = lengthBounds(narrowing, size)

	return highest <= lowest
		? lowest
		: lowest + below(source, highest - lowest + 1)
}

function mergeNarrowing(outer: Narrowing, inner: Narrowing): Narrowing {
	let merged: Narrowing = { ...outer }

	if (inner.atLeast !== undefined) {
		merged.atLeast =
			merged.atLeast === undefined ||
			BigInt(merged.atLeast) < BigInt(inner.atLeast)
				? inner.atLeast
				: merged.atLeast
	}

	if (inner.atMost !== undefined) {
		merged.atMost =
			merged.atMost === undefined ||
			BigInt(merged.atMost) > BigInt(inner.atMost)
				? inner.atMost
				: merged.atMost
	}

	if (inner.notEqualTo !== undefined) {
		merged.notEqualTo = [...(merged.notEqualTo ?? []), ...inner.notEqualTo]
	}

	if (inner.minimumLength !== undefined) {
		merged.minimumLength = Math.max(
			merged.minimumLength ?? 0,
			inner.minimumLength,
		)
	}

	if (inner.maximumLength !== undefined) {
		merged.maximumLength = Math.min(
			merged.maximumLength ?? inner.maximumLength,
			inner.maximumLength,
		)
	}

	return merged
}

// Whether the bounds a narrowing states enclose nothing.
function unsatisfiable(narrowing: Narrowing): boolean {
	if (
		narrowing.atLeast !== undefined &&
		narrowing.atMost !== undefined &&
		BigInt(narrowing.atLeast) > BigInt(narrowing.atMost)
	) {
		return true
	}

	return (
		narrowing.minimumLength !== undefined &&
		narrowing.maximumLength !== undefined &&
		narrowing.minimumLength > narrowing.maximumLength
	)
}

// Whether every check holds and the value is inside the narrowing. The
// narrowing is checked rather than trusted to have shaped the value.
function admitted(
	generator: Extract<Generator, { kind: "refined" }>,
	narrowing: Narrowing,
	value: AnyType,
): boolean {
	for (let check of generator.checks) {
		if (!check(value).value) {
			return false
		}
	}

	return inside(narrowing, value)
}

// Whether a built value is inside a narrowing. A kind the narrowing says
// nothing about is inside it.
function inside(narrowing: Narrowing, value: AnyType): boolean {
	let key = (value as unknown as Record<symbol, string>)[typeKeySymbol]

	if (key === "Integer") {
		return admitsWhole(
			BigInt((value as unknown as { value: number | bigint }).value),
			narrowing,
		)
	}

	// A Dictionary counts entries, which its box holds. A List counts through
	// `runsOf`, since counting reads no item.
	let length =
		key === "String"
			? [...(value as unknown as { value: string }).value].length
			: key === "List"
				? runsOf(value as Parameters<typeof runsOf>[0]).total
				: key === "Dictionary"
					? (value as AnyDictionary).length
					: null

	if (length === null) {
		return true
	}

	return (
		length >= (narrowing.minimumLength ?? 0) &&
		length <= (narrowing.maximumLength ?? length)
	)
}

// #endregion

// #region Moving one step from a value

// Neighbours a refinement tries before it draws a fresh value instead.
const MUTATION_ATTEMPTS = 8

// One Union neighbour in this many comes from another arm.
const CROSS_ARM = 4

// One neighbour of a value: the same value with one part moved. See
// "Neighbouring generated values" in DEVELOPMENT.md.
export function mutate(
	generator: Generator,
	value: AnyType,
	source: RandomnessType,
	size: number,
	narrowing: Narrowing = {},
): AnyType {
	switch (generator.kind) {
		case "boolean":
			return createBoolean(!(value as { value: boolean }).value)
		// Leaves are redrawn rather than nudged.
		case "integer":
			return createInteger(drawWhole(source, size, narrowing))
		case "rational":
			return drawRational(source, size)
		case "string":
			return createString(drawCharacters(source, size, narrowing))
		case "list":
			return mutateList(generator.item, value, source, size, narrowing)
		case "dictionary":
			return mutateDictionary(generator, value, source, size, narrowing)
		case "record":
			return mutateMembers(
				generator.members,
				value,
				source,
				size,
				(members) => createRecord(members),
			)
		// A payload-free Case is its own whole neighbourhood.
		case "case":
			return generator.members.length === 0
				? value
				: mutateMembers(
						generator.members,
						value,
						source,
						size,
						(members) => caseValue(generator.tag, members),
					)
		case "union":
			return mutateUnion(
				generator.members,
				value,
				source,
				size,
				narrowing,
			)
		case "refined": {
			let merged = mergeNarrowing(narrowing, generator.narrowing)

			for (let attempt = 0; attempt < MUTATION_ATTEMPTS; attempt++) {
				let candidate = mutate(
					generator.base,
					value,
					source,
					size,
					merged,
				)

				if (admitted(generator, merged, candidate)) {
					return candidate
				}
			}

			// A fresh draw answers an admitted value, or throws `GenerationFailure` as
			// `generate` does.
			return generate(generator, source, size, narrowing)
		}
		// A Namespace's own generator does not say what a value is made of.
		case "generated":
			return generator.generate(source)
	}
}

// One item redrawn, dropped or inserted, among the moves the length allows.
function mutateList(
	item: Generator,
	value: AnyType,
	source: RandomnessType,
	size: number,
	narrowing: Narrowing,
): AnyType {
	let items = itemsOf(value)
	let { lowest, highest } = lengthBounds(narrowing, size)
	let moves: Array<"redraw" | "drop" | "insert"> = []

	if (items.length > 0) {
		moves.push("redraw")
	}

	if (items.length > lowest) {
		moves.push("drop")
	}

	if (items.length < highest) {
		moves.push("insert")
	}

	let move = moves[below(source, moves.length)]

	// No move is left only for a List pinned empty.
	if (move === undefined) {
		return createList(items)
	}

	if (move === "redraw") {
		let index = below(source, items.length)
		let moved = [...items]

		moved[index] = generate(item, source, size)

		return createList(moved)
	}

	if (move === "drop") {
		let index = below(source, items.length)

		return createList([...items.slice(0, index), ...items.slice(index + 1)])
	}

	let index = below(source, items.length + 1)

	return createList([
		...items.slice(0, index),
		generate(item, source, size),
		...items.slice(index),
	])
}

// One value redrawn, one entry dropped or one added. A key is never moved,
// since a Dictionary is read by its keys.
function mutateDictionary(
	generator: {
		key: Generator
		value: Generator
		keyConformance?: EquatableWitness<AnyType>
	},
	value: AnyType,
	source: RandomnessType,
	size: number,
	narrowing: Narrowing,
): AnyType {
	let conformance = witnessOf(generator)
	let entries = entriesOf(value)
	let { lowest, highest } = lengthBounds(narrowing, size)
	let moves: Array<"redraw" | "drop" | "add"> = []

	if (entries.length > 0) {
		moves.push("redraw")
	}

	if (entries.length > lowest) {
		moves.push("drop")
	}

	if (entries.length < highest) {
		moves.push("add")
	}

	let move: "redraw" | "drop" | "add" | undefined =
		moves[below(source, moves.length)]

	// An added key must be new, which the Dictionary itself decides by its own
	// equality. Draws grow with each attempt, then another move is taken.
	if (move === "add") {
		for (let attempt = 0; attempt < ADDITION_ATTEMPTS; attempt++) {
			let grown = dictionaryOf(
				[
					...entries,
					[
						generate(generator.key, source, size + attempt),
						generate(generator.value, source, size),
					],
				],
				conformance,
			)

			if ((grown as AnyDictionary).length > entries.length) {
				return grown
			}
		}

		move = moves.includes("redraw")
			? "redraw"
			: moves.includes("drop")
				? "drop"
				: undefined
	}

	// No move is left only for a Dictionary pinned empty.
	if (move === undefined) {
		return dictionaryOf(entries, conformance)
	}

	if (move === "redraw") {
		let index = below(source, entries.length)
		let moved: Array<[AnyType, AnyType]> = [...entries]

		moved[index] = [
			entries[index]![0],
			generate(generator.value, source, size),
		]

		return dictionaryOf(moved, conformance)
	}

	let index = below(source, entries.length)

	return dictionaryOf(
		[...entries.slice(0, index), ...entries.slice(index + 1)],
		conformance,
	)
}

// One member moved and the rest shared, which is safe since values are
// immutable.
function mutateMembers(
	members: Array<GeneratorMember>,
	value: AnyType,
	source: RandomnessType,
	size: number,
	build: (members: Record<string, AnyType>) => AnyType,
): AnyType {
	let holder = value as unknown as Record<string, AnyType>
	let moved: Record<string, AnyType> = {}

	for (let entry of members) {
		let held = holder[entry.name]

		if (held !== undefined) {
			moved[entry.name] = held
		}
	}

	let member = members[below(source, members.length)]

	if (member !== undefined) {
		let held = holder[member.name]

		moved[member.name] =
			held === undefined
				? generate(member.generator, source, size)
				: mutate(member.generator, held, source, size)
	}

	return build(moved)
}

// Usually a neighbour inside the value's own arm, and one time in `CROSS_ARM`
// a draw from another arm.
function mutateUnion(
	members: Array<Generator>,
	value: AnyType,
	source: RandomnessType,
	size: number,
	narrowing: Narrowing,
): AnyType {
	let own = members.findIndex((member) => claims(member, value))

	// A value no arm claims has no neighbourhood, so a draw answers.
	if (own === -1) {
		return generate({ kind: "union", members }, source, size, narrowing)
	}

	if (members.length > 1 && below(source, CROSS_ARM) === 0) {
		// One draw over the other arms, stepping over the value's own index.
		let pick = below(source, members.length - 1)

		if (pick >= own) {
			pick += 1
		}

		return generate(members[pick]!, source, size, narrowing)
	}

	return mutate(members[own]!, value, source, size, narrowing)
}

// #endregion

// #region Making a failing value smaller

// Smaller values of the same Type to try in place of a failing one, smallest
// first. See "Shrinking a failing value" in DEVELOPMENT.md.
export function shrink(
	generator: Generator,
	value: AnyType,
	narrowing: Narrowing = {},
): Array<AnyType> {
	switch (generator.kind) {
		case "boolean":
			return (value as { value: boolean }).value
				? [createBoolean(false)]
				: []
		case "integer":
			return shrinkWhole(
				(value as { value: number | bigint }).value,
				narrowing,
			)
		case "rational":
			return shrinkRational(
				value as { numerator: bigint; denominator: bigint },
			)
		case "string":
			return shrinkString(
				(value as { value: string }).value,
				narrowing,
			).map((text) => createString(text))
		case "list":
			return shrinkList(generator.item, value, narrowing)
		case "dictionary":
			return shrinkDictionary(generator, value, narrowing)
		case "record":
			return shrinkMembers(generator.members, value, (members) =>
				createRecord(members),
			)
		case "case":
			return shrinkMembers(generator.members, value, (members) =>
				caseValue(
					generator.tag,
					generator.members.length === 0 ? undefined : members,
				),
			)
		case "union":
			return shrinkUnion(generator.members, value)
		case "refined": {
			let merged = mergeNarrowing(narrowing, generator.narrowing)

			return shrink(generator.base, value, merged).filter((candidate) =>
				admitted(generator, merged, candidate),
			)
		}
		// Asks the conformance's own `shrink`, dropping a candidate equal to the
		// failing value so it can not spend the shrink budget on itself.
		case "generated":
			return itemsOf(generator.shrink(value)).filter(
				(candidate) => !anyIs(candidate, value),
			)
	}
}

// The smallest value a generator can build, or `null`, which is what a Union
// shrinks towards. A Namespace's own generator answers `null`, since it can
// only draw.
export function minimal(
	generator: Generator,
	narrowing: Narrowing = {},
): AnyType | null {
	switch (generator.kind) {
		case "boolean":
			return createBoolean(false)
		case "integer":
			return createInteger(smallestWhole(narrowing))
		case "rational":
			return createRational(0n, 1n)
		case "string":
			return createString(
				"a".repeat(Math.max(0, narrowing.minimumLength ?? 0)),
			)
		case "list": {
			let length = Math.max(0, narrowing.minimumLength ?? 0)
			let items: Array<AnyType> = []

			for (let index = 0; index < length; index++) {
				let item = minimal(generator.item)

				if (item === null) {
					return null
				}

				items.push(item)
			}

			return createList(items)
		}
		// As many entries as the narrowing demands, under distinct keys. `null`
		// where the key Type has too few values.
		case "dictionary": {
			let length = Math.max(0, narrowing.minimumLength ?? 0)
			let conformance = witnessOf(generator)

			if (length === 0) {
				return dictionaryOf([], conformance)
			}

			let keys = smallestKeys(generator, length, conformance)
			let held = minimal(generator.value)

			return keys === null || held === null
				? null
				: dictionaryOf(
						keys.map((key) => [key, held]),
						conformance,
					)
		}
		case "record": {
			let members = minimalMembers(generator.members)

			return members === null ? null : createRecord(members)
		}
		case "case": {
			if (generator.members.length === 0) {
				return caseValue(generator.tag)
			}

			let members = minimalMembers(generator.members)

			return members === null ? null : caseValue(generator.tag, members)
		}
		case "union": {
			let ranked = [...generator.members].sort(
				(left, right) => complexity(left) - complexity(right),
			)

			for (let member of ranked) {
				let value = minimal(member, narrowing)

				if (value !== null) {
					return value
				}
			}

			return null
		}
		case "refined": {
			let merged = mergeNarrowing(narrowing, generator.narrowing)
			let value = minimal(generator.base, merged)

			return value !== null && admitted(generator, merged, value)
				? value
				: null
		}
		case "generated":
			return null
	}
}

// `count` distinct keys, the smallest first and the rest drawn from a fixed
// seed. `set` decides distinctness, with the key Type's own equality.
function smallestKeys(
	generator: { key: Generator },
	count: number,
	conformance: EquatableWitness<AnyType>,
): Array<AnyType> | null {
	let first = minimal(generator.key)

	if (first === null) {
		return null
	}

	let keys = [first]

	if (count === 1) {
		return keys
	}

	let source = createRandomness(1)
	let held = createDictionary([[first, first]], conformance)

	for (
		let attempt = 0;
		keys.length < count && attempt < ADDITION_ATTEMPTS * count;
		attempt++
	) {
		let drawn = generate(generator.key, source, attempt)
		let grown = setAt(held, drawn, drawn, conformance)

		if (grown.length > held.length) {
			keys.push(drawn)
			held = grown
		}
	}

	return keys.length === count ? keys : null
}

function minimalMembers(
	members: Array<GeneratorMember>,
): Record<string, AnyType> | null {
	let minimalised: Record<string, AnyType> = {}

	for (let member of members) {
		let value = minimal(member.generator)

		if (value === null) {
			return null
		}

		minimalised[member.name] = value
	}

	return minimalised
}

function shrinkWhole(
	value: number | bigint,
	narrowing: Narrowing,
): Array<AnyType> {
	let current = BigInt(value)
	let target = smallestWhole(narrowing)
	let candidates: Array<bigint> = []

	if (current === target) {
		return []
	}

	candidates.push(target)

	// Halving the distance finds a boundary in logarithmic steps, and the step
	// beside the value pins an off-by-one.
	let distance = current - target

	while (distance !== 0n && distance !== 1n && distance !== -1n) {
		distance = distance / 2n
		candidates.push(current - distance)
	}

	candidates.push(current > target ? current - 1n : current + 1n)

	return candidates
		.filter((candidate) => admitsWhole(candidate, narrowing))
		.filter((candidate) => candidate !== current)
		.map((candidate) => createInteger(candidate))
}

// Zero, or the nearest admitted bound where zero is outside the narrowing.
function smallestWhole(narrowing: Narrowing): bigint {
	let low = narrowing.atLeast === undefined ? null : BigInt(narrowing.atLeast)
	let high = narrowing.atMost === undefined ? null : BigInt(narrowing.atMost)
	let target =
		low !== null && low > 0n ? low : high !== null && high < 0n ? high : 0n

	for (let entry of narrowing.notEqualTo ?? []) {
		if (BigInt(entry) === target) {
			target += 1n
		}
	}

	return target
}

function admitsWhole(candidate: bigint, narrowing: Narrowing): boolean {
	if (
		narrowing.atLeast !== undefined &&
		candidate < BigInt(narrowing.atLeast)
	) {
		return false
	}

	if (
		narrowing.atMost !== undefined &&
		candidate > BigInt(narrowing.atMost)
	) {
		return false
	}

	return !(narrowing.notEqualTo ?? []).some(
		(entry) => BigInt(entry) === candidate,
	)
}

function shrinkRational(value: {
	numerator: bigint
	denominator: bigint
}): Array<AnyType> {
	let candidates: Array<AnyType> = []

	if (value.numerator !== 0n) {
		candidates.push(createRational(0n, 1n))
		candidates.push(createRational(value.numerator / 2n, value.denominator))
	}

	// A whole number reads more simply, so the denominator goes before the
	// numerator is finished.
	if (value.denominator !== 1n) {
		candidates.push(createRational(value.numerator, 1n))
	}

	if (value.numerator > 0n) {
		candidates.push(createRational(value.numerator - 1n, value.denominator))
	}

	if (value.numerator < 0n) {
		candidates.push(createRational(value.numerator + 1n, value.denominator))
	}

	return candidates
}

// Shorter first, then each character simplified to `a`.
function shrinkString(value: string, narrowing: Narrowing): Array<string> {
	let characters = [...value]
	let lowest = Math.max(0, narrowing.minimumLength ?? 0)
	let candidates: Array<string> = []

	if (characters.length > lowest) {
		candidates.push(characters.slice(0, lowest).join(""))

		let half = Math.max(lowest, Math.floor(characters.length / 2))

		candidates.push(characters.slice(0, half).join(""))
		candidates.push(characters.slice(characters.length - half).join(""))

		for (let index = 0; index < characters.length; index++) {
			candidates.push(
				[
					...characters.slice(0, index),
					...characters.slice(index + 1),
				].join(""),
			)
		}
	}

	for (let index = 0; index < characters.length; index++) {
		if (characters[index] !== "a") {
			candidates.push(
				[
					...characters.slice(0, index),
					"a",
					...characters.slice(index + 1),
				].join(""),
			)
		}
	}

	return candidates.filter(
		(candidate) => candidate !== value && [...candidate].length >= lowest,
	)
}

function shrinkList(
	item: Generator,
	value: AnyType,
	narrowing: Narrowing,
): Array<AnyType> {
	let items = itemsOf(value)
	let lowest = Math.max(0, narrowing.minimumLength ?? 0)
	let candidates: Array<Array<AnyType>> = []

	if (items.length > lowest) {
		candidates.push(items.slice(0, lowest))

		let half = Math.max(lowest, Math.floor(items.length / 2))

		candidates.push(items.slice(0, half))
		candidates.push(items.slice(items.length - half))

		for (let index = 0; index < items.length; index++) {
			candidates.push([
				...items.slice(0, index),
				...items.slice(index + 1),
			])
		}
	}

	// Then each item made smaller at the same length.
	for (let index = 0; index < items.length; index++) {
		for (let smaller of shrink(item, items[index]!)) {
			candidates.push([
				...items.slice(0, index),
				smaller,
				...items.slice(index + 1),
			])
		}
	}

	return candidates.map((entries) => createList(entries))
}

// Like a List, but a key never shrinks: two keys shrinking into one would
// change the length.
function shrinkDictionary(
	generator: {
		key: Generator
		value: Generator
		keyConformance?: EquatableWitness<AnyType>
	},
	value: AnyType,
	narrowing: Narrowing,
): Array<AnyType> {
	let entries = entriesOf(value)
	let lowest = Math.max(0, narrowing.minimumLength ?? 0)
	let candidates: Array<Array<[AnyType, AnyType]>> = []

	if (entries.length > lowest) {
		candidates.push(entries.slice(0, lowest))

		let half = Math.max(lowest, Math.floor(entries.length / 2))

		candidates.push(entries.slice(0, half))
		candidates.push(entries.slice(entries.length - half))

		for (let index = 0; index < entries.length; index++) {
			candidates.push([
				...entries.slice(0, index),
				...entries.slice(index + 1),
			])
		}
	}

	for (let index = 0; index < entries.length; index++) {
		for (let smaller of shrink(generator.value, entries[index]![1])) {
			candidates.push([
				...entries.slice(0, index),
				[entries[index]![0], smaller],
				...entries.slice(index + 1),
			])
		}
	}

	return candidates.map((shrunk) =>
		dictionaryOf(shrunk, witnessOf(generator)),
	)
}

function shrinkMembers(
	members: Array<GeneratorMember>,
	value: AnyType,
	build: (members: Record<string, AnyType>) => AnyType,
): Array<AnyType> {
	let candidates: Array<AnyType> = []
	let holder = value as unknown as Record<string, AnyType>

	for (let member of members) {
		let held = holder[member.name]

		if (held === undefined) {
			continue
		}

		for (let smaller of shrink(member.generator, held)) {
			let rebuilt: Record<string, AnyType> = {}

			for (let entry of members) {
				let current = holder[entry.name]

				if (current !== undefined) {
					rebuilt[entry.name] = current
				}
			}

			rebuilt[member.name] = smaller
			candidates.push(build(rebuilt))
		}
	}

	return candidates
}

// Towards the smallest value of a simpler arm, and within the value's own arm.
function shrinkUnion(
	members: Array<Generator>,
	value: AnyType,
): Array<AnyType> {
	let own = members.find((member) => claims(member, value))
	let rank = own === undefined ? Number.MAX_SAFE_INTEGER : complexity(own)
	let candidates: Array<AnyType> = []

	for (let member of members) {
		if (member === own || complexity(member) >= rank) {
			continue
		}

		let value = minimal(member)

		if (value !== null) {
			candidates.push(value)
		}
	}

	return own === undefined
		? candidates
		: [...candidates, ...shrink(own, value)]
}

// Whether a value belongs to this arm. Arms that share a Type key look one
// level down. See "Shrinking a failing value" in DEVELOPMENT.md.
function claims(generator: Generator, value: AnyType): boolean {
	let key = (value as unknown as Record<symbol, string>)[typeKeySymbol]

	switch (generator.kind) {
		case "boolean":
			return key === "Boolean"
		case "integer":
			return key === "Integer"
		case "rational":
			return key === "Rational"
		case "string":
			return key === "String"
		case "list": {
			if (key !== "List") {
				return false
			}

			let items = itemsOf(value)

			return items.length === 0 || claims(generator.item, items[0]!)
		}
		case "dictionary": {
			if (key !== "Dictionary") {
				return false
			}

			// One entry deep. An empty Dictionary is claimed.
			let entries = entriesOf(value)
			let first = entries[0]

			return (
				first === undefined ||
				(claims(generator.key, first[0]) &&
					claims(generator.value, first[1]))
			)
		}
		case "record": {
			if (key !== "Record") {
				return false
			}

			let held = Object.keys(value as unknown as object)
			let names = new Set(generator.members.map((member) => member.name))

			return (
				held.length === names.size &&
				held.every((name) => names.has(name))
			)
		}
		case "case":
			return key === generator.tag
		case "union":
			return generator.members.some((member) => claims(member, value))
		case "refined": {
			if (!claims(generator.base, value)) {
				return false
			}

			// A predicate that throws on the value does not claim it.
			try {
				return admitted(generator, generator.narrowing, value)
			} catch {
				return false
			}
		}
		case "generated":
			return true
	}
}

// How hard a value is to read, which orders a Union's arms for shrinking. Only
// the order matters, and a payload-free Case ranks lowest.
function complexity(generator: Generator): number {
	switch (generator.kind) {
		case "case":
			return generator.members.length === 0
				? 0
				: 6 + membersComplexity(generator.members)
		case "boolean":
			return 1
		case "integer":
			return 2
		case "rational":
			return 3
		case "string":
			return 4
		case "list":
			return 5 + complexity(generator.item)
		case "record":
			return 6 + membersComplexity(generator.members)
		// An entry pairs a key with a value, so a Dictionary starts above a Record.
		case "dictionary":
			return 8 + complexity(generator.key) + complexity(generator.value)
		case "union":
			return generator.members.length === 0
				? 0
				: Math.min(...generator.members.map(complexity))
		case "refined":
			return complexity(generator.base)
		case "generated":
			return 7
	}
}

function membersComplexity(members: Array<GeneratorMember>): number {
	return members.reduce(
		(total, member) => total + complexity(member.generator),
		0,
	)
}

function itemsOf(value: AnyType): Array<AnyType> {
	let view = viewOf(value as Parameters<typeof viewOf>[0])
	let items: Array<AnyType> = []

	for (let index = view.frontCount - 1; index >= 0; index--) {
		items.push(view.front[index]!)
	}

	for (let index = 0; index < view.backCount; index++) {
		items.push(view.back[index]!)
	}

	return items
}

// #endregion

// #region Writing a failing value down

// A counterexample as data, shaped by the generator that reads it back. See
// "Writing a counterexample down" in DEVELOPMENT.md.
export type EncodedValue =
	| { kind: "boolean"; value: boolean }
	// Digits, as in `Narrowing.atLeast`.
	| { kind: "integer"; value: string }
	| { kind: "rational"; numerator: string; denominator: string }
	| { kind: "string"; value: string }
	| { kind: "list"; items: Array<EncodedValue> }
	// Pairs in the Dictionary's order, since a key of any Type may not spell as
	// a JSON member name.
	| {
			kind: "dictionary"
			entries: Array<{ key: EncodedValue; value: EncodedValue }>
	  }
	| { kind: "record"; members: Record<string, EncodedValue> }
	| { kind: "case"; tag: string; members: Record<string, EncodedValue> }
	// The arm's index, so a Union reordered or shortened refuses the value.
	| { kind: "union"; member: number; value: EncodedValue }
	| { kind: "refined"; value: EncodedValue }

// The value written down, or `null` where it can not be. It never throws,
// since a run that found a counterexample still has to report it.
export function encode(
	generator: Generator,
	value: AnyType,
): EncodedValue | null {
	// A value the generator does not claim could only be encoded wrong.
	if (!claims(generator, value)) {
		return null
	}

	switch (generator.kind) {
		case "boolean":
			return {
				kind: "boolean",
				value: (value as { value: boolean }).value,
			}
		case "integer":
			return {
				kind: "integer",
				value: BigInt(
					(value as { value: number | bigint }).value,
				).toString(),
			}
		case "rational": {
			let rational = value as { numerator: bigint; denominator: bigint }

			return {
				kind: "rational",
				numerator: rational.numerator.toString(),
				denominator: rational.denominator.toString(),
			}
		}
		case "string":
			return { kind: "string", value: (value as { value: string }).value }
		case "list": {
			let items: Array<EncodedValue> = []

			for (let item of itemsOf(value)) {
				let encoded = encode(generator.item, item)

				if (encoded === null) {
					return null
				}

				items.push(encoded)
			}

			return { kind: "list", items }
		}
		case "dictionary": {
			let entries: Array<{ key: EncodedValue; value: EncodedValue }> = []

			for (let [key, held] of entriesOf(value)) {
				let encodedKey = encode(generator.key, key)
				let encodedValue = encode(generator.value, held)

				if (encodedKey === null || encodedValue === null) {
					return null
				}

				entries.push({ key: encodedKey, value: encodedValue })
			}

			return { kind: "dictionary", entries }
		}
		case "record": {
			let members = encodeMembers(generator.members, value)

			return members === null ? null : { kind: "record", members }
		}
		case "case": {
			let members = encodeMembers(generator.members, value)

			return members === null
				? null
				: { kind: "case", tag: generator.tag, members }
		}
		case "union": {
			let member = generator.members.findIndex((arm) =>
				claims(arm, value),
			)

			if (member === -1) {
				return null
			}

			let encoded = encode(generator.members[member]!, value)

			return encoded === null
				? null
				: { kind: "union", member, value: encoded }
		}
		case "refined": {
			let encoded = encode(generator.base, value)

			return encoded === null ? null : { kind: "refined", value: encoded }
		}
		// A Namespace's own generator does not say what a value is made of, so a
		// test with such a Parameter keeps no corpus.
		case "generated":
			return null
	}
}

function encodeMembers(
	members: Array<GeneratorMember>,
	value: AnyType,
): Record<string, EncodedValue> | null {
	let holder = value as unknown as Record<string, AnyType>
	let encoded: Record<string, EncodedValue> = {}

	for (let member of members) {
		let held = holder[member.name]

		if (held === undefined) {
			return null
		}

		let entry = encode(member.generator, held)

		if (entry === null) {
			return null
		}

		encoded[member.name] = entry
	}

	return encoded
}

// `generate` without the randomness, through the same constructors. Nothing
// is trusted: any mismatch answers `null`, and the stored entry is dropped.
export function decode(
	generator: Generator,
	data: EncodedValue,
	narrowing: Narrowing = {},
): AnyType | null {
	if (typeof data !== "object" || data === null) {
		return null
	}

	switch (generator.kind) {
		case "boolean":
			return data.kind === "boolean" && typeof data.value === "boolean"
				? createBoolean(data.value)
				: null
		case "integer": {
			if (data.kind !== "integer") {
				return null
			}

			let whole = wholeFrom(data.value)

			return whole === null ? null : createInteger(whole)
		}
		case "rational": {
			if (data.kind !== "rational") {
				return null
			}

			let numerator = wholeFrom(data.numerator)
			let denominator = wholeFrom(data.denominator)

			// A denominator of zero is a Rational nothing ever built.
			return numerator === null ||
				denominator === null ||
				denominator === 0n
				? null
				: createRational(numerator, denominator)
		}
		case "string":
			return data.kind === "string" && typeof data.value === "string"
				? createString(data.value)
				: null
		case "list": {
			if (data.kind !== "list" || !Array.isArray(data.items)) {
				return null
			}

			let items: Array<AnyType> = []

			for (let item of data.items) {
				let decoded = decode(generator.item, item)

				if (decoded === null) {
					return null
				}

				items.push(decoded)
			}

			return createList(items)
		}
		case "dictionary": {
			if (data.kind !== "dictionary" || !Array.isArray(data.entries)) {
				return null
			}

			let entries: Array<[AnyType, AnyType]> = []

			for (let entry of data.entries) {
				// A pair missing either half is a lost entry.
				if (typeof entry !== "object" || entry === null) {
					return null
				}

				let key = decode(generator.key, entry.key)
				let value = decode(generator.value, entry.value)

				if (key === null || value === null) {
					return null
				}

				entries.push([key, value])
			}

			return dictionaryOf(entries, witnessOf(generator))
		}
		case "record": {
			if (data.kind !== "record") {
				return null
			}

			let members = decodeMembers(generator.members, data.members)

			return members === null ? null : createRecord(members)
		}
		case "case": {
			// A renamed Case no longer matches its stored value.
			if (data.kind !== "case" || data.tag !== generator.tag) {
				return null
			}

			let members = decodeMembers(generator.members, data.members)

			return members === null
				? null
				: caseValue(
						generator.tag,
						generator.members.length === 0 ? undefined : members,
					)
		}
		case "union": {
			if (data.kind !== "union") {
				return null
			}

			let member = generator.members[data.member]

			return member === undefined
				? null
				: decode(member, data.value, narrowing)
		}
		case "refined": {
			if (data.kind !== "refined") {
				return null
			}

			let merged = mergeNarrowing(narrowing, generator.narrowing)
			let value = decode(generator.base, data.value, merged)

			// The predicate is asked again, since the refinement may have
			// narrowed since the value was written down.
			return value !== null && admitted(generator, merged, value)
				? value
				: null
		}
		case "generated":
			return null
	}
}

// Exactly the members the generator names. A gained or lost member means the
// Type changed under the stored value.
function decodeMembers(
	members: Array<GeneratorMember>,
	data: Record<string, EncodedValue>,
): Record<string, AnyType> | null {
	if (
		typeof data !== "object" ||
		data === null ||
		Object.keys(data).length !== members.length
	) {
		return null
	}

	let decoded: Record<string, AnyType> = {}

	for (let member of members) {
		let held = data[member.name]

		if (held === undefined) {
			return null
		}

		let value = decode(member.generator, held)

		if (value === null) {
			return null
		}

		decoded[member.name] = value
	}

	return decoded
}

// `BigInt` reads an empty or padded String as a number, so digits are checked
// first.
const DIGITS = /^-?\d+$/

function wholeFrom(text: string): bigint | null {
	return typeof text === "string" && DIGITS.test(text) ? BigInt(text) : null
}

// #endregion
