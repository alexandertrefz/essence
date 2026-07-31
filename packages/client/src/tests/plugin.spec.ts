import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { readFile, readdir, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { pathToFileURL } from "node:url"

import { fixturePath } from "@essence-lang/fixtures"
import * as esbuild from "esbuild"

import { EssenceCompileError } from "../errors"
import {
	declarationsPath,
	essence,
	essenceEsbuild,
	type PluginContext,
} from "../plugin"

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
function project(files: Record<string, string>): string {
	let directory = realpathSync.native(
		mkdtempSync(path.join(workspace, "project-")),
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

// NOTE: The built output, imported. `write: false` keeps esbuild's answer in
// memory; it is written once, under a name of its own, because a Module is
// identified by its URL and two builds of one name would be one Module.
async function built(
	directory: string,
	entry: string,
	name: string,
): Promise<Record<string, unknown>> {
	let result = await esbuild.build({
		entryPoints: [path.join(directory, entry)],
		bundle: true,
		write: false,
		format: "esm",
		plugins: [essenceEsbuild()],
	})

	expect(result.errors).toEqual([])

	let output = path.join(directory, name)

	await writeFile(output, result.outputFiles[0]!.text)

	return (await import(pathToFileURL(output).href)) as Record<string, unknown>
}

describe("The esbuild plugin", () => {
	it("compiles an imported `.es` file into the build", async () => {
		let directory = project({
			"Math.es": MATH_MODULE,
			"entry.js": `import { PI, square, $bridge_integer, $bridge_typeKey } from "./Math.es"

export const squared = square($bridge_integer(12n))
export const pi = PI
export const typeKey = $bridge_typeKey
`,
		})
		let bundle = await built(directory, "entry.js", "out.mjs")
		let typeKey = bundle.typeKey as symbol
		let squared = bundle.squared as Record<symbol, unknown> & {
			value: bigint
		}

		expect(squared[typeKey]).toBe("Integer")
		expect(squared.value).toBe(144n)
		expect((bundle.pi as Record<symbol, unknown>)[typeKey]).toBe("Rational")
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
			"entry.js": `import { twice, $bridge_integer, $bridge_typeKey } from "./Main.es"

export const answer = twice($bridge_integer(5n))
export const typeKey = $bridge_typeKey
`,
		})
		let bundle = await built(directory, "entry.js", "out.mjs")
		let answer = bundle.answer as Record<symbol, unknown> & {
			value: bigint
		}

		expect(answer[bundle.typeKey as symbol]).toBe("Integer")
		expect(answer.value).toBe(50n)
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
			"entry.js": `import { square, $bridge_integer as integer } from "./Math.es"
import { tripled, $bridge_integer as otherInteger } from "./Other.es"

export const squared = square(integer(12n))
export const trebled = tripled(otherInteger(4n))
`,
		})
		let bundle = await built(directory, "entry.js", "twoGraphs.mjs")

		expect((bundle.squared as { value: bigint }).value).toBe(144n)
		expect((bundle.trebled as { value: bigint }).value).toBe(12n)
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

	it("answers with the compiled bundle and watches every source", async () => {
		let directory = project({ "Math.es": MATH_MODULE })
		let plugin = essence({ declarations: false })
		let hook = context()
		let code = await plugin.load.call(hook, path.join(directory, "Math.es"))

		expect(code).toContain("$bridge_integer")
		expect(code).toContain("export {")
		expect(hook.watched).toEqual([path.join(directory, "Math.es")])
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
})

describe("The declarations a build writes", () => {
	it("writes them beside the source while serving", async () => {
		let directory = project({ "Math.es": MATH_MODULE })
		let entry = path.join(directory, "Math.es")
		let plugin = essence()

		plugin.configResolved({ command: "serve" })
		await plugin.load.call(context(), entry)

		let written = await readFile(declarationsPath(entry), "utf8")

		expect(path.basename(declarationsPath(entry))).toBe("Math.d.es.ts")
		expect(written).toContain("export declare const PI: EssenceValue")
		expect(written).toContain(
			"export declare function square(p0: EssenceValue): EssenceValue",
		)
	})

	it("writes none in a build", async () => {
		let directory = project({ "Math.es": MATH_MODULE })
		let plugin = essence()

		plugin.configResolved({ command: "build" })
		await plugin.load.call(context(), path.join(directory, "Math.es"))

		expect(await readdir(directory)).toEqual(["Math.es"])
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
