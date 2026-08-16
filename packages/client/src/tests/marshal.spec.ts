import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import type { common } from "@essence-lang/interfaces"

import type { EssenceValue } from "../bridge"
import { describeModule, type Marshaller } from "../descriptor"
import { EssenceMarshalError } from "../errors"
import { type EssenceModule, loadModule } from "../index"
import { createInterpreter } from "../marshal-runtime"
import { EssenceRational } from "../rational"

let cacheDirectory = ""
let module: EssenceModule
let marshaller: Marshaller
let leaves: EssenceModule

beforeAll(async () => {
	cacheDirectory = realpathSync.native(
		mkdtempSync(path.join(tmpdir(), "essence-marshal-")),
	)
	module = await loadModule(
		path.join(import.meta.dirname, "files", "Marshal.es"),
		{ cacheDirectory },
	)
	marshaller = module.marshaller
	leaves = await loadModule(
		path.join(import.meta.dirname, "files", "Leaves.es"),
		{ cacheDirectory },
	)
})

afterAll(() => {
	rmSync(cacheDirectory, { recursive: true, force: true })
})

// NOTE: The Types every test below builds against are the Module's OWN, read
// off the Export Surface — an `Optional<Integer>` here is the one the Compiler
// wrote down for `maybe`, not one this file spelled to suit itself.
function parameterType(name: string): common.Type {
	let signature = module.surface.values[name] as common.FunctionType

	return signature.parameterTypes[0]!.type as common.Type
}

function returnType(name: string): common.Type {
	let signature = module.surface.values[name] as common.FunctionType

	return signature.returnType as common.Type
}

function constantType(name: string): common.Type {
	return module.surface.values[name] as common.Type
}

// NOTE: The whole boundary in one call — a JavaScript value in, through the
// Module's own identity Function, and back out. What comes back is what a host
// would have got, having gone the whole way rather than having been checked
// halfway.
function through(name: string, value: unknown): unknown {
	let callee = module.raw[name] as (
		...args: Array<EssenceValue>
	) => EssenceValue

	return marshaller.toJS(
		callee(marshaller.fromJS(value, parameterType(name), "argument 1")),
		"return value",
	)
}

// NOTE: The same round trip made the way a HOST makes one — through the door
// `exports` binds, where the way out is compiled against the return the Module
// DECLARED rather than left to the walk the value directs. The two answer alike
// for every row of the table, `through` included; this exists because a unit
// Choice is the shape where they answer alike for DIFFERENT reasons — the
// declared door reads the Case off the position, the walk reads it off the
// Module — and both are worth calling.
function called(name: string, ...args: Array<unknown>): unknown {
	return (module.exports[name] as (...args: Array<unknown>) => unknown)(
		...args,
	)
}

