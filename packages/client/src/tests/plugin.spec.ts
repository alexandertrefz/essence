import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
	mkdirSync,
	mkdtempSync,
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
import { EssenceBuildError } from "../errors"
import { essenceEsbuild } from "../esbuild-plugin"
import { declarationsPath, rawSpecifier } from "../plugin-core"
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

// NOTE: The shapes a declaration file has to spell and a consumer has to be able
// to write: a Choice, a Record under a name, a labelled call and an `Optional`.
// Deliberately no Rational — a generated file borrows `EssenceRational` from this
// package, and the point of this Module is that what is written beside it stands
// on its own.
const SHAPES_MODULE = `implementation {

	choice Shape {
		Circle { radius: Integer },
		Blank,
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
		<- value::otherwise("unnamed")
	}

	constant blank: Shape = #Blank
}

export {
	Box
	Shape
	areaOf
	blank
	named
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

// NOTE: A project of its own per test, under one workspace that is removed at
// the end — several of these write files BESIDE their sources, which is exactly
// what is under test, and a shared directory would let one test read another's.
//
// NOTE: With this package installed in it, because that is what a project that
// uses the plugin has: the wrapper the plugin serves imports the interpreter by
// name — `@essence-lang/client/marshal-runtime` — and it is the HOST that
// resolves it, so a project with no `node_modules` would test a resolution
// nobody performs.
function project(files: Record<string, string>): string {
	let directory = realpathSync.native(
		mkdtempSync(path.join(workspace, "project-")),
	)
	let scope = path.join(directory, "node_modules", "@essence-lang")

	mkdirSync(scope, { recursive: true })
	symlinkSync(
		path.join(REPOSITORY, "packages", "client"),
		path.join(scope, "client"),
		"dir",
	)

	for (let [name, source] of Object.entries(files)) {
		let filePath = path.join(directory, name)

		mkdirSync(path.dirname(filePath), { recursive: true })
		writeFileSync(filePath, source)
	}

	return directory
}

// NOTE: What Rollup and Vite call a hook with. Only `addWatchFile` is ever
// reached, and it is optional there — the plugin has to work under a host that
// offers no such thing.
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

// NOTE: The built output, imported. `write: false` keeps esbuild's answer in
// memory; it is written once, under a name of its own, because a Module is
// identified by its URL and two builds of one name would be one Module.
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
	// NOTE: The whole claim of the wrapper, in one call: a `bigint` goes in, a
	// `bigint` comes back, and nothing in the entry knows Essence was involved.
	// Before it, this same test had to build its Argument with the bridge and
	// read `.value` off the answer.
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
		// NOTE: A Rational crosses as this package's own class — read for its
		// parts rather than by `instanceof`, because the class the BUILD holds
		// was bundled into it and is not the one this test imported.
		expect(pi.numerator).toBe(157n)
		expect(pi.denominator).toBe(50n)
		expect(pi.toString()).toBe("157/50")
	})

	// NOTE: A Choice across the boundary, which is the one value whose spelling
	// the WRAPPER and the BUNDLE have to agree on: a Case is tagged with a path
	// relative to the entry it was emitted for, and the Descriptor bakes that
	// same tag. Disagree by one character and `areaOf` would match `#Blank` and
	// answer 0 — no error, a wrong number.
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

	// NOTE: The whole Essence graph, not the file that was named. Nothing about a
	// dependency reaches the host bundler — the Bundler already inlined it, and
	// the runtime with it, so what esbuild is handed resolves to nothing.
	it("hands over one standalone Module for a whole graph", async () => {
		let directory = project({
			"Main.es": `import {
	square from "./Math.es"
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

	// NOTE: The door the wrapper itself imports through, opened to a host. What
	// is behind it is the emitted bundle: Essence's own values, under the names
	// the Rewriter emitted them as, and the bridge that builds values they
	// accept.
	it("serves the emitted bundle behind `?raw`", async () => {
		let directory = project({
			"Math.es": MATH_MODULE,
			"entry.js": `import { square, $bridge_integer, $bridge_typeKey } from "./Math.es?raw"

export const squared = square($bridge_integer(12n))
export const typeKey = $bridge_typeKey
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

	// NOTE: ONE bundle behind both doors, which is what makes them doors into one
	// Module rather than two Programs. A value built through the raw bridge is
	// tagged with the Symbol that bundle minted, and the marshalled door hands
	// values to the very same Functions — a second copy would tag its values with
	// a Symbol the first has never seen, and every `match` on one would take the
	// wrong arm.
	it("serves one bundle to the marshalled door and the raw one", async () => {
		let directory = project({
			"Math.es": MATH_MODULE,
			"entry.js": `import { square } from "./Math.es"
import { square as rawSquare, $bridge_integer, $bridge_typeKey } from "./Math.es?raw"

export const marshalled = square(12n)
export const raw = rawSquare($bridge_integer(12n))
export const typeKey = $bridge_typeKey
`,
		})
		let result = await build(directory, "entry.js")
		let text = result.outputFiles![0]!.text

		expect(result.errors).toEqual([])
		// NOTE: A sentence only the runtime's own Integer says, counted. Two
		// copies of the runtime would say it twice.
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

	// NOTE: `ok?` is a perfectly ordinary Essence export and a name JavaScript
	// can not spell. A module may name its exports with a string literal, which
	// is how it reaches a host at all — and the wrapper writes one.
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
				// NOTE: The report is what is under test, and esbuild would print
				// it to the terminal on its way to the rejection.
				logLevel: "silent",
				plugins: [essenceEsbuild()],
			})
			.catch((thrown: unknown) => thrown as esbuild.BuildFailure)

		expect(failure).toBeInstanceOf(Error)
		expect((failure as esbuild.BuildFailure).errors[0]?.text).toContain(
			"[assignment-type-mismatch]",
		)
	})

	// NOTE: The failure this refuses is SILENT otherwise: two entries out of one
	// graph are two standalone bundles, each with a `typeKeySymbol` of its own, so
	// a Circle built by one carries nothing the other can read. `areaOf` then
	// matched `#Blank` and answered `0` — no error, no warning, a wrong number.
	it("refuses two entries out of one Module graph", async () => {
		let directory = project({
			"Shapes.es": `implementation {

	choice Shape {
		Circle { radius: Integer },
		Blank,
	}

	function circleOf(_ radius: Integer) -> Shape {
		<- #Circle({ radius = radius })
	}
}

export {
	Shape
	circleOf
}
`,
			"Area.es": `import {
	Shape from "./Shapes.es"
}

implementation {

	function areaOf(_ value: Shape) -> Integer {
		<- match value -> Integer {
			case #Circle { <- @.radius::multiply(with @.radius) }
			case #Blank  { <- 0 }
		}
	}
}

export {
	areaOf
}
`,
			"entry.js": `import { circleOf } from "./Shapes.es"
import { areaOf } from "./Area.es"

export { circleOf, areaOf }
`,
		})
		let failure = await esbuild
			.build({
				entryPoints: [path.join(directory, "entry.js")],
				bundle: true,
				write: false,
				format: "esm",
				logLevel: "silent",
				plugins: [essenceEsbuild()],
			})
			.catch((thrown: unknown) => thrown as esbuild.BuildFailure)

		expect(failure).toBeInstanceOf(Error)
		expect((failure as esbuild.BuildFailure).errors[0]?.text).toContain(
			"two Essence entries out of one Module graph",
		)
	})

	// NOTE: Two Programs that share nothing are two Programs. They duplicate the
	// runtime and their values still may not pass between them, but nothing in
	// either of them ever claimed otherwise — so there is nothing to refuse.
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

	// NOTE: The two imports and the Descriptor between them — the whole of what
	// makes a build's `.es` import JavaScript rather than Essence's own values.
	it("imports the bundle and the interpreter, and marshals between them", async () => {
		let code = await wrapper()

		expect(code).toContain('import * as $raw from "essence-raw:')
		expect(code).toContain(
			'import { bind } from "@essence-lang/client/marshal-runtime"',
		)
		expect(code).toContain("typeKey: $raw.$bridge_typeKey,")
		expect(code).toContain("export const PI = $module.PI")
		expect(code).toContain("export const square = $module.square")
	})

	// NOTE: What a Descriptor carries beyond the decisions themselves: the Type
	// as the Compiler printed it, which is what a refusal at run time NAMES. It
	// is most of the bytes and none of the behaviour, so a build that ships to a
	// browser can say so.
	it("carries the Types a refusal names, and drops them for `minimal`", async () => {
		expect(await wrapper()).toContain('"shown":"Integer"')

		let minimal = await wrapper({ diagnostics: "minimal" })

		expect(minimal).not.toMatch(/"shown":"[^"]/)
		expect(minimal).toContain('"kind":"integer"')
	})

	// NOTE: `shown` is a name a Module may write as well as a field the
	// Descriptor carries, and only the second is a Type printed for a refusal to
	// name. Blanked by NAME, a member called `shown` becomes an empty string
	// where a Descriptor belongs — which no branch of the interpreter matches,
	// so the member crosses as nothing and the Module fails somewhere inside
	// itself with `minimal` and works with `full`.
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
		// NOTE: With nothing to resolve it against, it is not this plugin's to
		// claim — Vite's own resolution knows about roots and aliases.
		expect(plugin.resolveId.call(undefined, "./Math.es", undefined)).toBe(
			null,
		)
	})

	// NOTE: `/src/Main.es` is the id the canonical Vite entry writes — `<script
	// type="module" src="/src/Main.es">` — and it names a file under the
	// project ROOT, not one at the root of the filesystem. A filesystem path
	// that really exists still answers as itself.
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

	// NOTE: `?raw` and the wrapper's own import resolve to ONE id — the module
	// no filesystem holds, marked with Rollup's `\0` so that nothing goes
	// looking for a file. Two ids would be two copies of the bundle in one
	// build, whose values would not recognise each other.
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

	it("answers with a wrapper, and watches every source it was built from", async () => {
		let directory = project({ "Math.es": MATH_MODULE })
		let plugin = essence({ declarations: false })
		let hook = context()
		let code = await plugin.load.call(hook, path.join(directory, "Math.es"))

		expect(code).toContain("bind($raw,")
		expect(code).toContain("export const square = $module.square")
		expect(hook.watched).toEqual([path.join(directory, "Math.es")])
	})

	it("answers with the emitted bundle behind the raw id", async () => {
		let directory = project({ "Math.es": MATH_MODULE })
		let plugin = essence({ declarations: false })
		let code = await plugin.load.call(
			context(),
			`\0${rawSpecifier(path.join(directory, "Math.es"))}`,
		)

		expect(code).toContain("$bridge_integer")
		expect(code).toContain("export {")
	})

	// NOTE: A dev server asks for `/src/Main.es?import` and `?t=1730` as well.
	// Matching the id as written would let both through unclaimed, and Vite would
	// then read Essence as JavaScript.
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

	// NOTE: A dev server never rebuilds from the top — entries load one at a
	// time, and only the changed ones again — so the compiler's record of WHO
	// the entries are goes stale the moment a file changes. A refactor that
	// folds one entry into the other's graph collided with the record of an
	// entry that no longer is one, and refused a one-entry build until the
	// server was restarted.
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
	shared from "./Shared.es"
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

	// NOTE: The refusal itself stands: two entries BOTH loaded since the last
	// change really are two halves of one Program, and the second load is
	// where that is caught.
	it("still refuses two live entries out of one Module graph", async () => {
		let directory = project({
			"Shared.es": `implementation {

	function shared() -> Integer {
		<- 1
	}
}

export {
	shared
}
`,
			"Entry.es": `import {
	shared from "./Shared.es"
}

implementation {
	constant value = shared()
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

		let error = await plugin.load
			.call(context(), path.join(directory, "Entry.es"))
			.catch((thrown: unknown) => thrown)

		expect(error).toBeInstanceOf(EssenceBuildError)
		expect((error as EssenceBuildError).message).toContain(
			"two Essence entries out of one Module graph",
		)
	})

	// NOTE: Regression test — a dev server re-transforms a module only when
	// its OWN watched files change, so an edit to a file in neither graph (a
	// stylesheet, say) staled the first entry's record, the second entry's
	// load silently displaced it, and both duplicated-runtime bundles ran side
	// by side undetected. Displacing the record now invalidates the entry's
	// module too, so an entry the server still holds is loaded again — where
	// it collides with the fresh record and refuses.
	it("forces a displaced entry to load again, where a live one still refuses", async () => {
		let entry = `import {
	shared from "./Shared.es"
}

implementation {
	constant value = shared()
}

export {
	value
}
`
		let directory = project({
			"Shared.es": `implementation {

	function shared() -> Integer {
		<- 1
	}
}

export {
	shared
}
`,
			"First.es": entry,
			"Second.es": entry,
		})
		let plugin = essence({ declarations: false })
		let invalidated: Array<string> = []

		plugin.configResolved({ command: "serve", root: directory })
		plugin.configureServer({
			moduleGraph: {
				getModuleById: (id) => ({ id }),
				invalidateModule(module) {
					invalidated.push((module as { id: string }).id)
				},
			},
		})
		plugin.buildStart()

		expect(
			await plugin.load.call(context(), path.join(directory, "First.es")),
		).not.toBe(null)

		plugin.watchChange(path.join(directory, "style.css"))

		expect(
			await plugin.load.call(
				context(),
				path.join(directory, "Second.es"),
			),
		).not.toBe(null)
		expect(invalidated).toEqual([path.join(directory, "First.es")])

		// NOTE: What Vite does with an invalidated module a page still uses —
		// the next request loads it again.
		let error = await plugin.load
			.call(context(), path.join(directory, "First.es"))
			.catch((thrown: unknown) => thrown)

		expect(error).toBeInstanceOf(EssenceBuildError)
		expect((error as EssenceBuildError).message).toContain(
			"two Essence entries out of one Module graph",
		)
	})
})

describe("The declarations a build writes", () => {
	// NOTE: The `javascript` view, because that is the module the import
	// resolves to — the wrapper. What a reader gets is the Module as JavaScript:
	// a Choice as a discriminated union, an `Optional` as `T | undefined`, and
	// every Parameter under the label the Declaration wrote.
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

	// NOTE: The other half of the claim. Declarations that admit everything
	// typecheck every consumer, so a file that compiles says nothing on its own
	// until somebody writes against it what the Module really offers.
	it("typechecks a consumer against what it wrote", async () => {
		let directory = project({ "Shapes.es": SHAPES_MODULE })
		let entry = path.join(directory, "Shapes.es")
		let plugin = essence({ declarations: true })

		await plugin.load.call(context(), entry)

		let run = typecheck({
			"Shapes.d.es.ts": await readFile(declarationsPath(entry), "utf8"),
			"consumer.ts": `import { areaOf, blank, named, widen } from "./Shapes.es"
import type { Box, Shape } from "./Shapes.es"

export let area: bigint = areaOf({ $case: "Shape#Circle", radius: 3n })
export let empty: Shape = blank
export let wider: Box = widen({ width: 1n, height: 2n }, 3n)
export let label: string = named(undefined)
`,
		})

		expect(run.output).toBe("")
		expect(run.code).toBe(0)
	})

	// NOTE: The raw door describes a different module, so it can not share the
	// one file. `Math.raw.es` is the name that reaches this one, by the same
	// rule `Math.es` reaches its own.
	it("writes the bundle view for the raw door", async () => {
		let directory = project({ "Math.es": MATH_MODULE })
		let entry = path.join(directory, "Math.es")
		let plugin = essence({ declarations: true })

		await plugin.load.call(context(), `\0${rawSpecifier(entry)}`)

		let written = await readFile(declarationsPath(entry, "bundle"), "utf8")

		expect(path.basename(declarationsPath(entry, "bundle"))).toBe(
			"Math.raw.d.es.ts",
		)
		expect(written).toContain("export declare const PI: EssenceValue")
		expect(written).toContain(
			"export declare function square(p0: EssenceValue): EssenceValue",
		)
		expect(written).toContain("export declare const $bridge_integer:")
	})

	it("writes none in a build", async () => {
		let directory = project({ "Math.es": MATH_MODULE })
		let plugin = essence()

		plugin.configResolved({ command: "build" })
		await plugin.load.call(context(), path.join(directory, "Math.es"))

		expect(await readdir(directory)).toEqual(["Math.es", "node_modules"])
	})

	// NOTE: A dev server compiles on every request, and a file rewritten with its
	// own contents still moves its mtime — which the watcher that asked for the
	// compile is watching. Writing unconditionally is how a dev server rebuilds
	// forever.
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
