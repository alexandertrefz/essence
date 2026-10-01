import { describe, expect, it } from "bun:test"
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { FIXTURES_DIRECTORY, fixturePath } from "@essence-lang/fixtures"
import type { common } from "@essence-lang/interfaces"

import { containsErrors } from "../diagnostics/index"
import { renderDiagnostics } from "../diagnostics/render"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// Each file in `packages/fixtures/files/` compiles clean and prints something.
// Other specs reach for a few of them, so this sweeps them all through the
// stages the CLI runs and snapshots what each prints.
//
// `diagnostics/` is left out: those files are broken on purpose, and
// `diagnosticShowcase.spec.ts` reads their reports.

// `stdlibGolden.spec.ts` compares the output of `StdlibExhaustive.es` with
// `__golden__/stdlibExhaustive.txt`, naming the Method behind each line that
// moved.
const SWEPT_ELSEWHERE = new Set(["StdlibExhaustive.es"])

type SweptFixture =
	| { javaScript: string; failure: null }
	| { javaScript: null; failure: string }

// A stage runs only when the one before it reported no errors. A failure
// names the stage that refused and carries its rendered report.
function sweep(fileName: string, source: string): SweptFixture {
	let refused = (
		stage: string,
		diagnostics: Array<common.Diagnostic>,
	): SweptFixture => ({
		javaScript: null,
		failure: `${fileName} does not ${stage}.\n\n${renderDiagnostics(
			diagnostics,
			source,
			fileName,
			{ color: false },
		)}`,
	})

	let parsed = parseWithDiagnostics(source)

	if (containsErrors(parsed.diagnostics)) {
		return refused("parse", parsed.diagnostics)
	}

	let enriched = enrich(parsed.program)

	if (containsErrors(enriched.diagnostics)) {
		return refused("enrich", enriched.diagnostics)
	}

	let diagnostics = validate(enriched.program)

	if (containsErrors(diagnostics)) {
		return refused("validate", diagnostics)
	}

	return {
		javaScript: rewrite(optimise(simplify(enriched.program))),
		failure: null,
	}
}

// Imports the emitted Program from a throwaway module, which resolves because
// the emitted imports are absolute paths into this repository's runtime.
//
// `Terminal.inspect` goes through `console.log`, and `Terminal.print` and
// `Terminal.write` through the streams. All of them write into one buffer, so
// a `write` with no newline shares a line with what follows, as on a terminal.
async function outputOf(javaScript: string): Promise<Array<string>> {
	let directory = mkdtempSync(join(tmpdir(), "essence-sweep-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, javaScript)

	let written = ""
	let originalLog = console.log
	let originalOut = process.stdout.write
	let originalError = process.stderr.write
	let intercept = ((chunk: unknown) => {
		written += String(chunk)

		return true
	}) as typeof process.stdout.write

	// `console.log` ends its line itself, so the interception does too.
	console.log = (...args: Array<unknown>) => {
		written += `${args.map((argument) => String(argument)).join(" ")}\n`
	}

	process.stdout.write = intercept
	process.stderr.write = intercept

	try {
		await import(file)
	} finally {
		console.log = originalLog
		process.stdout.write = originalOut
		process.stderr.write = originalError
		rmSync(directory, { recursive: true, force: true })
	}

	// The last line's trailing newline ends it rather than starting another.
	return written === "" ? [] : written.replace(/\n$/, "").split("\n")
}

let fixtureFiles = readdirSync(FIXTURES_DIRECTORY)
	.filter((fileName) => fileName.endsWith(".es"))
	.filter((fileName) => !SWEPT_ELSEWHERE.has(fileName))
	.sort()

describe("Fixture Sweep", () => {
	it("should have fixtures to sweep", () => {
		expect(fixtureFiles.length).toBeGreaterThan(0)
	})

	for (let fileName of fixtureFiles) {
		describe(fileName, () => {
			let swept = sweep(
				fileName,
				readFileSync(fixturePath(fileName), "utf8"),
			)

			it("should compile without an error", () => {
				if (swept.failure !== null) {
					throw new Error(swept.failure)
				}
			})

			// The snapshots were checked against the `§` comments that
			// annotate each fixture's output. A difference is a change of
			// behaviour to understand before re-capturing, never to silence.
			it("should print what it printed before", async () => {
				if (swept.javaScript === null) {
					throw new Error(swept.failure)
				}

				let output = await outputOf(swept.javaScript)

				expect(output.join("\n")).toMatchSnapshot()
			})
		})
	}
})
