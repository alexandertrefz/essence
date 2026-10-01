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
let async: EssenceModule
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
	async = await loadModule(
		path.join(import.meta.dirname, "files", "Async.es"),
		{ cacheDirectory },
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
	// The `modules` fixture prints as its body runs, so it loads with output
	// held back.
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

// An export as `unknown`, since its shape is known only once compiled.
function exported(module: EssenceModule, name: string): AnyCall {
	return module.exports[name] as AnyCall
}

// A Choice's constructors, under its own name or its Namespace's.
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

	// A Function carries no tag, so its declared position wraps it, as a
	// call's answer or a Record member.
	it("marshals a Function that comes back out of a call", () => {
		let adder = exported(calls, "makeAdder")(5n) as AnyCall

		expect(adder(3n)).toBe(8n)
	})

	it("marshals a Function held by a Record member", () => {
		let handler = calls.exports.handler as { callback: AnyCall }

		expect(handler.callback(4n)).toBe(8n)
	})

	// A signature is compiled once, but each crossing keeps the name an Error
	// calls the Function by, which is where it was met.
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

	// A Descriptor and a bundle from two compiles, made by taking the Future
	// door off a bridge. An answer is refused when it comes back, and a callback
	// when it arrives.
	it("says so where the bundle carries no asynchrony door", () => {
		let doorless = { ...async.bridge }

		delete doorless.future
		delete doorless.futureContext
		delete doorless.futureAnswer

		let interpreter = createInterpreter(
			doorless,
			describeModule(async.surface, async.entryPath),
		)
		let context = { entryPath: async.entryPath }
		let doubled = interpreter.wrapFunction(
			async.raw.doubled as EssenceFunction,
			describeSignature(
				async.surface.values.doubled as common.BaseFunction,
				context,
			),
			"doubled",
		)
		let loaded = interpreter.wrapFunction(
			async.raw.loaded as EssenceFunction,
			describeSignature(
				async.surface.values.loaded as common.BaseFunction,
				context,
			),
			"loaded",
		)

		expect(marshalError(() => doubled(21n)).message).toContain(
			"return value: this bundle carries no asynchrony door",
		)
		expect(
			marshalError(() => loaded("key", () => Promise.resolve("read")))
				.message,
		).toContain("argument 2: this bundle carries no asynchrony door")
	})

	// A callback receives values crossing out and answers one crossing in.
	it("takes a Function passed into a call", () => {
		expect(
			exported(calls, "applied")(3n, (value: bigint) => value * 2n),
		).toBe(6n)
	})

	// Each call the Module makes is a crossing of its own.
	it("takes a Function the Module calls more than once", () => {
		expect(
			exported(calls, "applyTwice")((value: bigint) => value * 3n, 2n),
		).toBe(18n)
	})

	// A labelled call passes one the same way it passes anything else.
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

	// The callback gets the Module's Record marshalled, with `bigint` members.
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

	// Spelled from where the callback arrived, which names the Function passed.
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

	// A Choice binds nothing in the bundle, so only `exports` has its
	// constructors.
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

		// `namespace Colour for Colour` binds the name, so both doors hold it.
		expect(Object.keys(calls.exports)).toEqual(Object.keys(calls.raw))
	})
})

describe("A Choice", () => {
	// A constructor writes the `$case` `toJS` writes, so
	// `areaOf(Shape.Circle({ radius: 3n }))` works.
	it("spells a Case with a payload as a call", () => {
		let shape = choice(marshal, "Shape").Circle as AnyCall

		expect(shape({ radius: 3n })).toEqual({
			$case: "Shape#Circle",
			radius: 3n,
		})
		expect(exported(marshal, "areaOf")(shape({ radius: 3n }))).toBe(9n)
	})

	// A Case with no payload is the value itself.
	it("spells a Case with no payload as a value", () => {
		expect(choice(marshal, "Shape").Blank).toEqual({ $case: "Shape#Blank" })
		expect(
			exported(marshal, "areaOf")(choice(marshal, "Shape").Blank),
		).toBe(0n)
	})

	// A unit Choice's Case is its string, so `Direction.Up` and `"Up"` are one
	// value.
	it("spells a Case of a unit Choice as the string it crosses as", () => {
		expect(choice(marshal, "Direction")).toEqual({
			Up: "Up",
			Down: "Down",
		})
		expect(
			exported(marshal, "direction")(choice(marshal, "Direction").Up),
		).toBe("Up")
	})

	// The constructors join the Namespace of the same name.
	it("hands its constructors to the Namespace of its own name", () => {
		let colour = choice(calls, "Colour")

		expect(colour.Red).toEqual({ $case: "Colour#Red" })
		expect((colour.Named as AnyCall)({ name: "blue" })).toEqual({
			$case: "Colour#Named",
			name: "blue",
		})
		expect((colour.preferred as AnyCall)()).toEqual({ $case: "Colour#Red" })
	})

	// A Type Alias for a Choice gets no constructors, since its values would
	// carry the Choice's name.
	it("is spelled under its own name alone", () => {
		expect("Label" in marshal.exports).toBe(false)
	})
})

