import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { readFile, readdir, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

import { fixturePath } from "@essence-lang/fixtures"
import * as esbuild from "esbuild"

import { EssenceCompileError } from "../compile-error"
import { essenceEsbuild } from "../esbuild-plugin"
import { declarationsPath, PRELUDE_ID, rawSpecifier } from "../plugin-core"
import { essence, type PluginContext } from "../vite-plugin"
import { REPOSITORY, typecheck } from "./typecheck"

const MATH_MODULE = `implementation {

	constant PI = 314/100

	function squared(_ value: Integer) -> Integer {
		<- value::multiply(with value)
	}
}

export {
	PI
	squared as square
}
`

// Work, which crosses only as a call's answer, as a `Promise`.
const ASYNC_MODULE = `implementation {

	function doubled(_ value: Integer) -> Future<Integer> {
		<- complete Async.deferred(() { <- value::multiply(with 2) })
	}
}

export {
	doubled
}
`

// The shapes a declaration file spells and a consumer writes. No Rational, so
// the generated file borrows nothing from this package.
const SHAPES_MODULE = `implementation {

	choice Shape {
		Circle { radius: Integer },
		Blank,
	}

	choice Direction {
		Up,
		Down,
	}

	type Box = { width: Integer, height: Integer }

	function areaOf(_ value: Shape) -> Integer {
		<- match value -> Integer {
			case #Circle { <- @.radius::multiply(with @.radius) }
			case #Blank  { <- 0 }
		}
	}

	function widen(box: Box, by amount: Integer) -> Box {
		<- { width = box.width::add(amount), height = box.height }
	}

	function named(_ value: Optional<String>) -> String {
		<- value::value(defaultingTo "unnamed")
	}

	function turn(_ direction: Direction) -> Direction {
		<- match direction -> Direction {
			case #Up   { <- #Down }
			case #Down { <- #Up }
		}
	}

	constant blank: Shape = #Blank
}

export {
	Box
	Direction
	Shape
	areaOf
	blank
	named
	turn
	widen
}
`

let workspace = ""

beforeAll(() => {
	workspace = realpathSync.native(
		mkdtempSync(path.join(tmpdir(), "essence-plugin-")),
	)
})

afterAll(() => {
	rmSync(workspace, { recursive: true, force: true })
})

// A project per test, since some write files beside their sources. This
// package is installed in it, because the host resolves what a wrapper imports
// by name.
function project(files: Record<string, string>): string {
	let directory = realpathSync.native(
		mkdtempSync(path.join(workspace, "project-")),
	)
	let scope = path.join(directory, "node_modules", "@essence-lang")

	mkdirSync(scope, { recursive: true })

	// The client and the runtime, symlinked into `node_modules`.
	for (let name of ["client", "runtime"]) {
		symlinkSync(
			path.join(REPOSITORY, "packages", name),
			path.join(scope, name),
			"dir",
		)
	}

	for (let [name, source] of Object.entries(files)) {
		let filePath = path.join(directory, name)

		mkdirSync(path.dirname(filePath), { recursive: true })
		writeFileSync(filePath, source)
	}

	return directory
}

// The context a hook is called with. Only the optional `addWatchFile` is used.
function context(): PluginContext & { watched: Array<string> } {
	let watched: Array<string> = []

	return {
		watched,
		addWatchFile(id: string) {
			watched.push(id)
		},
	}
}

async function build(
	directory: string,
	entry: string,
): Promise<esbuild.BuildResult> {
	return await esbuild.build({
		entryPoints: [path.join(directory, entry)],
		bundle: true,
		write: false,
		format: "esm",
		plugins: [essenceEsbuild()],
	})
}

// The built output, written under a name of its own and imported, since a
// Module is identified by its URL.
async function built(
	directory: string,
	entry: string,
	name: string,
): Promise<Record<string, unknown>> {
	let result = await build(directory, entry)

	expect(result.errors).toEqual([])

	let output = path.join(directory, name)

	await writeFile(output, result.outputFiles![0]!.text)

	return (await import(pathToFileURL(output).href)) as Record<string, unknown>
}

describe("The esbuild plugin", () => {
	// A `bigint` goes in and a `bigint` comes back.
	it("serves an imported `.es` file as marshalled JavaScript", async () => {
		let directory = project({
			"Math.es": MATH_MODULE,
			"entry.js": `import { PI, square } from "./Math.es"

export const squared = square(12n)
export const pi = PI
`,
		})
		let bundle = await built(directory, "entry.js", "out.mjs")
		let pi = bundle.pi as {
			numerator: bigint
			denominator: bigint
			toString: () => string
		}

		expect(bundle.squared).toBe(144n)
		// Read by its parts, since the build holds its own copy of the class.
		expect(pi.numerator).toBe(157n)
		expect(pi.denominator).toBe(50n)
		expect(pi.toString()).toBe("157/50")
	})

	// Only a spec counts List work, so the build defines the flag false and
	// nothing of the count is left.
	it("drops the List work count from what it builds", async () => {
		let directory = project({
			"Lists.es": `implementation {
	function grown(_ count: Integer) -> List<Integer> {
		<- [1, 2]::prepend(count)::remove(at 1)
	}
}

export {
	grown
}
`,
			"entry.js": `import { grown } from "./Lists.es"

export const lengths = grown(3n).length
`,
		})
		let result = await build(directory, "entry.js")

		expect(result.errors).toEqual([])
		expect(result.outputFiles![0]!.text).not.toContain(
			"essenceCountsListWork",
		)
	})

	// The entry awaits work. The wrapper, the interpreter and `Future.ts` must
	// be the copies the host resolved, or the answer would be refused.
	it("answers a call with a promise a build can await", async () => {
		let directory = project({
			"Async.es": ASYNC_MODULE,
			"entry.js": `import { doubled } from "./Async.es"

export const doubling = doubled(21n)
`,
		})
		let bundle = await built(directory, "entry.js", "async.mjs")

		expect(await (bundle.doubling as Promise<bigint>)).toBe(42n)
	})

	// The wrapper's baked tag must match the bundle's entry-relative tag, or
	// `areaOf` would answer 0 without an error.
	it("carries a Choice across as a discriminated union", async () => {
		let directory = project({
			"Shapes.es": SHAPES_MODULE,
			"entry.js": `import { areaOf, blank, named, widen } from "./Shapes.es"

export const area = areaOf({ $case: "Shape#Circle", radius: 3n })
export const empty = blank
export const wider = widen({ width: 1n, height: 2n }, 3n)
export const label = named(undefined)
`,
		})
		let bundle = await built(directory, "entry.js", "shapes.mjs")

		expect(bundle.area).toBe(9n)
		expect(bundle.empty).toEqual({ $case: "Shape#Blank" })
		expect(bundle.wider).toEqual({ width: 4n, height: 2n })
		expect(bundle.label).toBe("unnamed")
	})

	// The wrapper exports the Choice's constructors, built from its Descriptor.
	it("serves a Choice as the constructors its Cases are spelled with", async () => {
		let directory = project({
			"Shapes.es": SHAPES_MODULE,
			"entry.js": `import { areaOf, Shape } from "./Shapes.es"

export const area = areaOf(Shape.Circle({ radius: 4n }))
export const empty = Shape.Blank
`,
		})
		let bundle = await built(directory, "entry.js", "shapes.mjs")

		expect(bundle.area).toBe(16n)
		expect(bundle.empty).toEqual({ $case: "Shape#Blank" })
	})

	// `unitChoice` must survive the Descriptor baked into the wrapper. `turn`
	// flips its Argument, so the answer is a string the entry never wrote.
	it("carries a unit Choice across as the bare Case name", async () => {
		let directory = project({
			"Shapes.es": SHAPES_MODULE,
			"entry.js": `import { Direction, turn } from "./Shapes.es"

export const down = turn("Up")
export const up = turn(Direction.Down)
export const qualified = turn("Direction#Down")
export const table = Direction
`,
		})
		let bundle = await built(directory, "entry.js", "compass.mjs")

		expect(bundle.down).toBe("Down")
		expect(bundle.up).toBe("Up")
		expect(bundle.qualified).toBe("Up")
		expect(bundle.table).toEqual({ Up: "Up", Down: "Down" })
	})

	it("builds a `.es` file that imports another", async () => {
		let directory = project({
			"Main.es": `import {
	from "./Math.es" { square }
}

implementation {
	function twice(_ value: Integer) -> Integer {
		<- square(value)::multiply(with 2)
	}
}

export {
	twice
}
`,
			"Math.es": MATH_MODULE,
			"entry.js": `import { twice } from "./Main.es"

export const answer = twice(5n)
`,
		})
		let bundle = await built(directory, "entry.js", "graph.mjs")

		expect(bundle.answer).toBe(50n)
	})

	// A `.es` file outside the project still resolves the packages it imports,
	// from the build's root.
	it("resolves what a Module imports from the build's own root", async () => {
		let directory = project({
			"entry.js": `import { square } from "../shared/Math.es"

export const squared = square(12n)
`,
		})
		let shared = path.join(directory, "..", "shared")

		mkdirSync(shared, { recursive: true })
		writeFileSync(path.join(shared, "Math.es"), MATH_MODULE)

		let result = await esbuild.build({
			entryPoints: [path.join(directory, "entry.js")],
			bundle: true,
			write: false,
			format: "esm",
			absWorkingDir: directory,
			plugins: [essenceEsbuild()],
		})

		expect(result.errors).toEqual([])

		let output = path.join(directory, "shared.mjs")

		await writeFile(output, result.outputFiles![0]!.text)

		let bundle = (await import(pathToFileURL(output).href)) as Record<
			string,
			unknown
		>

		expect(bundle.squared).toBe(144n)
	})

	// `?raw` serves the emitted Module. Values for it come from the same
	// `@essence-lang/runtime` the Module imports.
	it("serves the emitted Module behind `?raw`", async () => {
		let directory = project({
			"Math.es": MATH_MODULE,
			"entry.js": `import { square } from "./Math.es?raw"
import { createInteger } from "@essence-lang/runtime/Integer"
import { typeKeySymbol } from "@essence-lang/runtime/type"

export const squared = square(createInteger(12))
export const typeKey = typeKeySymbol
`,
		})
		let bundle = await built(directory, "entry.js", "raw.mjs")
		let typeKey = bundle.typeKey as symbol
		let squared = bundle.squared as Record<symbol, unknown> & {
			value: number
		}

		expect(squared[typeKey]).toBe("Integer")
		expect(squared.value).toBe(144)
	})

	// One Module and one runtime behind both doors.
	it("serves one Module to the marshalled door and the raw one", async () => {
		let directory = project({
			"Math.es": MATH_MODULE,
			"entry.js": `import { square } from "./Math.es"
import { square as rawSquare } from "./Math.es?raw"
import { createInteger } from "@essence-lang/runtime/Integer"
import { typeKeySymbol } from "@essence-lang/runtime/type"

export const marshalled = square(12n)
export const raw = rawSquare(createInteger(12))
export const typeKey = typeKeySymbol
`,
		})
		let result = await build(directory, "entry.js")
		let text = result.outputFiles![0]!.text

		expect(result.errors).toEqual([])
		// A sentence only the runtime's Integer says, once.
		expect(
			text.split("is not an Integer a number can hold").length - 1,
		).toBe(1)

		let output = path.join(directory, "doors.mjs")

		await writeFile(output, text)

		let bundle = (await import(pathToFileURL(output).href)) as Record<
			string,
			unknown
		>
		let raw = bundle.raw as Record<symbol, unknown> & { value: number }

		expect(bundle.marshalled).toBe(144n)
		expect(raw[bundle.typeKey as symbol]).toBe("Integer")
		expect(raw.value).toBe(144)
	})

	// `ok?` is exported under a string literal.
	it("exports a name JavaScript can not spell", async () => {
		let directory = project({
			"Escaped.es": `implementation {

	constant $$integer = 12

	function ok?(_ value: Boolean) -> Boolean {
		<- value
	}
}

export {
	$$integer
	ok?
}
`,
			"entry.js": `import { "ok?" as ok, $$integer } from "./Escaped.es"

export const answer = ok(true)
export const twelve = $$integer
`,
		})
		let bundle = await built(directory, "entry.js", "escaped.mjs")

		expect(bundle.answer).toBe(true)
		expect(bundle.twelve).toBe(12n)
	})

	// `bind`, `$raw` and `$module` are the wrapper's names and valid Essence
	// ones, so every export takes an alias.
	it("exports names the wrapper itself binds", async () => {
		let directory = project({
			"Collide.es": `implementation {

	constant $module = 1

	constant $raw = 2

	function bind(_ value: Integer) -> Integer {
		<- value::multiply(with 2)
	}
}

export {
	$module
	$raw
	bind
}
`,
			"entry.js": `import { bind, $module, $raw } from "./Collide.es"

export const doubled = bind(21n)
export const values = [$module, $raw]
`,
		})
		let bundle = await built(directory, "entry.js", "collide.mjs")

		expect(bundle.doubled).toBe(42n)
		expect(bundle.values).toEqual([1n, 2n])
	})

	it("reports a Module that does not compile as a build failure", async () => {
		let directory = project({
			"Broken.es": `implementation {
	constant value: Integer = "twelve"
}

export {
	value
}
`,
			"entry.js":
				'import { value } from "./Broken.es"\n\nexport { value }\n',
		})
		let failure = await esbuild
			.build({
				entryPoints: [path.join(directory, "entry.js")],
				bundle: true,
				write: false,
				format: "esm",
				// The report is under test, so esbuild prints nothing.
				logLevel: "silent",
				plugins: [essenceEsbuild()],
			})
			.catch((thrown: unknown) => thrown as esbuild.BuildFailure)

		expect(failure).toBeInstanceOf(Error)
		expect((failure as esbuild.BuildFailure).errors[0]?.text).toContain(
			"[assignment-type-mismatch]",
		)
	})

	// Two entries of one graph share one `Geometry.es`, one prelude and one
	// runtime, so a value passes between them.
	it("passes a value between two entries of one Module graph", async () => {
		let modules = fixturePath("modules")
		let directory = project({
			"entry.js": `import { describe } from ${JSON.stringify(
				path.join(modules, "Main.es"),
			)}
import { Rectangle } from ${JSON.stringify(path.join(modules, "Geometry.es"))}

export const described = describe(Rectangle.of(3n, 4n))
`,
		})
		let result = await build(directory, "entry.js")
		let text = result.outputFiles![0]!.text

		expect(result.errors).toEqual([])
		// One Type key, one runtime Integer and one prelude.
		expect(text.split('Symbol("$type")').length - 1).toBe(1)
		expect(
			text.split("is not an Integer a number can hold").length - 1,
		).toBe(1)
		expect(
			text.split("$es_Integer_multiply__overload$2 =").length - 1,
		).toBe(1)

		let output = path.join(directory, "entries.mjs")

		await writeFile(output, text)

		// `Main.es` prints as it is imported, so the output is captured.
		let printed = ""
		let write = process.stdout.write

		process.stdout.write = ((chunk: unknown) => {
			printed += String(chunk)

			return true
		}) as typeof process.stdout.write

		try {
			let bundle = (await import(pathToFileURL(output).href)) as Record<
				string,
				unknown
			>

			expect(bundle.described).toBe("area: 12")
		} finally {
			process.stdout.write = write
		}

		expect(printed).toContain("area: 12")
	})

	// Two entries that share no source compile as two Programs.
	it("compiles two entries that share no source", async () => {
		let directory = project({
			"Math.es": MATH_MODULE,
			"Other.es": `implementation {

	function tripled(_ value: Integer) -> Integer {
		<- value::multiply(with 3)
	}
}

export {
	tripled
}
`,
			"entry.js": `import { square } from "./Math.es"
import { tripled } from "./Other.es"

export const squared = square(12n)
export const trebled = tripled(4n)
`,
		})
		let bundle = await built(directory, "entry.js", "twoGraphs.mjs")

		expect(bundle.squared).toBe(144n)
		expect(bundle.trebled).toBe(12n)
	})
})

describe("The wrapper a build imports", () => {
	async function wrapper(
		options: Parameters<typeof essence>[0] = {},
	): Promise<string> {
		let directory = project({ "Math.es": MATH_MODULE })
		let plugin = essence({ declarations: false, ...options })
		let code = await plugin.load.call(
			context(),
			path.join(directory, "Math.es"),
		)

		return code ?? ""
	}

	// The wrapper imports its Module, the interpreter and the runtime, the last
	// by the name the Module uses, so they share one Type key.
	it("imports the Module, the interpreter and the runtime", async () => {
		let code = await wrapper()

		expect(code).toContain('import * as $raw from "essence-raw:')
		expect(code).toContain(
			'import { bind } from "@essence-lang/client/marshal-runtime"',
		)
		expect(code).toContain(
			'import * as $runtime_type from "@essence-lang/runtime/type"',
		)
		expect(code).toContain("typeKey: $runtime_type.typeKeySymbol,")
		expect(code).toContain("integer: $runtime_Integer.createIntegerFrom,")
		expect(code).toContain('const $export_PI = $module["PI"]')
		expect(code).toContain("export { $export_PI as PI }")
		expect(code).toContain("export { $export_square as square }")
	})

	// The Dictionary door is imported only where the boundary names one.
	it("imports the Dictionary door only where the boundary names one", async () => {
		let plain = await wrapper()

		expect(plain).not.toContain("@essence-lang/runtime/Dictionary")
		expect(plain).not.toContain("dictionary:")

		let directory = project({
			"Ledger.es": `implementation {

	function ages(_ value: Dictionary<String, Integer>) -> Dictionary<String, Integer> {
		<- value
	}
}

export {
	ages
}
`,
		})
		let plugin = essence({ declarations: false })
		let code =
			(await plugin.load.call(
				context(),
				path.join(directory, "Ledger.es"),
			)) ?? ""

		expect(code).toContain(
			'import * as $runtime_Dictionary from "@essence-lang/runtime/Dictionary"',
		)
		expect(code).toContain(
			"dictionary: $runtime_Dictionary.createDictionaryFrom,",
		)
		expect(code).toContain(
			"dictionaryEntries: $runtime_type.liveEntriesOf,",
		)
	})

	// So is the Future door, from `Future.ts`.
	it("imports the asynchrony door only where the boundary names work", async () => {
		let plain = await wrapper()

		expect(plain).not.toContain("@essence-lang/runtime/Future")
		expect(plain).not.toContain("futureAnswer:")

		let directory = project({ "Async.es": ASYNC_MODULE })
		let plugin = essence({ declarations: false })
		let code =
			(await plugin.load.call(
				context(),
				path.join(directory, "Async.es"),
			)) ?? ""

		expect(code).toContain(
			'import * as $runtime_Future from "@essence-lang/runtime/Future"',
		)
		expect(code).toContain("future: $runtime_Future.of,")
		expect(code).toContain("futureContext: $runtime_Future.root,")
		expect(code).toContain("futureAnswer: $runtime_Future.complete,")
	})

	// `shown` names a Type in a refusal and decides nothing, so `minimal` drops
	// it.
	it("carries the Types a refusal names, and drops them for `minimal`", async () => {
		expect(await wrapper()).toContain('"shown":"Integer"')

		let minimal = await wrapper({ diagnostics: "minimal" })

		expect(minimal).not.toMatch(/"shown":"[^"]/)
		expect(minimal).toContain('"kind":"integer"')
	})

	// A member called `shown` keeps its Descriptor under `minimal`.
	it("blanks the Types a Descriptor names and not a member of that name", async () => {
		let directory = project({
			"Shown.es": `implementation {

	type Card = { shown: Integer, hidden: Integer }

	function reveal(_ card: Card) -> Integer {
		<- card.shown
	}

	constant shown = 12
}

export {
	Card
	reveal
	shown
}
`,
			"entry.js": `import { reveal, shown } from "./Shown.es"

export const revealed = reveal({ shown: 7n, hidden: 2n })
export const constant = shown
`,
		})
		let result = await esbuild.build({
			entryPoints: [path.join(directory, "entry.js")],
			bundle: true,
			write: false,
			format: "esm",
			plugins: [essenceEsbuild({ diagnostics: "minimal" })],
		})

		expect(result.errors).toEqual([])

		let output = path.join(directory, "shown.mjs")

		await writeFile(output, result.outputFiles![0]!.text)

		let bundle = (await import(pathToFileURL(output).href)) as Record<
			string,
			unknown
		>

		expect(bundle.revealed).toBe(7n)
		expect(bundle.constant).toBe(12n)
	})
})

