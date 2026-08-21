// NOTE: The server is bundled from the `@essence-lang/language-server`
// DEPENDENCY, not from a path counted out to a sibling directory. Inside the
// monorepo the workspace satisfies the pinned version and this resolves to
// the TypeScript sources; anywhere else `bun install` fetches the published
// package and this resolves to its compiled `dist/` — the same build works
// from either, which is what lets the extension be built away from the
// monorepo at all. The standard library's `.es` sources are copied beside the
// bundle the same way, resolved off the package that owns them — the loader
// finds them with `readdirSync`, and no bundler can see through that.
import { spawnSync } from "node:child_process"
import { cpSync, rmSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

let serverEntry = fileURLToPath(
	import.meta.resolve("@essence-lang/language-server/serverEntry"),
)
// NOTE: The test session's Worker is bundled BESIDE the server rather than into
// it. A Worker is started from a file, and the server ships as one file with no
// `node_modules` to resolve out of — so the file has to exist, and it has to
// carry the Compiler and the standard library loader with it. The session looks
// for `testWorker.js` beside itself and falls back to the TypeScript source,
// which is what runs inside the monorepo.
let workerEntry = fileURLToPath(
	import.meta.resolve("@essence-lang/language-server/testWorker"),
)
let stdlibEntry = fileURLToPath(
	import.meta.resolve("@essence-lang/standard-library"),
)
let stdlibSources = path.resolve(path.dirname(stdlibEntry), "../sources")
// NOTE: The runtime's TypeScript sources go beside the bundle for the same
// reason the standard library's `.es` sources do, and it is the same failure
// when they do not: the Bundler writes their absolute paths into the JavaScript
// it emits and then reads them off disk, so no bundler can see through it. The
// server itself never compiles a Program — but the test session's Worker does,
// and without these every run it attempts answers "Could not resolve
// .../Integer.ts". `RUNTIME_DIRECTORY` looks for them here.
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
		// NOTE: The runtime's own specs come with its sources and are no part
		// of what a Program bundles. Copying them would ship a `tests/`
		// directory into every extension and, worse, put `bun:test` imports
		// inside the tree esbuild resolves against.
		filter: (from) => path.basename(from) !== "tests",
	})
}