// NOTE: A project on disk in a directory of its own, removed again — for the
// one test that needs a Module GRAPH rather than a single file.
async function withProject<Result>(
	files: Record<string, string>,
	work: (directory: string) => Promise<Result>,
): Promise<Result> {
	let directory = mkdtempSync(path.join(tmpdir(), "essence-marshal-project-"))

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

function marshalError(work: () => unknown): EssenceMarshalError {
	let thrown: unknown = null

	try {
		work()
	} catch (error) {
		thrown = error
	}

	expect(thrown).toBeInstanceOf(EssenceMarshalError)

	return thrown as EssenceMarshalError
}

describe("Round trips", () => {
	it("carries an Integer as a bigint", () => {
		expect(through("integer", 42n)).toBe(42n)
		// NOTE: A number is admitted where it is exactly an integer, and comes
		// back as the bigint the Type says it is.
		expect(through("integer", 42)).toBe(42n)
		expect(through("integer", -9007199254740991n)).toBe(-9007199254740991n)
	})

	it("carries a Rational as its two parts", () => {
		let third = through("rational", new EssenceRational(1n, 3n))

		expect(third).toBeInstanceOf(EssenceRational)
		expect((third as EssenceRational).toString()).toBe("1/3")

		// NOTE: Reduced and sign-canonicalised on the way in, which is what the
		// runtime does with the pair as well.
		expect(
			(
				through(
					"rational",
					new EssenceRational(2n, -4n),
				) as EssenceRational
			).toString(),
		).toBe("-1/2")
		expect((through("rational", 5n) as EssenceRational).toString()).toBe(
			"5/1",
		)
	})

	it("carries a String, normalised", () => {
		expect(through("text", "hello")).toBe("hello")
	})

	it("carries a Boolean", () => {
		expect(through("flag", true)).toBe(true)
		expect(through("flag", false)).toBe(false)
	})

	it("carries a List as an Array", () => {
		expect(through("words", ["a", "b", "c"])).toEqual(["a", "b", "c"])
		expect(through("words", [])).toEqual([])
	})

	it("carries a Record as a plain object", () => {
		expect(through("box", { width: 3n, height: 4n })).toEqual({
			width: 3n,
			height: 4n,
		})
	})

	// NOTE: An absent key IS `undefined`, which is how `Optional<String>` is
	// spelled on this side — so leaving it off is the same statement as writing
	// it. Refusing absence reported "expected Optional<String>, got nothing" for
	// the one Type that accepts exactly nothing, and made a Record that had been
	// through `JSON.stringify` — which drops an `undefined`-valued key —
	// impossible to hand back.
	it("takes a Record with an Optional member left off", () => {
		expect(through("card", { title: "a", note: "b" })).toEqual({
			title: "a",
			note: "b",
		})
		expect(through("card", { title: "a", note: undefined })).toEqual({
			title: "a",
			note: undefined,
		})
		expect(through("card", { title: "a" })).toEqual({
			title: "a",
			note: undefined,
		})
		expect(
			through(
				"card",
				JSON.parse(JSON.stringify({ title: "a", note: undefined })),
			),
		).toEqual({ title: "a", note: undefined })
	})

	// NOTE: The same rule, and the same sentence, where the sentence is true.
	it("still refuses a Record with a member that is not Optional left off", () => {
		expect(marshalError(() => through("box", { width: 3n })).message).toBe(
			"argument 1 → .height: expected Integer, got nothing.",
		)
	})

	it("carries an Optional as the value or nothing", () => {
		expect(through("maybe", 7n)).toBe(7n)
		expect(through("maybe", undefined)).toBeUndefined()
		// NOTE: `null` is admitted beside `undefined` — JSON has only the one —
		// and `undefined` is what comes back either way.
		expect(through("maybe", null)).toBeUndefined()
	})

	it("carries a Case with its payload", () => {
		expect(
			through("shape", { $case: "Shape#Rect", width: 3n, height: 4n }),
		).toEqual({ $case: "Shape#Rect", width: 3n, height: 4n })
		expect(through("shape", { $case: "Shape#Circle", radius: 2n })).toEqual(
			{
				$case: "Shape#Circle",
				radius: 2n,
			},
		)
	})

	it("carries a payload-less Case of a mixed Choice", () => {
		expect(through("shape", { $case: "Shape#Blank" })).toEqual({
			$case: "Shape#Blank",
		})
	})

	// NOTE: What the Essence source itself writes — `#Circle` needs no Choice in
	// front of it there, so neither does a host.
	it("takes a Case by its bare name", () => {
		expect(through("shape", { $case: "Circle", radius: 2n })).toEqual({
			$case: "Shape#Circle",
			radius: 2n,
		})
	})

	it("carries a Union by the arm that admits the value", () => {
		expect(through("labelled", "text")).toBe("text")
		expect(through("labelled", 12n)).toBe(12n)
	})

	// NOTE: `toString` lives on `Object.prototype`, so reading an absent key
	// through the prototype chain finds JavaScript's own function where the
	// absent-key rule promises `undefined` — a plain literal and a JSON-parsed
	// object both inherit it.
	it("reads a member through its own keys, never the prototype's", () => {
		expect(through("config", JSON.parse("{}"))).toEqual({
			toString: undefined,
		})
		expect(through("config", { toString: "spelled" })).toEqual({
			toString: "spelled",
		})
		expect(through("styled", { $case: "Styled#Tagged" })).toEqual({
			$case: "Styled#Tagged",
			valueOf: undefined,
		})
	})

	it("carries a List of Records", () => {
		expect(
			through("boxes", [
				{ width: 1n, height: 2n },
				{ width: 3n, height: 4n },
			]),
		).toEqual([
			{ width: 1n, height: 2n },
			{ width: 3n, height: 4n },
		])
	})

	it("carries a List of Optionals", () => {
		expect(through("maybes", [1n, undefined, 3n])).toEqual([
			1n,
			undefined,
			3n,
		])
	})

	// NOTE: A List is stored as two runs and a VIEW into each — the authority is
	// `packages/runtime/src/List.ts` — because the Arrays under one are SHARED
	// with every List built from it. So a value added to at both ends keeps its
	// first items in a different Array from its last, and a value another List
	// was built from is stored in an Array holding more items than it has. What
	// crosses the boundary has to be the items the value holds, and these are
	// the two shapes a List built here and handed straight back can never be in.
	it("carries a List that was added to at both ends", () => {
		expect(through("grown", ["b", "c"])).toEqual([
			"first",
			"b",
			"c",
			"last",
		])
		expect(through("grown", [])).toEqual(["first", "last"])
	})

	it("carries Lists built from one another, each with its own items", () => {
		expect(through("branched", ["b", "c"])).toEqual([
			["b", "c", "z"],
			["a", "b", "c"],
			["b", "c"],
		])
		expect(through("branched", [])).toEqual([["z"], ["a"], []])
	})

	// NOTE: The Module does something with the value rather than handing it
	// back, so this is what says the value it was given was a real one — a Case
	// the Match did not recognise would have thrown inside the bundle.
	it("hands the Module values its own Methods accept", () => {
		let areaOf = module.raw.areaOf as (value: EssenceValue) => EssenceValue
		let shapeType = parameterType("shape")

		expect(
			marshaller.toJS(
				areaOf(
					marshaller.fromJS(
						{ $case: "Shape#Rect", width: 3n, height: 4n },
						shapeType,
					),
				),
			),
		).toBe(12n)
		expect(
			marshaller.toJS(
				areaOf(marshaller.fromJS({ $case: "Shape#Blank" }, shapeType)),
			),
		).toBe(0n)
	})
})

// NOTE: A Choice whose every Case is payload-less crosses as the bare NAME of
// the Case — `"Up"`, never `{ $case: 'Direction#Up' }` — in both directions. It
// is the one shape whose JavaScript spelling was chosen for the HOST rather
// than derived from the Essence value, and the whole of why is in what a
// declaration then reads: `turn(direction: "Up" | "Down")` is an enumeration a
// TypeScript reader already knows, where the object form was this Module's
// bookkeeping made a caller's problem.
describe("A unit Choice", () => {
	it("carries each of its Cases as the bare name", () => {
		expect(called("direction", "Up")).toBe("Up")
		expect(called("direction", "Down")).toBe("Down")
	})

	// NOTE: The same pair of spellings every other Case answers to — the bare
	// name the Essence source itself writes, and the qualified one a `$case`
	// carries. What comes back is the bare one either way, because there is one
	// spelling OUT.
	it("takes a Case by its qualified name as well", () => {
		expect(called("direction", "Direction#Up")).toBe("Up")
	})

	// NOTE: And the standard library's own, which is the Choice the whole rule
	// was wanted for: every `compare` in the language answers one, and a host
	// reading the answer should be reading `"Less"`.
	it("carries the standard library's Ordering", () => {
		expect(called("ordering", "Less")).toBe("Less")
		expect(called("ordering", "Ordering#Greater")).toBe("Greater")
	})

	// NOTE: Beside an `Optional`, which is spelled by absence — so the two do
	// not collide and there is nothing to decide: a string is a Case and
	// `undefined` is the absence.
	it("carries one held by an Optional as the name or nothing", () => {
		expect(called("maybeDirection", "Up")).toBe("Up")
		expect(called("maybeDirection", undefined)).toBeUndefined()
		expect(called("maybeDirection", null)).toBeUndefined()
	})

	it("carries a List of them", () => {
		expect(called("directions", ["Up", "Down"])).toEqual(["Up", "Down"])
		expect(called("directions", [])).toEqual([])
	})

	it("carries one held by a Record member", () => {
		expect(called("marker", { direction: "Up" })).toEqual({
			direction: "Up",
		})
	})

	// NOTE: All-or-nothing per Choice. `Shape` has `#Blank` beside `#Circle`,
	// so every one of its Cases keeps the object form — a Choice half of whose
	// Cases were strings is one no host could write a single `switch` over.
	it("leaves a payload-less Case of a mixed Choice alone", () => {
		expect(called("shape", { $case: "Shape#Blank" })).toEqual({
			$case: "Shape#Blank",
		})
		expect(marshalError(() => called("shape", "Blank")).message).toBe(
			'argument 1: expected Shape, got the string "Blank".',
		)
	})

	// NOTE: One spelling per shape, so the object form is not kept as a second
	// one: a position that took both would be a position two different
	// JavaScript values cross into, while the way out can hand only one of them
	// back. It is worth its own sentence because it is the one wrong value that
	// is RIGHT about which Case it means — "expected Direction, got an object
	// with '$case'" would be true and would not say what to write instead.
	it("refuses the object form and says which string to write", () => {
		expect(
			marshalError(() => called("direction", { $case: "Direction#Up" }))
				.message,
		).toBe(
			`argument 1: expected Direction#Up, which crosses as the string "Up" rather than as a '$case' object.`,
		)
		expect(
			marshalError(() => called("direction", { $case: "Down" })).message,
		).toBe(
			`argument 1: expected Direction#Down, which crosses as the string "Down" rather than as a '$case' object.`,
		)
	})

	it("names the Choice for a string that is no Case of it", () => {
		expect(marshalError(() => called("direction", "Left")).message).toBe(
			'argument 1: expected Direction, got the string "Left".',
		)
		expect(
			marshalError(() => called("directions", ["Up", "Left"])).message,
		).toBe('argument 1 → [1]: expected Direction, got the string "Left".')
	})

	// NOTE: And with NOTHING declared, which is the position the fact is hardest
	// to answer from: a `Direction#Up` and a `Shape#Blank` are the same empty
	// object under two tags, so the value itself can not say which of them
	// crosses as a string. What answers is the Module — a door built from a
	// Descriptor knows every Case that Descriptor names — and it has to, or
	// `toJS` would hand a host a value `fromJS` then refuses.
	it("crosses as the same string with nothing declared", () => {
		let up = module.bridge.case("./Marshal.es#Direction#Up")

		expect(marshaller.toJS(up)).toBe("Up")
		expect(marshaller.toJS(up, "value", returnType("direction"))).toBe("Up")
		expect(through("direction", marshaller.toJS(up))).toBe("Up")
	})
})

// NOTE: Two shapes this boundary told apart by object-versus-string until a
// unit Choice's Cases became strings, and now can not. Refused rather than
// decided, which is the ONE place the Union rule "arms in declaration order,
// first admitting arm wins" deliberately does not reach: deciding would hand a
// String `"Up"` back out as a `Direction#Up`, and losing the value it was given
// is the single thing this boundary may not do.
describe("A position two spellings would collide in", () => {
	// NOTE: The way OUT of a refused position, which is the only way it can be
	// reached at all — the way in refuses the value before any Function is
	// called, so nothing the Module answers with ever gets there through a
	// round trip.
	function refusedOut(name: string, value: unknown): EssenceMarshalError {
		return marshalError(() =>
			marshaller.toJS(value, "return value", returnType(name)),
		)
	}

	function up(): EssenceValue {
		return module.bridge.case("./Marshal.es#Direction#Up")
	}

	// NOTE: The collision the whole rule exists for, and the same sentence in
	// both directions — the position has no spelling, which is a fact about the
	// SHAPE rather than about any value of it, so it holds whichever way one is
	// crossing.
	it("refuses a bare Case standing beside a String", () => {
		expect(
			marshalError(() => called("directionOrText", "Up")).message,
		).toBe(
			`argument 1: 'Direction | String' has no unambiguous JavaScript spelling — a Direction#Up crosses as the string "Up", which a String is too. Wrap one side in a Record or give the Case a payload.`,
		)
		expect(refusedOut("directionOrText", up()).message).toBe(
			`return value: 'Direction | String' has no unambiguous JavaScript spelling — a Direction#Up crosses as the string "Up", which a String is too. Wrap one side in a Record or give the Case a payload.`,
		)
	})

	// NOTE: And the same collision without a String in it — one Choice's `#Up`
	// is spelled exactly like another's, and neither the value nor the position
	// says which was meant.
	it("refuses two unit Choices sharing a Case name", () => {
		expect(
			marshalError(() => called("directionOrVertical", "Up")).message,
		).toBe(
			`argument 1: 'Direction | Vertical' has no unambiguous JavaScript spelling — a Direction#Up and a Vertical#Up both cross as the string "Up". Wrap one side in a Record or give the Case a payload.`,
		)
		expect(refusedOut("directionOrVertical", up()).message).toBe(
			`return value: 'Direction | Vertical' has no unambiguous JavaScript spelling — a Direction#Up and a Vertical#Up both cross as the string "Up". Wrap one side in a Record or give the Case a payload.`,
		)
	})

	// NOTE: Per Case NAME, not per pair of unit Choices. Two of them in one
	// position are perfectly spellable while no name is written twice, and
	// refusing the pair rather than the name would refuse a shape that works.
	it("takes two unit Choices sharing no Case name", () => {
		expect(called("directionOrSign", "Up")).toBe("Up")
		expect(called("directionOrSign", "Minus")).toBe("Minus")
	})

	// NOTE: And per unit CASE. A Choice with a payload anywhere in it crosses
	// as a `$case` object whatever its payload-less Cases are called, and an
	// object is not a string.
	it("takes a unit Choice beside one that keeps the object form", () => {
		expect(called("directionOrShape", "Up")).toBe("Up")
		expect(called("directionOrShape", { $case: "Shape#Blank" })).toEqual({
			$case: "Shape#Blank",
		})
	})

	// NOTE: The two places an `Optional` can stand between a position and a
	// collision, and neither hides one. It is spelled by ABSENCE, so what it
	// holds stands in the position beside everything else: `Optional<String> |
	// Direction` collides through it, and `Optional<Direction | String>`
	// collides inside it and keeps the sentence rather than being answered with
	// its own Type. What `Optional` contributes of its own is `undefined`,
	// which is nobody else's spelling and collides with nothing — which is why
	// the `Optional<Direction>` above is ordinary.
	//
	// NOTE: A project of its own because `Marshal.es` is a table of the shapes
	// that CROSS, and these two are here to be refused. One compile answers
	// both.
	it("refuses a collision an Optional stands in the way of", async () => {
		await withProject(
			{
				"Main.es": `implementation {
	choice Direction {
		Up,
		Down,
	}

	function noted(
		_ value: Optional<String> | Direction,
	) -> Optional<String> | Direction {
		<- value
	}

	function wrapped(
		_ value: Optional<Direction | String>,
	) -> Optional<Direction | String> {
		<- value
	}
}

export {
	Direction
	noted
	wrapped
}
`,
			},
			async (directory) => {
				let project = await loadModule(
					path.join(directory, "Main.es"),
					{ cacheDirectory },
				)
				let noted = project.exports.noted as (value: unknown) => unknown
				let wrapped = project.exports.wrapped as (
					value: unknown,
				) => unknown

				expect(marshalError(() => noted("Up")).message).toBe(
					`argument 1: 'Optional<String> | Direction' has no unambiguous JavaScript spelling — a Direction#Up crosses as the string "Up", which a String is too. Wrap one side in a Record or give the Case a payload.`,
				)
				expect(marshalError(() => wrapped("Up")).message).toBe(
					`argument 1: 'Direction | String' has no unambiguous JavaScript spelling — a Direction#Up crosses as the string "Up", which a String is too. Wrap one side in a Record or give the Case a payload.`,
				)
				// NOTE: And the absence still crosses, because the position it
				// crosses into is the one shape in there that has a spelling.
				expect(wrapped(undefined)).toBeUndefined()
			},
		)
	})

	// NOTE: At VALUE time and never at bind time. A Module with one unspellable
	// position in it is still a Module and every other name it exports still
	// works — the same stance `nestedOptional` is refused under, and the reason
	// the refusal is COMPILED into a reader rather than thrown while compiling
	// one.
	it("still binds the Module and every other name in it", () => {
		expect(typeof module.exports.directionOrText).toBe("function")
		expect(typeof module.exports.directionOrVertical).toBe("function")
		expect(called("direction", "Up")).toBe("Up")
		expect(module.exports.answer).toBe(42n)
	})
})

describe("Numbers", () => {
	// NOTE: What `0.1` HOLDS, not what its decimal spelling suggests. Going by
	// `toString` would answer `1/10` and claim a precision the double never had.
	it("reads a double's exact dyadic value", () => {
		expect(EssenceRational.fromNumber(0.1).toString()).toBe(
			"3602879701896397/36028797018963968",
		)
		expect(EssenceRational.fromNumber(0.5).toString()).toBe("1/2")
		expect(EssenceRational.fromNumber(-0.75).toString()).toBe("-3/4")
		expect(EssenceRational.fromNumber(0).toString()).toBe("0/1")
		expect(EssenceRational.fromNumber(3).toString()).toBe("3/1")
	})

	// NOTE: A subnormal carries no implicit leading bit and shares the smallest
	// normal's exponent — the one reading the bits has to special-case, and the
	// one an off-by-one in the scale is invisible anywhere else.
	it("reads a subnormal double exactly", () => {
		let smallest = EssenceRational.fromNumber(Number.MIN_VALUE)

		expect(smallest.numerator).toBe(1n)
		expect(smallest.denominator).toBe(2n ** 1074n)
	})

	it("takes that exact value across the boundary", () => {
		let tenth = through("rational", 0.1)

		expect((tenth as EssenceRational).toString()).toBe(
			"3602879701896397/36028797018963968",
		)
	})

	it("answers the nearest double back", () => {
		expect(new EssenceRational(1n, 3n).toNumber()).toBe(1 / 3)
		expect(EssenceRational.fromNumber(0.1).toNumber()).toBe(0.1)
		expect(new EssenceRational(0n, 5n).toNumber()).toBe(0)
		// NOTE: Parts far too large for a double to hold — the magnitude still
		// comes back rather than a `NaN` out of `Infinity / Infinity`.
		expect(
			new EssenceRational(10n ** 400n, 3n * 10n ** 400n).toNumber(),
		).toBeCloseTo(1 / 3, 15)
	})

	// NOTE: Both parts past 2 ** 53 are already rounded by the mere reading, so
	// dividing the two readings rounds three times and lands an ulp off the
	// nearest double — these pairs are known to. The last is a part small
	// enough to read exactly over one so large the answer is subnormal, which
	// the hardware division answers in its one correctly rounded step and a
	// 53-bit intermediate would double-round.
	it("rounds to the nearest double, down to the last ulp", () => {
		expect(
			new EssenceRational(
				129907132001406551n,
				63955986924371064n,
			).toNumber(),
		).toBe(2.0311957996211323)
		expect(
			new EssenceRational(
				22903556286483331n,
				9330191837554713n,
			).toNumber(),
		).toBe(2.4547787103685073)
		expect(new EssenceRational(1n, 5n << 1021n).toNumber()).toBe(
			1 / (5 * 2 ** 1021),
		)
	})

	// NOTE: The scale back is a power of two far outside a double's own exponent
	// — `2 ** -1088` for the first of these — and `2 ** -1088` IS `0`. Applied in
	// one multiplication it answered `0` for a value that is a perfectly ordinary
	// subnormal: not the magnitude, not a `NaN`, a wrong finite number.
	it("answers a small Rational with a huge denominator exactly", () => {
		expect(new EssenceRational(1n, 2n ** 1024n).toNumber()).toBe(2 ** -1024)
		expect(new EssenceRational(-1n, 2n ** 1024n).toNumber()).toBe(
			-(2 ** -1024),
		)
		// NOTE: The smallest double there is, and the first value below it.
		expect(new EssenceRational(1n, 2n ** 1074n).toNumber()).toBe(
			Number.MIN_VALUE,
		)
		expect(new EssenceRational(1n, 2n ** 1100n).toNumber()).toBe(0)
		// NOTE: And the other end, where `Infinity` is the right answer rather
		// than the one that got away.
		expect(new EssenceRational(2n ** 2000n, 3n).toNumber()).toBe(Infinity)
		expect(new EssenceRational(2n ** 1200n, 2n ** 1199n).toNumber()).toBe(2)
	})

	it("refuses a denominator of zero and a number that is not finite", () => {
		expect(() => new EssenceRational(1n, 0n)).toThrow(RangeError)
		expect(() => EssenceRational.fromNumber(Number.NaN)).toThrow(RangeError)
		expect(() => EssenceRational.fromNumber(Infinity)).toThrow(RangeError)
	})

	it("is equal by its canonical parts", () => {
		expect(
			new EssenceRational(2n, 4n).equals(new EssenceRational(1n, 2n)),
		).toBe(true)
		expect(
			new EssenceRational(-1n, 2n).equals(new EssenceRational(1n, -2n)),
		).toBe(true)
		expect(
			new EssenceRational(1n, 2n).equals(new EssenceRational(1n, 3n)),
		).toBe(false)
	})
})

describe("Strings", () => {
	// NOTE: String equality in Essence is normalised, so letting both spellings
	// of `é` in would put two values into the Module it insists are one.
	//
	// NOTE: Spelled by code point rather than typed, because the DIFFERENCE
	// between the two spellings is what is under test — an editor, a formatter or
	// a `git` filter normalising this file would quietly erase it.
	it("normalises to NFC on the way in", () => {
		let composed = "\u00e9"
		let decomposed = "e\u0301"

		expect(composed).not.toBe(decomposed)
		expect(through("text", decomposed)).toBe(composed)
		expect(through("text", composed)).toBe(
			through("text", decomposed) as string,
		)
	})
})

describe("The exports of a Module", () => {
	it("hands back every constant as a JavaScript value", () => {
		expect(module.exports.answer).toBe(42n)
		expect((module.exports.third as EssenceRational).toString()).toBe("1/3")
		expect(module.exports.greeting).toBe("h\u00e9")
		expect(module.exports.yes).toBe(true)
		expect(module.exports.names).toEqual(["a", "b"])
		expect(module.exports.point).toEqual({ x: 1n, y: 2n })
		expect(module.exports.blank).toEqual({ $case: "Shape#Blank" })
		expect(module.exports.circle).toEqual({
			$case: "Shape#Circle",
			radius: 3n,
		})
		expect(module.exports.present).toBe(7n)
		expect(module.exports.absent).toBeUndefined()
		// NOTE: A constant is read through a door of its own — compiled once
		// against what was DECLARED, with no call around it — so a unit Choice
		// reaches this side here without a Parameter or a return having named
		// it. `plus` is the Case standing alone for a Type, which is what an
		// unannotated one is inferred as, and it crosses by the same rule.
		expect(module.exports.heading).toBe("Up")
		expect(module.exports.plus).toBe("Plus")
	})

	// NOTE: And every Function beside them, marshalling both ways around the
	// call — which is what makes `exports` JavaScript all the way down rather
	// than JavaScript until the first call.
	it("hands back every Function as a JavaScript one", () => {
		expect(typeof module.exports.integer).toBe("function")
		expect(Object.keys(module.exports).sort()).toEqual([
			// NOTE: The Choices among them, which the bundle binds no name for
			// — what is under those is one constructor per Case, spelled on
			// this side.
			"Direction",
			"Shape",
			"Sign",
			"Styled",
			"Vertical",
			"absent",
			"answer",
			"areaOf",
			"blank",
			"box",
			"boxes",
			"branched",
			"card",
			"circle",
			"config",
			"direction",
			"directionOrShape",
			"directionOrSign",
			"directionOrText",
			"directionOrVertical",
			"directions",
			"flag",
			"greeting",
			"grown",
			"heading",
			"integer",
			"labelled",
			"marker",
			"maybe",
			"maybeDirection",
			"maybes",
			"names",
			"ordering",
			"plus",
			"point",
			"present",
			"rational",
			"shape",
			"styled",
			"text",
			"third",
			"words",
			"yes",
		])
	})

	it("marshals a constant against nothing but its own tag", () => {
		expect(marshaller.toJS(module.raw.circle)).toEqual({
			$case: "Shape#Circle",
			radius: 3n,
		})
	})
})

describe("Values built through the bridge", () => {
	it("reads back what the bundle's own constructors built", () => {
		let bridge = module.bridge

		expect(marshaller.toJS(bridge.integer(12n))).toBe(12n)
		expect(marshaller.toJS(bridge.string("hi"))).toBe("hi")
		expect(marshaller.toJS(bridge.boolean(false))).toBe(false)
		expect(
			(
				marshaller.toJS(bridge.rational(2n, 4n)) as EssenceRational
			).toString(),
		).toBe("1/2")
		expect(
			marshaller.toJS(
				bridge.list([bridge.integer(1n), bridge.integer(2n)]),
			),
		).toEqual([1n, 2n])
		expect(
			marshaller.toJS(
				bridge.record({
					name: bridge.string("a"),
					size: bridge.integer(1n),
				}),
			),
		).toEqual({ name: "a", size: 1n })
	})

	// NOTE: The raw door is the only place a host reaches a constructor
	// directly, so it is the only place a value that is not an Integer at all
	// can get under an Integer's tag. `createInteger` itself does not ask —
	// every caller inside the runtime and in emitted code is already holding an
	// integer, and it is the hottest construction path there is — so the door
	// asks instead.
	it("refuses a number that is not an Integer a double holds", () => {
		let bridge = module.bridge

		expect(() => bridge.integer(1.5)).toThrow("1.5 is not an Integer")
		expect(() => bridge.integer(-0.5)).toThrow()
		expect(() => bridge.integer(2 ** 53)).toThrow()
		expect(() => bridge.integer(1e21)).toThrow()
		expect(() => bridge.integer(Number.NaN)).toThrow()
		expect(() => bridge.integer(Number.POSITIVE_INFINITY)).toThrow()

		expect(marshaller.toJS(bridge.integer(-0))).toBe(0n)
		expect(marshaller.toJS(bridge.integer(9007199254740991))).toBe(
			9007199254740991n,
		)
		expect(marshaller.toJS(bridge.integer(9007199254740992n))).toBe(
			9007199254740992n,
		)
	})

	it("unwraps an Optional built through the bridge", () => {
		let bridge = module.bridge

		expect(
			marshaller.toJS(
				bridge.case("Optional#Value", { item: bridge.integer(5n) }),
			),
		).toBe(5n)
		expect(marshaller.toJS(bridge.case("Optional#Empty"))).toBeUndefined()
	})

	// NOTE: A Function is the one Essence value carrying no tag, so it is the
	// one that has to pass through rather than be read apart.
	it("passes a Function through untouched", () => {
		expect(marshaller.toJS(module.raw.integer)).toBe(module.raw.integer)
	})

	// NOTE: The interpreter is a door of its own — `prebuilt` hands one over,
	// and a host reaching it holds Descriptors rather than Types. A host with
	// none for the value in hand has two ways to say so and means the same thing
	// by both: `null` out of a variable that holds no Descriptor is not a Type
	// declaration of `null`.
	it("reads a value against no Descriptor, however that is spelled", () => {
		let interpreter = createInterpreter(
			module.bridge,
			describeModule(module.surface, module.entryPath),
		)
		let none = null as unknown as undefined

		expect(interpreter.toJS(module.raw.answer, "answer")).toBe(42n)
		expect(interpreter.toJS(module.raw.answer, "answer", none)).toBe(42n)
	})
})

describe("Errors", () => {
	it("names the Type it expected and the value it got", () => {
		let error = marshalError(() =>
			marshaller.fromJS("nope", parameterType("integer"), "argument 1"),
		)

		expect(error.message).toBe(
			'argument 1: expected Integer, got the string "nope".',
		)
		expect(error.path).toBe("argument 1")
	})

	// NOTE: The path is the point — an Error naming only the Type would say
	// `expected Integer` about a value four levels down and leave the finding of
	// it to the reader.
	it("spells where inside the value the failure was", () => {
		let error = marshalError(() =>
			marshaller.fromJS(
				[
					{ width: 1n, height: 2n },
					{ width: 3n, height: "four" },
				],
				parameterType("boxes"),
				"argument 1",
			),
		)

		expect(error.path).toBe("argument 1 → [1].height")
		expect(error.message).toBe(
			'argument 1 → [1].height: expected Integer, got the string "four".',
		)
	})

	it("refuses a Record with a member the Type does not declare", () => {
		let error = marshalError(() =>
			marshaller.fromJS(
				{ width: 1n, height: 2n, depth: 3n },
				parameterType("box"),
				"argument 1",
			),
		)

		expect(error.message).toBe(
			"argument 1: expected { width: Integer, height: Integer }, got an object with a member it does not declare — 'depth'.",
		)
	})

	it("refuses a Record with a member missing", () => {
		let error = marshalError(() =>
			marshaller.fromJS(
				{ width: 1n },
				parameterType("box"),
				"argument 1",
			),
		)

		expect(error.message).toBe(
			"argument 1 → .height: expected Integer, got nothing.",
		)
	})

	it("names the whole Union when no arm admits the value", () => {
		let error = marshalError(() =>
			marshaller.fromJS(true, parameterType("labelled"), "argument 1"),
		)

		expect(error.message).toBe(
			"argument 1: expected Label, got the boolean true.",
		)
	})

	it("names the Choice when no Case admits the value", () => {
		let error = marshalError(() =>
			marshaller.fromJS(
				{ $case: "Shape#Oval", radius: 1n },
				parameterType("shape"),
				"argument 1",
			),
		)

		expect(error.message).toContain("expected Shape")
		expect(error.path).toBe("argument 1")
	})

	// NOTE: Every arm of a Union refuses the value, so the Union itself is what
	// went wrong — but only one arm got INSIDE the value before refusing, and
	// what it found there is the only sentence that says what is actually wrong.
	it("keeps the one arm's reason where a Union has only one", () => {
		let error = marshalError(() =>
			marshaller.fromJS(
				{ $case: "Shape#Circle", radius: "big" },
				parameterType("shape"),
				"argument 1",
			),
		)

		expect(error.message).toBe(
			'argument 1 → .radius: expected Integer, got the string "big".',
		)
	})

	it("keeps it for a member the Case declares and the value does not", () => {
		let error = marshalError(() =>
			marshaller.fromJS(
				{ $case: "Shape#Rect", width: 1n },
				parameterType("shape"),
				"argument 1",
			),
		)

		expect(error.message).toBe(
			"argument 1 → .height: expected Integer, got nothing.",
		)
	})

	// NOTE: And where no arm got inside, the Union is the only honest answer —
	// `Optional<Integer>` handed a Boolean is not a near miss at either of them.
	it("names the Union where no arm reached inside", () => {
		let error = marshalError(() =>
			marshaller.fromJS(true, parameterType("maybe"), "argument 1"),
		)

		expect(error.message).toBe(
			"argument 1: expected Optional<Integer>, got the boolean true.",
		)
	})

	// NOTE: A number that is not exactly an integer is refused rather than
	// rounded — a boundary that rounds is a boundary that loses.
	it("refuses a number that is not exactly an Integer", () => {
		expect(
			marshalError(() => marshaller.fromJS(1.5, parameterType("integer")))
				.message,
		).toBe("value: expected Integer, got the number 1.5.")
		expect(
			marshalError(() =>
				marshaller.fromJS(2 ** 53, parameterType("integer")),
			).message,
		).toContain("expected Integer")
	})

	it("refuses a JavaScript value on the way out", () => {
		expect(marshalError(() => marshaller.toJS({ width: 3 })).message).toBe(
			"value: this value did not come from this Module — an object with 'width'.",
		)
		expect(marshalError(() => marshaller.toJS(42)).message).toContain(
			"did not come from this Module",
		)
	})

	// NOTE: An Essence value handed back IN is a common enough mistake to be
	// worth naming as what it is rather than as a list of hidden members.
	it("says so when an Essence value arrives where JavaScript was wanted", () => {
		let error = marshalError(() =>
			marshaller.fromJS(
				module.bridge.integer(1n),
				parameterType("integer"),
			),
		)

		expect(error.message).toBe(
			"value: expected Integer, got an Essence Integer value.",
		)
	})

	// NOTE: The mirror of every other row of the table: a Function goes IN, and
	// the values it is then handed come OUT. `integer` is `(Integer) -> Integer`,
	// so the callback is called with one of the Module's Integers and answers
	// with a `bigint` the boundary builds one back out of.
	it("takes a Function where the Type declares one", () => {
		let signature = module.surface.values.integer as common.Type
		let callback = marshaller.fromJS(
			(value: bigint) => value + 1n,
			signature,
		) as (...args: Array<EssenceValue>) => EssenceValue

		expect(marshaller.toJS(callback(module.bridge.integer(41n)))).toBe(42n)
	})

	// NOTE: A refusal inside a callback is spelled from where the callback
	// ARRIVED, because that is the Function a reader has to go and fix — the one
	// they passed, not one of the Module's.
	it("says where inside a callback a value did not fit", () => {
		let signature = module.surface.values.integer as common.Type
		let callback = marshaller.fromJS(
			() => "four",
			signature,
			"argument 2",
		) as (...args: Array<EssenceValue>) => EssenceValue
		let error = marshalError(() => callback(module.bridge.integer(1n)))

		expect(error.message).toBe(
			'argument 2 → return value: expected Integer, got the string "four".',
		)
	})

	it("refuses a value that is no Function where one is declared", () => {
		let signature = module.surface.values.integer as common.Type

		expect(
			marshalError(() => marshaller.fromJS(12n, signature)).message,
		).toBe("value: expected (_ Integer) -> Integer, got the bigint 12.")
	})

	// NOTE: A misspelled payload member has to be as findable as a misspelled
	// Record member. A Choice always reaches `fromJS` as the Union of its Cases,
	// so a refusal raised at the value's own path is one the Union throws away —
	// which left `argument 1: expected Shape` as the whole answer.
	it("keeps a Case's own reason where its tag matched", () => {
		let error = marshalError(() =>
			marshaller.fromJS(
				{ $case: "Shape#Circle", radius: 1n, extra: 2n },
				parameterType("shape"),
				"argument 1",
			),
		)

		expect(error.message).toContain(
			"got an object with a member it does not declare — 'extra'",
		)
	})

	// NOTE: Bounded, because the object being described is one a host got wrong,
	// and a parsed JSON document with a thousand keys is exactly that.
	it("does not spell out every key of a wide object", () => {
		let wide: Record<string, unknown> = {}

		for (let position = 0; position < 200; position += 1) {
			wide[`key${position}`] = position
		}

		let message = marshalError(() => marshaller.toJS(wide)).message

		expect(message).toContain("'key0', 'key1', 'key2', 'key3', 'key4'")
		expect(message).toContain("and 195 more")
		expect(message.length).toBeLessThan(200)
	})
})

describe("The Types a Surface actually carries", () => {
	// NOTE: An applied Alias is already substituted by the time it reaches an
	// Export Surface, which is why `fromJS` meets a Record where the source
	// wrote `Box` and a Union of two Cases where it wrote `Optional<Integer>`.
	it("meets an applied Alias already substituted", () => {
		expect(parameterType("box").type).toBe("Record")
		expect(parameterType("maybe").type).toBe("UnionType")
		expect((parameterType("maybe") as common.UnionType).alias?.name).toBe(
			"Optional",
		)
	})

	it("meets a Choice as the Union of its Cases", () => {
		let shape = parameterType("shape") as common.UnionType

		expect(shape.name).toBe("Shape")
		expect(shape.types.map((one) => (one as common.CaseType).name)).toEqual(
			["Circle", "Rect", "Blank"],
		)
	})

	// NOTE: A Case tag is qualified by the Module that declared the Choice, and
	// a bundle spells that Module relative to its entry — so the tag a value
	// carries is neither the bare `Shape#Circle` a host writes nor the absolute
	// path the Surface holds.
	it("stamps a Case with the tag the bundle's own values carry", () => {
		let built = marshaller.fromJS(
			{ $case: "Shape#Circle", radius: 1n },
			parameterType("shape"),
		)

		expect((built as Record<symbol, unknown>)[module.bridge.typeKey]).toBe(
			"./Marshal.es#Shape#Circle",
		)
		expect(
			(constantType("circle") as common.UnionType).types.map(
				(one) => (one as common.CaseType).choice,
			)[0],
		).toBe(`${module.entryPath}#Shape`)
	})

	// NOTE: The entry is not the only Module that can declare a Choice, and a
	// Case declared in a DEPENDENCY is spelled relative to the entry's directory
	// — `./shapes/Shapes.es#Shape#Circle`. Nothing about the entry's own Choices
	// would have caught a tag built from the wrong base.
	it("stamps a Case declared in a dependency with its relative spelling", async () => {
		await withProject(
			{
				"shapes/Shapes.es": `implementation {
	choice Shape {
		Circle { radius: Integer },
		Blank,
	}
}

export {
	Shape
}
`,
				"Main.es": `import {
	Shape from "./shapes/Shapes.es"
}

implementation {
	function shape(_ value: Shape) -> Shape {
		<- value
	}
}

export {
	shape
}
`,
			},
			async (directory) => {
				let project = await loadModule(
					path.join(directory, "Main.es"),
					{
						cacheDirectory,
					},
				)
				let signature = project.surface.values
					.shape as common.FunctionType
				let shapeType = signature.parameterTypes[0]!.type as common.Type
				let built = project.marshaller.fromJS(
					{ $case: "Shape#Circle", radius: 2n },
					shapeType,
				)

				expect(
					(built as Record<symbol, unknown>)[project.bridge.typeKey],
				).toBe("./shapes/Shapes.es#Shape#Circle")

				let callee = project.raw.shape as (
					value: EssenceValue,
				) => EssenceValue

				expect(
					project.marshaller.toJS(callee(built as EssenceValue)),
				).toEqual({ $case: "Shape#Circle", radius: 2n })
			},
		)
	})
})

// NOTE: What the boundary can not describe, refused in both directions. The rule
// this file holds is that a value the mapping has no spelling for is REFUSED
// rather than answered wrongly — silently turning `#Value(#Empty)` into `#Empty`
// is the one thing a boundary called lossless may not do.
describe("What the boundary refuses", () => {
	let refused: EssenceModule
	let refusedMarshaller: Marshaller

	beforeAll(async () => {
		refused = await loadModule(
			path.join(import.meta.dirname, "files", "Refused.es"),
			{ cacheDirectory },
		)
		refusedMarshaller = refused.marshaller
	})

	function refusedParameter(name: string): common.Type {
		let signature = refused.surface.values[name] as common.FunctionType

		return signature.parameterTypes[0]!.type as common.Type
	}

	// NOTE: `Optional<T>` is `T | undefined` here, and `undefined` does not
	// nest: `#Value(#Empty)` and `#Empty` would both be `undefined`, so a round
	// trip through a host would turn the first into the second and say nothing.
	// `Optional.es` states the opposite invariant outright.
	it("refuses an Optional inside an Optional coming out", () => {
		let error = marshalError(() => refused.exports.deep)

		expect(error.message).toContain(
			"an Optional inside an Optional has no JavaScript spelling",
		)
		// NOTE: One level is still perfectly ordinary.
		expect(refused.exports.shallow).toBeUndefined()
	})

	it("refuses an Optional inside an Optional going in", () => {
		let error = marshalError(() =>
			refusedMarshaller.fromJS(
				undefined,
				refusedParameter("nested"),
				"argument 1",
			),
		)

		expect(error.message).toContain("'#Value(#Empty)' is not '#Empty'")
		expect(
			marshalError(() =>
				(refused.exports.nested as (value: unknown) => unknown)(7n),
			).message,
		).toContain("an Optional inside an Optional")
	})

	// NOTE: `$` is an ordinary Essence identifier character, so a Choice CAN
	// declare a payload member named after the tag. Coming out it was already
	// refused; going in it used to read the tag string as the member's value —
	// a corrupted value the boundary accepts and can then never describe.
	it("refuses a Case whose payload is named after the tag", () => {
		let error = marshalError(() =>
			refusedMarshaller.fromJS(
				{ $case: "One" },
				refusedParameter("nameOf"),
				"argument 1",
			),
		)

		expect(error.message).toBe(
			"argument 1: this Case can not be marshalled — its payload declares a member named '$case', which is the name the Case tag is carried under.",
		)
		expect(
			marshalError(() =>
				refusedMarshaller.toJS(
					(
						refused.raw.tagged as (
							value: EssenceValue,
						) => EssenceValue
					)(refused.bridge.string("hi")),
					"return value",
				),
			).message,
		).toContain("declares a member named '$case'")
	})

	// NOTE: A Case of the same Choice that declares no such member is untouched
	// — the refusal is about the Case, not about the Choice.
	it("still takes a Case of that Choice that does not collide", () => {
		expect(
			(refused.exports.nameOf as (value: unknown) => unknown)({
				$case: "Plain",
			}),
		).toBe("plain")
	})

	// NOTE: One export the Marshaller has no mapping for used to take the whole
	// Module with it — `exports`, `raw`, `bridge` and `marshaller` all
	// unreachable over a constant nobody asked for. Bound on read, the refusal
	// lands on the export that caused it.
	it("keeps the rest of the Module reachable past an export it can not marshal", () => {
		expect(marshalError(() => refused.exports.root).message).toBe(
			"root: Algebraic values can not be marshalled yet.",
		)
		expect(refused.exports.answer).toBe(42n)
		expect((refused.exports.doubled as (value: bigint) => bigint)(4n)).toBe(
			8n,
		)
		expect(typeof refused.raw.root).toBe("object")
	})

	// NOTE: What `exports` hands out is what `marshaller.toJS(raw.…)` hands out,
	// which means a fresh value on every read. One shared Array is one a host can
	// push onto, and every other holder of the same Module sees the push —
	// while `Object.freeze(exports)` says, wrongly, that it cannot.
	it("hands out a constant a reader can not corrupt for the next one", () => {
		let names = module.exports.names as Array<string>

		expect(names).toEqual(["a", "b"])

		names.push("MUTATED")

		expect(module.exports.names).toEqual(["a", "b"])
	})
})

// NOTE: The item Type of a `Leaves.es` Parameter, read off ITS Surface — the
// same rule the helpers above are written under, for the Module that has each
// leaf twice.
function leafType(name: string): common.Type {
	let signature = leaves.surface.values[name] as common.FunctionType

	return signature.parameterTypes[0]!.type as common.Type
}

// NOTE: What the boundary did with one value, as something two calls can be
// compared by: the value it answered with, or the sentence it refused with —
// minus the path, which is the one thing the two spellings below are SUPPOSED
// to disagree about. Any other Error is compared whole, because a leaf that
// stops refusing a value the boundary should have refused reaches the runtime's
// own constructors instead, and that difference is the one most worth seeing.
type Admission = { got: unknown } | { refused: string }

function admission(work: () => unknown): Admission {
	try {
		return { got: work() }
	} catch (error) {
		let failure = error as Error

		return {
			refused:
				failure instanceof EssenceMarshalError
					? failure.message.slice(failure.path.length)
					: failure.message,
		}
	}
}

function asLeaf(name: string, value: unknown): Admission {
	return admission(() =>
		leaves.marshaller.toJS(
			leaves.marshaller.fromJS(value, leafType(name), "argument 1"),
		),
	)
}

function asItem(name: string, value: unknown): Admission {
	return admission(() => {
		let list = leaves.marshaller.toJS(
			leaves.marshaller.fromJS([value], leafType(name), "argument 1"),
		)

		return (list as Array<unknown>)[0]
	})
}

// NOTE: A hole is not a value, and an Array with one in it is not a List with
// one in it: every position of a List holds something. `Array.prototype.map`
// SKIPS a hole, so a walk written with it left the position holding a raw
// JavaScript `undefined` — a value carrying no Type tag at all, which every
// Method that reached it would find untyped. The loop reads the position
// instead, and the item's own shape decides, which is the same rule an absent
// Record member is read by.
describe("An Array with a hole in it", () => {
	// NOTE: A HOLE at position 1 rather than a written `undefined`, which is a
	// different Array — `1 in [1, undefined, 3]` is true and `1 in [1, , 3]` is
	// not. Spelled once, so the one place this has to be said is this one.
	// oxlint-disable-next-line no-sparse-arrays -- the hole is the subject
	let holed = (before: unknown, after: unknown) => [before, , after]

	it("refuses the hole where the items are values", () => {
		let refusal = marshalError(() =>
			leaves.marshaller.fromJS(
				holed(1n, 3n),
				leafType("integers"),
				"argument 1",
			),
		)

		expect(refusal.message).toBe(
			"argument 1 → [1]: expected Integer, got nothing.",
		)
		expect(refusal.path).toBe("argument 1 → [1]")
		expect(
			marshalError(() =>
				leaves.marshaller.fromJS(
					holed("a", "c"),
					leafType("texts"),
					"argument 1",
				),
			).message,
		).toBe("argument 1 → [1]: expected String, got nothing.")
	})

	// NOTE: And crosses it where the items admit absence, because there the
	// position holding nothing is a position holding `#Empty`.
	it("carries the hole as nothing where the items admit it", () => {
		expect(
			leaves.marshaller.toJS(
				leaves.marshaller.fromJS(
					holed(1n, 3n),
					leafType("maybes"),
					"argument 1",
				),
			),
		).toEqual([1n, undefined, 3n])
	})
})

// NOTE: `runIn` spells the Integer, String and Boolean admissions a second time,
// beside the `buildIn` branches that compile the same leaves alone — one rule in
// two places, because a loop that calls a converter it was handed can not see
// what it is calling, and the measurement that bought the duplication is in
// `BENCH.md`. Two spellings of ONE rule, though: a value met on its own and the
// same value met inside a List are the same value, so a difference between them
// is a bug and never a decision. This is what checks that rather than promising
// it — without it, a change to one spelling applies to values met alone and not
// to the same values met inside a List, and every leaf test keeps passing.
describe("A leaf met alone and met inside a List", () => {
	// NOTE: Deliberately adversarial and deliberately not all valid — what the
	// two spellings have to agree about is the REFUSALS as much as the values,
	// and a corpus of things that fit would check the easy half.
	const CORPUS: Array<unknown> = [
		5,
		5n,
		0,
		-0,
		-7,
		1.5,
		2 ** 53,
		9007199254740991,
		9007199254740991n,
		-9007199254740992n,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		"",
		"hi",
		// NOTE: The same String decomposed and composed — NFC is part of the
		// admission, so both spellings have to normalise or neither does.
		"é",
		"é",
		true,
		false,
		null,
		undefined,
		{},
		{ $case: "Optional#Value", item: 1n },
		[],
		[1n],
		new EssenceRational(1n, 3n),
		Symbol("nope"),
		() => 1n,
	]

	for (let name of ["integer", "text", "flag", "rational", "maybe"]) {
		it(`admits and refuses ${name} the same way either way`, () => {
			for (let value of CORPUS) {
				expect({
					value,
					...asItem(`${name}s`, value),
				}).toEqual({ value, ...asLeaf(name, value) })
			}
		})
	}

	// NOTE: And a value that came from the MODULE, which is the one kind of
	// value neither spelling builds: a tagged Integer is a JavaScript object,
	// and an object is not what any leaf admits.
	it("refuses one of the Module's own values the same way either way", () => {
		let tagged = leaves.bridge.integer(5n)

		expect(asItem("integers", tagged)).toEqual(asLeaf("integer", tagged))
		expect(asItem("texts", tagged)).toEqual(asLeaf("text", tagged))
	})
})
