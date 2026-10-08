import { describe, expect, it } from "bun:test"
import * as path from "node:path"

import { compileToMemory } from "@essence-lang/compiler/embed"
import { canonicalPath } from "@essence-lang/compiler/modules"
import { fixturePath } from "@essence-lang/fixtures"

import {
	type DeclaredType,
	describeModule,
	describeTypes,
	type ModuleDescriptor,
} from "../descriptor"
import { type DeclarationView, generateDeclarations } from "../dts"
import { BORROWED_MODULE, typecheck } from "./typecheck"

function clientFixture(name: string): string {
	return path.join(import.meta.dirname, "files", name)
}

// What a plugin hands `generateDeclarations`, described against the entry as
// the bundle is, since a Case tag is entry-relative.
async function describedModule(
	entryPath: string,
): Promise<{ descriptor: ModuleDescriptor; types: Array<DeclaredType> }> {
	let entry = canonicalPath(entryPath)
	let compiled = await compileToMemory(entry, { embed: true })

	expect(compiled.diagnostics).toEqual([])

	return {
		descriptor: describeModule(compiled.surface, entry),
		types: describeTypes(compiled.surface, entry),
	}
}

async function declarationsOf(
	entryPath: string,
	view: DeclarationView = "javascript",
): Promise<string> {
	let { descriptor, types } = await describedModule(entryPath)

	return generateDeclarations(descriptor, {
		moduleName: path.basename(entryPath),
		types,
		view,
	})
}

// The `javascript` view, importing the borrowed names by path, since a
// temporary directory has no `node_modules` above it.
async function declarationsFor(entryPath: string): Promise<string> {
	let { descriptor, types } = await describedModule(entryPath)

	return generateDeclarations(descriptor, {
		clientSpecifier: BORROWED_MODULE,
		types,
	})
}

