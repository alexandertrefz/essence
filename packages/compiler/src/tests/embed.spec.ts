import { describe, expect, it } from "bun:test"
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

import { fixturePath } from "@essence-lang/fixtures"

import { compileToMemory } from "../embed/index"
import { unoptimisedOptions } from "../optimiser/index"

// NOTE: A project on disk, in a directory of its own that is removed again —
// the same shape `modules.spec.ts` builds its graphs in, because what is under
// test here also begins with a path somebody handed over.
async function withProject<Result>(
	files: Record<string, string>,
	work: (directory: string) => Promise<Result>,
): Promise<Result> {
	let directory = mkdtempSync(path.join(tmpdir(), "essence-embed-"))

	try {
		for (let [name, source] of Object.entries(files)) {
			let filePath = path.join(directory, name)

			mkdirSync(path.dirname(filePath), { recursive: true })
			writeFileSync(filePath, source)
		}

		// NOTE: `mkdtempSync` answers under `/var/folders/…` on macOS, which is a
		// symlink to `/private/var/folders/…`, so the directory is canonicalised
		// before anything is built out of it.
		return await work(realpathSync.native(directory))
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

// NOTE: The fixture Program prints three lines as it runs, and importing the
// bundle is what runs it. Both doors are held: `print` writes to the stream,
// `inspect` ends its line through `console.log`, and a harness holding one of
// the two reads half a Program as silent.
async function importBundle(
	code: string,
	directory: string,
	name: string = "bundle.mjs",
): Promise<{ module: Record<string, unknown>; written: string }> {
	let file = path.join(directory, name)

	writeFileSync(file, code)

	let written = ""
	let originalLog = console.log
	let originalOut = process.stdout.write

	console.log = (...args: Array<unknown>) => {
		written += `${args.map((argument) => String(argument)).join(" ")}\n`
	}

	process.stdout.write = ((chunk: unknown) => {
		written += String(chunk)

		return true
	}) as typeof process.stdout.write

	try {
		return {
			module: (await import(pathToFileURL(file).href)) as Record<
				string,
				unknown
			>,
			written,
		}
	} finally {
		console.log = originalLog
		process.stdout.write = originalOut
	}
}

describe("Compiling To Memory", () => {
	it("compiles a Module graph without writing anything", async () => {
		let result = await compileToMemory(fixturePath("modules", "Main.es"))

		expect(result.diagnostics).toEqual([])
		expect(result.code).not.toBe("")
		// NOTE: The whole answer to "what does this Module offer", which is what
		// a host binds its own names off. `Rectangle` is a Type Alias AND the
		// Namespace of the same name, and one entry carries both — the kind is
		// what it was DECLARED as, not a promise that nothing is emitted for it.
		expect(result.surface.kinds).toEqual({
			describe: "function",
			Rectangle: "type",
		})
		expect(Object.keys(result.surface.values).sort()).toEqual([
			"Rectangle",
			"describe",
		])
		expect(Object.keys(result.surface.types)).toEqual(["Rectangle"])
	})

	// NOTE: The map rides inside the bundle rather than beside it, because a
	// host is handed one string and a map it can not reach is a stack trace it
	// can not read.
	it("carries its source map inside the bundle", async () => {
		let result = await compileToMemory(fixturePath("modules", "Main.es"))

		expect(result.code).toContain(
			"//# sourceMappingURL=data:application/json;base64,",
		)
	})

	it("produces a bundle that runs and exports what the surface names", async () => {
		let result = await compileToMemory(fixturePath("modules", "Main.es"))

		await withProject({}, async (directory) => {
			let { module, written } = await importBundle(result.code, directory)

			expect(written.trimEnd().split("\n")).toEqual([
				"area: 12",
				"25",
				"157/1",
			])
			expect(typeof module.describe).toBe("function")
		})
	})

	// NOTE: The seam a host injects JavaScript of its own through. A bridge
	// Module re-exporting the real entry is what the client is going to need, so
	// that is what is built here rather than a token nothing would do.
	it("lets a caller rewrite the Modules before they are bundled", async () => {
		let bridge = "essence:$bridge"
		let result = await compileToMemory(fixturePath("modules", "Main.es"), {
			transformSources: (sources) => ({
				entry: bridge,
				sources: new Map([
					...sources.sources,
					[
						bridge,
						`export * from "${sources.entry}"\n` +
							"export const bridged = 42\n",
					],
				]),
			}),
		})

		expect(result.diagnostics).toEqual([])

		await withProject({}, async (directory) => {
			let { module } = await importBundle(
				result.code,
				directory,
				"bridged.mjs",
			)

			expect(module.bridged).toBe(42)
			expect(typeof module.describe).toBe("function")
		})
	})

	it("answers a type error with Diagnostics and no code", async () => {
		await withProject(
			{
				"Broken.es": `implementation {
	function twice(_ value: Integer) -> Integer {
		<- value::multiply(with "two")
	}
}

export {
	twice
}
`,
			},
			async (directory) => {
				let result = await compileToMemory(
					path.join(directory, "Broken.es"),
				)

				expect(result.code).toBe("")
				expect(
					result.diagnostics.map((diagnostic) => diagnostic.severity),
				).toContain("error")
				expect(result.sourceHash).not.toBe("")
			},
		)
	})

	it("answers a file it can not read with a Diagnostic", async () => {
		await withProject({}, async (directory) => {
			let result = await compileToMemory(path.join(directory, "None.es"))

			expect(result.code).toBe("")
			expect(
				result.diagnostics.map((diagnostic) => diagnostic.code),
			).toEqual(["module-not-found"])
			expect(result.surface.kinds).toEqual({})
		})
	})

	describe("Source Hash", () => {
		it("is the same for the same sources and changes with them", async () => {
			let sources = {
				"Main.es": `import {
	value from "./Dep.es"
}

implementation {
	Terminal.print(value::toString())
}
`,
				"Dep.es": `implementation {
	constant value = 1
}

export {
	value
}
`,
			}

			let hashes = await withProject(sources, async (directory) => {
				let entry = path.join(directory, "Main.es")
				let first = await compileToMemory(entry)
				let again = await compileToMemory(entry)

				// NOTE: A DEPENDENCY's text counts as much as the entry's: the
				// whole graph is what the bundle was derived from.
				writeFileSync(
					path.join(directory, "Dep.es"),
					sources["Dep.es"].replace("= 1", "= 2"),
				)

				return {
					first: first.sourceHash,
					again: again.sourceHash,
					edited: (await compileToMemory(entry)).sourceHash,
				}
			})

			expect(hashes.again).toBe(hashes.first)
			expect(hashes.edited).not.toBe(hashes.first)

			// NOTE: The same sources in another directory hash differently on
			// purpose — the paths are part of what was compiled, so a cache
			// keyed by this is keyed to a place on disk rather than to a text.
			let elsewhere = await withProject(sources, (directory) =>
				compileToMemory(path.join(directory, "Main.es")),
			)

			expect(elsewhere.sourceHash).not.toBe(hashes.first)
		})

		it("separates two sets of Optimiser Options", async () => {
			let entry = fixturePath("modules", "Main.es")
			let optimised = await compileToMemory(entry)
			let plain = await compileToMemory(entry, {
				optimisation: unoptimisedOptions,
			})

			expect(plain.diagnostics).toEqual([])
			expect(plain.sourceHash).not.toBe(optimised.sourceHash)
		})
	})
})
