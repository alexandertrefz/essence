import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { BRIDGE_KEY, linkToMemory } from "@essence-lang/compiler/embed"
import { fixturePath } from "@essence-lang/fixtures"
import { typeKeySymbol } from "@essence-lang/runtime/type"

import type { EssenceValue, RuntimeBridge } from "../bridge"
import { EssenceCompileError } from "../compile-error"
import { describeModule } from "../descriptor"
import { EssenceCallError, EssenceMarshalError } from "../errors"
import { type EssenceModule, loadModule, watchModule } from "../index"
import { createInterpreter } from "../marshal-runtime"
import { EssenceRational } from "../rational"

// Every load here caches into a directory of its own.
let cacheDirectory = ""

beforeAll(() => {
	cacheDirectory = realpathSync.native(
		mkdtempSync(path.join(tmpdir(), "essence-client-")),
	)
})

afterAll(() => {
	rmSync(cacheDirectory, { recursive: true, force: true })
})

function clientFixture(name: string): string {
	return path.join(import.meta.dirname, "files", name)
}

// A temporary project, for tests that edit a source.
async function withProject<Result>(
	files: Record<string, string>,
	work: (directory: string) => Promise<Result>,
): Promise<Result> {
	let directory = mkdtempSync(path.join(tmpdir(), "essence-client-project-"))

	try {
		for (let [name, source] of Object.entries(files)) {
			let filePath = path.join(directory, name)

			mkdirSync(path.dirname(filePath), { recursive: true })
			writeFileSync(filePath, source)
		}

		return await work(realpathSync.native(directory))
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

// Captures what a bundle prints as it is imported. `print` writes to the
// stream and `inspect` ends its line through `console.log`, so both are held.
async function captured<Result>(
	work: () => Promise<Result>,
): Promise<{ result: Result; written: string }> {
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
		return { result: await work(), written }
	} finally {
		console.log = originalLog
		process.stdout.write = originalOut
	}
}

function call(
	module: EssenceModule,
	name: string,
	...args: Array<EssenceValue>
): EssenceValue {
	let callee = module.raw[name] as (
		...args: Array<EssenceValue>
	) => EssenceValue

	return callee(...args)
}

function tagOf(bridge: RuntimeBridge, value: EssenceValue): unknown {
	return (value as Record<symbol, unknown>)[bridge.typeKey]
}

function fieldOf(value: EssenceValue, name: string): unknown {
	return (value as Record<string, unknown>)[name]
}

describe("Loading a Module", () => {
	it("binds every export the Surface names and calls into them", async () => {
		let math = await loadModule(fixturePath("modules", "math", "Math.es"), {
			cacheDirectory,
		})

		expect(Object.keys(math.raw).sort()).toEqual(["PI", "square"])
		expect(math.surface.kinds).toEqual({
			PI: "constant",
			square: "function",
		})

		let squared = call(math, "square", math.bridge.integer(12n))

		// The bundle's own value, unmarshalled, holds a small Integer as a
		// number. Only `toJS` makes it a bigint.
		expect(tagOf(math.bridge, squared)).toBe("Integer")
		expect(fieldOf(squared, "value")).toBe(144)
	})

	it("hands back the Module's own values, not JavaScript ones", async () => {
		let math = await loadModule(fixturePath("modules", "math", "Math.es"), {
			cacheDirectory,
		})
		let pi = math.raw.PI as EssenceValue

		expect(tagOf(math.bridge, pi)).toBe("Rational")
		expect(fieldOf(pi, "numerator")).toBe(314n)
		expect(fieldOf(pi, "denominator")).toBe(100n)
	})

	// The runtime holds `314/100` unreduced, and it comes out reduced.
	it("hands back its constants as JavaScript values", async () => {
		let math = await loadModule(fixturePath("modules", "math", "Math.es"), {
			cacheDirectory,
		})

		expect(Object.keys(math.exports)).toEqual(["PI", "square"])
		expect((math.exports.PI as EssenceRational).toString()).toBe("157/50")
		expect((math.exports.PI as EssenceRational).toNumber()).toBe(3.14)
	})

	it("takes a Record built through the bridge", async () => {
		let { result: main, written } = await captured(() =>
			loadModule(fixturePath("modules", "Main.es"), { cacheDirectory }),
		)

		// The fixture's body runs as the bundle is imported.
		expect(written.trimEnd().split("\n")).toEqual(["area: 12", "25", "157"])

		let described = call(
			main,
			"describe",
			main.bridge.record({
				width: main.bridge.integer(3n),
				height: main.bridge.integer(4n),
			}),
		)

		expect(tagOf(main.bridge, described)).toBe("String")
		expect(fieldOf(described, "value")).toBe("area: 12")
	})

	// `Rectangle` is a Type Alias and a Namespace, so its kind reads `type`
	// though the bundle binds it.
	it("binds a Namespace whose kind reads as a Type", async () => {
		let { result: main } = await captured(() =>
			loadModule(fixturePath("modules", "Main.es"), { cacheDirectory }),
		)

		expect(Object.keys(main.raw).sort()).toEqual(["Rectangle", "describe"])
		expect(main.surface.kinds.Rectangle).toBe("type")
		expect(typeof main.raw.Rectangle).toBe("function")
	})

	// A Namespace that writes the Method keeps its own, as in Essence.
	it("binds the provided Methods a Namespace's Protocol gives it", async () => {
		let provided = await loadModule(clientFixture("Provided.es"), {
			cacheDirectory,
		})
		let rectangles = provided.exports.Rectangles as Record<
			string,
			(...args: Array<unknown>) => unknown
		>
		let squares = provided.exports.Squares as typeof rectangles

		expect(Object.keys(rectangles)).toEqual(["area", "isEmpty", "scaled"])
		expect(rectangles.isEmpty!({ width: 0n, height: 4n })).toBe(true)
		expect(rectangles.scaled!({ width: 2n, height: 3n }, 2n)).toBe(12n)
		expect(squares.isEmpty!({ side: 1n })).toBe(true)
		expect(squares.scaled!({ side: 3n }, 2n)).toBe(18n)
	})

	// The Choice's Case keeps its name, and the Protocol's other Methods join it.
	it("keeps a Case over a provided Method of its name", async () => {
		let provided = await loadModule(clientFixture("Provided.es"), {
			cacheDirectory,
		})
		let colour = provided.exports.Colour as Record<string, unknown>

		expect(colour.Red).toBe("Red")
		expect((colour.shout as (value: string) => string)("Blue")).toBe(
			"blue!",
		)
	})

	// The re-exporting Module of a cycle hands on what the declaring one found.
	it("binds the provided Methods of a Namespace a cycle forwards", async () => {
		let walking = await loadModule(
			clientFixture(path.join("cycle", "Walking.es")),
			{ cacheDirectory },
		)
		let walkers = walking.exports.Walkers as Record<
			string,
			(value: { stride: bigint }) => bigint
		>

		expect(walkers.twice!({ stride: 4n })).toBe(8n)
	})

	it("undoes the Rewriter's escaping", async () => {
		let escaped = await loadModule(clientFixture("Escaped.es"), {
			cacheDirectory,
		})

		expect(Object.keys(escaped.raw).sort()).toEqual(["$$integer", "ok?"])
		expect(typeof escaped.raw["ok?"]).toBe("function")

		let answer = call(escaped, "ok?", escaped.bridge.boolean(true))

		expect(tagOf(escaped.bridge, answer)).toBe("Boolean")
		expect(fieldOf(answer, "value")).toBe(true)
	})
})

describe("The Runtime Bridge", () => {
	// The Type key is minted as the bundle is evaluated, so this process's
	// runtime holds another.
	it("hands out the bundle's own Type key rather than this process's", async () => {
		let math = await loadModule(fixturePath("modules", "math", "Math.es"), {
			cacheDirectory,
		})

		expect(typeof math.bridge.typeKey).toBe("symbol")
		expect(math.bridge.typeKey).not.toBe(typeKeySymbol)
		expect(math.bridge.typeKey.description).toBe("$type")
	})

	// The bridge is the default export, which no Essence export can take, since
	// the Rewriter prefixes a reserved word with `_`. `Escaped.es` tries to
	// collide anyway.
	it("names itself out of reach of an Essence export", async () => {
		let escaped = await loadModule(clientFixture("Escaped.es"), {
			cacheDirectory,
		})
		let userConstant = escaped.raw.$$integer as EssenceValue

		expect(tagOf(escaped.bridge, userConstant)).toBe("Integer")
		expect(fieldOf(userConstant, "value")).toBe(12)
	})

	// The runtime's `createList` takes ownership of its Array, so the bridge
	// hands out `createListFrom`, which copies. `grown` must not reach the host's
	// Array.
	it("copies the Array a host builds a List out of", async () => {
		let marshal = await loadModule(clientFixture("Marshal.es"), {
			cacheDirectory,
		})
		let hostItems = [marshal.bridge.string("a"), marshal.bridge.string("b")]
		let grown = marshal.raw.grown as (value: EssenceValue) => EssenceValue

		grown(marshal.bridge.list(hostItems))

		expect(hostItems.map((item) => fieldOf(item, "value"))).toEqual([
			"a",
			"b",
		])
	})
})

describe("A value from another copy of the runtime", () => {
	// A value from another bundle is tagged by a key this Module never saw.
	// The refusal names it as such rather than as a plain object.
	it("is refused as one, not as a plain object", async () => {
		let math = await loadModule(fixturePath("modules", "math", "Math.es"), {
			cacheDirectory,
		})
		let marshal = await loadModule(clientFixture("Marshal.es"), {
			cacheDirectory,
		})
		let foreign = marshal.bridge.integer(12n)
		let square = math.exports.square as (value: unknown) => unknown

		expect(() => square(foreign)).toThrow(
			/an Essence Integer value from another copy of the runtime — a previous load of this Module, or a different bundle/,
		)
		expect(() => math.marshaller.toJS(foreign, "value")).toThrow(
			/did not come from this Module — an Essence Integer value from another copy of the runtime/,
		)
	})

	// A value from this process's own runtime is recognised by its key's
	// description.
	it("names a value this process's own runtime built", async () => {
		let math = await loadModule(fixturePath("modules", "math", "Math.es"), {
			cacheDirectory,
		})
		let own = { value: 12, [typeKeySymbol]: "Integer" }

		expect(() => math.marshaller.toJS(own, "value")).toThrow(
			/an Essence Integer value from another copy of the runtime/,
		)
	})
})

describe("A Module that does not compile", () => {
	it("throws the report `esc` would have printed", async () => {
		let entry = clientFixture("Broken.es")
		let error: unknown = null

		try {
			await loadModule(entry, { cacheDirectory })
		} catch (thrown) {
			error = thrown
		}

		expect(error).toBeInstanceOf(EssenceCompileError)

		let compileError = error as EssenceCompileError

		expect(compileError.entryPath).toBe(entry)
		expect(compileError.diagnostics.map((one) => one.code)).toEqual([
			"no-matching-overload",
		])
		expect(compileError.message).toContain("[no-matching-overload]")
		expect(compileError.message).toContain(
			"Error: No overload of 'multiply' accepts these Arguments",
		)
		// The whole report: excerpt, underline and tally.
		expect(compileError.message).toContain("Broken.es:4:6")
		expect(compileError.message).toContain('<- value::multiply(with "two")')
		expect(compileError.message).toContain("1 error")
		// Without colour.
		expect(compileError.message).not.toContain("[")
	})

	// One block per file, against that file's own source. The entry gets a
	// block saying what it imports did not compile, as `essence check` reports.
	it("renders a dependency's Diagnostic against the dependency", async () => {
		await withProject(
			{
				"Main.es": `import {
	from "./Dep.es" { broken }
}

implementation {
	Terminal.print(broken())
}
`,
				"Dep.es": `implementation {
	function broken() -> String {
		<- 1
	}
}

export {
	broken
}
`,
			},
			async (directory) => {
				let error: unknown = null

				try {
					await loadModule(path.join(directory, "Main.es"), {
						cacheDirectory,
					})
				} catch (thrown) {
					error = thrown
				}

				let compileError = error as EssenceCompileError

				expect(compileError).toBeInstanceOf(EssenceCompileError)
				expect(
					compileError.diagnosticGroups.map((group) =>
						path.basename(group.filePath),
					),
				).toEqual(["Dep.es", "Main.es"])
				expect(compileError.message).toContain("<- 1")
			},
		)
	})
})

// A watcher's listeners, with a way to wait for the next of each that fails
// rather than hangs.
function listeners(): {
	modules: Array<EssenceModule>
	errors: Array<EssenceCompileError>
	onModule: (module: EssenceModule) => void
	onError: (error: EssenceCompileError) => void
	nextModule: () => Promise<EssenceModule>
	nextError: () => Promise<EssenceCompileError>
	settle: (milliseconds?: number) => Promise<void>
} {
	let modules: Array<EssenceModule> = []
	let errors: Array<EssenceCompileError> = []
	let waitingForModule: Array<(module: EssenceModule) => void> = []
	let waitingForError: Array<(error: EssenceCompileError) => void> = []
	let awaited = <Value>(
		waiting: Array<(value: Value) => void>,
		what: string,
	): Promise<Value> =>
		// Inside the per-test budget `scripts/testBudget.ts` sets. A later
		// rejection would be an unattributed error between tests.
		new Promise((resolve, reject) => {
			let timeout = setTimeout(
				() => reject(new Error(`No ${what} arrived within 4 seconds.`)),
				4000,
			)

			waiting.push((value) => {
				clearTimeout(timeout)
				resolve(value)
			})
		})

	return {
		modules,
		errors,
		onModule(module) {
			modules.push(module)

			for (let resolve of waitingForModule.splice(0)) {
				resolve(module)
			}
		},
		onError(error) {
			errors.push(error)

			for (let resolve of waitingForError.splice(0)) {
				resolve(error)
			}
		},
		nextModule: () => awaited(waitingForModule, "Module"),
		nextError: () => awaited(waitingForError, "Error"),
		settle: (milliseconds = 300) =>
			new Promise((resolve) => setTimeout(resolve, milliseconds)),
	}
}

const COUNTED_MODULE = (answer: number) => `import {
	from "./Math.es" { square }
}

implementation {
	constant answer = square(${answer})
}

export {
	answer
}
`

const MATH_SOURCE = `implementation {

	function squared(_ value: Integer) -> Integer {
		<- value::multiply(with value)
	}
}

export {
	squared as square
}
`

describe("Watching a Module", () => {
	it("hands over the first Module, and another after every edit that compiles", async () => {
		await withProject(
			{ "Main.es": COUNTED_MODULE(2), "Math.es": MATH_SOURCE },
			async (directory) => {
				let heard = listeners()
				let watcher = await watchModule(
					path.join(directory, "Main.es"),
					{
						cacheDirectory,
						onModule: heard.onModule,
						onError: heard.onError,
					},
				)

				try {
					// The first load arrives before `watchModule` answers.
					expect(heard.modules).toHaveLength(1)
					expect(watcher.module).toBe(heard.modules[0]!)
					expect(watcher.module!.exports.answer).toBe(4n)
					expect(watcher.files).toEqual(
						[
							path.join(directory, "Main.es"),
							path.join(directory, "Math.es"),
						].sort(),
					)

					// An edit to what the entry imports.
					let next = heard.nextModule()

					writeFileSync(
						path.join(directory, "Math.es"),
						MATH_SOURCE.replace(
							"value::multiply(with value)",
							"value::multiply(with value)::add(1)",
						),
					)

					let second = await next

					expect(second).not.toBe(heard.modules[0]!)
					expect(watcher.module).toBe(second)
					expect(second.exports.answer).toBe(5n)
					// The Module from before the edit still works.
					expect(heard.modules[0]!.exports.answer).toBe(4n)
				} finally {
					watcher.close()
				}
			},
		)
	})

	it("keeps the Module before an edit that does not compile", async () => {
		await withProject(
			{ "Main.es": COUNTED_MODULE(3), "Math.es": MATH_SOURCE },
			async (directory) => {
				let heard = listeners()
				let watcher = await watchModule(
					path.join(directory, "Main.es"),
					{
						cacheDirectory,
						onModule: heard.onModule,
						onError: heard.onError,
					},
				)

				try {
					let first = watcher.module!
					let failure = heard.nextError()

					writeFileSync(
						path.join(directory, "Main.es"),
						COUNTED_MODULE(3).replace(
							"square(3)",
							'square("three")',
						),
					)

					let error = await failure

					expect(error).toBeInstanceOf(EssenceCompileError)
					expect(error.message).toContain("Main.es")
					expect(watcher.module).toBe(first)
					expect(heard.modules).toHaveLength(1)

					// And the fix is the next thing heard.
					let fixed = heard.nextModule()

					writeFileSync(
						path.join(directory, "Main.es"),
						COUNTED_MODULE(4),
					)

					expect((await fixed).exports.answer).toBe(16n)
				} finally {
					watcher.close()
				}
			},
		)
	})

	// A save of the same text is loaded, since only a load can tell, and not
	// reported.
	it("does not report a save that changes nothing", async () => {
		await withProject(
			{ "Main.es": COUNTED_MODULE(5), "Math.es": MATH_SOURCE },
			async (directory) => {
				let heard = listeners()
				let watcher = await watchModule(
					path.join(directory, "Main.es"),
					{
						cacheDirectory,
						onModule: heard.onModule,
						onError: heard.onError,
					},
				)

				try {
					writeFileSync(path.join(directory, "Math.es"), MATH_SOURCE)
					await heard.settle()

					expect(heard.modules).toHaveLength(1)
					expect(heard.errors).toHaveLength(0)
				} finally {
					watcher.close()
				}
			},
		)
	})

	it("reports a first load that does not compile, and waits for the fix", async () => {
		await withProject(
			{
				"Main.es": COUNTED_MODULE(2).replace("square(2)", "square()"),
				"Math.es": MATH_SOURCE,
			},
			async (directory) => {
				let heard = listeners()
				let watcher = await watchModule(
					path.join(directory, "Main.es"),
					{
						cacheDirectory,
						onModule: heard.onModule,
						onError: heard.onError,
					},
				)

				try {
					expect(watcher.module).toBe(null)
					expect(heard.errors).toHaveLength(1)
					// Watched although nothing compiled, for the fix.
					expect(watcher.files).toContain(
						path.join(directory, "Math.es"),
					)

					let fixed = heard.nextModule()

					writeFileSync(
						path.join(directory, "Main.es"),
						COUNTED_MODULE(2),
					)

					expect((await fixed).exports.answer).toBe(4n)
					expect(watcher.module).not.toBe(null)
				} finally {
					watcher.close()
				}
			},
		)
	})

	it("hears nothing once closed", async () => {
		await withProject(
			{ "Main.es": COUNTED_MODULE(6), "Math.es": MATH_SOURCE },
			async (directory) => {
				let heard = listeners()
				let watcher = await watchModule(
					path.join(directory, "Main.es"),
					{
						cacheDirectory,
						onModule: heard.onModule,
						onError: heard.onError,
					},
				)

				watcher.close()
				writeFileSync(
					path.join(directory, "Main.es"),
					COUNTED_MODULE(7),
				)
				await heard.settle()

				expect(heard.modules).toHaveLength(1)
				expect(watcher.module!.exports.answer).toBe(36n)
			},
		)
	})

	// A raw value from the load before carries that bundle's key, and the next
	// load refuses it by name.
	it("refuses a raw value from the load before, by name", async () => {
		await withProject(
			{ "Main.es": COUNTED_MODULE(2), "Math.es": MATH_SOURCE },
			async (directory) => {
				let heard = listeners()
				let watcher = await watchModule(
					path.join(directory, "Main.es"),
					{
						cacheDirectory,
						onModule: heard.onModule,
						onError: heard.onError,
					},
				)

				try {
					let before = watcher.module!
					let stale = before.bridge.integer(3n)
					let next = heard.nextModule()

					writeFileSync(
						path.join(directory, "Main.es"),
						COUNTED_MODULE(2).replace(
							"export {\n\tanswer",
							'export {\n\tfrom "./Math.es" { square }\n\tanswer',
						),
					)

					let after = await next
					let square = after.exports.square as (
						value: unknown,
					) => unknown

					expect(square(3n)).toBe(9n)
					expect(() => square(stale)).toThrow(
						/from another copy of the runtime — a previous load of this Module/,
					)
				} finally {
					watcher.close()
				}
			},
		)
	})
})

describe("The Bundle Cache", () => {
	it("reuses the file it already wrote", async () => {
		await withProject({}, async (directory) => {
			let entry = fixturePath("modules", "math", "Math.es")
			let first = await loadModule(entry, { cacheDirectory: directory })
			let bundles = (await readdir(directory)).filter((name) =>
				name.endsWith(".mjs"),
			)

			expect(bundles).toHaveLength(1)

			let file = path.join(directory, bundles[0]!)
			let before = (await stat(file)).mtimeMs
			let again = await loadModule(entry, { cacheDirectory: directory })

			// Not rewritten, since its name is the hash of what it holds.
			expect((await stat(file)).mtimeMs).toBe(before)
			expect(await readdir(directory)).toEqual(bundles)
			// The same URL is the same Module, evaluated once.
			expect(again.raw.square).toBe(first.raw.square)
		})
	})

	it("writes a second bundle once a source changes", async () => {
		await withProject(
			{
				"Main.es": `implementation {
	constant value = 1
}

export {
	value
}
`,
			},
			async (project) => {
				await withProject({}, async (directory) => {
					let entry = path.join(project, "Main.es")

					await loadModule(entry, { cacheDirectory: directory })
					writeFileSync(
						entry,
						`implementation {
	constant value = 2
}

export {
	value
}
`,
					)

					let edited = await loadModule(entry, {
						cacheDirectory: directory,
					})

					expect(
						(await readdir(directory)).filter((name) =>
							name.endsWith(".mjs"),
						),
					).toHaveLength(2)
					expect(
						fieldOf(edited.raw.value as EssenceValue, "value"),
					).toBe(2)
				})
			},
		)
	})

	// A bundle carries the Dictionary door only where the boundary names one.
	// Each half caches apart, since the bundle hash does not name the door.
	it("caches the Dictionary door only where the boundary names one", async () => {
		await withProject(
			{
				"Plain.es": `implementation {
	function twice(_ value: Integer) -> Integer {
		<- value::multiply(with 2)
	}
}

export {
	twice
}
`,
				"Ledger.es": `implementation {
	function ages(_ value: Dictionary<String, Integer>) -> Dictionary<String, Integer> {
		<- value
	}
}

export {
	ages
}
`,
			},
			async (project) => {
				let bundleOf = async (name: string): Promise<string> => {
					return await withProject({}, async (directory) => {
						await loadModule(path.join(project, name), {
							cacheDirectory: directory,
						})

						let bundles = (await readdir(directory)).filter(
							(entry) => entry.endsWith(".mjs"),
						)

						expect(bundles).toHaveLength(1)

						return readFileSync(
							path.join(directory, bundles[0]!),
							"utf8",
						)
					})
				}
				let plain = await bundleOf("Plain.es")

				expect(plain).not.toContain("createDictionaryFrom")
				expect(plain).not.toContain("liveEntriesOf")

				let carrying = await bundleOf("Ledger.es")

				expect(carrying).toContain("createDictionaryFrom")
				expect(carrying).toContain("liveEntriesOf")
			},
		)
	})

	// `loadModule` looks the bundle up before emitting, so the hash it looks up
	// must be the one the compile writes under.
	it("names the bundle by a hash it can compute without emitting", async () => {
		await withProject({}, async (directory) => {
			let entry = fixturePath("modules", "math", "Math.es")

			await loadModule(entry, { cacheDirectory: directory })

			let linked = linkToMemory(entry, {
				emitterKey: BRIDGE_KEY,
				embed: true,
			})

			expect(
				(await readdir(directory)).filter((name) =>
					name.endsWith(".mjs"),
				),
			).toEqual([`${linked.bundleHash}.mjs`])
		})
	})

	// A bundle with the bridge and one without must be two files.
	it("names a bridged bundle apart from a plain one", async () => {
		let entry = fixturePath("modules", "math", "Math.es")
		let plain = linkToMemory(entry)
		let bridged = linkToMemory(entry, { emitterKey: BRIDGE_KEY })

		expect(bridged.bundleHash).not.toBe(plain.bundleHash)
	})
})

// A JavaScript call may leave out what an Essence call may, and the emitted
// default fills it in.
describe("Calling with an Argument left out", () => {
	let defaults: EssenceModule

	beforeAll(async () => {
		defaults = await loadModule(clientFixture("Defaults.es"), {
			cacheDirectory,
		})
	})

	it("takes a positional call that stops before a trailing default", () => {
		let scaled = defaults.exports.scaled as (
			value: bigint,
			factor?: bigint,
		) => bigint

		expect(scaled(21n)).toBe(42n)
		expect(scaled(21n, 3n)).toBe(63n)
	})

	it("takes a labelled call that leaves an interior default out", () => {
		let cut = defaults.exports.cut as (labelled: {
			from?: bigint
			to: bigint
		}) => bigint

		expect(cut({ to: 7n })).toBe(7n)
		expect(cut({ from: 2n, to: 7n })).toBe(5n)
	})

	it("takes a call that writes nothing at all", () => {
		let greeting = defaults.exports.greeting as (
			prefix?: string,
			name?: string,
		) => string

		expect(greeting()).toBe("hello world")
		expect(greeting("hi")).toBe("hi world")
		expect(greeting("hi", "there")).toBe("hi there")
	})

	// The refusal names the range of Arguments the signature accepts.
	it("still refuses a call that leaves a required Argument out", () => {
		let cut = defaults.exports.cut as (...args: Array<unknown>) => bigint

		expect(() => cut()).toThrow(/takes 1 to 2 Arguments/)
	})

	// `cut(7n)` is within the range but leaves the required `to` out.
	it("refuses a positional call that stops before a required Parameter", () => {
		let cut = defaults.exports.cut as (...args: Array<unknown>) => bigint

		expect(() => cut(7n)).toThrow(EssenceCallError)
		expect(() => cut(7n)).toThrow(/takes 1 to 2 Arguments/)
	})

	// The declarations admit an explicit `undefined` for an omittable slot,
	// which means leaving it out.
	it("takes an explicit undefined where the declaration admits one", () => {
		let cut = defaults.exports.cut as (labelled: {
			from?: bigint
			to: bigint
		}) => bigint
		let greeting = defaults.exports.greeting as (
			prefix?: string,
			name?: string,
		) => string

		expect(cut({ from: undefined, to: 7n })).toBe(7n)
		expect(greeting(undefined, "there")).toBe("hello there")
		expect(greeting("hi", undefined)).toBe("hi world")
	})

	// In a required slot `undefined` is a value, and no Type admits it.
	it("still refuses an explicit undefined on a required Parameter", () => {
		let cut = defaults.exports.cut as (labelled: {
			from?: bigint
			to?: bigint
		}) => bigint

		expect(() => cut({ from: 2n, to: undefined })).toThrow(
			EssenceMarshalError,
		)
	})

	it("still refuses a labelled call missing a required label", () => {
		let cut = defaults.exports.cut as (...args: Array<unknown>) => bigint

		expect(() => cut({ from: 2n })).toThrow(/'from', 'to'/)
	})

	it("still refuses an unknown label", () => {
		let cut = defaults.exports.cut as (...args: Array<unknown>) => bigint

		expect(() => cut({ to: 7n, around: 1n })).toThrow(/'from', 'to'/)
	})

	// A Descriptor without the `optional` field reads every Parameter as
	// required.
	it("reads a descriptor with no `optional` field as all required", async () => {
		let defaults = await loadModule(clientFixture("Defaults.es"), {
			cacheDirectory,
		})
		let described = describeModule(defaults.surface, defaults.entryPath)
		let signature = described.exports["scaled"]

		if (signature?.kind !== "function") {
			throw new Error("Expected a function export")
		}

		// The same Descriptor with the field taken out.
		let older = {
			exports: {
				scaled: {
					...signature,
					of: {
						...signature.of,
						parameters: signature.of.parameters.map(
							({ label, of }) => ({ label, of }),
						),
					},
				},
			},
		}

		let interpreter = createInterpreter(defaults.bridge, older)
		let scaled = interpreter.wrapFunction(
			defaults.raw.scaled as never,
			older.exports.scaled.of,
			"scaled",
		) as (...args: Array<unknown>) => bigint

		expect(scaled(21n, 3n)).toBe(63n)
		expect(() => scaled(21n)).toThrow(/takes 2 Arguments/)
	})
})

// A Record Parameter whose default fills some members in. The host may leave
// those out, and the callee's prologue puts them back.
describe("Leaving out a member the callee fills in", () => {
	let defaults: EssenceModule

	beforeAll(async () => {
		defaults = await loadModule(clientFixture("Defaults.es"), {
			cacheDirectory,
		})
	})

	type Connect = (
		url: string,
		options: { host: string; retries?: bigint; secure: boolean },
	) => string

	it("takes a Record the default completes", () => {
		let connect = defaults.exports.connect as Connect

		expect(connect("a", { host: "h", secure: true })).toBe("a|h|3|true")
	})

	it("takes a Record that writes every member", () => {
		let connect = defaults.exports.connect as Connect

		expect(connect("a", { host: "h", retries: 9n, secure: false })).toBe(
			"a|h|9|false",
		)
	})

	// A member written `undefined` is written, and no Integer admits it.
	it("refuses a member written as undefined", () => {
		let connect = defaults.exports.connect as (
			...args: Array<unknown>
		) => string

		expect(() =>
			connect("a", { host: "h", retries: undefined, secure: true }),
		).toThrow(EssenceMarshalError)
	})

	it("still refuses a member the default does not fill in", () => {
		let connect = defaults.exports.connect as (
			...args: Array<unknown>
		) => string

		expect(() => connect("a", { host: "h" })).toThrow(EssenceMarshalError)
	})

	// The Record is still closed.
	it("still refuses a member the Type does not name", () => {
		let connect = defaults.exports.connect as (
			...args: Array<unknown>
		) => string

		expect(() =>
			connect("a", { host: "h", secure: true, timeout: 30n }),
		).toThrow(/timeout/)
	})

	// The Argument itself is still required.
	it("still requires the Argument itself", () => {
		let connect = defaults.exports.connect as (
			...args: Array<unknown>
		) => string

		expect(() => connect("a")).toThrow(/takes 2 Arguments/)
	})

	// A member without the `optional` field reads as required too.
	it("reads a member with no `optional` field as required", async () => {
		let described = describeModule(defaults.surface, defaults.entryPath)
		let signature = described.exports["connect"]

		if (signature?.kind !== "function") {
			throw new Error("Expected a function export")
		}

		let options = signature.of.parameters[1]!.of

		if (options.kind !== "record") {
			throw new Error("Expected a Record Parameter")
		}

		// The same Descriptor with the field taken out.
		let older = {
			exports: {
				connect: {
					...signature,
					of: {
						...signature.of,
						parameters: [
							signature.of.parameters[0]!,
							{
								...signature.of.parameters[1]!,
								of: {
									...options,
									members: Object.fromEntries(
										Object.entries(options.members).map(
											([name, member]) => [
												name,
												{ of: member.of },
											],
										),
									),
								},
							},
						],
					},
				},
			},
		}

		let interpreter = createInterpreter(defaults.bridge, older)
		let connect = interpreter.wrapFunction(
			defaults.raw.connect as never,
			older.exports.connect.of,
			"connect",
		) as (...args: Array<unknown>) => string

		expect(connect("a", { host: "h", retries: 9n, secure: true })).toBe(
			"a|h|9|true",
		)
		expect(() => connect("a", { host: "h", secure: true })).toThrow(
			EssenceMarshalError,
		)
	})
})

// A Case is built where it is written, with no callee to fill a default in, so
// the boundary fills in a payload default.
describe("Leaving out a member a Case payload's default fills in", () => {
	let defaults: EssenceModule

	beforeAll(async () => {
		defaults = await loadModule(clientFixture("Defaults.es"), {
			cacheDirectory,
		})
	})

	let fetched = () =>
		defaults.exports.fetched as (...args: Array<unknown>) => string

	it("fills every member the payload left out", () => {
		expect(fetched()({ $case: "Fetch#Get", url: "/a" })).toBe(
			"/a|0|0|Accept|10|quiet",
		)
	})

	it("leaves a member the payload wrote alone", () => {
		expect(
			fetched()({
				$case: "Fetch#Get",
				url: "/a",
				retries: 3n,
				tags: ["x", "y"],
				headers: ["X-Trace"],
				limits: { calls: 1n },
				mode: "Verbose",
			}),
		).toBe("/a|3|2|X-Trace|1|loud")
	})

	it("takes a payload built by the Case constructor", () => {
		let Fetch = defaults.exports.Fetch as {
			Get: (payload: { url: string }) => unknown
		}

		expect(fetched()(Fetch.Get({ url: "/b" }))).toBe(
			"/b|0|0|Accept|10|quiet",
		)
	})

	// `headers` defaults to a Constant, whose value the Case Type carries, so it
	// is filled like a literal.
	it("fills a member whose default names a Constant", () => {
		expect(fetched()({ $case: "Fetch#Get", url: "/a" })).toContain(
			"|Accept|",
		)
	})

	it("refuses a member filled from a Constant written as undefined", () => {
		expect(() =>
			fetched()({ $case: "Fetch#Get", url: "/a", headers: undefined }),
		).toThrow(EssenceMarshalError)
	})

	// A member written `undefined` is written, as at a Record Parameter.
	it("refuses a member written as undefined", () => {
		expect(() =>
			fetched()({ $case: "Fetch#Get", url: "/a", retries: undefined }),
		).toThrow(EssenceMarshalError)
	})

	it("still refuses a member the default does not fill in", () => {
		expect(() => fetched()({ $case: "Fetch#Get" })).toThrow(
			EssenceMarshalError,
		)
	})

	// The payload is still closed.
	it("still refuses a member the payload does not name", () => {
		expect(() =>
			fetched()({ $case: "Fetch#Get", url: "/a", timeout: 30n }),
		).toThrow(/timeout/)
	})

	// A Case coming back out carries every member.
	it("hands every member back out", () => {
		let blank = defaults.exports.blank as () => Record<string, unknown>

		expect(blank()).toEqual({
			$case: "Fetch#Get",
			url: "/",
			retries: 0n,
			tags: [],
			headers: ["Accept"],
			limits: { calls: 10n },
			mode: "Quiet",
		})
	})
})
