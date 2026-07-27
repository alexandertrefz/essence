import { describe, expect, it } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { fixturePath } from "@essence/fixtures"
import { type RawSourceMap, SourceMapConsumer } from "source-map"

import { bundle, moduleSpecifier, PRELUDE_SPECIFIER } from "../bundler/index"
import { containsErrors } from "../diagnostics/index"
import { loadModuleGraph } from "../modules/graph"
import { diskModuleHost } from "../modules/host"
import { linkModuleGraph } from "../modules/link"
import { optimise } from "../optimiser/index"
import { type ModuleInput, rewriteModules } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: The Module fixtures, through the stages the CLI runs after linking —
// the same graph `modules.spec.ts` pins as Diagnostic-clean — with each
// Module's source text riding along, which is what a map embeds as
// `sourcesContent`.
function moduleInputs(): {
	inputs: Array<ModuleInput>
	entryPath: string
	texts: Map<string, string>
} {
	let linked = linkModuleGraph(
		loadModuleGraph(fixturePath("modules", "Main.es"), diskModuleHost),
	)
	let texts = new Map<string, string>()

	let inputs = [...linked.modules.values()].map((module) => {
		let diagnostics = [...module.diagnostics]

		if (!containsErrors(diagnostics)) {
			diagnostics.push(...validate(module.program))
		}

		expect(containsErrors(diagnostics)).toBe(false)
		texts.set(module.module.filePath, module.module.sourceText)

		return {
			filePath: module.module.filePath,
			program: optimise(simplify(module.program)),
			sourceText: module.module.sourceText,
		}
	})

	return { inputs, entryPath: linked.entryPath, texts }
}

const inlineMapPrefix = "//# sourceMappingURL=data:application/json;base64,"

function decodeInlineMap(moduleText: string): RawSourceMap {
	let lastLine = moduleText.slice(moduleText.lastIndexOf("\n") + 1)

	expect(lastLine.startsWith(inlineMapPrefix)).toBe(true)

	return JSON.parse(
		Buffer.from(lastLine.slice(inlineMapPrefix.length), "base64").toString(
			"utf-8",
		),
	) as RawSourceMap
}

