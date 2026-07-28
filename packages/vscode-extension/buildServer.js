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
let stdlibEntry = fileURLToPath(import.meta.resolve("@essence-lang/stdlib"))
let stdlibSources = path.resolve(path.dirname(stdlibEntry), "../sources")

let build = spawnSync(
	"bun",
	[
		"build",
		serverEntry,
		"--target=node",
		"--format=esm",
		"--outfile=server/server.js",
	],
	{ cwd: import.meta.dirname, stdio: "inherit" },
)

if (build.status !== 0) {
	process.exit(build.status ?? 1)
}

let bundledSources = path.join(import.meta.dirname, "server", "stdlib")

rmSync(bundledSources, { recursive: true, force: true })
cpSync(stdlibSources, bundledSources, { recursive: true })
