import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { fixturePath } from "@essence-lang/fixtures"
import type { common } from "@essence-lang/interfaces"

import type { EssenceValue } from "../bridge"
import { describeModule, describeSignature } from "../descriptor"
import { EssenceCallError, EssenceMarshalError } from "../errors"
import { type EssenceModule, loadModule } from "../index"
import { createInterpreter, type EssenceFunction } from "../marshal-runtime"

let cacheDirectory = ""
let absence: EssenceModule
let calls: EssenceModule
let geometry: EssenceModule
let main: EssenceModule
let marshal: EssenceModule
let math: EssenceModule

beforeAll(async () => {
	cacheDirectory = realpathSync.native(
		mkdtempSync(path.join(tmpdir(), "essence-bind-")),
	)
	absence = await loadModule(
		path.join(import.meta.dirname, "files", "Absence.es"),
		{ cacheDirectory },
	)
	calls = await loadModule(
		path.join(import.meta.dirname, "files", "Calls.es"),
		{ cacheDirectory },
	)
	geometry = await loadModule(fixturePath("modules", "Geometry.es"), {
		cacheDirectory,
	})
	// NOTE: The `modules` fixture prints three lines as its body runs, and
	// importing the bundle is what runs it — so it is loaded with both doors of
	// the terminal held shut rather than into the middle of this run's output.
	main = await withoutOutput(() =>
		loadModule(fixturePath("modules", "Main.es"), { cacheDirectory }),
	)
	marshal = await loadModule(
		path.join(import.meta.dirname, "files", "Marshal.es"),
		{ cacheDirectory },
	)
	math = await loadModule(fixturePath("modules", "math", "Math.es"), {
		cacheDirectory,
	})
})

async function withoutOutput<Result>(
	work: () => Promise<Result>,
): Promise<Result> {
	let originalLog = console.log
	let originalWrite = process.stdout.write

	console.log = () => {}
	process.stdout.write = (() => true) as typeof process.stdout.write

	try {
		return await work()
	} finally {
		console.log = originalLog
		process.stdout.write = originalWrite
	}
}

afterAll(() => {
	rmSync(cacheDirectory, { recursive: true, force: true })
})

type AnyCall = (...args: Array<unknown>) => unknown

// NOTE: The exports as a host writes them — `unknown` is the honest Type for a
// Module whose shape is only known once it is compiled, and every test below
// says what it expects of a name by using it.
function exported(module: EssenceModule, name: string): AnyCall {
	return module.exports[name] as AnyCall
}

// NOTE: A Choice reaches a host as an object of constructors — under a
// Namespace's name where the Module wrote one, and under its own where it did
// not. Both are read the same way.
function choice(module: EssenceModule, name: string): Record<string, unknown> {
	return module.exports[name] as Record<string, unknown>
}

function namespaceOf(
	module: EssenceModule,
	name: string,
): Record<string, unknown> {
	return module.exports[name] as Record<string, unknown>
}

function method(
	module: EssenceModule,
	namespace: string,
	name: string,
): AnyCall {
	return namespaceOf(module, namespace)[name] as AnyCall
}

