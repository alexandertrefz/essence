import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import * as path from "node:path"

import {
	carriesDictionary,
	carriesFuture,
	linkToMemory,
} from "@essence-lang/compiler/embed"
import {
	canonicalPath,
	type ExportSurface,
} from "@essence-lang/compiler/modules"

import {
	type DeclaredType,
	describe as describeType,
	describeModule,
	describeTypes,
	type Descriptor,
	type ModuleDescriptor,
} from "../descriptor"

const FILES = path.join(import.meta.dirname, "files")

// Every fixture of this package's shapes.
const FIXTURES = [
	"Marshal.es",
	"Calls.es",
	"Declarations.es",
	"Defaults.es",
	"Escaped.es",
	"Refused.es",
	"Async.es",
]

// Linked rather than compiled, since a Descriptor is decided before anything is
// emitted.
function moduleDescriptor(fileName: string): ModuleDescriptor {
	let entry = canonicalPath(path.join(FILES, fileName))

	return describeModule(linkToMemory(entry).surface, entry)
}

// The Types the Module names, which the door questions ask about too.
function moduleTypes(fileName: string): Array<DeclaredType> {
	let entry = canonicalPath(path.join(FILES, fileName))

	return describeTypes(linkToMemory(entry).surface, entry)
}

// A Descriptor is the contract both halves of the boundary read, so a change
// to one shows as a snapshot diff someone has to read.
describe("A Module described", () => {
	for (let fileName of FIXTURES) {
		it(`describes ${fileName}`, () => {
			expect(moduleDescriptor(fileName)).toMatchSnapshot()
		})
	}

	// Only an `embed` compile binds them, so a plain build is left as it was.
	it("lists the provided Methods an exported Namespace offers a host", () => {
		let entry = canonicalPath(path.join(FILES, "Provided.es"))
		let signatures = (surface: ExportSurface): unknown => {
			let rectangles = describeModule(surface, entry).exports.Rectangles

			return rectangles?.kind === "namespace"
				? Object.fromEntries(
						Object.entries(rectangles.methods).map(
							([name, method]) => [
								name,
								method.kind === "function"
									? method.of.shown
									: null,
							],
						),
					)
				: null
		}

		expect(
			signatures(linkToMemory(entry, { embed: true }).surface),
		).toEqual({
			area: "(_ { width: Integer, height: Integer }) -> Integer",
			isEmpty: "(_ { width: Integer, height: Integer }) -> Boolean",
			scaled: "(_ { width: Integer, height: Integer }, by: Integer) -> Integer",
		})
		expect(signatures(linkToMemory(entry).surface)).toEqual({
			area: "(_ { width: Integer, height: Integer }) -> Integer",
		})
	})

	it("shows a bound by its Protocol's name and never its path", () => {
		let measure = moduleDescriptor("Bounded.es").exports.measure

		expect(measure?.kind === "function" ? measure.of.shown : null).toBe(
			"<Item is Sized>(_ Item) -> Integer",
		)
		expect(JSON.stringify(measure)).not.toContain(canonicalPath(FILES))
	})

	// The Descriptor fixes the entry-relative tag every built value carries.
	it("bakes a Case tag as the bundle spells it", () => {
		expect(moduleDescriptor("Marshal.es").exports.circle).toMatchObject({
			kind: "constant",
			of: {
				kind: "union",
				arms: [
					{ tag: "./Marshal.es#Shape#Circle" },
					{ tag: "./Marshal.es#Shape#Rect" },
					{ tag: "./Marshal.es#Shape#Blank" },
				],
			},
		})
	})

	// An unannotated `Optional<Integer>#Value(3)` infers the lone Case, which is
	// marked as spelled by absence.
	it("marks one of Optional's own Cases met without the other", () => {
		expect(
			describeType(
				{
					type: "Case",
					choice: "Optional",
					name: "Value",
					members: { item: { type: "Integer" } },
				},
				{ entryPath: "/somewhere/Main.es" },
			),
		).toEqual({
			kind: "case",
			tag: "Optional#Value",
			choice: "Optional",
			name: "Value",
			optional: true,
			unitChoice: false,
			payload: { item: { of: { kind: "integer", shown: "Integer" } } },
			shown: "Optional#Value",
		})
	})

	// A Module's own `choice Optional` is an ordinary Choice. The whole identity
	// tells it apart, since both print `Optional`.
	it("leaves a Module's own Choice of that name alone", () => {
		expect(
			describeType(
				{
					type: "Case",
					choice: "/somewhere/Shapes.es#Optional",
					name: "Value",
					members: {},
				},
				{ entryPath: "/somewhere/Main.es" },
			),
		).toEqual({
			kind: "case",
			tag: "./Shapes.es#Optional#Value",
			choice: "Optional",
			name: "Value",
			optional: false,
			unitChoice: false,
			payload: {},
			shown: "Optional#Value",
		})
	})

	// An omittable payload member carries its `fill`, since no callee fills it
	// in. Without one the declaration would promise a call the marshaller refuses.
	it("carries a fill beside every omittable payload member", () => {
		let described = moduleDescriptor("Defaults.es")
		let seen = 0

		let walk = (node: Descriptor): void => {
			switch (node.kind) {
				case "case":
					for (let member of Object.values(node.payload)) {
						if (member.optional === true) {
							seen += 1

							expect(member.fill).toBeDefined()
						}

						walk(member.of)
					}

					return
				case "record":
					for (let member of Object.values(node.members)) {
						walk(member.of)
					}

					return
				case "list":
				case "optional":
					walk(node.of)

					return
				case "union":
					node.arms.forEach(walk)

					return
				case "function":
					for (let parameter of node.parameters) {
						walk(parameter.of)
					}

					walk(node.returns)

					return
				default:
					return
			}
		}

		for (let entry of Object.values(described.exports)) {
			switch (entry.kind) {
				case "constant":
					walk(entry.of)
					break
				case "function":
					walk(entry.of)
					break
				case "overloaded":
					entry.overloads.forEach((overload) => walk(overload.of))
					break
				case "choice":
					entry.cases.forEach(walk)
					break
				default:
					break
			}
		}

		// Five members at each of the Choice's entry, a Parameter and a return.
		// One is filled from a Constant and carries a `fill` like the others.
		expect(seen).toBe(15)
	})

	// Only `Optional<T>` itself collapses. A Union containing one decides arm by
	// arm.
	it("collapses an Optional and leaves every other Union alone", () => {
		let calls = moduleDescriptor("Calls.es")

		// `measure(box: Optional<Box>)` and `boxed(box: Box | Integer)`.
		expect(calls.exports.measure).toMatchObject({
			of: { parameters: [{ of: { kind: "optional" } }] },
		})
		expect(calls.exports.boxed).toMatchObject({
			of: { parameters: [{ of: { kind: "union" } }] },
		})
	})

	// Work is described wherever it stands. Which positions may hold it is the
	// marshaller's rule.
	it("describes work as what it answers with, at every position", () => {
		let described = moduleDescriptor("Async.es")

		expect(described.exports.doubled).toMatchObject({
			kind: "function",
			of: {
				returns: {
					kind: "future",
					of: { kind: "integer" },
					shown: "Future<Integer>",
				},
			},
		})
		expect(described.exports.running).toMatchObject({
			of: { returns: { kind: "started", of: { kind: "integer" } } },
		})
		expect(described.exports.queued).toMatchObject({
			of: {
				parameters: [
					{
						of: {
							kind: "record",
							members: { work: { of: { kind: "future" } } },
						},
					},
				],
			},
		})
	})

	// Whether the bundle carries the Future door, asked of the whole boundary.
	it("answers whether the boundary names work at all", () => {
		expect(
			carriesFuture(
				moduleDescriptor("Async.es"),
				moduleTypes("Async.es"),
			),
		).toBe(true)
		expect(
			carriesFuture(
				moduleDescriptor("Marshal.es"),
				moduleTypes("Marshal.es"),
			),
		).toBe(false)
	})

	// The door question walks through work to what it answers, so `counted`
	// still needs the Dictionary door.
	it("finds a Dictionary a future answers with", () => {
		expect(
			carriesDictionary(
				moduleDescriptor("Async.es"),
				moduleTypes("Async.es"),
			),
		).toBe(true)
	})
})

