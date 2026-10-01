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

// The `modules` fixtures through the stages the CLI runs after linking, with
// each Module's source text, which a map embeds as `sourcesContent`.
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

// Compiles one source the way `essence dap` compiles a debug session, with
// every pass off. It is a Module of its own, so the `modules` fixtures that
// other specs read stay unchanged.
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

// The same with the Optimiser on, since `loop-self-tail-calls` only rewrites
// an optimised Program. A debug session never sees the loop, but a stack trace
// from a bundle built with `--sourcemap` is read through its map.
function optimisedModule(
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
				program: optimise(simplify(enriched.program, { source })),
				sourceText: source,
			},
		],
		filePath,
		{ sourcemap: true },
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

		// Lines are found in the text rather than hardcoded, so an edited
		// fixture moves the expectation with it.
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

	// Asking for a map adds only the trailing comment. In map mode escodegen
	// renders through `SourceNode`s, which should be equivalent, and this spec
	// pins it.
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

	// A turn of a looped Function maps to the `<- total(…)` that was written.
	// The `continue` and every Statement of the turn stand for that one Return,
	// so all of them carry its position.
	it("maps a looped tail call back onto the call that was written", () => {
		let filePath = join(tmpdir(), "essence-sourcemaps", "Walk.es")
		let source = `implementation {
	function total(_ rest: List<Integer>, _ sum: Integer) -> Integer {
		<- match rest::firstItem() -> Integer {
			case #Empty       { <- sum }
			case #Value(head) { <- total(rest::removeFirst(), sum::add(head)) }
		}
	}

	Terminal.print(total([1, 2, 3], 0))
}
`
		let { text, map } = optimisedModule(filePath, source)
		let lines = text.split("\n")
		let continueLine =
			lines.findIndex((line) => line.includes("continue $tail_0")) + 1
		let writtenLine =
			source.split("\n").findIndex((line) => line.includes("<- total(")) +
			1

		expect(continueLine).toBeGreaterThan(0)
		expect(writtenLine).toBeGreaterThan(0)

		let consumer = new SourceMapConsumer(map)
		let original = consumer.originalPositionFor({
			line: continueLine,
			column: lines[continueLine - 1]!.indexOf("continue"),
		})

		expect(original.source).toBe(filePath)
		expect(original.line).toBe(writtenLine)

		// Every mapping on the turn's lines is read, not one column, since a
		// debugger may query any token boundary. None may name another line.
		let turnLines = new Set(
			lines.flatMap((line, index) =>
				/^\s*(?:const \$tail_\d+_t\d+ = |sum = |rest = )/.test(line)
					? [index + 1]
					: [],
			),
		)

		expect(turnLines.size).toBe(4)

		let named = new Set<number>()

		consumer.eachMapping((mapping) => {
			if (
				turnLines.has(mapping.generatedLine) &&
				mapping.originalLine !== null
			) {
				named.add(mapping.originalLine)
			}
		})

		expect([...named]).toEqual([writtenLine])
	})

	// esbuild ignores an empty map and maps the module onto itself, so the
	// prelude carries none. See "Source maps" in
	// packages/compiler/src/bundler/DEVELOPMENT.md.
	it("gives the prelude no map of its own", () => {
		let { inputs, entryPath } = moduleInputs()
		let { sources } = rewriteModules(inputs, entryPath, { sourcemap: true })

		expect(
			sources.get(PRELUDE_SPECIFIER)!.includes("sourceMappingURL"),
		).toBe(false)
	})

	// A pooled constant stands for every site that writes the value, so it
	// maps to none of them. A debugger stepping the pool would otherwise jump
	// to an unrelated line.
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

	// A `define` is emitted as a chain of conditionals on one line, so each arm
	// maps back through a column. Stepping then lands on the arm, not on the
	// top of the chain.
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

		// escodegen maps every token boundary of a Node, and a debugger may
		// query any of them. So every mapping over an arm's answer must name
		// that arm.
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

		// The lines the arms are written on, found in the source rather
		// than hardcoded, so an edited fixture moves the expectation with it.
		let sourceLines = source.split("\n")
		let lineOf = (answer: string): number =>
			sourceLines.findIndex((line) => line.includes(`as "${answer}"`)) + 1

		expect(answers.map((answer) => [...found.get(answer)!].sort())).toEqual(
			answers.map((answer) => [lineOf(answer)]),
		)
	})

	// An ESM Module may `await` at its top level, so a top-level `complete`
	// needs no Function around it. The `await` maps back to the Keyword, where
	// a debugger stepping onto the wait lands.
	it("maps a top-level wait back onto the Keyword that wrote it", () => {
		let filePath = join(tmpdir(), "essence-sourcemaps", "Waiting.es")
		let source = `implementation {
	function doubled(_ value: Integer) -> Future<Integer> {
		constant held = complete Async.deferred(() { <- value })

		<- held::multiply(with 2)
	}

	constant answered = complete doubled(21)

	Terminal.print(answered)
}
`
		let { text, map } = unoptimisedModule(filePath, source)
		let lines = text.split("\n")
		let waitLine =
			lines.findIndex((line) => line.includes("const answered =")) + 1

		expect(waitLine).toBeGreaterThan(0)
		expect(lines[waitLine - 1]).toContain("await $future.complete(")
		// With no body to take a context from, the top level makes its own.
		expect(lines[waitLine - 1]).toContain("$future.root()")

		let awaitColumn = lines[waitLine - 1]!.indexOf("await ")
		let sourceLines = source.split("\n")
		let sourceLine =
			sourceLines.findIndex((line) =>
				line.includes("constant answered ="),
			) + 1
		let keywordColumn = sourceLines[sourceLine - 1]!.indexOf("complete")
		let consumer = new SourceMapConsumer(map)
		let found: Array<{ line: number; column: number }> = []

		consumer.eachMapping((mapping) => {
			if (
				mapping.generatedLine === waitLine &&
				mapping.generatedColumn === awaitColumn &&
				mapping.originalLine !== null
			) {
				found.push({
					line: mapping.originalLine,
					column: mapping.originalColumn,
				})
			}
		})

		expect(found).toContainEqual({
			line: sourceLine,
			column: keywordColumn,
		})
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

	// esbuild folds each Module's inline map into the bundle's. The final map
	// names the `.es` files on disk, carries their text, and lands a known
	// Function on its declaring line.
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

		// A debugger binds breakpoints against the absolute `.es` paths, so they
		// survive verbatim. They are the only sources, so the prelude and the
		// inlined runtime read as unmapped code to step over.
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

		// The entry calls `describe`, so it survives tree-shaking.
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

		// A Method's body maps into the Module that declared its Namespace. The
		// Method head stays unmapped, so the spec reads the line after it.
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

		// The prelude carries no map, so no `.es` source may claim a `$es_`
		// declaration's line.
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
