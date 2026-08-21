import { createBoolean } from "./Boolean"
import { createInteger } from "./Integer"
import { createList, viewOf } from "./List"
import { type RandomnessType, below, bigBetween, character } from "./Randomness"
import { createRational } from "./Rational"
import { createRecord } from "./Record"
import { createString } from "./String"
import { type AnyType, createCase, typeKeySymbol } from "./type"

// NOTE: THE generator interpreter a property test runs on. What the Compiler
// emits is a DESCRIPTION of a Type — this file is the one place that turns such
// a description into values, and the one place that makes a failing value
// smaller. Both halves live together on purpose: a generator that knew how to
// build a value but not how to shrink one would leave a reader with whatever
// the source happened to draw first, which is usually a wall of digits.
//
// NOTE: Nothing here reaches a Program. Every value it builds is built through
// the same constructors emitted code builds values with, so a generated value
// is indistinguishable from a written one — including its hidden Type key,
// which is what lets `is`, `toString` and a Match read it.

// #region The description

export type Narrowing = {
	// NOTE: Integer bounds, in digits — an Integer is a bigint at run time and
	// no JSON number spells every one of them.
	atLeast?: string
	atMost?: string
	notEqualTo?: Array<string>
	// NOTE: Lists and Strings, counted in items and in characters.
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
	| {
			kind: "generated"
			name: string
			generate: (source: RandomnessType) => AnyType
	  }

// NOTE: What a refinement whose predicate nothing could satisfy answers with.
// It is a failure of the RUN rather than of the property: the test asserted
// nothing, and a report that said "passed" would be claiming otherwise.
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

// NOTE: How hard a generator tries before it gives up on a refinement. It is
// generous because a filter is drawn from a distribution that knows nothing
// about the predicate, and cheap because every attempt is one draw.
const REFINEMENT_ATTEMPTS = 500

// NOTE: The most items a List and the most characters a String is drawn with,
// whatever the case number grew the size to. A property that needs a bigger one
// says so by building it.
const MAXIMUM_LENGTH = 64

// #endregion

// #region Building a value

// NOTE: `size` grows with the case number: the first cases are small, so a
// failure found early is already close to minimal, and the last ones are big
// enough to meet the assumptions a small value never breaks.
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

			// NOTE: A narrowing that contradicts itself — `@::isGreaterThan(10)
			// ::and(@::isLessThan(5))` — describes no value at all. Drawing
			// against it would answer a bound rather than nothing, which is a
			// value the Type says is impossible; the run says so instead.
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

// NOTE: `CaseInstanceType` is deliberately not part of `AnyType` — its
// `[typeKeySymbol]: string` would defeat the tag-based narrowing every runtime
// helper relies on — so a Case value is cast where it is built, exactly as
// emitted code does. It is a Case at run time either way.
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

// NOTE: An Integer inside whatever bounds a refinement narrowed it to, and
// inside a window that grows with the size otherwise. One draw in eight is
// taken from a much wider window, because the assumptions an Integer breaks are
// usually about a value no small window holds.
function drawWhole(
	source: RandomnessType,
	size: number,
	narrowing: Narrowing,
): bigint {
	let span = BigInt(size) * 4n + 8n
	let wide = below(source, 8) === 0
	let reach = wide ? span * 100_000_000n : span
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

	// NOTE: Every draw landed on an excluded value, which means the range holds
	// almost nothing else. Walking it is what answers rather than drawing again
	// for ever; a range holding nothing at all answers its own bound, and the
	// refinement's own checks refuse it.
	for (let candidate = lowest; candidate <= highest; candidate += 1n) {
		if (!excluded.includes(candidate)) {
			return candidate
		}
	}

	return lowest
}

// NOTE: A Rational as a numerator over one of the small denominators a reader
// recognises, so a counterexample reads as `3/4` rather than as a ratio of two
// forty-digit numbers.
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

function drawLength(
	source: RandomnessType,
	size: number,
	narrowing: Narrowing,
): number {
	let lowest = Math.max(0, narrowing.minimumLength ?? 0)
	let highest = Math.min(
		MAXIMUM_LENGTH,
		narrowing.maximumLength ?? lowest + size,
	)

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

// NOTE: Whether the bounds a narrowing states enclose nothing.
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

// NOTE: Whether a candidate has EARNED the refinement — every check answered
// `true`, and the value is inside whatever the narrowing states.
//
// The narrowing is asked about the value rather than trusted to have shaped it,
// because a narrowing that holds the whole predicate leaves no check to run:
// where a draw or a shrink answers a bound it could not honour — an excluded
// value in a range holding nothing else, a step past one — nothing else would
// notice.
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

// NOTE: What a narrowing says about a value that is already built. A value of a
// kind the narrowing says nothing about is inside it by definition.
function inside(narrowing: Narrowing, value: AnyType): boolean {
	let key = (value as unknown as Record<symbol, string>)[typeKeySymbol]

	if (key === "Integer") {
		return admitsWhole(
			BigInt((value as unknown as { value: number | bigint }).value),
			narrowing,
		)
	}

	let length =
		key === "String"
			? [...(value as unknown as { value: string }).value].length
			: key === "List"
				? viewOf(value as Parameters<typeof viewOf>[0]).total
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

// #region Making a failing value smaller

// NOTE: The candidates worth trying instead of a value that failed, smallest
// first. Every one of them is a value of the same Type — a shrink that left the
// Type behind would report a counterexample the property was never asked about.
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
		// NOTE: A Namespace's own generator says how to BUILD a value and
		// nothing about what a smaller one is, so a counterexample it drew is
		// reported as it was drawn. Declaring a conformance is declaring that
		// the structure is nobody else's business.
		case "generated":
			return []
	}
}

// NOTE: The smallest value a generator can build, where it can build one at
// all. It is what a Union shrinks TOWARDS — a `#Value(…)` reported as `#Empty`
// is the shortest true thing a report can say — and what nothing answers for a
// Namespace's own generator or for a refinement no small value satisfies.
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

	// NOTE: Halving the distance to the target, which finds a boundary in a
	// logarithmic number of steps rather than a linear one, and then the step
	// beside the value itself, which is what pins an off-by-one down.
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

// NOTE: The Integer a shrink walks towards: zero, or the nearest bound the
// narrowing admits where zero is outside it.
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

	// NOTE: A whole number is simpler to read than a fraction, so the
	// denominator is walked down before the numerator is finished with.
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

// NOTE: Halves first, then one character at a time, then the characters
// themselves simplified — which is what turns `"kQ9é x"` into `"aa"` rather
// than into a shorter run of the same noise.
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

	// NOTE: The items themselves, one at a time — a List of the right length
	// holding one huge number shrinks to a List of the right length holding a
	// small one.
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

// NOTE: A Union shrinks in two directions: towards the smallest value one of
// its SIMPLER arms can build — an `#Empty` beside a `#Value(…)` — and within
// the arm the value belongs to.
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

// NOTE: Whether an arm of a Union is the one a value belongs to. A Case says so
// by its tag, and everything else by the hidden Type key every value carries —
// which is the same question `isValueOfType` asks, answered here without a Type
// descriptor because a generator already knows the shape it built.
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
		case "list":
			return key === "List"
		case "record":
			return key === "Record"
		case "case":
			return key === generator.tag
		case "union":
			return generator.members.some((member) => claims(member, value))
		case "refined":
			return claims(generator.base, value)
		case "generated":
			return true
	}
}

// NOTE: How complicated a value of this generator is to read, which is the
// order a Union's arms are shrunk towards. The numbers say nothing on their own
// — only their order matters — and a payload-free Case is deliberately below
// everything, because "it was `#Empty`" is the shortest true thing a report can
// say.
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
