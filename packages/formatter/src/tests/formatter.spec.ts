import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import * as path from "node:path"

import { fixturePath } from "@essence-lang/fixtures"
import { readStdlibFiles } from "@essence-lang/stdlib"

import { format, guarded } from "../index"
import { commentAnchors } from "../trivia"

// NOTE: Every `.es` source in the repository, which is what a formatter has to
// survive before it is allowed anywhere near a source tree. The Diagnostic
// showcase files are included deliberately: six of the seven parse perfectly
// well and only fail later, so a formatter must handle them like any other
// file, and the seventh is the one file here that must be refused.
function corpus(): Array<{ name: string; filePath: string; source: string }> {
	let files = readStdlibFiles().map((file) => ({
		name: "stdlib/" + path.basename(file.filePath),
		filePath: file.filePath,
		source: file.sourceText,
	}))

	// NOTE: Every fixture directory, walked rather than listed: the Module
	// fixtures live in subdirectories of their own — a Module Diagnostic takes
	// more than one file to provoke — and a directory nobody thought to add
	// here would be a corner of the repository the formatter is never held to.
	for (let filePath of essenceFilesUnder(fixturePath())) {
		files.push({
			name: path.relative(fixturePath(), filePath),
			filePath,
			source: readFileSync(filePath, "utf8"),
		})
	}

	return files
}

function essenceFilesUnder(directory: string): Array<string> {
	let files: Array<string> = []

	for (let entry of readdirSync(directory).sort()) {
		let filePath = path.join(directory, entry)

		if (statSync(filePath).isDirectory()) {
			files.push(...essenceFilesUnder(filePath))
		} else if (entry.endsWith(".es")) {
			files.push(filePath)
		}
	}

	return files
}

const CORPUS = corpus()

const UNPARSEABLE = new Set(["diagnostics/Syntax.es"])

