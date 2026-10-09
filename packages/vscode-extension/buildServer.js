// Bundles the server from the `@essence-lang/language-server` dependency, so
// the build works inside the monorepo and outside it. The standard library's
// `.es` sources are copied beside the bundle, since the loader reads them with
// `readdirSync`.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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

// The Worker bundles each Program with esbuild, whose native binary differs per
// platform. The extension ships esbuild's WebAssembly build instead. See "The
// test session's esbuild" in DEVELOPMENT.md.
let esbuildWasmPackage = path.dirname(
	fileURLToPath(import.meta.resolve("esbuild-wasm/package.json")),
)
let compilerBundler = fileURLToPath(
	import.meta.resolve("@essence-lang/compiler/bundler"),
)
let esbuildPackage = path.dirname(
	Bun.resolveSync("esbuild/package.json", path.dirname(compilerBundler)),
)
// What the copy keeps of the package: its API, the WebAssembly binary, and
// the Go glue its launcher loads. Its `package.json` keeps `lib/main.js`
// CommonJS. Under the extension's `"type": "module"`, Node would load it as an
// ES module, and importing it would answer none of esbuild's API.
const esbuildWasmFiles = [
	"package.json",
	"LICENSE.md",
	"bin/esbuild",
	"lib/main.js",
	"esbuild.wasm",
	"wasm_exec.js",
	"wasm_exec_node.js",
]
// Where the bundles import the copy from, relative to themselves.
const esbuildWasmEntry = "./esbuild-wasm/lib/main.js"

// A bundled CommonJS module's `__dirname` and `__filename` would otherwise be
// spelled out as the paths it was built from. Every bundle reads its own
// location at run time instead.
export const ownLocation = {
	define: {
		__dirname: "__bundleDirname",
		__filename: "__bundleFilename",
	},
	banner: "const __bundleDirname = import.meta.dirname, __bundleFilename = import.meta.filename;",
}

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

// Points `esbuild` at the copy beside the bundle and leaves it unbundled. Its
// API finds its binary by a path relative to its own file.
const wasmESBuild = {
	name: "wasm-esbuild",
	setup(build) {
		build.onResolve({ filter: /^esbuild$/ }, () => ({
			path: esbuildWasmEntry,
			external: true,
		}))
	},
}

// Copies esbuild's WebAssembly build beside the bundles. Its API starts the
// binary under a bare `node`, which `PATH` may lack, so the copy starts it
// under the process's own executable.
function copyESBuildWasm(directory) {
	let { version } = JSON.parse(
		readFileSync(path.join(esbuildPackage, "package.json"), "utf8"),
	)
	let wasm = JSON.parse(
		readFileSync(path.join(esbuildWasmPackage, "package.json"), "utf8"),
	)

	if (wasm.version !== version) {
		throw new Error(
			`The compiler bundles with esbuild ${version}, but the extension ships esbuild-wasm ${wasm.version}. Pin esbuild-wasm to ${version}.`,
		)
	}

	let copy = path.join(directory, "esbuild-wasm")

	rmSync(copy, { recursive: true, force: true })

	for (let file of esbuildWasmFiles) {
		mkdirSync(path.dirname(path.join(copy, file)), { recursive: true })
		cpSync(path.join(esbuildWasmPackage, file), path.join(copy, file))
	}

	let api = path.join(copy, "lib", "main.js")
	let launch =
		/\["node", \[(\w+)\.join\(__dirname, "\.\.", "bin", "esbuild"\)\]\]/g
	let source = readFileSync(api, "utf8")

	if (source.match(launch)?.length !== 1) {
		throw new Error(
			`esbuild-wasm ${wasm.version} no longer starts its binary as 'node bin/esbuild' in lib/main.js, so buildServer.js can not point it at the process's own executable.`,
		)
	}

	writeFileSync(
		api,
		source.replace(
			launch,
			'[process.execPath, [$1.join(__dirname, "..", "bin", "esbuild")]]',
		),
	)
}

// Writes `server.js`, `testWorker.js` and what they read at run time into
// `directory`.
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
			plugins: [moduleEntries, wasmESBuild],
			...ownLocation,
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

	copyESBuildWasm(directory)
}

if (import.meta.main) {
	await buildServer(path.join(import.meta.dirname, "server"))
}
