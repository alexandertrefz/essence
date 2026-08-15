import { stat } from "node:fs/promises"
import * as path from "node:path"

import {
	cacheDirectory as cacheDirectoryFor,
	writeAtomic,
} from "@essence-lang/compiler/cache"

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

// NOTE: Where a host asks for the cache to live — `ESSENCE_CLIENT_CACHE`. Set
// it to a directory inside a build's own output and the bundles travel with
// that build; leave it and they land beside every other program's caches.
//
// NOTE: The rules are the Compiler's, in `@essence-lang/compiler/cache`, so
// that the toolchain has ONE answer to where a user's caches are — this package
// asks for the `client` area of it. Unlike the Compiler's own snapshots there
// is no way to turn this off: a bundle has to become a file before `import()`
// can reach it, so there is nothing here to fall back to.
export function cacheDirectory(): string {
	return cacheDirectoryFor("client")
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
// overwritten and the write is atomic — both are the Compiler's rule for a
// content-addressed file, and both matter here in particular: `import()` is
// going to read this file, several processes may be compiling the same sources
// at once, and a Module another process has already imported must not be
// replaced underneath it.
export async function cacheBundle(
	directory: string,
	bundleHash: string,
	code: string,
): Promise<string> {
	let file = bundlePath(directory, bundleHash)

	await writeAtomic(file, code)

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
