import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { compileToMemory } from "@essence-lang/compiler/embed"
import { fixturePath } from "@essence-lang/fixtures"
import type { common } from "@essence-lang/interfaces"
import { analyse } from "@essence-lang/language-server/analyse"

import { compileFile } from "../pipeline"

// NOTE: `essence check X.es` and the Editor's Problems for X.es are ONE list.
// They run the same analysis — see `@essence-lang/compiler/analysis` — and this
// is what says so over every deliberately broken file in the corpus rather than
// over one example somebody remembered to write down.
//
// It is a CLI spec because the CLI is the only package that can reach both: it
// depends on the Language Server, and nothing depends on it.
//
// NOTE: Compared by code, Position and message. What is deliberately NOT
// compared is presentation: `esc` renders a report and the Editor publishes
// LSP Diagnostics, and the two will never be the same bytes.
function fingerprint(diagnostic: common.Diagnostic): string {
	let position = diagnostic.position

	return [
		diagnostic.severity,
		diagnostic.code,
		position === null
			? "-"
			: `${position.start.line}:${position.start.column}-${position.end.line}:${position.end.column}`,
		diagnostic.message,
	].join(" ")
}

async function checkFingerprints(filePath: string): Promise<Array<string>> {
	let outcome = await compileFile({
		inputFileName: filePath,
		outputFileName: null,
		minify: false,
		sourcemap: false,
	})

	return outcome.modules
		.filter((module) => module.fileName === filePath)
		.flatMap((module) => module.diagnostics.map(fingerprint))
}

function editorFingerprints(filePath: string): Array<string> {
	return analyse(readFileSync(filePath, "utf8"), filePath).map(fingerprint)
}

// NOTE: The THIRD reader of the same list — the seam a host embeds the Compiler
// through, which is where the Vite, Bun and esbuild plugins get a build's
// mistakes from. It used to stop at whichever stage reported first and call the
// Validator bare underneath, so a plugin's Problems panel showed one mistake
// where `essence check` over the very same file showed three, and a reader had
// no way to tell which of the two was telling them the truth about their file.
async function embedFingerprints(filePath: string): Promise<Array<string>> {
	let result = await compileToMemory(filePath)

	return result.diagnosticGroups
		.filter((group) => group.filePath === filePath)
		.flatMap((group) => group.diagnostics.map(fingerprint))
}

const SHOWCASE_DIRECTORY = fixturePath("diagnostics")

let showcaseFiles = readdirSync(SHOWCASE_DIRECTORY)
	.filter((fileName) => fileName.endsWith(".es"))
	.sort()

describe("one analysis", () => {
	it("has files to compare", () => {
		expect(showcaseFiles.length).toBeGreaterThan(0)
	})

	for (let fileName of showcaseFiles) {
		it(`answers alike for ${fileName} from the command line, the Editor and an embedding host`, async () => {
			let filePath = path.join(SHOWCASE_DIRECTORY, fileName)
			let fromCheck = await checkFingerprints(filePath)

			expect(fromCheck).toEqual(editorFingerprints(filePath))
			expect(fromCheck).toEqual(await embedFingerprints(filePath))
		})
	}

	// NOTE: A Module graph is the case the two used to be furthest apart on —
	// the Editor answered a dependency's mistake AND said so over the import,
	// while `esc` said only the first. The entry's own list is what is compared:
	// each of the graph's other files is reported under its own name on both
	// sides, and `Main.es` is where they used to disagree.
	it("answers alike for a Module whose dependency is broken", async () => {
		let filePath = fixturePath("diagnostics", "modules", "Main.es")
		let fromCheck = await checkFingerprints(filePath)

		expect(fromCheck).toEqual(editorFingerprints(filePath))
		expect(fromCheck).toEqual(await embedFingerprints(filePath))
	})
})

// NOTE: The finding this whole seam was built for. Three mistakes, one per
// stage, in one file: the Enricher's `unknown-name` used to be the entire
// report, and the two Validator Diagnostics above it took two more edit-and-
// check rounds to find.
describe("every stage in one run", () => {
	let filePath = path.join(SHOWCASE_DIRECTORY, "Staged.es")

	it("reports all three mistakes from the command line, in file order", async () => {
		let outcome = await compileFile({
			inputFileName: filePath,
			outputFileName: null,
			minify: false,
			sourcemap: false,
		})

		expect(
			outcome.diagnostics.map((diagnostic) => [
				diagnostic.code,
				diagnostic.position?.start.line,
			]),
		).toEqual([
			["return-type-mismatch", 12],
			["missing-return", 16],
			["unknown-name", 21],
		])
		expect(outcome.ok).toBe(false)
		// NOTE: And no stage refused, so nothing is said about one. A `check`
		// writes no file, so there is nothing it stopped short of either.
		expect(outcome.failedStage).toBeNull()
	})

	it("reports all three mistakes in the Editor, in file order", () => {
		expect(
			analyse(readFileSync(filePath, "utf8"), filePath).map(
				(diagnostic) => [
					diagnostic.code,
					diagnostic.position?.start.line,
				],
			),
		).toEqual([
			["return-type-mismatch", 12],
			["missing-return", 16],
			["unknown-name", 21],
		])
	})

	// NOTE: And through the embedding seam, which is the one that used to stop
	// at the first stage that reported — a host building this file was handed
	// the `unknown-name` and nothing else.
	it("reports all three mistakes to an embedding host, in file order", async () => {
		let result = await compileToMemory(filePath)

		expect(
			result.diagnostics.map((diagnostic) => [
				diagnostic.code,
				diagnostic.position?.start.line,
			]),
		).toEqual([
			["return-type-mismatch", 12],
			["missing-return", 16],
			["unknown-name", 21],
		])
	})
})
