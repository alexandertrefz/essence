import { describe, expect, it } from "bun:test"
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

import { fixturePath } from "@essence-lang/fixtures"
import { RUNTIME_DIRECTORY } from "@essence-lang/runtime"

import { hashGraph } from "../embed/hash"
import {
	compileToMemory,
	emitToMemory,
	linkToMemory,
	type MemoryEmitResult,
	toolchainKey,
} from "../embed/index"
import { loadModuleGraph } from "../modules/graph"
import { diskModuleHost } from "../modules/host"
import { defaultOptimiserOptions, unoptimisedOptions } from "../optimiser/index"

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

	// NOTE: The whole graph, so a host watching for a reason to compile again
	// watches all of it. The file that changed is rarely the file that was asked
	// for — a bundler plugin registering only the entry would sit still through
	// every edit to what the entry imports.
	it("says which sources it read", async () => {
		let result = await compileToMemory(fixturePath("modules", "Main.es"))

		expect(result.files).toEqual(
			[
				fixturePath("modules", "A.es"),
				fixturePath("modules", "B.es"),
				fixturePath("modules", "Geometry.es"),
				fixturePath("modules", "Main.es"),
				fixturePath("modules", "math", "Math.es"),
			].sort(),
		)
	})

	// NOTE: Present even where the compile stopped, because a host watching for
	// the edit that FIXES a broken Module needs the same list as one watching a
	// working one.
	it("says which sources it read of a Module that does not compile", async () => {
		await withProject(
			{
				"Main.es": `import {
	value from "./Dep.es"
}

implementation {
	constant doubled: String = value
}

export {
	doubled
}
`,
				"Dep.es": `implementation {
	constant value = 1
}

export {
	value
}
`,
			},
			async (directory) => {
				let result = await compileToMemory(
					path.join(directory, "Main.es"),
				)

				expect(result.code).toBe("")
				expect(result.files).toEqual([
					path.join(directory, "Dep.es"),
					path.join(directory, "Main.es"),
				])
			},
		)
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
				expect(result.bundleHash).not.toBe("")
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

	describe("Bundle Hash", () => {
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
					first: first.bundleHash,
					again: again.bundleHash,
					edited: (await compileToMemory(entry)).bundleHash,
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

			expect(elsewhere.bundleHash).not.toBe(hashes.first)
		})

		it("separates two sets of Optimiser Options", async () => {
			let entry = fixturePath("modules", "Main.es")
			let optimised = await compileToMemory(entry)
			let plain = await compileToMemory(entry, {
				optimisation: unoptimisedOptions,
			})

			expect(plain.diagnostics).toEqual([])
			expect(plain.bundleHash).not.toBe(optimised.bundleHash)
		})

		// NOTE: The bundle holds more than the graph does — the standard library
		// is compiled into it, the runtime is inlined into it, and neither is a
		// Module — so a key over the `.es` files alone names a file an older
		// toolchain wrote, and a host caching by that name runs it forever.
		it("carries the toolchain that emitted the bundle", () => {
			let entryPath = fixturePath("modules", "Main.es")
			let parts = {
				entryPath,
				modules: loadModuleGraph(entryPath, diskModuleHost).modules,
				optimisation: defaultOptimiserOptions,
				emitterKey: "",
			}

			expect(toolchainKey()).toMatch(/^[0-9a-f]{64}$/)
			expect(hashGraph(parts)).toBe(
				hashGraph({ ...parts, toolchain: toolchainKey() }),
			)
			expect(
				hashGraph({ ...parts, toolchain: "another-toolchain" }),
			).not.toBe(hashGraph(parts))
		})

		// NOTE: A host that injects a Module of its own — the client's runtime
		// bridge is one — changes the bytes without touching a source. Without
		// this there would be two bundles under one name, and whichever was
		// written first would answer for both.
		it("separates two emitters over one set of sources", async () => {
			let entry = fixturePath("modules", "Main.es")
			let plain = await compileToMemory(entry)
			let injected = await compileToMemory(entry, {
				emitterKey: "a-host-of-its-own",
			})

			expect(injected.diagnostics).toEqual([])
			expect(injected.bundleHash).not.toBe(plain.bundleHash)
		})
	})

	// NOTE: The front half on its own, which is what a host with a cache asks
	// before it decides to emit at all.
	describe("Linking To Memory", () => {
		it("answers with the Export Surface and the same hash a compile would", async () => {
			let entry = fixturePath("modules", "Main.es")
			let linked = linkToMemory(entry)
			let compiled = await compileToMemory(entry)

			expect(linked.diagnostics).toEqual([])
			expect(linked.bundleHash).toBe(compiled.bundleHash)
			expect(Object.keys(linked.surface.kinds).sort()).toEqual(
				Object.keys(compiled.surface.kinds).sort(),
			)
			expect(linked.files).toEqual(compiled.files)
		})

		it("reports what a Module graph that does not link has to say", async () => {
			await withProject(
				{
					"Main.es": `implementation {
	Terminal.print(missing)
}
`,
				},
				async (directory) => {
					let linked = linkToMemory(path.join(directory, "Main.es"))

					expect(
						linked.diagnostics.map((diagnostic) => diagnostic.code),
					).not.toEqual([])
					expect(linked.diagnosticGroups.length).toBeGreaterThan(0)
				},
			)
		})
	})

	// NOTE: The graph as Modules, which is what a host bundler embeds. Everything
	// here is about ONE property: a file's emitted text must be a function of the
	// file and the root, and of nothing else — least of all of which entry the
	// build happened to compile it under.
	describe("Emitting To Memory", () => {
		// NOTE: One file two entries share, reached from two different depths, so
		// that the entry-relative spelling and the root-relative one can not
		// coincide: `../lib/Shape.es` from the one, `./lib/Shape.es` from the
		// other.
		const SHARED = {
			"lib/Shape.es": `implementation {

	choice Shape {
		Circle { radius: Integer },
		Blank,
	}

	function areaOf(_ value: Shape) -> Integer {
		<- match value -> Integer {
			case #Circle({ radius }) { <- radius::multiply(with radius) }
			case #Blank              { <- 0 }
		}
	}
}

export {
	Shape
	areaOf
}
`,
			"app/One.es": `import {
	Shape  from "../lib/Shape.es"
	areaOf from "../lib/Shape.es"
}

implementation {
	constant one: Shape = #Circle({ radius = 2 })
	constant area = areaOf(one)
}

export {
	area
}
`,
			"Two.es": `import {
	Shape  from "./lib/Shape.es"
	areaOf from "./lib/Shape.es"
}

implementation {
	constant two: Shape = #Circle({ radius = 3 })
	constant area = areaOf(two)
}

export {
	area
}
`,
		}

		it("spells a shared Module the same however it was reached", async () => {
			await withProject(SHARED, async (root) => {
				let target = { mode: "host", root } as const
				let one = await emitToMemory(path.join(root, "app", "One.es"), {
					emit: target,
				})
				let two = await emitToMemory(path.join(root, "Two.es"), {
					emit: target,
				})

				expect(one.diagnostics).toEqual([])
				expect(two.diagnostics).toEqual([])
				// NOTE: Byte for byte, which is the whole claim — the host holds
				// ONE module per path, so the two compiles have to agree about
				// every character of it. The Case tag inside is what makes this
				// more than tidiness: `./lib/Shape.es#Shape#Circle` stamped by
				// one entry and compared by the other is what a `match` reads.
				expect(one.sources.sources.get("essence:./lib/Shape.es")).toBe(
					two.sources.sources.get("essence:./lib/Shape.es")!,
				)
				expect(
					one.sources.sources.get("essence:./lib/Shape.es"),
				).toContain('"./lib/Shape.es#Shape#Circle"')
				// NOTE: And the prelude with it, which is a different claim: its
				// contents are the whole standard library rather than what this
				// graph reaches, so two graphs that reach different halves of it
				// still write the same Module under the one name a host holds it
				// by.
				expect(one.sources.sources.get("essence:$prelude")).toBe(
					two.sources.sources.get("essence:$prelude")!,
				)
			})
		})

		// NOTE: The default emitting a bundle, where the same file is spelled
		// against the entry — stated here because it is what the mode above exists
		// to answer, and a change to it would otherwise only show up as a host
		// build that silently takes the wrong arm.
		it("spells a shared Module against the entry when it emits a bundle", async () => {
			await withProject(SHARED, async (root) => {
				let one = await emitToMemory(path.join(root, "app", "One.es"))
				let two = await emitToMemory(path.join(root, "Two.es"))

				expect(
					one.sources.sources.get("essence:../lib/Shape.es"),
				).toContain('"../lib/Shape.es#Shape#Circle"')
				expect(
					two.sources.sources.get("essence:./lib/Shape.es"),
				).toContain('"./lib/Shape.es#Shape#Circle"')
			})
		})

		it("imports the runtime by name so a host resolves one of it", async () => {
			await withProject(SHARED, async (root) => {
				let bundled = await emitToMemory(path.join(root, "Two.es"))
				let hosted = await emitToMemory(path.join(root, "Two.es"), {
					emit: { mode: "host", root },
				})
				let shape = (result: MemoryEmitResult): string =>
					result.sources.sources.get("essence:./lib/Shape.es")!

				expect(shape(hosted)).toContain(
					'from "@essence-lang/runtime/Integer"',
				)
				expect(shape(hosted)).not.toContain(RUNTIME_DIRECTORY)
				// NOTE: The other way round for a bundle, whose imports the
				// Bundler resolves and inlines itself — a package specifier there
				// would have to resolve against wherever the emitted text was
				// handed to esbuild from.
				expect(shape(bundled)).toContain(RUNTIME_DIRECTORY)
			})
		})

		// NOTE: What the runtime's own package promises, checked rather than
		// assumed: the specifier the Rewriter now writes has to resolve, in a
		// workspace and once published alike, or a host's build fails at a
		// specifier no Essence source wrote.
		it("writes a runtime specifier the runtime's exports map answers", () => {
			let manifest = JSON.parse(
				readFileSync(
					path.join(RUNTIME_DIRECTORY, "..", "package.json"),
					"utf8",
				),
			) as { name: string; exports: Record<string, string> }

			expect(manifest.name).toBe("@essence-lang/runtime")
			// NOTE: A `./src/*.ts` wildcard is BOTH halves of the promise. It is
			// what resolves in a workspace — checked below by resolving one for
			// real — and it is the one shape `scripts/publishing/stage.ts`
			// rewrites, into `./dist/*.js` beside a `./dist/*.d.ts`, so the same
			// specifier answers out of a published package too.
			expect(manifest.exports["./*"]).toBe("./src/*.ts")
			expect(import.meta.resolve("@essence-lang/runtime/Integer")).toBe(
				pathToFileURL(path.join(RUNTIME_DIRECTORY, "Integer.ts")).href,
			)
		})

		it("names a host's Modules apart from a bundle's in the hash", async () => {
			await withProject(SHARED, async (root) => {
				let entry = path.join(root, "Two.es")
				let bundled = await emitToMemory(entry)
				let hosted = await emitToMemory(entry, {
					emit: { mode: "host", root },
				})
				let elsewhere = await emitToMemory(entry, {
					emit: { mode: "host", root: path.dirname(root) },
				})

				expect(hosted.bundleHash).not.toBe(bundled.bundleHash)
				// NOTE: The root is in the key because it is what the Modules are
				// spelled relative to — two roots are two different texts over one
				// graph.
				expect(elsewhere.bundleHash).not.toBe(hosted.bundleHash)
			})
		})

		it("answers a Module that does not compile with Diagnostics and no Modules", async () => {
			await withProject(
				{
					"Main.es": `implementation {
	constant wrong: String = 1
}
`,
				},
				async (root) => {
					let result = await emitToMemory(
						path.join(root, "Main.es"),
						{
							emit: { mode: "host", root },
						},
					)

					expect(result.diagnostics).not.toEqual([])
					expect(result.sources.entry).toBe("")
					expect([...result.sources.sources.keys()]).toEqual([])
				},
			)
		})
	})
})
