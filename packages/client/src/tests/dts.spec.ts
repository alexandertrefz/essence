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

// NOTE: What a plugin hands `generateDeclarations`: the Descriptor the wrapper
// marshals by, and the Types the Module named. Described against the entry, the
// way the bundle beside it is emitted — a Case tag is entry-relative, and a
// declaration file that disagreed with its own bundle would name Cases nothing
// carries.
async function describedModule(
	entryPath: string,
): Promise<{ descriptor: ModuleDescriptor; types: Array<DeclaredType> }> {
	let entry = canonicalPath(entryPath)
	let compiled = await compileToMemory(entry)

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

// NOTE: The declarations as a consumer reads them — the `javascript` view, with
// `EssenceRational` imported by path. A temporary directory has no
// `node_modules` above it, so the package name would not resolve there.
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

	// NOTE: `Rectangle` is a Type Alias AND the Namespace of that name, so it is
	// declared twice — as a Type and as a value. TypeScript keeps the two in
	// separate declaration spaces for exactly this.
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

	// NOTE: By object identity, which the Enricher makes true: an Alias resolves
	// to ONE Type and every mention of it is that same object. Spelling the shape
	// out instead would read nothing like the source it came from, and would say
	// nothing about two Parameters being the same Type.
	//
	// NOTE: Going IN, a Type holding an Integer is wider than its declaration —
	// a safe number is taken there — so the name is kept and wrapped in the
	// package's `Input<…>`, which widens exactly the leaves the interpreter does.
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

	// NOTE: A Type Parameter is a shape that has not been decided yet, and a
	// value going in has to be BUILT against a shape — so there is nothing to
	// build one against and the boundary says so, in the words it would throw
	// them in. Declaring the Parameter `ItemType` would typecheck
	// `firstOf([1n])`, which throws; `never` typechecks `firstOf([])`, which is
	// exactly the call that works.
	//
	// NOTE: And no `<ItemType>` on the Function either. A Descriptor carries the
	// shapes a value crosses AS, and a Type Parameter never is one — a
	// declaration that bound the name would promise a caller a Type to apply on
	// a call that can not be made.
	it("refuses a Type Parameter in a Parameter position", async () => {
		let refusal =
			"ItemType is a Type Parameter — there is no shape to build a value against until it is applied."

		expect(
			await declarationsOf(clientFixture("Declarations.es")),
		).toContain(
			`export declare function firstOf(p0: Array<never /* ${refusal} */>): unknown /* ${refusal} */ | undefined`,
		)
	})

	// NOTE: A callback Parameter is the Function the MODULE will call, so it is
	// declared as the call the host has to be ready for: its Parameters are the
	// Module's own values coming out — a `bigint`, always — and its answer is a
	// value going in, which a safe number satisfies. The direction turns around
	// at the Function and nowhere else.
	it("declares a callback Parameter as the call the Module will make", async () => {
		let text = await declarationsOf(clientFixture("Calls.es"))

		expect(text).toContain(
			"export declare function applied(p0: bigint | number, p1: (p0: bigint) => bigint | number): bigint",
		)
		expect(text).toContain(
			"export declare function measured(box: Input<Box>, by: (p0: Box) => bigint | number): bigint",
		)
	})

	// NOTE: A Type Alias holding a callback is named in BOTH directions, because
	// what it holds reads the same either way — the Alias is declared once, and
	// naming it at a Parameter is the claim that it does.
	it("names a Type whose members cross the same way in both directions", async () => {
		let text = await declarationsOf(clientFixture("Calls.es"))

		expect(text).toContain(
			"export type Handler = { callback: (p0: bigint | number) => bigint }",
		)
		expect(text).toContain(
			"export declare function invoke(p0: Handler): bigint",
		)
	})

	// NOTE: And spelled out where it does not. `Nest` holds an Optional inside
	// an Optional: coming out that is `bigint | undefined`, and going in it is
	// nothing at all — so a Parameter naming the Alias would typecheck the call
	// that always throws, and the `never` goes on the member that is the
	// mistake.
	it("spells out a named Type whose member can not cross in", async () => {
		let text = await declarationsOf(clientFixture("Refused.es"))

		expect(text).toContain(
			"export type Nest = { level: bigint | undefined }",
		)
		expect(text).toContain(
			"export declare function nesting(p0: { level: never /* an Optional inside an Optional has no JavaScript spelling */ }): Nest",
		)
	})

	// NOTE: A Function crossing OUT is wrapped by the Marshaller, so the
	// callable signature printed here is the one a caller really calls.
	it("declares a Function that comes back as callable", async () => {
		let text = await declarationsOf(clientFixture("Calls.es"))

		expect(text).toContain(
			"export declare function makeAdder(p0: bigint | number): (p0: bigint | number) => bigint",
		)
		expect(text).toContain(
			"export declare const handler: { callback: (p0: bigint | number) => bigint }",
		)
	})

	// NOTE: A Choice is declared twice under one name, and TypeScript keeps the
	// two apart: the Type is what a value of it IS, and the const is how a host
	// spells one. A Case with a payload is a call and one without is the value —
	// there is nothing to pass to `Blank`.
	//
	// NOTE: A constructor is a spelling that marshals nothing — it writes the tag
	// onto the payload it was handed — so it is declared as exactly that: any
	// payload the boundary would take, answered with the tag on it and its own
	// Types kept. `Shape.Circle({ radius: 3n })` is therefore a `Shape`, and
	// `Shape.Circle({ radius: 3 })` an `Input<Shape>`.
	it("declares a Choice's Cases as the constructors a host spells them with", async () => {
		expect(await declarationsOf(clientFixture("Marshal.es"))).toContain(
			`export declare const Shape: {
	Circle<Payload_ extends { radius: bigint | number }>(payload: Payload_): Payload_ & { $case: "Shape#Circle" }
	Rect<Payload_ extends { width: bigint | number; height: bigint | number }>(payload: Payload_): Payload_ & { $case: "Shape#Rect" }
	Blank: { $case: "Shape#Blank" }
}`,
		)
	})

	// NOTE: And where a Namespace already holds the name, they are members of it
	// — one name binds one thing, and `namespace Colour for Colour` is how a
	// Choice is given its Methods.
	it("declares them on the Namespace of the same name", async () => {
		expect(await declarationsOf(clientFixture("Calls.es"))).toContain(
			`export declare const Colour: {
	Red: { $case: "Colour#Red" }
	Named<Payload_ extends { name: string }>(payload: Payload_): Payload_ & { $case: "Colour#Named" }
	preferred(): Colour
}`,
		)
	})

	// NOTE: And where the Namespace declares a member of a Case's own name, the
	// Case is left out — `bindNamespace` writes the constructors first exactly so
	// that what the Module declares overwrites them, so declaring both would name
	// one member twice and promise a constructor nothing binds.
	it("leaves out a Case the Namespace itself declares", async () => {
		expect(await declarationsOf(clientFixture("Collisions.es"))).toContain(
			`export declare const Shape: {
	Blank: bigint
	Circle(p0: bigint | number): bigint
	drawn(): Shape
}`,
		)
	})

	// NOTE: A Choice all of whose Cases are payload-less crosses as the bare Case
	// name, so its Type is the union of those names as string literals — which is
	// what a TypeScript enumeration looks like, and the whole reason the spelling
	// exists. `Ordering` says the same thing without being declared by the
	// Module: nothing here is about a Choice being local, only about every Case
	// being empty.
	it("prints a unit Choice as the union of its Case names", async () => {
		let text = await declarationsOf(clientFixture("Marshal.es"))

		expect(text).toContain(`export type Direction = "Up" | "Down"`)
		expect(text).toContain(`export type Sign = "Plus" | "Minus"`)
		expect(text).toContain(
			`export declare function ordering(p0: "Less" | "Equal" | "Greater"): "Less" | "Equal" | "Greater"`,
		)
		expect(text).not.toContain(`{ $case: "Direction#Up" }`)
	})

	// NOTE: And the const under the same name is the table of those strings, so
	// that `Direction.Up` and `"Up"` are one value written two ways. `readonly`
	// because the table is frozen and a bare string is the one member here a
	// reader might take for somewhere to keep one.
	it("declares a unit Choice's Cases as the names they cross as", async () => {
		expect(await declarationsOf(clientFixture("Marshal.es"))).toContain(
			`export declare const Direction: { readonly Up: "Up"; readonly Down: "Down" }`,
		)
	})

	// NOTE: At every position a Descriptor is WALKED to rather than met at — an
	// `Optional`'s item, a List's item, a Record's member — because the fact is
	// on the Case and the walk is the same walk as ever.
	//
	// NOTE: And by NAME at a Parameter, unwrapped — a unit Choice carries no
	// Integer, so it is not one of the Types whose in-form is wider than its
	// declaration, and `Input<Direction>` would be the same Type spelled twice.
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

	// NOTE: And where a constant is all that names it. `heading` was annotated,
	// so it is the Choice by name; `plus` was not, so its Type is the one Case
	// alone — which prints as that Case's own string and nothing else, the
	// narrowest true thing to say about a value that can only ever be `"Plus"`.
	it("declares a constant of a unit Choice by what it can be", async () => {
		let text = await declarationsOf(clientFixture("Marshal.es"))

		expect(text).toContain("export declare const heading: Direction")
		expect(text).toContain(`export declare const plus: "Plus"`)
	})

	// NOTE: `never`, because printing the arms honestly is what can not be done:
	// TypeScript reads `"Up" | string` as `string`, so a declaration that named
	// both would promise a position taking any string at all while the
	// interpreter refuses every value there. The refusal is the interpreter's own
	// sentence, and it lands on both directions — a collision is not a thing a
	// value can be built past on the way in and read past on the way out.
	it("refuses a Union a bare Case has no unambiguous spelling in", async () => {
		let text = await declarationsOf(clientFixture("Marshal.es"))

		expect(text).toContain(
			`export declare function directionOrText(p0: never /* 'Direction | String' has no unambiguous JavaScript spelling — a Direction#Up crosses as the string "Up", which a String is too. Crossing one throws. */): never /* 'Direction | String' has no unambiguous JavaScript spelling — a Direction#Up crosses as the string "Up", which a String is too. Crossing one throws. */`,
		)
		expect(text).toContain(
			`export declare function directionOrVertical(p0: never /* 'Direction | Vertical' has no unambiguous JavaScript spelling — a Direction#Up and a Vertical#Up both cross as the string "Up". Crossing one throws. */): never /* 'Direction | Vertical' has no unambiguous JavaScript spelling — a Direction#Up and a Vertical#Up both cross as the string "Up". Crossing one throws. */`,
		)
	})

	// NOTE: And spells the ones that do have one. The collision is per CASE NAME
	// — `Direction | Sign` share none — and per bare Case: a Choice with a
	// payload crosses as a `$case` object, which no string is, so `Shape` stands
	// beside a bare name perfectly well.
	it("spells a Union a bare Case can stand unambiguously in", async () => {
		let text = await declarationsOf(clientFixture("Marshal.es"))

		expect(text).toContain(
			"export declare function directionOrSign(p0: Direction | Sign): Direction | Sign",
		)
		expect(text).toContain(
			"export declare function directionOrShape(p0: Direction | Input<Shape>): Direction | Shape",
		)
	})

	// NOTE: `EssenceRational` is this package's name and a name a Module may
	// export. Both spelled plainly, the import and the declaration are one name
	// declared twice — which TypeScript refuses, taking the whole file with it —
	// so the borrowed one steps aside.
	it("steps a borrowed name around one the Module exports", async () => {
		let text = await declarationsOf(clientFixture("Collisions.es"))

		expect(text).toContain(
			'import type { EssenceRational as $EssenceRational } from "@essence-lang/client"',
		)
		expect(text).toContain("export declare const EssenceRational: bigint")
		expect(text).toContain("export declare const ratio: $EssenceRational")
	})

	// NOTE: An `Optional` standing between a bare Case and a String hides
	// nothing, in either of the two places it can stand. Beside the pair, the
	// collision is the Union's own and the whole position is `never`. Around
	// the pair, `undefined` is still a spelling the position has — absence is
	// nobody else's — so what is printed is `never | undefined`, which
	// TypeScript reads as `undefined`: the one value that crosses, and the
	// interpreter's own answer for that position (it lets the absence through
	// and refuses every `"Up"`). Both halves are pinned here so that a change
	// to one is a change the other has to be read against.
	it("refuses a collision an Optional stands in the way of", async () => {
		let text = await declarationsOf(clientFixture("Refused.es"))

		expect(text).toContain(
			`export declare function noted(p0: never /* 'Optional<String> | Direction' has no unambiguous JavaScript spelling — a Direction#Up crosses as the string "Up", which a String is too. Crossing one throws. */): never /* 'Optional<String> | Direction' has no unambiguous JavaScript spelling — a Direction#Up crosses as the string "Up", which a String is too. Crossing one throws. */`,
		)
		expect(text).toContain(
			`export declare function wrapped(p0: never /* 'Direction | String' has no unambiguous JavaScript spelling — a Direction#Up crosses as the string "Up", which a String is too. Crossing one throws. */ | undefined): never /* 'Direction | String' has no unambiguous JavaScript spelling — a Direction#Up crosses as the string "Up", which a String is too. Crossing one throws. */ | undefined`,
		)
	})

	// NOTE: `fromJS` refuses EVERY value for a nested Optional — both levels
	// would be `undefined` — so the Parameter has to refuse every call, exactly
	// as the callback and Type Parameter positions already do. Coming out, only
	// the collapse is deduplicated: `bigint | undefined`, not the inner Union
	// printed as one arm with its `undefined` twice.
	it("refuses an Optional inside an Optional in a Parameter position", async () => {
		let text = await declarationsOf(clientFixture("Refused.es"))

		expect(text).toContain(
			"export declare function nested(p0: never /* an Optional inside an Optional has no JavaScript spelling */): bigint | undefined",
		)
		expect(text).toContain("export declare const deep: bigint | undefined")
		expect(text).not.toContain("undefined | undefined")
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

// NOTE: An Essence value as JavaScript holds it — deliberately opaque. It
// carries its Type on a Symbol the runtime mints, and reading one apart
// or building one is \`@essence-lang/runtime\`'s to do.
type EssenceValue = object

export declare const PI: EssenceValue
export declare function square(p0: EssenceValue): EssenceValue
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

	// NOTE: A class refuses a static member named `prototype` or `constructor`,
	// so the Rewriter mangles the two — a declaration spelling the written name
	// would promise a member the bundle does not have.
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

	// NOTE: A unit Choice's bare-name spelling is the MARSHALLED door's, and this
	// view is the other one: behind the wrapper a `Direction` is the Essence Case
	// object itself, which no string is. So nothing here changes — not the
	// spelling, and not the refusal either, since a Union with no unambiguous
	// JavaScript reading has a perfectly ordinary Essence value in it.
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

describe("A consumer of the generated declarations", () => {
	it("typechecks against them", async () => {
		let declarations = await declarationsFor(clientFixture("Marshal.es"))
		let run = typecheck({
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

	// NOTE: The other half of the claim. Declarations that admit everything
	// typecheck every consumer, so a passing consumer says nothing on its own.
	it("is refused an Argument of the wrong Type", async () => {
		let declarations = await declarationsFor(clientFixture("Marshal.es"))
		let run = typecheck({
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

	// NOTE: The interpreter takes a safe `number` for an Integer going IN and
	// hands it to the runtime's own canonicaliser, so a declaration that made a
	// caller write `BigInt(3)` there would be refusing a call the Module answers.
	// What comes OUT is a `bigint` at every size, and the declaration says that
	// too — the same call is refused where its answer is annotated as a number.
	it("takes a safe number for an Integer going in, and answers a bigint", async () => {
		let declarations = await declarationsFor(clientFixture("Marshal.es"))
		let accepted = typecheck({
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

		let refused = typecheck({
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

	// NOTE: The generic constructor keeps the caller's own Types, and the two
	// annotations a host would reach for both hold: `Shape` where the payload was
	// bigints, `Input<Shape>` where it was numbers — and a payload of the wrong
	// shape is refused at the constructor rather than at the crossing.
	it("types a Case constructor by the payload it was handed", async () => {
		let declarations = await declarationsFor(clientFixture("Marshal.es"))
		let accepted = typecheck({
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

		let refused = typecheck({
			"Marshal.d.es.ts": declarations,
			"consumer.ts": `import { Shape } from "./Marshal.es"

export let wrong = Shape.Circle({ radius: "3" })
`,
		})

		expect(refused.code).not.toBe(0)
		expect(refused.output).toContain("consumer.ts")
	})

	// NOTE: The two spellings a host reaches for, both of which have to hold: the
	// bare string, which is what the boundary really carries, and the Case off
	// the Choice, which is what a reader coming from the object form writes. They
	// are one value — `Direction.Up` IS `"Up"` — so the declaration has to say so
	// rather than only admit both.
	//
	// NOTE: And a name the Choice does not have is refused, which is the half
	// that makes the rest worth having. A declaration printing `string` there
	// would typecheck `"Left"` and throw at the crossing.
	it("takes a bare Case as its own name or off the Choice", async () => {
		let declarations = await declarationsFor(clientFixture("Marshal.es"))
		let run = typecheck({
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

	// NOTE: And the refused positions refuse, at the call rather than at the
	// crossing — which is the whole reason they are declared `never` instead of
	// being spelled out as the arms they hold.
	it("is refused a Union a bare Case has no spelling in", async () => {
		let declarations = await declarationsFor(clientFixture("Marshal.es"))
		let run = typecheck({
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
			// NOTE: The value goes in as one of the Module's own — opaque, and
			// built by the runtime the build resolved for both of them. What
			// this view promises is that the names are there and that nothing
			// but an Essence value fits, which is what a consumer can check
			// without ever meeting a Type.
			"consumer.ts": `import { PI, square } from "./Math.es"

export let squared = square(PI)
`,
		})

		expect(run.output).toBe("")
		expect(run.code).toBe(0)
	})
})

// NOTE: `= expression` defaults, at the JavaScript boundary. `?` is the first
// thing this generator ever writes that TypeScript restricts the ORDER of, and
// the restriction is stricter than Essence's own rule — so the two forms of a
// call say different things about the same Parameter.
describe("A Parameter a call may leave out", () => {
	it("declares it", async () => {
		expect(await declarationsOf(clientFixture("Defaults.es"))).toBe(
			`// Generated from Defaults.es by @essence-lang/client. Do not edit.
//
// The Module as JavaScript — marshalled at every boundary.

export declare function cut(from: bigint | number | undefined, to: bigint | number): bigint
export declare function cut(labelled: { from?: bigint | number; to: bigint | number }): bigint

export declare function greeting(p0?: string, and?: string): string
export declare function greeting(labelled: { "with"?: string; and?: string }): string

export declare function scaled(p0: bigint | number, by?: bigint | number): bigint
`,
		)
	})
})
