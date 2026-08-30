import { describe, expect, it } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { fixturePath } from "@essence-lang/fixtures"
import { type RawSourceMap, SourceMapConsumer } from "source-map"

import { bundle, moduleSpecifier, PRELUDE_SPECIFIER } from "../bundler/index"
import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { loadModuleGraph } from "../modules/graph"
import { diskModuleHost } from "../modules/host"
import { linkModuleGraph } from "../modules/link"
import { optimise, unoptimisedOptions } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
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

// NOTE: One source, compiled the way `essence dap` compiles a debug session —
// every pass off, so what is stepped through is the Program as it was written.
// A Module of its own rather than a line added to the `modules` fixtures, whose
// text every expectation above is read out of.
function unoptimisedModule(
	filePath: string,
	source: string,
): { text: string; map: RawSourceMap } {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program, { modulePath: filePath })

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	let generated = rewriteModules(
		[
			{
				filePath,
				program: optimise(
					simplify(enriched.program, { source }),
					unoptimisedOptions,
				),
				sourceText: source,
			},
		],
		filePath,
		{ sourcemap: true, optimiser: unoptimisedOptions },
	)
	let text = generated.sources.get(generated.entry)!

	return { text, map: decodeInlineMap(text) }
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

	// NOTE: The band of pooled constants is emitted by the Compiler's own
	// reckoning — the same `1` written on four lines is one const there — so the
	// value in it belongs to no one site and maps to none. Without this it
	// carried the Position of whichever site was rewritten first, and stepping
	// the band in a debugger jumped into a line that merely happened to write
	// that constant.
	it("gives the pooled constants no mapping", () => {
		let { inputs, entryPath } = moduleInputs()
		let { sources } = rewriteModules(inputs, entryPath, { sourcemap: true })
		let moduleText = sources.get(moduleSpecifier("./Main.es"))!
		let lines = moduleText.split("\n")
		let bandLines = new Set(
			lines.flatMap((line, index) =>
				line.startsWith("const $pool_") ? [index + 1] : [],
			),
		)

		expect(bandLines.size).toBeGreaterThan(0)

		let consumer = new SourceMapConsumer(decodeInlineMap(moduleText))
		let mappedBandLines: Array<string> = []

		consumer.eachMapping((mapping) => {
			if (
				mapping.source !== null &&
				bandLines.has(mapping.generatedLine)
			) {
				mappedBandLines.push(lines[mapping.generatedLine - 1]!)
			}
		})

		expect(mappedBandLines).toEqual([])
	})

	// NOTE: A `define` is emitted as a chain of JavaScript conditionals on ONE
	// line, so every arm of it maps back through a COLUMN rather than through a
	// line of its own — which is the whole of what makes stepping through one in
	// a debugger land where the arm was written rather than at the top of the
	// ladder. Read with every pass off, because that is what `essence dap`
	// compiles a session with.
	it("maps each arm of a define back to the arm it was written as", () => {
		let filePath = join(tmpdir(), "essence-sourcemaps", "Grade.es")
		let source = `implementation {
	function grade(_ score: Integer) -> String {
		<- define {
			as "A" if score::isGreaterThanOrEqualTo(90)
			as "B" if score::isGreaterThanOrEqualTo(80)
			as "F" otherwise
		}
	}

	Terminal.print(grade(95))
}
`
		let { text, map } = unoptimisedModule(filePath, source)
		let lines = text.split("\n")
		let chainLine = lines.findIndex((line) => line.includes('"A"')) + 1

		expect(chainLine).toBeGreaterThan(0)

		// NOTE: Where each arm's ANSWER stands in the emitted chain, read as a
		// span rather than as one column: escodegen writes a mapping at the
		// token boundaries of the Node it was given, and which of them a
		// debugger's own query lands on is its business. What has to hold is
		// that every mapping over an arm's answer names THAT arm and no other.
		let answers = ["A", "B", "F"]
		let spans = new Map(
			answers.map((answer) => {
				let emitted = `String.createString("${answer}")`
				let start = lines[chainLine - 1]!.indexOf(emitted)

				expect(start).toBeGreaterThan(-1)

				return [answer, { start, end: start + emitted.length }]
			}),
		)
		let found = new Map(
			answers.map((answer) => [answer, new Set<number>()]),
		)
		let consumer = new SourceMapConsumer(map)

		consumer.eachMapping((mapping) => {
			if (
				mapping.generatedLine !== chainLine ||
				mapping.originalLine === null
			) {
				return
			}

			for (let [answer, span] of spans) {
				if (
					mapping.generatedColumn >= span.start &&
					mapping.generatedColumn < span.end
				) {
					found.get(answer)!.add(mapping.originalLine)
				}
			}
		})

		// NOTE: The lines the arms are written on, found in the source rather
		// than hardcoded, so an edited fixture moves the expectation with it.
		let sourceLines = source.split("\n")
		let lineOf = (answer: string): number =>
			sourceLines.findIndex((line) => line.includes(`as "${answer}"`)) + 1

		expect(answers.map((answer) => [...found.get(answer)!].sort())).toEqual(
			answers.map((answer) => [lineOf(answer)]),
		)
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
		expect(map.sources.filter((source) => !source.endsWith(".es"))).toEqual(
			[],
		)
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
			column: Math.max(bundleLines[areaBodyLine - 1]!.search(/\S/), 0),
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
