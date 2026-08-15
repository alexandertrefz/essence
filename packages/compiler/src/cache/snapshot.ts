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

// NOTE: A snapshot is a whole in-memory value written to disk with
// `v8.serialize`, so that a process which would otherwise BUILD it reads it
// instead. Two things in the Compiler are built identically by every process
// that starts and are expensive enough to be most of what a small compile
// costs: the enriched standard library, and the simplified-and-optimised
// prelude derived from it. Neither depends on the user's Program at all.
//
// NOTE: `v8.serialize` rather than JSON because these graphs hold Sets and Maps
// and shared sub-objects, and because it is an order of magnitude faster in
// both directions — a snapshot deserialises in under two milliseconds against
// the seventy the standard library takes to enrich.
//
// NOTE: Nothing here can make an answer wrong and nothing here can stop a
// compile. Every read is a guess that is checked, every failure falls through
// to building from source, and a value that was built is offered back to disk
// on the way out. The one thing that WOULD make an answer wrong is a key that
// does not change when the answer would — which is what the fingerprint below
// exists for.

const AREA = "compiler"

// NOTE: In the name, so a format change can not be read back as the shape it
// replaced. The Compiler fingerprint below already covers that — this file is
// one of the sources it digests — so this is belt to that braces, and the one
// signal that survives a Compiler shipped as a bundle whose fingerprint is
// coarser.
const FORMAT = "essence-snapshot-1"

// NOTE: How many snapshots of one kind are kept. The key changes on every edit
// to the Compiler, so a development session would otherwise leave a megabyte of
// dead snapshots behind per edit, forever, in a directory nobody ever looks in.
// More than one is kept because more than one is LIVE: the prelude is keyed by
// the Optimiser Options too, and a test suite that turns a pass off and on
// again wants both, not each evicting the other.
const KEPT_PER_KIND = 4

// NOTE: Length-prefixed, exactly as `embed/hash.ts` mixes, so that no two
// different sequences of parts can spell the same bytes.
function mix(hash: Hash, text: string): void {
	hash.update(`${text.length}:${text}`)
}

// NOTE: What a snapshot is OF, in one name: the format, what the toolchain
// compiles from and by, what the Compiler's own code is, and whatever the kind
// adds — the Optimiser Options, for the prelude.
//
// NOTE: `toolchainKey()` is deliberately not enough on its own — it says
// nothing about the Compiler's own code, and a snapshot is SHAPED by it: edit
// the Enricher and the enriched standard library is a different object, edit a
// pass and the prelude is different code, with no version bump and no `.es`
// file touched. `compilerFingerprint()` is the half that notices, and says at
// its own definition what it costs and why there is no escape hatch from it.
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

// NOTE: Off when the user says so, and off when the Compiler could not say what
// it is — a key that can not tell two Compilers apart is worse than no key.
function isEnabled(): boolean {
	return !isCacheDisabled(AREA) && compilerFingerprint() !== ""
}

export type Snapshot<Value> = {
	// NOTE: The leading half of the file name, and the unit the prune below
	// counts in — one kind is one thing being remembered.
	kind: string
	// NOTE: What else the value depends on, beyond the toolchain and the
	// Compiler's own code. The prelude's Optimiser Options are the only one.
	variant: string
	// NOTE: Not optional. What comes back is bytes some other process wrote, and
	// `v8.deserialize` will happily answer with an object of the wrong shape
	// rather than throwing — a file truncated by a full disk that deserialises
	// anyway, a snapshot from a Compiler whose fingerprint somehow collided. A
	// kind that can not say what its own value looks like has no business
	// trusting one off disk.
	isValid: (value: unknown) => boolean
	build: () => Value
}

// NOTE: What a caller does with a snapshot: ask for one, and if there is none,
// build the value and hand it back to be written. Both halves are one call so
// that no caller can key the read and the write differently, and so that the
// guard, the failure handling and the pruning are in one place rather than at
// every kind.
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
		// NOTE: No file, a half-written one, bytes a different V8 wrote — every
		// one of them means the same thing here, which is that there is nothing
		// to read. Building is always available and always correct.
	}

	let value = build()

	try {
		writeAtomicSync(file, v8.serialize(value))
		prune(kind, file)
	} catch {
		// NOTE: A value holding something `v8.serialize` refuses — a Function
		// reached a shape that used to be plain data — is a snapshot that can
		// not be taken, and the caller already has its answer. It is caught
		// rather than left to throw so that the day somebody puts a Function in
		// the Enricher's output is a day the cache stops working, not a day the
		// Compiler stops.
	}

	return value
}

// NOTE: Only ever after a write, so a process that finds what it came for
// touches no directory but its own file. Failure is ignored throughout:
// Windows refuses to unlink a file another process has open, and a snapshot
// that outlives its welcome costs disk rather than correctness.
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
		// NOTE: Nothing pruned is nothing wrong.
	}
}
