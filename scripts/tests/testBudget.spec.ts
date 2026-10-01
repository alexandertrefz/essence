import { afterAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { spawnAndWait } from "@essence-lang/fixtures/spawn"

import { REPOSITORY_ROOT } from "../publishing/packages"
import { budgetFrom, specFileName } from "../testBudget"

// The probes outlast the lowered budget but not Bun's default, so a probe
// that falls back to the default passes.
const loweredBudget = 100
const probes = {
	"first.spec.ts": [
		'import { it } from "bun:test"',
		'it("passes", () => {})',
	],
	"test.spec.ts": [
		'import { it } from "bun:test"',
		'it("outlasts the budget", async () => { await Bun.sleep(2_000) })',
	],
	"hook.spec.ts": [
		'import { beforeAll, it } from "bun:test"',
		"beforeAll(async () => { await Bun.sleep(2_000) })",
		'it("waits for a hook that outlasts the budget", () => {})',
	],
	"shebang.spec.ts": [
		"#!/usr/bin/env bun",
		'import { it } from "bun:test"',
		'it("outlasts the budget after a #! line", async () => { await Bun.sleep(2_000) })',
	],
	"names.spec.ts": [
		'import { it } from "bun:test"',
		'import { createRequire } from "node:module"',
		"const require = createRequire(import.meta.url)",
		"function setDefaultTimeout(_: number) {}",
		"function setTestBudget(_: number) {}",
		'it("outlasts the budget beside its own names", async () => { await Bun.sleep(2_000) })',
	],
}

const directory = mkdtempSync(path.join(tmpdir(), "essence-test-budget-"))

for (let [name, lines] of Object.entries(probes)) {
	writeFileSync(path.join(directory, name), lines.join("\n") + "\n")
}

afterAll(() => {
	rmSync(directory, { recursive: true, force: true })
})

// Bun's own file names for a test.
const testFileName = /[._](test|spec)\.[cm]?[jt]sx?$/

describe("the test budget", () => {
	for (let mode of [[], ["--isolate"], ["--parallel=2"]]) {
		it(`should reach every file of a run with ${mode.join(" ") || "no flags"}`, async () => {
			// From the repository root, so that its `bunfig.toml` preloads the
			// budget, and by path, so that the probes run in the order given.
			let run = await spawnAndWait(
				[
					process.execPath,
					"test",
					...mode,
					...Object.keys(probes).map((name) =>
						path.join(directory, name),
					),
				],
				{
					cwd: REPOSITORY_ROOT,
					env: {
						...process.env,
						ESSENCE_TEST_BUDGET: String(loweredBudget),
					},
				},
			)
			let output = run.stdout + run.stderr
			let timedOut = `this test timed out after ${loweredBudget}ms`

			expect(output.match(/this test timed out after \d+ms/g)).toEqual([
				timedOut,
				timedOut,
				timedOut,
			])
			expect(output.match(/hook timed out/g)).toHaveLength(1)
			expect(output).toMatch(/\b1 pass\b/)
			expect(output).toMatch(/\b4 fail\b/)
		})
	}

	it("should keep a minute for a budget that is not a positive number", () => {
		expect(
			["", "abc", "0", "-5", "Infinity", undefined].map(budgetFrom),
		).toEqual(Array(6).fill(60_000))
		expect(budgetFrom("100")).toBe(100)
	})

	it("should find every test file named so that the budget reaches it", async () => {
		let listed = await spawnAndWait(["git", "ls-files", "-z"], {
			cwd: REPOSITORY_ROOT,
		})

		if (listed.code !== 0) {
			throw new Error(`git ls-files failed: ${listed.stderr}`)
		}

		let misnamed = listed.stdout
			.split("\0")
			.filter(
				(file) => testFileName.test(file) && !specFileName.test(file),
			)

		expect(misnamed).toEqual([])
	})
})
