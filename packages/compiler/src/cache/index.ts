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

// NOTE: Where everything the toolchain keeps on disk between runs lives, and
// the rules that decide how it gets there — the platform's cache location, the
// atomic write, and what the Compiler has to say about itself for a key to be
// able to notice an edit to it. All three are asked by more than one thing: the
// Compiler keeps snapshots of what it would otherwise rebuild in every process,
// `esc` keeps the bundles it emitted, and the JavaScript client keeps the ones
// it compiled. Two copies of "where does a cache go" is two answers a user's
// `ESSENCE_*_CACHE` could stop agreeing with.
//
// NOTE: It lives in the COMPILER rather than in a package of its own because
// the client already depends on the Compiler and nothing depends on the client
// — the one placement that leaves both able to reach it without a cycle, and
// without a fourteenth package whose whole content is this file.

// NOTE: The area is the leaf directory AND the name of the variable that moves
// it: `compiler` is `ESSENCE_COMPILER_CACHE`, `client` is
// `ESSENCE_CLIENT_CACHE`. Derived rather than passed beside it, so the name a
// user types can not drift away from the directory it moves.
export function cacheVariable(area: string): string {
	return `ESSENCE_${area.toUpperCase()}_CACHE`
}

// NOTE: The words that turn a cache OFF rather than move it, spelled into the
// same variable. There is one escape hatch per area and no flag anywhere,
// because what a user wants when they reach for this is not an option their
// build has to carry — it is one run compared against another, which is what a
// bisect and this task's differential both need.
const DISABLING_WORDS = new Set(["0", "off", "false", "no"])

// NOTE: Asked only by a cache that CAN be turned off. The client's can not: a
// compiled bundle has to become a file before `import()` can reach it, so there
// is nothing there to fall back to and nothing to ask.
export function isCacheDisabled(area: string): boolean {
	let override = process.env[cacheVariable(area)]

	return override !== undefined && DISABLING_WORDS.has(override.toLowerCase())
}

