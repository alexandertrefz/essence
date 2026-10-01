import { createHash, type Hash } from "node:crypto"
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import * as path from "node:path"
import * as v8 from "node:v8"

import { toolchainKey } from "../embed/hash"
import {
	cacheDirectory,
	compilerFingerprint,
	isCacheDisabled,
	writeAtomicSync,
} from "./index"

// A snapshot is a whole value written to disk with `v8.serialize`, so that a
// process reads it instead of building it. A snapshot can neither make an
// answer wrong nor stop a compile. See "Snapshots" in DEVELOPMENT.md.

const AREA = "compiler"

// In the key, so a changed format is never read back as the old one, even
// where the compiler's fingerprint is coarse.
const FORMAT = "essence-snapshot-2"

// More than one, since the prelude is keyed by the optimiser options and a
// test suite uses several at once.
const KEPT_PER_KIND = 4

// Length-prefixed, so no two sequences of parts spell the same bytes.
function mix(hash: Hash, text: string): void {
	hash.update(`${text.length}:${text}`)
}

// The compiler's own code shapes a snapshot, so `compilerFingerprint` joins
// `toolchainKey`. See "The compiler fingerprint" in DEVELOPMENT.md.
function snapshotKey(kind: string, variant: string): string {
	let hash = createHash("sha256")

	mix(hash, FORMAT)
	mix(hash, kind)
	mix(hash, toolchainKey())
	mix(hash, compilerFingerprint())
	mix(hash, variant)

	return hash.digest("hex")
}

function snapshotPath(kind: string, key: string): string {
	return path.join(cacheDirectory(AREA), `${kind}-${key}.v8`)
}

// Off as well when the compiler has no fingerprint, since that key could not
// tell two compilers apart.
function isEnabled(): boolean {
	return !isCacheDisabled(AREA) && compilerFingerprint() !== ""
}

export type Snapshot<Value> = {
	// The leading half of the file name, and the unit `prune` counts in.
	kind: string
	// What the value depends on beyond the toolchain and the compiler's code.
	variant: string
	// Required, since `v8.deserialize` can answer a truncated file with an
	// object of the wrong shape rather than throwing.
	isValid: (value: unknown) => boolean
	build: () => Value
}

// Reads the snapshot, or builds the value and writes it. One call does both so
// that no caller keys the read and the write differently.
export function throughSnapshot<Value>({
	kind,
	variant,
	isValid,
	build,
}: Snapshot<Value>): Value {
	if (!isEnabled()) {
		return build()
	}

	let key = snapshotKey(kind, variant)
	let file = snapshotPath(kind, key)

	try {
		let restored: unknown = v8.deserialize(readFileSync(file))

		if (isValid(restored)) {
			return restored as Value
		}
	} catch {
		// Any failure to read means building, which is always correct.
	}

	let value = build()

	try {
		writeAtomicSync(file, v8.serialize(value))
		prune(kind, file)
	} catch {
		// A value `v8.serialize` refuses, such as one holding a Function, is
		// not stored. The caller already has its answer.
	}

	return value
}

// Only after a write, so a process that finds its snapshot touches nothing
// else. Failures are ignored, since Windows refuses to delete an open file.
function prune(kind: string, keep: string): void {
	try {
		let directory = cacheDirectory(AREA)
		let dated = readdirSync(directory)
			.filter(
				(name) => name.startsWith(`${kind}-`) && name.endsWith(".v8"),
			)
			.map((name) => path.join(directory, name))
			.filter((file) => file !== keep)
			.map((file) => ({ file, modified: statSync(file).mtimeMs }))
			.sort((left, right) => right.modified - left.modified)

		for (let { file } of dated.slice(KEPT_PER_KIND - 1)) {
			rmSync(file, { force: true })
		}
	} catch {
		// A file left behind costs disk, not correctness.
	}
}