describe("The JavaScript view", () => {
	it("describes a Module of a constant and a Function", async () => {
		expect(
			await declarationsOf(fixturePath("modules", "math", "Math.es")),
		).toBe(
			`// Generated from Math.es by @essence-lang/client. Do not edit.
//
// The Module as JavaScript — marshalled at every boundary.

import type { EssenceRational } from "@essence-lang/client"

export declare const PI: EssenceRational
export declare function square(p0: bigint | number): bigint
`,
		)
	})

	// `Rectangle` is a Type Alias and a Namespace, declared as a Type and as a
	// value, which TypeScript keeps apart.
	it("declares a Type and the Namespace that shares its name", async () => {
		expect(await declarationsOf(fixturePath("modules", "Main.es"))).toBe(
			`// Generated from Main.es by @essence-lang/client. Do not edit.
//
// The Module as JavaScript — marshalled at every boundary.

import type { Input } from "@essence-lang/client"

export type Rectangle = { width: bigint; height: bigint }

export declare function describe(p0: Input<Rectangle>): string

export declare const Rectangle: {
	of(width: bigint | number, height: bigint | number): Rectangle
	of(labelled: { width: bigint | number; height: bigint | number }): Rectangle
}
`,
		)
	})

	// An exported Type is printed by name. Going in, one holding an Integer is
	// wrapped in `Input<…>`.
	it("names an exported Type rather than spelling its shape", async () => {
		let text = await declarationsOf(clientFixture("Marshal.es"))

		expect(text).toContain(
			"export type Box = { width: bigint; height: bigint }",
		)
		expect(text).toContain(
			"export declare function box(p0: Input<Box>): Box",
		)
		expect(text).toContain(
			"export declare function boxes(p0: Array<Input<Box>>): Array<Box>",
		)
		expect(text).toContain("export declare function card(p0: Card): Card")
	})

	it("collapses an Optional into `T | undefined`", async () => {
		let text = await declarationsOf(clientFixture("Marshal.es"))

		expect(text).toContain(
			"export declare function maybe(p0: bigint | number | undefined): bigint | undefined",
		)
		expect(text).toContain(
			"export declare const present: bigint | undefined",
		)
	})

	// A `Map` at every key Type, its Integer key widened going in, and an alias
	// holding one still named.
	it("declares a Dictionary as a Map of its two slots", async () => {
		let text = await declarationsOf(clientFixture("Marshal.es"))

		expect(text).toContain(
			"export declare function ages(p0: Map<string, bigint | number>): Map<string, bigint>",
		)
		expect(text).toContain(
			"export declare function counts(p0: Map<bigint | number, string>): Map<bigint, string>",
		)
		expect(text).toContain(
			"export declare const sizes: Map<string, bigint>",
		)
		expect(text).toContain(
			"export type Ledger = { entries: Map<string, bigint> }",
		)
		expect(text).toContain(
			"export declare function ledger(p0: Input<Ledger>): Ledger",
		)
	})

	// Bare Case keys print as their names.
	it("declares a bare Case key as the union of its names", async () => {
		expect(await declarationsOf(clientFixture("Marshal.es"))).toContain(
			"export declare function headings(p0: Map<Direction, bigint | number>): Map<Direction, bigint>",
		)
	})

	// The tag `toJS` writes: the Choice as declared and the Case, without the
	// compiling machine's path.
	it("spells a Case with the tag the Marshaller writes", async () => {
		let text = await declarationsOf(clientFixture("Marshal.es"))

		expect(text).toContain(`export type Shape =
	| { $case: "Shape#Circle"; radius: bigint }
	| { $case: "Shape#Rect"; width: bigint; height: bigint }
	| { $case: "Shape#Blank" }`)
		expect(text).not.toContain(clientFixture("Marshal.es"))
	})

	// Nothing can be built against an unapplied Type Parameter, so it is `never`
	// going in, and the Function declares no Type Parameter.
	it("refuses a Type Parameter in a Parameter position", async () => {
		let refusal =
			"ItemType is a Type Parameter — there is no shape to build a value against until it is applied."

		expect(
			await declarationsOf(clientFixture("Declarations.es")),
		).toContain(
			`export declare function firstOf(p0: Array<never /* ${refusal} */>): unknown /* ${refusal} */ | undefined`,
		)
	})

	// A callback's Parameters come out as `bigint`, and its answer goes in, so a
	// safe number satisfies it.
	it("declares a callback Parameter as the call the Module will make", async () => {
		let text = await declarationsOf(clientFixture("Calls.es"))

		expect(text).toContain(
			"export declare function applied(p0: bigint | number, p1: (p0: bigint) => bigint | number): bigint",
		)
		expect(text).toContain(
			"export declare function measured(box: Input<Box>, by: (p0: Box) => bigint | number): bigint",
		)
	})

	// An alias whose members read the same both ways is named in both.
	it("names a Type whose members cross the same way in both directions", async () => {
		let text = await declarationsOf(clientFixture("Calls.es"))

		expect(text).toContain(
			"export type Handler = { callback: (p0: bigint | number) => bigint }",
		)
		expect(text).toContain(
			"export declare function invoke(p0: Handler): bigint",
		)
	})

	// `Nest` holds a nested Optional, which can not go in, so the Parameter
	// spells it out with `never` on that member.
	it("spells out a named Type whose member can not cross in", async () => {
		let text = await declarationsOf(clientFixture("Refused.es"))

		expect(text).toContain(
			"export type Nest = { level: bigint | undefined }",
		)
		expect(text).toContain(
			"export declare function nesting(p0: { level: never /* an Optional inside an Optional has no JavaScript spelling */ }): Nest",
		)
	})

	// A Function coming out is wrapped, and declared as the wrapper is called.
	it("declares a Function that comes back as callable", async () => {
		let text = await declarationsOf(clientFixture("Calls.es"))

		expect(text).toContain(
			"export declare function makeAdder(p0: bigint | number): (p0: bigint | number) => bigint",
		)
		expect(text).toContain(
			"export declare const handler: { callback: (p0: bigint | number) => bigint }",
		)
	})

	// A Choice is a Type and a const of constructors under one name. See "Unions
	// and Cases" in DEVELOPMENT.md.
	it("declares a Choice's Cases as the constructors a host spells them with", async () => {
		expect(await declarationsOf(clientFixture("Marshal.es"))).toContain(
			`export declare const Shape: {
	Circle<Payload_ extends { radius: bigint | number }>(payload: Payload_): Payload_ & { $case: "Shape#Circle" }
	Rect<Payload_ extends { width: bigint | number; height: bigint | number }>(payload: Payload_): Payload_ & { $case: "Shape#Rect" }
	Blank: { $case: "Shape#Blank" }
}`,
		)
	})

	// Where a Namespace holds the name, the constructors are its members.
	it("declares them on the Namespace of the same name", async () => {
		expect(await declarationsOf(clientFixture("Calls.es"))).toContain(
			`export declare const Colour: {
	Red: { $case: "Colour#Red" }
	Named<Payload_ extends { name: string }>(payload: Payload_): Payload_ & { $case: "Colour#Named" }
	preferred(): Colour
}`,
		)
	})

	// A Case the Namespace declares a member for is left out, as
	// `bindNamespace` lets the member replace it.
	it("leaves out a Case the Namespace itself declares", async () => {
		expect(await declarationsOf(clientFixture("Collisions.es"))).toContain(
			`export declare const Shape: {
	Blank: bigint
	Circle(p0: bigint | number): bigint
	drawn(): Shape
}`,
		)
	})

	// A unit Choice is the union of its Case names, whether the Module declares
	// it or not, as `Ordering` shows.
	it("prints a unit Choice as the union of its Case names", async () => {
		let text = await declarationsOf(clientFixture("Marshal.es"))

		expect(text).toContain(`export type Direction = "Up" | "Down"`)
		expect(text).toContain(`export type Sign = "Plus" | "Minus"`)
		expect(text).toContain(
			`export declare function ordering(p0: "Less" | "Equal" | "Greater"): "Less" | "Equal" | "Greater"`,
		)
		expect(text).not.toContain(`{ $case: "Direction#Up" }`)
	})

	// The const of the same name is the table of those strings, `readonly`.
	it("declares a unit Choice's Cases as the names they cross as", async () => {
		expect(await declarationsOf(clientFixture("Marshal.es"))).toContain(
			`export declare const Direction: { readonly Up: "Up"; readonly Down: "Down" }`,
		)
	})

	// Wherever a bare Case is reached, and by name without `Input<…>` at a
	// Parameter, since it holds no Integer.
	it("carries the spelling wherever a bare Case is reached", async () => {
		let text = await declarationsOf(clientFixture("Marshal.es"))

		expect(text).toContain(
			"export declare function direction(p0: Direction): Direction",
		)
		expect(text).toContain(
			"export declare function maybeDirection(p0: Direction | undefined): Direction | undefined",
		)
		expect(text).toContain(
			"export declare function directions(p0: Array<Direction>): Array<Direction>",
		)
		expect(text).toContain("export type Marker = { direction: Direction }")
	})

	// The annotated `heading` is the Choice by name, and the unannotated `plus`
	// is the one string `"Plus"`.
	it("declares a constant of a unit Choice by what it can be", async () => {
		let text = await declarationsOf(clientFixture("Marshal.es"))

		expect(text).toContain("export declare const heading: Direction")
		expect(text).toContain(`export declare const plus: "Plus"`)
	})

	// `never` with the interpreter's sentence, in both directions, since
	// TypeScript reads `"Up" | string` as `string`.
	it("refuses a Union a bare Case has no unambiguous spelling in", async () => {
		let text = await declarationsOf(clientFixture("Marshal.es"))

		expect(text).toContain(
			`export declare function directionOrText(p0: never /* 'Direction | String' has no unambiguous JavaScript spelling — a Direction#Up crosses as the string "Up", which a String is too. Crossing one throws. */): never /* 'Direction | String' has no unambiguous JavaScript spelling — a Direction#Up crosses as the string "Up", which a String is too. Crossing one throws. */`,
		)
		expect(text).toContain(
			`export declare function directionOrVertical(p0: never /* 'Direction | Vertical' has no unambiguous JavaScript spelling — a Direction#Up and a Vertical#Up both cross as the string "Up". Crossing one throws. */): never /* 'Direction | Vertical' has no unambiguous JavaScript spelling — a Direction#Up and a Vertical#Up both cross as the string "Up". Crossing one throws. */`,
		)
	})

	// `Direction | Sign` share no Case name, and `Shape` crosses as objects.
	it("spells a Union a bare Case can stand unambiguously in", async () => {
		let text = await declarationsOf(clientFixture("Marshal.es"))

		expect(text).toContain(
			"export declare function directionOrSign(p0: Direction | Sign): Direction | Sign",
		)
		expect(text).toContain(
			"export declare function directionOrShape(p0: Direction | Input<Shape>): Direction | Shape",
		)
	})

	// A Module may export its own `EssenceRational`, so the borrowed one is
	// renamed.
	it("steps a borrowed name around one the Module exports", async () => {
		let text = await declarationsOf(clientFixture("Collisions.es"))

		expect(text).toContain(
			'import type { EssenceRational as $EssenceRational } from "@essence-lang/client"',
		)
		expect(text).toContain("export declare const EssenceRational: bigint")
		expect(text).toContain("export declare const ratio: $EssenceRational")
	})

	// Beside a colliding pair, an `Optional` leaves the position `never`. Around
	// it, the position is `never | undefined`, which is `undefined`, as the
	// interpreter admits absence there and nothing else.
	it("refuses a collision an Optional stands in the way of", async () => {
		let text = await declarationsOf(clientFixture("Refused.es"))

		expect(text).toContain(
			`export declare function noted(p0: never /* 'Optional<String> | Direction' has no unambiguous JavaScript spelling — a Direction#Up crosses as the string "Up", which a String is too. Crossing one throws. */): never /* 'Optional<String> | Direction' has no unambiguous JavaScript spelling — a Direction#Up crosses as the string "Up", which a String is too. Crossing one throws. */`,
		)
		expect(text).toContain(
			`export declare function wrapped(p0: never /* 'Direction | String' has no unambiguous JavaScript spelling — a Direction#Up crosses as the string "Up", which a String is too. Crossing one throws. */ | undefined): never /* 'Direction | String' has no unambiguous JavaScript spelling — a Direction#Up crosses as the string "Up", which a String is too. Crossing one throws. */ | undefined`,
		)
	})

	// A nested Optional refuses every call going in. Coming out it reads
	// `bigint | undefined`, once.
	it("refuses an Optional inside an Optional in a Parameter position", async () => {
		let text = await declarationsOf(clientFixture("Refused.es"))

		expect(text).toContain(
			"export declare function nested(p0: never /* an Optional inside an Optional has no JavaScript spelling */): bigint | undefined",
		)
		expect(text).toContain("export declare const deep: bigint | undefined")
		expect(text).not.toContain("undefined | undefined")
	})

	it("declares a bounded Function without its Protocol's path", async () => {
		let text = await declarationsOf(clientFixture("Bounded.es"))

		expect(text).toContain("export type Sized = unknown")
		expect(text).toContain("export declare function measure(p0: never")
		expect(text).not.toContain(
			canonicalPath(path.dirname(clientFixture("Bounded.es"))),
		)
	})

	// A Namespace that writes the Method declares its own under the same name.
	it("declares the provided Methods a Namespace's Protocol gives it", async () => {
		let text = await declarationsOf(clientFixture("Provided.es"))

		expect(text).toContain(`export declare const Rectangles: {
	area(p0: Input<Rectangle>): bigint
	isEmpty(p0: Input<Rectangle>): boolean
	scaled(p0: Input<Rectangle>, by: bigint | number): bigint
}`)
		expect(text).toContain(`export declare const Squares: {
	area(p0: Input<Square>): bigint
	isEmpty(p0: Input<Square>): boolean
	scaled(p0: Input<Square>, by: bigint | number): bigint
}`)
	})

	it("declares a Case over a provided Method of its name", async () => {
		let text = await declarationsOf(clientFixture("Provided.es"))

		expect(text).toContain(`export declare const Colour: {
	readonly Red: "Red"
	readonly Blue: "Blue"
	label(p0: Colour): string
	shout(p0: Colour): string
}`)
	})

	it("declares a generic Choice's Case over a provided Method of its name", async () => {
		let text = await declarationsOf(clientFixture("Provided.es"))
		let start = text.indexOf("export declare const Tag: {")
		let tag = text.slice(start, text.indexOf("\n}\n", start))

		expect(tag).toContain('\tRed: { $case: "Tag#Red" }\n')
		expect(tag).toContain("\tshout(p0: ")
		expect(tag).not.toContain("\tRed(")
	})

	it("declares the provided Methods of a Namespace a cycle forwards", async () => {
		expect(
			await declarationsOf(
				clientFixture(path.join("cycle", "Walking.es")),
			),
		).toContain(`export declare const Walkers: {
	step(p0: Input<Walker>): bigint
	twice(p0: Input<Walker>): bigint
}`)
	})

	it("declares a Protocol as a Type nothing holds", async () => {
		expect(
			await declarationsOf(clientFixture("Declarations.es")),
		).toContain("export type Measurable = unknown")
	})

	// `never`, since `exports` binds an Overload set to a refusal.
	it("refuses an overloaded Method a callable Type", async () => {
		let text = await declarationsOf(clientFixture("Calls.es"))

		expect(text).toContain(
			"from: never /* overloaded — calling it throws */",
		)
		expect(text).toContain(
			"grown: never /* overloaded — calling it throws */",
		)
	})

	// `ok?` is exported under a string literal.
	it("exports a name JavaScript can not spell under a string", async () => {
		let text = await declarationsOf(clientFixture("Escaped.es"))

		expect(text).toContain("export declare const $$integer: bigint")
		expect(text).toContain(
			'declare const $export_ok_3f_: (p0: boolean) => boolean\nexport { $export_ok_3f_ as "ok?" }',
		)
	})
})

