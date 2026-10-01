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

// A Record asks its members whether they are equal, checked against a model
// written from the rule rather than from the Compiler. Two Records are equal
// when their member sets match and each member is equal by its own Type's rule.
// That is the one its Namespace writes, or the structural one. The model knows
// nothing of witnesses, slots, brands or pools.
//
// Each generated Program declares several Record Types, so two witnesses that
// could be confused for each other share one Program. A witness pool keyed
// without the routed member names would merge `{ fig: Tag }` and `{ zebra: Tag }`.
//
// The seeds are fixed and the generator is written out, so a failing seed
// names a Program a reader can regenerate. The seeds generate different shapes.

// An Essence Type and pairs of its values, each with the model's answer. `Tag`
// compares text without case and `Money` ignores `note`, so their pairs differ
// structurally: a Record that failed to route would contradict the model.
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

// Out of alphabetical order on purpose. The witnesses line up with the routed
// names by position, and only unordered members tell the two lists apart.
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

// Mulberry32, written out so a seed means the same Program on every machine
// and runtime version.
function randomFrom(seed: number): () => number {
	let state = seed >>> 0

	return () => {
		state = (state + 0x6d2b79f5) >>> 0

		let value = Math.imul(state ^ (state >>> 15), 1 | state)

		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value

		return ((value ^ (value >>> 14)) >>> 0) / 4294967296
	}
}

// Each pair is asked through every route an answer travels. The routes are the
// direct call, its complement, a bound solved at the call, a List's item
// witness, and a Dictionary key. The key must also agree with the key encoding.
// One Program asks them all, since compiling and running it is the cost.
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
			// The model: the Record is equal when every member is equal by its
			// own Type's rule.
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
	// One spec per seed, so a failure names the seed, and the deterministic
	// generator rebuilds the Program from it.
	for (let seed of [7, 23]) {
		it(`answers every question the model's way (seed ${seed})`, async () => {
			let { source, expected } = programFor(seed, 12)

			expect(await answersOf(source)).toEqual(expected)
		})
	}

	// A generator that stopped generating would let every seed's spec pass.
	it("generates the Program it says it does", () => {
		let { source, expected } = programFor(7, 12)

		expect(expected.length).toBe(12 * 2 * 5)
		expect(source.match(/^\ttype T\d+ = /gm)?.length).toBe(12)
		expect(programFor(7, 12).source).toBe(source)
		expect(programFor(23, 12).source).not.toBe(source)
	})
})
