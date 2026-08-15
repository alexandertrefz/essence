import { afterEach, describe, expect, it } from "bun:test"
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import * as v8 from "node:v8"

import { fixturePath } from "@essence-lang/fixtures"

import {
	cacheDirectory,
	cacheVariable,
	isCacheDisabled,
	writeAtomicSync,
} from "../cache/index"
import { throughSnapshot } from "../cache/snapshot"
import { compileToMemory } from "../embed/index"
import {
	isCanonicalStdlib,
	loadStdlib,
	type Stdlib,
	useStdlib,
} from "../enricher/stdlib"

// NOTE: What the Compiler keeps between processes: the enriched standard
// library and the prelude derived from it, each written whole with
// `v8.serialize` under a key that names everything it was built from. What is
// tested here is not that it is faster — that is measured, not asserted — but
// that it can not be WRONG: a snapshot answers only for the value it was taken
// of, anything unreadable falls through to building, and a library restored
// from disk emits the same bytes the one built from source does.

const VARIABLE = cacheVariable("compiler")

let previousOverride = process.env[VARIABLE]

afterEach(() => {
	if (previousOverride === undefined) {
		delete process.env[VARIABLE]
	} else {
		process.env[VARIABLE] = previousOverride
	}
})

function withCacheDirectory<Result>(
	work: (directory: string) => Result,
): Result {
	// NOTE: `mkdtempSync` answers under `/var/folders/…` on macOS, which is a
	// symlink to `/private/var/folders/…`, so the directory is canonicalised
	// before anything is written into it.
	let directory = realpathSync.native(
		mkdtempSync(path.join(tmpdir(), "essence-snapshot-")),
	)

	process.env[VARIABLE] = directory

	try {
		return work(directory)
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

// NOTE: The two halves of a Snapshot that say nothing about what is under test
// — every case here names its own `build`, and only the two that are about
// keying or about validation say more.
const anyShape = { kind: "spec", variant: "", isValid: () => true }

function snapshotsIn(directory: string): Array<string> {
	return readdirSync(directory)
		.filter((name) => name.endsWith(".v8"))
		.sort()
}

describe("The Cache Directory", () => {
	it("answers under the directory the area's own variable names", () => {
		process.env[VARIABLE] = "/tmp/essence-cache-spec"

		expect(cacheDirectory("compiler")).toBe("/tmp/essence-cache-spec")
		expect(cacheVariable("client")).toBe("ESSENCE_CLIENT_CACHE")
	})

	// NOTE: The escape hatch is a word in the same variable rather than a flag,
	// so a bisect can compare a cached run against an uncached one without the
	// command line changing.
	it("reads a disabling word as off rather than as a place", () => {
		for (let word of ["0", "off", "false", "no", "OFF"]) {
			process.env[VARIABLE] = word

			expect(isCacheDisabled("compiler")).toBe(true)
			expect(cacheDirectory("compiler")).not.toBe(word)
		}

		process.env[VARIABLE] = "/tmp/essence-cache-spec"

		expect(isCacheDisabled("compiler")).toBe(false)
	})
})

describe("Snapshots", () => {
	it("builds once and reads the answer back", () => {
		withCacheDirectory((directory) => {
			let builds = 0
			let build = () => {
				builds += 1

				return { value: [1, 2, 3], named: new Map([["a", 1]]) }
			}

			let first = throughSnapshot({ ...anyShape, build })

			expect(builds).toBe(1)
			expect(snapshotsIn(directory)).toHaveLength(1)

			let second = throughSnapshot({ ...anyShape, build })

			expect(builds).toBe(1)
			expect(second).toEqual(first)
			// NOTE: A fresh object graph, which is the whole point — a process
			// that reads a snapshot shares nothing with the one that wrote it.
			expect(second).not.toBe(first)
		})
	})

	it("keys a snapshot by its variant", () => {
		withCacheDirectory((directory) => {
			let builds = 0
			let build = () => {
				builds += 1

				return builds
			}

			expect(throughSnapshot({ ...anyShape, variant: "on", build })).toBe(
				1,
			)
			expect(
				throughSnapshot({ ...anyShape, variant: "off", build }),
			).toBe(2)
			expect(throughSnapshot({ ...anyShape, variant: "on", build })).toBe(
				1,
			)
			expect(snapshotsIn(directory)).toHaveLength(2)
		})
	})

	// NOTE: Every way a file can be unreadable means one thing here, which is
	// that there is nothing to read. Building is always available and always
	// correct, and the rebuilt value replaces what could not be read.
	it("builds again when the file on disk is not a snapshot", () => {
		withCacheDirectory((directory) => {
			let builds = 0
			let build = () => {
				builds += 1

				return { built: builds }
			}

			throughSnapshot({ ...anyShape, build })

			let [file] = snapshotsIn(directory)

			writeFileSync(path.join(directory, file!), "not a snapshot")

			expect(throughSnapshot({ ...anyShape, build })).toEqual({
				built: 2,
			})
			expect(
				v8.deserialize(readFileSync(path.join(directory, file!))),
			).toEqual({ built: 2 })
		})
	})

	it("builds again when the snapshot holds the wrong shape", () => {
		withCacheDirectory((directory) => {
			let builds = 0

			throughSnapshot({ ...anyShape, build: () => ({ old: true }) })

			let answer = throughSnapshot({
				kind: "spec",
				variant: "",
				isValid: (value) => Object.hasOwn(value as object, "current"),
				build: () => {
					builds += 1

					return { current: true }
				},
			})

			expect(builds).toBe(1)
			expect(answer).toEqual({ current: true })
			expect(snapshotsIn(directory)).toHaveLength(1)
		})
	})

	it("writes nothing at all when the cache is turned off", () => {
		withCacheDirectory((directory) => {
			process.env[VARIABLE] = "off"

			let builds = 0

			throughSnapshot({ ...anyShape, build: () => (builds += 1) })
			throughSnapshot({ ...anyShape, build: () => (builds += 1) })

			expect(builds).toBe(2)
			expect(snapshotsIn(directory)).toEqual([])
		})
	})

	// NOTE: The key changes on every edit to the Compiler, so without this a
	// development session would leave a megabyte of dead snapshots behind per
	// edit, forever, in a directory nobody ever opens.
	it("keeps a bounded number of snapshots of one kind", () => {
		withCacheDirectory((directory) => {
			for (let index = 0; index < 12; index++) {
				throughSnapshot({
					...anyShape,
					variant: `${index}`,
					build: () => index,
				})
			}

			expect(snapshotsIn(directory).length).toBeLessThanOrEqual(4)
		})
	})

	// NOTE: A reader must see either no file or the whole of one. The temporary
	// name carries the process id and a random suffix so that two processes
	// racing on the same entry write two files, and the rename that follows is
	// atomic within the directory.
	it("never leaves a partially written file behind to be read", () => {
		withCacheDirectory((directory) => {
			let file = path.join(directory, "written.v8")

			writeAtomicSync(file, v8.serialize({ whole: true }))

			expect(readdirSync(directory)).toEqual(["written.v8"])
			expect(v8.deserialize(readFileSync(file))).toEqual({ whole: true })
		})
	})
})

describe("A Restored Standard Library", () => {
	// NOTE: The claim the whole snapshot rests on. The Compiler is handed a
	// library it did not build — a fresh object graph carrying no identity the
	// one it replaced had — and what it emits has to be the same bytes under the
	// same name, or the cache has changed the answer.
	it("emits the same bundle the built one does", async () => {
		let entry = fixturePath("Everyday.es")
		let built = await compileToMemory(entry)

		let clone = v8.deserialize(v8.serialize(loadStdlib())) as Stdlib
		let previous = useStdlib(clone)

		try {
			let restored = await compileToMemory(entry)

			expect(restored.code).toBe(built.code)
			expect(restored.bundleHash).toBe(built.bundleHash)
			expect(restored.diagnostics).toEqual([])
		} finally {
			useStdlib(previous)
		}
	})

	// NOTE: A library a test wrote itself is not the one the snapshot key names,
	// so the prelude derived from it is built rather than read. Without this the
	// snapshot of the REAL library would answer for a synthetic one — silently,
	// because the two are the same shape.
	it("is told apart from a library installed over it", () => {
		let real = loadStdlib()
		let clone = v8.deserialize(v8.serialize(real)) as Stdlib
		let previous = useStdlib(clone)

		try {
			expect(loadStdlib()).toBe(clone)
			expect(isCanonicalStdlib(clone)).toBe(false)
			expect(isCanonicalStdlib(real)).toBe(true)
		} finally {
			useStdlib(previous)
		}

		// NOTE: Putting the real library back restores the identity with it —
		// there is nothing to undo, which is what keeps a spec that swaps a
		// library from having to know this exists.
		expect(loadStdlib()).toBe(real)
		expect(isCanonicalStdlib(loadStdlib())).toBe(true)
	})
})