describe("The bundle view", () => {
	it("describes what the emitted Module binds", async () => {
		expect(
			await declarationsOf(
				fixturePath("modules", "math", "Math.es"),
				"bundle",
			),
		).toBe(
			`// Generated from Math.es by @essence-lang/client. Do not edit.
//
// The Module's own exports: Essence values, under the names the
// Rewriter emitted them as. Build one with \`@essence-lang/runtime\`,
// which the build resolves to the same copy these were built by.

// An Essence value as JavaScript holds it — deliberately opaque. It
// carries its Type on a Symbol the runtime mints, and reading one apart
// or building one is \`@essence-lang/runtime\`'s to do.
type EssenceValue = object

export declare const PI: EssenceValue
export declare function square(p0: EssenceValue): EssenceValue
`,
		)
	})

	// Only the names the bundle binds: each Overload, and no Type, Choice or
	// Protocol.
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

	// The Rewriter mangles a static `prototype` or `constructor`.
	it("declares the two member names a class refuses as the Rewriter emits them", async () => {
		let text = await declarationsOf(clientFixture("Calls.es"), "bundle")

		expect(text).toContain("$user_constructor: EssenceValue")
		expect(text).toContain(
			"$user_prototype(p0: EssenceValue): EssenceValue",
		)
	})

	it("declares a name JavaScript can not spell as the Rewriter emits it", async () => {
		expect(await declarationsOf(clientFixture("Escaped.es"), "bundle"))
			.toContain(`// 'ok?' as the Rewriter emits it.
export declare function $user_ok_3f_(p0: EssenceValue): EssenceValue`)
	})

	// Bare names belong to the marshalled door. In this view every value is
	// opaque, and nothing is refused.
	it("leaves a unit Choice opaque, spelling and refusal alike", async () => {
		let text = await declarationsOf(clientFixture("Marshal.es"), "bundle")

		expect(text).toContain(
			"export declare function direction(p0: EssenceValue): EssenceValue",
		)
		expect(text).toContain(
			"export declare function directionOrText(p0: EssenceValue): EssenceValue",
		)
		expect(text).not.toContain(`"Up"`)
		expect(text).not.toContain("never")
	})
})

