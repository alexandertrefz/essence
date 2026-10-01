import { describe, expect, it } from "bun:test"

import type { common, parser } from "@essence-lang/interfaces"

import { containsErrors } from "../diagnostics/index"
import { parseWithDiagnostics } from "../parser/index"
import { compiles } from "./followedHelps"

// The Diagnostics the Lexer and the Parser report about a Program they can
// still read past. Examples are a Number holding letters or a name defined
// twice.

function firstNode(source: string): parser.ImplementationNode | undefined {
	return parseWithDiagnostics(source).program.implementation.nodes[0]
}

function helpsOf(source: string): Array<string> {
	return parseWithDiagnostics(source).diagnostics.flatMap(
		(diagnostic) => diagnostic.helps,
	)
}

function declaredValue(
	node: parser.ImplementationNode | undefined,
): parser.ExpressionNode | undefined {
	if (node?.nodeType !== "ConstantDeclarationStatement") {
		return undefined
	}

	return node.value
}

describe("Parser Diagnostics", () => {
	describe("Number Literals", () => {
		it("should report a Number Literal that holds letters", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { Terminal.inspect(0xFF::toString()) }",
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].code).toBe("invalid-number")
			expect(diagnostics[0].message).toBe("'0xFF' is not a valid Number")
			expect(diagnostics[0].labels).toHaveLength(1)
			expect(diagnostics[0].labels[0]?.kind).toBe("primary")
			expect(diagnostics[0].position).toEqual({
				start: { line: 1, column: 35 },
				end: { line: 1, column: 39 },
			})
		})

		it("should report an exponent form instead of failing in the Rewriter", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				`implementation {
					constant x = 1e5
					constant y = 5
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("invalid-number")

			// The malformed Literal ends only its own Token, and the Token left
			// holds digits, so no later stage sees `1e5`.
			let nodes = program.implementation.nodes

			expect(nodes).toHaveLength(2)
			expect(declaredValue(nodes[0])).toMatchObject({
				nodeType: "IntegerValue",
				value: "1",
			})
		})

		it("should not report a Number written in digits", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { 1_000_000 }",
			)

			expect(diagnostics).toEqual([])
		})
	})

	describe("String escapes", () => {
		it("should report an unknown escape without truncating the String", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				`implementation {
					constant x = "bad \\q here"
					constant y = 5
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].code).toBe("invalid-escape")

			// The bad escape ends nothing, and the character reads as itself.
			let nodes = program.implementation.nodes
			expect(nodes).toHaveLength(2)
			expect(declaredValue(nodes[0])).toMatchObject({
				nodeType: "StringValue",
				value: "bad q here",
			})
		})

		it("should not report a known escape", () => {
			let { diagnostics } = parseWithDiagnostics(
				'implementation { constant x = "a\\nb\\t\\"c\\\\d\\{e\\}\\u{1B}" }',
			)

			expect(diagnostics).toEqual([])
		})

		// A character that acts on the terminal is named rather than echoed,
		// so the report can not ring a bell.
		it("should name an escaped character that acts on the terminal", () => {
			let { diagnostics } = parseWithDiagnostics(
				'implementation { constant x = "a\\\u0007b" }',
			)

			expect(diagnostics[0].code).toBe("invalid-escape")
			expect(diagnostics[0].message).toBe(
				"A backslash before U+0007 is not a valid escape",
			)
		})

		// The escape set comes from `escapeSetSentence`, which the documentation
		// and the showcase are captured from too.
		it("should name the Unicode escape among the escapes a String understands", () => {
			let { diagnostics } = parseWithDiagnostics(
				'implementation { constant x = "bad \\q here" }',
			)

			expect(diagnostics[0].notes).toEqual([
				"A String understands '\\\"', '\\\\', '\\n', '\\r', '\\t', '\\{', '\\}' and '\\u{…}'; every other backslash is an error.",
			])
		})
	})

	// Each wrong `\u{…}` is held to its code, its label's span and its Help.
	// A Help is an edit, so it is written back into the probe and compiled.
	describe("Unicode escapes", () => {
		it("should rewrite the JavaScript habit into the braced spelling", () => {
			let source = 'implementation { constant x = "caf\\u00e9" }'
			let { diagnostics } = parseWithDiagnostics(source)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("unbraced-unicode-escape")
			expect(diagnostics[0].message).toBe(
				"'\\u00e9' is missing the braces around its code point",
			)
			expect(diagnostics[0].position).toEqual({
				start: { line: 1, column: 35 },
				end: { line: 1, column: 41 },
			})
			expect(helpsOf(source)).toEqual(["Write it in braces: '\\u{e9}'."])
			expect(
				compiles('implementation { constant x = "caf\\u{e9}" }'),
			).toBe(true)
		})

		// JavaScript writes a character beyond U+FFFF as two halves, as in
		// `\uD83D\uDE00`. Neither half is a character, so the Help offers the one
		// escape they stand for.
		it("should offer the whole character for a surrogate pair", () => {
			let source = 'implementation { constant x = "\\uD83D\\uDE00" }'

			expect(helpsOf(source)).toEqual([
				"Write the character as one escape: '\\u{1F600}'.",
			])
			expect(
				compiles('implementation { constant x = "\\u{1F600}" }'),
			).toBe(true)
		})

		// One report over both halves, spanning what the Help rewrites, so
		// following the Help leaves no half behind.
		it("should offer the whole character for a braced surrogate pair", () => {
			let source = 'implementation { constant x = "\\u{D83D}\\u{DE00}" }'
			let { diagnostics } = parseWithDiagnostics(source)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"surrogate-unicode-escape",
			])
			expect(diagnostics[0].position).toEqual({
				start: { line: 1, column: 32 },
				end: { line: 1, column: 48 },
			})
			expect(diagnostics[0].notes).toEqual([
				"U+D800 through U+DFFF are the halves UTF-16 writes a character above U+FFFF in; a String holds characters, so an escape names one of those directly.",
			])
			expect(helpsOf(source)).toEqual([
				"Write the character as one escape: '\\u{1F600}'.",
			])
			expect(
				compiles('implementation { constant x = "\\u{1F600}" }'),
			).toBe(true)
		})

		// A pair rewritten one half at a time mixes the spellings, and is
		// still one report offering the character both halves stand for.
		it("should read a pair whose halves are spelled differently", () => {
			for (let written of ['"\\uD83D\\u{DE00}"', '"\\u{D83D}\\uDE00"']) {
				let source = `implementation { constant x = ${written} }`
				let { diagnostics } = parseWithDiagnostics(source)

				expect([written, diagnostics.length]).toEqual([written, 1])
				expect([written, helpsOf(source)]).toEqual([
					written,
					["Write the character as one escape: '\\u{1F600}'."],
				])
			}

			expect(
				compiles('implementation { constant x = "\\u{1F600}" }'),
			).toBe(true)
		})

		// Halves in the wrong order, a high half before an ordinary escape, and
		// halves with something between them are no pair. Each half is refused
		// alone, with no edit.
		it("should offer nothing where two escapes are not a pair", () => {
			for (let [written, reports] of [
				['"\\u{DC00}\\u{D800}"', 2],
				['"\\u{D800}\\u{41}"', 1],
				['"\\u{D800}x\\u{DC00}"', 2],
				['"\\u{D800}{ 1 }\\u{DC00}"', 2],
			] as Array<[string, number]>) {
				let source = `implementation { constant x = ${written} }`
				let { diagnostics } = parseWithDiagnostics(source)

				expect([written, diagnostics.length]).toEqual([
					written,
					reports,
				])
				expect([written, helpsOf(source)]).toEqual([written, []])
			}
		})

		// A lone surrogate stands for no character, so no rewrite is offered.
		it("should offer nothing for a lone surrogate", () => {
			let source = 'implementation { constant x = "\\u{D800}" }'
			let { diagnostics } = parseWithDiagnostics(source)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("surrogate-unicode-escape")
			expect(diagnostics[0].message).toBe(
				"U+D800 is a surrogate, which names no character",
			)
			expect(helpsOf(source)).toEqual([])
		})

		it("should refuse an escape holding nothing", () => {
			let source = 'implementation { constant x = "\\u{}" }'
			let { diagnostics } = parseWithDiagnostics(source)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("malformed-unicode-escape")
			expect(diagnostics[0].message).toBe("'\\u{}' names no code point")
			expect(helpsOf(source)).toEqual([
				"Write the code point's hexadecimal digits between the braces: '\\u{1B}' is the escape character.",
			])
			expect(compiles('implementation { constant x = "\\u{1B}" }')).toBe(
				true,
			)
		})

		it("should name the character that is not a hexadecimal digit", () => {
			let source = 'implementation { constant x = "\\u{1G}" }'
			let { diagnostics } = parseWithDiagnostics(source)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("malformed-unicode-escape")
			expect(diagnostics[0].message).toBe(
				"'G' is not a hexadecimal digit",
			)
			expect(helpsOf(source)).toEqual([
				"Write the code point in hexadecimal: '\\u{1B}' is the escape character, '\\u{1F600}' a grinning face.",
			])
			expect(
				compiles('implementation { constant x = "\\u{1F600}" }'),
			).toBe(true)
		})

		// A report is read on a terminal, where an override reorders the line, a
		// BEL rings and a byte order mark vanishes. Such a character is named, as
		// a chart spells it.
		it("should name an offending character that acts on the terminal", () => {
			for (let [character, named] of [
				["\u202E", "U+202E"],
				["\u0007", "U+0007"],
				["\uFEFF", "U+FEFF"],
				["\u2028", "U+2028"],
			] as Array<[string, string]>) {
				let { diagnostics } = parseWithDiagnostics(
					`implementation { constant x = "\\u{${character}41}" }`,
				)

				expect([named, diagnostics[0].message]).toEqual([
					named,
					`${named} is not a hexadecimal digit`,
				])
				expect([named, diagnostics[0].message]).not.toContain(character)
			}
		})

		// A character that prints as itself is quoted, not named.
		it("should quote an offending character that prints as itself", () => {
			let { diagnostics } = parseWithDiagnostics(
				'implementation { constant x = "\\u{1\u00E9}" }',
			)

			expect(diagnostics[0].message).toBe(
				"'\u00E9' is not a hexadecimal digit",
			)
		})

		// Code points are named as `U+1B` elsewhere, so that spelling inside the
		// braces gets an answer of its own.
		it("should take the 'U+' off a code point written by name", () => {
			let source = 'implementation { constant x = "\\u{U+1B}" }'

			expect(helpsOf(source)).toEqual([
				"Write the digits alone: '\\u{1B}' — the 'U+' names a code point rather than spelling one.",
			])
			expect(compiles('implementation { constant x = "\\u{1B}" }')).toBe(
				true,
			)
		})

		it("should refuse more than six digits and drop the leading zeros", () => {
			let source = 'implementation { constant x = "\\u{0000041}" }'
			let { diagnostics } = parseWithDiagnostics(source)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("malformed-unicode-escape")
			expect(diagnostics[0].message).toBe("'\\u{0000041}' has 7 digits")
			expect(helpsOf(source)).toEqual([
				"Drop the leading zeros: '\\u{41}'.",
			])
			expect(compiles('implementation { constant x = "\\u{41}" }')).toBe(
				true,
			)
		})

		it("should refuse a code point above the highest one", () => {
			let source = 'implementation { constant x = "\\u{110000}" }'
			let { diagnostics } = parseWithDiagnostics(source)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("unicode-escape-out-of-range")
			expect(diagnostics[0].message).toBe(
				"U+110000 is above the highest character",
			)
			expect(diagnostics[0].notes).toEqual([
				"The highest Unicode code point is U+10FFFF, so '\\u{10FFFF}' is the largest escape there is.",
			])
			expect(
				compiles('implementation { constant x = "\\u{10FFFF}" }'),
			).toBe(true)
		})

		// A decimal code point reads as a hexadecimal number that is too large.
		// The source does not record which base was meant, so the Help states
		// its condition.
		it("should offer the hexadecimal spelling of a decimal code point", () => {
			let source = 'implementation { constant x = "\\u{128512}" }'

			expect(helpsOf(source)).toEqual([
				"The digits are read as hexadecimal — write '\\u{1F600}' where the character numbered 128512 was meant.",
			])
			expect(
				compiles('implementation { constant x = "\\u{1F600}" }'),
			).toBe(true)
		})

		// Just past the top, `\u{110000}` is more likely the top missed by one
		// than a decimal. So the decimal reading is withheld up to the plane
		// past the last.
		it("should withhold a decimal reading just above the top", () => {
			for (let written of ["110000", "110001", "111111", "119999"]) {
				let source = `implementation { constant x = "\\u{${written}}" }`
				let { diagnostics } = parseWithDiagnostics(source)

				expect([written, diagnostics[0].code]).toEqual([
					written,
					"unicode-escape-out-of-range",
				])
				expect([written, helpsOf(source)]).toEqual([written, []])
			}
		})

		// The decimal digits of a surrogate, `\u{55296}`, are a valid
		// hexadecimal code point, so they are never refused.
		it("should read a decimal surrogate as the character its digits spell", () => {
			expect(
				parseWithDiagnostics(
					'implementation { constant x = "\\u{55296}" }',
				).diagnostics,
			).toEqual([])
		})

		// The String closes where it was written, so the next Statement is read
		// and no `unclosed-string` is reported.
		it("should close the String an unclosed escape was written in", () => {
			let source = `implementation {
	constant s = "\\u{1B"
	constant t = 2
}`
			let { program, diagnostics } = parseWithDiagnostics(source)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"malformed-unicode-escape",
			])
			expect(diagnostics[0].message).toBe("this '\\u{' is never closed")
			expect(helpsOf(source)).toEqual(["Close it with a '}': '\\u{1B}'."])
			expect(program.implementation.nodes).toHaveLength(2)
			expect(
				compiles(`implementation {
	constant s = "\\u{1B}"
	Terminal.inspect(s)
}`),
			).toBe(true)
		})

		// A hole after an unclosed escape is still a hole, as `lexer.spec.ts`
		// checks in Tokens.
		it("should leave a hole below an unclosed escape alone", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				`implementation {
	constant n = 2
	constant s = "\\u{{ n }tail"
}`,
			)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"malformed-unicode-escape",
			])
			expect(
				declaredValue(program.implementation.nodes[1]),
			).toMatchObject({ nodeType: "InterpolatedStringValue" })
		})
	})

	describe("Interpolation holes", () => {
		it("should refuse a Comment inside a hole without swallowing the String", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				`implementation {
	constant s = "a{ 1 § note }"
	constant t = 2
}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].code).toBe("comment-in-hole")
			expect(diagnostics[0].position).toEqual({
				start: { line: 2, column: 21 },
				end: { line: 2, column: 28 },
			})

			// The Comment ends at the hole's '}', so the String closes where it
			// was written.
			let nodes = program.implementation.nodes

			expect(nodes).toHaveLength(2)
			expect(declaredValue(nodes[1])).toMatchObject({
				nodeType: "IntegerValue",
				value: "2",
			})
		})
	})

	// The Lexer reads the whole file before the Parser starts, yet the report
	// lists its Diagnostics in line order.
	describe("The order a report is read in", () => {
		it("should print the Diagnostics in the order the lines are written", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
	constant n = 0xFF
	constant m = 1e5
	constant s = "bad \\q here"
	constant t = 2px
}`,
			)

			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.code,
					diagnostic.position?.start.line,
				]),
			).toEqual([
				["invalid-number", 2],
				["invalid-number", 3],
				["invalid-escape", 4],
				["invalid-number", 5],
			])
		})
	})

	describe("Line endings", () => {
		it("should parse a file with Windows line endings", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation {\r\n\tconstant x = 1\r\n}\r\n",
			)

			expect(diagnostics).toEqual([])
		})

		it("should parse a file opening with a byte order mark", () => {
			let { diagnostics } = parseWithDiagnostics(
				"\uFEFFimplementation { constant x = 1 }",
			)

			expect(diagnostics).toEqual([])
		})
	})

	describe("Number Literal joining", () => {
		it("should not join a '_' group on the next line", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				`implementation {
					constant x = 1
_ 2
				}`,
			)

			expect(containsErrors(diagnostics)).toBe(true)
			expect(
				declaredValue(program.implementation.nodes[0]),
			).toMatchObject({
				nodeType: "IntegerValue",
				value: "1",
			})
		})

		it("should not join a '/' denominator on the next line", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				`implementation {
					constant a = 1
/ 2
				}`,
			)

			expect(containsErrors(diagnostics)).toBe(true)
			expect(
				declaredValue(program.implementation.nodes[0]),
			).toMatchObject({
				nodeType: "IntegerValue",
				value: "1",
			})
		})

		it("should not join a '_' group written apart on one line", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				"implementation { constant x = 1 _ 000 }",
			)

			expect(containsErrors(diagnostics)).toBe(true)
			expect(
				declaredValue(program.implementation.nodes[0]),
			).toMatchObject({
				nodeType: "IntegerValue",
				value: "1",
			})
		})

		// A spaced `/` behind a finished Expression is another language's
		// division, so the Statement is dropped. See `foreignTextAhead`.
		it("should not join a '/' denominator written apart on one line", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				"implementation { constant a = 3 / 2 }",
			)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"operator-not-supported",
			])
			expect(program.implementation.nodes).toEqual([])
		})

		it("should join the parts of a Number written flush", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				"implementation { constant a = 1_000/9 }",
			)

			expect(diagnostics).toEqual([])
			expect(
				declaredValue(program.implementation.nodes[0]),
			).toMatchObject({
				nodeType: "RationalValue",
				numerator: "1000",
				denominator: "9",
			})
		})

		it("should not join the ':' of a Method call written apart", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { constant x = a :  : b() }",
			)

			expect(containsErrors(diagnostics)).toBe(true)
		})

		it("should not join the ':' of a Method call split across lines", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					constant x = a :
: b()
				}`,
			)

			expect(containsErrors(diagnostics)).toBe(true)
		})

		it("should read a '::' written flush as a Method call", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				"implementation { constant x = a::b() }",
			)

			expect(diagnostics).toEqual([])
			expect(
				declaredValue(program.implementation.nodes[0]),
			).toMatchObject({ nodeType: "MethodInvocation" })
		})
	})

	// A decimal is a second spelling of a Rational, with no Node of its own.
	// These hold the Parser to the fraction each spelling stands for.
	describe("Decimal Literals", () => {
		let numberOf = (source: string) =>
			declaredValue(
				firstNode(`implementation { constant a = ${source} }`),
			)

		it("should read a decimal as its fraction", () => {
			expect(numberOf("0.75")).toMatchObject({
				nodeType: "RationalValue",
				numerator: "75",
				denominator: "100",
			})
			expect(numberOf("19.99")).toMatchObject({
				nodeType: "RationalValue",
				numerator: "1999",
				denominator: "100",
			})
		})

		it("should keep the sign on the numerator", () => {
			expect(numberOf("-0.5")).toMatchObject({
				nodeType: "RationalValue",
				numerator: "-5",
				denominator: "10",
			})
		})

		// `2.0` is a Rational as `4/2` is, and the runtime reduces it on read.
		it("should read a whole decimal as a Rational", () => {
			expect(numberOf("2.0")).toMatchObject({
				nodeType: "RationalValue",
				numerator: "20",
				denominator: "10",
			})
		})

		// No scale is kept beside the fraction, so `1.50` and `1.5` reduce to
		// one value.
		it("should keep a trailing zero out of the value", () => {
			expect(numberOf("1.50")).toMatchObject({
				nodeType: "RationalValue",
				numerator: "150",
				denominator: "100",
			})
		})

		it("should join '_' groups on both sides of the point", () => {
			expect(numberOf("1_000.000_1")).toMatchObject({
				nodeType: "RationalValue",
				numerator: "10000001",
				denominator: "10000",
			})
		})

		// The numerator goes through `BigInt`, since later stages read it as
		// plain digits.
		it("should normalise a leading zero out of the numerator", () => {
			expect(numberOf("0.05")).toMatchObject({
				nodeType: "RationalValue",
				numerator: "5",
				denominator: "100",
			})
		})

		it("should leave no sign on a zero", () => {
			expect(numberOf("-0.0")).toMatchObject({
				nodeType: "RationalValue",
				numerator: "0",
				denominator: "10",
			})
		})

		it("should span the Literal from its sign to its last digit", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { constant a = -0.5 }",
			)

			expect(diagnostics).toEqual([])
			expect(numberOf("-0.5")).toMatchObject({
				position: {
					start: { line: 1, column: 31 },
					end: { line: 1, column: 35 },
				},
			})
		})

		it("should refuse a fraction written onto a decimal", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { constant a = 1.5/2 }",
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("mixed-rational-literal")
			expect(diagnostics[0].labels[0]?.message).toBe(
				"'/' can not follow a decimal",
			)
			// The whole Literal is underlined. The tail is read before it is
			// refused, so nothing is read again as a Statement.
			expect(diagnostics[0].position).toEqual({
				start: { line: 1, column: 31 },
				end: { line: 1, column: 36 },
			})
		})

		it("should refuse a decimal written onto a fraction", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { constant a = 1/2.5 }",
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("mixed-rational-literal")
			expect(diagnostics[0].labels[0]?.message).toBe(
				"'.' can not follow a fraction",
			)
		})

		it("should refuse a decimal with nothing before the point", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { constant a = .5 }",
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("partial-decimal-literal")
			expect(diagnostics[0].message).toBe(
				"A decimal Literal has digits on both sides of the dot",
			)
			expect(diagnostics[0].labels[0]?.message).toBe(
				"nothing stands before the point",
			)
			expect(diagnostics[0].helps).toContain(
				"Write the digits before the point: '0.5'.",
			)
		})

		it("should refuse a decimal with nothing behind the point", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { constant a = 1. }",
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("partial-decimal-literal")
			expect(diagnostics[0].labels[0]?.message).toBe(
				"no digits stand flush behind the point",
			)
			expect(diagnostics[0].helps).toContain(
				"Write the digits behind the point: '1.0'.",
			)
		})

		// The digits must be flush against the point, as a denominator must be
		// flush against the `/`.
		it("should refuse digits pushed off the point", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { constant a = 1. 5 }",
			)

			expect(diagnostics[0].code).toBe("partial-decimal-literal")
		})

		it("should not read a spaced '.' as a decimal point", () => {
			for (let source of ["1 . 5", "1 .5"]) {
				let { program, diagnostics } = parseWithDiagnostics(
					`implementation { constant a = ${source} }`,
				)

				expect(containsErrors(diagnostics)).toBe(true)
				expect(
					diagnostics.some(
						(diagnostic) =>
							diagnostic.code === "partial-decimal-literal",
					),
				).toBe(false)
				expect(
					JSON.stringify(program.implementation.nodes),
				).not.toContain("RationalValue")
			}
		})

		// A flush `.` behind an Integer still opens a Lookup where a member
		// name rather than digits follows it.
		it("should still read a flush member off an Integer", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				"implementation { constant a = 1.foo }",
			)

			expect(diagnostics).toEqual([])
			expect(
				declaredValue(program.implementation.nodes[0]),
			).toMatchObject({ nodeType: "Lookup" })
		})

		it("should still read a flush member off a fraction", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				"implementation { constant a = 1/2.foo }",
			)

			expect(diagnostics).toEqual([])
			expect(
				declaredValue(program.implementation.nodes[0]),
			).toMatchObject({ nodeType: "Lookup" })
		})

		// A `.` opening an Expression is still a member path. Only digits
		// after it are refused.
		it("should still read a member path", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				"implementation { constant a = .price }",
			)

			expect(diagnostics).toEqual([])
			expect(
				declaredValue(program.implementation.nodes[0]),
			).toMatchObject({ nodeType: "MemberPath" })
		})
	})

	describe("Record Matchers", () => {
		it("should report a member value that is not a literal", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					constant expected = 5
					constant result = match value -> String {
						case { size = expected } { <- "matched" }
						case _ { <- "other" }
					}
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].code).toBe("syntax-error")
			expect(diagnostics[0].message).toBe(
				"Expected a literal value but found 'expected'.",
			)
			expect(diagnostics[0].labels[0]?.message).toBe(
				"expected a Number, a String or a Boolean",
			)
		})

		it("should report a member value that is a Case", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					constant result = match value -> String {
						case { state = #Open } { <- "open" }
						case _ { <- "other" }
					}
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("syntax-error")
			expect(diagnostics[0].message).toBe(
				"Expected a literal value but found '#'.",
			)
		})

		// `nothing` is an ordinary name, so as a member value it is refused like
		// any other name.
		it("should report 'nothing' as a member value, now that it is an ordinary Identifier", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					constant result = match value -> String {
						case { missing = nothing } { <- "missing" }
						case _ { <- "other" }
					}
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].code).toBe("syntax-error")
			expect(diagnostics[0].message).toBe(
				"Expected a literal value but found 'nothing'.",
			)
		})

		it("should parse the literal member values", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					constant result = match value -> String {
						case { size = 5, name = "a", flag = true } { <- "one" }
						case { size = -3/2, flag = false } { <- "two" }
						case { size: Integer } { <- "three" }
						case _ { <- "other" }
					}
				}`,
			)

			expect(diagnostics).toEqual([])
		})
	})

	describe("Error Recovery", () => {
		it("should resynchronise on a protocol declaration", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				`implementation {
					constant broken =
					protocol Sizeable {
						size () -> Integer
					}
					constant fine = 5
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Expected an Expression but found 'protocol'.",
			)

			// The Protocol survives the broken Statement before it, or every
			// `is Sizeable` would fail too.
			let nodes = program.implementation.nodes

			expect(nodes).toHaveLength(2)
			expect(nodes[0].nodeType).toBe("ProtocolDeclarationStatement")
			expect(nodes[1].nodeType).toBe("ConstantDeclarationStatement")
		})
	})

	describe("Duplicate Definitions", () => {
		it("should report a Method defined twice in a Namespace", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					namespace Ladder for Integer {
						steps (_ count: Integer) -> Integer {
							<- @::steps(count)
						}

						steps () -> Integer {
							<- @
						}
					}
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].code).toBe("duplicate-method")
			expect(diagnostics[0].message).toBe(
				"Method 'steps' is already defined",
			)
			expect(diagnostics[0].labels).toHaveLength(2)
			expect(diagnostics[0].labels[0]?.kind).toBe("primary")
			expect(diagnostics[0].labels[1]?.kind).toBe("secondary")
			expect(diagnostics[0].helps).toHaveLength(1)
		})

		it("should report a static Method that shares a Method's name", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					namespace Ladder for Integer {
						steps () -> Integer {
							<- @
						}

						static steps () -> Integer {
							<- 0
						}
					}
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("duplicate-method")
		})

		it("should report an overload block that shares a Method's name", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					namespace Ladder for Integer {
						steps () -> Integer {
							<- @
						}

						overload steps {
							(_ count: Integer) -> Integer {
								<- count
							}
						}
					}
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("duplicate-method")
		})

		it("should report a Method signature defined twice in a Protocol", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					protocol Sizeable {
						size () -> Integer
						size () -> String
					}
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("duplicate-method")
			expect(diagnostics[0].message).toBe(
				"Method 'size' is already defined",
			)
		})

		it("should report a static Property defined twice", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					namespace Ladder for Integer {
						static rungs = 3
						static rungs = 4
					}
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("duplicate-property")
			expect(diagnostics[0].message).toBe(
				"Property 'rungs' is already defined",
			)
		})

		it("should not report a Property and a Method sharing a name", () => {
			// Properties and Methods are kept in separate Records, so neither
			// is lost.
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					namespace Ladder for Integer {
						static rungs = 3

						rungs () -> Integer {
							<- @
						}
					}
				}`,
			)

			expect(diagnostics).toEqual([])
		})

		it("should report a Record Literal member written twice", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					constant r = { a = noisy(), a = 2 }
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("error")
			expect(diagnostics[0].code).toBe("duplicate-member")
			expect(diagnostics[0].message).toBe("Member 'a' is already defined")
			expect(diagnostics[0].labels).toHaveLength(2)
		})

		it("should report a member written twice in a Combination", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					constant base = { a = 1 }
					constant r = { base with a = 1, a = 2 }
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("duplicate-member")
		})

		it("should report a Record Type member written twice", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					type Broken = { a: Integer, a: String }
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("duplicate-member")
		})

		it("should report a Record Matcher member written twice", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					constant result = match value -> String {
						case { a: Integer, a = 5 } { <- "one" }
						case _ { <- "other" }
					}
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("duplicate-member")
		})

		it("should not report members that only differ in kind", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					constant r = { a = 1, b = 2 }
					type T = { a: Integer, b: String }
				}`,
			)

			expect(diagnostics).toEqual([])
		})
	})

	describe("Documentation", () => {
		it("should report a tag that runs into its text", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
§§ @param subject who to greet
function greet(subject: String) -> String { <- subject }
}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].severity).toBe("warning")
			expect(diagnostics[0].code).toBe("missing-documentation-separator")
			expect(diagnostics[0].message).toBe(
				"This '@param' tag is not separated from its text",
			)
			expect(diagnostics[0].helps).toEqual([
				"Write '@param subject —' before the text.",
			])
			// The text alone is underlined, since the separator is missing where
			// 'who' begins.
			expect(diagnostics[0].position).toEqual({
				start: { line: 2, column: 19 },
				end: { line: 2, column: 31 },
			})
		})

		it("should report nothing for a separated or a bare tag", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
§§ @param subject — who to greet
§§ @returns
§§ the greeting
function greet(subject: String) -> String { <- subject }
}`,
			)

			expect(diagnostics).toEqual([])
		})

		it("should report a tag it read only once", () => {
			// Abandoned readings also reach a Namespace member's Documentation,
			// but the Diagnostic is reported once.
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
namespace Greeting for String {
§§ @returns the greeting
greet() -> String { <- @ }
}
}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("missing-documentation-separator")
			expect(diagnostics[0].helps).toEqual([
				"Write '@returns —' before the text.",
			])
		})
	})

	describe("Speculative parsing", () => {
		it("should report a duplicate in an annotation exactly once", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					constant x: { a: Integer, a: String } = 5
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("duplicate-member")
		})

		it("should not report a Diagnostic from a reading it threw away", () => {
			// The typed Record Literal reading meets the duplicate in the Record
			// Type, then fails on the missing `~>`. It is thrown away with what it
			// found, and only the kept reading's refusal of the `:` is reported.
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					{ a: Integer, a: String }
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("foreign-syntax")
		})

		// The Record Literal reading of `{ x = .5 }` meets the half-written
		// decimal. A refusal with a code judges the text, so it leaves the
		// speculation rather than letting the Combination reading answer.
		it("should let a coded refusal out of the reading that met it", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { constant a = { x = .5 } }",
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("partial-decimal-literal")
			expect(diagnostics[0].message).toBe(
				"A decimal Literal has digits on both sides of the dot",
			)
			expect(diagnostics[0].position).toEqual({
				start: { line: 1, column: 37 },
				end: { line: 1, column: 39 },
			})
		})

		it("should refuse every half-written Rational in a member value", () => {
			let members: Array<[string, common.DiagnosticCode]> = [
				["{ x = .5 }", "partial-decimal-literal"],
				["{ x = 1. }", "partial-decimal-literal"],
				["{ x = 1.5/2 }", "mixed-rational-literal"],
				["{ x = 1/2.5 }", "mixed-rational-literal"],
			]

			for (let [member, code] of members) {
				let { diagnostics } = parseWithDiagnostics(
					`implementation { constant a = ${member} }`,
				)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe(code)
			}
		})

		// Each construct reads its Record Literal through a speculation, and a
		// nested call through two, which the refusal leaves to be reported
		// once.
		it("should refuse it wherever the Record Literal stands", () => {
			let expressions = [
				"f({ x = .5 })",
				"f(g({ x = .5 }))",
				"#Full({ x = .5 })",
				"Point ~> { x = .5 }",
				"[{ x = .5 }]",
				"{ base with x = .5 }",
			]

			for (let expression of expressions) {
				let { diagnostics } = parseWithDiagnostics(
					`implementation { constant a = ${expression} }`,
				)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("partial-decimal-literal")
			}
		})

		// `require MATCHER = EXPR` reads its Matcher speculatively, so a Record
		// Matcher's member values stand behind a speculation too.
		it("should refuse a half-written decimal in a Record Matcher", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation { }
				tests {
					test "prices" {
						require { price = 1. } = order
					}
				}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("partial-decimal-literal")
		})

		// A path is refused where it is read, inside the Record Literal
		// reading.
		it("should refuse a call on a path in a member value", () => {
			for (let member of [
				"{ x = .price::rounded() }",
				"{ x = .total() }",
			]) {
				let { diagnostics } = parseWithDiagnostics(
					`implementation { constant a = ${member} }`,
				)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("path-is-members-only")
			}
		})

		// A generic failure is given back, and the next reading runs. The
		// reading that got furthest is reported: the Literal one, which fails on
		// the member value where the mistake is.
		it("should still give a generic failure back to the next reading", () => {
			let members: Array<[string, string]> = [
				["{ x = ] }", "Expected an Expression but found ']'."],
				["{ x = y. }", "Expected an Identifier but found '}'."],
			]

			for (let [member, message] of members) {
				let { diagnostics } = parseWithDiagnostics(
					`implementation { constant a = ${member} }`,
				)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("syntax-error")
				expect(diagnostics[0].message).toBe(message)
			}
		})

		// The shapes the speculations exist for still read without error.
		it("should still read the shapes the speculations are there for", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				`implementation {
					constant a = { x = 1 }
					constant b = { a with x = 2 }
					constant c = Point ~> { x = 3 }
					constant d = Holder<Integer>#Full(1)
				}`,
			)

			expect(diagnostics).toEqual([])
			expect(
				program.implementation.nodes.map(
					(node) => declaredValue(node)?.nodeType,
				),
			).toEqual([
				"RecordValue",
				"Combination",
				"RecordValue",
				"CaseValue",
			])
		})
	})
})

