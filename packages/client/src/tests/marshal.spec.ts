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
import { EssenceMarshalError } from "../errors"
import { type EssenceModule, loadModule } from "../index"
import type { Marshaller } from "../marshal"
import { EssenceRational } from "../rational"

let cacheDirectory = ""
let module: EssenceModule
let marshaller: Marshaller

beforeAll(async () => {
	cacheDirectory = realpathSync.native(
		mkdtempSync(path.join(tmpdir(), "essence-marshal-")),
	)
	module = await loadModule(
		path.join(import.meta.dirname, "files", "Marshal.es"),
		{ cacheDirectory },
	)
	marshaller = module.marshaller
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

	it("carries a unit Case", () => {
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
	})

	// NOTE: And every Function beside them, marshalling both ways around the
	// call — which is what makes `exports` JavaScript all the way down rather
	// than JavaScript until the first call.
	it("hands back every Function as a JavaScript one", () => {
		expect(typeof module.exports.integer).toBe("function")
		expect(Object.keys(module.exports).sort()).toEqual([
			"absent",
			"answer",
			"areaOf",
			"blank",
			"box",
			"boxes",
			"circle",
			"flag",
			"greeting",
			"integer",
			"labelled",
			"maybe",
			"maybes",
			"names",
			"point",
			"present",
			"rational",
			"shape",
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

	it("refuses a callback", () => {
		let signature = module.surface.values.integer as common.Type

		expect(
			marshalError(() => marshaller.fromJS(() => 1, signature)).message,
		).toContain("callbacks are not supported yet")
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
