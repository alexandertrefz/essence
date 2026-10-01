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
 * Each block is checked as `essence check` checks a file, tests included, and
 * must be byte-identical to what `essence format` makes of it. A line printing
 * with its output in a `§ …` comment is run and compared.
 *
 * Blocks are read through `src/lib/samples.ts`, as the site's Shiki
 * transformer reads them. `§ fragment` is never compiled, and
 * `§ file: Name.es` writes the block under that name for others to import.
 *
 * Compiles run in process through `compileFile` over a `CompileSession`, as
 * the CLI's commands do, since a process per block would take minutes.
 */

// A bundle cache of this run's own, set before the first compile, so samples
// never touch the user's cache.
let bundleCache = mkdtempSync(path.join(tmpdir(), "essence-docs-cache-"))

process.env.ESSENCE_CLI_CACHE = bundleCache

const DOCS_DIRECTORY = path.resolve(import.meta.dirname, "../src/content/docs")

let scratch = mkdtempSync(path.join(tmpdir(), "essence-docs-samples-"))

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true })
	rmSync(bundleCache, { recursive: true, force: true })
})

// The globals `run` hijacks to read what a Program wrote. A test that times out
// mid-import never reaches its `finally`, so `afterEach` restores them too.
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

// Every block of a page is written into one directory before any compiles. So
// an import of `./Money.es` finds that block wherever it stands on the page.
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

// A fresh directory for every bundle, as `stageBundle` gives test bundles, so
// no import of an earlier bundle affects this one.
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

// What a Program writes to standard output, as `essence run` shows it.
// `Terminal.inspect` writes through `console.log`, which under Bun bypasses
// `process.stdout.write`, so both are held. Standard error is silenced.
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

// A `§ "quoted"` comment is the printed text in quotes, which a page
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
		// A guard on the reading: a fence pattern that stopped matching would
		// leave no tests at all.
		expect(pages.length).toBeGreaterThan(30)
		expect(pages.flatMap((page) => page.samples).length).toBeGreaterThan(
			300,
		)
	})

	for (let page of pages) {
		describe(page.id, () => {
			let samples = writeSamples(page.id, page.samples)

			// One Session per page and mode, as one `essence check` over the
			// page's files would use. A check links the tests section and a run
			// does not, and a Session serves only its own mode.
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
