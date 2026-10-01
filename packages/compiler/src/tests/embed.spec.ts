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

import {
	carriesDictionary,
	type Descriptor,
	describeModule,
	describeTypes,
} from "../embed/describe"
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

// A project on disk in a directory of its own, removed afterwards, as
// `modules.spec.ts` builds its graphs.
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

		// On macOS `mkdtempSync` answers under a symlink, so the directory is
		// canonicalised before anything is built out of it.
		return await work(realpathSync.native(directory))
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

// Whether a bundle needs the Dictionary bridge, asked of the values and of the
// declared Types, since both are the boundary.
async function carriesDictionaryFor(
	directory: string,
	name: string,
): Promise<boolean> {
	let entry = path.join(directory, name)
	let result = await compileToMemory(entry)

	expect(result.diagnostics).toEqual([])

	return carriesDictionary(
		describeModule(result.surface, entry),
		describeTypes(result.surface, entry),
	)
}

// Importing the bundle runs the Program. `print` writes to the stream and
// `inspect` goes through `console.log`, so both are captured.
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
		// `Rectangle` is a Type Alias and a Namespace of the same name. One
		// entry carries both, and its kind is what it was declared as.
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

	// The whole graph, so a host watching for edits sees an edit to what the
	// entry imports.
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

	// A host watching for the edit that fixes a broken Module needs the list
	// too.
	it("says which sources it read of a Module that does not compile", async () => {
		await withProject(
			{
				"Main.es": `import {
	from "./Dep.es" { value }
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

	// A host is handed one string, so the map rides inside it.
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
				"157",
			])
			expect(typeof module.describe).toBe("function")
		})
	})

	// The seam a host injects JavaScript through. The client needs a bridge
	// Module re-exporting the real entry, so that is what is built here.
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

	// Only `Optional` crosses as an absence, and it is told by identity rather
	// than by shape. So `Result` crosses as a Union of `case` descriptors, and
	// neither Case is flagged `optional`.
	it("crosses a Result as an ordinary generic Choice", async () => {
		await withProject(
			{
				"Checked.es": `implementation {
	constant answered: Result<Integer, String> = #Value(3)

	constant refused: Result<Integer, String> = #Failure("gone")

	constant missing: Optional<Integer> = #Empty
}

export {
	answered
	missing
	refused
}
`,
			},
			async (directory) => {
				let entry = path.join(directory, "Checked.es")
				let result = await compileToMemory(entry)

				expect(result.diagnostics).toEqual([])

				let described = describeModule(result.surface, entry)
				let carriedBy = (name: string): Descriptor | null => {
					let entry = described.exports[name]

					return entry?.kind === "constant" ? entry.of : null
				}

				let answered = carriedBy("answered")

				expect(answered?.kind).toBe("union")

				let arms = answered?.kind === "union" ? answered.arms : []

				expect(
					arms.map((arm) =>
						arm.kind === "case"
							? {
									kind: arm.kind,
									tag: arm.tag,
									name: arm.name,
									optional: arm.optional,
									unitChoice: arm.unitChoice,
								}
							: { kind: arm.kind },
					),
				).toEqual([
					{
						kind: "case",
						tag: "Result#Value",
						name: "Value",
						optional: false,
						unitChoice: false,
					},
					{
						kind: "case",
						tag: "Result#Failure",
						name: "Failure",
						optional: false,
						unitChoice: false,
					},
				])

				// `Optional` still crosses as an absence.
				expect(carriedBy("missing")?.kind).toBe("optional")
			},
		)
	})

	// A Dictionary is described as its two slots, never its store. The runtime
	// builds and reads one through the bridge, which `carriesDictionary`
	// decides a bundle carries.
	it("describes a Dictionary as its two slots, and says a boundary holds one", async () => {
		await withProject(
			{
				"Ledger.es": `implementation {
	choice Direction {
		Up,
		Down,
	}

	constant sizes: Dictionary<String, Integer> = ["small" = 1]
}

export {
	Direction
	sizes
}
`,
				"Reached.es": `implementation {
	choice Direction {
		Up,
		Down,
	}

	function headings(
		_ value: List<Dictionary<Direction, Integer>>,
	) -> List<Dictionary<Direction, Integer>> {
		<- value
	}
}

export {
	Direction
	headings
}
`,
				"Plain.es": `implementation {
	function twice(_ value: Integer) -> Integer {
		<- value::multiply(with 2)
	}
}

export {
	twice
}
`,
			},
			async (directory) => {
				let entry = path.join(directory, "Ledger.es")
				let result = await compileToMemory(entry)

				expect(result.diagnostics).toEqual([])

				let described = describeModule(result.surface, entry)
				let sizes = described.exports.sizes

				expect(sizes?.kind).toBe("constant")

				let node = sizes?.kind === "constant" ? sizes.of : null

				expect(node?.kind).toBe("dictionary")
				expect(node?.kind === "dictionary" ? node.key : null).toEqual({
					kind: "string",
					shown: "String",
				})
				expect(node?.kind === "dictionary" ? node.value : null).toEqual(
					{ kind: "integer", shown: "Integer" },
				)
				expect(node?.shown).toBe("Dictionary<String, Integer>")
				expect(
					carriesDictionary(
						described,
						describeTypes(result.surface, entry),
					),
				).toBeTrue()

				// This Module's only Dictionary sits in a List inside a
				// Function's Parameter, which no exported Type names.
				expect(
					await carriesDictionaryFor(directory, "Reached.es"),
				).toBeTrue()
				expect(
					await carriesDictionaryFor(directory, "Plain.es"),
				).toBeFalse()
			},
		)
	})

	it("shows a bound by its Protocol's name and never its path", async () => {
		await withProject(
			{
				"Sized.es": `implementation {
	protocol Sized {
		size() -> Integer
	}

	function measure<infer Item is Sized>(_ item: Item) -> Integer {
		<- item::size()
	}
}

export {
	Sized
	measure
}
`,
			},
			async (directory) => {
				let entry = path.join(directory, "Sized.es")
				let result = await compileToMemory(entry)

				expect(result.diagnostics).toEqual([])

				let measure = describeModule(result.surface, entry).exports
					.measure

				expect(
					measure?.kind === "function" ? measure.of.shown : null,
				).toBe("<Item is Sized>(_ Item) -> Integer")
				expect(JSON.stringify(measure)).not.toContain(directory)
			},
		)
	})

	// One Module per arm of the walk, each with its only Dictionary behind that
	// arm. A missed arm makes the marshaller refuse a legal value at run time.
	// The Case arm needs a Choice of two Cases, or the `choice` or `union` arm
	// would reach the Case first.
	it("finds a Dictionary behind every arm of the walk", async () => {
		await withProject(
			{
				"ThroughOptional.es": `implementation {
	function found(_ value: Optional<Dictionary<String, Integer>>) -> Integer {
		<- 1
	}
}

export {
	found
}
`,
				"ThroughRecord.es": `implementation {
	function found(_ value: { sizes: Dictionary<String, Integer> }) -> Integer {
		<- 1
	}
}

export {
	found
}
`,
				"ThroughCase.es": `implementation {
	choice Holder {
		Sizes { sizes: Dictionary<String, Integer> },
		Empty,
	}

	function found(_ value: Holder) -> Integer {
		<- 1
	}
}

export {
	found
}
`,
				"ThroughUnion.es": `implementation {
	type Either = Dictionary<String, Integer> | String

	function found(_ value: Either) -> Integer {
		<- 1
	}
}

export {
	found
}
`,
				"ThroughType.es": `implementation {
	type Ledger = { entries: Dictionary<String, Integer> }

	function count() -> Integer {
		<- 1
	}
}

export {
	Ledger
	count
}
`,
			},
			async (directory) => {
				expect(
					await carriesDictionaryFor(directory, "ThroughOptional.es"),
				).toBeTrue()
				expect(
					await carriesDictionaryFor(directory, "ThroughRecord.es"),
				).toBeTrue()
				expect(
					await carriesDictionaryFor(directory, "ThroughCase.es"),
				).toBeTrue()
				expect(
					await carriesDictionaryFor(directory, "ThroughUnion.es"),
				).toBeTrue()

				// No exported value names a Dictionary here. The declared Type
				// does, and a host marshals against it through `surface.types`.
				expect(
					await carriesDictionaryFor(directory, "ThroughType.es"),
				).toBeTrue()
			},
		)
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
	from "./Dep.es" { value }
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

				// A dependency's text counts as much as the entry's.
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

			// The paths are part of what was compiled, so the same sources in
			// another directory hash differently.
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

		// The bundle holds the compiled standard library and the inlined
		// runtime too. A key over the `.es` files alone would keep serving a
		// bundle an older toolchain wrote.
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

		// A host that injects a Module of its own, such as the client's
		// runtime bridge, changes the bytes without touching a source.
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

	// The front half alone, which a host with a cache asks before it decides
	// to emit.
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

	// The graph as Modules, which a host bundler embeds. A file's emitted text
	// depends on the file and the root alone, never on the entry compiled.
	describe("Emitting To Memory", () => {
		// Two entries at different depths share one file, so its entry-relative
		// and root-relative spellings differ.
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
	from "../lib/Shape.es" { Shape }
	from "../lib/Shape.es" { areaOf }
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
	from "./lib/Shape.es" { Shape }
	from "./lib/Shape.es" { areaOf }
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
				// The host holds one module per path, so the two compiles must
				// agree byte for byte. A `match` compares the Case tag inside.
				expect(one.sources.sources.get("essence:./lib/Shape.es")).toBe(
					two.sources.sources.get("essence:./lib/Shape.es")!,
				)
				expect(
					one.sources.sources.get("essence:./lib/Shape.es"),
				).toContain('"./lib/Shape.es#Shape#Circle"')
				// The prelude holds the whole standard library rather than what
				// a graph reaches, so two graphs write the same prelude.
				expect(one.sources.sources.get("essence:$prelude")).toBe(
					two.sources.sources.get("essence:$prelude")!,
				)
			})
		})

		// A provided Method counts into its Module's table from the prelude,
		// and the Module imports that counter by name. The name must not
		// depend on where in a graph the Module stood.
		it("names a shared Module's coverage counter the same however it was reached", async () => {
			let sizing = `implementation {
	protocol Sized {
		size() -> Integer

		doubled() -> Integer {
			if @::size()::isZero() {
				<- 0
			} else {
				<- @::size()::multiply(with 2)
			}
		}
	}
}

export {
	Sized
}
`
			let user = (imports: string, answer: string) => `import {
${imports}
}

implementation {
	type Box = { count: Integer }

	namespace Boxes for Box is Sized {
		size() -> Integer {
			<- @.count
		}
	}

	constant box: Box = { count = 2 }
	constant answer = ${answer}
}

export {
	answer
}
`

			await withProject(
				{
					"lib/Sized.es": sizing,
					"lib/Extra.es":
						"implementation {\n\tconstant extra = 1\n}\n\nexport {\n\textra\n}\n",
					"One.es": user(
						'\tfrom "./lib/Sized.es" { Sized }',
						"box::doubled()",
					),
					// `Extra.es` stands before `Sized.es` in this graph.
					"Two.es": user(
						'\tfrom "./lib/Extra.es" { extra }\n\tfrom "./lib/Sized.es" { Sized }',
						"box::doubled()::add(extra)",
					),
				},
				async (root) => {
					let options = {
						emit: { mode: "host", root } as const,
						optimisation: {
							...defaultOptimiserOptions,
							coverage: true,
						},
					}
					let one = await emitToMemory(
						path.join(root, "One.es"),
						options,
					)
					let two = await emitToMemory(
						path.join(root, "Two.es"),
						options,
					)
					let sized = (result: MemoryEmitResult): string =>
						result.sources.sources.get("essence:./lib/Sized.es")!

					expect(one.diagnostics).toEqual([])
					expect(two.diagnostics).toEqual([])
					expect(sized(one)).toContain("as $cover }")
					expect(sized(one)).toBe(sized(two))
				},
			)
		})

		// A bundle, the default, spells the same file against the entry. The
		// host mode exists because of this.
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

		// A served Module never touches disk, so its map rides inside its text,
		// where a host bundler reads the `sourceMappingURL` comment.
		it("carries each Module's source map inside its own text", async () => {
			await withProject(SHARED, async (root) => {
				let emitted = await emitToMemory(path.join(root, "Two.es"), {
					emit: { mode: "host", root },
				})
				let shape = emitted.sources.sources.get(
					"essence:./lib/Shape.es",
				)!
				let encoded =
					/sourceMappingURL=data:application\/json;base64,(\S+)/.exec(
						shape,
					)?.[1] ?? ""
				let map = JSON.parse(
					Buffer.from(encoded, "base64").toString("utf8"),
				) as { sources: Array<string>; sourcesContent: Array<string> }

				expect(map.sources).toEqual([
					path.join(root, "lib", "Shape.es"),
				])
				// The Essence source, not the JavaScript it emitted.
				expect(map.sourcesContent[0]).toContain("choice Shape {")
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
				// A bundle's imports are resolved and inlined by the Bundler, so
				// they name the runtime's directory.
				expect(shape(bundled)).toContain(RUNTIME_DIRECTORY)
			})
		})

		// The specifier the Rewriter writes must resolve in a workspace and
		// from a published package alike.
		it("writes a runtime specifier the runtime's exports map answers", () => {
			let manifest = JSON.parse(
				readFileSync(
					path.join(RUNTIME_DIRECTORY, "..", "package.json"),
					"utf8",
				),
			) as { name: string; exports: Record<string, string> }

			expect(manifest.name).toBe("@essence-lang/runtime")
			// A `./src/*.ts` wildcard resolves in a workspace, and
			// `scripts/publishing/stage.ts` rewrites it to `./dist/*.js` beside a
			// `./dist/*.d.ts` for a published package.
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
				// The Modules are spelled relative to the root, so the root is
				// in the key.
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
