import { afterAll, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { spawnAndWait } from "@essence-lang/fixtures/spawn"

import { STDLIB_DIRECTORY } from "../index"

// The standard library's own `@example` blocks, run as a reader would run them:
// `essence test` in the library's directory. An example that stops being true
// fails here instead of misleading in hover text.

const essence = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"cli",
	"bin",
	"essence",
)

// Bundle and result caches of this spec's own, so it neither reads nor fills
// the developer's. A result left there would be replayed by their next
// `essence test` in this repository.
const cache = mkdtempSync(path.join(tmpdir(), "essence-stdlib-examples-"))
const results = mkdtempSync(path.join(tmpdir(), "essence-stdlib-results-"))

afterAll(() => {
	rmSync(cache, { recursive: true, force: true })
	rmSync(results, { recursive: true, force: true })
})

// The budget `scripts/testBudget.ts` gives every spec, written out. This
// spawns a whole `essence test` over the library and reads its report, which
// is bounded, deterministic work.
it("runs every example the standard library documents", async () => {
	let answer = await spawnAndWait(
		[process.execPath, essence, "test", "--no-color"],
		{
			cwd: STDLIB_DIRECTORY,
			env: {
				...process.env,
				ESSENCE_CLI_CACHE: cache,
				ESSENCE_RESULTS_CACHE: results,
			},
		},
	)
	let out = answer.stdout
	let err = answer.stderr

	expect([answer.code, err]).toEqual([0, err])
	expect(out).toContain("examples")
	expect(out).toContain("passed")
	// A count rather than names, since examples come and go. Finding none
	// means the wiring broke.
	expect(out).not.toContain("no tests")
}, 60_000)
