import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import * as path from "node:path"

import { fixturePath } from "@essence-lang/fixtures"
import { readStdlibFiles } from "@essence-lang/standard-library"

import { format, guarded } from "../index"
import { commentAnchors } from "../trivia"

// NOTE: Every `.es` source in the repository, which is what a formatter has to
// survive before it is allowed anywhere near a source tree. The Diagnostic
// showcase files are included deliberately: all but the three in `REFUSED`
// carry no Parser error at all and only fail later, so a formatter must handle
// them like any other file.
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

// NOTE: The showcase files the formatter must REFUSE — every one of them
// carries an error the Parser itself reported, and formatting a file the Parser
// could not read whole is exactly what the gate is there to prevent. Two of them
// genuinely do not parse; the third parses and is refused all the same, because
// a `default-on-function-literal` is an error like any other and the formatter
// asks only whether there were any.
const REFUSED = new Set([
	"diagnostics/Syntax.es",
	"diagnostics/UnclosedString.es",
	"diagnostics/DefaultsSyntax.es",
])

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

				if (REFUSED.has(file.name)) {
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
				REFUSED.has(file.name) ||
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
				"\tTerminal.inspect(match drawn -> Integer {",
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
				"\tTerminal.inspect(match held -> Integer {",
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

	// NOTE: A Pattern takes a value apart, in five written positions. Every one
	// of them is here because the printer reaches each by a different path — a
	// Matcher, a Case payload, a Parameter, and the head of a Declaration —
	// and because the safety gate compares Tokens: a spelling canonicalised
	// anywhere along those paths is not a diff a reader would argue with, it is
	// a refusal to format the file at all.
	describe("Patterns", () => {
		let block = (...lines: Array<string>) =>
			["implementation {", ...lines, "}", ""].join("\n")

		// NOTE: One source per position, each already written the way the
		// printer writes it, so that round-tripping it byte for byte is the
		// whole assertion.
		let positions: Array<[string, string]> = [
			[
				"a Matcher",
				block(
					"\tTerminal.print(match input -> String {",
					'\t\tcase { x = 0, y = 0 }           { <- "the origin" }',
					'\t\tcase { x: Integer, y: Integer } { <- "somewhere else" }',
					'\t\tcase _                          { <- "not a point" }',
					"\t})",
				),
			],
			[
				"a Matcher read by a Guard",
				block(
					"\tTerminal.print(match input -> String {",
					'\t\tcase { x, y } where x::is(y) { <- "on the diagonal" }',
					'\t\tcase _ { <- "elsewhere" }',
					"\t})",
				),
			],
			[
				"a Case payload",
				block(
					"\tTerminal.inspect(match drawn -> Integer {",
					"\t\tcase #Rect({ width, height }) { <- width::multiplyWith(height) }",
					"\t\tcase #Dot                     { <- 0 }",
					"\t})",
				),
			],
			[
				"a Case payload naming the whole value",
				block(
					"\tTerminal.inspect(match drawn -> Integer {",
					"\t\tcase #Rect({ width, height } as box)       { <- box.width }",
					"\t\tcase #Going({ state as { index, total } }) { <- index }",
					"\t})",
				),
			],
			[
				"a Function literal Parameter",
				block(
					"\tconstant first = ({ first, second }) { <- first }",
					"\tconstant whole = ({ first, second } as pair) { <- pair }",
				),
			],
			[
				"a named Function's Parameter",
				block(
					"\tfunction area(of { width, height }: Rectangle) -> Integer {",
					"\t\t<- width::multiplyWith(height)",
					"\t}",
					"",
					"\tfunction span(_ { width, height }: Rectangle) -> Integer {",
					"\t\t<- width",
					"\t}",
					"",
					"\tfunction edge({ width, height }: Rectangle) -> Integer {",
					"\t\t<- height",
					"\t}",
				),
			],
			[
				"a Declaration",
				block(
					"\tconstant { matching, rest } = list::partition(where predicate)",
					"\tconstant { width, height } as size: Rectangle = rect",
					"\tvariable { index, total } = state",
				),
			],
			[
				"a nested Declaration",
				block("\tconstant { origin as { x, y } } = shape"),
			],
		]

		for (let [name, source] of positions) {
			it(`round-trips a Pattern in ${name}`, () => {
				let result = format(source)

				expect(result.refusal).toBeNull()
				expect(result.text).toBe(source)
			})

			it(`is idempotent over a Pattern in ${name}`, () => {
				let once = format(source)
				let twice = format(once.text)

				expect(once.refusal).toBeNull()
				expect(twice.text).toBe(once.text)
			})
		}

		// NOTE: Declaration position has no alignment column at stake, so a
		// Pattern there lays itself out like the Record Type it reads as — one
		// member to a line, with the trailing comma every broken list gets.
		describe("in Declaration position", () => {
			it("breaks a Pattern too wide for its line", () => {
				let source = block(
					"\tconstant { firstMemberName, secondMemberName, thirdMemberName, fourthMember } = record",
				)

				expect(format(source).text).toBe(
					block(
						"\tconstant {",
						"\t\tfirstMemberName,",
						"\t\tsecondMemberName,",
						"\t\tthirdMemberName,",
						"\t\tfourthMember,",
						"\t} = record",
					),
				)
			})

			it("is idempotent over a broken Pattern", () => {
				let once = format(
					block(
						"\tconstant { firstMemberName, secondMemberName, thirdMemberName, fourthMember } = record",
					),
				)

				expect(once.refusal).toBeNull()
				expect(format(once.text).text).toBe(once.text)
			})

			it("breaks a nested Pattern with the Pattern that holds it", () => {
				let source = block(
					"\tconstant { origin as { horizontal, vertical }, extent as { width, height } } = shape",
				)

				expect(format(source).text).toBe(
					block(
						"\tconstant {",
						"\t\torigin as { horizontal, vertical },",
						"\t\textent as { width, height },",
						"\t} = shape",
					),
				)
			})

			// NOTE: A Pattern head reports no width, which ends its alignment
			// run — two of a similar width padded to one column could each then
			// break, leaving the padding they were given stranded after their
			// closing braces.
			it("never pads a Pattern head out to a sibling's column", () => {
				let source = block(
					"\tconstant { alpha, beta } = first",
					"\tconstant { gamma, delta } = second",
				)

				expect(format(source).text).toBe(source)
			})

			it("ends the run around it rather than dragging its neighbours", () => {
				let source = block(
					"\tconstant a = 1",
					"\tconstant { x, y } = point",
					"\tconstant bbbb = 2",
				)

				expect(format(source).text).toBe(source)
			})
		})

		// NOTE: A Matcher's Pattern is never broken. `printMatch` measures a
		// Matcher from its FLAT width and admits the Handler to a brace
		// alignment run without asking whether the Matcher can break — so one
		// that broke would drop the run's padding after its own closing brace,
		// and every short sibling would be padded out to a column that no
		// longer means anything.
		describe("in Matcher position", () => {
			// NOTE: The LAST brace of the line, unlike the `match` alignment's
			// own helper above: a Pattern opens a brace of its own, and the
			// column being measured is the one the Handler's body opens in.
			let bracesOf = (source: string) =>
				format(source)
					.text.split("\n")
					.filter((sourceLine) => sourceLine.includes("case "))
					.map((sourceLine) => sourceLine.lastIndexOf("{"))

			it("lines a Pattern up with a short sibling arm", () => {
				expect(
					bracesOf(
						block(
							"\tTerminal.print(match input -> String {",
							'\t\tcase { x: Integer, y: Integer } { <- "a point" }',
							'\t\tcase _ { <- "elsewhere" }',
							"\t})",
						),
					),
				).toEqual([34, 34])
			})

			// NOTE: The width at which a breakable Pattern would give way. It
			// stays on one line instead, which leaves the alignment column
			// where the Matchers are — the arms give way in their bodies, the
			// way every arm too wide for its line does.
			it("keeps a wide Pattern and its short sibling's on one line", () => {
				let text = format(
					block(
						"\tTerminal.print(match input -> String {",
						'\t\tcase { horizontal: Integer, vertical: Integer, depth: Integer, time: Integer } { <- "in space" }',
						'\t\tcase { x: Integer } { <- "flat" }',
						'\t\tcase _ { <- "elsewhere" }',
						"\t})",
					),
				).text

				expect(text).toContain(
					"\t\tcase { horizontal: Integer, vertical: Integer, depth: Integer, time: Integer } {\n",
				)
				expect(text).toContain("\t\tcase { x: Integer }")
				expect(text).not.toContain("\t\tcase {\n")
			})

			// NOTE: A Type inside a Matcher's Pattern is flattened with it. A
			// Union is the one Type that would otherwise offer the group a
			// break, and it would cost the same column.
			it("keeps a Union written inside a Matcher's Pattern flat", () => {
				let source = block(
					"\tTerminal.print(match input -> String {",
					'\t\tcase { value: Integer | Rational | String | Boolean, other: Integer } { <- "x" }',
					'\t\tcase _ { <- "y" }',
					"\t})",
				)
				let result = format(source)

				expect(result.refusal).toBeNull()
				expect(result.text).toContain(
					"\t\tcase { value: Integer | Rational | String | Boolean, other: Integer } {\n",
				)
			})

			it("is idempotent over a wide Pattern beside a short arm", () => {
				let once = format(
					block(
						"\tTerminal.print(match input -> String {",
						'\t\tcase { horizontal: Integer, vertical: Integer, depth: Integer, time: Integer } { <- "in space" }',
						'\t\tcase { x: Integer } { <- "flat" }',
						'\t\tcase _ { <- "elsewhere" }',
						"\t})",
					),
				)

				expect(once.refusal).toBeNull()
				expect(format(once.text).text).toBe(once.text)
			})
		})

		// NOTE: `as` is an ordinary Identifier everywhere it is not a Keyword,
		// so a member may be CALLED `as` — `{ as }` binds it, `{ as as as }`
		// binds it under that name, and `{ as as { … } }` takes it apart. The
		// printer writes the name it was given without ever asking what it
		// spells.
		describe("a member named as", () => {
			let source = block(
				"\tconstant { as } = record",
				"\tconstant { as as as } = record",
				"\tconstant { as as { index, total } } = record",
			)

			it("round-trips every spelling of it", () => {
				let result = format(source)

				expect(result.refusal).toBeNull()
				expect(result.text).toBe(source)
			})

			it("is idempotent over it", () => {
				let once = format(source)

				expect(once.refusal).toBeNull()
				expect(format(once.text).text).toBe(once.text)
			})
		})

		// NOTE: Parameter position has no alignment column at stake either, so
		// a Pattern there breaks like the one in a Declaration — and the
		// Parameter list around it breaks first, since a Parameter that fits on
		// a line of its own is the cheaper break.
		describe("in Parameter position", () => {
			let source = block(
				"\tfunction area(of { horizontal, vertical, depth, timeIndex, weight }: Box) -> Integer {",
				"\t\t<- horizontal",
				"\t}",
			)

			it("breaks the Parameter list around a wide Pattern", () => {
				expect(format(source).text).toBe(
					block(
						"\tfunction area(",
						"\t\tof { horizontal, vertical, depth, timeIndex, weight }: Box,",
						"\t) -> Integer {",
						"\t\t<- horizontal",
						"\t}",
					),
				)
			})

			it("is idempotent over a broken Parameter list", () => {
				let once = format(source)

				expect(once.refusal).toBeNull()
				expect(format(once.text).text).toBe(once.text)
			})
		})

		// NOTE: Every one of these is a spelling the printer could tidy away
		// and a Token the safety gate would then miss — which costs the whole
		// file its formatting, not one member's.
		describe("what must never be rewritten", () => {
			let roundTrips = (source: string) => {
				let result = format(source)

				expect(result.refusal).toBeNull()
				expect(result.text).toBe(source)
			}

			it("keeps a member bound under its own name", () => {
				roundTrips(block("\tconstant { x as x, y } = record"))
			})

			it("keeps a Type elided where it was elided", () => {
				roundTrips(block("\tconstant { x, y: Integer } = record"))
			})

			// NOTE: A one-member Case payload has two readings, and the
			// Pattern one is what was written — rewriting it as `#Done(value)`
			// would bind the payload whole instead of taking it apart.
			it("keeps a one-member payload Pattern as a Pattern", () => {
				roundTrips(
					block(
						"\tTerminal.inspect(match job -> Integer {",
						"\t\tcase #Done({ value = 0 }) { <- 0 }",
						"\t\tcase _                    { <- 1 }",
						"\t})",
					),
				)
			})

			// NOTE: `_ { … }` and a bare `{ … }` are ONE node — both are
			// labelless — so which was written lives in the source and nowhere
			// else, and the `_` is a Token like any other.
			it("keeps the underscore of a labelless Pattern Parameter", () => {
				roundTrips(
					block(
						"\tconstant kept = list::map((_ { value }) { <- value })",
					),
				)
			})

			it("keeps a labelless Pattern Parameter without one", () => {
				roundTrips(
					block(
						"\tconstant kept = list::map(({ value }) { <- value })",
					),
				)
			})

			it("keeps an empty Pattern and the name it binds", () => {
				roundTrips(block("\tconstant {} as whole = record"))
			})
		})
	})

	// NOTE: A checked refinement's `where` clause has to come back on the Type's
	// own line, because that is the only line the Parser reads it on — a clause
	// broken onto the next one would be a Statement beginning with the name
	// `where`, and the safety gate would catch it as a meaning that changed.
	describe("Predicate Type Aliases", () => {
		it("round-trips a predicate", () => {
			let source = [
				"implementation {",
				"\ttype NonZeroInteger = Integer where @::isNot(0)",
				"}",
				"",
			].join("\n")

			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		})

		it("round-trips a conjunction and a labelled Argument", () => {
			let source = [
				"implementation {",
				"\ttype Digit = Integer where @::isBetween(0, and 9)",
				"",
				"\ttype SmallOdd = Integer where @::isOdd()::and(@::isLessThan(10))",
				"}",
				"",
			].join("\n")

			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		})

		it("is idempotent over a predicate written loosely", () => {
			let source = [
				"implementation {",
				"\ttype   NonEmptyStrings = List<String>   where   @::hasItems()",
				"}",
				"",
			].join("\n")

			let once = format(source)
			let twice = format(once.text)

			expect(once.refusal).toBeNull()
			expect(once.text).toBe(
				[
					"implementation {",
					"\ttype NonEmptyStrings = List<String> where @::hasItems()",
					"}",
					"",
				].join("\n"),
			)
			expect(twice.text).toBe(once.text)
		})

		// NOTE: An unrefined Alias prints exactly as it always did — the clause
		// is the only thing the printer learned, so nothing else may move.
		it("leaves an unrefined Alias alone", () => {
			let source = [
				"implementation {",
				"\ttype Coordinate = { x: Integer, y: Integer }",
				"}",
				"",
			].join("\n")

			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		})
	})

	describe("Comments above the Program", () => {
		// NOTE: The blank line that separates a file's header from its
		// `implementation {` used to be found under EVERY line of that header,
		// because each Comment was measured against the keyword rather than
		// against the Comment below it — so a four-line header came back
		// double-spaced, and running the formatter again spaced it again. Every
		// deliberately-broken file under `fixtures/files/diagnostics/` opens
		// with one of these headers.
		it("keeps a run of heading Comments together", () => {
			let source = [
				"§ A header above the Program.",
				"§",
				"§ A second paragraph, and",
				"§ a third line under it.",
				"",
				"implementation {",
				'\tTerminal.inspect("hi")',
				"}",
				"",
			].join("\n")

			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		})

		it("keeps a heading Comment sitting straight on the keyword", () => {
			let source = [
				"§ One.",
				"§ Two.",
				"implementation {",
				'\tTerminal.inspect("hi")',
				"}",
				"",
			].join("\n")

			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
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
			roundTrips('Terminal.inspect("Hello, {name}! {count} left")')
		})

		it("leaves escapes and literal braces untouched", () => {
			roundTrips('Terminal.inspect("a \\"b\\" \\\\ \\{c\\}")')
		})

		it("leaves a nested interpolation alone", () => {
			roundTrips('Terminal.inspect("outer {"inner {name}"}")')
		})

		// NOTE: A hole holds an Expression, not text, so it is formatted like
		// one — the String's own text around it is what stays as written.
		it("formats the code inside a hole", () => {
			expect(
				format(
					'implementation {\n\tTerminal.inspect("sum {1::add( 2 )}")\n}\n',
				).text,
			).toContain('"sum {1::add(2)}"')
		})

		// NOTE: The padding between a brace and what it holds is inside the
		// hole, which makes it layout rather than a character of the String, so
		// a hole has one spelling however it was typed.
		it("closes the braces up against what the hole holds", () => {
			expect(
				format(
					'implementation {\n\tconstant name = "x"\n\tTerminal.inspect("a { name } b { name}c")\n}\n',
				).text,
			).toContain('"a {name} b {name}c"')
		})

		// NOTE: An escaped brace is a character of the String, not a hole, so
		// the text around it is left exactly as written — only the padding of a
		// real hole is closed up.
		it("leaves an escaped brace and the text around it alone", () => {
			expect(
				format(
					'implementation {\n\tconstant name = "x"\n\tTerminal.inspect("pre \\{ lit \\} post { name } tail")\n}\n',
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
					'\tTerminal.inspect("n: {match a -> String {\n' +
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
					formatted(block("constant a = 1", "Terminal.inspect(a)")),
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

		// NOTE: Only the outermost list that has to break does. Once `Terminal.inspect(`
		// is broken its Argument starts a level in, where it fits on one line —
		// breaking the inner call as well would be gratuitous.
		it("breaks the outermost argument list that does not fit, and no more", () => {
			let source =
				'implementation {\n\tTerminal.inspect("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"::append("bbbbbbbbbbbbbbbbbbbbbbbbbb"))\n}\n'

			expect(formatted(source)).toBe(
				'implementation {\n\tTerminal.inspect(\n\t\t"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"::append("bbbbbbbbbbbbbbbbbbbbbbbbbb"),\n\t)\n}\n',
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

		it("breaks a with-Combination like a Record", () => {
			let source =
				'implementation {\n\tconstant p = { x = 1, y = 2 }\n\tconstant q = { p with x = 100000000, y = 200000000, label = "somethingelse", description = "another" }\n}\n'

			expect(formatted(source)).toBe(
				'implementation {\n\tconstant p = { x = 1, y = 2 }\n\tconstant q = {\n\t\tp with\n\t\t\tx = 100000000,\n\t\t\ty = 200000000,\n\t\t\tlabel = "somethingelse",\n\t\t\tdescription = "another",\n\t}\n}\n',
			)
		})

		it("lets a braced right side of a with lay itself out", () => {
			let source =
				"implementation {\n\ttype Point = { x: Integer, y: Integer }\n\tconstant p: Point = { x = 1, y = 2 }\n\tconstant r = { p with Point ~> { x = 100000000000000000000, y = 200000000000000000000000000000000000000000000 } }\n}\n"

			expect(formatted(source)).toContain(
				"= {\n\t\tp with Point ~> {\n\t\t\tx = 100000000000000000000,\n\t\t\ty = 200000000000000000000000000000000000000000000,\n\t\t}\n\t}\n",
			)
		})

		it("keeps an else block that holds a single if as a block", () => {
			let source =
				'implementation {\n\tconstant n = 1\n\tif n::isPositive() {\n\t\tTerminal.print("pos")\n\t} else {\n\t\tif n::is(0) {\n\t\t\tTerminal.print("zero")\n\t\t}\n\t}\n}\n'
			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		})

		it("keeps a written else if as a chain", () => {
			let source =
				'implementation {\n\tconstant n = 1\n\tif n::isPositive() {\n\t\tTerminal.print("pos")\n\t} else if n::is(0) {\n\t\tTerminal.print("zero")\n\t}\n}\n'

			expect(formatted(source)).toBe(source)
		})

		it("does not let a long trailing comment break the code before it", () => {
			let source =
				"implementation {\n\tTerminal.inspect(2::raise(to 0::subtract(2))) § Optional#Value(1/4) — negative powers stay exact, and this comment is long\n}\n"

			expect(formatted(source)).toBe(source)
		})

		it("fills a List of Numbers rather than breaking it one per line", () => {
			let source =
				"implementation {\n\tTerminal.inspect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23])\n}\n"

			expect(formatted(source)).toBe(
				"implementation {\n\tTerminal.inspect([\n\t\t1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,\n\t\t21, 22, 23,\n\t])\n}\n",
			)
		})

		it("breaks a List of Strings one per line", () => {
			let source =
				'implementation {\n\tTerminal.inspect(["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota"])\n}\n'

			expect(formatted(source)).toContain(
				'[\n\t\t"alpha",\n\t\t"beta",\n',
			)
		})

		it("adds a trailing comma to a broken argument list", () => {
			let source =
				'implementation {\n\tTerminal.inspect("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")\n}\n'

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

		// NOTE: The right side of a `with` is unwrapped to bare members only
		// when the source never braced it — a typed Record always braces
		// itself, so unwrapping it dropped the `Type ~>` outright.
		it("keeps the ~> of a typed record on the right of a with", () => {
			roundTrips(
				"implementation {\n\tconstant moved = { point with Point ~> { x = 3, y = 4 } }\n}\n",
				"{ point with Point ~> { x = 3, y = 4 } }",
			)
		})

		it("is idempotent over a typed record on the right of a with", () => {
			let once = format(
				"implementation {\n\tconstant moved = { point with Point ~> { x = 3, y = 4 } }\n}\n",
			)

			expect(once.refusal).toBeNull()
			expect(format(once.text).text).toBe(once.text)
		})

		// NOTE: The spaces before a line break inside a multi-line String are
		// characters of the value, so the line-end trimming has to leave them
		// alone — trimmed, the file means something else and is refused.
		it("keeps trailing spaces inside a multi-line string", () => {
			let source =
				'implementation {\n\tconstant s = "hello   \nworld"\n}\n'
			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		})

		it("keeps trailing spaces inside an interpolated string", () => {
			let source =
				'implementation {\n\tconstant s = "hey {1}   \nworld"\n}\n'
			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
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
				"implementation {\n\tconstant list = [1]\n\n\tTerminal.inspect(list::map((box) { <- box }))  § note\n}\n"
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
				"implementation {\n\tconstant list = [1]\n\n\tTerminal.inspect(list::map((n) { § why\n\t\t<- n\n\t}))\n\n\t§ still here\n\tconstant after = 2\n}\n"
			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toContain("{ § why")
			expect(result.text).toContain("§ still here")
		})

		it("keeps a comment written below the program's closing brace", () => {
			let source =
				"implementation {\n\tconstant a = 1\n} § on the brace\n\n§ after everything\n§ and more\n"
			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		})

		it("keeps comments written above the program's own keyword", () => {
			let source =
				"§ about the file\n\nimplementation {\n\tconstant a = 1\n}\n"

			expect(format(source).text).toBe(source)
		})

		// NOTE: A Handler carries no Position for its own `}`, and its last
		// Statement's line is only the brace's when the Handler was written
		// flat — so a Comment trailing a broken Handler's brace was claimed by
		// nobody and swept to the end of the block.
		it("keeps a comment that trails a broken handler's closing brace", () => {
			let source =
				"implementation {\n\tconstant x = match 1 -> Integer {\n\t\tcase Integer {\n\t\t\t<- 1\n\t\t} § one\n\t\tcase _ { <- 2 }\n\t}\n}\n"
			let once = format(source)

			expect(once.refusal).toBeNull()
			expect(once.text).toContain("{ <- 1 } § one")
			expect(format(once.text).text).toBe(once.text)
		})

		// NOTE: The Handler used to claim this Comment as its own and write it
		// after the brace — across which the anchor comparison rightly refused
		// to let it move. It belongs to the Statement, and holds the body open.
		it("keeps a comment that trails the last statement of a handler", () => {
			let source =
				"implementation {\n\tconstant x = match 1 -> Integer {\n\t\tcase Integer {\n\t\t\tconstant y = 3\n\t\t\t<- y § note\n\t\t}\n\t\tcase _ { <- 2 }\n\t}\n}\n"
			let once = format(source)

			expect(once.refusal).toBeNull()
			expect(once.text).toContain("<- y § note\n\t\t}")
			expect(format(once.text).text).toBe(once.text)
		})

		// NOTE: A Comment runs to the end of its line, so a body holding one on
		// its last Statement can never collapse onto one line — flattened, the
		// closing brace lands inside the Comment and the output no longer
		// parses.
		it("holds a body open around a trailing comment", () => {
			let source =
				"implementation {\n\tconstant doubled = [1, 2]::map((n) {\n\t\t<- n::multiplyWith(2) § note\n\t})\n}\n"
			let once = format(source)

			expect(once.refusal).toBeNull()
			expect(once.text).toContain("<- n::multiplyWith(2) § note\n\t})")
			expect(format(once.text).text).toBe(once.text)
		})

		it("keeps a comment's trailing spaces", () => {
			let source = "implementation {\n\t§ note   \n\tconstant a = 1\n}\n"
			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		})
	})

	// NOTE: What the anchor comparison in `format` exists for. Every bug it
	// caught was one the AST comparison and a plain comment-text comparison
	// both passed: each Comment present, in order, and the code meaning the
	// same thing — only the Comments had moved.
	// NOTE: `= expression` at the end of a Parameter. Every case round-trips
	// through `format`, which runs the AST-equality gate itself — a dropped
	// default is a refusal here, not a silently shortened signature.
	describe("Default Parameter Values", () => {
		function roundTrip(source: string): string {
			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(format(result.text).text).toBe(result.text)

			return result.text
		}

		it("keeps a Number literal default", () => {
			expect(
				roundTrip(
					"implementation {\n\tfunction f(_ count: Integer = 1) -> Integer {\n\t\t<- count\n\t}\n}\n",
				),
			).toContain("(_ count: Integer = 1)")
		})

		it("keeps a bare Case default", () => {
			expect(
				roundTrip(
					"implementation {\n\tchoice Side {\n\t\tStart,\n\t\tEnd,\n\t}\n\n\tfunction f(at side: Side = #Start) -> Side {\n\t\t<- side\n\t}\n}\n",
				),
			).toContain("(at side: Side = #Start)")
		})

		it("keeps a Method call default", () => {
			expect(
				roundTrip(
					"implementation {\n\tnamespace Sizes for List<Integer> {\n\t\tupTo(_ end: Integer = @::length()) -> Integer {\n\t\t\t<- end\n\t\t}\n\t}\n}\n",
				),
			).toContain("(_ end: Integer = @::length())")
		})

		it("keeps a default on a Pattern Parameter", () => {
			expect(
				roundTrip(
					"implementation {\n\ttype Rectangle = { width: Integer, height: Integer }\n\n\tconstant origin = { width = 0, height = 0 }\n\n\tfunction area(of { width, height }: Rectangle = origin) -> Integer {\n\t\t<- width::multiply(height)\n\t}\n}\n",
				),
			).toContain("(of { width, height }: Rectangle = origin)")
		})

		it("keeps a List literal default", () => {
			expect(
				roundTrip(
					"implementation {\n\tfunction f(_ items: List<Integer> = [1, 2, 3]) -> List<Integer> {\n\t\t<- items\n\t}\n}\n",
				),
			).toContain("(_ items: List<Integer> = [1, 2, 3])")
		})

		it("keeps a call with its own commas as a default", () => {
			expect(
				roundTrip(
					"implementation {\n\tfunction g(_ a: Integer, _ b: Integer) -> Integer {\n\t\t<- a\n\t}\n\n\tfunction f(_ a: Integer = g(1, 2), _ b: Integer) -> Integer {\n\t\t<- a\n\t}\n}\n",
				),
			).toContain("(_ a: Integer = g(1, 2), _ b: Integer)")
		})

		it("breaks a Parameter list that no longer fits, defaults and all", () => {
			let formatted = roundTrip(
				"implementation {\n\tfunction alongName(_ firstParameterName: Integer = 100, _ secondParameterName: Integer = 200) -> Integer {\n\t\t<- firstParameterName\n\t}\n}\n",
			)

			expect(formatted).toContain(
				"\t\t_ firstParameterName: Integer = 100,\n",
			)
			expect(formatted).toContain(
				"\t\t_ secondParameterName: Integer = 200,\n",
			)
		})

		// NOTE: A trailing block-like default lays itself out over lines of its
		// own. The header must not break around it — the Parameters before it
		// stay on the line they were written on.
		it("does not shatter the header for a trailing block-like default", () => {
			let formatted = roundTrip(
				"implementation {\n\tfunction f(_ a: Integer, _ pick: (_ n: Integer) -> Integer = (_ n: Integer) -> Integer {\n\t\t<- n\n\t}) -> Integer {\n\t\t<- a\n\t}\n}\n",
			)

			expect(formatted).toContain(
				"function f(_ a: Integer, _ pick: (_ n: Integer) -> Integer = (",
			)
		})

		// NOTE: The rule above is about a default that HOLDS hard breaks, not
		// about its kind. `= []` is a List literal that renders flat, so a
		// header that no longer fits because of it breaks one Parameter per
		// line, exactly as the same header without the default would — and
		// exactly as it does with `= [1, 2, 3]`.
		it("breaks a header around a trailing flat literal default", () => {
			let source =
				"implementation {\n\ttype Shape = { width: Integer }\n\n\ttype StatusPair = { index: Integer, status: String }\n\n\tfunction aggregated(at index: Integer, in shape: Shape, given leafStatuses: List<String>, into pairs: List<StatusPair> = []) -> Integer {\n\t\t<- index\n\t}\n}\n"
			let formatted = roundTrip(source)

			expect(formatted).toContain("\tfunction aggregated(\n")
			expect(formatted).toContain("\t\tat index: Integer,\n")
			expect(formatted).toContain(
				"\t\tinto pairs: List<StatusPair> = [],\n\t) -> Integer {",
			)

			let nonEmpty = roundTrip(source.replace("= []", "= [1, 2, 3]"))

			expect(nonEmpty).toContain(
				"\t\tinto pairs: List<StatusPair> = [1, 2, 3],\n\t) -> Integer {",
			)
		})

		// NOTE: The other side of the same rule — a `match` default lays
		// itself out over lines whatever the width, so it still hugs.
		it("still hugs a trailing default that holds hard breaks", () => {
			let formatted = roundTrip(
				"implementation {\n\tfunction f(_ aVeryLongFirstParameterName: Integer, _ pick: Integer = match 1 -> Integer {\n\t\tcase 1 { <- 1 }\n\t\tcase Integer { <- 2 }\n\t}) -> Integer {\n\t\t<- pick\n\t}\n}\n",
			)

			expect(formatted).toContain(
				"function f(_ aVeryLongFirstParameterName: Integer, _ pick: Integer = match 1 -> Integer {",
			)
		})

		// NOTE: A List literal keeps the Comments written among its items,
		// so a default holding one is laid out like any other List — broken,
		// with the Comment above the item it was written above.
		it("keeps a Comment written inside a default", () => {
			let source =
				"implementation {\n\tfunction f(_ items: List<Integer> = [\n\t\t§ the first one\n\t\t1,\n\t\t2,\n\t]) -> List<Integer> {\n\t\t<- items\n\t}\n}\n"
			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		})
	})

	// NOTE: A block's `{` is not on the line its owner starts on once a header
	// breaks, and every one of these used to ask about the wrong line — an
	// opening Comment left unclaimed and flushed out of the block, or a
	// Namespace looking for its brace on the first member's `}`.
	describe("the line a block opens on", () => {
		it("keeps a comment trailing the brace of a broken header", () => {
			let source =
				"implementation {\n\tfunction foo(_ alpha: Integer, _ beta: Integer, _ gamma: Integer, _ delta: Integer) -> Integer { § note\n\t\t<- alpha\n\t}\n}\n"
			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toContain(") -> Integer { § note\n\t\t<- alpha")
		})

		it("keeps a comment trailing a namespace's brace", () => {
			let source =
				"implementation {\n\ttype Box = { value: Integer }\n\tnamespace BoxOps for Box { § ops\n\t\tdouble() -> Box {\n\t\t\t<- { value = @.value::multiply(with 2) }\n\t\t}\n\t}\n}\n"
			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		})

		it("leaves a comment trailing the first member's brace where it is", () => {
			let source =
				"implementation {\n\ttype Box = { value: Integer }\n\tnamespace BoxOps for Box {\n\t\tdouble() -> Box {\n\t\t\t<- { value = @.value::multiply(with 2) }\n\t\t} § trailing on method close\n\t\ttriple() -> Box {\n\t\t\t<- { value = @.value::multiply(with 3) }\n\t\t}\n\t}\n}\n"
			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		})

		it("keeps a comment trailing a match's brace", () => {
			let source =
				"implementation {\n\tconstant x: Optional<Integer> = #Value(1)\n\tTerminal.inspect(match x -> Integer { § note on the header\n\t\tcase #Value(item) { <- item }\n\t\tcase #Empty       { <- 0 }\n\t})\n}\n"
			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		})

		it("does not read a blank line between two parameters as one after the brace", () => {
			let source =
				"implementation {\n\tfunction foo(\n\t\t_ a: Integer,\n\n\t\t_ b: Integer,\n\t) -> Integer {\n\t\t<- a\n\t}\n}\n"

			expect(format(source).text).toBe(
				"implementation {\n\tfunction foo(_ a: Integer, _ b: Integer) -> Integer {\n\t\t<- a\n\t}\n}\n",
			)
		})

		it("drops a blank line written directly after a nested brace", () => {
			let source =
				'implementation {\n\n\tfunction double(_ n: Integer) -> Integer {\n\n\t\t<- n::multiply(with 2)\n\t}\n\n\tif true {\n\n\t\tTerminal.print("x")\n\t}\n}\n'

			expect(format(source).text).toBe(
				'implementation {\n\n\tfunction double(_ n: Integer) -> Integer {\n\t\t<- n::multiply(with 2)\n\t}\n\n\tif true {\n\t\tTerminal.print("x")\n\t}\n}\n',
			)
		})
	})

	describe("comments among the items of a list", () => {
		let stable = (source: string) => {
			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		}

		it("keeps a comment above and one trailing a List item", () => {
			stable(
				"implementation {\n\tconstant xs = [\n\t\t§ the first\n\t\t1, § first\n\t\t2,\n\t\t§ done\n\t]\n}\n",
			)
		})

		it("keeps a comment among Record members", () => {
			stable(
				"implementation {\n\tconstant r = {\n\t\t§ the x\n\t\tx = 1,\n\t\ty = 2, § the y\n\t}\n}\n",
			)
		})

		it("keeps a comment among the members of a Record Type", () => {
			stable(
				"implementation {\n\ttype P = {\n\t\t§ horizontal\n\t\tx: Integer,\n\t\ty: Integer,\n\t}\n}\n",
			)
		})

		it("keeps a comment among Arguments", () => {
			stable(
				"implementation {\n\tTerminal.inspect(\n\t\t1::add(2), § one\n\t)\n}\n",
			)
		})

		it("keeps a comment trailing a Parameter", () => {
			stable(
				"implementation {\n\tfunction area(\n\t\t_ width: Integer, § trailing\n\t\t_ height: Integer,\n\t) -> Integer {\n\t\t<- width::multiply(with height)\n\t}\n}\n",
			)
		})

		it("moves a comment written after the opening paren above the first Parameter", () => {
			expect(
				format(
					"implementation {\n\tfunction short(§§ w\n\t\t_ w: Integer) -> Integer { <- w }\n}\n",
				).text,
			).toBe(
				"implementation {\n\tfunction short(\n\t\t§§ w\n\t\t_ w: Integer,\n\t) -> Integer {\n\t\t<- w\n\t}\n}\n",
			)
		})

		it("keeps a comment above and one trailing a chain link", () => {
			stable(
				"implementation {\n\tconstant xs = [1, 2, 3]\n\tconstant ys = xs\n\t\t§ double\n\t\t::map((n) { <- n::multiply(with 2) })\n\t\t::sort() § then sort\n}\n",
			)
		})

		it("still leaves the trailing comment of a brace to the brace", () => {
			stable(
				"implementation {\n\tconstant list = [1]\n\tTerminal.inspect(\n\t\tlist::map((n) { § why\n\t\t\t<- n\n\t\t}),\n\t)\n}\n",
			)
		})
	})

	describe("hugging a trailing block", () => {
		let formatted = (source: string) => format(source).text

		it("keeps a hugged callback when everything up to its brace fits", () => {
			let source =
				"implementation {\n\tconstant xs = [1, 2, 3]\n\tconstant ys = xs::map((n) { <- n::multiply(with 2)::add(1)::multiply(with 2)::add(1) })\n}\n"

			expect(formatted(source)).toBe(
				"implementation {\n\tconstant xs = [1, 2, 3]\n\tconstant ys = xs::map((n) {\n\t\t<- n::multiply(with 2)::add(1)::multiply(with 2)::add(1)\n\t})\n}\n",
			)
		})

		it("breaks every argument when the head does not fit, instead of the first", () => {
			let source =
				"implementation {\n\tconstant xs = [1, 2, 3]\n\tconstant total = xs::reduce(0::add(0)::add(0)::add(0)::add(0)::add(0)::add(0), (sum, n) { <- sum::add(n) })\n}\n"

			expect(formatted(source)).toBe(
				"implementation {\n\tconstant xs    = [1, 2, 3]\n\tconstant total = xs::reduce(\n\t\t0::add(0)::add(0)::add(0)::add(0)::add(0)::add(0),\n\t\t(sum, n) { <- sum::add(n) },\n\t)\n}\n",
			)
		})

		it("hugs a Record only when it is the sole argument", () => {
			let source =
				"implementation {\n\tTerminal.inspect(List.of(integersFrom 1000000000000000000000000000000000000000000000, through [5]))\n}\n"

			expect(formatted(source)).toBe(
				"implementation {\n\tTerminal.inspect(\n\t\tList.of(\n\t\t\tintegersFrom 1000000000000000000000000000000000000000000000,\n\t\t\tthrough [5],\n\t\t),\n\t)\n}\n",
			)
		})

		it("breaks the list around a call whose block breaks", () => {
			let source =
				"implementation {\n\tconstant numbers = [1, 2, 3]\n\tTerminal.inspect(numbers::removeEvery(where (item) -> Boolean {\n\t\t<- item::isGreaterThan(2)\n\t}))\n}\n"

			expect(formatted(source)).toBe(
				"implementation {\n\tconstant numbers = [1, 2, 3]\n\tTerminal.inspect(\n\t\tnumbers::removeEvery(where (item) -> Boolean {\n\t\t\t<- item::isGreaterThan(2)\n\t\t}),\n\t)\n}\n",
			)
		})

		it("lays a Case payload out inside its parentheses", () => {
			let source =
				"implementation {\n\tconstant value: Optional<Integer> = #Value(1)\n\tconstant digit = 1\n\tconstant next: Optional<Integer> = #Value(value::value(withDefault 0)::multiply(with 10)::add(digit))\n}\n"

			expect(formatted(source)).toContain(
				"= #Value(\n\t\tvalue::value(withDefault 0)::multiply(with 10)::add(digit)\n\t)\n",
			)
		})
	})

	describe("chains", () => {
		let formatted = (source: string) => format(source).text

		it("keeps the first link on a short head's line", () => {
			let source =
				"implementation {\n\tconstant xs = [1, 2, 3]\n\tconstant zs = xs::filter((n) { <- n::isGreaterThan(2) })::sort()::sort()::sort()::sort()::sort()\n}\n"

			expect(formatted(source)).toContain(
				"constant zs = xs::filter((n) { <- n::isGreaterThan(2) })\n\t\t::sort()\n",
			)
		})

		it("leaves a long head on a line of its own", () => {
			let source =
				'implementation {\n\tconstant ys = List.repeat("x", times 3)::join(with ", ")::split(on ",")::join(with "")::split(on "")::firstItem()\n}\n'

			expect(formatted(source)).toContain(
				'constant ys = List.repeat("x", times 3)\n\t\t::join(with ", ")\n',
			)
		})

		it("does not fuse a first link that breaks", () => {
			let source =
				"implementation {\n\tconstant xs = [1, 2, 3]\n\tconstant a = xs::map((n) {\n\t\tconstant m = n\n\t\t<- m\n\t})::filter((n) { <- true })\n}\n"

			expect(formatted(source)).toContain(
				"constant a = xs\n\t\t::map((n) {\n\t\t\tconstant m = n\n\t\t\t<- m\n\t\t})\n\t\t::filter((n) { <- true })\n",
			)
		})

		it("puts the brace of an if on its own line when the condition breaks", () => {
			let source =
				'implementation {\n\tconstant a = 1\n\tif a::isGreaterThan(0)::and(a::isLessThan(10))::and(a::isEven())::and(a::isPositive()) {\n\t\tTerminal.print("ok")\n\t}\n}\n'

			expect(formatted(source)).toBe(
				'implementation {\n\tconstant a = 1\n\tif a::isGreaterThan(0)\n\t\t::and(a::isLessThan(10))\n\t\t::and(a::isEven())\n\t\t::and(a::isPositive())\n\t{\n\t\tTerminal.print("ok")\n\t}\n}\n',
			)
		})
	})

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
