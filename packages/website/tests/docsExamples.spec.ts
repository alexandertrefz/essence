import { afterAll, afterEach, describe, expect, it } from "bun:test"
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { compileFile } from "@essence-lang/cli/src/pipeline.ts"
import { createCompileSession } from "@essence-lang/cli/src/session.ts"
import { renderDiagnostics } from "@essence-lang/compiler/diagnostics/render"
import { format } from "@essence-lang/formatter"

import { essenceSamples, type Sample } from "../src/lib/samples.ts"

/*
 * Every Essence sample on the site, held to the toolchain the site documents.
 *
 * A sample that does not compile teaches a reader that the page is wrong, and
 * from then on they trust the compiler over the page — so this is a completion
 * gate in the sense `diagnosticCodes.spec.ts` is one. Each block of every page
 * is checked the way `essence check` checks a file (the tests section
 * included), held byte-identical to what `essence format` makes of it, and,
 * where a line prints with its output written beside it in a `§ …` comment,
 * run and compared line by line with what it printed.
 *
 * The blocks are read through `src/lib/samples.ts`, the module the site's own
 * Shiki transformer reads them through, so a marker the page hides is a marker
 * this honours: `§ fragment` is never compiled, and `§ file: Name.es` writes
 * the block under that name beside the page's other blocks, so a module the
 * next block imports is there to be imported.
 *
 * NOTE: In process, through the command line's own compile — `compileFile` over
 * a `CompileSession` is what `essence check`, `build` and `run` hand a file to,
 * minus the report. Spawning `essence` per block is what the writers' checker
 * did; four hundred processes is minutes, and this has to sit in `bun test`.
 */

// NOTE: A directory of this run's own for the bundle cache, set before the
// first compile, because where the cache lives is read off the environment
// every time it is asked for. A sample compiled here neither answers out of
// the user's cache nor leaves a bundle in it.
let bundleCache = mkdtempSync(path.join(tmpdir(), "essence-docs-cache-"))

process.env.ESSENCE_CLI_CACHE = bundleCache

const DOCS_DIRECTORY = path.resolve(import.meta.dirname, "../src/content/docs")

let scratch = mkdtempSync(path.join(tmpdir(), "essence-docs-samples-"))

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true })
	rmSync(bundleCache, { recursive: true, force: true })
})

// NOTE: The globals `run` below hijacks to read what a Program wrote. A test
// that times out mid-import leaves its `finally` unrun, and every later sample
// would then print into a buffer nothing reads — so they are put back after
// every test as well.
const originalLog = console.log
const originalStandardOut = process.stdout.write
const originalStandardError = process.stderr.write

afterEach(() => {
	console.log = originalLog
	process.stdout.write = originalStandardOut
	process.stderr.write = originalStandardError
})

function pagesUnder(directory: string): Array<string> {
	return readdirSync(directory, { withFileTypes: true })
		.flatMap((entry) => {
			let full = path.join(directory, entry.name)

			return entry.isDirectory()
				? pagesUnder(full)
				: entry.name.endsWith(".mdx")
					? [full]
					: []
		})
		.sort()
}

type WrittenSample = Sample & { fileName: string }

// NOTE: Every block of a page is written before any of them is compiled, into
// one directory per page — a block that imports `./Money.es` finds the block
// that is `Money.es` whichever of the two comes first on the page.
function writeSamples(
	pageId: string,
	samples: Array<Sample>,
): Array<WrittenSample> {
	let directory = path.join(scratch, pageId)

	mkdirSync(directory, { recursive: true })

	return samples.map((sample, index) => {
		let fileName = path.join(
			directory,
			sample.file ?? `block-${index + 1}.es`,
		)

		writeFileSync(fileName, sample.code)

		return { ...sample, fileName }
	})
}

// NOTE: A directory of its own for every bundle, made just before the bundle is
// written into it. Bun's resolver remembers what a directory held the first
// time it resolved a module out of it, so a second bundle written beside one
// already imported is "not found" for the rest of the process — every run
// after a page's first would fail on a file that is plainly there.
function bundlePathFor(sample: WrittenSample): string {
	let directory = mkdtempSync(path.join(scratch, "bundle-"))

	return path.join(directory, path.basename(sample.fileName, ".es") + ".mjs")
}

function report(outcome: Awaited<ReturnType<typeof compileFile>>): string {
	return outcome.modules
		.filter((module) => module.diagnostics.length > 0)
		.map((module) =>
			renderDiagnostics(
				module.diagnostics,
				module.sourceText,
				module.fileName,
				{
					color: false,
				},
			),
		)
		.join("\n")
}