function callError(work: () => unknown): EssenceCallError {
	let thrown: unknown = null

	try {
		work()
	} catch (error) {
		thrown = error
	}

	expect(thrown).toBeInstanceOf(EssenceCallError)

	return thrown as EssenceCallError
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

describe("Calling a Function", () => {
	it("marshals both ways around the call", () => {
		expect(exported(math, "square")(12n)).toBe(144n)
	})

	it("binds a Function under the name its author wrote", async () => {
		let escaped = await loadModule(
			path.join(import.meta.dirname, "files", "Escaped.es"),
			{ cacheDirectory },
		)

		expect(Object.keys(escaped.exports).sort()).toEqual([
			"$$integer",
			"ok?",
		])
		expect(exported(escaped, "ok?")(true)).toBe(true)
	})

	it("takes a Function that answers nothing to take", () => {
		expect(exported(calls, "nothing")()).toBe("nothing")
	})

	it("answers an Optional as the value or nothing", () => {
		expect(exported(calls, "evened")(4n)).toBe(4n)
		expect(exported(calls, "evened")(5n)).toBeUndefined()
	})

	it("answers a Case as its tag and its payload", () => {
		expect(exported(calls, "coloured")("red")).toEqual({
			$case: "Colour#Red",
		})
		expect(exported(calls, "coloured")("blue")).toEqual({
			$case: "Colour#Named",
			name: "blue",
		})
	})

	// NOTE: A Function is the one value that carries no Type tag, so the Type
	// its position declared is what says how it crosses: the answer of a call
	// and a Record member both come back wrapped, callable exactly as the
	// generated declarations spell them — not as the raw emitted Function,
	// which takes tagged values no host holds.
	it("marshals a Function that comes back out of a call", () => {
		let adder = exported(calls, "makeAdder")(5n) as AnyCall

		expect(adder(3n)).toBe(8n)
	})

	it("marshals a Function held by a Record member", () => {
		let handler = calls.exports.handler as { callback: AnyCall }

		expect(handler.callback(4n)).toBe(8n)
	})

	// NOTE: A constant is marshalled where it is READ, so a constant holding a
	// Function wraps a fresh one on every read — and everything a SIGNATURE
	// settles about a call is compiled once against the Descriptor rather than
	// again on each. What is left per crossing is the name an Error calls the
	// Function, which is the position it was met at and not a property of the
	// signature: two crossings of one signature have to keep their own.
	it("names each crossing of one signature by where it was met", () => {
		let interpreter = createInterpreter(
			calls.bridge,
			describeModule(calls.surface, calls.entryPath),
		)
		let signature = describeSignature(
			calls.surface.values.positional as common.BaseFunction,
			{ entryPath: calls.entryPath },
		)
		let target = calls.raw.positional as EssenceFunction
		let here = interpreter.wrapFunction(target, signature, "here")
		let there = interpreter.wrapFunction(target, signature, "there")

		expect(here(10n, 4n)).toBe(6n)
		expect(there(10n, 4n)).toBe(6n)
		expect(callError(() => here(1n)).message).toStartWith("here(")
		expect(callError(() => there(1n)).message).toStartWith("there(")
	})

	// NOTE: And a Function goes the other way as well. What the Module hands a
	// callback are its own values, so they cross OUT to reach it; what the
	// callback answers with is built against the declared return, so it crosses
	// IN. Both halves of the boundary meet at a call site the host wrote.
	it("takes a Function passed into a call", () => {
		expect(
			exported(calls, "applied")(3n, (value: bigint) => value * 2n),
		).toBe(6n)
	})

	// NOTE: Called as many times as the Module calls it, each call its own
	// crossing — a callback is not a value marshalled once and remembered.
	it("takes a Function the Module calls more than once", () => {
		expect(
			exported(calls, "applyTwice")((value: bigint) => value * 3n, 2n),
		).toBe(18n)
	})

	// NOTE: A labelled call passes one the same way it passes anything else.
	it("takes a Function under its label", () => {
		expect(
			exported(
				calls,
				"measured",
			)({
				box: { box: 5n },
				by: (box: { box: bigint }) => box.box + 1n,
			}),
		).toBe(6n)
	})

	it("takes a Function held by a Record member", () => {
		expect(
			exported(
				calls,
				"invoke",
			)({
				callback: (value: bigint) => value + 1n,
			}),
		).toBe(8n)
	})

	// NOTE: The Record the callback is handed is the MODULE's, so it arrives
	// marshalled — a plain object with `bigint` members, not the tagged value the
	// raw door would have passed.
	it("hands a callback the Module's values as JavaScript", () => {
		let seen: Array<unknown> = []

		expect(
			exported(calls, "measured")({ box: 6n }, (box: { box: bigint }) => {
				seen.push(box)

				return box.box * 2n
			}),
		).toBe(12n)
		expect(seen).toEqual([{ box: 6n }])
	})

	// NOTE: Spelled from where the callback ARRIVED, because the Function that
	// answered wrongly is the one the caller passed at that Argument rather than
	// one of the Module's own.
	it("says which callback of which Argument did not fit", () => {
		expect(
			marshalError(() => exported(calls, "applied")(3n, () => "twice"))
				.message,
		).toBe(
			'argument 2 → return value: expected Integer, got the string "twice".',
		)

		expect(
			marshalError(() =>
				exported(calls, "invoke")({ callback: () => undefined }),
			).message,
		).toBe(
			"argument 1 → .callback → return value: expected Integer, got nothing.",
		)
	})

	it("refuses an Argument that is no Function where one is declared", () => {
		expect(
			marshalError(() => exported(calls, "applied")(3n, 4n)).message,
		).toBe("argument 2: expected (_ Integer) -> Integer, got the bigint 4.")
	})

	// NOTE: A Choice is erased — it names Cases, and a Case is a value's Type
	// rather than a value — so the bundle binds nothing under its name and the
	// raw door has nothing to offer. What `exports` offers instead is spelling:
	// one constructor per Case, written on this side.
	it("leaves a Choice off the raw door", () => {
		expect("Shape" in marshal.raw).toBe(false)
		expect("Shape" in marshal.exports).toBe(true)
	})

	it("binds every name the bundle binds, and the Choices beside them", () => {
		expect(Object.keys(marshal.exports)).toEqual([
			"Direction",
			"Shape",
			"Sign",
			"Styled",
			"Vertical",
			...Object.keys(marshal.raw),
		])

		// NOTE: `namespace Colour for Colour` binds a name of its own, so the
		// two doors hold the same names and the Cases are members of that one.
		expect(Object.keys(calls.exports)).toEqual(Object.keys(calls.raw))
	})
})

describe("A Choice", () => {
	// NOTE: The `$case` a constructor writes is the one `toJS` writes, so a
	// value spelled here and a value that came back out of the Module are the
	// same object — which is what makes `areaOf(Shape.Circle({ radius: 3n }))`
	// work without a word about tags.
	it("spells a Case with a payload as a call", () => {
		let shape = choice(marshal, "Shape").Circle as AnyCall

		expect(shape({ radius: 3n })).toEqual({
			$case: "Shape#Circle",
			radius: 3n,
		})
		expect(exported(marshal, "areaOf")(shape({ radius: 3n }))).toBe(9n)
	})

	// NOTE: And a Case with no payload as the value itself. There is nothing to
	// pass, so a call would exist only to look like the others.
	it("spells a Case with no payload as a value", () => {
		expect(choice(marshal, "Shape").Blank).toEqual({ $case: "Shape#Blank" })
		expect(
			exported(marshal, "areaOf")(choice(marshal, "Shape").Blank),
		).toBe(0n)
	})

	// NOTE: And a Case of a UNIT Choice as the string it crosses as, so the
	// constructor and what a host would have written by hand are the very same
	// value. What the name is worth there is a place to read the Cases off and
	// a misspelling caught by the generated declaration, rather than a wrapper
	// around anything: `Direction.Up` and `"Up"` are one value, not two
	// spellings of one.
	it("spells a Case of a unit Choice as the string it crosses as", () => {
		expect(choice(marshal, "Direction")).toEqual({
			Up: "Up",
			Down: "Down",
		})
		expect(
			exported(marshal, "direction")(choice(marshal, "Direction").Up),
		).toBe("Up")
	})

	// NOTE: One name binds one thing, and `namespace Colour for Colour` is how a
	// Choice is given its Methods — so the constructors ride on the Namespace
	// rather than taking the name away from it.
	it("hands its constructors to the Namespace of its own name", () => {
		let colour = choice(calls, "Colour")

		expect(colour.Red).toEqual({ $case: "Colour#Red" })
		expect((colour.Named as AnyCall)({ name: "blue" })).toEqual({
			$case: "Colour#Named",
			name: "blue",
		})
		expect((colour.preferred as AnyCall)()).toEqual({ $case: "Colour#Red" })
	})

	// NOTE: A Type Alias for a Choice is the same Union, and gets no
	// constructors of its own: a value built through one would say `Shape#Circle`
	// while the name that offered it said something else, and one set of
	// constructors reached through two names is a second thing to keep true.
	it("is spelled under its own name alone", () => {
		expect("Label" in marshal.exports).toBe(false)
	})
})

// NOTE: `Optional` is the one Choice spelled by ABSENCE rather than by a
// `$case`, and an unannotated `constant present = #Value(3)` is inferred as one
// of its Cases ALONE rather than as the Union an annotation would have named —
// so the lone Case is a shape the boundary meets, and it has to read as the
// item itself in every position it appears in. The way in, the way out and the
// generated declarations each carry that rule, and this is where they are held
// to saying the same thing.
describe("One of Optional's own Cases met alone", () => {
	it("reads a lone #Value as the item and a lone #Empty as nothing", () => {
		expect(absence.exports.present).toBe(3n)
		expect(absence.exports.nought).toBeUndefined()
	})

	it("reads it the same way inside every shape it is nested in", () => {
		expect(absence.exports.boxed).toEqual({ held: 3n })
		expect(absence.exports.listed).toEqual([3n, 4n])
	})

	// NOTE: The two doors of one Marshaller, on the same value: the walk the
	// VALUE directs, which has no Descriptor to consult, and the reader compiled
	// out of the one the Module declared. A shape only one of them has a rule for
	// is a shape a round trip can not survive.
	it("reads the same with the Type declared and without it", () => {
		let marshaller = absence.marshaller
		let raw = absence.raw as Record<string, EssenceValue>
		let declared = absence.surface.values.present as common.Type

		expect(marshaller.toJS(raw.present, "present")).toBe(3n)
		expect(marshaller.toJS(raw.present, "present", declared)).toBe(3n)
		expect(
			marshaller.toJS(marshaller.fromJS(3n, declared), "present"),
		).toBe(3n)
	})
})

describe("A labelled call", () => {
	// NOTE: Both, and they mean the same call. Essence writes the labels at
	// every call site, so a boundary that only took positions would drop the one
	// thing the Declaration insisted on.
	it("takes the labels or the positions", () => {
		expect(exported(calls, "labelled")(10n, 4n)).toBe(6n)
		expect(exported(calls, "labelled")({ first: 10n, second: 4n })).toBe(6n)
	})

	// NOTE: The keys are a set, not a sequence — an object literal's order is
	// the caller's business and never the Declaration's.
	it("reads the labels in the order the Function takes them", () => {
		expect(exported(calls, "labelled")({ second: 4n, first: 10n })).toBe(6n)
	})

	it("is not offered where a Parameter carries no label", () => {
		// NOTE: `square(_ value: Integer)` — its one Parameter is written `_`,
		// so `{ value: … }` is an object handed to an Integer and nothing else.
		let error = marshalError(() => exported(math, "square")({ value: 12n }))

		expect(error.message).toBe(
			"argument 1: expected Integer, got an object with 'value'.",
		)

		// NOTE: And half a set of labels is not a set of labels: `mixed` takes
		// `_ first` and `second`, so the object is one positional Argument.
		expect(
			callError(() =>
				exported(calls, "mixed")({ first: 10n, second: 4n }),
			).message,
		).toContain("takes 2 Arguments; 1 Argument was passed.")
	})

	// NOTE: THE ambiguity, and it is decided rather than guessed at: both
	// readings take an object, and a Record is the one that can hold any shape,
	// so the Record wins. `describe(_ shape: Rectangle)` is written with `_`
	// anyway; `moved` proves it holds where a label is written too.
	it("loses to a single Record Parameter", () => {
		expect(exported(main, "describe")({ width: 3n, height: 4n })).toBe(
			"area: 12",
		)
		expect(exported(calls, "moved")({ x: 1n, y: 2n })).toEqual({
			x: 1n,
			y: 2n,
		})
	})

	// NOTE: And to a single Parameter a Record merely CAN inhabit — the Box arm
	// of a Union, the Box inside an Optional. Read as a labelled call, the
	// object would be unwrapped to its one member and the Module silently
	// handed the wrong value.
	it("loses to a single Parameter a Record can inhabit", () => {
		expect(exported(calls, "boxed")({ box: 5n })).toEqual({ box: 5n })
		expect(exported(calls, "boxed")(5n)).toBe(5n)
		expect(exported(calls, "measure")({ box: 5n })).toEqual({ box: 5n })
		expect(exported(calls, "measure")(undefined)).toBeUndefined()
	})

	it("names the Argument that failed by its label", () => {
		expect(
			marshalError(() =>
				exported(calls, "labelled")({ first: 10n, second: "four" }),
			).path,
		).toBe("argument 'second'")
		expect(
			marshalError(() => exported(calls, "labelled")(10n, "four")).path,
		).toBe("argument 2")
	})
})

describe("A call the Function does not admit", () => {
	it("names the signature and both ways of writing it", () => {
		let error = callError(() => exported(calls, "labelled")(1n))

		expect(error.name).toBe("EssenceCallError")
		expect(error.message).toBe(
			"labelled(first: Integer, second: Integer) -> Integer takes 2 Arguments positionally, or one object with the labels 'first', 'second'; 1 Argument was passed.",
		)
	})

	// NOTE: An object handed to a Function of two Parameters was meant to be a
	// labelled call, so it is answered as one — "takes 2 Arguments, 1 was
	// passed" would be true and useless.
	it("says which label is wrong rather than counting Arguments", () => {
		expect(
			callError(() =>
				exported(calls, "labelled")({ first: 1n, third: 2n }),
			).message,
		).toBe(
			"labelled(first: Integer, second: Integer) -> Integer takes 2 Arguments positionally, or one object with the labels 'first', 'second'. It was passed one object with 'first', 'third'.",
		)
	})

	it("refuses an Argument to a Function that takes none", () => {
		expect(callError(() => exported(calls, "nothing")(1n)).message).toBe(
			"nothing() -> String takes 0 Arguments; 1 Argument was passed.",
		)
	})
})

describe("A Namespace", () => {
	it("binds its static Methods as an object of Functions", () => {
		expect(Object.keys(namespaceOf(geometry, "Rectangle"))).toEqual(["of"])
		expect(method(geometry, "Rectangle", "of")(3n, 4n)).toEqual({
			width: 3n,
			height: 4n,
		})
		expect(
			method(geometry, "Rectangle", "of")({ width: 3n, height: 4n }),
		).toEqual({ width: 3n, height: 4n })
	})

	// NOTE: There is no `::` on this side, so the receiver is written where a
	// call passes it — first. The Export Surface already carries it as Parameter
	// one, typed as the Namespace's target.
	it("takes an instance Method's receiver as its first Argument", () => {
		let rectangle = { width: 3n, height: 4n }

		expect(method(geometry, "RectangleMeasurable", "area")(rectangle)).toBe(
			12n,
		)
		expect(
			method(geometry, "RectangleMeasurable", "perimeter")(rectangle),
		).toBe(14n)
		expect(method(calls, "Point", "shifted")({ x: 1n, y: 2n }, 3n)).toEqual(
			{ x: 4n, y: 5n },
		)
	})

	// NOTE: The receiver is written `_`, so no instance Method is ever callable
	// by label — `shifted(by amount: Integer)` reads as one label out of two.
	it("offers no labelled call for an instance Method", () => {
		expect(
			callError(() => method(calls, "Point", "shifted")({ by: 3n }))
				.message,
		).toBe(
			"Point.shifted(_ { x: Integer, y: Integer }, by: Integer) -> { x: Integer, y: Integer } takes 2 Arguments; 1 Argument was passed.",
		)
	})

	it("binds a static Property as a value", () => {
		expect(namespaceOf(calls, "Point").named).toBe("Point")
	})

	// NOTE: A class refuses a static member named `prototype` or `constructor`,
	// so the Rewriter mangles the two — reading them raw would answer with the
	// class-prototype object and `Function` instead.
	it("binds the two member names a class refuses", () => {
		expect(namespaceOf(calls, "Point")["constructor"]).toBe(5n)
		expect(method(calls, "Point", "prototype")({ x: 7n, y: 2n })).toBe(7n)
	})

	it("takes a Method that takes nothing", () => {
		expect(method(calls, "Point", "origin")()).toEqual({ x: 0n, y: 0n })
	})

	// NOTE: `Rectangle` is a Type Alias AND the Namespace of that name, so its
	// kind reads `type` while it is a value in the bundle. Binding by kind would
	// have left it out.
	it("is bound although its kind reads as a Type", () => {
		expect(geometry.surface.kinds.Rectangle).toBe("type")
		expect(typeof method(geometry, "Rectangle", "of")).toBe("function")
	})
})

describe("An overloaded Method", () => {
	it("refuses the call and says where its Overloads are", () => {
		let error = callError(() => method(calls, "Point", "from")(1n))

		expect(error.message).toContain("'Point.from' is overloaded")
		expect(error.message).toContain(
			"Point.from__overload$1(x: Integer) -> { x: Integer, y: Integer }",
		)
		expect(error.message).toContain(
			"Point.from__overload$2(x: Integer, y: Integer) -> { x: Integer, y: Integer }",
		)
	})

	// NOTE: An instance Overload's signature carries the receiver it is emitted
	// with, because that is the Argument the caller has to pass.
	it("lists an instance Overload with its receiver", () => {
		expect(
			callError(() =>
				method(calls, "Point", "grown")({ x: 1n, y: 2n }, 3n),
			).message,
		).toContain(
			"Point.grown__overload$1(_ { x: Integer, y: Integer }, _ Integer) -> { x: Integer, y: Integer }",
		)
	})

	// NOTE: The refusal is about `exports`, which promises ONE Function per
	// name. Each Overload is a binding of its own and stays reachable.
	it("leaves every Overload callable through the raw Namespace", () => {
		let namespace = calls.raw.Point as Record<string, unknown>
		let from = namespace.from__overload$2 as (
			...args: Array<EssenceValue>
		) => EssenceValue

		expect(
			calls.marshaller.toJS(
				from(calls.bridge.integer(1n), calls.bridge.integer(2n)),
			),
		).toEqual({ x: 1n, y: 2n })
	})
})