describe("formatter", () => {
	it("finds the corpus", () => {
		expect(CORPUS.length).toBeGreaterThan(30)
	})

	describe("corpus", () => {
		for (let file of CORPUS) {
			// NOTE: `format` runs the whole safety gate itself — the result
			// parses, means the same thing, kept every Comment, and is stable
			// under a second pass. A refusal here IS the failure.
			it(`formats ${file.name} without refusing`, () => {
				let result = format(file.source, {
					documentPath: file.filePath,
				})

				if (UNPARSEABLE.has(file.name)) {
					expect(result.refusal?.kind).toBe("syntax")
					expect(result.text).toBe(file.source)

					return
				}

				expect(result.refusal).toBeNull()
			})

			it(`is idempotent on ${file.name}`, () => {
				let once = format(file.source, {
					documentPath: file.filePath,
				})
				let twice = format(once.text, { documentPath: file.filePath })

				expect(twice.text).toBe(once.text)
			})
		}
	})

	// NOTE: This is the gate that replaces forcing a formatting pass on every
	// successful compile. The corpus stays canonically formatted because it is
	// checked here, not because the compiler writes to anybody's source tree.
	//
	// The Diagnostic showcase files are exempt: their rendered output is
	// snapshotted line and column exact by `diagnosticShowcase.spec.ts`, so
	// they are shaped for the Diagnostics they produce rather than for style.
	describe("the repository is formatted", () => {
		for (let file of CORPUS) {
			if (
				UNPARSEABLE.has(file.name) ||
				file.name.startsWith("diagnostics/")
			) {
				continue
			}

			it(`${file.name} is already formatted`, () => {
				let result = format(file.source, {
					documentPath: file.filePath,
				})

				expect(result.refusal).toBeNull()
				expect(result.changed).toBe(false)
			})
		}
	})

	// NOTE: A Case Matcher's payload binding is part of the Matcher, so it has
	// to survive the round trip AND be measured as part of the Matcher's width
	// by the case-brace alignment. The safety gate compares ASTs, so a dropped
	// binding would be a refusal rather than silent data loss — but a refusal on
	// ordinary source is itself the bug.
	describe("Case Matcher payload bindings", () => {
		it("round-trips a binding and aligns the braces past it", () => {
			let source = [
				"implementation {",
				"\tchoice Shape {",
				"\t\tCircle { radius: Integer },",
				"\t\tDot,",
				"\t}",
				"",
				"\tconstant drawn: Shape = #Circle(3)",
				"",
				"\t__print(match drawn -> Integer {",
				"\t\tcase #Circle(radius) { <- radius }",
				"\t\tcase #Dot            { <- 0 }",
				"\t})",
				"}",
				"",
			].join("\n")

			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		})

		it("is idempotent over a binding", () => {
			let source = [
				"implementation {",
				"\tchoice Held { Item { value: Integer } }",
				"",
				"\tconstant held: Held = #Item(1)",
				"",
				"\t__print(match held -> Integer {",
				"\t\tcase #Item(value) { <- value }",
				"\t})",
				"}",
				"",
			].join("\n")

			let once = format(source)
			let twice = format(once.text)

			expect(once.refusal).toBeNull()
			expect(twice.text).toBe(once.text)
		})
	})

	describe("refuses what it cannot format", () => {
		it("leaves a file with syntax errors byte for byte alone", () => {
			let source = "implementation {\n\tconstant = = =\n}\n"
			let result = format(source)

			expect(result.refusal?.kind).toBe("syntax")
			expect(result.changed).toBe(false)
			expect(result.text).toBe(source)
		})

		it("reports the parser's own diagnostics with the refusal", () => {
			let result = format("implementation {\n\tconstant = = =\n}\n")

			expect(result.refusal?.diagnostics.length).toBeGreaterThan(0)
		})

		// NOTE: `guarded` is the wrapper `format` runs inside; no reachable
		// source crashes the printer today, so the catch path is exercised
		// through the seam directly.
		it("turns an unexpected crash into a refusal with the original bytes", () => {
			let source = "implementation {\n\tconstant a = 1\n}\n"
			let result = guarded(source, () => {
				throw new Error("boom")
			})

			expect(result.refusal?.kind).toBe("unsafe")
			expect(result.refusal?.message).toContain("boom")
			expect(result.changed).toBe(false)
			expect(result.text).toBe(source)
		})
	})

	// NOTE: A String's own text is written back from the source byte for byte —
	// its escapes are decoded in the AST, so only the source still holds it as
	// it was written — while what is inside a hole is code, and is printed like
	// any other Expression.
	describe("string interpolation", () => {
		let roundTrips = (line: string) => {
			let source = `implementation {\n\t${line}\n}\n`
			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toContain(line)
		}

		it("leaves a hole that is already canonical alone", () => {
			roundTrips('__print("Hello, {name}! {count} left")')
		})

		it("leaves escapes and literal braces untouched", () => {
			roundTrips('__print("a \\"b\\" \\\\ \\{c\\}")')
		})

		it("leaves a nested interpolation alone", () => {
			roundTrips('__print("outer {"inner {name}"}")')
		})

		// NOTE: A hole holds an Expression, not text, so it is formatted like
		// one — the String's own text around it is what stays as written.
		it("formats the code inside a hole", () => {
			expect(
				format('implementation {\n\t__print("sum {1::add( 2 )}")\n}\n')
					.text,
			).toContain('"sum {1::add(2)}"')
		})

		// NOTE: The padding between a brace and what it holds is inside the
		// hole, which makes it layout rather than a character of the String, so
		// a hole has one spelling however it was typed.
		it("closes the braces up against what the hole holds", () => {
			expect(
				format(
					'implementation {\n\tconstant name = "x"\n\t__print("a { name } b { name}c")\n}\n',
				).text,
			).toContain('"a {name} b {name}c"')
		})

		// NOTE: An escaped brace is a character of the String, not a hole, so
		// the text around it is left exactly as written — only the padding of a
		// real hole is closed up.
		it("leaves an escaped brace and the text around it alone", () => {
			expect(
				format(
					'implementation {\n\tconstant name = "x"\n\t__print("pre \\{ lit \\} post { name } tail")\n}\n',
				).text,
			).toContain('"pre \\{ lit \\} post {name} tail"')
		})

		// NOTE: The reason this was worth doing. A `match` written into a hole
		// used to keep whatever shape it was first typed with, Handler alignment
		// and all, because the whole String was reprinted verbatim.
		it("lays out and aligns a match written into a hole", () => {
			let result = format(
				"implementation {\n" +
					"\tconstant a: Integer | Rational = 1/2\n" +
					'\t__print("n: {match a -> String {\n' +
					'case Integer { <- "whole" }\n' +
					'\t\t\t\tcase Rational { <- "fraction" }\n' +
					'}}")\n' +
					"}\n",
			)

			expect(result.refusal).toBeNull()
			expect(result.text).toContain(
				'\t\t\tcase Integer  { <- "whole" }\n' +
					'\t\t\tcase Rational { <- "fraction" }\n',
			)
		})

		// NOTE: The `=` never breaks away from what it assigns. A String starts
		// on the line its name is written on however long it is, and gives way
		// at a hole further along — the beginning of a value stays where the
		// name that introduced it is.
		it("keeps a long String on the line its name is on", () => {
			let source =
				'implementation {\n\tconstant alpha = 1\n\tconstant sentence = "the quick brown fox {alpha} jumped over the lazy dog now"\n}\n'
			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toContain(
				'\tconstant sentence = "the quick brown fox {',
			)
			expect(result.text).not.toContain("constant sentence =\n")
		})

		// NOTE: A value that can give way inside itself does that, for the same
		// reason — an Argument list breaks at its commas rather than moving off
		// the line its name is on.
		it("leaves a value that can break to break inside itself", () => {
			let result = format(
				"implementation {\n\tconstant result = someCall(alpha 1, beta 2, gamma 3, delta 4, epsilon 5, zeta 6)\n}\n",
			)

			expect(result.text).toContain("constant result = someCall(\n")
		})

		// NOTE: A String with no hole has nothing to give — its text can not
		// carry a break — so it is left over the line rather than moved down to
		// buy one indent's worth of room.
		it("leaves a long String with no hole where it is", () => {
			let result = format(
				'implementation {\n\tconstant sentence = "the quick brown fox jumped over the very lazy dog and away"\n}\n',
			)

			expect(result.refusal).toBeNull()
			expect(result.text).toContain(
				'\tconstant sentence = "the quick brown fox jumped over the very lazy dog and away"',
			)
		})

		// NOTE: A hole is the only break a String has to offer — the padding
		// inside its braces is layout, while a newline in the text either side
		// would be a character. This is the shape a String too long for its line
		// gives way in, and the text on either side stays whole.
		it("breaks a String too long for its line at one of its holes", () => {
			let result = format(
				'implementation {\n\tfunction f() -> String {\n\t\t<- "the quick brown fox {alpha} jumped over the lazy dog {beta} and away"\n\t}\n}\n',
			)

			expect(result.refusal).toBeNull()
			expect(result.text).toContain(
				'<- "the quick brown fox {alpha} jumped over the lazy dog {\n' +
					"\t\t\tbeta\n" +
					'\t\t} and away"',
			)
		})

		// NOTE: Only as far as it has to — the holes that still fit are left
		// closed up, so a String gives way at one place rather than every place.
		it("breaks only the holes it has to", () => {
			let result = format(
				'implementation {\n\tfunction f() -> String {\n\t\t<- "the quick brown fox {alpha} jumped over the lazy dog {beta} and away"\n\t}\n}\n',
			)

			expect(result.text).toContain("{alpha}")
		})

		// NOTE: The hole that gives is the one the line runs out at, so the text
		// before it — the part a reader starts on — keeps as much of the line as
		// it can.
		it("gives way at the hole the line runs out at", () => {
			let result = format(
				'implementation {\n\tconstant alpha = 1\n\tconstant beta = 2\n\tconstant sentence = "the quick brown fox {alpha} jumped over the very lazy dog {beta} and then away again"\n}\n',
			)

			expect(result.refusal).toBeNull()
			expect(result.text).toContain(
				'constant sentence = "the quick brown fox {\n' +
					"\t\talpha\n" +
					'\t} jumped over the very lazy dog {beta} and then away again"',
			)
		})
	})

	describe("layout", () => {
		let formatted = (source: string) => format(source).text

		it("normalises indentation to tabs and collapses runs of blank lines", () => {
			expect(
				formatted(
					"implementation {\n    constant a = 1\n\n\n\n    constant b = 2\n}\n",
				),
			).toBe(
				"implementation {\n\tconstant a = 1\n\n\tconstant b = 2\n}\n",
			)
		})

		it("keeps a blank line the author wrote", () => {
			expect(
				formatted(
					"implementation {\n\tconstant a = 1\n\n\tconstant b = 2\n}\n",
				),
			).toBe(
				"implementation {\n\tconstant a = 1\n\n\tconstant b = 2\n}\n",
			)
		})

		// NOTE: An `if` body always opens a block, however short it is. The
		// corpus writes nine inline ones against a hundred inline `case`
		// bodies, and a half-flat `else if` chain — one arm on the `if`'s line,
		// the next opening a block — reads worse than either shape alone.
		it("always breaks an if body, however short", () => {
			expect(
				formatted(
					"implementation {\n\tfunction f(_ a: Boolean) -> Integer {\n\t\tif a { <- 1 } else { <- 2 }\n\t}\n}\n",
				),
			).toBe(
				"implementation {\n\tfunction f(_ a: Boolean) -> Integer {\n\t\tif a {\n\t\t\t<- 1\n\t\t} else {\n\t\t\t<- 2\n\t\t}\n\t}\n}\n",
			)
		})

		// NOTE: The opposite rule for `case`, which is how the corpus writes a
		// `match` throughout — a hundred of them — and expanding each to three
		// lines would triple the size of every one.
		it("keeps a short case body on one line", () => {
			let source =
				'implementation {\n\tconstant a: Integer | Nothing = 1\n\n\tconstant b = match a -> String {\n\t\tcase Nothing { <- "none" }\n\t\tcase Integer { <- @::toString() }\n\t}\n}\n'

			expect(formatted(source)).toBe(source)
		})

		it("breaks a case body that does not fit", () => {
			let source =
				'implementation {\n\tconstant a: Integer | Nothing = 1\n\n\tconstant b = match a -> String {\n\t\tcase Nothing { <- "nooooooooooooooooooooooooooooooooooooooooooooooooooone" }\n\t\tcase Integer { <- @::toString() }\n\t}\n}\n'

			expect(formatted(source)).toContain(
				'case Nothing {\n\t\t\t<- "nooo',
			)
		})

		// NOTE: The corpus was written this way by hand in seven places and had
		// drifted in the rest — `Protocols.es` aligned the first two Cases of
		// four and gave up. Deriving it makes the whole `match` line up.
		describe("case body alignment", () => {
			let bracesOf = (source: string) =>
				formatted(source)
					.split("\n")
					.filter((sourceLine) => sourceLine.includes("case "))
					.map((sourceLine) => sourceLine.indexOf("{"))

			let match = (...cases: Array<string>) =>
				"implementation {\n\tconstant a: Integer | Rational = 1/2\n\n\tconstant b = match a -> String {\n" +
				cases.map((entry) => "\t\t" + entry + "\n").join("") +
				"\t}\n}\n"

			it("lines up the braces of a run of cases", () => {
				expect(
					bracesOf(
						match(
							'case Integer { <- "whole" }',
							'case Rational { <- "fraction" }',
						),
					),
				).toEqual([16, 16])
			})

			// NOTE: A `where` clause is an arbitrary Expression, and usually the
			// longest thing in the `match` — padding every sibling out to it
			// would push the braces right rather than line them up.
			it("leaves a guarded case out of the run", () => {
				let braces = bracesOf(
					match(
						'case Integer where @::isGreaterThan(100) { <- "big" }',
						'case Integer { <- "whole" }',
						'case Rational { <- "fraction" }',
					),
				)

				expect(braces[0]).toBe(43)
				expect(braces[1]).toBe(16)
				expect(braces[2]).toBe(16)
			})

			it("does not pad a run of one", () => {
				expect(
					formatted(
						match(
							'case Integer { <- "whole" }',
							"case _ { <- @::toString() }",
						),
					),
				).toContain("case Integer { ")
			})

			// NOTE: A Handler that breaks still opens its brace right after its
			// Matcher, so it keeps its place in the column.
			it("keeps the column when a case in the middle breaks", () => {
				expect(
					bracesOf(
						match(
							'case Nothing { <- "x" }',
							'case Integer { <- "a very long body that will certainly not fit on one line" }',
							'case Rational { <- "y" }',
						),
					),
				).toEqual([16, 16, 16])
			})

			it("is stable under a second pass", () => {
				let source = match(
					'case Integer { <- "whole" }',
					'case Rational { <- "fraction" }',
				)
				let once = format(source)

				expect(format(once.text).changed).toBe(false)
			})
		})

		// NOTE: The same alignment the corpus was given for `match` Handlers,
		// carried to the `=` of a run of adjacent Declarations — the one place a
		// column lines something up outside a `match`.
		describe("assignment alignment", () => {
			let equalsOf = (source: string) =>
				formatted(source)
					.split("\n")
					.filter((sourceLine) => sourceLine.includes(" = "))
					.map((sourceLine) => sourceLine.indexOf("="))

			let block = (...lines: Array<string>) =>
				"implementation {\n" +
				lines.map((entry) => "\t" + entry + "\n").join("") +
				"}\n"

			it("lines up the equals signs of a run of declarations", () => {
				expect(
					equalsOf(block("constant a = 1", "constant bbbb = 2")),
				).toEqual([15, 15])
			})

			it("measures the type annotation into the column", () => {
				expect(
					formatted(
						block("constant a: Integer = 1", "constant b = 2"),
					),
				).toBe(
					"implementation {\n\tconstant a: Integer = 1\n\tconstant b          = 2\n}\n",
				)
			})

			it("does not align a run of one", () => {
				expect(
					formatted(block("constant a = 1", "__print(a)")),
				).toContain("constant a = 1")
			})

			// NOTE: A blank line is how the author says two groups of Declarations
			// are not one, so the column stops at it.
			it("starts a new column after a blank line", () => {
				expect(
					equalsOf(
						block(
							"constant a = 1",
							"constant bbbb = 2",
							"",
							"constant cc = 3",
							"constant d = 4",
						),
					),
				).toEqual([15, 15, 13, 13])
			})

			// NOTE: A value that lays itself out over several lines is left out of
			// the run, the same as a guarded `case` — it would drag the column
			// past everything around it.
			it("leaves a multi-line value out of the run", () => {
				let equals = equalsOf(
					block(
						"constant a = 1",
						"constant bbbb = 2",
						'constant m = match a -> String {\n\t\tcase _ { <- "x" }\n\t}',
					),
				)

				expect(equals[0]).toBe(15)
				expect(equals[1]).toBe(15)
			})

			// NOTE: A reassignment writes no keyword, so padding it out to a
			// Declaration would leave a keyword's worth of empty column mid-run.
			it("keeps a declaration and a bare reassignment in separate runs", () => {
				expect(
					equalsOf(
						block("variable aaaaaa = 1", "aaaaaa = 2", "bb = 3"),
					),
				).toEqual([17, 8, 8])
			})

			// NOTE: A run whose heads span more than the padding budget is split
			// into blocks that each line up on their own `=`, rather than forced
			// to one column that a single long typed Declaration would drag right.
			// Here a group of short Declarations, a pair of medium ones and a pair
			// of wide ones each line up among themselves.
			it("splits a run into blocks that each line up", () => {
				expect(
					equalsOf(
						block(
							"constant greeting = 1",
							"constant emptyText = 2",
							"constant numbers = 3",
							"constant singleNumber = 4",
							"constant noNumbers: List<Integer> = 5",
							"constant noRationals: List<Rational> = 6",
							"constant noMixedNumbers: List<Integer | Rational> = 7",
							"constant noNestedNumbers: List<List<Integer>> = 8",
						),
					),
				).toEqual([23, 23, 23, 23, 38, 38, 51, 51])
			})

			// NOTE: A head far wider than its neighbours starts its own block, so
			// it lines up with nothing and drags no sibling's `=` out to meet it. A
			// short Declaration on either side of it lands in a block of its own
			// too, and a block of one is left unpadded.
			it("gives a wide declaration between short ones its own block", () => {
				expect(
					equalsOf(
						block(
							"constant a = 1",
							"constant longFieldName: List<Integer | Rational> = 2",
							"constant bb = 3",
						),
					),
				).toEqual([12, 50, 13])
			})

			// NOTE: Heads of a similar width belong to one block — a run of
			// uniformly long Declarations lines up like any other.
			it("aligns a run of uniformly long heads", () => {
				expect(
					equalsOf(
						block(
							"constant firstThing: Ordering = 1",
							"constant secondThing: Ordering = 2",
							"constant thirdThing: Ordering = 3",
						),
					),
				).toEqual([32, 32, 32])
			})

			it("is stable under a second pass", () => {
				let once = format(block("constant a = 1", "constant bbbb = 2"))

				expect(format(once.text).changed).toBe(false)
			})
		})

		it("removes a blank line before a closing brace", () => {
			expect(formatted("implementation {\n\tconstant a = 1\n\n}\n")).toBe(
				"implementation {\n\tconstant a = 1\n}\n",
			)
		})

		// NOTE: Only the outermost list that has to break does. Once `__print(`
		// is broken its Argument starts a level in, where it fits on one line —
		// breaking the inner call as well would be gratuitous.
		it("breaks the outermost argument list that does not fit, and no more", () => {
			let source =
				'implementation {\n\t__print("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"::append("bbbbbbbbbbbbbbbbbbbbbbbbbb"))\n}\n'

			expect(formatted(source)).toBe(
				'implementation {\n\t__print(\n\t\t"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"::append("bbbbbbbbbbbbbbbbbbbbbbbbbb"),\n\t)\n}\n',
			)
		})

		// NOTE: A bare `@` is too small to hold a line of its own, so the first
		// link of a broken chain stays fused to it.
		it("keeps the first link of a broken chain on a bare @'s line", () => {
			let source =
				"implementation {\n\tconstant a: Integer | Nothing = 1\n\n\tconstant b = match a -> Boolean {\n\t\tcase Nothing { <- false }\n\t\tcase Integer {\n\t\t\t<- @\n\t\t\t\t::isGreaterThanOrEqualTo(100)\n\t\t\t\t::and(@::isLessThanOrEqualTo(100000))\n\t\t}\n\t}\n}\n"

			expect(formatted(source)).toContain(
				"<- @::isGreaterThanOrEqualTo(100)\n\t\t\t\t::and(@::isLessThanOrEqualTo(100000))",
			)
		})

		// NOTE: The return clause is measured with the Parameter list as one
		// header, so a header that does not fit breaks its Parameters — the
		// return Type follows the `)` whole instead of splitting at a `|` that
		// lands flush with the body.
		it("breaks the parameter list before ever splitting the return type", () => {
			let source =
				"implementation {\n\tconstant minimum = (_ firstNumber: Integer, _ secondNumber: Rational) -> Integer | Rational {\n\t\tif firstNumber::isLessThanOrEqualTo(secondNumber) {\n\t\t\t<- firstNumber\n\t\t} else {\n\t\t\t<- secondNumber\n\t\t}\n\t}\n}\n"

			expect(formatted(source)).toBe(
				"implementation {\n\tconstant minimum = (\n\t\t_ firstNumber: Integer,\n\t\t_ secondNumber: Rational,\n\t) -> Integer | Rational {\n\t\tif firstNumber::isLessThanOrEqualTo(secondNumber) {\n\t\t\t<- firstNumber\n\t\t} else {\n\t\t\t<- secondNumber\n\t\t}\n\t}\n}\n",
			)
		})

		it("adds a trailing comma to a broken argument list", () => {
			let source =
				'implementation {\n\t__print("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")\n}\n'

			expect(formatted(source)).toContain('",\n\t)\n')
		})
	})

	describe("what must never be rewritten", () => {
		let roundTrips = (source: string, fragment: string) => {
			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toContain(fragment)
		}

		// NOTE: The AST normalises `1_000` to `1000`, so a printer that reads
		// the node rather than the source silently deletes the grouping.
		it("keeps a grouped Number's underscores", () => {
			roundTrips(
				"implementation {\n\tconstant a = 1_000_000\n}\n",
				"1_000_000",
			)
		})

		// NOTE: A Rational's three Tokens are one literal only while they are
		// written flush — `1 / 2` is not `1/2`.
		it("keeps a Rational's parts flush", () => {
			roundTrips("implementation {\n\tconstant a = 1/2\n}\n", "1/2")
		})

		// NOTE: Adjacency is what tells `Choice#Case` from an Argument label
		// followed by a bare Case.
		it("keeps a qualified Case flush against its Choice", () => {
			roundTrips(
				"implementation {\n\tchoice C {\n\t\tA,\n\t}\n\n\tconstant a: C = C#A\n}\n",
				"C#A",
			)
		})

		// NOTE: The Type Arguments applied at a construction sit between the
		// Choice's name and its `#`, and every piece of that has to stay flush —
		// a `<` on its own line reads as a new declaration, and a `#` off the `>`
		// is not a construction at all.
		it("keeps an applied Case flush through its Type Arguments", () => {
			roundTrips(
				"implementation {\n\tchoice C<T> {\n\t\tA { value: T },\n\t}\n\n\tconstant a = C<Integer>#A(1)\n}\n",
				"C<Integer>#A(1)",
			)
		})

		// NOTE: FunctionTypeParameter records only the external name, so an
		// internal one exists in the source and nowhere else.
		it("keeps the internal name of a Function Type's parameter", () => {
			roundTrips(
				"implementation {\n\tfunction run(_ body: (_ value: Integer) -> Nothing) -> Nothing {\n\t\t<- nothing\n\t}\n}\n",
				"(_ value: Integer) -> Nothing",
			)
		})

		// NOTE: `Type ~> { a = b }` is one typed Record value; dropping the `~>`
		// still parses, as a constant bound to the Identifier `Type` followed by
		// a bare untyped Record, so only the safety gate noticed — and a gate
		// that refuses is a Format Document that silently does nothing.
		it("keeps the ~> of a typed record literal", () => {
			roundTrips(
				"implementation {\n\tconstant made = Type ~> { member = value }\n}\n",
				"Type ~> { member = value }",
			)
		})

		it("keeps the ~> when the typed record breaks across lines", () => {
			roundTrips(
				"implementation {\n\tconstant made = ConfigurationRecord ~> { firstMemberName = firstValue, secondMemberName = secondValue, thirdMemberName = thirdValue }\n}\n",
				"ConfigurationRecord ~> {\n\t\tfirstMemberName = firstValue,",
			)
		})

		// NOTE: The empty Record took an early return that answered `{}` before
		// the Type prefix was ever built, which lost the Type outright.
		it("keeps the type of an empty typed record literal", () => {
			roundTrips(
				"implementation {\n\tconstant made = Type ~> {}\n}\n",
				"Type ~> {}",
			)
		})

		it("never reflows a comment", () => {
			let divider = "§ ——— String ———————————————————————————————————————"
			let result = format(
				`implementation {\n\t${divider}\n\tconstant a = 1\n}\n`,
			)

			expect(result.text).toContain(divider)
		})

		// NOTE: Documentation attaches to a Declaration by line adjacency, so a
		// blank line inserted here is valid code that silently loses the docs.
		// `format`'s own gate compares the parsed Documentation, which is what
		// makes this checkable at all.
		it("never separates a documentation block from what it documents", () => {
			let source =
				"implementation {\n\t§§ Doc.\n\tfunction f() -> Nothing {\n\t\t<- nothing\n\t}\n}\n"
			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toContain("§§ Doc.\n\tfunction f()")
		})
	})

	describe("comments", () => {
		it("keeps a comment above the statement it was written above", () => {
			expect(
				format("implementation {\n\t§ note\n\tconstant a = 1\n}\n")
					.text,
			).toBe("implementation {\n\t§ note\n\tconstant a = 1\n}\n")
		})

		it("keeps a trailing comment on its own line", () => {
			expect(
				format("implementation {\n\tconstant a = 1 § why\n}\n").text,
			).toBe("implementation {\n\tconstant a = 1 § why\n}\n")
		})

		it("keeps a comment that trails the last statement of a block", () => {
			let source = "implementation {\n\tconstant a = 1\n\t§ dangling\n}\n"

			expect(format(source).text).toBe(source)
		})

		// NOTE: The true body's brace is not the end of the `if … else` node,
		// so bounding it by the false body's first Statement swept the `else`
		// block's leading Comments up into the `if`.
		it("does not pull an else block's comments into the if", () => {
			let source =
				"implementation {\n\tfunction f(_ a: Boolean) -> Integer {\n\t\tif a {\n\t\t\t<- 1\n\t\t} else {\n\t\t\t§ about the else\n\t\t\t<- 2\n\t\t}\n\t}\n}\n"
			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toContain("} else {\n\t\t\t§ about the else")
		})

		// NOTE: The inner `<- box` ends on the same line as the whole
		// Statement, so whichever asked first won — and the printer descends
		// before it asks.
		it("gives a trailing comment to the outermost node on its line", () => {
			let source =
				"implementation {\n\tconstant list = [1]\n\n\t__print(list::map((box) { <- box }))  § note\n}\n"
			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toContain("})) § note")
		})

		// NOTE: A Comment after a `{` belongs to no Statement on either side of
		// the brace, so nothing claimed it — and `takeBefore` stops at a
		// Comment that does not start its line, which stalled every Comment
		// written below it.
		it("keeps a comment that trails an opening brace", () => {
			let source =
				"implementation {\n\tconstant list = [1]\n\n\t__print(list::map((n) { § why\n\t\t<- n\n\t}))\n\n\t§ still here\n\tconstant after = 2\n}\n"
			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toContain("{ § why")
			expect(result.text).toContain("§ still here")
		})

		it("keeps comments written above the program's own keyword", () => {
			let source =
				"§ about the file\n\nimplementation {\n\tconstant a = 1\n}\n"

			expect(format(source).text).toBe(source)
		})
	})

	// NOTE: What the anchor comparison in `format` exists for. Every bug it
	// caught was one the AST comparison and a plain comment-text comparison
	// both passed: each Comment present, in order, and the code meaning the
	// same thing — only the Comments had moved.
	describe("the safety gate", () => {
		it("holds every comment in place among the tokens around it", () => {
			let source =
				"implementation {\n\tfunction f(_ a: Boolean) -> Integer {\n\t\tif a {\n\t\t\t<- 1\n\t\t} else {\n\t\t\t§ about the else\n\t\t\t<- 2\n\t\t}\n\t}\n}\n"
			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(commentAnchors(result.text)).toEqual(commentAnchors(source))
		})

		it("leaves the file alone when it refuses", () => {
			let source = "implementation {\n\tconstant = = =\n}\n"

			expect(format(source).text).toBe(source)
		})
	})
})
