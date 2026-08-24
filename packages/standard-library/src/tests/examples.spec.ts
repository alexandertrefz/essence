import { afterAll, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { STDLIB_DIRECTORY } from "../index"

// NOTE: The standard library's own `@example` blocks, run the way a reader
// would run them: `essence test` in the library's own directory. It is a spec
// of the LIBRARY rather than of the Compiler — what it holds honest is the
// documentation, so that an example which stopped being true fails a run
// instead of sitting in hover text saying something that is not so.

const essence = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"cli",
	"bin",
	"essence",
)

// NOTE: A bundle cache of this spec's own, so a run neither answers out of the
// developer's cache nor fills it — and a result cache beside it, for the same
// reason twice over: this run is the STANDARD LIBRARY's own, so an answer left
// in the developer's store would be replayed by the very next `essence test`
// they run in this repository.
const cache = mkdtempSync(path.join(tmpdir(), "essence-stdlib-examples-"))
const results = mkdtempSync(path.join(tmpdir(), "essence-stdlib-results-"))

afterAll(() => {
	rmSync(cache, { recursive: true, force: true })
	rmSync(results, { recursive: true, force: true })
})

it("runs every example the standard library documents", () => {
	let answer = Bun.spawnSync(
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
	let out = answer.stdout.toString()
	let err = answer.stderr.toString()

	expect([answer.exitCode, err]).toEqual([0, err])
	expect(out).toContain("examples")
	expect(out).toContain("passed")
	// NOTE: A number rather than a name: which Methods carry an example is the
	// library's business and changes with every one that is written, but a run
	// that suddenly finds NONE is the wiring having quietly come apart.
	expect(out).not.toContain("no tests")
})