describe("Asynchronous work in the declarations", () => {
	// Work is a `Promise` only as a call's answer, a callback's included, and
	// `never` with the boundary's sentence elsewhere.
	it("declares work as a promise where a call answers one", async () => {
		expect(await declarationsOf(clientFixture("Async.es"))).toBe(
			`// Generated from Async.es by @essence-lang/client. Do not edit.
//
// The Module as JavaScript — marshalled at every boundary.

import type { Input } from "@essence-lang/client"

export type Job = {
	work: never /* a Future<Integer> is work rather than a value, and work crosses only as a call's answer */
}

export declare function attempted(p0: string, using: (p0: string) => Promise<{ $case: "Result#Value"; item: string } | { $case: "Result#Failure"; reason: string }>): Promise<{ $case: "Result#Value"; item: string } | { $case: "Result#Failure"; reason: string }>
export declare function counted(p0: Map<string, bigint | number>): Promise<Map<string, bigint>>
export declare function doubled(p0: bigint | number): Promise<bigint>
export declare function greeted(p0: string, after: bigint | number): Promise<string>
export declare function loaded(p0: string, using: (p0: string) => Promise<string>): Promise<string>
export declare function nested(p0: bigint | number): Promise<never /* a Future<Integer> is work rather than a value, and work crosses only as a call's answer */>
export declare function queued(p0: Input<Job>): Job
export declare function ran(p0: never /* a Future<Integer> is work rather than a value, and work crosses only as a call's answer */): Promise<bigint>
export declare function running(p0: bigint | number): Promise<bigint>
export declare function shelved(p0: string, using: (p0: string) => Promise<string>): bigint
export declare function together(p0: Array<never /* a Future<Integer> is work rather than a value, and work crosses only as a call's answer */>): Promise<Array<bigint>>
export declare const work: never /* a Future<Integer> is work rather than a value, and work crosses only as a call's answer */
`,
		)
	})

	// The bundle view leaves a Future opaque, like every value.
	it("leaves work opaque in the bundle view", async () => {
		let text = await declarationsOf(clientFixture("Async.es"), "bundle")

		expect(text).toContain(
			"export declare function doubled(p0: EssenceValue): EssenceValue",
		)
		expect(text).not.toContain("Promise")
		expect(text).not.toContain("never")
	})
})

