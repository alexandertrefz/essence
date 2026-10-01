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

// The Compiler keeps the enriched standard library and its prelude between
// processes, written with `v8.serialize` under a key naming their inputs. These
// specs hold that a snapshot cannot be wrong, not that it is fast. A snapshot
// answers only for what it was taken of, and an unreadable file means building.
// A restored library emits the same bytes as a built one.

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
	// On macOS `mkdtempSync` answers under `/var/folders/…`, a symlink to
	// `/private/var/folders/…`, so the directory is canonicalised first.
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

// The fields of a Snapshot that most specs do not care about. Each spec names
// its own `build`.
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

	// A word in the same variable turns the cache off. A bisect can then
	// compare cached and uncached runs without changing the command line.
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
			// A process reading a snapshot shares nothing with the one that wrote it.
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

	// An unreadable file means there is nothing to read. The rebuilt value
	// replaces it.
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

	// The key changes with every edit to the Compiler, so without a bound a
	// development session would pile up dead snapshots.
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

	// A reader sees no file or the whole of one. Each writer renames its own
	// temporary file into place, which is atomic within a directory.
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
	// The claim the snapshot rests on. A restored library shares no object
	// identity with the built one, and must still emit the same bytes.
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

	// A library a spec installed is not the one the snapshot key names, so its
	// prelude is built rather than read. The real library's snapshot would
	// otherwise answer for it, since the two have the same shape.
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

		// Putting the real library back restores its identity, so a spec that
		// swaps a library has nothing to undo.
		expect(loadStdlib()).toBe(real)
		expect(isCanonicalStdlib(loadStdlib())).toBe(true)
	})
})
