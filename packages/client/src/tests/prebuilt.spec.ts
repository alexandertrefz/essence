import { afterAll, beforeAll, describe, expect, it } from "bun:test"
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

import {
	compileToMemory,
	linkToMemory,
	withRuntimeBridge,
} from "@essence-lang/compiler/embed"
import {
	carriesDictionary,
	describeModule,
	describeTypes,
} from "@essence-lang/compiler/embed/describe"
import { canonicalPath } from "@essence-lang/compiler/modules"
import { spawnAndWait } from "@essence-lang/fixtures/spawn"

import type { EssenceValue } from "../bridge"
import { descriptorPath, loadPrebuilt, type PrebuiltModule } from "../prebuilt"
import { REPOSITORY } from "./typecheck"

let directory = ""
let calls: PrebuiltModule

beforeAll(async () => {
	directory = realpathSync.native(
		mkdtempSync(path.join(tmpdir(), "essence-prebuilt-")),
	)
	calls = await loadPrebuilt(
		await build(clientFixture("Calls.es"), "calls.js"),
	)
})

afterAll(() => {
	rmSync(directory, { recursive: true, force: true })
})

function clientFixture(name: string): string {
	return path.join(import.meta.dirname, "files", name)
}

// A bundle and its Descriptor, built as `esc build --embed` builds them. The
// bridge is injected and the Surface described against one entry.
async function build(entryPath: string, name: string): Promise<string> {
	let entry = canonicalPath(entryPath)
	let bundlePath = path.join(directory, name)
	let linked = linkToMemory(entry, { embed: true })
	let descriptor = describeModule(linked.surface, entry)
	let compiled = await compileToMemory(entry, {
		embed: true,
		transformSources: (sources) =>
			withRuntimeBridge(sources, {
				dictionary: carriesDictionary(
					descriptor,
					describeTypes(linked.surface, entry),
				),
			}),
		outputFileName: bundlePath,
	})

	expect(compiled.diagnostics).toEqual([])

	writeFileSync(bundlePath, compiled.code)
	writeFileSync(
		descriptorPath(bundlePath),
		JSON.stringify(describeModule(compiled.surface, entry)),
	)

	return bundlePath
}

