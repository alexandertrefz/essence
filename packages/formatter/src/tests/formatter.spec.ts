import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import * as path from "node:path"

import { fixturePath } from "@essence-lang/fixtures"
import { spawnAndWait } from "@essence-lang/fixtures/spawn"
import {
	readStdlibFiles,
	STDLIB_DIRECTORY,
} from "@essence-lang/standard-library"

import { format, guarded } from "../index"
import { commentAnchors } from "../trivia"

// Every `.es` source in the standard library, the fixtures, the examples and
// the client's test Modules. The Diagnostic showcase files are included, since
// all but those in `REFUSED` parse cleanly and only fail later.
function corpus(): Array<{ name: string; filePath: string; source: string }> {
	let files = readStdlibFiles().map((file) => ({
		name: "stdlib/" + path.basename(file.filePath),
		filePath: file.filePath,
		source: file.sourceText,
	}))

	// Walked rather than listed, since the Module fixtures live in
	// subdirectories, and a directory missing from a list would go unchecked.
	for (let filePath of essenceFilesUnder(fixturePath())) {
		files.push({
			name: path.relative(fixturePath(), filePath),
			filePath,
			source: readFileSync(filePath, "utf8"),
		})
	}

	// The programs under `examples/` are held to the same standard, walked the
	// same way.
	for (let filePath of essenceFilesUnder(EXAMPLES_DIRECTORY)) {
		files.push({
			name: "examples/" + path.relative(EXAMPLES_DIRECTORY, filePath),
			filePath,
			source: readFileSync(filePath, "utf8"),
		})
	}

	for (let filePath of essenceFilesUnder(CLIENT_MODULES_DIRECTORY)) {
		files.push({
			name: "client/" + path.relative(CLIENT_MODULES_DIRECTORY, filePath),
			filePath,
			source: readFileSync(filePath, "utf8"),
		})
	}

	return files
}

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../../..")

const EXAMPLES_DIRECTORY = path.join(REPOSITORY_ROOT, "examples")

const CLIENT_MODULES_DIRECTORY = path.join(
	REPOSITORY_ROOT,
	"packages/client/src/tests/files",
)

function essenceFilesUnder(directory: string): Array<string> {
	let files: Array<string> = []

	for (let entry of readdirSync(directory).sort()) {
		let filePath = path.join(directory, entry)

		if (entry === "node_modules" || entry === "dist") {
			continue
		}

		if (statSync(filePath).isDirectory()) {
			files.push(...essenceFilesUnder(filePath))
		} else if (entry.endsWith(".es")) {
			files.push(filePath)
		}
	}

	return files
}

const CORPUS = corpus()

// The showcase files the formatter must refuse, since the Parser reports an
// error in each, whether or not the file parses.
const REFUSED = new Set([
	"diagnostics/Syntax.es",
	"diagnostics/UnclosedString.es",
	"diagnostics/SwallowedString.es",
	"diagnostics/Escapes.es",
	"diagnostics/DefaultsSyntax.es",
	"diagnostics/MemberPathSyntax.es",
	"diagnostics/PathKeySyntax.es",
	"diagnostics/DictionarySyntax.es",
	"diagnostics/TestsSyntax.es",
	"diagnostics/DefineSyntax.es",
	"diagnostics/ForeignSyntax.es",
])

// Showcase files that stay as written, since the rendered report shows their
// layout. `GenericChoice.es` splits a call over two lines for its report.
const SHAPED = new Set(["diagnostics/GenericChoice.es"])

