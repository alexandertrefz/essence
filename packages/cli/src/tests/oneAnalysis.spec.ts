import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { compileToMemory } from "@essence-lang/compiler/embed"
import { fixturePath } from "@essence-lang/fixtures"
import type { common } from "@essence-lang/interfaces"
import { analyse } from "@essence-lang/language-server/analyse"

import { compileFile } from "../pipeline"

// `essence check X.es` and the Editor's Problems for X.es are one list, from one
// analysis in `@essence-lang/compiler/analysis`. This checks it over every broken
// file in the corpus. Only the CLI depends on the Language Server, so only it can
// reach both. Code, Position and message are compared, never presentation.
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

// The third reader of the list: the seam a host embeds the Compiler through,
// which the Vite, Bun and esbuild plugins report from. It must report every
// mistake `essence check` does.
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

	// In a Module graph, the entry's own list is compared. Each other file
	// reports under its own name, and `Main.es` reports over the import.
	it("answers alike for a Module whose dependency is broken", async () => {
		let filePath = fixturePath("diagnostics", "modules", "Main.es")
		let fromCheck = await checkFingerprints(filePath)

		expect(fromCheck).toEqual(editorFingerprints(filePath))
		expect(fromCheck).toEqual(await embedFingerprints(filePath))
	})
})

// Three mistakes in one file from two stages: the Validator's
// `return-type-mismatch` and `missing-return`, and the Enricher's
// `unknown-name`. One run reports all three.
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
		// No stage refused, and a `check` writes no file, so nothing says it stopped.
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

	// Through the embedding seam too, which must report more than the first stage's
	// mistake.
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