describe("A prebuilt Module", () => {
	// A bundle's path in, the Module as JavaScript out, with no compiler.
	it("binds a bundle and the Descriptor beside it", () => {
		expect(Object.keys(calls.exports)).toContain("labelled")
		expect(calls.exports.labelled).toBeInstanceOf(Function)
		expect(
			(calls.exports.labelled as (...args: Array<unknown>) => unknown)(
				10n,
				4n,
			),
		).toBe(6n)
	})

	// The labels come from the Descriptor alone.
	it("keeps the labels the Descriptor carries", () => {
		let labelled = calls.exports.labelled as (
			...args: Array<unknown>
		) => unknown

		expect(labelled({ first: 10n, second: 4n })).toBe(6n)
	})

	it("hands over a constructor per Case of an exported Choice", () => {
		let colour = calls.exports.Colour as Record<string, unknown>
		let named = colour.Named as (payload: unknown) => unknown

		expect(colour.Red).toEqual({ $case: "Colour#Red" })
		expect(named({ name: "teal" })).toEqual({
			name: "teal",
			$case: "Colour#Named",
		})
		// The tag a constructor writes is the tag the bundle matches on.
		expect(
			(calls.exports.coloured as (name: string) => unknown)("teal"),
		).toEqual({ name: "teal", $case: "Colour#Named" })
	})

	it("wraps a callback in both directions", () => {
		let applyTwice = calls.exports.applyTwice as (
			transform: (value: bigint) => bigint,
			value: bigint,
		) => bigint
		let makeAdder = calls.exports.makeAdder as (
			amount: bigint,
		) => (value: bigint) => bigint

		expect(applyTwice((value) => value * 3n, 2n)).toBe(18n)
		expect(makeAdder(5n)(3n)).toBe(8n)
	})

	// What `loadModule` answers, but for the Export Surface and the Marshaller.
	it("answers with the raw door, the bridge and the boundary", () => {
		let raw = calls.raw.labelled as (
			...args: Array<EssenceValue>
		) => unknown

		expect(typeof calls.bridge.typeKey).toBe("symbol")
		expect(calls.bridge.typeKey.description).toBe("$type")
		expect(calls.descriptor.exports.labelled?.kind).toBe("function")

		let ten = calls.interpreter.fromJS(10n, { kind: "integer", shown: "" })
		let four = calls.interpreter.fromJS(4n, { kind: "integer", shown: "" })

		expect(calls.interpreter.toJS(raw(ten, four))).toBe(6n)
	})

	// `descriptorFileName` in the CLI states the same rule, and the
	// "`esc build --embed`" tests load a pair it wrote.
	it("looks for the sidecar beside the bundle", () => {
		expect(descriptorPath("dist/app.js")).toBe("dist/app.descriptor.json")
		expect(descriptorPath("/build/app.mjs")).toBe(
			"/build/app.descriptor.json",
		)
		// A dot in a directory is no extension.
		expect(descriptorPath("/opt/v1.2/app")).toBe(
			"/opt/v1.2/app.descriptor.json",
		)
		expect(descriptorPath("/build/.app")).toBe(
			"/build/.app.descriptor.json",
		)
	})

	it("takes a sidecar of its own where it is given one", async () => {
		let elsewhere = path.join(directory, "moved.json")

		writeFileSync(
			elsewhere,
			readFileSync(
				descriptorPath(path.join(directory, "calls.js")),
				"utf8",
			),
		)

		let moved = await loadPrebuilt(
			path.join(directory, "calls.js"),
			elsewhere,
		)

		expect(
			(moved.exports.labelled as (...args: Array<unknown>) => unknown)(
				10n,
				4n,
			),
		).toBe(6n)
	})

	// Named by the file, which is what went wrong.
	it("refuses a sidecar that is not a Descriptor", async () => {
		let wrong = path.join(directory, "wrong.json")

		writeFileSync(wrong, JSON.stringify({ hello: "world" }))

		expect(
			loadPrebuilt(path.join(directory, "calls.js"), wrong),
		).rejects.toThrow("is not a Module Descriptor")
	})

	// A bundle built to run carries no bridge, and is refused saying so.
	it("refuses a bundle that carries no bridge", async () => {
		let plain = path.join(directory, "plain.js")
		let compiled = await compileToMemory(
			canonicalPath(clientFixture("Calls.es")),
			{ outputFileName: plain },
		)

		writeFileSync(plain, compiled.code)
		writeFileSync(
			descriptorPath(plain),
			readFileSync(
				descriptorPath(path.join(directory, "calls.js")),
				"utf8",
			),
		)

		expect(loadPrebuilt(plain)).rejects.toThrow("exports no runtime bridge")
	})
})

