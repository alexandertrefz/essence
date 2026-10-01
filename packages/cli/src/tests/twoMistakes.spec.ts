import { describe, expect, it } from "bun:test"
import { readFileSync, realpathSync } from "node:fs"
import path from "node:path"

import { compileToMemory } from "@essence-lang/compiler/embed"
import type { common } from "@essence-lang/interfaces"
import { analyse } from "@essence-lang/language-server/analyse"

import { compileFile } from "../pipeline"
import { withFiles } from "./harness"

// One run reports every independent mistake and nothing else. Each Program holds
// two unrelated mistakes, and the assertion is the exact set of codes and lines.
// So it fails on a missing mistake and on a cascade alike. A check of "at least
// these" would pass a Compiler that says nothing.
//
// Only the CLI reaches all three readers: the command line, the Editor, and the
// seam a host embeds the Compiler through. All three are held to one list.

// `code@line`, what a reader acts on. Columns and messages belong to the specs
// that own each Diagnostic.
function placedCodes(diagnostics: Array<common.Diagnostic>): Array<string> {
	return diagnostics.map(
		(diagnostic) =>
			`${diagnostic.code}@${diagnostic.position?.start.line ?? "-"}`,
	)
}

type TwoMistakes = {
	name: string
	source: string
	// Every Diagnostic the file is owed, in source order, and no others.
	expected: Array<string>
}