describe("A Descriptor", () => {
	// A Descriptor is written on one machine and read on another, so it must
	// survive `JSON.stringify`.
	for (let fileName of FIXTURES) {
		it(`survives a round trip through JSON for ${fileName}`, () => {
			let descriptor = moduleDescriptor(fileName)

			expect(
				JSON.parse(JSON.stringify(descriptor)) as ModuleDescriptor,
			).toEqual(descriptor)
		})
	}
})

// The interpreter must not reach a toolchain. A test run has the compiler on
// disk, so this reads the imports as text, as a bundler would follow them.
describe("The runtime half", () => {
	const RUNTIME_SAFE = ["./bare-cases", "./errors", "./rational"]
	const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../../..")

	function sourceOf(fileName: string): string {
		return readFileSync(
			path.join(import.meta.dirname, "..", fileName),
			"utf8",
		)
	}

	function needsAToolchain(specifier: string): boolean {
		return (
			specifier.startsWith("node:") ||
			specifier.startsWith("@essence-lang/compiler") ||
			specifier === "esbuild"
		)
	}

	// `[^"']*?` spans the lines of a formatted import list, and stops at its
	// specifier.
	function importsOf(
		source: string,
	): Array<{ specifier: string; typeOnly: boolean }> {
		return [
			...source.matchAll(/^import\s+(type\s+)?[^"']*?from\s+"([^"]+)"/gm),
		].map((match) => ({
			specifier: match[2]!,
			typeOnly: match[1] !== undefined,
		}))
	}

	// Every file a bundler reaches from the interpreter, following the value
	// imports Bun's transpiler keeps.
	function bundledFrom(entry: string): Map<string, string> {
		let transpiler = new Bun.Transpiler({ loader: "ts" })
		let bundled = new Map<string, string>()
		let pending = [entry]

		while (pending.length > 0) {
			let file = pending.pop()!

			if (bundled.has(file)) {
				continue
			}

			let source = readFileSync(file, "utf8")

			bundled.set(file, source)

			for (let { path: specifier } of transpiler.scanImports(source)) {
				if (!needsAToolchain(specifier)) {
					pending.push(Bun.resolveSync(specifier, path.dirname(file)))
				}
			}
		}

		return bundled
	}

	const MARSHALLER = sourceOf("marshal-runtime.ts")
	const SHARED_RULE = sourceOf("bare-cases.ts")
	const BUNDLED = bundledFrom(
		path.join(import.meta.dirname, "..", "marshal-runtime.ts"),
	)

	it("reads its own imports and follows them", () => {
		expect(importsOf(MARSHALLER).length).toBeGreaterThan(0)
		expect(BUNDLED.size).toBeGreaterThan(1)
	})

	// Every specifier a bundled file names, the type-only ones as well.
	it("imports nothing that needs a Compiler, a file system or a toolchain", () => {
		let transpiler = new Bun.Transpiler({ loader: "ts" })
		let reached: Array<string> = []

		for (let [file, source] of BUNDLED) {
			let specifiers = new Set([
				...importsOf(source).map((entry) => entry.specifier),
				...transpiler.scanImports(source).map((entry) => entry.path),
			])

			for (let specifier of specifiers) {
				if (needsAToolchain(specifier)) {
					reached.push(
						`${path.relative(REPOSITORY_ROOT, file)}: ${specifier}`,
					)
				}
			}
		}

		expect(reached).toEqual([])
	})

	// `./descriptor` and `./bridge` may be imported for types, which are
	// erased. A value import would pull the compiler in.
	it("imports values from the runtime-safe files alone", () => {
		expect(
			importsOf(MARSHALLER)
				.filter((entry) => !entry.typeOnly)
				.map((entry) => entry.specifier)
				.sort(),
		).toEqual(RUNTIME_SAFE)
	})

	// `bare-cases.ts` imports no value at all.
	it("leaves the shared rule with no value imports of its own", () => {
		expect(
			importsOf(SHARED_RULE).filter((entry) => !entry.typeOnly),
		).toEqual([])
	})

	// No dynamic import or `require` reaches around the import list.
	it("reaches for nothing at run time either", () => {
		for (let source of BUNDLED.values()) {
			expect(source).not.toMatch(/\bimport\s*\(/)
			expect(source).not.toMatch(/\brequire\s*\(/)
		}
	})
})
