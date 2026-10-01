import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"

import { fixturePath } from "@essence-lang/fixtures"

import { bundle } from "../bundler/index"
import { enrich } from "../enricher/index"
import { loadModuleGraph } from "../modules/graph"
import { diskModuleHost } from "../modules/host"
import { linkModuleGraph } from "../modules/link"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite, rewriteModules } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// Each Essence Method is its own const, so a native the Program does not use
// stays shakeable. These ceilings hold that for fixtures, for single calls and
// for a bundle of several Modules.
//
// A ceiling sits about a kilobyte above its measurement and follows it both
// ways, so a kilobyte-scale mistake shows. The prelude spec keeps about 500
// bytes, since the duplication it watches for is about a kilobyte.
//
// `bundle` imports esbuild lazily and is slow, so few files are measured.
// `write: false` keeps it off the file system.
async function bundleSizeOf(fixtureName: string): Promise<number> {
	return bundleSizeOfSource(
		readFileSync(fixturePath(fixtureName), { encoding: "utf-8" }),
	)
}

// The same measurement over a Program written here, for a claim about one
// Method next to a Program that does everything but call it.
async function bundleSizeOfSource(source: string): Promise<number> {
	let parsed = parseWithDiagnostics(source)
	let enriched = enrich(parsed.program)

	validate(enriched.program)

	let code = rewrite(optimise(simplify(enriched.program)))

	let result = await bundle(code, {
		sourceFileName: "program.ts",
		outputFileName: "program.js",
	})

	expect(result.outputs).toHaveLength(1)

	return result.outputs[0]!.contents.byteLength
}

describe("Bundle Size", () => {
	// HelloWorld.es names no number, container or constant, so its figure is the
	// floor every Program pays. The ceiling catches a top-level effect no bundler
	// can prove pure.
	it("keeps the floor every Program pays", async () => {
		expect(await bundleSizeOf("HelloWorld.es")).toBeLessThan(6_950)
	})

	// The ceiling catches the numeric tower arriving whole, as a reintroduced
	// `Number` spread would. A Program carries the runtime reach of what it calls.
	// Some Optimiser passes grow this figure on purpose, so read the minified
	// figure before calling a rise a regression.
	it("keeps Everyday.es from dragging in the whole numeric tower", async () => {
		expect(await bundleSizeOf("Everyday.es")).toBeLessThan(88_000)
	})

	// The same claim on a Program that takes square roots. A conformance witness
	// carries its Protocol's provided bodies, so this figure moves on Methods
	// the file never names.
	it("keeps Irrational.es from dragging in the whole numeric tower", async () => {
		expect(await bundleSizeOf("Irrational.es")).toBeLessThan(42_300)
	})

	// What a Program holding a Dictionary carries. The registry being bypassed, or
	// `Dictionary.ts` gaining a top-level side effect, would move the other
	// figures too.
	it("charges a Dictionary Program for the container it uses", async () => {
		expect(await bundleSizeOf("Dictionary.es")).toBeLessThan(63_900)
	})

	// The set-shaped List Methods rest on `keyEncoding.ts` alone, without the
	// Dictionary store. The figure prices that reach.
	it("charges a removeDuplicates Program for the key encoding behind it", async () => {
		expect(
			await bundleSizeOfSource(`implementation {
	constant names = ["ada", "bob", "ada", "cy"]

	Terminal.print(names::removeDuplicates()::join(with ", "))
}`),
		).toBeLessThan(14_700)
	})

	// `mode` counts by the key encoding rather than through a Dictionary, so a
	// numeric aggregate pulls in no container.
	it("charges a mode Program for the count rather than a Dictionary", async () => {
		expect(
			await bundleSizeOfSource(`implementation {
	constant numbers = [3, 1, 1, 3, 2]

	Terminal.print(numbers::mode(defaultingTo 0)::toString())
}`),
		).toBeLessThan(12_450)
	})

	// What one `Http.get` carries, mostly the Dictionary of its headers. A
	// top-level side effect added to `Http.ts` would show here and in the floor.
	it("charges a Program that sends one request for the request", async () => {
		expect(
			await bundleSizeOfSource(`implementation {
	constant answered = complete Http.get("https://example.test/")

	Terminal.print(answered::hasValue())
}`),
		).toBeLessThan(25_700)
	})

	// A bundle of several Modules carries one copy of each prelude Method. The
	// Module fixtures call `round` on a Rational from two files, so a per-Module
	// prelude would show as a second copy. Copies are counted against the prelude
	// Module, since esbuild would rename a second copy rather than repeat its name.
	// The ceiling catches other routes.
	it("carries one copy of the prelude across a bundle of Modules", async () => {
		let linked = linkModuleGraph(
			loadModuleGraph(fixturePath("modules", "Main.es"), diskModuleHost),
		)

		let sources = rewriteModules(
			[...linked.modules.values()].map((module) => ({
				filePath: module.module.filePath,
				program: optimise(simplify(module.program)),
			})),
			linked.entryPath,
		)

		let result = await bundle(sources, {
			sourceFileName: "Main.es",
			outputFileName: "bundle.js",
		})

		expect(result.diagnostics).toEqual([])
		expect(result.outputs).toHaveLength(1)

		let essenceConsts = (text: string) =>
			[
				...text.matchAll(
					/(?:const|let|var|function)\s+(\$es_[A-Za-z0-9_$]+)/g,
				),
			].map((match) => match[1]!)

		let inPrelude = essenceConsts(sources.sources.get("essence:$prelude")!)
		let inBundle = essenceConsts(
			new TextDecoder().decode(result.outputs[0]!.contents),
		)

		expect(inBundle.length).toBeGreaterThan(0)
		expect(inBundle.length).toBeLessThanOrEqual(inPrelude.length)
		// Kept about 500 bytes above the measurement, as the file's own rule asks.
		expect(result.outputs[0]!.contents.byteLength).toBeLessThan(16_800)
	})
})