const PROGRAMS: Array<TwoMistakes> = [
	// The shape every stand-down concerns: a Statement the Parser dropped, and an
	// unrelated second mistake further down.
	{
		name: "a dropped Constant and a Function that falls off the end",
		source: `implementation {
	constant greeting "hello"

	function describe(_ n: Integer) -> String {
		if n::isGreaterThan(0) {
			<- "positive"
		}
	}
}
`,
		expected: ["syntax-error@2", "missing-return@4"],
	},
	// The `missing-return` for `doubled` is not owed, since the dropped text holds
	// its `<-`. `tripled`, written whole, really does fall off its end.
	{
		name: "a Method whose Return was dropped and a Method that has none",
		source: `implementation {
	namespace Sizes for Integer {
		doubled() -> Integer {
			<- @::multiply(with 2
		}

		tripled() -> Integer {
			constant unused = 1
		}
	}

	Terminal.print(2::doubled()::toString())
}
`,
		expected: ["syntax-error@5", "missing-return@7"],
	},
	// A dropped Constant leaves no body without a head, so the `<-` below it is a
	// top-level one and is owed its report.
	{
		name: "a dropped Constant and a '<-' written at the top level",
		source: `implementation {
	constant limit 10

	<- 42
}
`,
		expected: ["syntax-error@2", "top-level-return@4"],
	},
	// And far from it, under a Function the Parser read whole.
	{
		name: "a Constant dropped inside a body and a '<-' far below it",
		source: `implementation {
	function helper() -> Integer {
		constant step 1
		<- 0
	}

	function other(_ n: Integer) -> Integer {
		<- n
	}

	constant value = other(2)

	<- value
}
`,
		expected: ["syntax-error@3", "top-level-return@13"],
	},
	// A dropped head leaves its body at the top level, and every `<-` in it repeats
	// the one syntax error, so they stay silent.
	{
		name: "a Function head that lost its brace",
		source: `implementation {
	function helper() -> Integer
		<- 1
	}
}
`,
		expected: ["syntax-error@3", "unexpected-token@5"],
	},
	// One missing brace orphans several Returns, all silent.
	{
		name: "a dropped head that orphans two Returns",
		source: `implementation {
	function f() -> Integer
		<- 1
		<- 2
	}
}
`,
		expected: ["syntax-error@3", "unexpected-token@6"],
	},
	// A head dropped below the `<-` orphans nothing above it.
	{
		name: "a '<-' at the top level above the run that was abandoned",
		source: `implementation {
	<- 5

	function helper() -> Integer {
		constant step 1
		<- 0
	}
}
`,
		expected: ["top-level-return@2", "syntax-error@5"],
	},
	// A name dropped inside one Function's body is not in scope in the next
	// Function, so the read there is a second mistake.
	{
		name: "a Variable dropped in one body and read in another",
		source: `implementation {
	function subtotal() -> Integer {
		variable total 0
		<- total
	}

	function report() -> String {
		<- total::toString()
	}
}
`,
		expected: ["syntax-error@3", "unknown-name@8"],
	},
	{
		name: "a Constant dropped in a body and read at the top level",
		source: `implementation {
	function helper() -> Integer {
		constant shipping 5
		<- 0
	}

	Terminal.print(shipping::toString())
}
`,
		expected: ["syntax-error@3", "unknown-name@7"],
	},
	// A `type` is hoisted only at a section's top level, so one dropped inside a
	// body is not a Type the Parameter can name.
	{
		name: "a Type dropped inside a body and named outside it",
		source: `implementation {
	function make() -> Integer {
		type Point { x: Integer }
		<- 1
	}

	function use(_ p: Point) -> Integer {
		<- 1
	}
}
`,
		expected: ["syntax-error@3", "unknown-type@7"],
	},
	// A dropped top-level `choice` is owed silence as `Signal` and as `Signal#Red`.
	// The Match against it says nothing about unhandled Cases either.
	{
		name: "a dropped Choice named as a Type and as a qualified Case",
		source: `implementation {
	choice Signal {
		Red,
		Amber
		Green,
	}

	constant s: Signal = Signal#Red

	constant action = match s -> String {
		case #Red { <- "stop" }
		case #Amber { <- "wait" }
	}
}
`,
		expected: ["syntax-error@5"],
	},
	// A Choice dropped inside a body, and a Case of another Choice named at the top
	// level. That undeclared Case is still owed its report.
	{
		name: "a Choice dropped in a body and a Case nothing declares",
		source: `implementation {
	choice Signal {
		Red,
		Amber,
	}

	function dropped() -> Integer {
		choice Other {
			Green

		<- 1
	}

	constant s: Signal = Signal#Green
}
`,
		expected: ["unclosed-block@8", "syntax-error@11", "unknown-case@14"],
	},
	// A Match that does not handle every Case, beside a syntax error it cannot
	// reach.
	{
		name: "a dropped Constant and a Match that misses a Case",
		source: `implementation {
	choice Signal {
		Red,
		Amber,
		Green,
	}

	constant broken 1

	constant signal: Signal = Signal#Red

	constant action = match signal -> String {
		case #Red { <- "stop" }
	}
}
`,
		expected: ["syntax-error@8", "missing-case@12"],
	},
	{
		name: "a dropped Constant and a Case that can never match",
		source: `implementation {
	constant oops 1

	constant other: Integer | Boolean = 1

	constant described = match other -> String {
		case Integer { <- "number" }
		case Boolean { <- "flag" }
		case String  { <- "never" }
	}
}
`,
		expected: ["syntax-error@2", "unreachable-case@9"],
	},
	{
		name: "a dropped Constant and an Argument of the wrong Type",
		source: `implementation {
	constant oops 1

	function greet(_ name: String) -> String {
		<- name
	}

	constant said = greet(42)
}
`,
		expected: ["syntax-error@2", "argument-type-mismatch@8"],
	},
	// A Function that calls itself on every path never returns, and the syntax error
	// above it concerns an unrelated Constant.
	{
		name: "a dropped Constant and a Method that recurses forever",
		source: `implementation {
	constant seed 1

	namespace Counting for Integer {
		countdown() -> Integer {
			<- @::countdown()
		}
	}
}
`,
		expected: ["syntax-error@2", "infinite-recursion@5"],
	},
	// The same check stands down when the dropped Statement is inside the body whose
	// paths are counted, since it may be the missing `<-`.
	{
		name: "a Statement dropped inside the body that would recurse",
		source: `implementation {
	namespace Counting for Integer {
		countdown() -> Integer {
			constant note "x"
			<- @::countdown()
		}
	}
}
`,
		expected: ["syntax-error@4"],
	},
	// Three stages, three mistakes, one run, and the dropped `label` is not owed.
	{
		name: "a dropped Constant, a Record missing a member and an undeclared name",
		source: `implementation {
	type Point = { x: Integer, y: Integer }

	constant label 1

	function origin() -> Point {
		<- { x = 0 }
	}

	Terminal.print(undeclared)
}
`,
		expected: [
			"syntax-error@4",
			"return-type-mismatch@7",
			"unknown-name@10",
		],
	},
	// Two mistakes with no syntax error: nothing was dropped, so nothing is owed
	// silence.
	{
		name: "two Functions returning the wrong Type",
		source: `implementation {
	function one() -> Integer {
		<- "text"
	}

	function two() -> String {
		<- 7
	}
}
`,
		expected: ["return-type-mismatch@3", "return-type-mismatch@7"],
	},
	// An Error inside a written List still leaves it a Type, so its Constant is
	// still judged.
	{
		name: "an undeclared name in a List and a List assigned to a String",
		source: `implementation {
	function total(_ items: List<Integer>) -> Integer {
		<- 0
	}

	constant values = [1, undeclared, 3]
	constant sum = total(values)
	constant text: String = values
}
`,
		expected: ["unknown-name@6", "assignment-type-mismatch@8"],
	},
	// Likewise inside a written Record, with an undeclared member read off it.
	{
		name: "an undeclared name in a Record and a member nothing declares",
		source: `implementation {
	type Box = { size: Integer }

	constant box = { size = undeclared }

	constant n: Integer = box
	Terminal.print(box.missing::toString())
}
`,
		expected: [
			"unknown-name@4",
			"assignment-type-mismatch@6",
			"unknown-member@7",
		],
	},
	// A Protocol lost a member entry. The Namespace conforms to what remains, so the
	// one mistake is the entry.
	{
		name: "a Protocol member dropped and a Namespace conforming to the rest",
		source: `implementation {
	protocol Sized {
		size() -> Integer
		bad(_ n Integer) -> Integer
	}

	namespace Boxes for Integer is Sized {
		size() -> Integer {
			<- @
		}
	}
}
`,
		expected: ["syntax-error@4"],
	},
	// A Namespace without a target Type refuses a Method that takes one, which then
	// carries an Error receiver. Its calls must not report a Parameter the reader
	// cannot see.
	{
		name: "a Method in an untyped Namespace and a name nothing declares",
		source: `implementation {
	namespace Maths {
		doubled(_ n: Integer) -> Integer {
			<- n::multiply(with 2)
		}
	}

	Terminal.print(Maths.doubled(2)::toString())
	Terminal.print(undeclared)
}
`,
		expected: ["untyped-namespace-method@3", "unknown-name@9"],
	},
	// A hole in a positional Argument shifts every later one, so the call stands
	// down whole.
	{
		name: "an undeclared positional Argument beside one of the wrong Type",
		source: `implementation {
	function pair(_ a: Integer, _ b: String) -> String {
		<- b
	}

	constant result = pair(undeclared, 99)
}
`,
		expected: ["unknown-name@6"],
	},
	// A hole under a label shifts nothing, since labelled Arguments match by label,
	// so the second mistake is found too.
	{
		name: "an undeclared labelled Argument beside one of the wrong Type",
		source: `implementation {
	function pair(first a: Integer, second b: String) -> String {
		<- b
	}

	constant result = pair(first undeclared, second 99)
}
`,
		expected: ["unknown-name@6", "argument-type-mismatch@6"],
	},
	// A static Property dropped from a Namespace body, read with `.`, beside a
	// member that is really missing. Like `::`, the `.` lookup stands down for a
	// dropped member.
	{
		name: "a dropped static Property and a member nothing declares",
		source: `implementation {
	namespace Config {
		static limit = 10
		static broken 20
	}

	Terminal.print(Config.broken::toString())
	Terminal.print(Config.missing::toString())
}
`,
		expected: ["syntax-error@4", "unknown-member@8"],
	},
	// Files with one mistake each, so the pairs above are not a Compiler reporting
	// everything twice.
	{
		name: "a Method that calls itself on every path, alone",
		source: `implementation {
	namespace Counting for Integer {
		countdown() -> Integer {
			<- @::countdown()
		}
	}
}
`,
		expected: ["infinite-recursion@3"],
	},
	{
		name: "a '<-' at the top level, alone",
		source: `implementation {
	<- 42
}
`,
		expected: ["top-level-return@2"],
	},
	{
		name: "a Program with nothing wrong with it",
		source: `implementation {
	constant limit: Integer = 10

	Terminal.print(limit::toString())
}
`,
		expected: [],
	},
]

