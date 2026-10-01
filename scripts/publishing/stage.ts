import { execFileSync } from "node:child_process"
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import * as path from "node:path"

import {
	COMPILED_DIRECTORY,
	type Manifest,
	packageDirectory,
	PUBLISHED_PACKAGES,
	type PublishedPackage,
	REPOSITORY_ROOT,
	STAGE_DIRECTORY,
	stageDirectory,
	TARBALL_DIRECTORY,
} from "./packages"

// Assembles each package's publishable form outside the tree, under
// `build/publish/packages/`. See "Publishing packages" in DEVELOPMENT.md.

function readManifest(filePath: string): Manifest {
	return JSON.parse(readFileSync(filePath, "utf8")) as Manifest
}

function workspaceVersions(): Map<string, string> {
	let versions = new Map<string, string>()

	for (let { directory } of PUBLISHED_PACKAGES) {
		let manifest = readManifest(
			path.join(packageDirectory(directory), "package.json"),
		)

		versions.set(manifest.name, manifest.version)
	}

	return versions
}

export function compilePackages(): void {
	rmSync(COMPILED_DIRECTORY, { recursive: true, force: true })

	execFileSync(
		path.join(REPOSITORY_ROOT, "node_modules", ".bin", "tsc"),
		["-p", "tsconfig.publish.json"],
		{ cwd: REPOSITORY_ROOT, stdio: "inherit" },
	)
}

