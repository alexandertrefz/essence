import { describe, expect, test } from "bun:test"

import { createDictionary } from "../Dictionary"
import { createInteger } from "../Integer"
import { anyIs, boundRecordToString } from "../internalHelpers"
import { createList } from "../List"
import { formatAsFraction } from "../Rational"
import { createRecord } from "../Record"
import { createString } from "../String"
import { getStringRepresentation } from "../Terminal"
import type { AnyType } from "../type"
import { createCase } from "../type"

describe("rendering a String", () => {
	// Spelled with the String Literal's escapes, so an embedded quote does not
	// read as the closing one. See "Quoting a String" in
	// packages/runtime/DEVELOPMENT.md.
	test("quotes, backslashes and line breaks are escaped", () => {
		expect(getStringRepresentation(createString('a"b\nc'))).toBe(
			'"a\\"b\\nc"',
		)
		expect(getStringRepresentation(createString("back\\slash"))).toBe(
			'"back\\\\slash"',
		)
		expect(getStringRepresentation(createString("tab\there\r"))).toBe(
			'"tab\\there\\r"',
		)
	})

	// A control character with no escape of its own renders as a code point
	// escape, which a Literal reads back.
	test("a control character renders as its code point", () => {
		expect(getStringRepresentation(createString("\u0000"))).toBe('"\\u{0}"')
		expect(getStringRepresentation(createString("\u009F"))).toBe(
			'"\\u{9F}"',
		)
	})

	// A bare brace in quoted output would open an interpolation hole when read
	// back. `roundTrip.spec.ts` in the Compiler holds the round trip through the
	// real Lexer.
	test("a brace renders as the escape that writes one", () => {
		expect(getStringRepresentation(createString("a{b}"))).toBe('"a\\{b\\}"')
	})

	// A bidi override reorders the printed line, U+2028 breaks it, and a byte
	// order mark hides, so each is spelled as a code point.
	test("a character that reorders or hides renders as its code point", () => {
		expect(getStringRepresentation(createString("a\u202Eb"))).toBe(
			'"a\\u{202E}b"',
		)
		expect(getStringRepresentation(createString("a\u2028b"))).toBe(
			'"a\\u{2028}b"',
		)
		expect(getStringRepresentation(createString("\uFEFFa"))).toBe(
			'"\\u{FEFF}a"',
		)
	})

	// A zero-width joiner changes only how its neighbours draw, and escaping it
	// would take an emoji sequence apart.
	test("a joiner inside an emoji sequence is left alone", () => {
		expect(
			getStringRepresentation(createString("\u{1F469}\u200D\u{1F4BB}")),
		).toBe('"\u{1F469}\u200D\u{1F4BB}"')
	})

	// No Literal spells a lone surrogate, so it renders as the replacement
	// character's escape, which encoding the text would produce anyway.
	test("a lone surrogate renders as the replacement character", () => {
		expect(getStringRepresentation(createString("a\uD800b"))).toBe(
			'"a\\u{FFFD}b"',
		)
		expect(getStringRepresentation(createString("\uD83D\uDE00"))).toBe(
			'"\u{1F600}"',
		)
	})

	test("plain text renders unchanged inside its quotes", () => {
		expect(getStringRepresentation(createString("hello"))).toBe('"hello"')
		expect(getStringRepresentation(createString("caf\u00E9 \u65E5"))).toBe(
			'"caf\u00E9 \u65E5"',
		)
	})

	test("a Record member renders with the same escapes", () => {
		expect(
			getStringRepresentation(
				createRecord({ note: createString('say "hi"\n') }),
			),
		).toBe('{ note = "say \\"hi\\"\\n" }')
	})
})

// The keys here are distinct, so the key witness only ever answers `false`.
// `dictionaries.spec.ts` asks about equality.
const distinct = {
	is: () => ({ [Symbol.for("$type")]: "Boolean", value: false }) as never,
}

// `createCase` answers a `CaseInstanceType`, which stays out of `AnyType`, so
// it is cast as the runtime modules cast it.
const caseValue = (tag: string, payload?: Record<string, AnyType>): AnyType =>
	createCase(tag, payload) as unknown as AnyType

const dictionary = (...pairs: Array<[string, number]>) =>
	createDictionary(
		pairs.map(
			([key, value]) =>
				[createString(key), createInteger(BigInt(value))] as [
					AnyType,
					AnyType,
				],
		),
		distinct,
	)

// A Dictionary renders in its written form, as `Dictionary::toString` answers.
// The structural and printable readings differ only in padding, as for a List.
describe("rendering a Dictionary", () => {
	test("the entries read as a Program writes them", () => {
		expect(getStringRepresentation(dictionary(["a", 1], ["b", 2]))).toBe(
			'[ "a" = 1, "b" = 2 ]',
		)
	})

	// `[=]` tells the empty Dictionary from the empty List, and has nothing to
	// pad.
	test("the empty Dictionary reads [=]", () => {
		expect(getStringRepresentation(dictionary())).toBe("[=]")
		expect(
			getStringRepresentation(dictionary(), 0, formatAsFraction, ""),
		).toBe("[=]")
	})

	// `Record::toString` asks for the form `Dictionary::toString` answers.
	test("the printable reading pads nothing", () => {
		expect(
			getStringRepresentation(
				createRecord({ counts: dictionary(["a", 1]) }),
				0,
				formatAsFraction,
				"",
			),
		).toBe('{ counts = ["a" = 1] }')
	})

	// A line reaching 60 characters wraps, as for a List or a Record.
	test("a long Dictionary wraps one entry to a line", () => {
		expect(
			getStringRepresentation(
				dictionary(
					["alexander", 1],
					["bartholomew", 2],
					["christopher", 3],
					["dominic", 4],
				),
			),
		).toBe(
			[
				"[",
				'    "alexander" = 1,',
				'    "bartholomew" = 2,',
				'    "christopher" = 3,',
				'    "dominic" = 4',
				"]",
			].join("\n"),
		)
	})
})

