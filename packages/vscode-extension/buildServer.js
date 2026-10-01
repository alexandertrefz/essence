// Bundles the server from the `@essence-lang/language-server` dependency, so
// the build works inside the monorepo and outside it. The standard library's
// `.es` sources are copied beside the bundle, since the loader reads them with
// `readdirSync`.
import { spawnSync } from "node:child_process"
import { cpSync, rmSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

let serverEntry = fileURLToPath(
	import.meta.resolve("@essence-lang/language-server/serverEntry"),
)
// The test session's Worker is bundled beside the server, since a Worker starts
// from a file. The session looks for `testWorker.js` beside itself and falls
// back to the TypeScript source.
let workerEntry = fileURLToPath(
	import.meta.resolve("@essence-lang/language-server/testWorker"),
)
let stdlibEntry = fileURLToPath(
	import.meta.resolve("@essence-lang/standard-library"),
)
let stdlibSources = path.resolve(path.dirname(stdlibEntry), "../sources")
// The runtime's TypeScript sources go beside the bundle too, since the Bundler
// reads them off disk when the test session's Worker compiles a Program.
// `RUNTIME_DIRECTORY` looks for them here.
let runtimeEntry = fileURLToPath(import.meta.resolve("@essence-lang/runtime"))
let runtimeSources = path.dirname(runtimeEntry)

for (let [entry, outfile] of [
	[serverEntry, "server/server.js"],
	[workerEntry, "server/testWorker.js"],
]) {
	let build = spawnSync(
		"bun",
		[
			"build",
			entry,
			"--target=node",
			"--format=esm",
			`--outfile=${outfile}`,
		],
		{ cwd: import.meta.dirname, stdio: "inherit" },
	)

	if (build.status !== 0) {
		process.exit(build.status ?? 1)
	}
}

for (let [sources, name] of [
	[stdlibSources, "standard-library"],
	[runtimeSources, "runtime"],
]) {
	let bundled = path.join(import.meta.dirname, "server", name)

	rmSync(bundled, { recursive: true, force: true })
	cpSync(sources, bundled, {
		recursive: true,
		// The runtime's specs are left out: no Program bundles them, and
		// their `bun:test` imports would sit in the tree esbuild resolves.
		filter: (from) => path.basename(from) !== "tests",
	})
}
