import { stat } from "node:fs/promises"
import * as path from "node:path"

import {
	cacheDirectory as cacheDirectoryFor,
	writeAtomic,
} from "@essence-lang/compiler/cache"

// A bundle must be a file before `import()` can load it, and a data URL would
// make two loads of the same sources two Modules. A bundle is named by the hash
// of its sources and of the toolchain that compiled them. A file already there
// is the answer, and nothing is ever invalidated.

// `ESSENCE_CLIENT_CACHE` moves the cache, for instance into a build's output.
// The rules are the compiler's, in `@essence-lang/compiler/cache`. This cache
// can not be turned off, since `import()` needs a file.
export function cacheDirectory(): string {
	return cacheDirectoryFor("client")
}

// `.mjs`, so Node reads the file as a Module whatever the nearest
// `package.json` says.
export function bundlePath(directory: string, bundleHash: string): string {
	return path.join(directory, `${bundleHash}.mjs`)
}

// The bundle already on disk, or `null`. A caller asks before generating any
// code, which is what the content-addressed name is for.
export async function cachedBundle(
	directory: string,
	bundleHash: string,
): Promise<string | null> {
	let file = bundlePath(directory, bundleHash)

	return (await exists(file)) ? file : null
}

// The bundle on disk, written atomically unless it is there already. Several
// processes may compile the same sources at once, and a file another process
// imported must not be replaced under it.
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