async function readingsOf(filePath: string): Promise<{
	check: Array<string>
	editor: Array<string>
	embed: Array<string>
}> {
	let outcome = await compileFile({
		inputFileName: filePath,
		outputFileName: null,
		minify: false,
		sourcemap: false,
	})
	let memory = await compileToMemory(filePath)

	return {
		check: placedCodes(
			outcome.modules
				.filter((module) => module.fileName === filePath)
				.flatMap((module) => module.diagnostics),
		),
		editor: placedCodes(analyse(readFileSync(filePath, "utf8"), filePath)),
		embed: placedCodes(
			memory.diagnosticGroups
				.filter((group) => group.filePath === filePath)
				.flatMap((group) => group.diagnostics),
		),
	}
}

describe("two mistakes in one run", () => {
	for (let program of PROGRAMS) {
		it(`reports exactly what is owed for ${program.name}`, async () => {
			await withFiles(
				{ "Main.es": program.source },
				async (directory) => {
					// Through `realpath`: every reader canonicalises its entry, and a temporary
					// directory on macOS is reached through a symbolic link.
					let readings = await readingsOf(
						path.join(realpathSync(directory), "Main.es"),
					)

					expect(readings.check).toEqual(program.expected)
					expect(readings.editor).toEqual(program.expected)
					expect(readings.embed).toEqual(program.expected)
				},
				"essence-two-mistakes-",
			)
		})
	}
})