// NOTE: The platform's own cache location rather than `~/.cache` everywhere:
// these are regenerable files, and a directory the operating system already
// knows to be regenerable is one its backups and its cleaners handle correctly.
export function cacheDirectory(area: string): string {
	let override = process.env[cacheVariable(area)]

	// NOTE: A disabling word is not a place, so it is not read as one — an area
	// that ignores `isCacheDisabled` keeps the directory it would have had
	// rather than filling one named `off`.
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

// NOTE: A name beside the file it is going to become, carrying the process and
// a random suffix — so that two processes racing on the same entry write to two
// different temporary files rather than to one. Beside it rather than in the
// system temporary directory because `rename` is only atomic WITHIN a file
// system, and the two are routinely different mounts.
export function temporaryPath(file: string): string {
	return `${file}.${process.pid}.${randomBytes(6).toString("hex")}`
}

// NOTE: Written to a private temporary name and RENAMED into place. Several
// processes may be filling the same entry at once, and `rename` is atomic
// within a directory — so a reader sees either no file or the whole of one,
// never the half of one another process is still writing, which comes back as
// a deserialisation failure out of nowhere.
//
// NOTE: A failure to write is not a failure to compile. Everything written
// through here can be rebuilt from source, so a read-only cache directory, a
// full disk, or a rename another process won the race for are all reasons to
// have no cache rather than reasons to stop.
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

// NOTE: The same rule for a caller that can not swallow the failure. A
// CONTENT-ADDRESSED file is written through here: its name is the hash of
// everything it holds, so a file already sitting there holds these exact bytes
// already and `replace` stays off — rewriting it would only invalidate the
// Module every process that has already imported it is holding. `replace` is
// for the one entry that is a scratch file rather than a remembered answer:
// `esc run`'s bundle with the cache turned off, which has to be this run's
// bytes and can not be left as an older run's.
//
// NOTE: Answers whether THIS call put the bytes there, which is what a caller
// pruning after a write needs and a caller that only wants the file to exist
// can ignore.
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
		// NOTE: Windows refuses a rename onto an existing file, and the loser of
		// a race is exactly that case — the winner's file is the same bytes, so
		// losing is success. Anything else is a real failure and is re-thrown
		// once the temporary file is gone.
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

// NOTE: What the Compiler's own CODE is, by content — the one thing a cache key
// needs that `toolchainKey` deliberately leaves out. That key mixes the
// Compiler's version, the standard library's `.es` text and the runtime's
// TypeScript, and says at its own definition what it leaves out and why: the
// Compiler's sources, three megabytes re-read by every process, to catch a case
// only somebody editing the Compiler is in.
//
// For a bundle a HOST caches that trade is right; the loser rebuilds by
// emptying a cache directory. For anything a Compiler developer runs it is not,
// because the Compiler's own sources are exactly what SHAPES the answer: edit
// the Enricher and the enriched standard library is a different object, edit the
// Rewriter and the same sources emit different JavaScript — with no version
// bump, no `.es` file touched, and therefore no change in `toolchainKey()`. The
// stale answer would be served, the edit would have no effect, and the developer
// would be debugging a compiler that is not the one they are editing. No escape
// hatch is an acceptable answer to that: a hatch protects whoever remembers, and
// this is a trap for whoever does not.
//
// NOTE: Measured at about three milliseconds, and paid on files the process has
// already read to be running at all — the import graph reaches nearly every one
// of them, so the read is out of the page cache. Content rather than
// size-and-modification-time, which would be five times cheaper again, because
// the answer has to be exact in the one direction that matters and because an
// edit reverted is then a HIT rather than a rebuild.
//
// NOTE: Read once per process and kept. Nothing here can change under a running
// compile in a way this is meant to notice.
let fingerprint: string | null = null

export function compilerFingerprint(): string {
	fingerprint ??= digestCompiler()

	return fingerprint
}

// NOTE: The Compiler's own module tree — `src/` in a workspace checkout,
// `dist/` in a compiled package. This module sits in `cache/` inside it either
// way, so the tree is its parent and nothing has to be told where the Compiler
// is.
const COMPILER_TREE = path.resolve(import.meta.dirname, "..")

// NOTE: Two of the stage directories, as proof that the tree above IS the
// Compiler's. Bundled into one file — the Language Server inside the VS Code
// extension is — this module's directory is wherever that file was written, so
// the "tree" is the extension itself; walking it would fingerprint an icon set
// and a pair of `.vsix` archives, and would recurse through whatever else is
// there. A bundle has neither directory beside it.
const STAGE_DIRECTORIES = ["enricher", "rewriter"]

function digestCompiler(): string {
	let hash = createHash("sha256")
	let files = compilerSources()

	// NOTE: A Compiler with no tree to walk is one bundled into a single file,
	// and a single file is an immutable artifact: its size and modification time
	// name it exactly, because nothing edits a bundle in place — a bundle is
	// replaced.
	if (files.length === 0) {
		try {
			let bundle = statSync(import.meta.filename)

			mix(hash, `${bundle.size}:${bundle.mtimeMs}`)
		} catch {
			// NOTE: Neither a tree nor a file to stat is a Compiler that can not
			// say what it is. The empty digest is what a caller refuses to key
			// on, rather than a key that means nothing.
			return ""
		}

		return hash.digest("hex")
	}

	// NOTE: Named relative to the tree, so that the same Compiler installed
	// under two prefixes fingerprints the same — the rule `toolchainKey` follows
	// for the standard library's file names, for the same reason.
	for (let filePath of files) {
		mix(hash, path.relative(COMPILER_TREE, filePath))
		mix(hash, readFileSync(filePath, "utf8"))
	}

	// NOTE: And the interfaces the Compiler is written against, under their own
	// prefix. They are the shape of everything a cache serialises — a Type, a
	// typed Node — and a field added there and populated here reaches a cached
	// artifact from both packages at once, so a key that read only one of them
	// would hold its promise by coincidence: an edit confined to the interfaces
	// would leave the Compiler's own digest standing. Nearly every such edit is
	// a type alone and shapes nothing at run time, which is why this costs one
	// rebuild once and not a slower key.
	for (let [name, filePath] of interfacesSources()) {
		mix(hash, `interfaces/${name}`)
		mix(hash, readFileSync(filePath, "utf8"))
	}

	return hash.digest("hex")
}

// NOTE: Where `@essence-lang/interfaces` resolves to — `src/` in a workspace
// checkout, `dist/` in a compiled package — or nowhere, for a Compiler bundled
// into a single file, whose interfaces are inside that file and are named by
// its size and modification time above. Resolved rather than reached by a
// relative path, because the two packages sit beside each other in a checkout
// and under `node_modules` in an install, and only the resolver knows which.
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

// NOTE: Reached only past the bundle check above — a bundle has no tree of
// either kind, and its stat already names the interfaces inside it.
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

// NOTE: Sorted, so the digest does not depend on the order a file system
// happens to enumerate a directory in.
//
// NOTE: A `tests` directory anywhere in the tree is left out. A spec can not
// shape what the Compiler produces — nothing outside a spec imports one — and a
// session spent writing specs would otherwise invalidate every key on every
// save, which is the one way to make a cache cost more than it saves.
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

// NOTE: Length-prefixed, exactly as `embed/hash.ts` mixes, so that no two
// different sequences of parts can spell the same bytes.
function mix(hash: Hash, text: string): void {
	hash.update(`${text.length}:${text}`)
}