describe("Parser AST", () => {
	it("should keep a Number Literal whole when it is written flush", () => {
		expect(
			declaredValue(firstNode("implementation { constant x = 1_000 }")),
		).toMatchObject({ nodeType: "IntegerValue", value: "1000" })
	})

	it("should span a Combination from brace to brace", () => {
		// The Formatter claims trailing trivia behind the span's braces, so
		// the span must reach the closing brace.
		let node = declaredValue(
			firstNode(
				`implementation { constant a = { base with
	x = 1,
	y = 2
} }`,
			),
		)

		expect(node).toMatchObject({ nodeType: "Combination" })
		expect(node?.position).toEqual({
			start: { line: 1, column: 31 },
			end: { line: 4, column: 2 },
		})
	})

	describe("Member paths", () => {
		it("should refuse a Method call after a path", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { call(.total::rounded()) }",
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("path-is-members-only")
			expect(diagnostics[0].labels[0]?.message).toBe(
				"'::' can not follow a path",
			)
			expect(diagnostics[0].labels[0]?.position).toEqual({
				start: { line: 1, column: 29 },
				end: { line: 1, column: 30 },
			})
		})

		it("should refuse an invocation after a path", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { call(.total()) }",
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("path-is-members-only")
			expect(diagnostics[0].labels[0]?.message).toBe(
				"'(' can not follow a path",
			)
		})

		// Two colons written apart are no `::`, here as anywhere.
		it("should leave a spaced colon pair to the rest of the grammar", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { call(.total : :rounded()) }",
			)

			expect(
				diagnostics.some(
					(diagnostic) => diagnostic.code === "path-is-members-only",
				),
			).toBe(false)
		})

		it("should refuse a brace where a step was expected", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { call(.total.{ a = 1 }) }",
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Expected an Identifier but found '{'.",
			)
		})
	})

	// Where every reading of a text fails, the one that got furthest is
	// reported, not the fallback tried last.
	describe("The furthest reading", () => {
		// The unlabelled reading runs on to the next Statement's `Terminal`.
		// The labelled reading takes `names` for a label and fails at the `::`.
		it("should report a call missing its ')' at the call, not at a label", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
	constant names = ["ada", "alan"]

	Terminal.print(names::map((name) { <- name::length() })

	Terminal.print("after")
}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("syntax-error")
			expect(diagnostics[0].message).toBe(
				"Expected ')' but found 'Terminal'.",
			)
			expect(diagnostics[0].position).toEqual({
				start: { line: 6, column: 2 },
				end: { line: 6, column: 10 },
			})
			expect(diagnostics[0].labels[1]?.message).toBe("opened here")
			expect(diagnostics[0].labels[1]?.position).toEqual({
				start: { line: 4, column: 16 },
				end: { line: 4, column: 17 },
			})
		})

		// The Literal reading meets the stray ')' further down, while the
		// update reading fails at the first member's `=`.
		it("should report a Record's mistake where it stands, not as a missing 'with'", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
	constant game = { moves = 0, carried = ["lamp"] }

	constant turn = {
		game = {
			game with
				moves = game.moves::add(1),
				carried = game.carried::append("key")),
		},
		message = "You take the key.",
	}
}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("syntax-error")
			expect(diagnostics[0].message).toBe("Expected '}' but found ')'.")
			expect(diagnostics[0].position).toEqual({
				start: { line: 8, column: 42 },
				end: { line: 8, column: 43 },
			})
		})

		// Every Diagnostic is listed. The third closes its Record early, so its
		// closing `}` stands after the Program, a second mistake.
		it("should report a mistake inside a Record wherever it stands", () => {
			let members: Array<[string, Array<string>, number]> = [
				[
					"{ x = 1, y = }",
					["Expected an Expression but found '}'."],
					44,
				],
				["{ x = [1, 2, y = 3 }", ["Expected ']' but found '='."], 46],
				[
					"{ x = 1, }, y = 2 }",
					[
						"Expected an Expression but found ','.",
						"Unexpected '}' after the end of the Program",
					],
					41,
				],
			]

			for (let [member, messages, column] of members) {
				let { diagnostics } = parseWithDiagnostics(
					`implementation { constant a = ${member} }`,
				)

				expect(
					diagnostics.map((diagnostic) => diagnostic.message),
				).toEqual(messages)
				expect(diagnostics[0].position?.start.column).toBe(column)
			}
		})

		// Dictionary and List readings are told apart by a Token of lookahead
		// rather than by speculation, so nothing here is read twice.
		it("should report a mistake inside a Dictionary wherever it stands", () => {
			let literals: Array<[string, string]> = [
				[`["x" = 1, "y" = ]`, "Expected an Expression but found ']'."],
				[`["x" = [1, 2, "y" = 3]`, "Expected ']' but found '='."],
				[`[d with "x" = ]`, "Expected an Expression but found ']'."],
			]

			for (let [literal, message] of literals) {
				let { diagnostics } = parseWithDiagnostics(
					`implementation { constant a = ${literal} }`,
				)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].message).toBe(message)
			}
		})

		// A speculation gives `nesting-too-deep` back, so the reading that
		// exhausted the budget is thrown away. As the furthest reading, it is
		// still the one reported.
		it("should report the budget an abandoned reading exhausted", () => {
			let deep = `${"[".repeat(1030)}1${"]".repeat(1030)}`
			let { diagnostics } = parseWithDiagnostics(
				`implementation { constant a = { x = ${deep} } }`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("nesting-too-deep")
		})

		// `refusesTheText` raises a coded refusal out of the speculation, so it
		// outranks a reading that got further.
		it("should leave a coded refusal ahead of the furthest reading", () => {
			let refusals: Array<[string, common.DiagnosticCode]> = [
				["{ x = .5 }", "partial-decimal-literal"],
				[
					"{ found = define { as 1 if flag } }",
					"define-without-otherwise",
				],
				["{ x = .price::rounded() }", "path-is-members-only"],
			]

			for (let [source, code] of refusals) {
				let { diagnostics } = parseWithDiagnostics(
					`implementation { constant a = ${source} }`,
				)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe(code)
			}
		})

		// A reading that held answers for the ones tried beside it, so the
		// failed Literal reading of the braces is not reported.
		it("should not answer a later mistake with a reading that was replaced", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
	constant b = { a with other }::merge(1 2)
}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe("Expected ')' but found '2'.")
			expect(diagnostics[0].position?.start.line).toBe(2)
		})

		// A Statement that was read answers for its abandoned readings, so the
		// second Statement's own failure is reported.
		it("should not answer one Statement with a reading thrown away for another", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
	constant a = { x = 1, y = 2 }
	constant b = ]
}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Expected an Expression but found ']'.",
			)
			expect(diagnostics[0].position?.start.line).toBe(3)
		})
	})

	// A missing bracket is noticed at the first Token that can not carry its
	// contents on, often lines away. An "opened here" Label points back, unless
	// the pair is on one line.
	describe("An unclosed bracket", () => {
		it("should point at the '(' a call never closed", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
	constant total = Math.sum(
		1,
		2
	Terminal.print(total)
}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].code).toBe("syntax-error")
			expect(diagnostics[0].message).toBe(
				"Expected ')' but found 'Terminal'.",
			)
			expect(diagnostics[0].labels).toHaveLength(2)
			expect(diagnostics[0].labels[1]?.kind).toBe("secondary")
			expect(diagnostics[0].labels[1]?.message).toBe("opened here")
			expect(diagnostics[0].labels[1]?.position).toEqual({
				start: { line: 2, column: 27 },
				end: { line: 2, column: 28 },
			})
		})

		it("should point at the '[' a List never closed", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
	constant names = [
		"ada",
		"alan"
	Terminal.print(names)
}`,
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe(
				"Expected ']' but found 'Terminal'.",
			)
			expect(diagnostics[0].labels[1]?.message).toBe("opened here")
			expect(diagnostics[0].labels[1]?.position).toEqual({
				start: { line: 2, column: 19 },
				end: { line: 2, column: 20 },
			})
		})

		// On one line the Diagnostic keeps one Label. The mistake is a missing
		// comma, since `1 + 2` would be `operator-not-supported`.
		it("should stay silent about a bracket on the line of the mistake", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { Terminal.print(1 2) }",
			)

			expect(diagnostics).toHaveLength(1)
			expect(diagnostics[0].message).toBe("Expected ')' but found '2'.")
			expect(diagnostics[0].labels).toHaveLength(1)
		})
	})

	it("should span an Expression Combination from brace to brace", () => {
		let node = declaredValue(
			firstNode("implementation { constant a = { base with other } }"),
		)

		expect(node).toMatchObject({ nodeType: "Combination" })
		expect(node?.position).toEqual({
			start: { line: 1, column: 31 },
			end: { line: 1, column: 50 },
		})
	})

	// Helps that spell the reader's own text rather than an example, which
	// would name something the file does not declare. Each Help is written back
	// into its probe and compiled.
	describe("Helps built from the text that was written", () => {
		it("spells the reader's own path and call in the Function literal", () => {
			let source = `implementation {
	constant names = [{ title = "Ada" }]::map(.title::uppercase())
	Terminal.inspect(names)
}`

			expect(helpsOf(source)).toEqual([
				"Write the Function literal instead: '(_ item) { <- item.title::uppercase() }'.",
			])
			expect(
				compiles(`implementation {
	constant names = [{ title = "Ada" }]::map((_ item) { <- item.title::uppercase() })
	Terminal.inspect(names)
}`),
			).toBe(true)
		})

		// A literal handed to a Method reads its Parameter's Type off the
		// position, so the offered literal needs no annotation.
		it("leaves the offered literal's Parameter unannotated", () => {
			expect(
				helpsOf("implementation { call(.total::rounded()) }"),
			).toEqual([
				"Write the Function literal instead: '(_ item) { <- item.total::rounded() }'.",
			])
		})

		// Outside an Argument list nothing hands the literal its Types, so the
		// Help spells them as holes, as `path-without-context` does.
		it("spells both Types where the path stands in no Argument list", () => {
			let source = `implementation {
	constant orders = [{ order = { total = 1 } }]
	constant reach = .order.total::toString()
	Terminal.inspect(orders)
}`

			expect(helpsOf(source)).toEqual([
				"Write the Function literal instead, with the Parameter and return Types a path leaves out — '(_ item: <Type>) -> <Type> { <- item.order.total::toString() }', filling each '<Type>' in.",
			])
			expect(
				compiles(`implementation {
	constant orders = [{ order = { total = 1 } }]
	constant reach = (_ item: { order: { total: Integer } }) -> String { <- item.order.total::toString() }
	Terminal.inspect(orders)
}`),
			).toBe(true)
		})

		it("prints the Argument a called path was written with", () => {
			expect(helpsOf("implementation { call(.total(2)) }")).toEqual([
				"Write the Function literal instead: '(_ item) { <- item.total(2) }'.",
			])
		})

		// `(n: Integer)` would declare a labelled Parameter, which an unlabelled
		// call refuses.
		it("writes the arrow literal's Parameter unlabelled", () => {
			let source = `implementation {
	constant double = (n: Integer) => n
	Terminal.inspect(double(2))
}`

			expect(helpsOf(source)).toEqual([
				"Write '(_ n: Integer) -> Integer { <- n }'.",
			])
			expect(
				compiles(`implementation {
	constant double = (_ n: Integer) -> Integer { <- n }
	Terminal.inspect(double(2))
}`),
			).toBe(true)
		})

		// A `=>` behind a String or a Number is a hash rocket, since no
		// Parameter list is a Literal.
		it("answers a hash rocket as the Dictionary entry it is", () => {
			let source = `implementation {
	constant ages = ["kim" => 7, "ada" => 36]
	Terminal.inspect(ages)
}`
			let { diagnostics } = parseWithDiagnostics(source)

			expect(diagnostics[0]?.code).toBe("dictionary-entry-syntax")
			expect(diagnostics[0]?.helps).toEqual([
				"Write '=' in place of '=>'.",
			])
			expect(
				compiles(`implementation {
	constant ages = ["kim" = 7, "ada" = 36]
	Terminal.inspect(ages)
}`),
			).toBe(true)
		})

		// `x => x` is a Function in one language and a key in another, so a
		// name on the left keeps the Function literal answer.
		it("leaves a named left operand to the Function literal", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { constant ages = [key => 7] }",
			)

			expect(diagnostics[0]?.code).toBe("foreign-syntax")
			expect(diagnostics[0]?.message).toBe(
				"A Function literal has no '=>'",
			)
		})

		// Dropping an only key would leave `{ config with }`, so the Help says
		// to drop the update too.
		it("names the value an only descend would leave behind", () => {
			let source = `implementation {
	constant config = { server = { port = 80 } }
	constant same = { config with server.{ } }
	Terminal.inspect(same)
}`

			expect(helpsOf(source)).toEqual([
				"Write the members to update inside it.",
				"Or drop the key — and where it is the only one, drop the update with it and write 'config' on its own.",
			])
			expect(
				compiles(`implementation {
	constant config = { server = { port = 80 } }
	constant same = config
	Terminal.inspect(same)
}`),
			).toBe(true)
		})

		// The offered Record holds every bare key, so following one report
		// drops no other key.
		it("gathers every bare key into the Record it offers", () => {
			let source = `implementation {
	constant base = { port = 80, host = "localhost" }
	constant port = 8080
	constant host = "example.com"
	constant server = { base with port, host }
	Terminal.inspect(server)
}`
			let merged =
				"Or merge a whole Record: '{ base with { port, host } }'."

			expect(helpsOf(source)).toEqual([
				"Write 'port = port'.",
				merged,
				"Write 'host = host'.",
				merged,
			])
			expect(
				compiles(`implementation {
	constant base = { port = 80, host = "localhost" }
	constant port = 8080
	constant host = "example.com"
	constant server = { base with { port, host } }
	Terminal.inspect(server)
}`),
			).toBe(true)
		})

		// The Help and the Quick Fix read one computation, so both offer the
		// value written.
		it("offers the value the two mixed spellings say between them", () => {
			expect(helpsOf("implementation { constant a = 1.5/2 }")).toEqual([
				"Write it as '3/4' — or as '0.75', which is the same value written the other way.",
			])
			expect(helpsOf("implementation { constant a = 2.5/3 }")).toEqual([
				"Write it as '5/6', which is the value the two spellings say between them.",
			])
		})

		// A trailing comma is dropped. A second value can not be, so the Help
		// offers one Record under the Case the reader wrote.
		it("tells a trailing comma from a second payload", () => {
			expect(
				helpsOf("implementation { constant x = Optional#Value(1,) }"),
			).toEqual(["Drop the ','."])

			let two = `implementation {
	choice Shape {
		Rect { width: Integer, height: Integer },
		Dot,
	}

	constant s: Shape = #Rect(2, 3)
	Terminal.inspect(s)
}`

			expect(helpsOf(two)).toEqual([
				"Carry the values as one Record: '#Rect({ … })', with a member for each of them.",
			])
			expect(
				compiles(`implementation {
	choice Shape {
		Rect { width: Integer, height: Integer },
		Dot,
	}

	constant s: Shape = #Rect({ width = 2, height = 3 })
	Terminal.inspect(s)
}`),
			).toBe(true)
		})

		// The literal is often passed to nothing, or to a standard library
		// Method, so the Help is the Quick Fix's removal.
		it("offers the removal the Quick Fix makes", () => {
			let source = `implementation {
	constant double = (_ number: Integer = 1) -> Integer { <- number::multiply(with 2) }
	Terminal.inspect(double(2))
}`

			expect(helpsOf(source)).toEqual(["Remove the default."])
			expect(
				compiles(`implementation {
	constant double = (_ number: Integer) -> Integer { <- number::multiply(with 2) }
	Terminal.inspect(double(2))
}`),
			).toBe(true)
		})
	})
})
