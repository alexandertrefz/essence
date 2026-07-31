import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { compileToMemory } from "@essence-lang/compiler/embed"
import type { ExportSurface } from "@essence-lang/compiler/modules"
import { fixturePath } from "@essence-lang/fixtures"

import { type DeclarationView, generateDeclarations } from "../dts"

const REPOSITORY = path.join(import.meta.dirname, "..", "..", "..", "..")

// NOTE: The real class rather than a copy of its shape. A consumer of a
// generated file imports `EssenceRational` from this package, and a stub
// declaring what it is thought to be would typecheck a Module against a Rational
// that does not exist.
const RATIONAL_MODULE = path.join(import.meta.dirname, "..", "rational")

function clientFixture(name: string): string {
	return path.join(import.meta.dirname, "files", name)
}

async function surfaceOf(entryPath: string): Promise<ExportSurface> {
	let compiled = await compileToMemory(entryPath)

	expect(compiled.diagnostics).toEqual([])

	return compiled.surface
}

async function declarationsOf(
	entryPath: string,
	view: DeclarationView = "javascript",
): Promise<string> {
	return generateDeclarations(await surfaceOf(entryPath), {
		moduleName: path.basename(entryPath),
		view,
	})
}

// NOTE: `tsc` over a directory of its own, extending the repository's own
// TypeScript settings — the point of the exercise is that a generated file
// compiles where its reader's code compiles, and a laxer configuration invented
// for the test would answer a question nobody asked. `typeRoots` is absolute
// because a temporary directory has no `node_modules` above it.
function typecheck(files: Record<string, string>): {
	code: number
	output: string
} {
	let directory = mkdtempSync(path.join(tmpdir(), "essence-dts-"))

	try {
		for (let [name, contents] of Object.entries(files)) {
			writeFileSync(path.join(directory, name), contents)
		}

		writeFileSync(
			path.join(directory, "tsconfig.json"),
			JSON.stringify({
				extends: path.join(REPOSITORY, "tsconfig.base.json"),
				compilerOptions: {
					// NOTE: What makes `./Math.es` resolve to `Math.d.es.ts`.
					allowArbitraryExtensions: true,
					types: ["bun"],
					typeRoots: [
						path.join(REPOSITORY, "node_modules", "@types"),
					],
				},
				include: ["*.ts"],
			}),
		)

		// NOTE: The repository's own `tsc`, by path. `bun x tsc` from a directory
		// with no `node_modules` above it goes to the network for one, which
		// makes the test both slow and a liar about which compiler it ran.
		let run = Bun.spawnSync(
			[
				path.join(REPOSITORY, "node_modules", ".bin", "tsc"),
				"--project",
				directory,
			],
			{ cwd: directory },
		)

		return {
			code: run.exitCode,
			output: `${new TextDecoder().decode(
				run.stdout,
			)}${new TextDecoder().decode(run.stderr)}`,
		}
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

describe("The JavaScript view", () => {
	it("describes a Module of a constant and a Function", async () => {
		expect(
			await declarationsOf(fixturePath("modules", "math", "Math.es")),
		).toBe(
			`// Generated from Math.es by @essence-lang/client. Do not edit.
//
// The Module as JavaScript — what \`loadModule(…).exports\` answers with.

import type { EssenceRational } from "@essence-lang/client"

export declare const PI: EssenceRational
export declare function square(p0: bigint): bigint
`,
		)
	})

	// NOTE: `Rectangle` is a Type Alias AND the Namespace of that name, so it is
	// declared twice — as a Type and as a value. TypeScript keeps the two in
	// separate declaration spaces for exactly this.
	it("declares a Type and the Namespace that shares its name", async () => {
		expect(await declarationsOf(fixturePath("modules", "Main.es"))).toBe(
			`// Generated from Main.es by @essence-lang/client. Do not edit.
//
// The Module as JavaScript — what \`loadModule(…).exports\` answers with.

export type Rectangle = { width: bigint; height: bigint }

export declare function describe(p0: Rectangle): string
export declare const Rectangle: { of(width: bigint, height: bigint): Rectangle }
`,
		)
	})

	// NOTE: By object identity, which the Enricher makes true: an Alias resolves
	// to ONE Type and every mention of it is that same object. Spelling the shape
	// out instead would read nothing like the source it came from, and would say
	// nothing about two Parameters being the same Type.
	it("names an exported Type rather than spelling its shape", async () => {
		let text = await declarationsOf(clientFixture("Marshal.es"))

		expect(text).toContain(
			"export type Box = { width: bigint; height: bigint }",
		)
		expect(text).toContain("export declare function box(p0: Box): Box")
		expect(text).toContain(
			"export declare function boxes(p0: Array<Box>): Array<Box>",
		)
	})

	it("collapses an Optional into `T | undefined`", async () => {
		let text = await declarationsOf(clientFixture("Marshal.es"))

		expect(text).toContain(
			"export declare function maybe(p0: bigint | undefined): bigint | undefined",
		)
		expect(text).toContain(
			"export declare const present: bigint | undefined",
		)
	})

	// NOTE: The tag `toJS` writes — the Choice as it was DECLARED and the Case.
	// Never the path of the machine that compiled it, which is what the Case's
	// identity carries and what a declaration file must not.
	it("spells a Case with the tag the Marshaller writes", async () => {
		let text = await declarationsOf(clientFixture("Marshal.es"))

		expect(text).toContain(`export type Shape =
	| { $case: "Shape#Circle"; radius: bigint }
	| { $case: "Shape#Rect"; width: bigint; height: bigint }
	| { $case: "Shape#Blank" }`)
		expect(text).not.toContain(clientFixture("Marshal.es"))
	})

	it("maps a Type Parameter to a TypeScript one", async () => {
		expect(
			await declarationsOf(clientFixture("Declarations.es")),
		).toContain(
			"export declare function firstOf<ItemType>(p0: Array<ItemType>): ItemType | undefined",
		)
	})

	it("declares a Protocol as a Type nothing holds", async () => {
		expect(
			await declarationsOf(clientFixture("Declarations.es")),
		).toContain("export type Measurable = unknown")
	})

	// NOTE: A `never` rather than the Overloads' signatures. Which Overload a call
	// means is decided by the Argument Types, which a JavaScript value does not
	// carry — so `exports` binds the name to a refusal, and declaring the
	// signatures would typecheck a call that throws.
	it("refuses an overloaded Method a callable Type", async () => {
		let text = await declarationsOf(clientFixture("Calls.es"))

		expect(text).toContain(
			"from: never /* overloaded — calling it throws */",
		)
		expect(text).toContain(
			"grown: never /* overloaded — calling it throws */",
		)
	})

	// NOTE: A module may name an export with a string literal, which is the only
	// way `ok?` reaches TypeScript at all. Leaving it out would say the Module
	// does not export it.
	it("exports a name JavaScript can not spell under a string", async () => {
		let text = await declarationsOf(clientFixture("Escaped.es"))

		expect(text).toContain("export declare const $$integer: bigint")
		expect(text).toContain(
			'declare const $export_ok_3f_: (p0: boolean) => boolean\nexport { $export_ok_3f_ as "ok?" }',
		)
	})
})

describe("The bundle view", () => {
	it("describes what the emitted bundle binds, and the bridge beside it", async () => {
		expect(
			await declarationsOf(
				fixturePath("modules", "math", "Math.es"),
				"bundle",
			),
		).toBe(
			`// Generated from Math.es by @essence-lang/client. Do not edit.
//
// The bundle's own exports: Essence values, under the names the Rewriter
// emitted them as, beside the bridge that builds values they accept.

// NOTE: An Essence value as JavaScript holds it — deliberately opaque. It
// carries its Type on a Symbol minted while this bundle was evaluated, so
// nothing outside the bundle can read one apart or build one.
type EssenceValue = object

export declare const PI: EssenceValue
export declare function square(p0: EssenceValue): EssenceValue

// NOTE: The bundle's own runtime. Every Essence value carries its Type on a
// Symbol minted while this bundle was evaluated, so these are the only
// constructors whose values its Functions recognise.
export declare const $bridge_typeKey: symbol
export declare const $bridge_case: (tag: string, payload?: Record<string, EssenceValue>) => EssenceValue
export declare const $bridge_integer: (value: bigint) => EssenceValue
export declare const $bridge_rational: (numerator: bigint, denominator: bigint) => EssenceValue
export declare const $bridge_string: (value: string) => EssenceValue
export declare const $bridge_boolean: (value: boolean) => EssenceValue
export declare const $bridge_list: (items: Array<EssenceValue>) => EssenceValue
export declare const $bridge_record: (fields: Record<string, EssenceValue>) => EssenceValue
`,
		)
	})

	// NOTE: The names the bundle actually binds. An Overload set binds none of its
	// own, and a Type, a Choice and a Protocol are erased before a byte is
	// emitted — a declaration for one would name an export that is not there.
	it("declares each Overload under the name the bundle binds", async () => {
		let text = await declarationsOf(clientFixture("Calls.es"), "bundle")

		expect(text).toContain(
			"from__overload$1(x: EssenceValue): EssenceValue",
		)
		expect(text).toContain(
			"from__overload$2(x: EssenceValue, y: EssenceValue): EssenceValue",
		)
		expect(text).not.toContain("export type Colour")
	})

	it("declares a name JavaScript can not spell as the Rewriter emits it", async () => {
		expect(await declarationsOf(clientFixture("Escaped.es"), "bundle"))
			.toContain(`// 'ok?' as the Rewriter emits it.
export declare function $user_ok_3f_(p0: EssenceValue): EssenceValue`)
	})
})

describe("A consumer of the generated declarations", () => {
	it("typechecks against them", async () => {
		let declarations = generateDeclarations(
			await surfaceOf(clientFixture("Marshal.es")),
			{ clientSpecifier: RATIONAL_MODULE },
		)
		let run = typecheck({
			"Marshal.d.es.ts": declarations,
			"consumer.ts": `import { areaOf, box, boxes, greeting, maybe, present, shape, third } from "./Marshal.es"
import type { Box, Label, Shape } from "./Marshal.es"

export let area: bigint = areaOf({ $case: "Shape#Circle", radius: 3n })
export let circle: Shape = shape({ $case: "Shape#Blank" })
export let one: Box = box({ width: 3n, height: 4n })
export let many: Array<Box> = boxes([one])
export let some: bigint | undefined = maybe(present)
export let label: Label = greeting
export let ratio: string = third.toString()
`,
		})

		expect(run.output).toBe("")
		expect(run.code).toBe(0)
	})

	// NOTE: The other half of the claim. Declarations that admit everything
	// typecheck every consumer, so a passing consumer says nothing on its own.
	it("is refused an Argument of the wrong Type", async () => {
		let declarations = generateDeclarations(
			await surfaceOf(clientFixture("Marshal.es")),
			{ clientSpecifier: RATIONAL_MODULE },
		)
		let run = typecheck({
			"Marshal.d.es.ts": declarations,
			"consumer.ts": `import { box } from "./Marshal.es"

export let wrong = box({ width: 3, height: 4 })
`,
		})

		expect(run.code).not.toBe(0)
		expect(run.output).toContain("consumer.ts")
		expect(run.output).toContain(
			"Type 'number' is not assignable to type 'bigint'",
		)
	})

	it("reaches an export JavaScript can not spell", async () => {
		let declarations = generateDeclarations(
			await surfaceOf(clientFixture("Escaped.es")),
			{ clientSpecifier: RATIONAL_MODULE },
		)
		let run = typecheck({
			"Escaped.d.es.ts": declarations,
			"consumer.ts": `import { "ok?" as ok, $$integer } from "./Escaped.es"

export let answer: boolean = ok(true)
export let twelve: bigint = $$integer
`,
		})

		expect(run.output).toBe("")
		expect(run.code).toBe(0)
	})

	// NOTE: The view the plugin writes, checked the same way — and it imports
	// nothing, which is the point of declaring `EssenceValue` in the file rather
	// than importing it: these sit beside a `.es` file in somebody else's
	// project.
	it("typechecks the bundle view without importing anything", async () => {
		let declarations = await declarationsOf(
			fixturePath("modules", "math", "Math.es"),
			"bundle",
		)

		expect(declarations).not.toContain("import")

		let run = typecheck({
			"Math.d.es.ts": declarations,
			"consumer.ts": `import { $bridge_integer, square } from "./Math.es"

export let squared = square($bridge_integer(12n))
`,
		})

		expect(run.output).toBe("")
		expect(run.code).toBe(0)
	})
})
