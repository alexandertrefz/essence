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
let async: EssenceModule

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
	async = await loadModule(asyncFixture, { cacheDirectory })
})

const asyncFixture = path.join(import.meta.dirname, "files", "Async.es")

afterAll(() => {
	rmSync(cacheDirectory, { recursive: true, force: true })
})

// The Module's own Types, read off its Export Surface.
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

// A JavaScript value in through the Module's identity Function, and back out.
function through(name: string, value: unknown): unknown {
	let callee = module.raw[name] as (
		...args: Array<EssenceValue>
	) => EssenceValue

	return marshaller.toJS(
		callee(marshaller.fromJS(value, parameterType(name), "argument 1")),
		"return value",
	)
}

// The same round trip through `exports`, compiled against the declared return.
// For a unit Choice the two agree for different reasons, so both are called.
function called(name: string, ...args: Array<unknown>): unknown {
	return (module.exports[name] as (...args: Array<unknown>) => unknown)(
		...args,
	)
}

// A temporary project, for a test that needs a Module graph.
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

// The test's own wait. Set after the Module's timer, it expires after it, so
// a stopped run has visibly not finished.
function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

// Whether a promise has settled. Stopped work never does, since a Future can
// not fail.
function settlingOf(promise: Promise<unknown>): () => boolean {
	let settled = false

	promise.then(
		() => {
			settled = true
		},
		() => {
			settled = true
		},
	)

	return () => settled
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
		// A safe integer number comes back as a bigint.
		expect(through("integer", 42)).toBe(42n)
		expect(through("integer", -9007199254740991n)).toBe(-9007199254740991n)
	})

	it("carries a Rational as its two parts", () => {
		let third = through("rational", new EssenceRational(1n, 3n))

		expect(third).toBeInstanceOf(EssenceRational)
		expect((third as EssenceRational).toString()).toBe("1/3")

		// Reduced, with the sign on the numerator, as the runtime does.
		expect(
			(
				through(
					"rational",
					new EssenceRational(2n, -4n),
				) as EssenceRational
			).toString(),
		).toBe("-1/2")
		expect((through("rational", 5n) as EssenceRational).toString()).toBe(
			"5",
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

	// An absent key reads as `undefined`, so an `Optional` member may be left
	// off, as `JSON.stringify` leaves it.
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

	// A member that is not Optional may not.
	it("still refuses a Record with a member that is not Optional left off", () => {
		expect(marshalError(() => through("box", { width: 3n })).message).toBe(
			"argument 1 → .height: expected Integer, got nothing.",
		)
	})

	it("carries an Optional as the value or nothing", () => {
		expect(through("maybe", 7n)).toBe(7n)
		expect(through("maybe", undefined)).toBeUndefined()
		// `null` is admitted, since JSON has no `undefined`.
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

	// A payload is built in the order its Case declares, whatever order the
	// host wrote, as the compiled Program builds one.
	it("builds a payload in the order its Case declares", () => {
		let crossed = through("shape", {
			height: 4n,
			$case: "Shape#Rect",
			width: 3n,
		}) as Record<string, unknown>

		expect(Object.keys(crossed).filter((key) => key !== "$case")).toEqual([
			"width",
			"height",
		])
	})

	it("carries a payload-less Case of a mixed Choice", () => {
		expect(through("shape", { $case: "Shape#Blank" })).toEqual({
			$case: "Shape#Blank",
		})
	})

	// A `Result` is an ordinary Choice with a `$case`, since `undefined` has no
	// room for a reason.
	it("carries a Result as an ordinary Choice, not as absence", () => {
		expect(through("result", { $case: "Result#Value", item: 3n })).toEqual({
			$case: "Result#Value",
			item: 3n,
		})
		expect(
			through("result", { $case: "Result#Failure", reason: "gone" }),
		).toEqual({ $case: "Result#Failure", reason: "gone" })
	})

	// As the Essence source writes it.
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

	// An absent `toString` must not be found on `Object.prototype`.
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

	// A List added to at both ends, and one another List grew from. See "List
	// boxes" in DEVELOPMENT.md.
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

	// The Module matches on the value, so it must be a real one.
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

// A Dictionary crosses as a `Map` at every key Type, keeping its order.
describe("A Dictionary", () => {
	it("carries its entries as a Map, in the order it holds them", () => {
		let ages = through(
			"ages",
			new Map([
				["alex", 39n],
				["sam", 25n],
			]),
		)

		expect(ages).toBeInstanceOf(Map)
		expect([...(ages as Map<string, bigint>)]).toEqual([
			["alex", 39n],
			["sam", 25n],
		])
		expect([
			...(through("ages", new Map()) as Map<string, bigint>),
		]).toEqual([])
	})

	// Each key is spelled as its Type is everywhere else.
	it("carries a key of every kind the boundary spells", () => {
		expect([
			...(through(
				"counts",
				new Map<bigint | number, string>([
					[1n, "one"],
					[2, "two"],
				]),
			) as Map<bigint, string>),
		]).toEqual([
			[1n, "one"],
			[2n, "two"],
		])
		expect([
			...(through("flags", new Map([[true, "yes"]])) as Map<
				boolean,
				string
			>),
		]).toEqual([[true, "yes"]])
		expect([
			...(through("headings", new Map([["Up", 1n]])) as Map<
				string,
				bigint
			>),
		]).toEqual([["Up", 1n]])

		let shares = [
			...(through(
				"shares",
				new Map([[new EssenceRational(1n, 3n), "third"]]),
			) as Map<EssenceRational, string>),
		]

		expect(shares).toHaveLength(1)
		expect(shares[0]![0].toString()).toBe("1/3")
		expect(shares[0]![1]).toBe("third")
	})

	// An object key comes back as a fresh object, so it is iterated rather than
	// looked up.
	it("carries an object key for iterating rather than for looking up", () => {
		let plots = through("plots", new Map([[{ width: 1n, height: 2n }, 3n]]))

		expect([...(plots as Map<unknown, bigint>)]).toEqual([
			[{ width: 1n, height: 2n }, 3n],
		])
		expect(
			(plots as Map<unknown, bigint>).get({ width: 1n, height: 2n }),
		).toBeUndefined()
		expect([
			...(through(
				"outlines",
				new Map([[{ $case: "Shape#Circle", radius: 2n }, 1n]]),
			) as Map<unknown, bigint>),
		]).toEqual([[{ $case: "Shape#Circle", radius: 2n }, 1n]])
	})

	it("carries one a Record, a List and an Optional hold", () => {
		expect(through("ledger", { entries: new Map([["a", 1n]]) })).toEqual({
			entries: new Map([["a", 1n]]),
		})
		expect(through("ledgers", [new Map([["a", 1n]])])).toEqual([
			new Map([["a", 1n]]),
		])
		expect(through("maybeAges", undefined)).toBeUndefined()
		expect(through("maybeAges", new Map([["a", 1n]]))).toEqual(
			new Map([["a", 1n]]),
		)
	})

	it("carries a Dictionary of Dictionaries", () => {
		expect(
			through("nesting", new Map([["a", new Map([["b", 1n]])]])),
		).toEqual(new Map([["a", new Map([["b", 1n]])]]))
	})

	// A Dictionary shares a store with other boxes, as
	// `packages/runtime/src/Dictionary.ts` lays it out. What crosses is what this
	// box holds.
	it("carries what the box holds, not what its store does", () => {
		expect([
			...(through(
				"edited",
				new Map([
					["dropped", 1n],
					["kept", 2n],
				]),
			) as Map<string, bigint>),
		]).toEqual([
			["kept", 2n],
			["added", 9n],
		])
	})

	// A refinement crosses as its base, unproven, so an empty Map is taken.
	it("takes a refined Dictionary unproven, as every refinement crosses", () => {
		expect(through("filled", new Map())).toEqual(new Map())
		expect(through("filled", new Map([["a", 1n]]))).toEqual(
			new Map([["a", 1n]]),
		)
	})

	// A plain object is refused with the shape to write instead.
	it("refuses a plain object and says what to write instead", () => {
		expect(marshalError(() => through("ages", { alex: 39n })).message).toBe(
			"argument 1: expected Dictionary<String, Integer>, which crosses as a Map rather than as a plain object — 'new Map(Object.entries(…))' builds one.",
		)
	})

	// Two Map keys the language calls equal are refused: an Integer's two
	// forms, an Integer and its whole Rational, and a String's two spellings.
	it("refuses two entries whose keys are one key", () => {
		expect(
			marshalError(() =>
				through(
					"counts",
					new Map<bigint | number, string>([
						[1n, "one"],
						[1, "again"],
					]),
				),
			).message,
		).toBe(
			"argument 1 → [1].key: this key is already held — a Map tells its keys apart by '===' where a Dictionary tells them apart by the key Type's own equality, so two entries of this Map are one entry of it.",
		)
		expect(
			marshalError(() =>
				through(
					"ages",
					new Map([
						["caf\u00e9", 1n],
						["cafe\u0301", 2n],
					]),
				),
			).path,
		).toBe("argument 1 → [1].key")
	})

	it("spells where inside an entry a value was wrong", () => {
		expect(
			marshalError(() => through("ages", new Map([["alex", "39"]])))
				.message,
		).toBe('argument 1 → [0].value: expected Integer, got the string "39".')
		expect(
			marshalError(() => through("ages", new Map([[3n, 39n]]))).message,
		).toBe("argument 1 → [0].key: expected String, got the bigint 3.")
	})

	it("names a Map for what it is where another shape was wanted", () => {
		expect(marshalError(() => through("box", new Map())).message).toBe(
			"argument 1: expected { width: Integer, height: Integer }, got an empty Map.",
		)
		expect(
			marshalError(() => through("box", new Map([["width", 1n]])))
				.message,
		).toBe(
			"argument 1: expected { width: Integer, height: Integer }, got a Map of 1 entry.",
		)
	})

	// A Namespace's own `is` that calls no keys equal lets a Dictionary hold
	// two keys that are one string. A Map would drop one, so it is refused.
	it("refuses a Dictionary whose keys are one JavaScript value", async () => {
		await withProject(
			{
				"Main.es": `implementation {
	§ No two keys are ever one key, however they are spelled.
	namespace Apart for NonEmptyString is Equatable {
		is(_ other: NonEmptyString) -> Boolean {
			<- false
		}
	}

	constant first: NonEmptyString  = "Ada"
	constant second: NonEmptyString = "Ada"

	function twice() -> Dictionary<NonEmptyString, Integer> {
		<- Dictionary.of([
			{ key = first, value = 1 },
			{ key = second, value = 2 },
		])
	}
}

export {
	twice
}
`,
			},
			async (directory) => {
				let project = await loadModule(
					path.join(directory, "Main.es"),
					{ cacheDirectory },
				)
				let twice = project.exports.twice as () => unknown

				expect(marshalError(() => twice()).message).toBe(
					"return value: this Dictionary's 2 keys are 1 JavaScript value — a Map tells its keys apart by '===' where the Module tells them apart by the key Type's own 'is', so a Map of it would not hold them all.",
				)
			},
		)
	})

	// With no Type, each entry is read by what it says it is.
	it("crosses with nothing declared at all", () => {
		expect(marshaller.toJS(module.raw.sizes)).toEqual(
			new Map([
				["small", 1n],
				["large", 2n],
			]),
		)
	})
})

// The door question covers exported Types, so a Dictionary named only in one
// still gets its door.
describe("A Dictionary the boundary names only in a Type", () => {
	it("crosses against the declared Type it was published under", async () => {
		await withProject(
			{
				"Ledger.es": `implementation {
	type Ledger = { entries: Dictionary<String, Integer> }

	function count() -> Integer {
		<- 1
	}
}

export {
	Ledger
	count
}
`,
			},
			async (directory) => {
				let ledger = await loadModule(
					path.join(directory, "Ledger.es"),
					{ cacheDirectory },
				)
				let crossed = ledger.marshaller.fromJS(
					{ entries: new Map([["alex", 39n]]) },
					ledger.surface.types.Ledger!,
					"argument 1",
				)
				let entries = (crossed as Record<string, unknown>).entries

				expect(ledger.marshaller.toJS(entries, "value")).toBeInstanceOf(
					Map,
				)
				expect([
					...(ledger.marshaller.toJS(entries, "value") as Map<
						string,
						bigint
					>),
				]).toEqual([["alex", 39n]])
			},
		)
	})
})

// A Record member no Type names may hold a Dictionary with no door. The
// refusal must not blame another compile.
describe("A Dictionary at a position the boundary does not name", () => {
	it("is refused with the reason the bundle has no door", async () => {
		await withProject(
			{
				"Widen.es": `implementation {
	function widened() -> { width: Integer } {
		<- { width = 1, extra = ["a" = 1] }
	}
}

export {
	widened
}
`,
			},
			async (directory) => {
				let widen = await loadModule(path.join(directory, "Widen.es"), {
					cacheDirectory,
				})
				let error = marshalError(() =>
					(widen.exports.widened as () => unknown)(),
				)

				expect(error.message).toContain(
					"this bundle carries no Dictionary door",
				)
				expect(error.message).toContain(
					"it was built for a boundary that declares none",
				)
				expect(error.message).not.toContain("different compiles")
			},
		)
	})
})

// A unit Choice's Case crosses as its bare name, `"Up"`, in both directions.
describe("A unit Choice", () => {
	it("carries each of its Cases as the bare name", () => {
		expect(called("direction", "Up")).toBe("Up")
		expect(called("direction", "Down")).toBe("Down")
	})

	// The qualified name goes in too, and the bare one comes out.
	it("takes a Case by its qualified name as well", () => {
		expect(called("direction", "Direction#Up")).toBe("Up")
	})

	// The standard library's `Ordering`, which every `compare` answers.
	it("carries the standard library's Ordering", () => {
		expect(called("ordering", "Less")).toBe("Less")
		expect(called("ordering", "Ordering#Greater")).toBe("Greater")
	})

	// Inside an `Optional`, a string is a Case and `undefined` the absence.
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

	// `Shape` has a payload, so even its `#Blank` is an object.
	it("leaves a payload-less Case of a mixed Choice alone", () => {
		expect(called("shape", { $case: "Shape#Blank" })).toEqual({
			$case: "Shape#Blank",
		})
		expect(marshalError(() => called("shape", "Blank")).message).toBe(
			'argument 1: expected Shape, got the string "Blank".',
		)
	})

	// The object form is refused, with the string to write instead.
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

	// With nothing declared, the Module's table says which Cases are strings,
	// so `toJS` agrees with `fromJS`.
	it("crosses as the same string with nothing declared", () => {
		let up = module.bridge.case("./Marshal.es#Direction#Up")

		expect(marshaller.toJS(up)).toBe("Up")
		expect(marshaller.toJS(up, "value", returnType("direction"))).toBe("Up")
		expect(through("direction", marshaller.toJS(up))).toBe("Up")
	})
})

// A Union whose bare Cases collide is refused. See "Bare Cases" in
// DEVELOPMENT.md.
describe("A position two spellings would collide in", () => {
	// The way out of a refused position. The way in refuses before any call,
	// so a round trip never reaches it.
	function refusedOut(name: string, value: unknown): EssenceMarshalError {
		return marshalError(() =>
			marshaller.toJS(value, "return value", returnType(name)),
		)
	}

	function up(): EssenceValue {
		return module.bridge.case("./Marshal.es#Direction#Up")
	}

	// A bare Case beside a String, refused with one sentence in both
	// directions.
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

	// Two Choices' `#Up` are spelled alike.
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

	// Unit Choices sharing no Case name are fine.
	it("takes two unit Choices sharing no Case name", () => {
		expect(called("directionOrSign", "Up")).toBe("Up")
		expect(called("directionOrSign", "Minus")).toBe("Minus")
	})

	// A Choice with a payload crosses as objects, which no string is.
	it("takes a unit Choice beside one that keeps the object form", () => {
		expect(called("directionOrShape", "Up")).toBe("Up")
		expect(called("directionOrShape", { $case: "Shape#Blank" })).toEqual({
			$case: "Shape#Blank",
		})
	})

	// An `Optional` beside or around a collision hides nothing, since its item
	// stands in the position. Its own `undefined` collides with nothing.
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
				// The absence still crosses.
				expect(wrapped(undefined)).toBeUndefined()
			},
		)
	})

	// The refusal comes when a value crosses, not at binding, so every other
	// export still works.
	it("still binds the Module and every other name in it", () => {
		expect(typeof module.exports.directionOrText).toBe("function")
		expect(typeof module.exports.directionOrVertical).toBe("function")
		expect(called("direction", "Up")).toBe("Up")
		expect(module.exports.answer).toBe(42n)
	})
})

describe("Numbers", () => {
	// What `0.1` holds, not `1/10`.
	it("reads a double's exact dyadic value", () => {
		expect(EssenceRational.fromNumber(0.1).toString()).toBe(
			"3602879701896397/36028797018963968",
		)
		expect(EssenceRational.fromNumber(0.5).toString()).toBe("1/2")
		expect(EssenceRational.fromNumber(-0.75).toString()).toBe("-3/4")
		// A whole value prints its numerator alone.
		expect(EssenceRational.fromNumber(0).toString()).toBe("0")
		expect(EssenceRational.fromNumber(3).toString()).toBe("3")
		expect(EssenceRational.fromNumber(3).denominator).toBe(1n)
	})

	// A subnormal has no implicit leading bit, the case the reading special-cases.
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
		// Parts too large for a double still give the magnitude, not `NaN`.
		expect(
			new EssenceRational(10n ** 400n, 3n * 10n ** 400n).toNumber(),
		).toBeCloseTo(1 / 3, 15)
	})

	// Pairs that a division of rounded parts lands an ulp off, and one whose
	// subnormal answer a 53-bit intermediate would round twice.
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

	// A huge denominator gives a subnormal answer, rounded once to a multiple
	// of `2 ** -1074`. See "Rounding a Rational to a double" in DEVELOPMENT.md.
	it("answers a small Rational with a huge denominator exactly", () => {
		expect(new EssenceRational(1n, 2n ** 1024n).toNumber()).toBe(2 ** -1024)
		expect(new EssenceRational(-1n, 2n ** 1024n).toNumber()).toBe(
			-(2 ** -1024),
		)
		// The smallest double, and the first value under it.
		expect(new EssenceRational(1n, 2n ** 1074n).toNumber()).toBe(
			Number.MIN_VALUE,
		)
		expect(new EssenceRational(1n, 2n ** 1100n).toNumber()).toBe(0)
		// At the other end, `Infinity` is the right answer.
		expect(new EssenceRational(2n ** 2000n, 3n).toNumber()).toBe(Infinity)
		expect(new EssenceRational(2n ** 1200n, 2n ** 1199n).toNumber()).toBe(2)
	})

	it("refuses a denominator of zero and a number that is not finite", () => {
		expect(() => new EssenceRational(1n, 0n)).toThrow(RangeError)
		expect(() => EssenceRational.fromNumber(Number.NaN)).toThrow(RangeError)
		expect(() => EssenceRational.fromNumber(Infinity)).toThrow(RangeError)
	})

	// Safe integer parts are taken as numbers.
	it("takes whole numbers as the parts they are", () => {
		expect(new EssenceRational(1, 2).toString()).toBe("1/2")
		expect(new EssenceRational(3).toString()).toBe("3")
		expect(
			new EssenceRational(-4, 8).equals(new EssenceRational(-1n, 2n)),
		).toBe(true)
	})

	// The runtime's `reduced` trusts typed code, so the constructor refuses a
	// part that is not a whole number.
	it("refuses a part that is not a whole number", () => {
		expect(() => new EssenceRational(1.5)).toThrow(TypeError)
		expect(() => new EssenceRational(1n, 2.5)).toThrow(TypeError)
		// A double past 2 ** 53 may already have lost its value.
		expect(() => new EssenceRational(2 ** 53)).toThrow(TypeError)
	})

	// `NaN` and the infinities get the `RangeError` `fromNumber` throws.
	it("refuses a part that is not finite, as 'fromNumber' does", () => {
		expect(() => new EssenceRational(Number.NaN)).toThrow(RangeError)
		expect(() => new EssenceRational(Infinity)).toThrow(RangeError)
		expect(() => new EssenceRational(1n, -Infinity)).toThrow(/finite/)
	})

	// Two numbers would pass `reduced` without a throw and leave number parts,
	// so only the constructor's checks refuse a pair of fractions.
	it("refuses a pair of number parts that are not both whole", () => {
		expect(() => new EssenceRational(Number.NaN, 2)).toThrow(RangeError)
		expect(() => new EssenceRational(0.1, 0.3)).toThrow(TypeError)
		expect(() => new EssenceRational(1.5, 2.5)).toThrow(TypeError)
	})

	it("refuses a part that is no number at all", () => {
		expect(() => new EssenceRational("1" as never)).toThrow(TypeError)
		expect(() => new EssenceRational(1n, {} as never)).toThrow(TypeError)
		expect(() => new EssenceRational(null as never)).toThrow(TypeError)
		expect(() => new EssenceRational(undefined as never)).toThrow(TypeError)
	})

	// The message names `fromNumber`, which answers what a double holds.
	it("names 'fromNumber' where a double was meant", () => {
		expect(() => new EssenceRational(0.1)).toThrow(
			/EssenceRational\.fromNumber/,
		)
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
	// Essence compares Strings normalised. The two spellings are written as code
	// points, so no tool normalising this file erases the difference.
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
		expect(module.exports.sizes).toEqual(
			new Map([
				["small", 1n],
				["large", 2n],
			]),
		)
		expect(module.exports.nothing).toEqual(new Map())
		expect(module.exports.present).toBe(7n)
		expect(module.exports.absent).toBeUndefined()
		expect(module.exports.answered).toEqual({
			$case: "Result#Value",
			item: 7n,
		})
		expect(module.exports.refused).toEqual({
			$case: "Result#Failure",
			reason: "gone",
		})
		// A constant crosses against its declared Type. The unannotated `plus`
		// has the lone Case for a Type and crosses the same way.
		expect(module.exports.heading).toBe("Up")
		expect(module.exports.plus).toBe("Plus")
	})

	// Every Function marshals both ways around its call.
	it("hands back every Function as a JavaScript one", () => {
		expect(typeof module.exports.integer).toBe("function")
		expect(Object.keys(module.exports).sort()).toEqual([
			// The Choices, whose constructors are built on this side.
			"Direction",
			"Shape",
			"Sign",
			"Styled",
			"Vertical",
			"absent",
			"ages",
			"answer",
			"answered",
			"areaOf",
			"blank",
			"box",
			"boxes",
			"branched",
			"card",
			"circle",
			"config",
			"counts",
			"direction",
			"directionOrShape",
			"directionOrSign",
			"directionOrText",
			"directionOrVertical",
			"directions",
			"edited",
			"filled",
			"flag",
			"flags",
			"greeting",
			"grown",
			"heading",
			"headings",
			"integer",
			"labelled",
			"ledger",
			"ledgers",
			"marker",
			"maybe",
			"maybeAges",
			"maybeDirection",
			"maybes",
			"names",
			"nesting",
			"nothing",
			"ordering",
			"outlines",
			"plots",
			"plus",
			"point",
			"present",
			"rational",
			"refused",
			"result",
			"shape",
			"shares",
			"sizes",
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

	// `createInteger` trusts its callers, so the bridge's constructor checks
	// what a host hands it.
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

	// A Function carries no tag, so with nothing declared it passes through.
	it("passes a Function through untouched", () => {
		expect(marshaller.toJS(module.raw.integer)).toBe(module.raw.integer)
	})

	// `undefined` and `null` both mean no Descriptor.
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

	// The path says where inside the value it failed.
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

	// The one arm that got inside the value gives the reason.
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

	// With no arm inside, the Union names itself.
	it("names the Union where no arm reached inside", () => {
		let error = marshalError(() =>
			marshaller.fromJS(true, parameterType("maybe"), "argument 1"),
		)

		expect(error.message).toBe(
			"argument 1: expected Optional<Integer>, got the boolean true.",
		)
	})

	// Refused rather than rounded.
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

	// An Essence value handed in is named as one.
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

	// A callback for `(Integer) -> Integer` gets a `bigint` and answers one.
	it("takes a Function where the Type declares one", () => {
		let signature = module.surface.values.integer as common.Type
		let callback = marshaller.fromJS(
			(value: bigint) => value + 1n,
			signature,
		) as (...args: Array<EssenceValue>) => EssenceValue

		expect(marshaller.toJS(callback(module.bridge.integer(41n)))).toBe(42n)
	})

	// Spelled from where the callback arrived.
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

	// A misspelled payload member is named, as a Record's would be. The Case
	// marks its refusal so the Union keeps it.
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

	// Only the first few keys are named.
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
	// The Export Surface holds applied Aliases substituted.
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

	// The tag is qualified by the declaring Module, relative to the entry.
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

	// A Case from a dependency is spelled relative to the entry's directory, as
	// `./shapes/Shapes.es#Shape#Circle`.
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
	from "./shapes/Shapes.es" { Shape }
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

// What the boundary can not spell is refused in both directions rather than
// answered wrongly.
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

	// `#Value(#Empty)` and `#Empty` would both be `undefined`.
	it("refuses an Optional inside an Optional coming out", () => {
		let error = marshalError(() => refused.exports.deep)

		expect(error.message).toContain(
			"an Optional inside an Optional has no JavaScript spelling",
		)
		// One level is ordinary.
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

	// A payload member called `$case` collides with the tag, so it is refused
	// in both directions.
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

	// The Choice's other Cases are untouched.
	it("still takes a Case of that Choice that does not collide", () => {
		expect(
			(refused.exports.nameOf as (value: unknown) => unknown)({
				$case: "Plain",
			}),
		).toBe("plain")
	})

	// An unmappable constant refuses only itself, when it is read.
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

	// Each read hands out a fresh value, so a push changes no other reader's.
	it("hands out a constant a reader can not corrupt for the next one", () => {
		let names = module.exports.names as Array<string>

		expect(names).toEqual(["a", "b"])

		names.push("MUTATED")

		expect(module.exports.names).toEqual(["a", "b"])
	})
})

// The item Type of a `Leaves.es` Parameter, read off its Surface.
function leafType(name: string): common.Type {
	let signature = leaves.surface.values[name] as common.FunctionType

	return signature.parameterTypes[0]!.type as common.Type
}

// What the boundary did with one value: its answer, or its refusal without the
// path, which the two spellings may differ in. Other Errors compare whole.
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

// A hole is read as `undefined`, and the item's shape decides. See "List
// loops" in DEVELOPMENT.md.
describe("An Array with a hole in it", () => {
	// A hole, not a written `undefined`: `1 in [1, , 3]` is false.
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

	// Where the items admit absence, the hole is `#Empty`.
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

// `runIn` repeats the leaf admissions of `buildIn`, and the two must agree.
// See "List loops" in DEVELOPMENT.md.
describe("A leaf met alone and met inside a List", () => {
	// Not all valid, since the refusals must agree as much as the values.
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
		// Decomposed and composed, since NFC is part of the admission.
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

	// A tagged Integer is an object, which no leaf admits.
	it("refuses one of the Module's own values the same way either way", () => {
		let tagged = leaves.bridge.integer(5n)

		expect(asItem("integers", tagged)).toEqual(asLeaf("integer", tagged))
		expect(asItem("texts", tagged)).toEqual(asLeaf("text", tagged))
	})
})

// Work crosses only as a call's answer, as a `Promise`, and is refused at
// every other position.
describe("Asynchronous work", () => {
	function call(name: string, ...args: Array<unknown>): unknown {
		return (async.exports[name] as (...args: Array<unknown>) => unknown)(
			...args,
		)
	}

	it("answers a call with a promise of what the work answers", async () => {
		let answer = call("doubled", 21n)

		expect(answer).toBeInstanceOf(Promise)
		expect(await answer).toBe(42n)
	})

	// `running` answers a Started, whose promise crosses without a new start.
	it("hands back the promise a run in flight holds", async () => {
		expect(await call("running", 21n)).toBe(42n)
	})

	// What the work answers is marshalled like any value.
	it("marshals what the work answers with", async () => {
		expect(await call("counted", new Map([["a", 1n]]))).toEqual(
			new Map([["a", 1n]]),
		)
	})

	// A callback that answers a Future is called at every start, so
	// `attempted` can run it again after a failure.
	it("calls a host callback at every start", async () => {
		let calls = 0
		let answer = await call("attempted", "key", (key: string) => {
			calls += 1

			return Promise.resolve({
				$case: "Result#Failure",
				reason: `${key} is gone`,
			})
		})

		expect(calls).toBe(2)
		expect(answer).toEqual({
			$case: "Result#Failure",
			reason: "key is gone",
		})
	})

	// Work never started never calls its callback.
	it("never calls a callback whose work is not started", () => {
		let calls = 0

		expect(
			call("shelved", "key", () => {
				calls += 1

				return Promise.resolve("read")
			}),
		).toBe(1n)
		expect(calls).toBe(0)
	})

	// Both directions of a callback, at the start.
	it("marshals both directions of a callback that answers work", async () => {
		expect(
			await call("loaded", "key", (key: string) => Promise.resolve(key)),
		).toBe("key")

		let refused = await (
			call("loaded", "key", () => Promise.resolve(7)) as Promise<unknown>
		).then(
			() => null,
			(thrown: unknown) => thrown,
		)

		expect(refused).toBeInstanceOf(EssenceMarshalError)
		expect((refused as EssenceMarshalError).message).toBe(
			"argument 2 → return value: expected String, got the number 7.",
		)
	})

	// A Promise can not be a Future Argument.
	it("refuses work handed in", () => {
		let refused = marshalError(() => call("ran", Promise.resolve(1n)))

		expect(refused.message).toBe(
			"argument 1: a Future<Integer> can not be built from a JavaScript value — a Promise is an answer that has not arrived, not a description that can be run. Work crosses INTO a Module as a callback declared to answer one, which is called at every start; pass such a Function, or hand the value over.",
		)
	})

	// Nor a List's item.
	it("refuses a List of work", () => {
		expect(
			marshalError(() => call("together", [Promise.resolve(1n)])).message,
		).toContain("argument 1 → [0]: a Future<Integer> can not be built")
	})

	// Nor a Record member.
	it("refuses work inside a value", () => {
		expect(
			marshalError(() => call("queued", { work: Promise.resolve(1n) }))
				.message,
		).toContain("argument 1 → .work: a Future<Integer> can not be built")
	})

	// `nested` answers work that answers work, so the inner one is refused as
	// a rejection of the outer promise.
	it("refuses work a promise answers with", async () => {
		let thrown = await (call("nested", 3n) as Promise<unknown>).then(
			() => null,
			(error: unknown) => error,
		)

		expect(thrown).toBeInstanceOf(EssenceMarshalError)
		expect((thrown as EssenceMarshalError).message).toBe(
			"return value: a Future<Integer> is work rather than a value, and work crosses only as a call's answer — inside a value there is nothing to say when it should run. Answer it from a Function, or complete it and hand the value over.",
		)
	})

	// A constant holding work is refused when read, since no call asked for it.
	it("refuses a constant that holds work", () => {
		expect(marshalError(() => async.exports.work).message).toContain(
			"work: a Future<Integer> is work rather than a value",
		)
	})

	// A `start` nobody waits for must not raise an unhandled rejection, which
	// ends the process under Node and Bun. The host never holds that promise.
	it("keeps a failing run nobody waits for off the host's hook", async () => {
		await withProject(
			{
				"Forget.es": `implementation {
	function forgotten(
		_ key: String,
		using load: (_: String) -> Future<String>,
	) -> Integer {
		start load(key)

		<- 1
	}
}

export {
	forgotten
}
`,
			},
			async (directory) => {
				let project = await loadModule(
					path.join(directory, "Forget.es"),
					{ cacheDirectory },
				)
				let forgotten = project.exports.forgotten as (
					key: string,
					load: (key: string) => unknown,
				) => unknown
				let unhandled: Array<unknown> = []
				let seen = (reason: unknown): void => {
					unhandled.push(reason)
				}

				process.on("unhandledRejection", seen)

				try {
					expect(
						forgotten("key", () =>
							Promise.reject(new Error("gone")),
						),
					).toBe(1n)
					expect(
						forgotten("key", () => {
							throw new Error("gone before it began")
						}),
					).toBe(1n)
					expect(forgotten("key", () => 7)).toBe(1n)

					await delay(20)
				} finally {
					process.off("unhandledRejection", seen)
				}

				expect(unhandled).toEqual([])
			},
		)
	})

	// A Promise is named as one, not as an empty object.
	it("names a Promise handed where a value was declared", () => {
		expect(
			marshalError(() => call("doubled", Promise.resolve(2n))).message,
		).toBe(
			"argument 1: expected Integer, got a Promise, which crosses only where the Module declared a Future.",
		)
	})
})

// A host's `AbortSignal` is the root of every run the boundary starts. Each
// test has its own controller, since an abort can not be undone.
describe("A host's signal", () => {
	function bound(signal: AbortSignal): Promise<EssenceModule> {
		return loadModule(asyncFixture, { cacheDirectory, signal })
	}

	function greeted(module: EssenceModule, after: bigint): Promise<unknown> {
		return (
			module.exports.greeted as (
				name: string,
				after: bigint,
			) => Promise<unknown>
		)("hi", after)
	}

	// A signal never aborted changes nothing.
	it("leaves an unstopped run alone", async () => {
		let module = await bound(new AbortController().signal)

		expect(await greeted(module, 0n)).toBe("hi")
	})

	// A run stopped mid-wait never settles, since a Future can not fail.
	it("stops the runs a call started", async () => {
		let stopping = new AbortController()
		let module = await bound(stopping.signal)
		let settled = settlingOf(greeted(module, 0n))

		stopping.abort()

		await delay(20)

		expect(settled()).toBe(false)
	})

	// Under an aborted signal nothing starts, and the promise never settles.
	it("answers nothing under a signal that is already aborted", async () => {
		let stopping = new AbortController()
		let module = await bound(stopping.signal)

		stopping.abort()

		let settled = settlingOf(greeted(module, 0n))

		await delay(20)

		expect(settled()).toBe(false)
	})

	// `doubled` has nothing to stop partway, so it must not start at all.
	it("runs nothing at all under a signal that is already aborted", async () => {
		let stopping = new AbortController()
		let module = await bound(stopping.signal)

		stopping.abort()

		let settled = settlingOf(
			(module.exports.doubled as (value: bigint) => Promise<unknown>)(
				21n,
			),
		)

		await delay(20)

		expect(settled()).toBe(false)
	})

	// Nor is a host callback called, since there is no start.
	it("calls no host callback under a signal that is already aborted", async () => {
		let stopping = new AbortController()
		let module = await bound(stopping.signal)

		stopping.abort()

		let calls = 0
		let settled = settlingOf(
			(
				module.exports.loaded as (
					key: string,
					load: (key: string) => unknown,
				) => Promise<unknown>
			)("key", (key: string) => {
				calls += 1

				return Promise.resolve(key)
			}),
		)

		await delay(20)

		expect(calls).toBe(0)
		expect(settled()).toBe(false)
	})

	// A Started belongs to whoever started it, so the signal does not stop it.
	it("leaves a run in flight to whoever started it", async () => {
		let stopping = new AbortController()
		let module = await bound(stopping.signal)

		stopping.abort()

		expect(
			await (
				module.exports.running as (value: bigint) => Promise<unknown>
			)(21n),
		).toBe(42n)
	})
})