// A Case's tag carries its Module, as in `"./Doors.es#Door#Open"`, but it
// renders as `Door#Open`, so renaming a file does not change a Program's output.
describe("rendering a Case", () => {
	test("a Module-qualified tag prints as Choice#Case", () => {
		expect(getStringRepresentation(caseValue("./Doors.es#Door#Open"))).toBe(
			"Door#Open",
		)
	})

	test("a standard library Case prints exactly as it always did", () => {
		expect(getStringRepresentation(caseValue("Ordering#Less"))).toBe(
			"Ordering#Less",
		)
	})

	test("a one-member payload prints bare, under the same text", () => {
		expect(
			getStringRepresentation(
				caseValue("./Shapes.es#Shape#Circle", {
					radius: createInteger(2n),
				}),
			),
		).toBe("Shape#Circle(2)")
	})

	test("a several-member payload prints as a Record, under the same text", () => {
		expect(
			getStringRepresentation(
				caseValue("./Shapes.es#Shape#Square", {
					side: createInteger(1n),
					door: caseValue("./Doors.es#Door#Shut"),
				}),
			),
		).toBe("Shape#Square { side = 1, door = Door#Shut }")
	})

	// Neither a Choice name nor a Case name can hold a `#`. So the last two
	// separators are the right pair, whatever the Module path holds.
	test("a Module path holding a # keeps only the last two segments", () => {
		expect(
			getStringRepresentation(caseValue("./o#d/Doors.es#Door#Open")),
		).toBe("Door#Open")
	})

	test("a Case held by a Record or a List is shown the same way", () => {
		let open = caseValue("./Doors.es#Door#Open")

		expect(getStringRepresentation(createRecord({ door: open }))).toBe(
			"{ door = Door#Open }",
		)
		expect(getStringRepresentation(createList([open]))).toBe(
			"[ Door#Open ]",
		)
	})

	// The renderings collide, but each tag keeps its Module, so the values stay
	// distinct.
	test("the tag itself is untouched — two Modules' Doors stay distinct", () => {
		let mine = caseValue("./Mine.es#Door#Open")
		let yours = caseValue("./Yours.es#Door#Open")

		expect(getStringRepresentation(mine)).toBe(
			getStringRepresentation(yours),
		)
		expect(anyIs(mine, yours)).toBe(false)
	})
})

// The renderer table is keyed by member name, and on a plain object a name such
// as `constructor` would find a function of `Object.prototype`. So the table has
// no prototype. A routed name shadows the prototype anyway, and its test fails a
// fix that filters names out instead. Only a Record that routes a member is
// handed a table, so both routed tests route one.
describe("rendering a Record whose member is named like Object.prototype", () => {
	// Every own name on `Object.prototype` a Program can spell. No Essence name
	// begins with an underscore, so `__proto__` is left out.
	const prototypeNames = Object.getOwnPropertyNames(Object.prototype).filter(
		(name) => name !== "__proto__",
	)

	// The tests go through `boundRecordToString`, which builds the table, since
	// a table built here would pass whatever the runtime does.
	const rendering = (name: string) => ({
		toString: () => createString(`<${name}>`),
	})

	test("a routed member named like one prints through its own renderer", () => {
		for (let name of prototypeNames) {
			expect(
				boundRecordToString([name])(
					createRecord({ [name]: createInteger(1n) }),
					rendering("routed"),
				).value,
			).toBe(`{ ${name} = <routed> }`)
		}
	})

	test("an unrouted member named like one prints structurally", () => {
		for (let name of prototypeNames) {
			expect(
				boundRecordToString(["price"])(
					createRecord({
						price: createInteger(1n),
						[name]: createInteger(2n),
					}),
					rendering("price"),
				).value,
			).toBe(`{ price = <price>, ${name} = 2 }`)
		}
	})

	// A Record that routes nothing is handed no table, and the routed tests must
	// match its answer.
	test("the same members print structurally where nothing routes", () => {
		for (let name of prototypeNames) {
			expect(
				getStringRepresentation(
					createRecord({ [name]: createInteger(2n) }),
				),
			).toBe(`{ ${name} = 2 }`)
		}
	})
})

// The walk renders each child once at indent zero and re-indents it. See "The
// structural rendering" in packages/runtime/DEVELOPMENT.md.
describe("rendering a deeply nested value", () => {
	// One member per level, and a leaf long enough that every level wraps.
	function chain(depth: number): AnyType {
		let value: AnyType = createString(
			"a leaf String long enough that every level of this chain wraps",
		)

		for (let level = 0; level < depth; level++) {
			value = createRecord({ member: value })
		}

		return value
	}

	test("a deeper indent is the indent written into the shallower one", () => {
		let value = chain(4)
		let shallow = getStringRepresentation(value)

		for (let level of [1, 2, 5]) {
			expect(getStringRepresentation(value, level)).toBe(
				shallow.replaceAll("\n", `\n${" ".repeat(4 * level)}`),
			)
		}
	})

	test("a chain twenty-two deep renders at once", () => {
		let value = chain(22)
		let start = performance.now()
		let rendered = getStringRepresentation(value)

		expect(performance.now() - start).toBeLessThan(50)
		expect(rendered.split("\n").length).toBe(45)
	})
})
