import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: A composite asks its members — checked against a MODEL of that sentence
// rather than against the Compiler's own idea of it. The model below is written
// from the rule and knows nothing about witnesses, slots, brands or pools: two
// Records are equal when their member sets match and every member is equal by
// its own Type's rule, where a Type's rule is the one its Namespace writes and
// the structural one otherwise. Everything the Compiler does to arrive there is
// invisible to it, which is the point — a test written from the implementation
// agrees with the implementation.
//
// NOTE: SEVERAL Record Types per generated Program, which is the property the
// hand-written tests did not have. Every one of them declares a single routed
// Record, so no Program they compile can hold two witnesses that might be
// confused for each other — and that is exactly the shape that found a witness
// pool keyed without the routed member names, where `{ fig: Tag }` and
// `{ zebra: Tag }` collapsed into one constant and the second Record was asked
// about the first one's members. One Program here declares a dozen.
//
// NOTE: Fixed seeds and a generator written out here, so a failure is a file a
// reader can open rather than a run they have to reproduce. The two seeds were
// picked because they generate different shapes, not because they were the ones
// that passed: the reviewer's own harness ran four over 2,400 assertions, and
// these two carry the same shapes in a size the suite can afford.

// NOTE: One Essence Type and the pairs that stand for it — each pair being two
// spellings and what the MODEL says about them. `Tag` is case-insensitive by
// its own `is`, so "News" and "NEWS" are one Tag and two Strings; `Money`
// compares on `cents` and ignores `note`. Both pairs differ structurally, so a
// Record that failed to route would answer the opposite of the model on every
// one of them.
type Kind = {
	spelling: string
	pairs: Array<{ left: string; right: string; equal: boolean }>
}

const universe: Record<string, Kind> = {
	Integer: {
		spelling: "Integer",
		pairs: [
			{ left: "1", right: "1", equal: true },
			{ left: "1", right: "2", equal: false },
		],
	},
	String: {
		spelling: "String",
		pairs: [
			{ left: '"a"', right: '"a"', equal: true },
			{ left: '"a"', right: '"b"', equal: false },
		],
	},
	Door: {
		spelling: "Door",
		pairs: [
			{ left: "Door#Open", right: "Door#Open", equal: true },
			{ left: "Door#Open", right: "Door#Shut", equal: false },
		],
	},
	Tag: {
		spelling: "Tag",
		pairs: [
			{
				left: '{ text = "News" }',
				right: '{ text = "NEWS" }',
				equal: true,
			},
			{
				left: '{ text = "News" }',
				right: '{ text = "Other" }',
				equal: false,
			},
		],
	},
	Money: {
		spelling: "Money",
		pairs: [
			{
				left: '{ cents = 5, note = "x" }',
				right: '{ cents = 5, note = "y" }',
				equal: true,
			},
			{
				left: '{ cents = 5, note = "x" }',
				right: '{ cents = 6, note = "x" }',
				equal: false,
			},
		],
	},
	Tags: {
		spelling: "List<Tag>",
		pairs: [
			{
				left: '[{ text = "News" }]',
				right: '[{ text = "NEWS" }]',
				equal: true,
			},
			{
				left: '[{ text = "News" }]',
				right: '[{ text = "Zed" }]',
				equal: false,
			},
		],
	},
	Maybe: {
		spelling: "Optional<Tag>",
		pairs: [
			{
				left: 'Optional<Tag>#Value({ text = "News" })',
				right: 'Optional<Tag>#Value({ text = "NEWS" })',
				equal: true,
			},
			{
				left: 'Optional<Tag>#Value({ text = "News" })',
				right: "Optional<Tag>#Empty",
				equal: false,
			},
		],
	},
	Inner: {
		spelling: "Inner",
		pairs: [
			{
				left: '{ tag = { text = "News" } }',
				right: '{ tag = { text = "NEWS" } }',
				equal: true,
			},
			{
				left: '{ tag = { text = "News" } }',
				right: '{ tag = { text = "Zed" } }',
				equal: false,
			},
		],
	},
}

// NOTE: Out of alphabetical order on purpose. The witnesses are lined up with
// the routed names BY POSITION, so a Record whose routed members are written
// out of order is the shape that can tell the two lists apart.
const memberNames = ["zebra", "apple", "mango", "kiwi", "pear", "fig"]

const prelude = `type Tag = { text: String }

	namespace Tags for Tag is Equatable {
		is(_ other: Tag) -> Boolean {
			<- @.text::is(other.text, comparing #Insensitive)
		}
	}

	type Money = { cents: Integer, note: String }

	namespace Monies for Money is Equatable {
		is(_ other: Money) -> Boolean {
			<- @.cents::is(other.cents)
		}
	}

	type Inner = { tag: Tag }

	choice Door { Open, Shut }

	function same<infer T is Equatable>(_ x: T, _ y: T) -> Boolean {
		<- x::is(y)
	}`

