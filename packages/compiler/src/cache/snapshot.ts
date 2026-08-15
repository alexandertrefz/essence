import { createHash, type Hash } from "node:crypto"
import {
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs"
import * as path from "node:path"
import * as v8 from "node:v8"

import { toolchainKey } from "../embed/hash"
import { cacheDirectory, isCacheDisabled, writeAtomicSync } from "./index"

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
// NOTE: `toolchainKey()` is deliberately not enough on its own, and this is the
// one place in the toolchain where that matters. It mixes the Compiler's
// VERSION, the standard library's `.es` text and the runtime's TypeScript — and
// says so at its own definition, where it also says what it leaves out and why:
// the Compiler's own sources, three megabytes re-read by every process, to
// catch a case only somebody editing the Compiler is in. For a BUNDLE that
// trade is right; the loser rebuilds a bundle by emptying a cache directory.
//
// For these snapshots it is not, because the Compiler's own sources are exactly
// what SHAPES them. Edit the Enricher and the enriched standard library is a
// different object; edit a pass and the prelude is different code — with no
// version bump, no `.es` file touched, and therefore no change in
// `toolchainKey()`. The snapshot would be read back, the edit would have no
// effect, and the compiler developer would be debugging a compiler that is not
// the one they are editing. That is the cache making the toolchain WRONG, and
// no escape hatch is an acceptable answer to it: a hatch protects whoever
// remembers, and this is a trap for whoever does not.
//
// So the Compiler's own code is fingerprinted here, by CONTENT. Measured at
// about three milliseconds against the hundred and ten these snapshots save,
// and paid on files the process has already read to be running at all — the
// import graph reaches nearly every one of them, so the read is out of the page
// cache. Content rather than size-and-modification-time, which would be five
// times cheaper again, because the answer has to be exact in the one direction
// that matters and because an edit reverted is then a HIT rather than a rebuild.
function snapshotKey(kind: string, variant: string): string {
	let hash = createHash("sha256")

	mix(hash, FORMAT)
	mix(hash, kind)
	mix(hash, toolchainKey())
	mix(hash, compilerFingerprint())
	mix(hash, variant)

	return hash.digest("hex")
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

// NOTE: Read once per process and kept, for the reason `toolchainKey` keeps
// its own: nothing here can change under a running compile in a way this is
// meant to notice.
let fingerprint: string | null = null

function compilerFingerprint(): string {
	fingerprint ??= digestCompiler()

	return fingerprint
}

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
			// say what it is, and a snapshot keyed on nothing is the stale one
			// this whole function exists to refuse. The empty digest turns the
			// cache off rather than answering under a key that means nothing.
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

	return hash.digest("hex")
}

// NOTE: Sorted, so the digest does not depend on the order a file system
// happens to enumerate a directory in.
//
// NOTE: A `tests` directory anywhere in the tree is left out. A spec can not
// shape what the Compiler produces — nothing outside a spec imports one — and a
// session spent writing specs would otherwise invalidate the snapshot on every
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
