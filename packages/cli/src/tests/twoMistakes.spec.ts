import { describe, expect, it } from "bun:test"
import { readFileSync, realpathSync } from "node:fs"
import path from "node:path"

import { compileToMemory } from "@essence-lang/compiler/embed"
import type { common } from "@essence-lang/interfaces"
import { analyse } from "@essence-lang/language-server/analyse"

import { compileFile } from "../pipeline"
import { withFiles } from "./harness"

// NOTE: The guard that says one run reports every INDEPENDENT mistake — and
// nothing else. Each Program below holds two mistakes that have nothing to do
// with one another, and the assertion is the EXACT set of codes and lines, so
// it fails both ways: a genuine mistake that goes missing, and a cascade that
// turns up beside the one that caused it.
//
// It is written as exact sets rather than as "contains" for the reason the
// stand-downs exist at all. Every one of them buys silence, and a check written
// as "at least these" can be satisfied by a Compiler that says nothing about
// anything. The pairs come from a survey of the recovery's reach: a name
// dropped in one body and read in another, a `<-` orphaned by a dropped head
// and a `<-` written at the top level on purpose, a Choice taken down whole and
// a Case nothing declares.
//
// It is a CLI spec because the CLI is the only package that can reach all three
// readers — the command line, the Editor, and the seam a host embeds the
// Compiler through. All three are held to the same list: a reader who meets a
// mistake in one of them and not in another has no way to tell which is telling
// them the truth about their file.

// NOTE: `code@line` — the two halves a reader acts on. The column and the
// message are the business of the specs that own each Diagnostic; what this one
// is about is WHICH mistakes were found and where.
function placedCodes(diagnostics: Array<common.Diagnostic>): Array<string> {
	return diagnostics.map(
		(diagnostic) =>
			`${diagnostic.code}@${diagnostic.position?.start.line ?? "-"}`,
	)
}

type TwoMistakes = {
	name: string
	source: string
	// NOTE: Every Diagnostic the file is owed, in source order, and no others.
	expected: Array<string>
}

const PROGRAMS: Array<TwoMistakes> = [
	// NOTE: The shape every stand-down here is about: a Statement the Parser
	// dropped, and a second mistake further down that has nothing to do with it.
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
	// NOTE: The other side of it. The `missing-return` for `doubled` is NOT
	// owed — the `<-` that would have made it return is the text the Parser
	// dropped — while `tripled`, written whole, really does fall off its end.
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
	// NOTE: A dropped Constant leaves no body without a head, so the `<-` below
	// it is one the reader wrote at the top level and is owed its report.
	{
		name: "a dropped Constant and a '<-' written at the top level",
		source: `implementation {
	constant limit 10

	<- 42
}
`,
		expected: ["syntax-error@2", "top-level-return@4"],
	},
	// NOTE: And far away from it, under a Function the Parser read whole.
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
	// NOTE: The dropped HEAD, which is the case the stand-down exists for. Its
	// body is left standing where the top level is, and every `<-` in it is the
	// one syntax error over again.
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
	// NOTE: One missing brace, several orphaned Returns — all from the one
	// mistake, so all silent.
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
	// NOTE: A head dropped BELOW the `<-` orphans nothing above it.
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
	// NOTE: A name dropped inside one Function's body is not in scope in the
	// next Function along, so the read there is a second mistake.
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
	// NOTE: A `type` is hoisted only at a section's top level, so one dropped
	// inside a body is not a Type the Parameter below can name.
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
	// NOTE: And the silence a top-level `choice` IS owed, both ways it is named
	// — `Signal` as a Type and `Signal#Red` as a qualified Case. The Match
	// below is written against a Choice whose Cases were dropped, so what it
	// does not handle says nothing either.
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
	// NOTE: A Choice dropped inside a BODY, and a Case of the whole Choice
	// named at the top level. The inner `choice Other` is not what `Signal#Green`
	// is about, so the Case nothing declares is still owed its report.
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
	// NOTE: A Match that really does not handle every Case, beside a syntax
	// error written where the Match can not reach.
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
	// NOTE: A Function that calls itself on every path really can never return
	// — and the syntax error two lines up is about a Constant that has nothing
	// to do with it.
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
	// NOTE: And the same check standing down, because the dropped Statement is
	// written INSIDE the body whose paths are being counted: a `<-` may be
	// exactly what went missing.
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
	// NOTE: Three stages, three mistakes, one run — the finding this whole seam
	// was built for, with a fourth thing that is NOT owed: the `label` the
	// Parser dropped.
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
	// NOTE: Two mistakes with no syntax error between them, which is the
	// baseline every stand-down is measured against: nothing was abandoned, so
	// nothing is owed silence.
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
	// NOTE: An Error INSIDE a written List does not stop the List from having a
	// Type, so the Constant it is assigned to is still judged.
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
	// NOTE: And inside a written Record, with a member nothing declares read
	// off it below.
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
	// NOTE: A Protocol whose member list lost an entry. The Namespace below
	// conforms to what the Protocol was left with, so nothing is owed about the
	// conformance — the one mistake is the entry.
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
	// NOTE: A Namespace with no target Type can not hold a Method that takes
	// one, so the Method is refused where it is written and left carrying an
	// Error receiver. Every call of it then counted one Parameter more than the
	// reader can see — the Namespace's mistake reported a second time, as
	// something wrong with a call that is written exactly right.
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
	// NOTE: A static Property dropped out of a Namespace body, read with `.`
	// below it, beside a member of the same Namespace that really is not there.
	// The `::` side of the lookup has always stood down for a dropped member;
	// the `.` side never did, so the one syntax error reported again at every
	// read of what it took away.
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
	// NOTE: And the files that hold ONE mistake, which is what says the pairs
	// above are pairs rather than a Compiler that reports everything twice.
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
					// NOTE: Through `realpath`, because every reader
					// canonicalises the entry it was handed and a temporary
					// directory on macOS is reached through a symbolic link —
					// so the path a group is filed under is not the path this
					// spec wrote the file at.
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
