import { execFileSync, spawnSync } from "node:child_process"
import {
	cpSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import {
	type Manifest,
	PUBLISHED_PACKAGES,
	REPOSITORY_ROOT,
	STAGE_DIRECTORY,
} from "./packages"
import { stagePackages } from "./stage"

// NOTE: The lesson the monorepo split taught, applied before anything is
// published: a green suite proves the SOURCES, and only running the artifact
// proves the artifact. The staged packages are copied into a scratch npm
// workspace in the system's tmpdir — outside the repository, so a missing
// file cannot be papered over by Node walking up into the workspace's own
// `node_modules` — installed with real npm, and driven with real Node:
// every export imported, a program compiled, run, source-mapped, formatted.
//
// The tmpdir is realpath'd for the same reason `prepareBundle` realpaths in
// the debug adapter: macOS answers `mkdtempSync` with a symlink, and paths
// that are compared must all be spelled canonically.

function run(
	command: string,
	commandArguments: Array<string>,
	cwd: string,
): string {
	return execFileSync(command, commandArguments, { cwd, encoding: "utf8" })
}

function importableSpecifiers(manifest: Manifest): Array<string> {
	if (manifest.exports !== undefined) {
		return Object.keys(manifest.exports)
			.filter((key) => !key.includes("*"))
			.map((key) => `${manifest.name}${key.slice(1)}`)
	}

	if (manifest.main !== undefined) {
		return [manifest.name]
	}

	return []
}

function assert(condition: boolean, message: string): void {
	if (!condition) {
		throw new Error(`smoke: ${message}`)
	}
}

stagePackages()

let root = realpathSync(
	mkdtempSync(path.join(os.tmpdir(), "essence-publish-smoke-")),
)

console.log(`smoke workspace: ${root}`)

try {
	writeFileSync(
		path.join(root, "package.json"),
		`${JSON.stringify(
			{
				name: "essence-publish-smoke",
				private: true,
				workspaces: ["packages/*"],
			},
			null,
			"\t",
		)}\n`,
	)
	cpSync(STAGE_DIRECTORY, path.join(root, "packages"), { recursive: true })

	console.log("installing external dependencies with npm…")
	execFileSync(
		"npm",
		["install", "--no-audit", "--no-fund", "--loglevel=error"],
		{ cwd: root, stdio: "inherit" },
	)

	let cliManifest = JSON.parse(
		readFileSync(
			path.join(root, "packages", "cli", "package.json"),
			"utf8",
		),
	) as Manifest
	let essence = path.join(root, "packages", "cli", "bin", "essence.js")

	let version = run("node", [essence, "--version"], root).trim()

	assert(
		version === cliManifest.version,
		`--version answered '${version}', the manifest says '${cliManifest.version}'`,
	)
	console.log(`smoke: essence --version → ${version}`)

	for (let { directory } of PUBLISHED_PACKAGES) {
		let manifest = JSON.parse(
			readFileSync(
				path.join(root, "packages", directory, "package.json"),
				"utf8",
			),
		) as Manifest

		for (let specifier of importableSpecifiers(manifest)) {
			execFileSync(
				"node",
				[
					"--eval",
					`import(${JSON.stringify(
						specifier,
					)}).then(() => {}, (error) => { console.error(error); process.exit(1) })`,
				],
				{ cwd: root, stdio: ["ignore", "inherit", "inherit"] },
			)
		}

		console.log(`smoke: ${manifest.name} imports under Node`)
	}

	let helloSource = readFileSync(
		path.join(REPOSITORY_ROOT, "packages/fixtures/files/HelloWorld.es"),
		"utf8",
	)

	writeFileSync(path.join(root, "Hello.es"), helloSource)
	run(
		"node",
		[
			essence,
			"build",
			"Hello.es",
			"--out",
			"Hello.js",
			"--sourcemap",
			"--quiet",
		],
		root,
	)
	assert(existsSync(path.join(root, "Hello.js")), "no bundle was written")
	assert(existsSync(path.join(root, "Hello.js.map")), "no map was written")

	let map = JSON.parse(
		readFileSync(path.join(root, "Hello.js.map"), "utf8"),
	) as { sources: Array<string> }

	assert(
		map.sources.length > 0 &&
			map.sources.every((source) => source.endsWith(".es")),
		`the map's sources are not all .es files: ${map.sources.join(", ")}`,
	)

	let output = run("node", [path.join(root, "Hello.js")], root)

	assert(output.includes("Hello"), `the program printed: ${output}`)
	console.log("smoke: compiled with the published compiler, ran under Node")

	let ran = run("node", [essence, "run", "Hello.es", "--quiet"], root)

	assert(ran.includes("Hello"), `essence run printed: ${ran}`)
	console.log("smoke: essence run works")

	let esfmt = path.join(root, "packages", "formatter", "bin", "esfmt.js")
	let formatted = spawnSync("node", [esfmt, "--stdin"], {
		cwd: root,
		input: helloSource,
		encoding: "utf8",
	})

	assert(
		formatted.status === 0,
		`esfmt --stdin exited ${formatted.status}: ${formatted.stderr}`,
	)
	assert(
		formatted.stdout === helloSource,
		"esfmt --stdin did not answer the already-formatted source unchanged",
	)
	console.log("smoke: esfmt formats over stdin")

	console.log("\nsmoke: every check passed")
} finally {
	if (process.argv.includes("--keep")) {
		console.log(`smoke workspace kept at ${root}`)
	} else {
		rmSync(root, { recursive: true, force: true })
	}
}
