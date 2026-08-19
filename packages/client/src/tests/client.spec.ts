import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
	mkdirSync,
	mkdtempSync,
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

// NOTE: Every load in this file caches into a directory of its own, so that a
// run touches neither the developer's real cache nor another test's.
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

// NOTE: A project on disk in a directory of its own, removed again — for the
// tests that need to EDIT a source and see what changes.
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

// NOTE: The `modules` fixture prints three lines as its body runs, and importing
// the bundle is what runs it. Both doors are held: `print` writes to the stream
// and `inspect` ends its line through `console.log`, so a harness holding one of
// the two reads half a Program as silent.
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

		// NOTE: The BUNDLE's own value, read without marshalling it — so what
		// it holds is the hybrid Integer's own representation, a number for
		// anything a double carries exactly. `toJS` is what makes an Integer a
		// bigint on the way out, and this call deliberately does not go
		// through it.
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

	// NOTE: And the same constant as JavaScript, which is what a host that never
	// wants to know about a Type key came for. The parts are held UNREDUCED by
	// the runtime — `314/100` is what the source wrote — and reduced on the way
	// out, because a Rational on this side has one spelling per value.
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

		// NOTE: The fixture's own body runs as the bundle is imported, which is
		// what a Module being a Program rather than a header means.
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

	// NOTE: `Rectangle` is a Type Alias AND the Namespace of the same name, so
	// its kind reads `type` while it is very much a value in the bundle. Binding
	// off `kinds` would have left it out.
	it("binds a Namespace whose kind reads as a Type", async () => {
		let { result: main } = await captured(() =>
			loadModule(fixturePath("modules", "Main.es"), { cacheDirectory }),
		)

		expect(Object.keys(main.raw).sort()).toEqual(["Rectangle", "describe"])
		expect(main.surface.kinds.Rectangle).toBe("type")
		expect(typeof main.raw.Rectangle).toBe("function")
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
	// NOTE: THE reason the bridge exists. The Type key is a Symbol minted while
	// the bundle is evaluated, so this process's own copy of the runtime holds a
	// different one — a host that read values with it would find nothing on any
	// of them.
	it("hands out the bundle's own Type key rather than this process's", async () => {
		let math = await loadModule(fixturePath("modules", "math", "Math.es"), {
			cacheDirectory,
		})

		expect(typeof math.bridge.typeKey).toBe("symbol")
		expect(math.bridge.typeKey).not.toBe(typeKeySymbol)
		expect(math.bridge.typeKey.description).toBe("$type")
	})

	// NOTE: The bridge is the bundle's DEFAULT export, which is the one name it
	// can not take from the Module: `export * from` never carries a default, and
	// no Essence export is emitted as one — the Rewriter escapes every reserved
	// word with a `_`. `Escaped.es` is the fixture that tries hardest to collide,
	// down to a `constant $$integer`, and its own bindings are untouched.
	it("names itself out of reach of an Essence export", async () => {
		let escaped = await loadModule(clientFixture("Escaped.es"), {
			cacheDirectory,
		})
		let userConstant = escaped.raw.$$integer as EssenceValue

		expect(tagOf(escaped.bridge, userConstant)).toBe("Integer")
		expect(fieldOf(userConstant, "value")).toBe(12)
	})

	// NOTE: The runtime's `createList` TAKES OWNERSHIP of the Array it is given
	// — a List may push onto it in place rather than copy it — and a host's
	// Array is not the host's to give away by calling a Function. The bridge
	// therefore hands out `createListFrom`, which copies, and this is the test
	// that says so: `grown` prepends and appends, and neither may reach the
	// Array the host still holds.
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
	// NOTE: The failure the bridge exists to prevent, named where it can not
	// be prevented: a value built by one bundle handed to another. Nothing on
	// the value says it is wrong — it IS an Integer, tagged as one, by a Symbol
	// this Module has never seen — so it would be refused as "an object with
	// 'value'", which is true and sends a host looking in the wrong place. The
	// two ways it happens are a Module loaded AGAIN after an edit with a value
	// from the load before still in hand, and two Modules that never shared a
	// runtime; the interpreter remembers every Type key it was built over and
	// names the value as what it is.
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

	// NOTE: This process's own runtime as well — the copy a host reaches by
	// importing `@essence-lang/runtime` itself, which no interpreter was ever
	// built over. Its key is recognised by its description, so a host that
	// built a value the direct way is told the same thing.
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
		// NOTE: The excerpt, the underline and the tally — the whole report
		// rather than the headline of one.
		expect(compileError.message).toContain("Broken.es:4:6")
		expect(compileError.message).toContain('<- value::multiply(with "two")')
		expect(compileError.message).toContain("1 error")
		// NOTE: Plain. An Error's message is read out of logs and assertions at
		// least as often as off a terminal.
		expect(compileError.message).not.toContain("[")
	})

	// NOTE: One block per file against that file's own source. A dependency's
	// Diagnostic rendered against the entry's text would underline whatever
	// happens to be written at that line number in the wrong file.
	it("renders a dependency's Diagnostic against the dependency", async () => {
		await withProject(
			{
				"Main.es": `import {
	broken from "./Dep.es"
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
				).toEqual(["Dep.es"])
				expect(compileError.message).toContain("<- 1")
			},
		)
	})
})

// NOTE: The listeners a watcher is given, with a way to WAIT for the next of
// each — a test that edited a file has nothing else to do until the watcher has
// seen it, and a watcher that never does should fail the test rather than hang
// it.
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
		new Promise((resolve, reject) => {
			let timeout = setTimeout(
				() => reject(new Error(`No ${what} arrived within 5 seconds.`)),
				5000,
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
	square from "./Math.es"
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
					// NOTE: The first load arrives BEFORE `watchModule` answers,
					// which is what lets a host read `module` straight away.
					expect(heard.modules).toHaveLength(1)
					expect(watcher.module).toBe(heard.modules[0]!)
					expect(watcher.module!.exports.answer).toBe(4n)
					expect(watcher.files).toEqual(
						[
							path.join(directory, "Main.es"),
							path.join(directory, "Math.es"),
						].sort(),
					)

					// NOTE: An edit to what the entry IMPORTS, not to the entry
					// — the file that changes is rarely the one that was asked
					// for, and a watcher on the entry alone would sit still.
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
					// NOTE: The Module before the edit is untouched — a host
					// still holding it holds a working Module.
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

					// NOTE: And the fix is the next thing heard.
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

	// NOTE: A save that changes nothing — the same text written again — moves
	// the file's time and nothing else. It is loaded, because only the load can
	// tell, and NOT reported, because what it loaded is the bundle already held.
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
					// NOTE: Watched even though nothing compiled — the graph as
					// far as it was read is what the fix will land in.
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

	// NOTE: The one thing a reload can not carry over, named. A raw value from
	// the load before the edit is tagged by THAT bundle's key; the load after
	// has a key of its own, and refuses the value as what it is rather than as a
	// plain object — see "A value from another copy of the runtime".
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
							'export {\n\tsquare from "./Math.es"\n\tanswer',
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

			// NOTE: Not rewritten — the name is the hash of the sources, so the
			// file that is there is already the answer. Rewriting it would only
			// invalidate the Module every holder has already imported.
			expect((await stat(file)).mtimeMs).toBe(before)
			expect(await readdir(directory)).toEqual(bundles)
			// NOTE: And the same file was imported: the same URL is the same
			// Module, so the Program inside a bundle is evaluated once.
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

	// NOTE: The file's NAME is what makes the cache worth having: `loadModule`
	// asks for it before it emits anything, and only compiles where nothing on
	// disk answers. That only works while the hash it looks the file up by is the
	// same hash the compile would have written it under — an option set on one
	// side and not the other leaves the fast path permanently cold and says
	// nothing about it.
	it("names the bundle by a hash it can compute without emitting", async () => {
		await withProject({}, async (directory) => {
			let entry = fixturePath("modules", "math", "Math.es")

			await loadModule(entry, { cacheDirectory: directory })

			let linked = linkToMemory(entry, { emitterKey: BRIDGE_KEY })

			expect(
				(await readdir(directory)).filter((name) =>
					name.endsWith(".mjs"),
				),
			).toEqual([`${linked.bundleHash}.mjs`])
		})
	})

	// NOTE: The bridge is bytes the sources do not say, so a bundle built with it
	// and one built without it can not be one file — otherwise whichever was
	// written first answers for both, and the loser is either a plugin build
	// handed exports it never asked for or a `loadModule` told the bundle "was
	// not built through the runtime bridge".
	it("names a bridged bundle apart from a plain one", async () => {
		let entry = fixturePath("modules", "math", "Math.es")
		let plain = linkToMemory(entry)
		let bridged = linkToMemory(entry, { emitterKey: BRIDGE_KEY })

		expect(bridged.bundleHash).not.toBe(plain.bundleHash)
	})
})

// NOTE: A JavaScript call may leave out what an Essence call may — the arity
// gate is a range and the label gate asks for the REQUIRED labels, and the
// emitted default parameter fills the rest.
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

	// NOTE: A required Argument is still required, and the refusal names the
	// RANGE the signature accepts rather than one count nobody has to pass.
	it("still refuses a call that leaves a required Argument out", () => {
		let cut = defaults.exports.cut as (...args: Array<unknown>) => bigint

		expect(() => cut()).toThrow(/takes 1 to 2 Arguments/)
	})

	// NOTE: WHICH Parameters a positional call stops before is the question,
	// never how many. `cut(7n)` writes as many Arguments as the range allows and
	// still leaves the REQUIRED `to` out — counted, it was admitted and the hole
	// was padded onto `to`, which reached the emitted Function as `undefined`
	// and died inside it rather than at the boundary.
	it("refuses a positional call that stops before a required Parameter", () => {
		let cut = defaults.exports.cut as (...args: Array<unknown>) => bigint

		expect(() => cut(7n)).toThrow(EssenceCallError)
		expect(() => cut(7n)).toThrow(/takes 1 to 2 Arguments/)
	})

	// NOTE: The `.d.ts` types an omittable label as `label?: T` and an interior
	// one as `T | undefined`, and TypeScript's `?` admits an explicit
	// `undefined` — so a call writing one is a call the declaration says is
	// legal, and it means the same as leaving the key out.
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

	// NOTE: And a required slot is untouched by that — `undefined` there is a
	// value the host passed, and no Essence Type admits it.
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

	// NOTE: `optional` is a WIRE format field, written to `<output>.descriptor
	// .json` and inlined as JSON into generated wrappers — so a sidecar written
	// before defaults existed has to keep loading, and every Parameter in it has
	// to keep meaning "required". Absence reads as required, which is what makes
	// that true; this is the test that says so out loud.
	it("reads a descriptor with no `optional` field as all required", async () => {
		let defaults = await loadModule(clientFixture("Defaults.es"), {
			cacheDirectory,
		})
		let described = describeModule(defaults.surface, defaults.entryPath)
		let signature = described.exports["scaled"]

		if (signature?.kind !== "function") {
			throw new Error("Expected a function export")
		}

		// NOTE: The old sidecar, made by taking the field back out.
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

// NOTE: A Record Parameter whose default fills SOME of its members in. The
// Argument is still required and every member the default does not fill in has
// to be written — what a host gains is the right to leave the rest out, and the
// callee's own prologue is what puts them back.
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

	// NOTE: A member written `undefined` is a member WRITTEN — the default is
	// for a caller that said nothing, and this caller said something no Integer
	// admits.
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

	// NOTE: The Record is still CLOSED — a member the Type does not name is a
	// misspelling in the making, and leaving one out is not permission to add
	// another.
	it("still refuses a member the Type does not name", () => {
		let connect = defaults.exports.connect as (
			...args: Array<unknown>
		) => string

		expect(() =>
			connect("a", { host: "h", secure: true, timeout: 30n }),
		).toThrow(/timeout/)
	})

	// NOTE: The whole Argument is NOT omittable — a partial default fills in
	// members, never a value — so the arity gate is unmoved.
	it("still requires the Argument itself", () => {
		let connect = defaults.exports.connect as (
			...args: Array<unknown>
		) => string

		expect(() => connect("a")).toThrow(/takes 2 Arguments/)
	})

	// NOTE: `optional` is a WIRE format field on a member exactly as it is on a
	// Parameter, and absence reads as required there too — a sidecar written
	// before Record defaults existed has to keep loading and keep meaning what
	// it always meant.
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

		// NOTE: The old sidecar, made by taking the field back out.
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

// NOTE: The other position a member may be left out at, and the one that has to
// carry its own values across: a Record Parameter's default is written in by the
// CALLEE, while a Case is BUILT where it is written — a constructor writes the
// tag onto what it was handed and marshals nothing — so the boundary itself is
// where a Case payload's default is filled in.
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
			"/a|0|0|10|quiet",
		)
	})

	it("leaves a member the payload wrote alone", () => {
		expect(
			fetched()({
				$case: "Fetch#Get",
				url: "/a",
				retries: 3n,
				tags: ["x", "y"],
				limits: { calls: 1n },
				mode: "Verbose",
			}),
		).toBe("/a|3|2|1|loud")
	})

	it("takes a payload built by the Case constructor", () => {
		let Fetch = defaults.exports.Fetch as {
			Get: (payload: { url: string }) => unknown
		}

		expect(fetched()(Fetch.Get({ url: "/b" }))).toBe("/b|0|0|10|quiet")
	})

	// NOTE: A member written `undefined` is a member WRITTEN, exactly as at a
	// Record Parameter — the default is for a host that said nothing.
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

	// NOTE: The payload is still CLOSED — leaving a member out is not
	// permission to add another.
	it("still refuses a member the payload does not name", () => {
		expect(() =>
			fetched()({ $case: "Fetch#Get", url: "/a", timeout: 30n }),
		).toThrow(/timeout/)
	})

	// NOTE: The filled members are the Module's own values, so a Case coming
	// back OUT carries all of them whether a host wrote them or not.
	it("hands every member back out", () => {
		let blank = defaults.exports.blank as () => Record<string, unknown>

		expect(blank()).toEqual({
			$case: "Fetch#Get",
			url: "/",
			retries: 0n,
			tags: [],
			limits: { calls: 10n },
			mode: "Quiet",
		})
	})
})