describe("The Vite plugin", () => {
	it("resolves a `.es` specifier against the file that wrote it", () => {
		let plugin = essence()
		let importer = fixturePath("modules", "Main.es")

		expect(
			plugin.resolveId.call(undefined, "./math/Math.es", importer),
		).toBe(fixturePath("modules", "math", "Math.es"))
		expect(plugin.resolveId.call(undefined, "./styles.css", importer)).toBe(
			null,
		)
		// Without an importer, Vite's own resolution answers.
		expect(plugin.resolveId.call(undefined, "./Math.es", undefined)).toBe(
			null,
		)
	})

	// `/src/Main.es`, as a Vite entry writes it, names a file under the root.
	// An existing filesystem path still answers as itself.
	it("resolves a root-relative id against the Vite root", () => {
		let directory = project({ "src/Main.es": MATH_MODULE })
		let plugin = essence({ declarations: false })

		plugin.configResolved({ command: "serve", root: directory })

		expect(
			plugin.resolveId.call(undefined, "/src/Main.es", undefined),
		).toBe(path.join(directory, "src", "Main.es"))
		expect(
			plugin.resolveId.call(
				undefined,
				path.join(directory, "src", "Main.es"),
				undefined,
			),
		).toBe(path.join(directory, "src", "Main.es"))
	})

	// `?raw` and the wrapper's import resolve to one id, marked with `\0`.
	it("resolves the raw door and the wrapper's own import to one id", () => {
		let importer = fixturePath("modules", "Main.es")
		let entry = fixturePath("modules", "math", "Math.es")
		let plugin = essence()
		let raw = `\0${rawSpecifier(entry)}`

		expect(
			plugin.resolveId.call(undefined, "./math/Math.es?raw", importer),
		).toBe(raw)
		expect(
			plugin.resolveId.call(undefined, rawSpecifier(entry), importer),
		).toBe(raw)
	})

	// An id the plugin answered comes back after an edit, and must not gain a
	// second `\0`, which `load` would read as a file.
	it("answers an id it already marked as itself", () => {
		let entry = fixturePath("modules", "math", "Math.es")
		let plugin = essence()
		let raw = `\0${rawSpecifier(entry)}`

		expect(plugin.resolveId.call(undefined, raw, undefined)).toBe(raw)
		expect(
			plugin.resolveId.call(undefined, `\0${PRELUDE_ID}`, undefined),
		).toBe(`\0${PRELUDE_ID}`)
		// Another plugin's marked id is not claimed.
		expect(
			plugin.resolveId.call(
				undefined,
				"\0somebody-elses:thing",
				undefined,
			),
		).toBe(null)
	})

	// Every source of the graph is watched, from the wrapper and from each
	// served sibling.
	it("answers with a wrapper, and watches every source it was built from", async () => {
		let directory = project({
			"Main.es": `import {
	from "./Math.es" { square }
}

implementation {
	constant answer = square(5)
}

export {
	answer
}
`,
			"Math.es": MATH_MODULE,
		})
		let plugin = essence({ declarations: false })
		let hook = context()
		let entry = path.join(directory, "Main.es")
		let sibling = path.join(directory, "Math.es")

		plugin.configResolved({ command: "serve", root: directory })

		let code = await plugin.load.call(hook, entry)

		expect(code).toContain("bind($raw,")
		expect(code).toContain("export { $export_answer as answer }")
		expect(hook.watched.sort()).toEqual([entry, sibling])

		let siblingHook = context()

		await plugin.load.call(siblingHook, `\0${rawSpecifier(sibling)}`)

		expect(siblingHook.watched.sort()).toEqual([entry, sibling])
	})

	it("answers with the emitted Module behind the raw id", async () => {
		let directory = project({ "Math.es": MATH_MODULE })
		let plugin = essence({ declarations: false })

		plugin.configResolved({ command: "serve", root: directory })

		let code = await plugin.load.call(
			context(),
			`\0${rawSpecifier(path.join(directory, "Math.es"))}`,
		)

		// A Module that imports the runtime by name, carrying no copy.
		expect(code).toContain('from "@essence-lang/runtime/Integer"')
		expect(code).not.toContain("typeKeySymbol = Symbol")
		expect(code).toContain("export {")
		// Its source map is inline, the only place for one without a file.
		expect(code).toContain("//# sourceMappingURL=data:application/json;")
	})

	// Ids with a query, such as `/src/Main.es?import`, are claimed too.
	it("claims an id a dev server has written a query onto", async () => {
		let directory = project({ "Math.es": MATH_MODULE })
		let plugin = essence({ declarations: false })
		let code = await plugin.load.call(
			context(),
			`${path.join(directory, "Math.es")}?import`,
		)

		expect(code).not.toBe(null)
		expect(await plugin.load.call(context(), "/src/main.ts")).toBe(null)
	})

	it("throws the report `esc` would have printed", async () => {
		let directory = project({
			"Broken.es": `implementation {
	constant value: Integer = "twelve"
}

export {
	value
}
`,
		})
		let plugin = essence({ declarations: false })
		let error = await plugin.load
			.call(context(), path.join(directory, "Broken.es"))
			.catch((thrown: unknown) => thrown)

		expect(error).toBeInstanceOf(EssenceCompileError)
		expect((error as EssenceCompileError).message).toContain(
			"[assignment-type-mismatch]",
		)
	})

	// An edit may join two entries into one graph. `watchChange` makes the
	// plugin forget what the old sources emitted.
	it("lets an edit refactor one entry into the other's graph", async () => {
		let shared = `implementation {

	function shared() -> Integer {
		<- 1
	}
}

export {
	shared
}
`
		let directory = project({
			"Shared.es": shared,
			"Entry.es": `implementation {
	constant value = 2
}

export {
	value
}
`,
		})
		let plugin = essence({ declarations: false })

		plugin.configResolved({ command: "serve", root: directory })
		plugin.buildStart()

		expect(
			await plugin.load.call(
				context(),
				path.join(directory, "Shared.es"),
			),
		).not.toBe(null)
		expect(
			await plugin.load.call(context(), path.join(directory, "Entry.es")),
		).not.toBe(null)

		writeFileSync(
			path.join(directory, "Entry.es"),
			`import {
	from "./Shared.es" { shared }
}

implementation {
	constant value = shared()
}

export {
	value
}
`,
		)
		plugin.watchChange(path.join(directory, "Entry.es"))

		expect(
			await plugin.load.call(context(), path.join(directory, "Entry.es")),
		).not.toBe(null)
	})

	// Only entries whose graph reaches the edited file compile again, counted
	// by the host's reads.
	it("forgets only what an edit can have changed", async () => {
		let directory = project({
			"One.es": MATH_MODULE,
			"Two.es": SHAPES_MODULE,
		})
		let reads: Array<string> = []
		let host = {
			readFile(filePath: string): string | undefined {
				reads.push(path.basename(filePath))

				return readFileSync(filePath, "utf8")
			},
		}
		let plugin = essence({ declarations: false, host })
		let one = path.join(directory, "One.es")
		let two = path.join(directory, "Two.es")

		plugin.configResolved({ command: "serve", root: directory })
		await plugin.load.call(context(), one)
		await plugin.load.call(context(), two)
		reads.length = 0

		plugin.watchChange(two)
		await plugin.load.call(context(), one)
		await plugin.load.call(context(), `\0${rawSpecifier(one)}`)

		expect(reads).toEqual([])

		await plugin.load.call(context(), two)

		expect(reads).toEqual(["Two.es"])
		reads.length = 0

		// With no file named, everything is forgotten.
		plugin.buildStart()
		await plugin.load.call(context(), one)

		expect(reads).toEqual(["One.es"])
	})

	// A compile reads its sources when `load` is called, so an edit before
	// `load` is awaited overtakes it. Its output is not kept.
	it("does not remember a compile an edit overtook", async () => {
		let directory = project({ "Slow.es": MATH_MODULE })
		let plugin = essence({ declarations: false })
		let entry = path.join(directory, "Slow.es")

		plugin.configResolved({ command: "serve", root: directory })

		let first = plugin.load.call(context(), entry)

		writeFileSync(entry, MATH_MODULE.replace("314/100", "22/7"))
		plugin.watchChange(entry)

		expect(await first).toContain("bind($raw,")

		let second = await plugin.load.call(
			context(),
			`\0${rawSpecifier(entry)}`,
		)

		expect(second).toContain("22n")
		expect(second).not.toContain("314n")
	})

	// A file two entries share is served the same text whichever compiled it.
	it("serves one text for a file two entries share", async () => {
		let directory = project({
			"lib/Shapes.es": SHAPES_MODULE,
			"app/One.es": `import {
	from "../lib/Shapes.es" { Shape }
	from "../lib/Shapes.es" { areaOf }
}

implementation {
	constant one: Shape = #Circle({ radius = 2 })
}

export {
	one
}
`,
			"Two.es": `import {
	from "./lib/Shapes.es" { Shape }
	from "./lib/Shapes.es" { areaOf }
}

implementation {
	constant two: Shape = #Circle({ radius = 3 })
}

export {
	two
}
`,
		})
		let shared = `\0${rawSpecifier(path.join(directory, "lib", "Shapes.es"))}`

		let servedThrough = async (entry: string): Promise<string> => {
			let plugin = essence({ declarations: false })

			plugin.configResolved({ command: "serve", root: directory })
			await plugin.load.call(context(), path.join(directory, entry))

			return (await plugin.load.call(context(), shared)) ?? ""
		}

		let throughOne = await servedThrough(path.join("app", "One.es"))
		let throughTwo = await servedThrough("Two.es")

		expect(throughOne).toBe(throughTwo)
		expect(throughOne).toContain('"./lib/Shapes.es#Shape#Circle"')
	})

	// A served Module's imports are spelled against the root, so each resolves
	// to one id for every entry.
	it("resolves what one served Module imports another by", () => {
		let directory = fixturePath("modules")
		let plugin = essence({ declarations: false })

		plugin.configResolved({ command: "build", root: directory })

		expect(
			plugin.resolveId.call(
				undefined,
				"essence:./math/Math.es",
				undefined,
			),
		).toBe(`\0${rawSpecifier(path.join(directory, "math", "Math.es"))}`)
		expect(
			plugin.resolveId.call(undefined, "essence:$prelude", undefined),
		).toBe(`\0${PRELUDE_ID}`)
	})

	it("serves the standard library prelude under one id", async () => {
		let directory = project({ "Math.es": MATH_MODULE })
		let plugin = essence({ declarations: false })

		plugin.configResolved({ command: "serve", root: directory })
		await plugin.load.call(context(), path.join(directory, "Math.es"))

		let prelude = await plugin.load.call(context(), `\0${PRELUDE_ID}`)

		expect(prelude).toContain("$es_Integer_multiply__overload$2")
		expect(prelude).toContain('from "@essence-lang/runtime/Integer"')
	})
})