// Relative specifiers without extensions, which tsc emits as written and Node's
// ESM loader refuses. Each gets `.js` or `/index.js` from the compiled tree, and
// one that resolves to neither is an error.
const SPECIFIER_PATTERN =
	/(\bfrom\s+|\bimport\s+|\bimport\()(["'])(\.{1,2}\/[^"']+)\2/g

function resolvedSpecifier(fileDirectory: string, specifier: string): string {
	if (/\.[a-zA-Z0-9]+$/.test(path.basename(specifier))) {
		return specifier
	}

	if (existsSync(path.join(fileDirectory, `${specifier}.js`))) {
		return `${specifier}.js`
	}

	if (existsSync(path.join(fileDirectory, specifier, "index.js"))) {
		return `${specifier}/index.js`
	}

	throw new Error(
		`'${specifier}' resolves to nothing compiled in ${fileDirectory}`,
	)
}

export function fixRelativeSpecifiers(root: string): number {
	let rewritten = 0

	for (let entry of readdirSync(root, {
		recursive: true,
		withFileTypes: true,
	})) {
		if (!entry.isFile()) {
			continue
		}

		if (!entry.name.endsWith(".js") && !entry.name.endsWith(".d.ts")) {
			continue
		}

		let filePath = path.join(entry.parentPath, entry.name)
		let text = readFileSync(filePath, "utf8")
		let changed = text.replace(
			SPECIFIER_PATTERN,
			(_, lead: string, quote: string, specifier: string) => {
				let resolved = resolvedSpecifier(entry.parentPath, specifier)

				if (resolved !== specifier) {
					rewritten += 1
				}

				return `${lead}${quote}${resolved}${quote}`
			},
		)

		if (changed !== text) {
			writeFileSync(filePath, changed)
		}
	}

	return rewritten
}

// `./src/<x>.ts` becomes the declaration and the JavaScript a consumer
// resolves. An entry into `tests/` is not published.
function publishedTarget(
	sourcePath: string,
): { types: string; default: string } | null {
	if (sourcePath.includes("/tests/")) {
		return null
	}

	let match = /^\.\/src\/(.+)\.ts$/.exec(sourcePath)

	if (match === null) {
		throw new Error(`'${sourcePath}' is not a ./src/*.ts entry`)
	}

	return {
		types: `./dist/${match[1]}.d.ts`,
		default: `./dist/${match[1]}.js`,
	}
}

type StagedManifest = Omit<Manifest, "exports"> & {
	exports?: Record<string, { types: string; default: string }>
	publishConfig: { access: string }
}

function publishedManifest(
	real: Manifest,
	versions: Map<string, string>,
): StagedManifest {
	let exports: Record<string, { types: string; default: string }> | undefined

	if (real.exports !== undefined) {
		exports = {}

		for (let [key, value] of Object.entries(real.exports)) {
			let target = publishedTarget(value)

			if (target !== null) {
				exports[key] = target
			}
		}
	}

	let dependencies: Record<string, string> | undefined

	if (real.dependencies !== undefined) {
		dependencies = {}

		for (let [name, range] of Object.entries(real.dependencies)) {
			if (range.startsWith("workspace:")) {
				let version = versions.get(name)

				if (version === undefined) {
					throw new Error(
						`${real.name} depends on ${name}, which is not published`,
					)
				}

				dependencies[name] = version
			} else {
				dependencies[name] = range
			}
		}
	}

	let bin: Record<string, string> | undefined

	if (real.bin !== undefined) {
		bin = {}

		// Spelled without `./`, since npm 11 drops a dot-slashed bin path and
		// publishes no commands. The smoke test calls bin files by path, so only
		// the checklist's `--dry-run` would catch this.
		for (let [name, filePath] of Object.entries(real.bin)) {
			bin[name] = `${filePath}.js`
		}
	}

	return {
		name: real.name,
		version: real.version,
		description: real.description,
		type: real.type,
		...(real.main === undefined
			? {}
			: {
					main: "./dist/index.js",
					types: "./dist/index.d.ts",
				}),
		exports,
		bin,
		author: real.author,
		license: real.license,
		homepage: real.homepage,
		repository: real.repository,
		bugs: real.bugs,
		keywords: real.keywords,
		// `import.meta.dirname` and `with { type: "json" }` set the
		// floor. The workspace runs on Bun either way; this is a claim about
		// the compiled package.
		engines: { node: ">=22" },
		dependencies,
		publishConfig: { access: "public" },
	}
}

// The staged bin is the real one, translated rather than duplicated:
// Bun's shebang becomes Node's, and the source import becomes the compiled
// one. Deriving it keeps the two from drifting apart.
function stagedBin(realBinText: string): string {
	return realBinText
		.replace("#!/usr/bin/env bun", "#!/usr/bin/env node")
		.replace(/from "\.\.\/src\/([\w/-]+)"/g, 'from "../dist/$1.js"')
}

function copyData(from: string, to: string): void {
	cpSync(from, to, {
		recursive: true,
		filter: (source) => {
			let base = path.basename(source)

			return base !== "tests" && !base.endsWith(".spec.ts")
		},
	})
}

function writeManifest(filePath: string, manifest: object): void {
	writeFileSync(filePath, `${JSON.stringify(manifest, null, "\t")}\n`)
}

function stagePackage(
	published: PublishedPackage,
	versions: Map<string, string>,
): void {
	let sourceDirectory = packageDirectory(published.directory)
	let targetDirectory = stageDirectory(published.directory)
	let real = readManifest(path.join(sourceDirectory, "package.json"))

	rmSync(targetDirectory, { recursive: true, force: true })
	mkdirSync(targetDirectory, { recursive: true })

	if (published.prebuilt !== undefined) {
		for (let file of published.prebuilt) {
			cpSync(
				path.join(sourceDirectory, file),
				path.join(targetDirectory, file),
			)
		}

		let { private: _, ...rest } = real

		writeManifest(path.join(targetDirectory, "package.json"), {
			...rest,
			publishConfig: { access: "public" },
		})

		return
	}

	cpSync(
		path.join(COMPILED_DIRECTORY, published.directory, "src"),
		path.join(targetDirectory, "dist"),
		{ recursive: true },
	)

	for (let data of published.data ?? []) {
		copyData(
			path.join(sourceDirectory, data),
			path.join(targetDirectory, data),
		)
	}

	for (let binPath of Object.values(real.bin ?? {})) {
		let staged = path.join(targetDirectory, `${binPath}.js`)

		mkdirSync(path.dirname(staged), { recursive: true })
		writeFileSync(
			staged,
			stagedBin(
				readFileSync(path.join(sourceDirectory, binPath), "utf8"),
			),
		)
		chmodSync(staged, 0o755)
	}

	let readme = path.join(sourceDirectory, "README.md")

	if (!existsSync(readme)) {
		throw new Error(`${real.name} has no README.md to publish`)
	}

	cpSync(readme, path.join(targetDirectory, "README.md"))

	let license = existsSync(path.join(sourceDirectory, "LICENSE"))
		? path.join(sourceDirectory, "LICENSE")
		: path.join(REPOSITORY_ROOT, "LICENSE")

	cpSync(license, path.join(targetDirectory, "LICENSE"))

	writeManifest(
		path.join(targetDirectory, "package.json"),
		publishedManifest(real, versions),
	)
}

export function stagePackages(): void {
	compilePackages()

	let rewritten = fixRelativeSpecifiers(COMPILED_DIRECTORY)

	console.log(`staged imports resolved: ${rewritten} specifiers extended`)

	rmSync(STAGE_DIRECTORY, { recursive: true, force: true })

	let versions = workspaceVersions()

	for (let published of PUBLISHED_PACKAGES) {
		stagePackage(published, versions)
		console.log(`staged ${published.directory}`)
	}
}

export function packPackages(): void {
	rmSync(TARBALL_DIRECTORY, { recursive: true, force: true })
	mkdirSync(TARBALL_DIRECTORY, { recursive: true })

	for (let { directory } of PUBLISHED_PACKAGES) {
		execFileSync("npm", ["pack", "--pack-destination", TARBALL_DIRECTORY], {
			cwd: stageDirectory(directory),
			stdio: "inherit",
		})
	}
}

if (import.meta.main) {
	stagePackages()

	if (process.argv.includes("--pack")) {
		packPackages()
	}
}