describe("Source Maps", () => {
	it("maps a Module's statements back onto its own source", () => {
		let { inputs, entryPath, texts } = moduleInputs()
		let { sources } = rewriteModules(inputs, entryPath, { sourcemap: true })

		let geometryPath = fixturePath("modules", "Geometry.es")
		let geometryText = texts.get(geometryPath)!
		let moduleText = sources.get(moduleSpecifier("./Geometry.es"))!
		let map = decodeInlineMap(moduleText)

		expect(map.sources).toEqual([geometryPath])
		expect(map.sourcesContent).toEqual([geometryText])

		// NOTE: The round trip, pinned on a Function the fixture declares: the
		// emitted `function centimetres` maps back to the line the source
		// declares it on — found in the text rather than hardcoded, so an
		// edited fixture moves the expectation along with itself.
		let generatedLines = moduleText.split("\n")
		let generatedLine =
			generatedLines.findIndex((line) =>
				line.includes("function centimetres"),
			) + 1
		let sourceLine =
			geometryText
				.split("\n")
				.findIndex((line) => line.includes("function centimetres")) + 1

		expect(generatedLine).toBeGreaterThan(0)
		expect(sourceLine).toBeGreaterThan(0)

		let consumer = new SourceMapConsumer(map)
		let original = consumer.originalPositionFor({
			line: generatedLine,
			column: generatedLines[generatedLine - 1]!.indexOf("function"),
		})

		expect(original.source).toBe(geometryPath)
		expect(original.line).toBe(sourceLine)
	})

	// NOTE: The gate the whole feature stands behind — asked for no map, the
	// emitted JavaScript is byte for byte what it was before source maps
	// existed, and asked for one, only the trailing comment is new. escodegen
	// renders through `SourceNode`s in map mode, which is equivalent but not
	// provably identical, so it is pinned here rather than assumed.
	it("changes nothing about the emitted JavaScript itself", () => {
		let { inputs, entryPath } = moduleInputs()
		let plain = rewriteModules(inputs, entryPath)
		let mapped = rewriteModules(inputs, entryPath, { sourcemap: true })

		expect([...mapped.sources.keys()].sort()).toEqual(
			[...plain.sources.keys()].sort(),
		)

		for (let [specifier, plainText] of plain.sources) {
			let mappedText = mapped.sources.get(specifier)!
			let commentStart = mappedText.lastIndexOf(`\n${inlineMapPrefix}`)
			let withoutComment =
				commentStart === -1
					? mappedText
					: mappedText.slice(0, commentStart)

			expect([specifier, withoutComment]).toEqual([specifier, plainText])
		}
	})

	// NOTE: An empty map would not help — esbuild ignores one and self-maps the
	// module anyway — so the prelude simply carries none, and the Bundler's
	// final pass is what strips its lines from the bundle's map.
	it("gives the prelude no map of its own", () => {
		let { inputs, entryPath } = moduleInputs()
		let { sources } = rewriteModules(inputs, entryPath, { sourcemap: true })

		expect(
			sources.get(PRELUDE_SPECIFIER)!.includes("sourceMappingURL"),
		).toBe(false)
	})

	it("emits no comment at all when no map was asked for", () => {
		let { inputs, entryPath } = moduleInputs()
		let { sources } = rewriteModules(inputs, entryPath)

		for (let [specifier, text] of sources) {
			expect([specifier, text.includes("sourceMappingURL")]).toEqual([
				specifier,
				false,
			])
		}
	})

	// NOTE: The composition seam, pinned end to end: esbuild reads each
	// Module's inline map off the plugin-served contents and folds it into the
	// bundle's own, so the FINAL map — the one a debugger loads — names the
	// on-disk `.es` files, carries their text, and lands a known Function on
	// its declaring line. Nothing touches disk; `write: false` keeps the
	// outputs in memory.
	it("composes through esbuild into the bundle's final map", async () => {
		let { inputs, entryPath, texts } = moduleInputs()
		let generated = rewriteModules(inputs, entryPath, { sourcemap: true })

		let result = await bundle(generated, {
			sourceFileName: entryPath,
			outputFileName: join(tmpdir(), "essence-sourcemaps", "Main.js"),
			sourcemap: true,
		})

		expect(result.diagnostics).toEqual([])

		let mapOutput = result.outputs.find((output) =>
			output.path.endsWith(".map"),
		)
		let bundleOutput = result.outputs.find(
			(output) => !output.path.endsWith(".map"),
		)

		expect(mapOutput).toBeDefined()
		expect(bundleOutput).toBeDefined()

		let map = JSON.parse(
			new TextDecoder().decode(mapOutput!.contents),
		) as RawSourceMap
		let mainPath = fixturePath("modules", "Main.es")
		let geometryPath = fixturePath("modules", "Geometry.es")

		// NOTE: The absolute `.es` paths must survive esbuild verbatim — they
		// are what a debugger binds breakpoints against, wherever the bundle
		// itself ended up. And they must be ALONE in there: the prelude's and
		// the inlined runtime's pseudo-sources are stripped by the Bundler, so
		// everything that is not Essence reads as unmapped code to step over.
		expect(map.sources).toContain(mainPath)
		expect(map.sources).toContain(geometryPath)
		expect(
			map.sources.filter((source) => !source.endsWith(".es")),
		).toEqual([])
		expect(map.sourcesContent?.[map.sources.indexOf(geometryPath)]).toBe(
			texts.get(geometryPath)!,
		)

		let bundleText = new TextDecoder().decode(bundleOutput!.contents)
		let bundleLines = bundleText.split("\n")
		let consumer = new SourceMapConsumer(map)

		// NOTE: A top-level Function of the entry — `describe` survives
		// tree-shaking because the entry calls it — lands on its declaring
		// line, found in the text rather than hardcoded, so an edited fixture
		// moves the expectation along with itself.
		let describeLine =
			bundleLines.findIndex((line) =>
				line.includes("function describe("),
			) + 1
		let describeSourceLine =
			texts
				.get(mainPath)!
				.split("\n")
				.findIndex((line) => line.includes("function describe")) + 1

		expect(describeLine).toBeGreaterThan(0)

		let describeOriginal = consumer.originalPositionFor({
			line: describeLine,
			column: bundleLines[describeLine - 1]!.indexOf("function"),
		})

		expect(describeOriginal.source).toBe(mainPath)
		expect(describeOriginal.line).toBe(describeSourceLine)

		// NOTE: A Method's body reaches back into the Module that declared the
		// Namespace — the first statement inside `area` is Geometry's, not the
		// entry's. The Method HEAD stays unmapped (nothing rewrites it as an
		// Expression), so the assertion reads the line after it.
		let areaBodyLine =
			bundleLines.findIndex((line) => line.includes("static area(")) + 2
		let areaSourceLine =
			texts
				.get(geometryPath)!
				.split("\n")
				.findIndex((line) => line.includes("@.width::multiply")) + 1

		expect(areaBodyLine).toBeGreaterThan(1)

		let areaOriginal = consumer.originalPositionFor({
			line: areaBodyLine,
			column: Math.max(
				bundleLines[areaBodyLine - 1]!.search(/\S/),
				0,
			),
		})

		expect(areaOriginal.source).toBe(geometryPath)
		expect(areaOriginal.line).toBe(areaSourceLine)

		// NOTE: The prelude's consts must stay unmapped — that is what its
		// empty map is FOR — so no `.es` source may claim a `$es_` const's
		// declaring line.
		let preludeLine =
			bundleLines.findIndex((line) => line.includes("var $es_")) + 1

		if (preludeLine > 0) {
			let preludeOriginal = consumer.originalPositionFor({
				line: preludeLine,
				column: 0,
			})

			expect(preludeOriginal.source).toBeNull()
		}
	})
})