// NOTE: What a Program writes to standard output, the way `essence run` shows
// it: `Terminal.print` and `Terminal.write` reach the stream, and
// `Terminal.inspect` ends its line through `console.log`, which under Bun goes
// to the file descriptor without passing `process.stdout.write`. Both are held.
// Standard error is held too, and kept apart — the writers' checker read only
// what came out between the run's banners, which is standard output alone.
async function run(bundle: string): Promise<Array<string>> {
	let written = ""

	console.log = (...values: Array<unknown>) => {
		written += `${values.map((value) => String(value)).join(" ")}\n`
	}

	process.stdout.write = ((chunk: unknown) => {
		written += String(chunk)

		return true
	}) as typeof process.stdout.write

	process.stderr.write = (() => true) as typeof process.stderr.write

	try {
		await import(bundle)
	} finally {
		console.log = originalLog
		process.stdout.write = originalStandardOut
		process.stderr.write = originalStandardError
	}

	let lines = written.split("\n").map((line) => line.trim())

	while (lines.length > 0 && lines.at(-1) === "") {
		lines.pop()
	}

	return lines
}

// NOTE: A `§ "quoted"` comment is the printed text in quotes, which a page
// writes where the text has a meaningful space at either end. Either spelling
// matches.
function printedAsExpected(printed: string | undefined, expected: string) {
	return (
		printed === expected || printed === expected.replace(/^"(.*)"$/, "$1")
	)
}

let pages = pagesUnder(DOCS_DIRECTORY)
	.map((file) => ({
		id: path.relative(DOCS_DIRECTORY, file).replace(/\.mdx$/, ""),
		samples: essenceSamples(readFileSync(file, "utf8")),
	}))
	.filter((page) => page.samples.length > 0)

describe("the samples on the site", () => {
	it("finds the site's samples", () => {
		// NOTE: A guard on the reading — a fence pattern that silently stopped
		// matching would turn every test below into no test at all.
		expect(pages.length).toBeGreaterThan(30)
		expect(pages.flatMap((page) => page.samples).length).toBeGreaterThan(
			300,
		)
	})

	for (let page of pages) {
		describe(page.id, () => {
			let samples = writeSamples(page.id, page.samples)

			// NOTE: One Session per page and per mode, which is how one
			// `essence check` over a page's files would compile them: a module
			// two blocks import is read and enriched once. A check links the
			// tests section and a run does not, and a Session opened in one mode
			// may not answer for the other.
			let checking = createCompileSession(
				samples.map((sample) => sample.fileName),
				{ tests: true },
			)
			let building = createCompileSession(
				samples.map((sample) => sample.fileName),
			)

			for (let sample of samples) {
				if (sample.fragment) {
					continue
				}

				let name = `${path.basename(sample.fileName)} (line ${sample.line})`

				it(`${name} compiles, is formatted and prints what it says`, async () => {
					let checked = await compileFile(
						{
							inputFileName: sample.fileName,
							outputFileName: null,
							minify: false,
							sourcemap: false,
							tests: true,
						},
						undefined,
						checking,
					)

					if (!checked.ok) {
						throw new Error(
							`${name} does not compile:\n${report(checked)}`,
						)
					}

					let formatted = format(sample.code, {
						documentPath: sample.fileName,
					})

					if (formatted.refusal !== null) {
						throw new Error(
							`${name} is refused by the formatter: ${formatted.refusal.message}`,
						)
					}

					if (formatted.text !== sample.code) {
						throw new Error(
							`${name} is not what \`essence format\` makes of it:\n${formatted.text}`,
						)
					}

					if (sample.expected.length === 0) {
						return
					}

					let built = await compileFile(
						{
							inputFileName: sample.fileName,
							outputFileName: bundlePathFor(sample),
							minify: false,
							sourcemap: false,
						},
						undefined,
						building,
					)

					if (!built.ok || built.outputFileName === null) {
						throw new Error(
							`${name} does not build:\n${report(built)}`,
						)
					}

					let printed = await run(built.outputFileName)
					let mismatched = sample.expected.filter(
						(line, index) =>
							!printedAsExpected(printed[index], line),
					)

					if (mismatched.length > 0) {
						expect({ printed }).toEqual({
							printed: sample.expected,
						})
					}
				})
			}
		})
	}
})
