import { createHash, type Hash, randomBytes } from "node:crypto"
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

// What every on-disk cache of the toolchain shares: where it lives, the atomic
// write, and the compiler's fingerprint. See "Developing the caches" in
// DEVELOPMENT.md.

// The area names both the leaf directory and the variable that moves it, so
// the two can not drift apart.
export function cacheVariable(area: string): string {
	return `ESSENCE_${area.toUpperCase()}_CACHE`
}

// The values of an area's variable that turn its cache off rather than move it.
const DISABLING_WORDS = new Set(["0", "off", "false", "no"])

// The client never asks, since its bundles have to be files before `import()`
// can reach them.
export function isCacheDisabled(area: string): boolean {
	let override = process.env[cacheVariable(area)]

	return override !== undefined && DISABLING_WORDS.has(override.toLowerCase())
}

// The platform's own cache location, which its backups and cleaners already
// treat as regenerable. See "Where caches live" in DEVELOPMENT.md.
export function cacheDirectory(area: string): string {
	let override = process.env[cacheVariable(area)]

	// A disabling word is not a path, so an area that ignores
	// `isCacheDisabled` keeps its usual directory rather than one named `off`.
	if (
		override !== undefined &&
		override !== "" &&
		!DISABLING_WORDS.has(override.toLowerCase())
	) {
		return path.resolve(override)
	}

	let xdg = process.env.XDG_CACHE_HOME

	if (xdg !== undefined && xdg !== "") {
		return path.join(xdg, "essence", area)
	}

	if (process.platform === "darwin") {
		return path.join(os.homedir(), "Library", "Caches", "essence", area)
	}

	if (process.platform === "win32") {
		let local = process.env.LOCALAPPDATA

		if (local !== undefined && local !== "") {
			return path.join(local, "essence", area, "Cache")
		}
	}

	return path.join(os.homedir(), ".cache", "essence", area)
}

// Unique per process and call, so racing writers never share a temporary file.
// It stands beside the target because `rename` is atomic only within one file
// system.
export function temporaryPath(file: string): string {
	return `${file}.${process.pid}.${randomBytes(6).toString("hex")}`
}

// Renamed into place, so a reader sees no file or a whole one. Every failure
// is swallowed, since what is written here can be rebuilt. See "Atomic writes"
// in DEVELOPMENT.md.
export function writeAtomicSync(file: string, contents: Uint8Array): void {
	let temporary = temporaryPath(file)

	try {
		mkdirSync(path.dirname(file), { recursive: true })
		writeFileSync(temporary, contents)
		renameSync(temporary, file)
	} catch {
		rmSync(temporary, { force: true })
	}
}

// The same write for a caller that has to see failures. An existing file is
// kept unless `replace` is set. Answers whether this call wrote the file.
export async function writeAtomic(
	file: string,
	contents: string | Uint8Array,
	options: { replace?: boolean } = {},
): Promise<boolean> {
	if (options.replace !== true && (await exists(file))) {
		return false
	}

	await mkdir(path.dirname(file), { recursive: true })

	let temporary = temporaryPath(file)

	await writeFile(temporary, contents)

	try {
		await rename(temporary, file)
	} catch (error) {
		// Windows refuses a rename onto an existing file. Losing that race is
		// no error, since the winner wrote the same bytes.
		await rm(temporary, { force: true })

		if (options.replace === true || !(await exists(file))) {
			throw error
		}

		return false
	}

	return true
}

async function exists(file: string): Promise<boolean> {
	try {
		await stat(file)

		return true
	} catch {
		return false
	}
}

// The compiler's own code by content, which `toolchainKey` leaves out. Read
// once per process. See "The compiler fingerprint" in DEVELOPMENT.md.
let fingerprint: string | null = null

export function compilerFingerprint(): string {
	fingerprint ??= digestCompiler()

	return fingerprint
}

// `src/` in a checkout and `dist/` in an installed package. This module sits in
// `cache/` inside it either way.
const COMPILER_TREE = path.resolve(import.meta.dirname, "..")

// Proof that `COMPILER_TREE` is the compiler's. A compiler bundled into one
// file has neither directory beside it, and its "tree" is wherever the bundle
// was written.
const STAGE_DIRECTORIES = ["enricher", "rewriter"]

function digestCompiler(): string {
	let hash = createHash("sha256")
	let files = compilerSources()

	// A bundle is replaced rather than edited, so its size and modification
	// time name it.
	if (files.length === 0) {
		try {
			let bundle = statSync(import.meta.filename)

			mix(hash, `${bundle.size}:${bundle.mtimeMs}`)
		} catch {
			// A caller refuses to key on the empty digest.
			return ""
		}

		return hash.digest("hex")
	}

	// Named relative to the tree, so that one compiler installed under two
	// prefixes fingerprints the same.
	for (let filePath of files) {
		mix(hash, path.relative(COMPILER_TREE, filePath))
		mix(hash, readFileSync(filePath, "utf8"))
	}

	// The interfaces shape every value a cache stores, so an edit confined to
	// them changes the key too.
	for (let [name, filePath] of interfacesSources()) {
		mix(hash, `interfaces/${name}`)
		mix(hash, readFileSync(filePath, "utf8"))
	}

	return hash.digest("hex")
}

// Resolved rather than reached by a relative path, since the packages sit side
// by side in a checkout and under `node_modules` in an install.
const INTERFACES_TREE = interfacesTree()

function interfacesTree(): string | null {
	try {
		return path.dirname(
			fileURLToPath(import.meta.resolve("@essence-lang/interfaces")),
		)
	} catch {
		return null
	}
}

// Never asked for a bundle, whose stat already names the interfaces inside it.
function interfacesSources(): Array<[name: string, filePath: string]> {
	if (INTERFACES_TREE === null) {
		return []
	}

	let tree = INTERFACES_TREE
	let found: Array<[name: string, filePath: string]> = []

	try {
		for (let entry of readdirSync(INTERFACES_TREE, {
			recursive: true,
			withFileTypes: true,
		})) {
			if (
				entry.isFile() &&
				(entry.name.endsWith(".ts") || entry.name.endsWith(".js"))
			) {
				let filePath = path.join(entry.parentPath, entry.name)

				found.push([path.relative(tree, filePath), filePath])
			}
		}
	} catch {
		return []
	}

	return found.sort(([left], [right]) => (left < right ? -1 : 1))
}

// Sorted, so the digest does not depend on directory order. A `tests`
// directory is left out, since a spec can not change what the compiler
// produces.
function compilerSources(): Array<string> {
	let found: Array<string> = []

	try {
		if (
			!STAGE_DIRECTORIES.every((stage) =>
				existsSync(path.join(COMPILER_TREE, stage)),
			)
		) {
			return []
		}

		for (let entry of readdirSync(COMPILER_TREE, {
			recursive: true,
			withFileTypes: true,
		})) {
			if (!entry.isFile()) {
				continue
			}

			if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".js")) {
				continue
			}

			let filePath = path.join(entry.parentPath, entry.name)
			let segments = path
				.relative(COMPILER_TREE, filePath)
				.split(path.sep)

			if (!segments.includes("tests")) {
				found.push(filePath)
			}
		}
	} catch {
		return []
	}

	return found.sort()
}

// Length-prefixed, so no two sequences of parts spell the same bytes.
function mix(hash: Hash, text: string): void {
	hash.update(`${text.length}:${text}`)
}