// `constant present = Optional<Integer>#Value(3)` infers one of `Optional`'s
// Cases alone. The way in, the way out and the declarations must all read it as
// the item.
describe("One of Optional's own Cases met alone", () => {
	it("reads a lone #Value as the item and a lone #Empty as nothing", () => {
		expect(absence.exports.present).toBe(3n)
		expect(absence.exports.nought).toBeUndefined()
	})

	it("reads it the same way inside every shape it is nested in", () => {
		expect(absence.exports.boxed).toEqual({ held: 3n })
		expect(absence.exports.listed).toEqual([3n, 4n])
	})

	// The walk the value directs and the compiled reader must agree.
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
	// Labels and positions are the same call.
	it("takes the labels or the positions", () => {
		expect(exported(calls, "labelled")(10n, 4n)).toBe(6n)
		expect(exported(calls, "labelled")({ first: 10n, second: 4n })).toBe(6n)
	})

	// The keys are a set, in any order.
	it("reads the labels in the order the Function takes them", () => {
		expect(exported(calls, "labelled")({ second: 4n, first: 10n })).toBe(6n)
	})

	it("is not offered where a Parameter carries no label", () => {
		// `square(_ value: Integer)` has no label, so the object is its Argument.
		let error = marshalError(() => exported(math, "square")({ value: 12n }))

		expect(error.message).toBe(
			"argument 1: expected Integer, got an object with 'value'.",
		)

		// `mixed` takes `_ first` and `second`, so it has no labelled call.
		expect(
			callError(() =>
				exported(calls, "mixed")({ first: 10n, second: 4n }),
			).message,
		).toContain("takes 2 Arguments; 1 Argument was passed.")
	})

	// A lone Record Parameter takes the object, even with a label, as `moved`
	// shows.
	it("loses to a single Record Parameter", () => {
		expect(exported(main, "describe")({ width: 3n, height: 4n })).toBe(
			"area: 12",
		)
		expect(exported(calls, "moved")({ x: 1n, y: 2n })).toEqual({
			x: 1n,
			y: 2n,
		})
	})

	// So does a lone Parameter a Record can inhabit, through a Union or an
	// Optional. A labelled reading would hand over the wrong value.
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

	// One object for two Parameters was meant as a labelled call, and is
	// refused as one.
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

	// The receiver comes first, as the Export Surface's first Parameter.
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

	// The receiver is written `_`, so an instance Method has no labelled call.
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

	// The Rewriter mangles a static `prototype` or `constructor`, which a class
	// refuses.
	it("binds the two member names a class refuses", () => {
		expect(namespaceOf(calls, "Point")["constructor"]).toBe(5n)
		expect(method(calls, "Point", "prototype")({ x: 7n, y: 2n })).toBe(7n)
	})

	it("takes a Method that takes nothing", () => {
		expect(method(calls, "Point", "origin")()).toEqual({ x: 0n, y: 0n })
	})

	// `Rectangle` is a Type Alias and a Namespace, so its kind reads `type`
	// though the bundle binds it.
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

	// An instance Overload's signature carries its receiver.
	it("lists an instance Overload with its receiver", () => {
		expect(
			callError(() =>
				method(calls, "Point", "grown")({ x: 1n, y: 2n }, 3n),
			).message,
		).toContain(
			"Point.grown__overload$1(_ { x: Integer, y: Integer }, _ Integer) -> { x: Integer, y: Integer }",
		)
	})

	// Each Overload stays reachable through `raw`.
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
