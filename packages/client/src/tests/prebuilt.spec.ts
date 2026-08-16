import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
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
	withRuntimeBridge,
} from "@essence-lang/compiler/embed"
import { describeModule } from "@essence-lang/compiler/embed/describe"
import { canonicalPath } from "@essence-lang/compiler/modules"

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

// NOTE: The pair, built the way anything that embeds the Compiler builds one:
// the bridge injected into the sources and the Surface described beside them,
// both against the same entry, because a Case tag is spelled relative to it.
// What `esc build --embed` does is exactly this, and the block below checks that
// by loading what `esc` wrote rather than what this wrote.
async function build(entryPath: string, name: string): Promise<string> {
	let entry = canonicalPath(entryPath)
	let bundlePath = path.join(directory, name)
	let compiled = await compileToMemory(entry, {
		transformSources: withRuntimeBridge,
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
	// NOTE: The whole claim in one call: a path to a bundle, and the Module as
	// JavaScript — no entry to compile, no graph to link, no Compiler anywhere
	// in the process that did it.
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

	// NOTE: A call spelled by its labels rather than positionally is the
	// Descriptor's own doing — the labels are on it, and this path never had a
	// Type to read them off.
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
		// NOTE: Built here and read by the Module, which is what says the tag a
		// constructor writes is the tag the bundle matches on.
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

	// NOTE: Everything `loadModule` answers with except the two things that only
	// a compile can produce — the Export Surface and a Marshaller over it.
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

	// NOTE: The rule stated on this side. `esc`'s `descriptorFileName` states it
	// on the other, and the block below is what keeps the two from drifting: it
	// asks `esc` for a pair and then finds the sidecar with this.
	it("looks for the sidecar beside the bundle", () => {
		expect(descriptorPath("dist/app.js")).toBe("dist/app.descriptor.json")
		expect(descriptorPath("/build/app.mjs")).toBe(
			"/build/app.descriptor.json",
		)
		// NOTE: A dot in a directory is not an extension, and a name that is
		// nothing but one has nothing to replace.
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

	// NOTE: Named by the file, because the thing that went wrong is which file
	// was pointed at. Read one member deep and the message would be about a
	// property of `undefined` from somewhere inside the binding.
	it("refuses a sidecar that is not a Descriptor", async () => {
		let wrong = path.join(directory, "wrong.json")

		writeFileSync(wrong, JSON.stringify({ hello: "world" }))

		expect(
			loadPrebuilt(path.join(directory, "calls.js"), wrong),
		).rejects.toThrow("is not a Module Descriptor")
	})

	// NOTE: A bundle built to RUN rather than to be loaded carries no bridge,
	// and every value the boundary would build needs one. Saying so beats a
	// `TypeError` about `undefined` from whichever constructor was reached for
	// first.
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

// NOTE: The pair as the toolchain actually writes it, loaded by the call that
// promises to read it. Everything above builds its own pair, which proves the
// reading; this proves that what `esc build --embed` leaves on disk IS that
// pair — the same bytes in the bundle, the same Descriptor beside it, under the
// name the reader looks for.
describe("`esc build --embed`", () => {
	// NOTE: The repository's own `esc`, by path — the same reasoning `typecheck`
	// spawns the repository's own `tsc` under. A published binary from somewhere
	// else would answer a question nobody asked.
	//
	// NOTE: With a bundle cache of this run's own, so that a spec building a
	// fixture neither answers out of the user's store nor fills it — and so that
	// the first build below is a miss and the second a hit, which is the whole
	// point of building twice.
	function esc(...args: Array<string>): { code: number; output: string } {
		let run = spawnSync(
			path.join(REPOSITORY, "packages", "cli", "bin", "esc"),
			args,
			{
				cwd: REPOSITORY,
				encoding: "utf8",
				env: {
					...process.env,
					ESSENCE_CLI_CACHE: path.join(directory, "cli-cache"),
				},
			},
		)

		return {
			code: run.status ?? 1,
			output: `${run.stdout ?? ""}${run.stderr ?? ""}`,
		}
	}

	it("writes a pair `loadPrebuilt` can read", async () => {
		let built = path.join(directory, "built")
		let bundle = path.join(built, "Calls.js")
		let run = esc(
			"build",
			path.relative(REPOSITORY, clientFixture("Calls.es")),
			"-o",
			bundle,
			"--embed",
			"--quiet",
		)

		expect(run.code).toBe(0)
		// NOTE: Two files and no more — the Descriptor is the only thing
		// `--embed` adds, and it is beside the bundle rather than in it.
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

	// NOTE: The Descriptor `esc` wrote and the one an in-memory compile of the
	// same entry writes are the same boundary — which is what says the two
	// writers of one are one writer. Indentation is the only difference allowed,
	// so both are read back as JSON and compared as values.
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

	// NOTE: A build that FOUND its bundle still has to leave the pair behind
	// wherever it was asked to put it. The Descriptor is written on the cached
	// path as well as the emitted one, and this is the build that only reaches
	// the first of those: identical sources into a second place, with the store
	// already holding the answer.
	it("writes the pair for a build that found its bundle", async () => {
		let again = path.join(directory, "again")
		let bundle = path.join(again, "Calls.js")
		let run = esc(
			"build",
			path.relative(REPOSITORY, clientFixture("Calls.es")),
			"-o",
			bundle,
			"--embed",
		)

		expect(run.code).toBe(0)
		// NOTE: What says this build FOUND its bundle rather than emitting a
		// second identical one: the timeline it reports stops at validation and
		// goes straight to the write. Byte-identical outputs alone would not
		// tell the two apart.
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

	// NOTE: Off by default, because everything else `esc build` writes is a
	// program to run. A build that did not ask for the pair leaves no half of it
	// behind — and is not the same bundle, which is what its own entry in the
	// store has to be keyed apart by.
	it("writes nothing beside a build that did not ask for it", () => {
		let plain = path.join(directory, "plain-build")
		let bundle = path.join(plain, "Calls.js")
		let run = esc(
			"build",
			path.relative(REPOSITORY, clientFixture("Calls.es")),
			"-o",
			bundle,
			"--quiet",
		)

		expect(run.code).toBe(0)
		expect(readdirSync(plain)).toEqual(["Calls.js"])
		// NOTE: The store already holds the embedded build of these exact
		// sources. Reading THAT back here would hand a plain build the bridge it
		// never asked for, which is what joining `BRIDGE_KEY` to the emitter key
		// prevents.
		expect(readFileSync(bundle, "utf8")).not.toBe(
			readFileSync(path.join(directory, "built", "Calls.js"), "utf8"),
		)
		expect(readFileSync(bundle, "utf8")).not.toContain("export default")
	})

	// NOTE: A unit Choice through the whole toolchain, because it is the one
	// rule of the boundary that no value carries: whether a Case crosses as its
	// bare name is a fact about the CHOICE, and by the time a prebuilt Module is
	// loaded the only thing left that could know it is the JSON beside the
	// bundle. Read off disk first, so that a failure says whether `esc` wrote
	// the fact or the loader lost it, and then crossed, which is the claim.
	//
	// NOTE: `Marshal.es` rather than the `Calls.es` above, because a fixture
	// keeps to what its header says it is for and this one is the table of
	// shapes that cross.
	it("bakes which Choices cross as bare names", async () => {
		let embedded = path.join(directory, "marshal")
		let bundle = path.join(embedded, "Marshal.js")
		let run = esc(
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
		// NOTE: The other half of the rule, in the same file and the same
		// Descriptor: one payload anywhere and every Case of that Choice keeps
		// the object form, its payload-less `Blank` included.
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
		// NOTE: And the two doors a value that was never called for comes
		// through — the constructors written out of the Descriptor, and a
		// constant, which is marshalled when it is read.
		expect(module.exports.Direction).toEqual({ Up: "Up", Down: "Down" })
		expect(module.exports.heading).toBe("Up")
		expect(module.exports.plus).toBe("Plus")
		expect((module.exports.Shape as Record<string, unknown>).Blank).toEqual(
			{ $case: "Shape#Blank" },
		)
	})
})

// NOTE: The rule this door exists for, checked as text because there is no other
// way to check it: a `bun test` run has the Compiler on disk either way, so an
// accidental import would work perfectly here and cost a shipped application the
// toolchain it was written to do without. What is asserted is what a bundler
// would follow — a value import — through both files this door is made of.
describe("The prebuilt door", () => {
	const FILES = ["prebuilt.ts", "bridge.ts"]

	for (let name of FILES) {
		let source = readFileSync(
			path.join(import.meta.dirname, "..", name),
			"utf8",
		)
		// NOTE: `[^"']*?` spans lines, which is what a formatted import list
		// needs, and can not run past the specifier of the import it is reading.
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

		// NOTE: And nothing reaches around the import list. `loadPrebuilt`'s own
		// `import()` of the bundle is the one exception, and it is a variable
		// rather than a specifier — nothing a bundler follows.
		it(`reaches for no Compiler at run time in ${name}`, () => {
			expect(source).not.toMatch(/import\s*\(\s*["']/)
			expect(source).not.toMatch(/\brequire\s*\(/)
		})
	}
})
