// Bundles the server from the `@essence-lang/language-server` dependency, so
// the build works inside the monorepo and outside it. The standard library's
// `.es` sources are copied beside the bundle, since the loader reads them with
// `readdirSync`.
import { cpSync, readFileSync, rmSync } from "node:fs"
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

// Packages whose `main` wraps itself in a universal module factory. The
// factory takes `require` as a Parameter, which hides its files from the
// bundler, and the bundle would look for them beside itself. Their `module`
// entry is plain modules the bundler follows.
const umdPackages = ["jsonc-parser"]

const moduleEntries = {
	name: "module-entries",
	setup(build) {
		build.onResolve(
			{ filter: new RegExp(`^(${umdPackages.join("|")})$`) },
			(args) => {
				let manifest = Bun.resolveSync(
					`${args.path}/package.json`,
					path.dirname(args.importer),
				)
				let { module } = JSON.parse(readFileSync(manifest, "utf8"))

				return { path: path.resolve(path.dirname(manifest), module) }
			},
		)
	},
}

// Writes `server.js`, `testWorker.js` and the sources they read at run time
// into `directory`.
export async function buildServer(directory) {
	for (let [entry, name] of [
		[serverEntry, "server.js"],
		[workerEntry, "testWorker.js"],
	]) {
		let build = await Bun.build({
			entrypoints: [entry],
			outdir: directory,
			naming: name,
			target: "node",
			format: "esm",
			plugins: [moduleEntries],
			throw: false,
		})

		if (!build.success) {
			throw new AggregateError(build.logs, `Bundling ${name} failed.`)
		}
	}

	for (let [sources, name] of [
		[stdlibSources, "standard-library"],
		[runtimeSources, "runtime"],
	]) {
		let bundled = path.join(directory, name)

		rmSync(bundled, { recursive: true, force: true })
		cpSync(sources, bundled, {
			recursive: true,
			// The runtime's specs are left out: no Program bundles them, and
			// their `bun:test` imports would sit in the tree esbuild resolves.
			filter: (from) => path.basename(from) !== "tests",
		})
	}
}

if (import.meta.main) {
	await buildServer(path.join(import.meta.dirname, "server"))
}