// NOTE: Written out rather than reached for, so a seed means the same Program
// on every machine and in every version of the runtime. Mulberry32: one
// multiply-xor round over a 32-bit state, which is all that is wanted of it.
function randomFrom(seed: number): () => number {
	let state = seed >>> 0

	return () => {
		state = (state + 0x6d2b79f5) >>> 0

		let value = Math.imul(state ^ (state >>> 15), 1 | state)

		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value

		return ((value ^ (value >>> 14)) >>> 0) / 4294967296
	}
}

// NOTE: The five questions, which are the five rails one answer has to travel:
// the direct call, its complement, a bound solved at the call, a List's item
// witness, and a Dictionary key — which is the one that also has to agree with
// the key encoding. A Program batches all of them per pair, because what costs
// seconds here is compiling and running a Program, not the questions in it.
function programFor(
	seed: number,
	typeCount: number,
): {
	source: string
	expected: Array<string>
} {
	let random = randomFrom(seed)
	let pick = <Item>(items: Array<Item>): Item =>
		items[Math.floor(random() * items.length)]!
	let kinds = Object.keys(universe)
	let lines: Array<string> = []
	let expected: Array<string> = []

	for (let index = 0; index < typeCount; index++) {
		let arity = 1 + Math.floor(random() * 3)
		let members = [...memberNames]
			.sort(() => random() - 0.5)
			.slice(0, arity)
			.map((name) => ({ name, kind: universe[pick(kinds)]! }))
		let name = `T${index}`

		lines.push(
			`\ttype ${name} = { ${members
				.map((member) => `${member.name}: ${member.kind.spelling}`)
				.join(", ")} }`,
		)

		for (let round = 0; round < 2; round++) {
			let chosen = members.map((member) => ({
				name: member.name,
				pair: pick(member.kind.pairs),
			}))
			// NOTE: THE MODEL. Every member decides for itself, by its own
			// Type's rule, and the Record is equal when all of them are.
			let equal = chosen.every((member) => member.pair.equal)
			let value = `${name}r${round}`
			let write = (side: "left" | "right") =>
				chosen
					.map((member) => `${member.name} = ${member.pair[side]}`)
					.join(", ")

			lines.push(
				`\tconstant ${value}a: ${name} = { ${write("left")} }`,
				`\tconstant ${value}b: ${name} = { ${write("right")} }`,
				`\tTerminal.inspect(${value}a::is(${value}b))`,
				`\tTerminal.inspect(${value}a::isNot(${value}b))`,
				`\tTerminal.inspect(same(${value}a, ${value}b))`,
				`\tTerminal.inspect([${value}a]::contains(${value}b))`,
				`\tTerminal.inspect([${value}a = 1]::hasKey(${value}b))`,
			)
			expected.push(
				String(equal),
				String(!equal),
				String(equal),
				String(equal),
				String(equal),
			)
		}
	}

	return {
		source: `implementation {\n\t${prelude}\n\n${lines.join("\n")}\n}`,
		expected,
	}
}

async function answersOf(source: string): Promise<Array<string>> {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	let directory = mkdtempSync(join(tmpdir(), "essence-model-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, rewrite(optimise(simplify(enriched.program))))

	let output: Array<string> = []
	let originalLog = console.log

	console.log = (...args: Array<unknown>) => {
		output.push(args.map((argument) => String(argument)).join(" "))
	}

	try {
		await import(file)
	} finally {
		console.log = originalLog
		rmSync(directory, { recursive: true, force: true })
	}

	return output
}

describe("A generated Program agrees with the rule", () => {
	// NOTE: The two seeds are run as separate tests so a failure names which
	// one, and the Program is regenerated from the seed in the report — the
	// generator is deterministic, so printing the seed is printing the Program.
	for (let seed of [7, 23]) {
		it(`answers every question the model's way (seed ${seed})`, async () => {
			let { source, expected } = programFor(seed, 12)

			expect(await answersOf(source)).toEqual(expected)
		})
	}

	// NOTE: The generator itself, because a generator that quietly stopped
	// generating would make every test above pass. Twelve Types, two pairs each,
	// five questions per pair.
	it("generates the Program it says it does", () => {
		let { source, expected } = programFor(7, 12)

		expect(expected.length).toBe(12 * 2 * 5)
		expect(source.match(/^\ttype T\d+ = /gm)?.length).toBe(12)
		expect(programFor(7, 12).source).toBe(source)
		expect(programFor(23, 12).source).not.toBe(source)
	})
})