// The pair `esc build --embed` writes, loaded by `loadPrebuilt`, which proves
// the CLI writes what the reader reads.
describe("`esc build --embed`", () => {
	// The repository's own `esc`, with a bundle cache of this run's own, so the
	// first build misses and the second hits.
	async function esc(
		...args: Array<string>
	): Promise<{ code: number; output: string }> {
		let run = await spawnAndWait(
			[path.join(REPOSITORY, "packages", "cli", "bin", "esc"), ...args],
			{
				cwd: REPOSITORY,
				env: {
					...process.env,
					ESSENCE_CLI_CACHE: path.join(directory, "cli-cache"),
				},
			},
		)

		return { code: run.code ?? 1, output: `${run.stdout}${run.stderr}` }
	}

	it("writes a pair `loadPrebuilt` can read", async () => {
		let built = path.join(directory, "built")
		let bundle = path.join(built, "Calls.js")
		let run = await esc(
			"build",
			path.relative(REPOSITORY, clientFixture("Calls.es")),
			"-o",
			bundle,
			"--embed",
			"--quiet",
		)

		expect(run.code).toBe(0)
		// `--embed` adds the Descriptor beside the bundle, and nothing else.
		expect(readdirSync(built).sort()).toEqual([
			"Calls.descriptor.json",
			"Calls.js",
		])
		expect(descriptorPath(bundle)).toBe(
			path.join(built, "Calls.descriptor.json"),
		)

		let module = await loadPrebuilt(bundle)

		expect(
			(module.exports.labelled as (...args: Array<unknown>) => unknown)(
				10n,
				4n,
			),
		).toBe(6n)
		expect(
			(
				module.exports.applyTwice as (
					transform: (value: bigint) => bigint,
					value: bigint,
				) => bigint
			)((value) => value * 3n, 2n),
		).toBe(18n)
		expect((module.exports.Colour as Record<string, unknown>).Red).toEqual({
			$case: "Colour#Red",
		})
	})

	// `esc` links for the embed, so the bundle binds what the Descriptor lists.
	it("writes a pair whose Namespace offers its provided Methods", async () => {
		let bundle = path.join(directory, "provided", "Provided.js")
		let run = await esc(
			"build",
			path.relative(REPOSITORY, clientFixture("Provided.es")),
			"-o",
			bundle,
			"--embed",
			"--quiet",
		)

		expect(run.code).toBe(0)

		let module = await loadPrebuilt(bundle)
		let rectangles = module.exports.Rectangles as Record<
			string,
			(...args: Array<unknown>) => unknown
		>

		expect(rectangles.isEmpty!({ width: 0n, height: 4n })).toBe(true)
		expect(rectangles.scaled!({ width: 2n, height: 3n }, 2n)).toBe(12n)
	})

	// `esc` decides the Dictionary door from the Descriptor it writes, so a
	// host can hand this pair a `Map`.
	it("writes a pair that carries a Dictionary", async () => {
		let built = path.join(directory, "ledger")
		let bundle = path.join(built, "Ledger.js")
		let source = path.join(directory, "Ledger.es")

		writeFileSync(
			source,
			`implementation {

	function ages(_ value: Dictionary<String, Integer>) -> Dictionary<String, Integer> {
		<- value::set("added", to 9)
	}
}

export {
	ages
}
`,
		)

		let run = await esc("build", source, "-o", bundle, "--embed", "--quiet")

		expect(run.code).toBe(0)

		let module = await loadPrebuilt(bundle)
		let ages = module.exports.ages as (
			value: Map<string, bigint>,
		) => Map<string, bigint>

		expect([...ages(new Map([["alex", 39n]]))]).toEqual([
			["alex", 39n],
			["added", 9n],
		])
		expect(readFileSync(bundle, "utf8")).toContain("createDictionaryFrom")
	})

	// And leaves the door out of a bundle whose boundary names no Dictionary.
	it("leaves the Dictionary door out of a pair that names none", async () => {
		let built = path.join(directory, "plain")
		let bundle = path.join(built, "Plain.js")
		let source = path.join(directory, "Plain.es")

		writeFileSync(
			source,
			`implementation {

	function twice(_ value: Integer) -> Integer {
		<- value::multiply(with 2)
	}
}

export {
	twice
}
`,
		)

		let run = await esc("build", source, "-o", bundle, "--embed", "--quiet")

		expect(run.code).toBe(0)

		let code = readFileSync(bundle, "utf8")

		expect(code).not.toContain("createDictionaryFrom")
		expect(code).not.toContain("liveEntriesOf")

		let module = await loadPrebuilt(bundle)

		expect((module.exports.twice as (value: bigint) => bigint)(3n)).toBe(6n)
	})

	// The Future door is decided the same way, and `loadPrebuilt` takes a
	// signal as `loadModule` does.
	it("writes a pair that carries work, and a stop for it", async () => {
		let built = path.join(directory, "waiting")
		let bundle = path.join(built, "Waiting.js")
		let source = path.join(directory, "Waiting.es")

		writeFileSync(
			source,
			`implementation {

	function doubled(_ value: Integer) -> Future<Integer> {
		<- complete Async.deferred(() { <- value::multiply(with 2) })
	}
}

export {
	doubled
}
`,
		)

		let run = await esc("build", source, "-o", bundle, "--embed", "--quiet")

		expect(run.code).toBe(0)

		let module = await loadPrebuilt(bundle)
		let doubled = module.exports.doubled as (
			value: bigint,
		) => Promise<bigint>

		expect(await doubled(21n)).toBe(42n)

		let stopping = new AbortController()

		stopping.abort()

		let stoppable = await loadPrebuilt(bundle, undefined, {
			signal: stopping.signal,
		})

		// An aborted host starts nothing, so the promise never settles.
		let settled = false

		void (stoppable.exports.doubled as (value: bigint) => Promise<bigint>)(
			21n,
		).then(
			() => {
				settled = true
			},
			() => {
				settled = true
			},
		)

		await new Promise((resolve) => setTimeout(resolve, 20))

		expect(settled).toBe(false)
	})

	// And leaves `Future.ts` out of a bundle whose boundary names no work.
	it("leaves the asynchrony door out of a pair that names none", async () => {
		let built = path.join(directory, "sync")
		let bundle = path.join(built, "Sync.js")
		let source = path.join(directory, "Sync.es")

		writeFileSync(
			source,
			`implementation {

	function thrice(_ value: Integer) -> Integer {
		<- value::multiply(with 3)
	}
}

export {
	thrice
}
`,
		)

		let run = await esc("build", source, "-o", bundle, "--embed", "--quiet")

		expect(run.code).toBe(0)

		let code = readFileSync(bundle, "utf8")

		expect(code).not.toContain("futureContext")
		expect(code).not.toContain("futureAnswer")
	})

	// `esc` and an in-memory compile write the same Descriptor, compared as
	// values since indentation may differ.
	it("describes the same boundary an embedded compile does", () => {
		let written = JSON.parse(
			readFileSync(
				path.join(directory, "built", "Calls.descriptor.json"),
				"utf8",
			),
		)

		expect(written).toEqual(
			JSON.parse(
				readFileSync(
					descriptorPath(path.join(directory, "calls.js")),
					"utf8",
				),
			),
		)
	})

	// A build that finds its bundle in the cache still writes the pair.
	it("writes the pair for a build that found its bundle", async () => {
		let again = path.join(directory, "again")
		let bundle = path.join(again, "Calls.js")
		let run = await esc(
			"build",
			path.relative(REPOSITORY, clientFixture("Calls.es")),
			"-o",
			bundle,
			"--embed",
		)

		expect(run.code).toBe(0)
		// The reported timeline skips from validation to the write, which
		// shows the bundle was found.
		expect(run.output).toMatch(/^\s+write\s/m)
		expect(run.output).not.toMatch(/^\s+bundle\s/m)
		expect(readdirSync(again).sort()).toEqual([
			"Calls.descriptor.json",
			"Calls.js",
		])
		expect(readFileSync(bundle, "utf8")).toBe(
			readFileSync(path.join(directory, "built", "Calls.js"), "utf8"),
		)
		expect(
			(
				(await loadPrebuilt(bundle)).exports.labelled as (
					...args: Array<unknown>
				) => unknown
			)(10n, 4n),
		).toBe(6n)
	})

	// A plain build writes no Descriptor, and its bundle is cached apart.
	it("writes nothing beside a build that did not ask for it", async () => {
		let plain = path.join(directory, "plain-build")
		let bundle = path.join(plain, "Calls.js")
		let run = await esc(
			"build",
			path.relative(REPOSITORY, clientFixture("Calls.es")),
			"-o",
			bundle,
			"--quiet",
		)

		expect(run.code).toBe(0)
		expect(readdirSync(plain)).toEqual(["Calls.js"])
		// `BRIDGE_KEY` in the emitter key keeps the embedded build apart.
		expect(readFileSync(bundle, "utf8")).not.toBe(
			readFileSync(path.join(directory, "built", "Calls.js"), "utf8"),
		)
		expect(readFileSync(bundle, "utf8")).not.toContain("export default")
	})

	// Only the Descriptor says which Choices cross as bare names. It is read
	// off disk first, so a failure tells whether `esc` or the loader lost it.
	it("bakes which Choices cross as bare names", async () => {
		let embedded = path.join(directory, "marshal")
		let bundle = path.join(embedded, "Marshal.js")
		let run = await esc(
			"build",
			path.relative(REPOSITORY, clientFixture("Marshal.es")),
			"-o",
			bundle,
			"--embed",
			"--quiet",
		)

		expect(run.code).toBe(0)

		let written = JSON.parse(
			readFileSync(descriptorPath(bundle), "utf8"),
		) as {
			exports: Record<
				string,
				{ cases: Array<{ name: string; unitChoice: boolean }> }
			>
		}

		function spellingOf(choice: string): Array<[string, boolean]> {
			return written.exports[choice]!.cases.map((node) => [
				node.name,
				node.unitChoice,
			])
		}

		expect(spellingOf("Direction")).toEqual([
			["Up", true],
			["Down", true],
		])
		// One payload makes every Case of a Choice an object, `Blank` included.
		expect(spellingOf("Shape")).toEqual([
			["Circle", false],
			["Rect", false],
			["Blank", false],
		])

		let module = await loadPrebuilt(bundle)
		let called = (name: string, value: unknown) =>
			(module.exports[name] as (value: unknown) => unknown)(value)

		expect(called("direction", "Up")).toBe("Up")
		expect(called("direction", "Direction#Down")).toBe("Down")
		expect(called("directions", ["Up", "Down"])).toEqual(["Up", "Down"])
		expect(called("marker", { direction: "Down" })).toEqual({
			direction: "Down",
		})
		// The constructors, and a constant marshalled when read.
		expect(module.exports.Direction).toEqual({ Up: "Up", Down: "Down" })
		expect(module.exports.heading).toBe("Up")
		expect(module.exports.plus).toBe("Plus")
		expect((module.exports.Shape as Record<string, unknown>).Blank).toEqual(
			{ $case: "Shape#Blank" },
		)
	})
})