describe("formatter", () => {
	it("finds the corpus", () => {
		expect(CORPUS.length).toBeGreaterThan(30)
	})

	// The corpus is checked against what git tracks, so no file escapes it.
	it("holds every tracked Essence file", async () => {
		let listed = await spawnAndWait(
			["git", "ls-files", "-z", "--", "*.es"],
			{
				cwd: REPOSITORY_ROOT,
			},
		)
		let held = new Set(
			CORPUS.map((file) => path.relative(REPOSITORY_ROOT, file.filePath)),
		)

		expect(listed.code).toBe(0)
		expect(
			listed.stdout
				.split("\0")
				.filter((file) => file !== "" && !held.has(file)),
		).toEqual([])
	})

	describe("corpus", () => {
		for (let file of CORPUS) {
			// The safety gate runs inside `format`, so a refusal here is the
			// failure.
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

	// The corpus stays formatted because it is checked here, never because
	// the compiler writes to a source tree. `REFUSED` and `SHAPED` are exempt.
	describe("the repository is formatted", () => {
		for (let file of CORPUS) {
			if (REFUSED.has(file.name) || SHAPED.has(file.name)) {
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

	// A Case Matcher's payload binding is part of the Matcher, so it survives
	// the round trip and counts toward the Matcher's width in the alignment.
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

	// A Pattern in each position that takes a value apart, since the Printer
	// reaches each by its own path. See "Patterns" in DEVELOPMENT.md.
	describe("Patterns", () => {
		let block = (...lines: Array<string>) =>
			["implementation {", ...lines, "}", ""].join("\n")

		// One source per position, each written as the Printer writes it, so
		// the round trip byte for byte is the whole assertion.
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
					"\tconstant { accepted, refused } = list::partition(where predicate)",
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

		// A Declaration has no alignment column at stake, so a Pattern there
		// breaks like a Record Type, one member per line.
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

			// A Pattern head reports no width and ends its alignment run, or
			// its padding could be stranded after its closing brace.
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

		// A Matcher's Pattern is never broken, since the alignment run measures
		// it flat.
		describe("in Matcher position", () => {
			// The last brace of each line, since a Pattern opens a brace of its
			// own. The column is where the Handler's body opens.
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

			// Wide enough that a breakable Pattern would break. It stays on one
			// line, and the arms break in their bodies instead.
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

			// A Union inside a Matcher's Pattern is flattened with it.
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

		// A member may be named `as`: `{ as }` binds it, `{ as as as }` binds it
		// under that name, and `{ as as { … } }` takes it apart.
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

		// A Parameter's Pattern breaks like a Declaration's, after the
		// Parameter list around it, which is the cheaper break.
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

		// Spellings the Printer must keep, since the gate would refuse the
		// whole file over one changed Token.
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

			// Written as `#Done(value)`, the payload would be bound whole
			// instead of taken apart.
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

			// `_ { … }` and `{ … }` are one node, so only the source says which
			// was written.
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

	// A Matcher holding a String written across lines has no flat width, so it
	// cannot join the Handlers' brace column.
	describe("Match", () => {
		let block = (...lines: Array<string>) =>
			["implementation {", ...lines, "}", ""].join("\n")

		it("leaves a Matcher written across lines out of the run", () => {
			let source = block(
				"\tconstant out = match value -> Integer {",
				'\t\tcase "hello',
				'world" { <- 1 }',
				'\t\tcase "b" { <- 2 }',
				"\t\tcase _   { <- 3 }",
				"\t}",
			)

			let once = format(source)

			expect(once.refusal).toBeNull()
			expect(once.text).toBe(source)

			let twice = format(once.text)

			expect(twice.refusal).toBeNull()
			expect(twice.text).toBe(once.text)
		})

		// A body holding such a String spans two lines, and a table does not
		// carry across such a row.
		it("ends the run at a body written across lines", () => {
			let source = block(
				"\tconstant out = match value -> String {",
				'\t\tcase "a" { <- "hello',
				'world" }',
				'\t\tcase "bb" { <- "2" }',
				'\t\tcase _    { <- "3" }',
				"\t}",
			)

			let once = format(source)

			expect(once.refusal).toBeNull()
			expect(once.text).toBe(source)

			let twice = format(once.text)

			expect(twice.refusal).toBeNull()
			expect(twice.text).toBe(once.text)
		})
	})

	// One arm per line, with the `if` of adjacent arms in one column.
	// See "Define" in DEVELOPMENT.md.
	describe("Define", () => {
		let block = (...lines: Array<string>) =>
			["implementation {", ...lines, "}", ""].join("\n")

		// Each source is the expected output. It is formatted twice, so a
		// column that shifts on the second pass fails with a diff.
		let roundTrips = (source: string) => {
			let once = format(source)

			expect(once.refusal).toBeNull()
			expect(once.text).toBe(source)

			let twice = format(once.text)

			expect(twice.refusal).toBeNull()
			expect(twice.text).toBe(once.text)
		}

		it("lines the if column up across a run of arms", () => {
			roundTrips(
				block(
					"\tconstant grade = define {",
					'\t\tas "A"       if score::isGreaterThanOrEqualTo(90)',
					'\t\tas "B"       if score::isGreaterThanOrEqualTo(80)',
					'\t\tas "unrated" otherwise',
					"\t}",
				),
			)
		})

		it("pads a run written without its column", () => {
			let result = format(
				block(
					"\tconstant grade = define {",
					'\t\tas "A" if score::isGreaterThanOrEqualTo(90)',
					'\t\tas "unrated" otherwise',
					"\t}",
				),
			)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(
				block(
					"\tconstant grade = define {",
					'\t\tas "A"       if score::isGreaterThanOrEqualTo(90)',
					'\t\tas "unrated" otherwise',
					"\t}",
				),
			)
		})

		it("round-trips a declared answer Type", () => {
			roundTrips(
				block(
					"\tconstant grade = define -> String {",
					'\t\tas "A"       if score::isGreaterThanOrEqualTo(90)',
					'\t\tas "unrated" otherwise',
					"\t}",
				),
			)
		})

		it("writes a define written flat one arm to a line", () => {
			let result = format(
				block(
					"\tconstant grade = define { as 1 if flag as 0 otherwise }",
				),
			)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(
				block(
					"\tconstant grade = define {",
					"\t\tas 1 if flag",
					"\t\tas 0 otherwise",
					"\t}",
				),
			)
		})

		// A `define` with only its `otherwise` arm is a run of one, which
		// stays unpadded.
		it("leaves a define of one arm unpadded", () => {
			roundTrips(
				block(
					"\tconstant grade = define {",
					"\t\tas 1 otherwise",
					"\t}",
				),
			)
		})

		// Answers whose widths span more than `MAX_ALIGNMENT_PADDING` split
		// the run into blocks that line up on their own.
		it("splits a run whose answers are too far apart in width", () => {
			roundTrips(
				block(
					"\tconstant grade = define {",
					'\t\tas "a"  if one',
					'\t\tas "bb" if two',
					'\t\tas "a rather wider answer"   if three',
					'\t\tas "another wide-ish answer" if four',
					'\t\tas "F" otherwise',
					"\t}",
				),
			)
		})

		it("breaks before the if when the arm runs past the width", () => {
			roundTrips(
				block(
					"\tconstant grade = define {",
					'\t\tas "an answer that runs on and on and on and on"',
					"\t\t\tif score::isGreaterThanOrEqualTo(90)",
					'\t\tas "B" if score::isGreaterThanOrEqualTo(80)',
					'\t\tas "F" otherwise',
					"\t}",
				),
			)
		})

		// An arm wider than any line breaks before its `if`, so it leaves the
		// run, and the arms around it line up with each other.
		it("leaves an arm too wide for any line out of the run", () => {
			roundTrips(
				block(
					"\tconstant grade = define {",
					'\t\tas "short" if value::is("a")',
					'\t\tas "aaaaaaaaaaaaaaaa"',
					'\t\t\tif value::is("cccccccccccccccccccccccccccccccccccccccccccccccccccc")',
					'\t\tas "mid"   if value::is("b")',
					'\t\tas "x"     otherwise',
					"\t}",
				),
			)
		})

		// These arms fit a line but not one three indents in, so they break
		// before their `if` and leave the run. The `otherwise` left is a block
		// of one and unpadded. The explicit check catches stranded spaces at a
		// line's end, which the trim should remove.
		it("leaves the arms the column it stands at breaks out of the run", () => {
			let source = block(
				"\tconstant grade = (_ score: Integer) -> String {",
				"\t\t<- define {",
				'\t\t\tas "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
				"\t\t\t\tif score::isGreaterThanOrEqualTo(90)",
				'\t\t\tas "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"',
				"\t\t\t\tif score::isGreaterThanOrEqualTo(80)",
				'\t\t\tas "cccccccccccccccccccccccccccccc" otherwise',
				"\t\t}",
				"\t}",
			)

			roundTrips(source)
			expect(format(source).text).not.toMatch(/[ \t]\n/)
		})

		// The same four indents in, with the wide arm in the middle. The arms
		// around a broken one line up on the widest head the column runs through.
		it("lines the arms either side of a broken one up without it", () => {
			roundTrips(
				[
					"implementation {",
					"\tnamespace Grades for Integer {",
					"\t\tband() -> String {",
					"\t\t\t<- define {",
					'\t\t\t\tas "bbbbbbbbbbbbbbbbbbbb" if @::isGreaterThan(80)',
					'\t\t\t\tas "aaaaaaaaaaaaaaaaaaaaaaaa"',
					"\t\t\t\t\tif @::isGreaterThanOrEqualTo(9_000_000_000)",
					'\t\t\t\tas "cccccccccccccccc"     otherwise',
					"\t\t\t}",
					"\t\t}",
					"\t}",
					"}",
					"",
				].join("\n"),
			)
		})

		// An arm leaves the run when its padding would break it. This one fits
		// by two columns unpadded and runs six past with the eight it would get.
		// It keeps its line, and the arms after it line up without it.
		it("leaves an arm out rather than let its padding break it", () => {
			roundTrips(
				block(
					"\tconstant grade = (_ score: Integer) -> String {",
					"\t\t<- define {",
					'\t\t\tas "aaaaa" if score::isGreaterThanOrEqualTo(9_000_000_000_000_000)',
					'\t\t\tas "bbbbbbbbbbbbb" if score::isGreaterThan(80)',
					'\t\t\tas "ccccccc"       otherwise',
					"\t\t}",
					"\t}",
				),
			)
		})

		// An answer that opens a block ends the run, and keeps its `if` after
		// the brace it closes with, as an `else` is written.
		it("ends the run at an answer that opens a block", () => {
			roundTrips(
				block(
					"\tconstant grade = define {",
					'\t\tas "aa" if one',
					"\t\tas match value -> String {",
					'\t\t\tcase 1 { <- "one" }',
					'\t\t\tcase _ { <- "other" }',
					"\t\t} if two",
					'\t\tas "cccc" if three',
					'\t\tas "F"    otherwise',
					"\t}",
				),
			)
		})

		// A condition that opens a block keeps its `if` on the answer's line,
		// since the brace opens right after it. The arm stays in the run.
		it("keeps the if on the line when the condition opens a block", () => {
			roundTrips(
				block(
					"\tconstant grade = define {",
					'\t\tas "yes" if define -> Boolean {',
					"\t\t\tas c     if c",
					"\t\t\tas false otherwise",
					"\t\t}",
					'\t\tas "no"  otherwise',
					"\t}",
				),
			)
		})

		it("keeps the if on the line when the condition is a match", () => {
			roundTrips(
				block(
					"\tconstant grade = define {",
					'\t\tas "yes" if match value -> Boolean {',
					"\t\t\tcase 1 { <- true }",
					"\t\t\tcase _ { <- false }",
					"\t\t}",
					'\t\tas "no"  otherwise',
					"\t}",
				),
			)
		})

		// A trailing callback in a condition hugs its call, which needs the
		// `if` on the answer's line.
		it("lets a Condition's trailing callback hug", () => {
			roundTrips(
				block(
					"\tconstant grade = define {",
					'\t\tas "yes" if scores::hasItems(onlyWhere (score) {',
					"\t\t\tconstant doubled = score::multiplyWith(2)",
					"",
					"\t\t\t<- doubled::isGreaterThan(100)",
					"\t\t})",
					'\t\tas "no"  otherwise',
					"\t}",
				),
			)
		})

		// `otherwise` never breaks from its answer, so the answer breaks inside
		// itself instead.
		it("keeps otherwise on the line its answer ends on", () => {
			roundTrips(
				block(
					"\tconstant grade = define {",
					'\t\tas "a" if one',
					"\t\tas someCall(",
					"\t\t\talpha,",
					"\t\t\tbeta,",
					"\t\t\tgamma,",
					"\t\t\tdelta,",
					"\t\t\tepsilon,",
					"\t\t\tzeta,",
					"\t\t\teta,",
					"\t\t\ttheta,",
					"\t\t) otherwise",
					"\t}",
				),
			)
		})

		it("aligns a define hugged as a trailing Argument", () => {
			roundTrips(
				block(
					"\tconstant grade = scores::map(define {",
					'\t\tas "A"       if score::isGreaterThanOrEqualTo(90)',
					'\t\tas "unrated" otherwise',
					"\t})",
				),
			)
		})

		it("aligns a define inside a define", () => {
			roundTrips(
				block(
					"\tconstant grade = define {",
					"\t\tas define {",
					'\t\t\tas "one"  if value::is(1)',
					'\t\t\tas "many" otherwise',
					"\t\t} if value::isPositive()",
					'\t\tas "none" otherwise',
					"\t}",
				),
			)
		})

		// A blank line ends a run of Declarations, but two arms are two rows of
		// one table however far apart.
		it("keeps a blank line from ending the run", () => {
			roundTrips(
				block(
					"\tconstant grade = define {",
					'\t\tas "A"       if one',
					"",
					'\t\tas "unrated" otherwise',
					"\t}",
				),
			)
		})

		// A trailing Comment is never measured, so its length cannot decide the
		// column before it.
		it("keeps a Comment at the end of an arm out of the column", () => {
			roundTrips(
				block(
					"\tconstant grade = define {",
					'\t\tas "A"       if one § the top',
					'\t\tas "unrated" otherwise § the rest',
					"\t}",
				),
			)
		})

		// Every place a Comment can sit in a `define`: after the `{`, before an
		// arm, at an arm's end, and after the last arm. One claimed out of order
		// would make the gate refuse the file.
		it("keeps the Comments written around its arms", () => {
			roundTrips(
				block(
					"\tconstant grade = define { § the bands",
					"\t\t§ the top one",
					'\t\tas "A"       if score::isGreaterThanOrEqualTo(90) § and no higher',
					"",
					'\t\tas "unrated" otherwise',
					"\t\t§ nothing below it",
					"\t}",
				),
			)
		})
	})

	// `{ a }` and `{ a = a }` mean the same, and `{ base with { a } }` and
	// `{ base with a = a }` parse differently. Whichever was written is kept.
	describe("Property shorthand", () => {
		let block = (...lines: Array<string>) =>
			["implementation {", ...lines, "}", ""].join("\n")

		let roundTrips = (source: string) => {
			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		}

		it("keeps a bare member name bare", () => {
			roundTrips(block("\tconstant point = { x, y }"))
		})

		it("keeps a member that spelled its value spelled out", () => {
			roundTrips(block("\tconstant point = { x = x, y = y }"))
		})

		it("keeps the two spellings side by side", () => {
			roundTrips(block("\tconstant point = { x, y = 2 }"))
		})

		it("keeps a bare member name in a typed Record Literal", () => {
			roundTrips(block("\tconstant point = Point ~> { x, y }"))
		})

		it("keeps a bare member name in a Case payload", () => {
			roundTrips(
				block("\tconstant shape = #Rectangle({ width, height })"),
			)
		})

		// Only the Parser's `bare` mark tells this braced right side from a
		// key list. The gate would refuse the other form, and this pins the
		// layout.
		it("keeps a Literal merged by an update braced", () => {
			roundTrips(
				block("\tconstant server = { base with { port, host } }"),
			)
		})

		it("keeps an update's key list spelled out", () => {
			roundTrips(block("\tconstant server = { base with port = port }"))
		})

		it("keeps a whole value merged in as a whole value", () => {
			roundTrips(block("\tconstant server = { base with other }"))
		})

		// Without its comma an update's only key, bare, would read as the
		// whole value merged in, so the comma stays where the list fits.
		it("keeps the comma after an update's only bare name", () => {
			roundTrips(block("\tconstant moved = { base with port, }"))
			roundTrips(block("\tconstant moved = { base with port, host }"))

			let broken = block(
				"\tconstant moved = {",
				"\t\tbase with",
				"\t\t\tport,",
				"\t}",
			)
			let once = format(broken)

			expect(once.refusal).toBeNull()
			expect(once.text).toBe(
				block("\tconstant moved = { base with port, }"),
			)
			expect(format(once.text).text).toBe(once.text)
		})

		it("keeps the comma after an update's only bare path key", () => {
			roundTrips(block("\tconstant moved = { config with server.port, }"))

			let broken = block(
				"\tconstant moved = {",
				"\t\tconfig with",
				"\t\t\tserver.port,",
				"\t}",
			)
			let once = format(broken)

			expect(once.refusal).toBeNull()
			expect(once.text).toBe(
				block("\tconstant moved = { config with server.port, }"),
			)
			expect(format(once.text).text).toBe(once.text)
		})

		it("breaks a long member list one bare name to a line", () => {
			roundTrips(
				block(
					"\tconstant wide = {",
					"\t\taaaaaaaaaaaaaaaa,",
					"\t\tbbbbbbbbbbbbbbbb,",
					"\t\tcccccccccccccccc,",
					"\t\tdddddddddddddddd,",
					"\t\teeeeeeeeeeeeeeee,",
					"\t}",
				),
			)
		})

		it("is idempotent over the shorthand", () => {
			let source = block("\tconstant point = { x, y = 2 }")
			let once = format(source)
			let twice = format(once.text)

			expect(twice.text).toBe(once.text)
		})
	})
	// A dotted key prints as written. `a.b = 1, a.c = 2` is never gathered up,
	// and a gathering is never taken apart.
	describe("Path keys", () => {
		let block = (...lines: Array<string>) =>
			["implementation {", ...lines, "}", ""].join("\n")

		let roundTrips = (source: string) => {
			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		}

		it("keeps a dotted key dotted", () => {
			roundTrips(
				block("\tconstant moved = { config with server.port = 1 }"),
			)
		})

		it("keeps every step of a longer path", () => {
			roundTrips(
				block(
					"\tconstant deep = { config with server.tls.enabled = true }",
				),
			)
		})

		it("keeps a path key beside a plain one", () => {
			roundTrips(
				block(
					'\tconstant mixed = { config with name = "b", server.port = 1 }',
				),
			)
		})

		it("keeps two paths that share a prefix apart", () => {
			roundTrips(
				block(
					"\tconstant both = { config with server.port = 1, server.tls.enabled = true }",
				),
			)
		})

		it("breaks a long key list one path to a line", () => {
			roundTrips(
				block(
					"\tconstant wide = {",
					"\t\tconfiguration with",
					"\t\t\tserver.aaaaaaaaaaaaaaaa = 1,",
					"\t\t\tserver.bbbbbbbbbbbbbbbb = 2,",
					"\t\t\tserver.cccccccccccccccc = 3,",
					"\t\t\tserver.dddddddddddddddd = 4,",
					"\t}",
				),
			)
		})

		// A path key does not make a bare key list braced. The gate would
		// refuse that, and this pins the layout.
		it("keeps a key list with a path in it bare", () => {
			let result = format(
				block("\tconstant moved = { config with server.port = 1 }"),
			)

			expect(result.text).not.toContain("with {")
		})

		it("keeps a braced descend braced", () => {
			roundTrips(
				block(
					'\tconstant a = { config with server.{ port = 1, host = "db" } }',
				),
			)
		})

		it("keeps a descend inside a descend", () => {
			roundTrips(
				block(
					"\tconstant b = { config with server.{ tls.{ enabled = true } } }",
				),
			)
		})

		it("keeps a bare name inside a descend bare", () => {
			roundTrips(
				block("\tconstant c = { config with server.{ port, host } }"),
			)
		})

		it("breaks a wide descend one member to a line", () => {
			roundTrips(
				block(
					"\tconstant wide = {",
					"\t\tconfiguration with",
					"\t\t\tserver.{",
					"\t\t\t\taaaaaaaaaaaaaaaaaa = 1,",
					"\t\t\t\tbbbbbbbbbbbbbbbbbb = 2,",
					"\t\t\t\tcccccccccccccccccc = 3,",
					"\t\t\t},",
					"\t}",
				),
			)
		})

		it("is idempotent over a braced descend", () => {
			let source = block(
				"\tconstant b = { config with server.{ tls.{ enabled = true }, port } }",
			)
			let once = format(source)
			let twice = format(once.text)

			expect(once.refusal).toBeNull()
			expect(twice.text).toBe(once.text)
		})

		it("is idempotent over a path key", () => {
			let source = block(
				'\tconstant mixed = { config with name = "b", server.port = 1 }',
			)
			let once = format(source)
			let twice = format(once.text)

			expect(once.refusal).toBeNull()
			expect(twice.text).toBe(once.text)
		})

		// A path key prints through the same member list wherever it stands,
		// so a literal merged into a default prints one as an update does.
		describe("in a Literal merged into a default", () => {
			it("keeps a dotted key in an Argument dotted", () => {
				roundTrips(
					block("\tconstant a = connect(using { server.port = 1 })"),
				)
			})

			it("keeps every step of a longer path", () => {
				roundTrips(
					block(
						"\tconstant a = connect(using { server.tls.enabled = true })",
					),
				)
			})

			it("keeps a braced descend braced", () => {
				roundTrips(
					block(
						'\tconstant a = connect(using { server.{ port = 1, host = "db" } })',
					),
				)
			})

			it("keeps a dotted key in a payload dotted", () => {
				roundTrips(
					block(
						'\tconstant a = #Get({ url = "/x", limits.calls = 2 })',
					),
				)
			})

			it("breaks a long Argument one path to a line", () => {
				roundTrips(
					block(
						"\tconstant wide = connect(using {",
						"\t\tserver.aaaaaaaaaaaaaaaa = 1,",
						"\t\tserver.bbbbbbbbbbbbbbbb = 2,",
						"\t\tserver.cccccccccccccccc = 3,",
						"\t\tserver.dddddddddddddddd = 4,",
						"\t})",
					),
				)
			})

			it("is idempotent over a path key in an Argument", () => {
				let source = block(
					"\tconstant a = connect(using { retries = 9, server.port = 1 })",
				)
				let once = format(source)
				let twice = format(once.text)

				expect(once.refusal).toBeNull()
				expect(twice.text).toBe(once.text)
			})
		})
	})

	describe("Member paths", () => {
		let block = (...lines: Array<string>) =>
			["implementation {", ...lines, "}", ""].join("\n")

		let roundTrips = (source: string) => {
			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		}

		it("keeps a path as it was written", () => {
			roundTrips(block("\tconstant sorted = products::sort(on .price)"))
		})

		it("keeps every step of a path", () => {
			roundTrips(block("\tconstant cities = people::map(.address.city)"))
		})

		// A member path and a Function literal are different nodes, so neither
		// is rewritten as the other.
		it("keeps a Function literal a literal", () => {
			roundTrips(
				block(
					"\tconstant prices = products::map((_ item: Product) { <- item.price })",
				),
			)
		})

		it("keeps the space that makes an Argument labelled", () => {
			roundTrips(
				block("\tconstant first = items::firstItem(where .isPaid)"),
			)
		})

		it("is idempotent over a path", () => {
			let source = block("\tconstant sorted = products::sort(on .price)")
			let once = format(source)
			let twice = format(once.text)

			expect(twice.text).toBe(once.text)
		})
	})

	// A refinement's `where` stays on the Type's line while it fits.
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

		// An Alias without a clause round-trips unchanged.
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

	// A Protocol's extension list and provided Method bodies print through
	// the code that prints a Namespace's conformance list and Methods.
	describe("Protocols", () => {
		it("round-trips a provided Method", () => {
			let source = [
				"implementation {",
				"	protocol Shape {",
				"		area() -> Rational",
				"",
				"		describe() -> String {",
				'			<- "area {@::area()}"',
				"		}",
				"	}",
				"}",
				"",
			].join("\n")

			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		})

		it("round-trips an extension list", () => {
			let source = [
				"implementation {",
				"	protocol Orderable is Comparable, is Equatable {",
				"		isLessThan(_ other: Self) -> Boolean",
				"	}",
				"}",
				"",
			].join("\n")

			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		})

		it("is idempotent over a provided Method written loosely", () => {
			let source = [
				"implementation {",
				"	protocol   Shape   is   Printable   {",
				"		area() -> Rational",
				"		describe()   ->   String   {   <-   @::area()::toString()   }",
				"	}",
				"}",
				"",
			].join("\n")

			let once = format(source)
			let twice = format(once.text)

			expect(once.refusal).toBeNull()
			expect(once.text).toBe(
				[
					"implementation {",
					"	protocol Shape is Printable {",
					"		area() -> Rational",
					"		describe() -> String {",
					"			<- @::area()::toString()",
					"		}",
					"	}",
					"}",
					"",
				].join("\n"),
			)
			expect(twice.text).toBe(once.text)
		})

		it("keeps a Comment written inside a provided body", () => {
			let source = [
				"implementation {",
				"	protocol Shape {",
				"		area() -> Rational",
				"",
				"		describe() -> String {",
				"			§ The area is the whole of what there is to say.",
				"			<- @::area()::toString()",
				"		}",
				"	}",
				"}",
				"",
			].join("\n")

			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		})

		// A Protocol of requirements alone round-trips unchanged.
		it("leaves a Protocol of requirements alone", () => {
			let source = [
				"implementation {",
				"	protocol Printable {",
				"		toString() -> String",
				"	}",
				"}",
				"",
			].join("\n")

			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		})
	})

	// The `tests { … }` section is a block of Statements. These hold the shapes
	// only it has: an item head whose Modifiers break one per line, and a file
	// with no implementation block.
	describe("the tests section", () => {
		it("writes a table test's rows and its row Parameter", () => {
			let source = [
				"implementation {",
				"\tconstant x = 1",
				"}",
				"",
				"tests {",
				'\ttest "{scored}-{conceded}" across [',
				"\t\t{ scored = 2, conceded = 1 },",
				"\t\t{ scored = 1, conceded = 1 },",
				"\t] ({ scored, conceded }: Scoreline) {",
				"\t\texpect scored::isGreaterThanOrEqualTo(conceded)",
				"\t}",
				"}",
				"",
			].join("\n")

			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		})

		it("writes a short table on one line, Modifiers and all", () => {
			let source = [
				"implementation {",
				"\tconstant x = 1",
				"}",
				"",
				"tests {",
				'\ttest "rows" tagged slow across [1, 2] (n: Integer) {',
				"\t\texpect n::isGreaterThan(0)",
				"\t}",
				"}",
				"",
			].join("\n")

			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		})

		it("writes a property test's Parameters", () => {
			let source = [
				"implementation {",
				"\tconstant x = 1",
				"}",
				"",
				"tests {",
				'\ttest "add commutes" for any (a: Integer, b: Integer) {',
				"\t\texpect a::add(b)::is(b::add(a))",
				"\t}",
				"}",
				"",
			].join("\n")

			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		})

		it("writes a benchmark under its own Keyword", () => {
			let source = [
				"implementation {",
				"\tconstant x = 1",
				"}",
				"",
				"tests {",
				'\tbenchmark "sorts ten thousand rows" tagged slow {',
				"\t\tconstant sorted = rows::sort()",
				"\t}",
				"}",
				"",
			].join("\n")

			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		})

		it("writes a property test's Modifiers in front of its Parameters", () => {
			let source = [
				"implementation {",
				"\tconstant x = 1",
				"}",
				"",
				"tests {",
				'\ttest "holds" tagged slow for any (a: Integer) {',
				"\t\texpect a::is(a)",
				"\t}",
				"}",
				"",
			].join("\n")

			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		})

		it("breaks a property test's Parameters onto their own lines", () => {
			let source = [
				"implementation {",
				"\tconstant x = 1",
				"}",
				"",
				"tests {",
				'\ttest "a very long name that pushes the Parameters over the margin" for any (',
				"\t\tstandings: NonEmptyList<String>,",
				"\t\tscored: Integer,",
				"\t) {",
				"\t\texpect scored::is(scored)",
				"\t}",
				"}",
				"",
			].join("\n")

			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		})

		// Every Matcher a `require` may take a value apart with, where a
		// Declaration's name stands. The gate compares Tokens, so a round trip
		// is the whole assertion.
		it("writes a Matcher left of the '='", () => {
			let source = [
				"implementation {",
				'\tconstant lions = { team = "Lions", points = 0 }',
				"\tconstant rows  = [lions]",
				"}",
				"",
				"tests {",
				'\ttest "takes it apart" {',
				"\t\trequire #Value(first) = rows::firstItem()",
				"\t\trequire { team: String, points = 0 } = first",
				"\t\trequire { team } as whole = first",
				"\t\trequire Integer = first.points",
				"\t\trequire #Empty = rows::item(at 9)",
				"\t}",
				"}",
				"",
			].join("\n")

			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		})

		it("writes the three shapes a snapshot takes", () => {
			let source = [
				"implementation {",
				"\tconstant x = 1",
				"}",
				"",
				"tests {",
				'\ttest "renders" {',
				"\t\texpect x matches snapshot",
				'\t\texpect x matches snapshot "1"',
				'\t\texpect x matches snapshot from "the-x"',
				"\t}",
				"}",
				"",
			].join("\n")

			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		})

		it("writes the section between the implementation and the exports", () => {
			let source = [
				"implementation {",
				"\tconstant x = 1",
				"}",
				"",
				"export {",
				"\tx",
				"}",
				"",
				"tests {",
				'\ttest "reads" {',
				"\t\texpect x::is(1)",
				"\t}",
				"}",
				"",
			].join("\n")

			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		})

		it("keeps a value comment where it was written", () => {
			let source = [
				"implementation {",
				"\tconstant x = 1",
				"}",
				"",
				"tests {",
				'\ttest "reads" {',
				"\t\tconstant doubled = x::add(with x) §? what came out",
				"",
				"\t\texpect doubled::is(2)",
				"\t}",
				"}",
				"",
			].join("\n")

			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		})

		it("keeps a bare value comment on a messy line", () => {
			let result = format(
				[
					"tests {",
					'\ttest "reads"    {',
					'\t\t   constant name    =   "Lions"     §?',
					"",
					'\t\texpect name::is("Lions")',
					"\t}",
					"}",
					"",
				].join("\n"),
			)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(
				[
					"tests {",
					'\ttest "reads" {',
					'\t\tconstant name = "Lions" §?',
					"",
					'\t\texpect name::is("Lions")',
					"\t}",
					"}",
					"",
				].join("\n"),
			)
		})

		it("lays a messy section out", () => {
			let source = [
				"implementation{constant x=1}",
				"tests{",
				'    test    "reads"     skipped   "later"    {',
				"      expect   x::is( 1 )",
				"    }",
				"}",
				"",
			].join("\n")

			expect(format(source).text).toBe(
				[
					"implementation {",
					"\tconstant x = 1",
					"}",
					"tests {",
					'\ttest "reads" skipped "later" {',
					"\t\texpect x::is(1)",
					"\t}",
					"}",
					"",
				].join("\n"),
			)
		})

		it("writes a file that is nothing but tests without an implementation block", () => {
			let source = [
				"import {",
				'\tfrom "./Other.es" { x }',
				"}",
				"",
				"tests {",
				'\ttest "reads" {',
				"\t\texpect x",
				"\t}",
				"}",
				"",
			].join("\n")

			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		})

		it("writes nested suites and their Modifiers", () => {
			let source = [
				"implementation {}",
				"",
				"tests {",
				'\tconstant lions = { name = "Lions" }',
				"",
				'\tsuite "Standing" tagged fast {',
				'\t\ttest "records a win" focused tagged slow, network {',
				"\t\t\texpect true",
				"\t\t}",
				"",
				'\t\tsuite "nested" {',
				'\t\t\ttest "still reads" skipped "waiting on the redesign" {',
				"\t\t\t\trequire { name } as team = lions",
				'\t\t\t\texpect name::is("Lions")',
				'\t\t\t\texpect team.name::is("Lions")',
				"\t\t\t}",
				"\t\t}",
				"\t}",
				"}",
				"",
			].join("\n")

			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		})

		// A head that stops fitting puts one Modifier per line under the name,
		// and the `{` back in the item's column.
		it("breaks a long head onto one Modifier per line", () => {
			let source = [
				"implementation {}",
				"",
				"tests {",
				'\ttest "recording a result never lowers the number of points a team has" skipped "waiting on the Table redesign" tagged slow, network {',
				"\t\texpect true",
				"\t}",
				"}",
				"",
			].join("\n")

			expect(format(source).text).toBe(
				[
					"implementation {}",
					"",
					"tests {",
					'\ttest "recording a result never lowers the number of points a team has"',
					'\t\tskipped "waiting on the Table redesign"',
					"\t\ttagged slow, network",
					"\t{",
					"\t\texpect true",
					"\t}",
					"}",
					"",
				].join("\n"),
			)
		})

		it("keeps a Comment written against every part of the section", () => {
			let source = [
				"implementation {}",
				"",
				"§ what this file proves",
				"tests { § the setup follows",
				"\t§ above the test",
				'\ttest "reads" { § the body follows',
				"\t\t§ inside",
				"\t\texpect true",
				"\t}",
				"}",
				"",
				"§ trailing",
				"",
			].join("\n")

			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		})

		it("aligns a run of Declarations inside the section", () => {
			let source = [
				"implementation {}",
				"",
				"tests {",
				'\tconstant lions = { name = "Lions" }',
				"\tconstant tigersAndBears = 2",
				"",
				'\ttest "reads" {',
				"\t\texpect true",
				"\t}",
				"}",
				"",
			].join("\n")

			expect(format(source).text).toBe(
				[
					"implementation {}",
					"",
					"tests {",
					'\tconstant lions          = { name = "Lions" }',
					"\tconstant tigersAndBears = 2",
					"",
					'\ttest "reads" {',
					"\t\texpect true",
					"\t}",
					"}",
					"",
				].join("\n"),
			)
		})

		it("writes an interpolated name and an empty section", () => {
			let source = [
				"implementation {}",
				"",
				"tests {",
				"\tconstant scored = 2",
				"",
				'\ttest "{scored} is a win" {',
				"\t\texpect true",
				"\t}",
				"}",
				"",
			].join("\n")

			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)

			let empty = ["implementation {}", "", "tests {}", ""].join("\n")

			expect(format(empty).text).toBe(empty)
		})
	})

	describe("Comments above the Program", () => {
		// Each heading Comment is measured against the next one rather than
		// the keyword, so a header is not written double-spaced.
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

		// No known source crashes the Printer, so the catch path is tested
		// through `guarded`, which `format` runs inside.
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

	// A String's text comes back from the source byte for byte, since the tree
	// holds its escapes decoded. A hole holds code, printed like any other.
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

		// A hole holds an Expression, so it is formatted like one.
		it("formats the code inside a hole", () => {
			expect(
				format(
					'implementation {\n\tTerminal.inspect("sum {1::add( 2 )}")\n}\n',
				).text,
			).toContain('"sum {1::add(2)}"')
		})

		// The padding between a brace and what it holds is layout, so a hole
		// has one spelling however it was typed.
		it("closes the braces up against what the hole holds", () => {
			expect(
				format(
					'implementation {\n\tconstant name = "x"\n\tTerminal.inspect("a { name } b { name}c")\n}\n',
				).text,
			).toContain('"a {name} b {name}c"')
		})

		// An escaped brace is a character of the String, not a hole, so the
		// text around it stays as written.
		it("leaves an escaped brace and the text around it alone", () => {
			expect(
				format(
					'implementation {\n\tconstant name = "x"\n\tTerminal.inspect("pre \\{ lit \\} post { name } tail")\n}\n',
				).text,
			).toContain('"pre \\{ lit \\} post {name} tail"')
		})

		// A `match` in a hole is laid out and aligned like any other.
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

		// The `=` never breaks from its value. A String starts on its name's
		// line however long it is, and breaks at a hole further along.
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

		// A value that can break inside itself does, as an Argument list breaks
		// at its commas.
		it("leaves a value that can break to break inside itself", () => {
			let result = format(
				"implementation {\n\tconstant result = someCall(alpha 1, beta 2, gamma 3, delta 4, epsilon 5, zeta 6)\n}\n",
			)

			expect(result.text).toContain("constant result = someCall(\n")
		})

		// A String with no hole cannot break, so it runs past the line rather
		// than moving down for one indent of room.
		it("leaves a long String with no hole where it is", () => {
			let result = format(
				'implementation {\n\tconstant sentence = "the quick brown fox jumped over the very lazy dog and away"\n}\n',
			)

			expect(result.refusal).toBeNull()
			expect(result.text).toContain(
				'\tconstant sentence = "the quick brown fox jumped over the very lazy dog and away"',
			)
		})

		// A hole is the only place a String breaks, since a newline in its text
		// would be a character. The text on either side stays whole.
		it("breaks a String too long for its line at one of its holes", () => {
			let result = format(
				'implementation {\n\tfunction f() -> String {\n\t\t<- "the quick brown fox {alpha::toString()} jumped over the lazy dog {beta::toString()} and away"\n\t}\n}\n',
			)

			expect(result.refusal).toBeNull()
			expect(result.text).toContain(
				'<- "the quick brown fox {alpha::toString()} jumped over the lazy dog {\n' +
					"\t\t\tbeta::toString()\n" +
					'\t\t} and away"',
			)
		})

		// A hole holding only a name never breaks, since three lines around one
		// word buy no room. The String runs long instead.
		it("never breaks a hole that holds only a name", () => {
			let source =
				'implementation {\n\tfunction f() -> String {\n\t\t<- "the quick brown fox {alpha} jumped over the lazy dog {beta.value} and away"\n\t}\n}\n'

			expect(format(source).text).toBe(source)
		})

		// Only the holes it must, so a String breaks at one place rather than
		// at every hole.
		it("breaks only the holes it has to", () => {
			let result = format(
				'implementation {\n\tfunction f() -> String {\n\t\t<- "the quick brown fox {alpha::toString()} jumped over the lazy dog {beta::toString()} and away"\n\t}\n}\n',
			)

			expect(result.text).toContain("{alpha::toString()}")
		})

		// The hole that breaks is the one the line runs out at. So the text a
		// reader starts on keeps as much of the line as it can.
		it("leaves a hole closed when breaking it would not help", () => {
			let source =
				'implementation {\n\tconstant name = "x"\n\tconstant long = "hello {name} this is a very long string that goes on and on and on and on and on and on past eighty {name} and then it keeps going and going and going for a while longer"\n}\n'

			expect(format(source).text).toBe(source)
		})

		it("gives way at the hole the line runs out at", () => {
			let result = format(
				'implementation {\n\tconstant alpha = 1\n\tconstant beta = 2\n\tconstant sentence = "the quick brown fox {alpha::toString()} jumped over the very lazy dog {beta::toString()} and then away again"\n}\n',
			)

			expect(result.refusal).toBeNull()
			expect(result.text).toContain(
				'constant sentence = "the quick brown fox {\n' +
					"\t\talpha::toString()\n" +
					'\t} jumped over the very lazy dog {beta::toString()} and then away again"',
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

		it("formats a file with CRLF line endings, writing LF", () => {
			let source =
				"implementation {\r\n\tconstant a = 1\r\n\tconstant bb = 2\r\n}\r\n"
			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(
				"implementation {\n\tconstant a  = 1\n\tconstant bb = 2\n}\n",
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

		it("breaks a require's pattern one member per line when it is too wide", () => {
			expect(
				formatted(
					'tests {\n\ttest "prices" {\n\t\trequire #Priced({ subtotal, discount, shipping, tax, total, display }) = quote(order)\n\t\trequire #Value(item) = table::item(at 0)\n\t}\n}\n',
				),
			).toBe(
				'tests {\n\ttest "prices" {\n\t\trequire #Priced({\n\t\t\tsubtotal,\n\t\t\tdiscount,\n\t\t\tshipping,\n\t\t\ttax,\n\t\t\ttotal,\n\t\t\tdisplay,\n\t\t}) = quote(order)\n\t\trequire #Value(item) = table::item(at 0)\n\t}\n}\n',
			)
		})

		it("hugs a Case payload through the Cases wrapping it", () => {
			expect(
				formatted(
					"implementation {\n\tconstant a = #Wrong(#OutOfStock({ sku, requested = quantity, available = stock }))\n\tconstant b = #Fine(#Value(#Value({ sku, requested = quantity, available = stock, note = 1 })))\n\tconstant c = #Value(someFunction(withArgument one, andAnother two, andThird three, more))\n}\n",
				),
			).toBe(
				"implementation {\n\tconstant a = #Wrong(#OutOfStock({\n\t\tsku,\n\t\trequested = quantity,\n\t\tavailable = stock,\n\t}))\n\tconstant b = #Fine(#Value(#Value({\n\t\tsku,\n\t\trequested = quantity,\n\t\tavailable = stock,\n\t\tnote = 1,\n\t})))\n\tconstant c = #Value(\n\t\tsomeFunction(withArgument one, andAnother two, andThird three, more)\n\t)\n}\n",
			)
		})

		it("fills a List of bare Cases the way it fills Numbers", () => {
			expect(
				formatted(
					"implementation {\n\tconstant cases = [#Up, #Down, #Left, #Right, #Up, #Down, #Left, #Right, #Up, #Down, #Left, #Right]\n\tconstant held = [#Value(1), #Empty, #Value(3), #Value(4), #Value(5), #Value(6), #Value(7), #Empty]\n}\n",
				),
			).toBe(
				"implementation {\n\tconstant cases = [\n\t\t#Up, #Down, #Left, #Right, #Up, #Down, #Left, #Right, #Up, #Down, #Left,\n\t\t#Right,\n\t]\n\tconstant held  = [\n\t\t#Value(1),\n\t\t#Empty,\n\t\t#Value(3),\n\t\t#Value(4),\n\t\t#Value(5),\n\t\t#Value(6),\n\t\t#Value(7),\n\t\t#Empty,\n\t]\n}\n",
			)
		})

		it("hugs a trailing Record after Arguments that read on one line", () => {
			expect(
				formatted(
					"implementation {\n\tconstant next = game::place(value, at { row = cell.row::add(direction.rowStep), column = cell.column::add(direction.columnStep) })\n\tconstant kept = numbers::transformFirst((item) {\n\t\tconstant doubled = item::multiply(with 2)\n\n\t\t<- doubled\n\t}, fallback {})\n}\n",
				),
			).toBe(
				"implementation {\n\tconstant next = game::place(value, at {\n\t\trow = cell.row::add(direction.rowStep),\n\t\tcolumn = cell.column::add(direction.columnStep),\n\t})\n\tconstant kept = numbers::transformFirst(\n\t\t(item) {\n\t\t\tconstant doubled = item::multiply(with 2)\n\n\t\t\t<- doubled\n\t\t},\n\t\tfallback {},\n\t)\n}\n",
			)
		})

		it("keeps a value that opens a block in its = run", () => {
			expect(
				formatted(
					"implementation {\n\tconstant total = items::sum()\n\tconstant doubled = items::map((item) {\n\t\tconstant twice = item::multiply(with 2)\n\n\t\t<- twice\n\t})\n\tconstant count = items::length()\n}\n",
				),
			).toBe(
				"implementation {\n\tconstant total   = items::sum()\n\tconstant doubled = items::map((item) {\n\t\tconstant twice = item::multiply(with 2)\n\n\t\t<- twice\n\t})\n\tconstant count   = items::length()\n}\n",
			)
		})

		it("moves matches snapshot to its own line when that keeps the value whole", () => {
			expect(
				formatted(
					'tests {\n\ttest "renders" {\n\t\texpect Table.render(table, titled "After round 7") matches snapshot "a very long snapshot text that goes on"\n\t\texpect Table.render(table, titled "After round 7", showing everyColumn, ruled true) matches snapshot from "rendered"\n\t\texpect short matches snapshot\n\t}\n}\n',
				),
			).toBe(
				'tests {\n\ttest "renders" {\n\t\texpect Table.render(table, titled "After round 7")\n\t\t\tmatches snapshot "a very long snapshot text that goes on"\n\t\texpect Table.render(\n\t\t\ttable,\n\t\t\ttitled "After round 7",\n\t\t\tshowing everyColumn,\n\t\t\truled true,\n\t\t) matches snapshot from "rendered"\n\t\texpect short matches snapshot\n\t}\n}\n',
			)
		})

		it("lines a broken Union alias up under its =", () => {
			expect(
				formatted(
					"implementation {\n\ttype Quote = Priced | Rejected | Pending | Cancelled | Refunded | Disputed | Archived\n\ttype Short = Priced | Rejected\n\tfunction f(_ a: Integer) -> Priced | Rejected | Pending | Cancelled | Refunded | Disputed {\n\t\t<- a\n\t}\n}\n",
				),
			).toBe(
				"implementation {\n\ttype Quote = Priced\n\t           | Rejected\n\t           | Pending\n\t           | Cancelled\n\t           | Refunded\n\t           | Disputed\n\t           | Archived\n\ttype Short = Priced | Rejected\n\tfunction f(\n\t\t_ a: Integer,\n\t) -> Priced | Rejected | Pending | Cancelled | Refunded | Disputed {\n\t\t<- a\n\t}\n}\n",
			)
		})

		// A broken head puts its `{` on a line of its own.
		// See "Broken heads" in DEVELOPMENT.md.
		describe("a broken head puts its brace on a line of its own", () => {
			it("moves a Guard down whole and breaks the body under the brace", () => {
				expect(
					formatted(
						"implementation {\n\tfunction merge(_ previous: Optional<Placed>, tile: Integer, open: Boolean) -> Merging {\n\t\t<- match previous -> Merging {\n\t\t\tcase #Value({ value, sources }) where open::and(value::is(tile))::and(sources::isNotEmpty()) {\n\t\t\t\t<- { placed = [], gained = 0, open = false }\n\t\t\t}\n\t\t\tcase #Value({ value }) where open::and(value::is(tile)) { <- { placed = [], gained = 0, open = false } }\n\t\t\tcase #Value({ sources }) where sources::isEmpty() { <- { placed = [], gained = 0, open = false } }\n\t\t\tcase _ { <- { placed = [], gained = 0, open = true } }\n\t\t}\n\t}\n}\n",
					),
				).toBe(
					"implementation {\n\tfunction merge(\n\t\t_ previous: Optional<Placed>,\n\t\ttile: Integer,\n\t\topen: Boolean,\n\t) -> Merging {\n\t\t<- match previous -> Merging {\n\t\t\tcase #Value({ value, sources })\n\t\t\t\twhere open::and(value::is(tile))::and(sources::isNotEmpty())\n\t\t\t{\n\t\t\t\t<- { placed = [], gained = 0, open = false }\n\t\t\t}\n\t\t\tcase #Value({ value }) where open::and(value::is(tile)) {\n\t\t\t\t<- { placed = [], gained = 0, open = false }\n\t\t\t}\n\t\t\tcase #Value({ sources }) where sources::isEmpty() {\n\t\t\t\t<- { placed = [], gained = 0, open = false }\n\t\t\t}\n\t\t\tcase _ { <- { placed = [], gained = 0, open = true } }\n\t\t}\n\t}\n}\n",
				)
			})

			it("breaks a match head before its -> rather than inside its value", () => {
				expect(
					formatted(
						'implementation {\n\tfunction digit(_ character: String) -> Step<Optional<Integer>, Optional<Integer>> {\n\t\t<- match "0123456789"::firstIndex(of character) -> Step<Optional<Integer>, Optional<Integer>> {\n\t\t\tcase #Value(index) { <- #Continue(#Value(index)) }\n\t\t\tcase #Empty { <- #Stop(#Empty) }\n\t\t}\n\t}\n\n\tconstant held = items::reduce(startingWith 0, (sum, key) {\n\t\t<- match entries::firstItem(where (entry) { <- entry.key::is(key) }) -> Integer {\n\t\t\tcase #Value({ value }) { <- sum::add(value) }\n\t\t\tcase #Empty { <- sum }\n\t\t}\n\t})\n}\n',
					),
				).toBe(
					'implementation {\n\tfunction digit(\n\t\t_ character: String,\n\t) -> Step<Optional<Integer>, Optional<Integer>> {\n\t\t<- match "0123456789"::firstIndex(of character)\n\t\t\t-> Step<Optional<Integer>, Optional<Integer>>\n\t\t{\n\t\t\tcase #Value(index) { <- #Continue(#Value(index)) }\n\t\t\tcase #Empty        { <- #Stop(#Empty) }\n\t\t}\n\t}\n\n\tconstant held = items::reduce(startingWith 0, (sum, key) {\n\t\t<- match entries::firstItem(where (entry) { <- entry.key::is(key) })\n\t\t\t-> Integer\n\t\t{\n\t\t\tcase #Value({ value }) { <- sum::add(value) }\n\t\t\tcase #Empty            { <- sum }\n\t\t}\n\t})\n}\n',
				)
			})

			it("keeps a match head whole where its value holds a hugged callback", () => {
				let source =
					"implementation {\n\tconstant total = fewKeys::reduce(startingWith 0, (sum, key) {\n\t\t<- match entries::firstItem(where (entry) {\n\t\t\tconstant wanted = key\n\n\t\t\t<- entry.key::is(wanted)\n\t\t}) -> Integer {\n\t\t\tcase #Value({ value }) { <- sum::add(value) }\n\t\t\tcase #Empty            { <- sum }\n\t\t}\n\t})\n}\n"

				expect(formatted(source)).toBe(source)
			})

			it("breaks a Namespace head at its is list first, then at its for", () => {
				expect(
					formatted(
						'implementation {\n\tnamespace Standing for Standing is Comparable, is Printable, is Equatable, is Orderable, is Hashable {\n\t\ttoString() -> String {\n\t\t\t<- ""\n\t\t}\n\t}\n\n\tnamespace Empty<infer ItemType> for List<ItemType> is Printable, is Comparable, is Equatable, is Order {}\n\n\tnamespace NonEmptyNestedList<infer ItemType> for NonEmptyList<NonEmptyList<ItemType>> {\n\t\tshort() -> String {\n\t\t\t<- ""\n\t\t}\n\t}\n}\n',
					),
				).toBe(
					'implementation {\n\tnamespace Standing for Standing\n\t\tis Comparable,\n\t\tis Printable,\n\t\tis Equatable,\n\t\tis Orderable,\n\t\tis Hashable\n\t{\n\t\ttoString() -> String {\n\t\t\t<- ""\n\t\t}\n\t}\n\n\tnamespace Empty<infer ItemType> for List<ItemType>\n\t\tis Printable,\n\t\tis Comparable,\n\t\tis Equatable,\n\t\tis Order {}\n\n\tnamespace NonEmptyNestedList<infer ItemType>\n\t\tfor NonEmptyList<NonEmptyList<ItemType>>\n\t{\n\t\tshort() -> String {\n\t\t\t<- ""\n\t\t}\n\t}\n}\n',
				)
			})

			it("breaks a Parameter list with nothing in it before its ->", () => {
				expect(
					formatted(
						"implementation {\n\tfunction total() -> Step<Optional<Integer>, Optional<Integer>, Optional<Integer>> {\n\t\t<- 1\n\t}\n}\n",
					),
				).toBe(
					"implementation {\n\tfunction total()\n\t\t-> Step<Optional<Integer>, Optional<Integer>, Optional<Integer>>\n\t{\n\t\t<- 1\n\t}\n}\n",
				)
			})

			it("breaks a signature with no Parameters before its ->", () => {
				let source =
					"declarations {\n\tnamespace Dictionary<infer KeyType, infer ValueType> for Dictionary<KeyType, ValueType> is Printable where KeyType is Printable, ValueType is Printable {\n\t\ttoString<infer KeyType is Printable, infer ValueType is Printable>() -> String\n\t\tshort() -> String\n\t}\n}\n"
				let result = format(source, {
					documentPath: path.join(STDLIB_DIRECTORY, "Probe.es"),
				})

				expect(result.refusal).toBeNull()
				expect(result.text).toBe(
					"declarations {\n\tnamespace Dictionary<infer KeyType, infer ValueType>\n\t\tfor Dictionary<KeyType, ValueType>\n\t\tis Printable where KeyType is Printable, ValueType is Printable\n\t{\n\t\ttoString<infer KeyType is Printable, infer ValueType is Printable>()\n\t\t\t-> String\n\t\tshort() -> String\n\t}\n}\n",
				)
			})
		})

		it("breaks a generic list one per line once the name and it overflow", () => {
			expect(
				formatted(
					"implementation {\n\tfunction generic<infer ItemType is Comparable, infer Other is Equatable, infer Key is Comparable>(_ items: List<ItemType>) -> ItemType {\n\t\t<- items::firstItem()\n\t}\n\n\tfunction shorter<infer ItemType is Comparable, infer Other>(_ items: List<ItemType>, other: Other) -> ItemType {\n\t\t<- items::firstItem()\n\t}\n}\n",
				),
			).toBe(
				"implementation {\n\tfunction generic<\n\t\tinfer ItemType is Comparable,\n\t\tinfer Other is Equatable,\n\t\tinfer Key is Comparable,\n\t>(_ items: List<ItemType>) -> ItemType {\n\t\t<- items::firstItem()\n\t}\n\n\tfunction shorter<infer ItemType is Comparable, infer Other>(\n\t\t_ items: List<ItemType>,\n\t\tother: Other,\n\t) -> ItemType {\n\t\t<- items::firstItem()\n\t}\n}\n",
			)
		})

		it("moves a refinement's where clause under a Type too wide for it", () => {
			expect(
				formatted(
					"implementation {\n\ttype NonEmptyDictionary<KeyType, ValueType> = Dictionary<KeyType, ValueType> where @::hasEntries()\n\ttype NonZero = Integer where @::isNot(0)\n}\n",
				),
			).toBe(
				"implementation {\n\ttype NonEmptyDictionary<KeyType, ValueType> = Dictionary<KeyType, ValueType>\n\t\twhere @::hasEntries()\n\ttype NonZero = Integer where @::isNot(0)\n}\n",
			)
		})

		// A chain of one link moves its link down rather than breaking its
		// Arguments. See "Method chains" in DEVELOPMENT.md.
		describe("a chain of one link", () => {
			it("breaks before the link when the head fits its line", () => {
				expect(
					formatted(
						'tests {\n\tsuite "shipping" {\n\t\ttest "charges" {\n\t\t\texpect shipping(to #Domestic, weighing 400, onGoodsWorth 5_000)::is(0)\n\t\t\texpect shipping(to #Overseas, weighing 500, onGoodsWorth 100)::isGreaterThan(shipping(to #Europe, weighing 500, onGoodsWorth 100))\n\t\t\texpect "Result: {result(lions, 3, 0, tigers)}"::is("Result: LIO 3–0 TIG")\n\t\t\tconstant leader = blank::record(scored 3, conceded 0)\n\t\t\tconstant follower = Standings.blank(of { team = tigers })::record(scored 1, conceded 1)\n\t\t}\n\t}\n}\n',
					),
				).toBe(
					'tests {\n\tsuite "shipping" {\n\t\ttest "charges" {\n\t\t\texpect shipping(to #Domestic, weighing 400, onGoodsWorth 5_000)\n\t\t\t\t::is(0)\n\t\t\texpect shipping(to #Overseas, weighing 500, onGoodsWorth 100)\n\t\t\t\t::isGreaterThan(\n\t\t\t\t\tshipping(to #Europe, weighing 500, onGoodsWorth 100),\n\t\t\t\t)\n\t\t\texpect "Result: {result(lions, 3, 0, tigers)}"\n\t\t\t\t::is("Result: LIO 3–0 TIG")\n\t\t\tconstant leader   = blank::record(scored 3, conceded 0)\n\t\t\tconstant follower = Standings.blank(of { team = tigers })\n\t\t\t\t::record(scored 1, conceded 1)\n\t\t}\n\t}\n}\n',
				)
			})

			it("hugs a callback on the link's own line once it is there", () => {
				expect(
					formatted(
						'implementation {\n\tconstant keys: List<String> = List.of(integersFrom 0, through 9999)::map((number) { <- "key {number}" })\n\tconstant results: List<Result> = List.of(integersFrom 0, through 9999)::map((number) {\n\t\tconstant team = number::remainder(dividingBy 100)\n\n\t\t<- { team, goals = number::remainder(dividingBy 7) }\n\t})\n}\n',
					),
				).toBe(
					'implementation {\n\tconstant keys: List<String>    = List.of(integersFrom 0, through 9999)\n\t\t::map((number) { <- "key {number}" })\n\tconstant results: List<Result> = List.of(integersFrom 0, through 9999)\n\t\t::map((number) {\n\t\t\tconstant team = number::remainder(dividingBy 100)\n\n\t\t\t<- { team, goals = number::remainder(dividingBy 7) }\n\t\t})\n}\n',
				)
			})

			// A name above its one link buys nothing, since the link's
			// Arguments still break under it.
			it("keeps a head that is a name fused to its link", () => {
				expect(
					formatted(
						"implementation {\n\tfunction f(_ tile: Integer, placed: List<Integer>, origin: Integer, game: Game, winningTile: Integer) -> Merging {\n\t\t<- {\n\t\t\tplaced = placed::append({ value = tile::multiply(with 2), sources = [origin, origin] }),\n\t\t\twon = game.won::or(slid.board::highest()::isGreaterThanOrEqualTo(winningTile)),\n\t\t\tgained = Integer.parse(denominatorText, defaultingTo 0)::andThen((denominator) { <- Rational.of(numerator::multiply(with signFactor), over denominator) }),\n\t\t}\n\t}\n}\n",
					),
				).toBe(
					"implementation {\n\tfunction f(\n\t\t_ tile: Integer,\n\t\tplaced: List<Integer>,\n\t\torigin: Integer,\n\t\tgame: Game,\n\t\twinningTile: Integer,\n\t) -> Merging {\n\t\t<- {\n\t\t\tplaced = placed::append({\n\t\t\t\tvalue = tile::multiply(with 2),\n\t\t\t\tsources = [origin, origin],\n\t\t\t}),\n\t\t\twon = game.won::or(\n\t\t\t\tslid.board::highest()::isGreaterThanOrEqualTo(winningTile),\n\t\t\t),\n\t\t\tgained = Integer.parse(denominatorText, defaultingTo 0)\n\t\t\t\t::andThen((denominator) {\n\t\t\t\t\t<- Rational.of(\n\t\t\t\t\t\tnumerator::multiply(with signFactor),\n\t\t\t\t\t\tover denominator,\n\t\t\t\t\t)\n\t\t\t\t}),\n\t\t}\n\t}\n}\n",
				)
			})

			it("puts an if's brace on its own line when the one link moves down", () => {
				expect(
					formatted(
						"implementation {\n\tfunction g(_ order: Order) -> Boolean {\n\t\tif isAvailable(order.sku, inStock order.quantity)::and(order.paid::and(order.shipped)) {\n\t\t\t<- true\n\t\t}\n\n\t\tif isAvailable(order.sku, inStock order.quantity, forVendor order.vendor)::and(order.paid) {\n\t\t\t<- true\n\t\t}\n\n\t\t<- false\n\t}\n}\n",
					),
				).toBe(
					"implementation {\n\tfunction g(_ order: Order) -> Boolean {\n\t\tif isAvailable(order.sku, inStock order.quantity)\n\t\t\t::and(order.paid::and(order.shipped))\n\t\t{\n\t\t\t<- true\n\t\t}\n\n\t\tif isAvailable(\n\t\t\torder.sku,\n\t\t\tinStock order.quantity,\n\t\t\tforVendor order.vendor,\n\t\t)::and(order.paid) {\n\t\t\t<- true\n\t\t}\n\n\t\t<- false\n\t}\n}\n",
				)
			})
		})

		// A blank line always follows a member that ends with a block.
		describe("a blank line after a block", () => {
			it("writes one after a bodied member, before the next sibling", () => {
				expect(
					formatted(
						"implementation {\n\tnamespace Board for Board {\n\t\ttranspose() -> Board {\n\t\t\t<- @\n\t\t}\n\t\t§§ Docs.\n\t\thighest() -> Integer {\n\t\t\t<- 0\n\t\t}\n\t}\n\tfunction a() -> Integer {\n\t\t<- 1\n\t}\n\tconstant x = 1\n}\n",
					),
				).toBe(
					"implementation {\n\tnamespace Board for Board {\n\t\ttranspose() -> Board {\n\t\t\t<- @\n\t\t}\n\n\t\t§§ Docs.\n\t\thighest() -> Integer {\n\t\t\t<- 0\n\t\t}\n\t}\n\n\tfunction a() -> Integer {\n\t\t<- 1\n\t}\n\n\tconstant x = 1\n}\n",
				)
			})

			it("writes one after an if, a choice, a test and a suite", () => {
				expect(
					formatted(
						'implementation {\n\tchoice C {\n\t\tA,\n\t}\n\tfunction f(_ a: Boolean) -> Integer {\n\t\tif a {\n\t\t\t<- 1\n\t\t}\n\t\t<- 2\n\t}\n}\n\ntests {\n\tsuite "s" {\n\t\ttest "a" {\n\t\t\texpect 1::is(1)\n\t\t}\n\t\ttest "b" {\n\t\t\texpect 1::is(1)\n\t\t}\n\t}\n\tconstant x = 1\n}\n',
					),
				).toBe(
					'implementation {\n\tchoice C {\n\t\tA,\n\t}\n\n\tfunction f(_ a: Boolean) -> Integer {\n\t\tif a {\n\t\t\t<- 1\n\t\t}\n\n\t\t<- 2\n\t}\n}\n\ntests {\n\tsuite "s" {\n\t\ttest "a" {\n\t\t\texpect 1::is(1)\n\t\t}\n\n\t\ttest "b" {\n\t\t\texpect 1::is(1)\n\t\t}\n\t}\n\n\tconstant x = 1\n}\n',
				)
			})

			it("writes none after a one-line alias, a property or a call", () => {
				let source =
					"implementation {\n\ttype Cell = { row: Integer }\n\tconstant a = someFunction(\n\t\twithAnArgument oneThatIsLong,\n\t\tandAnother twoThatIsLonger,\n\t)\n\tconstant b = 2\n\tnamespace N for Cell {\n\t\tstatic empty: Cell = { row = 0 }\n\t\tstatic other: Cell = { row = 1 }\n\t}\n}\n"

				expect(formatted(source)).toBe(source)
			})
		})

		// An `if` body always opens a block, since a half-flat `else if` chain
		// reads worse than either shape alone.
		it("always breaks an if body, however short", () => {
			expect(
				formatted(
					"implementation {\n\tfunction f(_ a: Boolean) -> Integer {\n\t\tif a { <- 1 } else { <- 2 }\n\t}\n}\n",
				),
			).toBe(
				"implementation {\n\tfunction f(_ a: Boolean) -> Integer {\n\t\tif a {\n\t\t\t<- 1\n\t\t} else {\n\t\t\t<- 2\n\t\t}\n\t}\n}\n",
			)
		})

		// A short `case` body stays on one line, or every `match` would triple
		// in size.
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

		// The `{` of adjacent Handlers stands in one column.
		// See "Match" in DEVELOPMENT.md.
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

			// A `where` clause is usually the widest thing in the `match`, and
			// padding siblings out to it would push the braces right.
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

			// A Handler that breaks opens a block and parts the run, so the
			// Handlers on each side line up among themselves.
			it("parts the run at a case that breaks", () => {
				expect(
					bracesOf(
						match(
							'case Nothing { <- "x" }',
							'case Integer { <- "a very long body that will certainly not fit on one line" }',
							'case Rational { <- "y" }',
						),
					),
				).toEqual([15, 15, 16])

				expect(
					bracesOf(
						match(
							'case #A { <- "x" }',
							'case Nothing { <- "x" }',
							'case Integer { <- "a very long body that will certainly not fit on one line" }',
							'case #B { <- "y" }',
							'case Rational { <- "y" }',
						),
					),
				).toEqual([15, 15, 15, 16, 16])
			})

			// A short Handler after a wide broken one is not padded out to the
			// wide Matcher.
			it("leaves a short case under a broken one unpadded", () => {
				expect(
					formatted(
						match(
							'case #Value(live) { <- "a very long body that will certainly not fit on one line" }',
							"case _ { <- 1/2 }",
						),
					),
				).toContain("\t\tcase _ { <- 1/2 }\n")
			})

			// A Handler that only its padding would push past the width leaves
			// the run, and is written unpadded and flat.
			it("writes a case flat that only its padding would break", () => {
				let wide =
					'case #Played({ home, away, homeGoals, awayGoals }) { <- "played" }'
				let short =
					'case #Postponed { <- "postponed, and rather long" }'

				expect(formatted(match(wide, short))).toContain(
					"\t\t" + short + "\n",
				)
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

		// The `=` of adjacent Declarations stands in one column.
		// See "Aligned columns" in DEVELOPMENT.md.
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

			// A decimal is one Literal and is measured as one.
			it("lines up a run of decimal values", () => {
				expect(
					equalsOf(
						block(
							"constant rate = 0.75",
							"constant owed = -0.5",
							"constant big = 1_000.5",
						),
					),
				).toEqual([15, 15, 15])
			})

			it("does not align a run of one", () => {
				expect(
					formatted(block("constant a = 1", "Terminal.inspect(a)")),
				).toContain("constant a = 1")
			})

			// A blank line ends the column.
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

			// A value over several lines stays in the run, since its `=` is on
			// its head's line.
			it("keeps a multi-line value in the run", () => {
				let equals = equalsOf(
					block(
						"constant a = 1",
						"constant bbbb = 2",
						'constant m = match a -> String {\n\t\tcase _ { <- "x" }\n\t}',
					),
				)

				expect(equals).toEqual([15, 15, 15])
			})

			// A reassignment writes no keyword, so padding it to a Declaration
			// would leave a keyword's worth of empty column.
			it("keeps a declaration and a bare reassignment in separate runs", () => {
				expect(
					equalsOf(
						block("variable aaaaaa = 1", "aaaaaa = 2", "bb = 3"),
					),
				).toEqual([17, 8, 8])
			})

			// Heads spanning more than the padding budget split the run into
			// blocks. Short, medium and wide Declarations each line up apart.
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

			// A head far wider than its neighbours starts its own block, and so
			// do the short ones around it. A block of one is left unpadded.
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

			// Heads of a similar width belong to one block, however long.
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

			it("lines up a run of static properties the same way", () => {
				let source =
					"implementation {\n\tnamespace Config {\n\t\tstatic a = 1\n\t\tstatic longerName = 2\n\t\tstatic x: Integer = 3\n\n\t\tstatic apart = 4\n\t\tdouble(_ n: Integer) -> Integer { <- n }\n\t\tstatic after = 5\n\t}\n}\n"

				expect(formatted(source)).toBe(
					"implementation {\n\tnamespace Config {\n\t\tstatic a          = 1\n\t\tstatic longerName = 2\n\t\tstatic x: Integer = 3\n\n\t\tstatic apart = 4\n\t\tdouble(_ n: Integer) -> Integer {\n\t\t\t<- n\n\t\t}\n\n\t\tstatic after = 5\n\t}\n}\n",
				)
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

		// Only the outermost list that has to break does. Once
		// `Terminal.inspect(` breaks, its Argument fits on one line a level in.
		it("breaks the outermost argument list that does not fit, and no more", () => {
			let source =
				'implementation {\n\tTerminal.inspect("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"::append("bbbbbbbbbbbbbbbbbbbbbbbbbb"))\n}\n'

			expect(formatted(source)).toBe(
				'implementation {\n\tTerminal.inspect(\n\t\t"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"::append("bbbbbbbbbbbbbbbbbbbbbbbbbb"),\n\t)\n}\n',
			)
		})

		// A bare `@` is too small for a line of its own, so the first link of a
		// broken chain stays on its line.
		it("keeps the first link of a broken chain on a bare @'s line", () => {
			let source =
				"implementation {\n\tconstant a: Integer | Nothing = 1\n\n\tconstant b = match a -> Boolean {\n\t\tcase Nothing { <- false }\n\t\tcase Integer {\n\t\t\t<- @\n\t\t\t\t::isGreaterThanOrEqualTo(100)\n\t\t\t\t::and(@::isLessThanOrEqualTo(100000))\n\t\t}\n\t}\n}\n"

			expect(formatted(source)).toContain(
				"<- @::isGreaterThanOrEqualTo(100)\n\t\t\t\t::and(@::isLessThanOrEqualTo(100000))",
			)
		})

		// The return clause is measured with the Parameter list as one header,
		// so the Parameters break and the return Type follows the `)` whole.
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

		it("breaks a Function Type too wide for its line like a Parameter list", () => {
			let source =
				"implementation {\n\tfunction applyLong(_ transform: (_ value: Integer, with other: Integer, and another: Integer) -> Integer, to n: Integer) -> Integer { <- transform(n, with n, and n) }\n}\n"

			expect(formatted(source)).toBe(
				"implementation {\n\tfunction applyLong(\n\t\t_ transform: (\n\t\t\t_ value: Integer,\n\t\t\twith other: Integer,\n\t\t\tand another: Integer,\n\t\t) -> Integer,\n\t\tto n: Integer,\n\t) -> Integer {\n\t\t<- transform(n, with n, and n)\n\t}\n}\n",
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

		// The tree holds `1_000` as `1000`, so only the source keeps the
		// grouping.
		it("keeps a grouped Number's underscores", () => {
			roundTrips(
				"implementation {\n\tconstant a = 1_000_000\n}\n",
				"1_000_000",
			)
		})

		// A Rational's three Tokens are one literal only while written flush.
		it("keeps a Rational's parts flush", () => {
			roundTrips("implementation {\n\tconstant a = 1/2\n}\n", "1/2")
		})

		// The node keeps nothing of a decimal's spelling, since `0.75` and
		// `3/4` build the same Rational. The Printer slices the source for it.
		it("keeps a decimal exactly as it was written", () => {
			let source = [
				"implementation {",
				"\tconstant rate  = 0.75",
				"\tconstant big   = 1_000.5",
				"\tconstant owed  = -0.5",
				"\tconstant scale = 1.50",
				"",
				"\tTerminal.inspect(19.99::toString(as #Decimal))",
				"}",
				"",
			].join("\n")
			let result = format(source)

			// A parse error would also leave the source untouched, so the
			// refusal is checked first.
			expect(result.refusal).toBeNull()
			expect(result.changed).toBe(false)
			expect(result.text).toBe(source)
			expect(format(result.text).text).toBe(source)
		})

		// Adjacency is what tells `Choice#Case` from an Argument label
		// followed by a bare Case.
		it("keeps a qualified Case flush against its Choice", () => {
			roundTrips(
				"implementation {\n\tchoice C {\n\t\tA,\n\t}\n\n\tconstant a: C = C#A\n}\n",
				"C#A",
			)
		})

		// The Type Arguments of a construction stand between the Choice's name
		// and its `#`, and all of it stays flush.
		it("keeps an applied Case flush through its Type Arguments", () => {
			roundTrips(
				"implementation {\n\tchoice C<T> {\n\t\tA { value: T },\n\t}\n\n\tconstant a = C<Integer>#A(1)\n}\n",
				"C<Integer>#A(1)",
			)
		})

		// The node records only the external name, so the internal one comes
		// from the source.
		it("keeps the internal name of a Function Type's parameter", () => {
			roundTrips(
				"implementation {\n\tfunction run(_ body: (_ value: Integer) -> Nothing) -> Nothing {\n\t\t<- nothing\n\t}\n}\n",
				"(_ value: Integer) -> Nothing",
			)
		})

		// Without its `~>`, `Type ~> { a = b }` still parses, as a name and an
		// untyped Record.
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

		// An empty typed Record keeps its Type.
		it("keeps the type of an empty typed record literal", () => {
			roundTrips(
				"implementation {\n\tconstant made = Type ~> {}\n}\n",
				"Type ~> {}",
			)
		})

		// A typed Record after a `with` always has braces, so it is never
		// unwrapped to bare members.
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

		// The spaces before a line break inside a multi-line String belong to
		// the value, so the line-end trim leaves them.
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

		// Documentation attaches by line adjacency, so a blank line here would
		// detach it. The safety gate compares the parsed Documentation.
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

		// The true body ends at its own `}`, found in the source, so the
		// Comments at the top of the `else` stay there.
		it("does not pull an else block's comments into the if", () => {
			let source =
				"implementation {\n\tfunction f(_ a: Boolean) -> Integer {\n\t\tif a {\n\t\t\t<- 1\n\t\t} else {\n\t\t\t§ about the else\n\t\t\t<- 2\n\t\t}\n\t}\n}\n"
			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toContain("} else {\n\t\t\t§ about the else")
		})

		// The inner `<- box` ends on the same line as the Statement, and the
		// outermost node claims the trailing Comment first.
		it("gives a trailing comment to the outermost node on its line", () => {
			let source =
				"implementation {\n\tconstant list = [1]\n\n\tTerminal.inspect(list::map((box) { <- box }))  § note\n}\n"
			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toContain("})) § note")
		})

		// A Comment after a `{` belongs to no Statement, so the block claims
		// it. Unclaimed, it would stall `takeBefore` for every later Comment.
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

		// A Handler has no Position for its own `}`, so the line is found in
		// the source. The Comment trailing it stays with the Handler.
		it("keeps a comment that trails a broken handler's closing brace", () => {
			let source =
				"implementation {\n\tconstant x = match 1 -> Integer {\n\t\tcase Integer {\n\t\t\t<- 1\n\t\t} § one\n\t\tcase _ { <- 2 }\n\t}\n}\n"
			let once = format(source)

			expect(once.refusal).toBeNull()
			expect(once.text).toContain("{ <- 1 } § one")
			expect(format(once.text).text).toBe(once.text)
		})

		// This Comment belongs to the Statement, not to the Handler's brace,
		// and holds the body open.
		it("keeps a comment that trails the last statement of a handler", () => {
			let source =
				"implementation {\n\tconstant x = match 1 -> Integer {\n\t\tcase Integer {\n\t\t\tconstant y = 3\n\t\t\t<- y § note\n\t\t}\n\t\tcase _ { <- 2 }\n\t}\n}\n"
			let once = format(source)

			expect(once.refusal).toBeNull()
			expect(once.text).toContain("<- y § note\n\t\t}")
			expect(format(once.text).text).toBe(once.text)
		})

		// A Comment runs to the end of its line, so a body holding one never
		// collapses onto one line.
		it("holds a body open around a trailing comment", () => {
			let source =
				"implementation {\n\tconstant doubled = [1, 2]::map((n) {\n\t\t<- n::multiplyWith(2) § note\n\t})\n}\n"
			let once = format(source)

			expect(once.refusal).toBeNull()
			expect(once.text).toContain("<- n::multiplyWith(2) § note\n\t})")
			expect(format(once.text).text).toBe(once.text)
		})

		it("trims a comment's trailing spaces", () => {
			let source = "implementation {\n\t§ note   \n\tconstant a = 1\n}\n"
			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(
				"implementation {\n\t§ note\n\tconstant a = 1\n}\n",
			)
		})
	})

	// `= { … }` after a Case's payload shape. The tree comparison carries the
	// default, so dropping one would be refused.
	describe("Case payload defaults", () => {
		function roundTrip(source: string): string {
			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(format(result.text).text).toBe(result.text)

			return result.text
		}

		it("keeps a partial payload default", () => {
			expect(
				roundTrip(
					"implementation {\n\tchoice Fetch {\n\t\tGet { url: String, retries: Integer } = { retries = 0 },\n\t}\n}\n",
				),
			).toContain(
				"\t\tGet { url: String, retries: Integer } = { retries = 0 },\n",
			)
		})

		it("keeps a default written on the only Case of a one-line Choice", () => {
			expect(
				roundTrip(
					"implementation {\n\tchoice Held { Item { value: Integer } = { value = 0 } }\n}\n",
				),
			).toContain("Item { value: Integer } = { value = 0 }")
		})

		it("keeps a default that is not a Record literal", () => {
			expect(
				roundTrip(
					"implementation {\n\ttype Page = { size: Integer }\n\n\tconstant blank: Page = { size = 0 }\n\n\tchoice Fetch {\n\t\tGet { size: Integer } = blank,\n\t}\n}\n",
				),
			).toContain("\t\tGet { size: Integer } = blank,\n")
		})
	})

	describe("Parameters that bind no name", () => {
		function roundTrip(source: string): string {
			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(format(result.text).text).toBe(result.text)

			return result.text
		}

		it("keeps a typed `_` in a Function literal", () => {
			expect(
				roundTrip(
					"implementation {\n\tconstant zero = (_: Integer) -> Integer { <- 0 }\n}\n",
				),
			).toContain("(_: Integer) -> Integer")
		})

		// Without its `_`, `on` would be both the label and a name.
		it("keeps the `_` after a label", () => {
			let formatted = roundTrip(
				"implementation {\n\tconstant flat = (on _: Integer) -> Integer { <- 1 }\n\n\tfunction ignoring(on _: Integer, _: String) -> Integer {\n\t\t<- 9\n\t}\n}\n",
			)

			expect(formatted).toContain("(on _: Integer) -> Integer")
			expect(formatted).toContain("ignoring(on _: Integer, _: String)")
		})
	})

	// `= expression` after a Parameter. The safety gate runs inside `format`,
	// so a dropped default is a refusal here.
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

		// A trailing default that opens a block leaves the Parameters before
		// it on their line. See "Parameter lists" in DEVELOPMENT.md.
		it("does not shatter the header for a trailing block-like default", () => {
			let formatted = roundTrip(
				"implementation {\n\tfunction f(_ a: Integer, _ pick: (_ n: Integer) -> Integer = (_ n: Integer) -> Integer {\n\t\t<- n\n\t}) -> Integer {\n\t\t<- a\n\t}\n}\n",
			)

			expect(formatted).toContain(
				"function f(_ a: Integer, _ pick: (_ n: Integer) -> Integer = (",
			)
		})

		// `= []` prints flat, so a header it overflows breaks one Parameter per
		// line, as it would without the default.
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

		// A `match` default spans several lines whatever the width, so it
		// still hugs.
		it("still hugs a trailing default that holds hard breaks", () => {
			let formatted = roundTrip(
				"implementation {\n\tfunction f(_ aVeryLongFirstParameterName: Integer, _ pick: Integer = match 1 -> Integer {\n\t\tcase 1 { <- 1 }\n\t\tcase Integer { <- 2 }\n\t}) -> Integer {\n\t\t<- pick\n\t}\n}\n",
			)

			expect(formatted).toContain(
				"function f(_ aVeryLongFirstParameterName: Integer, _ pick: Integer = match 1 -> Integer {",
			)
		})

		// A default holding a Comment is laid out like any List, broken, with
		// the Comment before its item.
		it("keeps a Comment written inside a default", () => {
			let source =
				"implementation {\n\tfunction f(_ items: List<Integer> = [\n\t\t§ the first one\n\t\t1,\n\t\t2,\n\t]) -> List<Integer> {\n\t\t<- items\n\t}\n}\n"
			let result = format(source)

			expect(result.refusal).toBeNull()
			expect(result.text).toBe(source)
		})
	})

	// Once a header breaks, a block's `{` is not on its owner's first line.
	// The opening Comment is claimed on the line the `{` is found on.
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
				"implementation {\n\ttype Box = { value: Integer }\n\tnamespace BoxOps for Box {\n\t\tdouble() -> Box {\n\t\t\t<- { value = @.value::multiply(with 2) }\n\t\t} § trailing on method close\n\n\t\ttriple() -> Box {\n\t\t\t<- { value = @.value::multiply(with 3) }\n\t\t}\n\t}\n}\n"
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
				"implementation {\n\tconstant value: Optional<Integer> = #Value(1)\n\tconstant digit = 1\n\tconstant next: Optional<Integer> = #Value(value::value(defaultingTo 0)::multiply(with 10)::add(digit))\n}\n"

			expect(formatted(source)).toContain(
				"= #Value(\n\t\tvalue::value(defaultingTo 0)::multiply(with 10)::add(digit)\n\t)\n",
			)
		})

		it("breaks a Case payload's parentheses before a Function literal's Parameters", () => {
			let source =
				"implementation {\n\tconstant boxed: Step<Integer, (_ x: Integer) -> Integer> = #Done((_ x: Integer) -> Integer { <- x })\n\n\tconstant wrapped = #Wrap(#Done((_ first: Integer, _ second: Integer) -> Integer { <- first }))\n}\n"

			expect(formatted(source)).toBe(
				"implementation {\n\tconstant boxed: Step<Integer, (_ x: Integer) -> Integer> = #Done(\n\t\t(_ x: Integer) -> Integer { <- x }\n\t)\n\n\tconstant wrapped = #Wrap(#Done(\n\t\t(_ first: Integer, _ second: Integer) -> Integer { <- first }\n\t))\n}\n",
			)
		})

		it("breaks a Case payload's parentheses before a match head that does not fit", () => {
			let source =
				"implementation {\n\tconstant longerNameForThisOne: Step<Integer, Integer> = #Done(match someValueWithAName -> Integer { case #A { <- 1 } case #B { <- 2 } })\n}\n"

			expect(formatted(source)).toBe(
				"implementation {\n\tconstant longerNameForThisOne: Step<Integer, Integer> = #Done(\n\t\tmatch someValueWithAName -> Integer {\n\t\t\tcase #A { <- 1 }\n\t\t\tcase #B { <- 2 }\n\t\t}\n\t)\n}\n",
			)
		})

		it("keeps a Function literal payload hugged while its head fits", () => {
			let source =
				"implementation {\n\tconstant step = #Done((_ first: Integer, _ second: Integer) -> Integer {\n\t\tconstant sum = first::add(second)\n\n\t\t<- sum\n\t})\n\n\tconstant s = #Done((_ x: Integer) -> Integer { <- x::add(1)::add(2)::add(3)::add(4)::add(5)::add(6) })\n}\n"

			expect(formatted(source)).toBe(
				"implementation {\n\tconstant step = #Done((_ first: Integer, _ second: Integer) -> Integer {\n\t\tconstant sum = first::add(second)\n\n\t\t<- sum\n\t})\n\n\tconstant s = #Done((_ x: Integer) -> Integer {\n\t\t<- x::add(1)::add(2)::add(3)::add(4)::add(5)::add(6)\n\t})\n}\n",
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
				"constant a  = xs\n\t\t::map((n) {\n\t\t\tconstant m = n\n\t\t\t<- m\n\t\t})\n\t\t::filter((n) { <- true })\n",
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

	// Moves the comment anchors catch, which pass the tree comparison and a
	// plain comparison of Comment texts. See "Comment anchors" in
	// DEVELOPMENT.md.
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