describe("A consumer of the generated declarations", () => {
	// A call is awaited, and a callback that answers work is an `async`
	// Function. Both must typecheck.
	it("awaits a call and writes a callback that answers work", async () => {
		let declarations = await declarationsFor(clientFixture("Async.es"))
		let run = await typecheck({
			"Async.d.es.ts": declarations,
			"consumer.ts": `import { attempted, counted, doubled, loaded, running } from "./Async.es"

export let doubling = doubled(21n)
export let answered: Promise<bigint> = doubling
export let inFlight: Promise<bigint> = running(21n)
export let entries: Promise<Map<string, bigint>> = counted(new Map([["a", 1]]))

export async function read(): Promise<string> {
	return await loaded("key", async (key) => key.toUpperCase())
}

export async function tried(): Promise<string> {
	let answer = await attempted("key", async (key) => ({
		$case: "Result#Failure" as const,
		reason: key,
	}))

	return answer.$case === "Result#Value" ? answer.item : answer.reason
}
`,
		})

		expect(run.output).toBe("")
		expect(run.code).toBe(0)
	})

	// A refused position fails to typecheck at the line that writes it.
	it("is refused work handed in", async () => {
		let declarations = await declarationsFor(clientFixture("Async.es"))
		let run = await typecheck({
			"Async.d.es.ts": declarations,
			"consumer.ts": `import { ran } from "./Async.es"

export let wrong = ran(Promise.resolve(1n))
`,
		})

		expect(run.code).not.toBe(0)
		expect(run.output).toContain("consumer.ts")
	})

	it("typechecks against them", async () => {
		let declarations = await declarationsFor(clientFixture("Marshal.es"))
		let run = await typecheck({
			"Marshal.d.es.ts": declarations,
			"consumer.ts": `import { areaOf, box, boxes, greeting, maybe, present, Shape, shape, third } from "./Marshal.es"
import type { Box, Label } from "./Marshal.es"

export let area: bigint = areaOf({ $case: "Shape#Circle", radius: 3n })
export let built: bigint = areaOf(Shape.Circle({ radius: 3n }))
export let blank: Shape = Shape.Blank
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

	// A Dictionary Parameter takes the consumer's `Map`, its key widened by
	// `Input`. See "Input types" in DEVELOPMENT.md.
	it("passes a Map to a Dictionary Parameter", async () => {
		let declarations = await declarationsFor(clientFixture("Marshal.es"))
		let run = await typecheck({
			"Marshal.d.es.ts": declarations,
			"consumer.ts": `import { ages, counts, headings, ledger, sizes } from "./Marshal.es"
import type { Ledger } from "./Marshal.es"
import type { Input } from "${BORROWED_MODULE}"

export let kept: Map<string, bigint> = ages(sizes)
export let built: Map<string, bigint> = ages(new Map([["alex", 39]]))
export let numbered: Map<bigint, string> = counts(new Map([[1, "one"]]))
export let named: Map<"Up" | "Down", bigint> = headings(new Map([["Up", 1n]]))
export let held: Ledger = ledger({ entries: new Map([["a", 1]]) })
export let loose: Input<Ledger> = { entries: new Map([["a", 1]]) }
export let one: bigint | undefined = kept.get("alex")
`,
		})

		expect(run.output).toBe("")
		expect(run.code).toBe(0)
	})

	it("is refused a Map whose values are of the wrong Type", async () => {
		let declarations = await declarationsFor(clientFixture("Marshal.es"))
		let run = await typecheck({
			"Marshal.d.es.ts": declarations,
			"consumer.ts": `import { ages } from "./Marshal.es"

export let wrong = ages(new Map([["alex", "39"]]))
`,
		})

		expect(run.code).not.toBe(0)
		expect(run.output).toContain("consumer.ts")
	})

	// A wrong Argument must fail, or a passing consumer proves nothing.
	it("is refused an Argument of the wrong Type", async () => {
		let declarations = await declarationsFor(clientFixture("Marshal.es"))
		let run = await typecheck({
			"Marshal.d.es.ts": declarations,
			"consumer.ts": `import { box } from "./Marshal.es"

export let wrong = box({ width: "3", height: 4n })
`,
		})

		expect(run.code).not.toBe(0)
		expect(run.output).toContain("consumer.ts")
		expect(run.output).toContain(
			"Type 'string' is not assignable to type 'number | bigint'",
		)
	})

	// A safe `number` goes in for an Integer, and a `bigint` comes out, so an
	// answer annotated as a number is refused.
	it("takes a safe number for an Integer going in, and answers a bigint", async () => {
		let declarations = await declarationsFor(clientFixture("Marshal.es"))
		let accepted = await typecheck({
			"Marshal.d.es.ts": declarations,
			"consumer.ts": `import { box, type Box } from "./Marshal.es"
import type { Input } from "${BORROWED_MODULE}"

export let built: Box = box({ width: 3, height: 4n })
export let plain: Input<Box> = { width: 3, height: 4 }
export let width: bigint = built.width
`,
		})

		expect(accepted.output).toBe("")
		expect(accepted.code).toBe(0)

		let refused = await typecheck({
			"Marshal.d.es.ts": declarations,
			"consumer.ts": `import { box } from "./Marshal.es"

export let width: number = box({ width: 3, height: 4 }).width
`,
		})

		expect(refused.code).not.toBe(0)
		expect(refused.output).toContain(
			"Type 'bigint' is not assignable to type 'number'",
		)
	})

	// `Shape` holds for a payload of bigints and `Input<Shape>` for numbers. A
	// wrong payload fails at the constructor.
	it("types a Case constructor by the payload it was handed", async () => {
		let declarations = await declarationsFor(clientFixture("Marshal.es"))
		let accepted = await typecheck({
			"Marshal.d.es.ts": declarations,
			"consumer.ts": `import { Shape, areaOf } from "./Marshal.es"
import type { Input } from "${BORROWED_MODULE}"

export let exact: Shape = Shape.Circle({ radius: 3n })
export let loose: Input<Shape> = Shape.Circle({ radius: 3 })
export let blank: Shape = Shape.Blank
export let area: bigint = areaOf(Shape.Circle({ radius: 3 }))
`,
		})

		expect(accepted.output).toBe("")
		expect(accepted.code).toBe(0)

		let refused = await typecheck({
			"Marshal.d.es.ts": declarations,
			"consumer.ts": `import { Shape } from "./Marshal.es"

export let wrong = Shape.Circle({ radius: "3" })
`,
		})

		expect(refused.code).not.toBe(0)
		expect(refused.output).toContain("consumer.ts")
	})

	// `"Up"` and `Direction.Up` are one value, and `"Left"` is refused.
	it("takes a bare Case as its own name or off the Choice", async () => {
		let declarations = await declarationsFor(clientFixture("Marshal.es"))
		let run = await typecheck({
			"Marshal.d.es.ts": declarations,
			"consumer.ts": `import { Direction, direction, directions, marker, maybeDirection, ordering } from "./Marshal.es"
import type { Marker } from "./Marshal.es"

export let up: Direction = "Up"
export let down: Direction = Direction.Down
export let sameThing: "Up" = Direction.Up
export let round: Direction = direction("Up")
export let absent: Direction | undefined = maybeDirection(undefined)
export let all: Array<Direction> = directions(["Up", Direction.Down])
export let held: Marker = marker({ direction: "Up" })
export let compared: "Less" | "Equal" | "Greater" = ordering("Less")

// @ts-expect-error — 'Left' is not a Case of Direction
export let wrong: Direction = "Left"
`,
		})

		expect(run.output).toBe("")
		expect(run.code).toBe(0)
	})

	// A refused Union fails at the call rather than at the crossing.
	it("is refused a Union a bare Case has no spelling in", async () => {
		let declarations = await declarationsFor(clientFixture("Marshal.es"))
		let run = await typecheck({
			"Marshal.d.es.ts": declarations,
			"consumer.ts": `import { directionOrText } from "./Marshal.es"

export let ambiguous = directionOrText("Up")
`,
		})

		expect(run.code).not.toBe(0)
		expect(run.output).toContain("consumer.ts")
		expect(run.output).toContain(
			"Argument of type '\"Up\"' is not assignable to parameter of type 'never'",
		)
	})

	it("reaches an export JavaScript can not spell", async () => {
		let declarations = await declarationsFor(clientFixture("Escaped.es"))
		let run = await typecheck({
			"Escaped.d.es.ts": declarations,
			"consumer.ts": `import { "ok?" as ok, $$integer } from "./Escaped.es"

export let answer: boolean = ok(true)
export let twelve: bigint = $$integer
`,
		})

		expect(run.output).toBe("")
		expect(run.code).toBe(0)
	})

	// The bundle view typechecks and imports nothing.
	it("typechecks the bundle view without importing anything", async () => {
		let declarations = await declarationsOf(
			fixturePath("modules", "math", "Math.es"),
			"bundle",
		)

		expect(declarations).not.toContain("import")

		let run = await typecheck({
			"Math.d.es.ts": declarations,
			// The names are there, and only an Essence value fits.
			"consumer.ts": `import { PI, square } from "./Math.es"

export let squared = square(PI)
`,
		})

		expect(run.output).toBe("")
		expect(run.code).toBe(0)
	})
})

// Defaults at the boundary. TypeScript allows `?` only on a trailing run, so
// the positional and labelled forms differ. See "Parameters" in DEVELOPMENT.md.
describe("A Parameter a call may leave out", () => {
	it("declares it", async () => {
		expect(await declarationsOf(clientFixture("Defaults.es"))).toBe(
			`// Generated from Defaults.es by @essence-lang/client. Do not edit.
//
// The Module as JavaScript — marshalled at every boundary.

export type Fetch =
	| { $case: "Fetch#Get"; url: string; retries: bigint; tags: Array<string>; headers: Array<string>; limits: { calls: bigint }; mode: Method }
	| { $case: "Fetch#Ping" }

export type Method = "Verbose" | "Quiet"

export declare const Fetch: {
	Get<Payload_ extends { url: string; retries?: bigint | number; tags?: Array<string>; headers?: Array<string>; limits?: { calls: bigint | number }; mode?: Method }>(payload: Payload_): Payload_ & { $case: "Fetch#Get" }
	Ping: { $case: "Fetch#Ping" }
}

export declare const Method: {
	readonly Verbose: "Verbose"
	readonly Quiet: "Quiet"
}

export declare function blank(): Fetch
export declare function connect(p0: string, using: { host: string; retries?: bigint | number; secure: boolean }): string

export declare function cut(from: bigint | number | undefined, to: bigint | number): bigint
export declare function cut(labelled: { from?: bigint | number; to: bigint | number }): bigint

export declare function fetched(p0: { $case: "Fetch#Get"; url: string; retries?: bigint | number; tags?: Array<string>; headers?: Array<string>; limits?: { calls: bigint | number }; mode?: Method } | { $case: "Fetch#Ping" }): string

export declare function greeting(p0?: string, and?: string): string
export declare function greeting(labelled: { "with"?: string; and?: string }): string

export declare function scaled(p0: bigint | number, by?: bigint | number): bigint
`,
		)
	})

	// The members a default fills in carry `?`, and `using` itself does not. The
	// shape is spelled out rather than named `Options`, as its two directions
	// differ.
	it("marks the members a default fills in", async () => {
		let declarations = await declarationsOf(clientFixture("Defaults.es"))

		expect(declarations).toContain(
			"using: { host: string; retries?: bigint | number; secure: boolean }",
		)
		expect(declarations).not.toContain("using?:")
	})
})
