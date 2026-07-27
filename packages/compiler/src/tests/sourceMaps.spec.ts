import { describe, expect, it } from "bun:test"

import { fixturePath } from "@essence/fixtures"
import { type RawSourceMap, SourceMapConsumer } from "source-map"

import { moduleSpecifier, PRELUDE_SPECIFIER } from "../bundler/index"
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
			let withoutComment = mappedText.slice(0, mappedText.lastIndexOf("\n"))

			expect([specifier, withoutComment]).toEqual([specifier, plainText])
		}
	})

	it("declares the prelude unmappable rather than unmapped", () => {
		let { inputs, entryPath } = moduleInputs()
		let { sources } = rewriteModules(inputs, entryPath, { sourcemap: true })
		let map = decodeInlineMap(sources.get(PRELUDE_SPECIFIER)!)

		expect(map.sources).toEqual([])
		expect(map.mappings).toBe("")
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
})
