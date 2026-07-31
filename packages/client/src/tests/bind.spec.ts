import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { fixturePath } from "@essence-lang/fixtures"

import type { EssenceValue } from "../bridge"
import { EssenceCallError, EssenceMarshalError } from "../errors"
import { type EssenceModule, loadModule } from "../index"

let cacheDirectory = ""
let calls: EssenceModule
let geometry: EssenceModule
let main: EssenceModule
let math: EssenceModule

beforeAll(async () => {
	cacheDirectory = realpathSync.native(
		mkdtempSync(path.join(tmpdir(), "essence-bind-")),
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

	// NOTE: A Choice is erased — it names Cases, and a Case is a value's Type
	// rather than a value. Nothing binds it, so nothing is bound.
	it("leaves a Choice off both doors", () => {
		expect(calls.surface.kinds.Colour).toBe("choice")
		expect("Colour" in calls.exports).toBe(false)
		expect("Colour" in calls.raw).toBe(false)
	})

	it("binds every name that has a runtime binding", () => {
		expect(Object.keys(calls.exports)).toEqual(Object.keys(calls.raw))
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
