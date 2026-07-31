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

// NOTE: The files in `packages/fixtures/files/` are what the language looks
// like when it works — each one compiles clean and prints something. Specs
// elsewhere reach for individual fixtures (`Loops.es`, `Everyday.es`,
// `GenericChoice.es`), which leaves every other one carried by nothing at all.
// This sweeps them all through the stages the CLI runs and records what each
// prints, so a change that breaks a fixture nobody wrote a spec for says so
// here rather than waiting for the next reader to open the file.
//
// NOTE: `diagnostics/` is deliberately left out. Those files are broken on
// purpose, and `diagnosticShowcase.spec.ts` reads their reports end to end.

// NOTE: `StdlibExhaustive.es` is swept by `stdlibGolden.spec.ts` instead, which
// compiles it, runs it and compares all fifteen hundred printed lines against
// `__golden__/stdlibExhaustive.txt` — with a differ that names the Method
// behind each line that moved. A snapshot here would be a second copy of that
// record to keep in step, and the golden one says far more when it breaks.
const SWEPT_ELSEWHERE = new Set(["StdlibExhaustive.es"])

type SweptFixture =
	| { javaScript: string; failure: null }
	| { javaScript: null; failure: string }

// NOTE: A stage only runs when the one before it reported no errors — the
// Enricher never sees a Program the Parser gave up on — so a failure can name
// the stage that refused, and carries that stage's own rendered report: the
// point of sweeping a file nobody wrote a spec for is that the failure has to
// say which line of it to open.
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

// NOTE: Writes the emitted Program to a throwaway module and imports it so its
// top-level `Terminal` calls run, the way `matchLowering.spec.ts` does — the
// emitted imports are absolute paths into this repo's runtime, so the module
// resolves from the temporary directory it is written to. A fixture that throws
// on its way through fails the test with its own error, which is the other half
// of what running one is for.
//
// NOTE: All three doors, into ONE buffer in the order they were written.
// `Terminal.inspect` goes through `console.log`, and `Terminal.print` and
// `Terminal.write` through the streams, because there is no way to spell "no
// newline" through the console — so a harness that only replaced `console.log`
// would capture nothing at all for a fixture that prints, and record its
// silence as the fixture's output. One buffer rather than one per stream
// because what is snapshotted is what a reader watching the terminal sees, and
// a `write` with no newline belongs on the same line as whatever follows it.
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

	// NOTE: `console.log` ends its line itself, so the interception has to end
	// it too — otherwise an `inspect` would run into whatever printed next.
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

	// NOTE: The trailing newline of the last line is the line's ending rather
	// than a line of its own, so it is dropped — a fixture that ends without
	// one keeps its unterminated last line all the same.
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

			// NOTE: The snapshots were read line by line against the `§`
			// comments the fixtures annotate their own output with before they
			// were committed. They record what these Programs DO, so a
			// difference here is a change of behaviour to be understood and
			// then re-captured deliberately — never re-captured to make this
			// pass.
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
