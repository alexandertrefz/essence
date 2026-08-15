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

import { linkToMemory } from "@essence-lang/compiler/embed"
import { fixturePath } from "@essence-lang/fixtures"
import { typeKeySymbol } from "@essence-lang/runtime/type"

import {
	BRIDGE_EXPORTS,
	BRIDGE_KEY,
	type EssenceValue,
	type RuntimeBridge,
} from "../bridge"
import { EssenceCompileError } from "../errors"
import { type EssenceModule, loadModule } from "../index"
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
		expect(written.trimEnd().split("\n")).toEqual([
			"area: 12",
			"25",
			"157/1",
		])

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

	// NOTE: `export * from` LOSES to an explicit export of the same name, so a
	// bridge name a Module could also export would take that Module's binding
	// away without a word. `$` is an ordinary Essence identifier character —
	// `constant $$integer` compiles — and `_` is a Lexer Symbol, which is what
	// makes the `$bridge_` names unreachable from Essence and this safe.
	it("names itself out of reach of an Essence export", async () => {
		let escaped = await loadModule(clientFixture("Escaped.es"), {
			cacheDirectory,
		})
		let userConstant = escaped.raw.$$integer as EssenceValue

		for (let name of Object.values(BRIDGE_EXPORTS)) {
			expect(name).toContain("_")
		}

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