// `prebuilt.ts` and `bridge.ts` must not reach the compiler. A test run has it
// on disk, so their value imports are read as text.
describe("The prebuilt door", () => {
	const FILES = ["prebuilt.ts", "bridge.ts"]

	for (let name of FILES) {
		let source = readFileSync(
			path.join(import.meta.dirname, "..", name),
			"utf8",
		)
		// `[^"']*?` spans the lines of a formatted import list, and stops at
		// its specifier.
		let imports = [
			...source.matchAll(/^import\s+(type\s+)?[^"']*?from\s+"([^"]+)"/gm),
		].map((match) => ({
			specifier: match[2] as string,
			typeOnly: match[1] !== undefined,
		}))

		it(`imports no Compiler into ${name}`, () => {
			expect(imports.length).toBeGreaterThan(0)

			for (let { specifier, typeOnly } of imports) {
				if (specifier.startsWith("@essence-lang/compiler")) {
					expect(typeOnly).toBe(true)
				}
			}
		})

		// No dynamic import of a literal specifier. `loadPrebuilt` imports its
		// bundle through a variable.
		it(`reaches for no Compiler at run time in ${name}`, () => {
			expect(source).not.toMatch(/import\s*\(\s*["']/)
			expect(source).not.toMatch(/\brequire\s*\(/)
		})
	}
})
