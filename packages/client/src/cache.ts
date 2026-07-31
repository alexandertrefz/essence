import { randomBytes } from "node:crypto"
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

// NOTE: A compiled bundle has to become a FILE before it can be imported —
// `import()` takes a URL, and a data URL loses the identity that makes two loads
// of the same sources the same Module. So the bundle is written, and it is
// written under the hash of everything it was compiled from AND BY: a name that
// can only mean this text, so a file already sitting there is already the answer
// and nothing has to be invalidated, ever.
//
// The "and by" is what makes that last clause true rather than merely
// convenient. The hash covers the Compiler, the standard library, the runtime
// and this package's own bridge — see `bundleHash` on the Compiler's embed
// seam — because a bundle is not a function of the `.es` sources alone, and a
// name that pretended it was would go on answering with the bundle an older
// toolchain wrote long after the upgrade meant to replace it.

// NOTE: Where a host asks for the cache to live. Set it to a directory inside a
// build's own output and the bundles travel with that build; leave it and they
// land beside every other program's caches.
const CACHE_OVERRIDE = "ESSENCE_CLIENT_CACHE"

// NOTE: The platform's own cache location rather than `~/.cache` everywhere:
// these are regenerable files, and a directory the operating system already
// knows to be regenerable is one its backups and its cleaners handle correctly.
export function cacheDirectory(): string {
	let override = process.env[CACHE_OVERRIDE]

	if (override !== undefined && override !== "") {
		return path.resolve(override)
	}

	let xdg = process.env.XDG_CACHE_HOME

	if (xdg !== undefined && xdg !== "") {
		return path.join(xdg, "essence", "client")
	}

	if (process.platform === "darwin") {
		return path.join(os.homedir(), "Library", "Caches", "essence", "client")
	}

	if (process.platform === "win32") {
		let local = process.env.LOCALAPPDATA

		if (local !== undefined && local !== "") {
			return path.join(local, "essence", "client", "Cache")
		}
	}

	return path.join(os.homedir(), ".cache", "essence", "client")
}

// NOTE: `.mjs`, so that Node reads the file as a Module whatever the nearest
// `package.json` in the cache directory's ancestry happens to say.
export function bundlePath(directory: string, bundleHash: string): string {
	return path.join(directory, `${bundleHash}.mjs`)
}

// NOTE: The bundle already on disk, or `null`. Asked BEFORE anything is
// generated — that is what a content-addressed name is for, and a cache that
// only saved the `writeFile` would have saved nothing worth naming.
export async function cachedBundle(
	directory: string,
	bundleHash: string,
): Promise<string | null> {
	let file = bundlePath(directory, bundleHash)

	return (await exists(file)) ? file : null
}

// NOTE: The bundle on disk, written if it is not there yet. Nothing is
// overwritten: the name is the hash of everything it was compiled from and by,
// so a file that exists holds this exact text already, and rewriting it would
// only invalidate the Module every process that has already imported it is
// holding.
//
// NOTE: Written to a private temporary name and RENAMED into place, because
// `import()` is going to read this file and several processes may be compiling
// the same sources at once. `rename` is atomic within a directory, so a reader
// sees either no file or the whole of one — never the half of a bundle another
// process is still writing, which imports as a syntax error out of nowhere.
export async function cacheBundle(
	directory: string,
	bundleHash: string,
	code: string,
): Promise<string> {
	let file = bundlePath(directory, bundleHash)

	if (await exists(file)) {
		return file
	}

	await mkdir(directory, { recursive: true })

	// NOTE: The process and a random suffix, so that two processes racing on the
	// same hash write to two different temporary files rather than to one.
	let temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}`

	await writeFile(temporary, code)

	try {
		await rename(temporary, file)
	} catch (error) {
		// NOTE: Windows refuses a rename onto an existing file, and the loser of
		// a race is exactly that case — the winner's file is the same bytes, so
		// losing is success. Anything else is a real failure and is re-thrown
		// once the temporary file is gone.
		await rm(temporary, { force: true })

		if (!(await exists(file))) {
			throw error
		}
	}

	return file
}

async function exists(file: string): Promise<boolean> {
	try {
		await stat(file)

		return true
	} catch {
		return false
	}
}
