import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import * as path from "node:path"

import { linkToMemory } from "@essence-lang/compiler/embed"
import { canonicalPath } from "@essence-lang/compiler/modules"

import {
	describe as describeType,
	describeModule,
	type ModuleDescriptor,
} from "../descriptor"

const FILES = path.join(import.meta.dirname, "files")

// NOTE: Every shape this package has a fixture for — the marshalling table, the
// calls, the declarations, the names JavaScript can not spell and the refusals.
const FIXTURES = [
	"Marshal.es",
	"Calls.es",
	"Declarations.es",
	"Escaped.es",
	"Refused.es",
]

// NOTE: Linked rather than compiled — describing reads an Export Surface, and
// linking is where one comes from. Nothing here needs a bundle, which is the
// point: the whole of what a Descriptor says is decided before a single byte is
// emitted.
function moduleDescriptor(fileName: string): ModuleDescriptor {
	let entry = canonicalPath(path.join(FILES, fileName))

	return describeModule(linkToMemory(entry).surface, entry)
}

// NOTE: The fixtures, described. A snapshot is the right shape for this because
// a Descriptor is what BOTH halves of the boundary agree on — a rule that
// quietly stops baking a Case's tag, stops unwrapping an Alias or starts
// spelling a refusal differently is a change to a contract, and a contract that
// changes without anyone reading the diff is how the two halves come apart.
describe("A Module described", () => {
	for (let fileName of FIXTURES) {
		it(`describes ${fileName}`, () => {
			expect(moduleDescriptor(fileName)).toMatchSnapshot()
		})
	}

	// NOTE: A Case tag is entry-relative, and the Descriptor is where that
	// spelling is decided once — every value the interpreter builds carries what
	// is written here, so this is the one place the rule can be read.
	it("bakes a Case tag as the bundle spells it", () => {
		expect(moduleDescriptor("Marshal.es").exports.circle).toMatchObject({
			kind: "constant",
			of: {
				kind: "union",
				arms: [
					{ tag: "./Marshal.es#Shape#Circle" },
					{ tag: "./Marshal.es#Shape#Rect" },
					{ tag: "./Marshal.es#Shape#Blank" },
				],
			},
		})
	})

	// NOTE: One of `Optional`'s two Cases can reach a Surface WITHOUT the other
	// — `constant thing = #Value(3)` is inferred as the Case alone — so the lone
	// arm keeps a Case of its own, marked as the one Choice that is spelled by
	// absence rather than by a `$case`.
	it("marks one of Optional's own Cases met without the other", () => {
		expect(
			describeType(
				{
					type: "Case",
					choice: "Optional",
					name: "Value",
					members: { item: { type: "Integer" } },
				},
				{ entryPath: "/somewhere/Main.es" },
			),
		).toEqual({
			kind: "case",
			tag: "Optional#Value",
			choice: "Optional",
			name: "Value",
			optional: true,
			payload: { item: { kind: "integer", shown: "Integer" } },
			shown: "Optional#Value",
		})
	})

	// NOTE: And a Module's own `choice Optional` is a Choice like any other. The
	// identity is compared whole rather than by the name it displays under,
	// which is the only thing telling the two apart: both print `Optional`.
	it("leaves a Module's own Choice of that name alone", () => {
		expect(
			describeType(
				{
					type: "Case",
					choice: "/somewhere/Shapes.es#Optional",
					name: "Value",
					members: {},
				},
				{ entryPath: "/somewhere/Main.es" },
			),
		).toEqual({
			kind: "case",
			tag: "./Shapes.es#Optional#Value",
			choice: "Optional",
			name: "Value",
			optional: false,
			payload: {},
			shown: "Optional#Value",
		})
	})

	// NOTE: `Optional<T>` is the one Union with a JavaScript spelling of its
	// own, and the only one that collapses. A Union that merely CONTAINS an
	// Optional still decides arm by arm.
	it("collapses an Optional and leaves every other Union alone", () => {
		let calls = moduleDescriptor("Calls.es")

		// NOTE: `measure(box: Optional<Box>)` and `boxed(box: Box | Integer)` —
		// one Union that IS an Optional and one that is not.
		expect(calls.exports.measure).toMatchObject({
			of: { parameters: [{ of: { kind: "optional" } }] },
		})
		expect(calls.exports.boxed).toMatchObject({
			of: { parameters: [{ of: { kind: "union" } }] },
		})
	})
})

describe("A Descriptor", () => {
	// NOTE: The whole point of the split. A Descriptor is written on one machine
	// and read on another — embedded in a generated Module, written beside a
	// bundle, handed across a wire — so anything that does not survive
	// `JSON.stringify` is not a Descriptor at all. A `Map`, a `Symbol`, a
	// `bigint` or an `undefined` in one of these would pass every other test in
	// this package and fail the day a plugin serves one.
	for (let fileName of FIXTURES) {
		it(`survives a round trip through JSON for ${fileName}`, () => {
			let descriptor = moduleDescriptor(fileName)

			expect(
				JSON.parse(JSON.stringify(descriptor)) as ModuleDescriptor,
			).toEqual(descriptor)
		})
	}
})

// NOTE: The rule the whole split exists for, checked as text because there is no
// other way to check it: a `bun test` run has the Compiler on disk either way,
// so an accidental import would work perfectly here and fail in the browser it
// was split apart for. What is asserted is what a bundler would follow — a value
// import — and every specifier is checked against the three that can not be
// followed anywhere but a machine with a toolchain on it.
describe("The runtime half", () => {
	const RUNTIME_SAFE = ["./errors", "./rational"]
	const SOURCE = readFileSync(
		path.join(import.meta.dirname, "..", "marshal-runtime.ts"),
		"utf8",
	)

	// NOTE: `[^"']*?` spans lines, which is what a formatted import list needs,
	// and can not run past the specifier of the import it is reading.
	let imports = [
		...SOURCE.matchAll(/^import\s+(type\s+)?[^"']*?from\s+"([^"]+)"/gm),
	].map((match) => ({
		specifier: match[2]!,
		typeOnly: match[1] !== undefined,
	}))

	it("reads its own imports", () => {
		expect(imports.length).toBeGreaterThan(0)
	})

	it("imports nothing that needs a Compiler, a file system or a toolchain", () => {
		for (let { specifier } of imports) {
			expect(specifier.startsWith("node:")).toBe(false)
			expect(specifier.startsWith("@essence-lang/compiler")).toBe(false)
			expect(specifier).not.toBe("esbuild")
		}
	})

	// NOTE: A type import is erased before anything runs, so `./descriptor` and
	// `./bridge` may be named — the Descriptor's own shape has to be spelled
	// somewhere, and the file that describes is where it belongs. A VALUE import
	// of either would pull the Compiler in behind it.
	it("imports values from the runtime-safe files alone", () => {
		expect(
			imports
				.filter((entry) => !entry.typeOnly)
				.map((entry) => entry.specifier)
				.sort(),
		).toEqual(RUNTIME_SAFE)
	})

	// NOTE: And nothing reaches around the import list. A dynamic import or a
	// `require` would be invisible to every assertion above.
	it("reaches for nothing at run time either", () => {
		expect(SOURCE).not.toMatch(/\bimport\s*\(/)
		expect(SOURCE).not.toMatch(/\brequire\s*\(/)
	})
})