describe("The declarations a build writes", () => {
	// The `javascript` view, since the import resolves to the wrapper.
	it("writes the JavaScript view beside the source while serving", async () => {
		let directory = project({ "Shapes.es": SHAPES_MODULE })
		let entry = path.join(directory, "Shapes.es")
		let plugin = essence()

		plugin.configResolved({ command: "serve" })
		await plugin.load.call(context(), entry)

		expect(path.basename(declarationsPath(entry))).toBe("Shapes.d.es.ts")
		expect(
			await readFile(declarationsPath(entry), "utf8"),
		).toMatchSnapshot()
	})

	// A consumer is checked against the declarations, which must refuse what
	// the Module does not offer.
	it("typechecks a consumer against what it wrote", async () => {
		let directory = project({ "Shapes.es": SHAPES_MODULE })
		let entry = path.join(directory, "Shapes.es")
		let plugin = essence({ declarations: true })

		await plugin.load.call(context(), entry)

		let run = await typecheck({
			"Shapes.d.es.ts": await readFile(declarationsPath(entry), "utf8"),
			"consumer.ts": `import { areaOf, blank, Direction, named, turn, widen } from "./Shapes.es"
import type { Box, Shape } from "./Shapes.es"

export let area: bigint = areaOf({ $case: "Shape#Circle", radius: 3n })
export let empty: Shape = blank
export let wider: Box = widen({ width: 1n, height: 2n }, 3n)
export let label: string = named(undefined)
export let flipped: Direction = turn("Up")
export let same: Direction = turn(Direction.Down)
// @ts-expect-error a Case the Choice does not declare
export let wrong: Direction = turn("Left")
`,
		})

		expect(run.output).toBe("")
		expect(run.code).toBe(0)
	})

	// The bundle view goes to `Math.raw.d.es.ts`, only for a file the host
	// imported through `?raw`. Resolution records that, so it runs first.
	it("writes the bundle view for the raw door", async () => {
		let directory = project({ "Math.es": MATH_MODULE })
		let entry = path.join(directory, "Math.es")
		let plugin = essence({ declarations: true })
		let id = plugin.resolveId.call(undefined, "./Math.es?raw", entry)

		await plugin.load.call(context(), id ?? "")

		let written = await readFile(declarationsPath(entry, "bundle"), "utf8")

		expect(id).toBe(`\0${rawSpecifier(entry)}`)
		expect(path.basename(declarationsPath(entry, "bundle"))).toBe(
			"Math.raw.d.es.ts",
		)
		expect(written).toContain("export declare const PI: EssenceValue")
		expect(written).toContain(
			"export declare function square(p0: EssenceValue): EssenceValue",
		)
		// No bridge declared, since values come from `@essence-lang/runtime`.
		expect(written).not.toContain("$bridge_")
	})

	it("writes none in a build", async () => {
		let directory = project({ "Math.es": MATH_MODULE })
		let plugin = essence()

		plugin.configResolved({ command: "build" })
		await plugin.load.call(context(), path.join(directory, "Math.es"))

		// Sorted, since `readdir` order depends on the filesystem.
		expect((await readdir(directory)).sort()).toEqual([
			"Math.es",
			"node_modules",
		])
	})

	// A rewrite with the same contents would move the mtime and rebuild forever.
	it("leaves them alone when nothing about them changed", async () => {
		let directory = project({ "Math.es": MATH_MODULE })
		let entry = path.join(directory, "Math.es")
		let plugin = essence({ declarations: true })

		await plugin.load.call(context(), entry)

		let before = (await stat(declarationsPath(entry))).mtimeMs

		await plugin.load.call(context(), entry)

		expect((await stat(declarationsPath(entry))).mtimeMs).toBe(before)
	})
})
