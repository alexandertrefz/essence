import { randomBytes } from "node:crypto"
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// NOTE: Where everything the toolchain keeps on disk between runs lives, and
// the two rules that decide how it gets there — the platform's cache location
// and the atomic write. Both are asked by more than one thing: the Compiler
// keeps snapshots of what it would otherwise rebuild in every process, and the
// JavaScript client keeps the bundles it compiled. Two copies of "where does a
// cache go" is two answers a user's `ESSENCE_*_CACHE` could stop agreeing with.
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
