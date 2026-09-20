import { describe, expect, it } from "bun:test"

import type { common } from "@essence-lang/interfaces"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { operatorNote } from "../helpers/foreign"
import { parseWithDiagnostics } from "../parser/index"

// NOTE: What a reader arriving from another language writes, and what the
// Compiler says about it. One spec for the whole family, because the family is
// held together by the answer rather than by the stage: `a && b` is refused by
// the Parser and `!a` by the Enricher, and a reader who wrote either is owed the
// same sentence.

function diagnosticsOf(source: string): Array<common.Diagnostic> {
	let parsed = parseWithDiagnostics(source)

	if (containsErrors(parsed.diagnostics)) {
		return parsed.diagnostics
	}

	return enrich(parsed.program).diagnostics
}

function codesOf(source: string): Array<string> {
	return diagnosticsOf(source).map((diagnostic) => diagnostic.code)
}

function messagesOf(source: string): Array<string> {
	return diagnosticsOf(source).map((diagnostic) => diagnostic.message)
}

function helpsOf(source: string): Array<string> {
	return diagnosticsOf(source).flatMap((diagnostic) => diagnostic.helps)
}

function notesOf(source: string): Array<string> {
	return diagnosticsOf(source).flatMap((diagnostic) => diagnostic.notes)
}

function labelsOf(source: string): Array<string> {
	return diagnosticsOf(source).flatMap((diagnostic) =>
		diagnostic.labels.map((label) => label.message),
	)
}

function onlyDiagnostic(source: string): common.Diagnostic {
	let diagnostics = diagnosticsOf(source)

	expect(diagnostics).toHaveLength(1)

	return diagnostics[0]
}

// NOTE: The characters a Position covers — the only way to say that a fix
// rewrites the `.` and not the member beside it without counting columns by
// hand. Single line spans only; every payload asked this covers one.
function spanOf(source: string, position: common.Position): string {
	return source
		.split("\n")
		[position.start.line - 1].slice(
			position.start.column - 1,
			position.end.column - 1,
		)
}

// NOTE: The text the one Diagnostic a Program carries underlines. A Position is
// nullable for the few Diagnostics that stand for a whole file rather than for
// something written in one; every refusal asked here stands at a span.
function refusedSpan(source: string): string {
	return spanOf(source, onlyDiagnostic(source).position as common.Position)
}

// NOTE: What a Help promises, checked by compiling it. A Help built out of the
// reader's own text is only worth more than a placeholder where what it spells
// holds together, so the ones printed below are written back into the probe
// they came from and compiled here.
function compiles(source: string): boolean {
	let parsed = parseWithDiagnostics(source)

	if (containsErrors(parsed.diagnostics)) {
		return false
	}

	return !containsErrors(enrich(parsed.program).diagnostics)
}

// NOTE: Written as one line per Statement with a real tab, so a span read back
// out of the source is read out of the text a reader would have written.
function program(...lines: Array<string>): string {
	return ["implementation {", ...lines.map((line) => `\t${line}`), "}"].join(
		"\n",
	)
}

describe("Foreign syntax", () => {
	describe("a Method reached with '.'", () => {
		it("names the Method rather than the missing member", () => {
			let source = program(
				'constant names = ["ada", "alan"]',
				"Terminal.print(names.length())",
			)

			expect(codesOf(source)).toEqual(["method-called-with-dot"])
			expect(messagesOf(source)).toEqual([
				"'length' is a Method, not a member",
			])
			expect(labelsOf(source)).toEqual([
				"a Method is reached with '::'",
				"this is a List<String>",
			])
			expect(helpsOf(source)).toEqual([
				"Write '::length' in place of '.length'.",
			])
		})

		it("says a Method is called where the member was read", () => {
			let source = program(
				'constant names = ["ada"]',
				"Terminal.print(names.length)",
			)

			expect(codesOf(source)).toEqual(["method-called-with-dot"])
			expect(helpsOf(source)).toEqual([
				"Write '::length()' in place of '.length' — a Method is called, never read.",
			])
		})

		// NOTE: `add` takes an Argument, so the parentheses a fix would write
		// answer a Method that needs one — the Help says so with its ellipsis and
		// the payload leaves the call out.
		it("leaves the parentheses to the reader where the Method takes an Argument", () => {
			let source = program("constant n = 1", "Terminal.print(n.add)")

			expect(helpsOf(source)).toEqual([
				"Write '::add(…)' in place of '.add' — a Method is called, never read.",
			])

			expect(onlyDiagnostic(source).data).toBeUndefined()
		})

		it("carries the separator and the call for a fix", () => {
			let source = program(
				'constant s = "ada"',
				"Terminal.print(s.uppercase)",
			)
			let { data } = onlyDiagnostic(source)

			expect(data?.kind).toBe("method-with-dot")

			if (data?.kind !== "method-with-dot") {
				throw new Error(
					"Diagnostic carries no method-with-dot payload.",
				)
			}

			expect(spanOf(source, data.separator)).toBe(".")
			expect(data.call).not.toBeNull()
			expect(spanOf(source, data.call as common.Position)).toBe("")
		})

		it("answers for a String, an Integer and a Dictionary alike", () => {
			expect(
				codesOf(
					program(
						'constant s = "ada"',
						"Terminal.print(s.uppercase())",
					),
				),
			).toEqual(["method-called-with-dot"])
			expect(
				codesOf(
					program("constant n = 1", "Terminal.print(n.absolute())"),
				),
			).toEqual(["method-called-with-dot"])
			expect(
				codesOf(
					program(
						'constant ages = ["ann" = 31]',
						"Terminal.print(ages.isEmpty())",
					),
				),
			).toEqual(["method-called-with-dot"])
		})

		// NOTE: A Record HAS members, so the question is only asked for a name
		// that is not one of them — and answered by the Namespace written over it,
		// which is where `unknown-member` used to stop.
		it("answers for a Record whose Namespace declares the Method", () => {
			let source = program(
				"type Money = { euros: Integer }",
				"namespace Monies for Money {",
				"\tdoubled() -> Integer { <- @.euros::multiply(with 2) }",
				"}",
				"constant price: Money = { euros = 3 }",
				"Terminal.print(price.doubled())",
			)

			expect(codesOf(source)).toEqual(["method-called-with-dot"])
		})

		it("leaves a member a Record really has alone", () => {
			expect(
				codesOf(
					program(
						"constant price = { euros = 3 }",
						"Terminal.print(price.euros)",
					),
				),
			).toEqual([])
		})

		it("leaves a Namespace's own members alone", () => {
			expect(codesOf(program('Terminal.prnt("hi")'))).toEqual([
				"unknown-member",
			])
		})

		// NOTE: The Method is not there, so nothing is offered as a fix — what is
		// added is the sentence that gets the reader to `unknown-method`, which
		// lists what the value does answer.
		it("keeps type-without-members where no Method of the name exists", () => {
			let source = program(
				'constant s = "ada"',
				"Terminal.print(s.charAt(0))",
			)

			expect(codesOf(source)).toEqual(["type-without-members"])
			expect(helpsOf(source)).toEqual([
				"A Method is called with '::' rather than '.' — write '::charAt(…)' if 'charAt' is one.",
			])
			expect(onlyDiagnostic(source).data).toBeUndefined()
		})

		it("says nothing about Methods where the member was only read", () => {
			let source = program(
				'constant s = "ada"',
				"Terminal.print(s.charAt)",
			)

			expect(codesOf(source)).toEqual(["type-without-members"])
			expect(helpsOf(source)).toEqual([])
		})

		it("adds the sentence to a Record's unknown member that was called", () => {
			let source = program(
				"constant price = { euros = 3 }",
				"Terminal.print(price.dollars())",
			)

			expect(codesOf(source)).toEqual(["unknown-member"])
			expect(helpsOf(source)).toEqual([
				"A Method is called with '::' rather than '.' — write '::dollars(…)' if 'dollars' is one.",
			])
		})
	})

	describe("a binding declared in another language", () => {
		// NOTE: THE point of reading the Statement on rather than dropping it: a
		// dropped declaration leaves the name undeclared, and one mistake becomes
		// one Diagnostic per line that reads it.
		it("reports 'const' once and declares the Constant anyway", () => {
			let source = program("const price = 12", "Terminal.print(price)")

			expect(codesOf(source)).toEqual(["foreign-syntax"])
			expect(messagesOf(source)).toEqual([
				"'const' is not how Essence declares a binding",
			])
			expect(helpsOf(source)).toEqual([
				"Write 'constant' in place of 'const'.",
			])
		})

		it("reports 'let' and 'var' as the Variable they declare", () => {
			let source = program(
				"let count = 3",
				"var total = 0",
				"count = 4",
				"total = count",
				"Terminal.print(total)",
			)

			expect(codesOf(source)).toEqual([
				"foreign-syntax",
				"foreign-syntax",
			])
			// NOTE: Both Helps the table carries, not the first of them. A
			// binding nothing reassigns is a `constant`, and a reader who wrote
			// `let` out of habit has no way to know that from the fix alone.
			expect(helpsOf(source)).toEqual([
				"Write 'variable' in place of 'let'.",
				"Or 'constant', where the value is never reassigned.",
				"Write 'variable' in place of 'var'.",
				"Or 'constant', where the value is never reassigned.",
			])
		})

		// NOTE: Rust writes two words where this language writes one, so the two
		// are one habit here: reported over the span they cover, fixed by one
		// edit, and read on as the Variable they declare. Answered word by word
		// they were four Diagnostics, and the fix for the first of them left a
		// `mut` standing between the Keyword and the name.
		it("reads 'let mut' as the one word it stands for", () => {
			let source = program(
				"let mut total = 0",
				"total = total::add(1)",
				"Terminal.print(total)",
			)

			expect(codesOf(source)).toEqual(["foreign-syntax"])
			expect(messagesOf(source)).toEqual([
				"'let' is not how Essence declares a binding",
			])

			let { data } = onlyDiagnostic(source)

			expect(data).toMatchObject({
				kind: "essence-spelling",
				spelling: "variable",
			})

			if (data?.kind !== "essence-spelling") {
				throw new Error(
					"Diagnostic carries no essence-spelling payload.",
				)
			}

			expect(spanOf(source, data.position)).toBe("let mut")
		})

		it("reads the annotation and the Pattern the Statement wrote", () => {
			expect(
				codesOf(
					program(
						"const total: Integer = 12",
						"Terminal.print(total)",
					),
				),
			).toEqual(["foreign-syntax"])

			expect(
				codesOf(
					program(
						"constant point = { x = 1, y = 2 }",
						"const { x, y } = point",
						"Terminal.print(x::add(y))",
					),
				),
			).toEqual(["foreign-syntax"])
		})

		it("carries the Keyword's own span for a fix", () => {
			let source = program("const price = 12", "Terminal.print(price)")
			let { data } = onlyDiagnostic(source)

			expect(data).toEqual({
				kind: "essence-spelling",
				position: expect.anything(),
				spelling: "constant",
			})

			if (data?.kind !== "essence-spelling") {
				throw new Error(
					"Diagnostic carries no essence-spelling payload.",
				)
			}

			expect(spanOf(source, data.position)).toBe("const")
		})

		// NOTE: The words are names, and a Program that declares one keeps it.
		it("leaves the words alone where they are declared", () => {
			expect(
				codesOf(
					program(
						"constant const = 1",
						"constant let = 2",
						"Terminal.print(const::add(let))",
					),
				),
			).toEqual([])
		})

		it("leaves a Constant named 'return' alone", () => {
			expect(
				codesOf(
					program("constant return = 1", "Terminal.print(return)"),
				),
			).toEqual([])
		})
	})

	describe("a value returned in another language", () => {
		it("reports 'return' and reads the value it answers with", () => {
			let source = program(
				"function twice(_ n: Integer) -> Integer { return n::multiply(with 2) }",
				"Terminal.print(twice(2))",
			)

			expect(codesOf(source)).toEqual(["foreign-syntax"])
			expect(messagesOf(source)).toEqual([
				"'return' is not how Essence answers with a value",
			])
			expect(helpsOf(source)).toEqual([
				"Write '<-' in place of 'return'.",
			])
		})
	})

	describe("the words another language has", () => {
		it("answers 'null' and 'undefined' with the Optional", () => {
			expect(codesOf(program("constant missing = null"))).toEqual([
				"foreign-syntax",
			])
			expect(helpsOf(program("constant missing = undefined"))).toEqual([
				"Write '#Empty'.",
			])
		})

		it("answers 'this' with the receiver", () => {
			let source = program(
				"namespace Monies for Integer {",
				"\tdoubled() -> Integer { <- this::multiply(with 2) }",
				"}",
			)

			expect(codesOf(source)).toEqual(["foreign-syntax"])
			expect(helpsOf(source)).toEqual(["Write '@' in place of 'this'."])
		})

		it("answers 'console' and 'print' with the Terminal", () => {
			expect(codesOf(program('console.log("hi")'))).toEqual([
				"foreign-syntax",
			])
			expect(helpsOf(program('print("hi")'))).toEqual([
				"Write 'Terminal.print(…)'.",
			])
		})

		it("carries no spelling where the answer is a shape", () => {
			expect(
				onlyDiagnostic(program('console.log("hi")')).data,
			).toBeUndefined()
		})

		it("refuses a declaration block another language writes", () => {
			let source = program("class Money {", "\teuros() {}", "}")

			expect(codesOf(source)).toEqual(["foreign-syntax"])
			expect(messagesOf(source)).toEqual([
				"'class' declares nothing in Essence",
			])
		})

		it("reads past the block rather than into it", () => {
			expect(codesOf(program("enum Colour { Red, Green }"))).toEqual([
				"foreign-syntax",
			])
		})

		// NOTE: The shape is the whole of the test — two Identifiers and a brace —
		// so a Program that declares one of the words keeps it.
		it("leaves a value named 'class' alone", () => {
			expect(
				codesOf(program("constant class = 1", "Terminal.print(class)")),
			).toEqual([])
		})

		// NOTE: The four shapes a block is opened in — see
		// `foreignBlockBraceOffset`. Each of them used to end in `Expected
		// 'with' but found '}'`, which is the Record Literal reading of the
		// block, reported a screen below the word that opened it.
		it("refuses a block whatever stands between the word and its brace", () => {
			let blocks: Array<[Array<string>, string]> = [
				[
					["try {", '\tTerminal.print("hi")', "}"],
					"'try' opens no block in Essence",
				],
				[
					["switch (x) {", "\tcase 1:", "}"],
					"'switch' opens no block in Essence",
				],
				[
					["while (x) {", '\tTerminal.print("hi")', "}"],
					"'while' opens no block in Essence",
				],
				[
					["func main() {", '\tTerminal.print("hi")', "}"],
					"'func' declares nothing in Essence",
				],
				[
					["fn double(n: i32) -> i32 {", "\tn", "}"],
					"'fn' declares nothing in Essence",
				],
			]

			for (let [lines, message] of blocks) {
				let source = program("constant x = 1", ...lines)

				expect({ message, codes: codesOf(source) }).toEqual({
					message,
					codes: ["foreign-syntax"],
				})
				expect(messagesOf(source)).toEqual([message])
			}
		})

		it("reads past a block nested inside another", () => {
			expect(
				messagesOf(
					program(
						"try {",
						"\tswitch (1) {",
						'\t\tcase 1: Terminal.print("hi")',
						"\t}",
						"}",
					),
				),
			).toEqual(["'try' opens no block in Essence"])
		})

		// NOTE: A block whose `}` never arrives is not read past — the Tokens
		// stay where they are, so nothing a later reading needs is swallowed by
		// a count that could never have balanced. It is still answered once, at
		// the word, and nothing is said about what stands inside it.
		it("answers a block that never closes once, at the word", () => {
			expect(
				messagesOf(
					[
						"implementation {",
						"\ttry {",
						'\t\tTerminal.print("hi")',
					].join("\n"),
				),
			).toEqual(["'try' opens no block in Essence"])
		})

		// NOTE: The words the other four languages people arrive from write.
		// Each is an ordinary name here, so each is answered exactly where an
		// `unknown-name` would have been.
		it("answers the words Python, Rust, Go, Swift and Ruby write", () => {
			let words: Array<[string, string]> = [
				[
					"def",
					"Write 'function greet(_ name: String) -> String { … }'.",
				],
				[
					"fn",
					"Write 'function greet(_ name: String) -> String { … }'.",
				],
				[
					"func",
					"Write 'function greet(_ name: String) -> String { … }'.",
				],
				["elif", "Write 'else if' in place of 'elif'."],
				[
					"len",
					"Write 'items::length()', which answers for a List, a String and a Dictionary alike.",
				],
				["println", "Write 'Terminal.print(…)'."],
				["puts", "Write 'Terminal.print(…)'."],
				["echo", "Write 'Terminal.print(…)'."],
				[
					"fmt",
					"Write 'Terminal.print(…)' to print a value, and 'Terminal.inspect(…)' to print its structure.",
				],
				[
					"guard",
					"Write 'match held -> String { case #Value(value) { … } case #Empty { … } }'.",
				],
				["mut", "Write 'variable' in place of 'let mut'."],
				["Some", "Write '#Value(x)' in place of 'Some(x)'."],
			]

			for (let [word, help] of words) {
				let source = program(`Terminal.print(${word})`)

				expect({ word, codes: codesOf(source) }).toEqual({
					word,
					codes: ["foreign-syntax"],
				})
				expect({ word, helps: helpsOf(source) }).toEqual({
					word,
					helps: [help],
				})
			}
		})

		// NOTE: `println!` is keyed with its `!`, which is what a reader wrote
		// and what the Lexer hands over — a `!` ends no name. Every rule under
		// the table would have taken the `!` off the end and answered about
		// that: the postfix habits first, and the operators behind them.
		it("answers a macro by the whole of what was written", () => {
			let source = program('println!("hi")')

			expect(codesOf(source)).toEqual(["foreign-syntax"])
			expect(messagesOf(source)).toEqual([
				"'println!' names nothing in Essence",
			])
		})

		it("leaves the new words alone where a Program declares them", () => {
			expect(
				codesOf(
					program(
						"constant len = 1",
						"constant fmt = 2",
						"constant guard = 3",
						"constant mut = 4",
						"constant Some = 5",
						"Terminal.print(len::add(fmt)::add(guard))",
						"Terminal.print(mut::add(Some))",
					),
				),
			).toEqual([])
		})
	})

	describe("a Case written without its sigil", () => {
		it("names the Choice that declares it", () => {
			let source = program(
				"choice Light { Red, Green }",
				"constant light: Light = Red",
				"Terminal.print(light::is(#Red))",
			)

			expect(codesOf(source)).toEqual(["unknown-name"])
			expect(helpsOf(source)).toEqual(["Write '#Red'."])
			expect(notesOf(source)).toEqual([
				"'Light' declares a Case '#Red'.",
				"A Case is written with a '#' in front of it, which is what tells one from a name.",
			])
		})

		it("names every Choice that declares it", () => {
			let source = program(
				"choice Light { Red, Green }",
				"choice Wine { Red, White }",
				"constant light: Light = Red",
				"Terminal.print(light::is(#Red))",
			)

			expect(notesOf(source)).toEqual([
				"'Light' declares a Case '#Red'.",
				"'Wine' declares a Case '#Red'.",
				"A Case is written with a '#' in front of it, which is what tells one from a name.",
			])
		})

		it("carries the bare name's span and the sigil for a fix", () => {
			let source = program(
				"choice Light { Red, Green }",
				"constant light: Light = Red",
				"Terminal.print(light::is(#Red))",
			)
			let { data } = onlyDiagnostic(source)

			expect(data).toMatchObject({
				kind: "essence-spelling",
				spelling: "#Red",
			})

			if (data?.kind !== "essence-spelling") {
				throw new Error(
					"Diagnostic carries no essence-spelling payload.",
				)
			}

			expect(spanOf(source, data.position)).toBe("Red")
		})

		it("leaves a name that is no Case to the near miss it always had", () => {
			let source = program("constant total = 1", "Terminal.print(totla)")

			expect(codesOf(source)).toEqual(["unknown-name"])
			expect(helpsOf(source)).toEqual(["Did you mean 'total'?"])
		})

		// NOTE: The three shapes where the guess is withheld — see
		// `reportBareCaseName`. Each of them used to write an edit that the
		// reader would have had to undo.
		it("says nothing where an APPLIED name matches a Case that takes nothing", () => {
			let source = program(
				"choice Light { Red, Green }",
				'Terminal.print(Red("dark"))',
			)

			expect(codesOf(source)).toEqual(["unknown-name"])
			expect(helpsOf(source)).toEqual([])
			expect(notesOf(source)).toEqual([])
		})

		it("withholds the fix where the Case carries a payload and none was written", () => {
			let source = program(
				"choice Light { Red { shade: String }, Green }",
				"constant light: Light = Red",
				"Terminal.print(light::is(#Green))",
			)

			expect(codesOf(source)).toEqual(["unknown-name"])
			expect(helpsOf(source)).toEqual([
				"Write '#Red(…)' — the Case carries a payload.",
			])
			expect(notesOf(source)).toEqual([
				"'Light' declares a Case '#Red'.",
				"A Case is written with a '#' in front of it, which is what tells one from a name.",
			])
			expect(onlyDiagnostic(source).data).toBeUndefined()
		})

		it("offers the sigil where the payload written matches a Case that takes one", () => {
			let source = program(
				"choice Light { Red { shade: String }, Green }",
				'constant light: Light = Red(shade "dark")',
				"Terminal.print(light::is(#Green))",
			)

			expect(helpsOf(source)).toEqual(["Write '#Red'."])
			expect(onlyDiagnostic(source).data).toMatchObject({
				kind: "essence-spelling",
				spelling: "#Red",
			})
		})

		// NOTE: `{ Red }` is a Record Literal's shorthand, where the name is the
		// member AND its value — so the sigil written over the name alone leaves
		// `{ #Red }`, which is not a Record Literal at all but `Expected 'with'`.
		// The member is spelled out instead.
		it("spells the member out where the name is a shorthand", () => {
			let source = program(
				"choice Light { Red, Green }",
				"constant lit = { Red }",
				"Terminal.print(lit::toString())",
			)

			expect(helpsOf(source)).toEqual(["Write 'Red = #Red'."])
			expect(onlyDiagnostic(source).data).toMatchObject({
				kind: "essence-spelling",
				spelling: "Red = #Red",
			})
		})

		it("says nothing where a habit was already reported on the line", () => {
			let source = program(
				"choice Failure { Timeout, Error }",
				'constant f: Failure = new Error("boom")',
				"Terminal.print(f::is(#Timeout))",
			)

			expect(messagesOf(source)).toEqual([
				"'new' names nothing in Essence",
				"'Error' is not declared",
			])
			expect(notesOf(source)).toEqual([
				"There is no 'new' and there are no classes: a Literal builds a value, and a static Method makes one where building it takes work.",
			])
		})
	})

	describe("operators", () => {
		it("refuses every arithmetic operator by name", () => {
			for (let [written, operator] of [
				["1 + 2", "+"],
				["1 - 2", "-"],
				["1 * 2", "*"],
				["1 / 2", "/"],
				["1 % 2", "%"],
			]) {
				let source = program(`constant total = ${written}`)

				expect(codesOf(source)).toEqual(["operator-not-supported"])
				expect(messagesOf(source)).toEqual([
					`Essence has no '${operator}' operator`,
				])
			}
		})

		it("refuses every comparison operator by name", () => {
			for (let [written, operator] of [
				["1 == 2", "=="],
				["1 === 2", "==="],
				["1 != 2", "!="],
				["1 !== 2", "!=="],
				["1 < 2", "<"],
				["1 <= 2", "<="],
				["1 > 2", ">"],
				["1 >= 2", ">="],
			]) {
				let source = program(`constant same = ${written}`)

				expect(messagesOf(source)).toEqual([
					`Essence has no '${operator}' operator`,
				])
			}
		})

		it("names the Method each operator stands for", () => {
			expect(helpsOf(program("constant total = 1 + 2"))).toEqual([
				"Write 'a::add(b)' for Numbers.",
				"Write 'a::append(b)' to join two Strings.",
			])
			expect(helpsOf(program("constant same = 1 == 2"))).toEqual([
				"Write 'a::is(b)', which compares Records and Lists by their content.",
			])
			expect(helpsOf(program("constant both = true && false"))).toEqual([
				"Write 'a::and(b)' — both sides are worked out, so nest an 'if' where the right one must not run.",
			])
		})

		// NOTE: The whole family, in the four places one is written: between two
		// Literals and between two names, as a whole Statement and inside a
		// call. The call with NAMES in it is where six of the fourteen used to
		// fall through to `Expected ')' but found 'tax'` — `total` read as an
		// Argument's label and `+ tax` as its value — and it is the one column
		// nothing covered, because a Literal can not be a label and so the
		// Literal row always went the other way.
		it("names the operator wherever one is written", () => {
			let operators = [
				"+",
				"-",
				"*",
				"/",
				"%",
				"==",
				"===",
				"!=",
				"<",
				">",
				"&&",
				"||",
				"??",
			]

			for (let operator of operators) {
				for (let [left, right] of [
					["1", "2"],
					["a", "b"],
				]) {
					let written = `${left} ${operator} ${right}`
					let sources = [
						program(
							"constant a = 1",
							"constant b = 2",
							`constant v = ${written}`,
						),
						program(
							"constant a = 1",
							"constant b = 2",
							`Terminal.print(${written})`,
						),
					]

					for (let source of sources) {
						expect({ written, codes: codesOf(source) }).toEqual({
							written,
							codes: ["operator-not-supported"],
						})
						expect({
							written,
							messages: messagesOf(source),
						}).toEqual({
							written,
							messages: [`Essence has no '${operator}' operator`],
						})
					}
				}
			}
		})

		// NOTE: The other half of the rule above: a name in front of an operator
		// is no label, and a name in front of a VALUE still is. `-` is the one
		// lexeme of the family that opens a value of this language, so a label
		// stands in front of it and a negative Number follows.
		it("keeps a labelled Argument whose value opens with punctuation", () => {
			expect(
				codesOf(
					program(
						"function f(label n: Integer) -> Integer { <- n }",
						"Terminal.print(f(label -1))",
					),
				),
			).toEqual([])

			expect(
				helpsOf(
					program(
						"function f(label n: Boolean) -> Boolean { <- n }",
						"constant ready = true",
						"Terminal.print(f(label !ready))",
					),
				),
			).toEqual(["Write 'ready::negate()'."])

			expect(
				helpsOf(
					program(
						"function f(label s: String) -> String { <- s }",
						"Terminal.print(f(label 'hi'))",
					),
				),
			).toEqual([`Write '"hi"'.`])
		})

		// NOTE: There are no grouping parentheses, so a `(` in Expression
		// position opens a Function literal's Parameter list — which read `a` as
		// a label and `+` as the name it labelled, and answered with
		// `redundant-parameter-label` about a Parameter nobody wrote.
		it("names the operator inside parentheses a reader wrote to group", () => {
			let source = program(
				"constant a = 1",
				"constant b = 2",
				"constant c = 3",
				"constant x = (a + b) * c",
			)

			expect(codesOf(source)).toEqual(["operator-not-supported"])
			expect(messagesOf(source)).toEqual(["Essence has no '+' operator"])
			expect(notesOf(source)).toEqual([operatorNote])
		})

		it("refuses an operator written flush against its operands", () => {
			expect(codesOf(program("constant total = 1+2"))).toEqual([
				"operator-not-supported",
			])
			expect(
				codesOf(
					program(
						"constant ready = true",
						"constant a = ready&&ready",
					),
				),
			).toEqual(["operator-not-supported"])
		})

		// NOTE: `!ready` is one Identifier — a `!` ends no name — so it is the
		// Enricher that meets it, and the operand is in hand there. The table's
		// own Help is the same sentence with a placeholder standing where the
		// name goes, so it is REPLACED rather than printed under it.
		it("names the operand of a prefix '!'", () => {
			let source = program(
				"constant ready = true",
				"constant flipped = !ready",
			)

			expect(codesOf(source)).toEqual(["operator-not-supported"])
			expect(helpsOf(source)).toEqual(["Write 'ready::negate()'."])
		})

		// NOTE: The name is offered as the thing to negate only where it IS the
		// thing being negated. `- tree::hasItems()` negates the call, and
		// `tree::negate()` is an edit about something else.
		it("says the rule rather than the name where the '-' leads a call", () => {
			let source = program(
				"constant tree = [1, 2]",
				"constant empty = - tree::hasItems()",
			)

			expect(codesOf(source)).toEqual(["operator-not-supported"])
			expect(helpsOf(source)).toEqual([
				"A value is negated with '::negate()' written on it.",
			])
		})

		it("refuses a compound assignment", () => {
			let source = program("variable count = 0", "count += 1")

			expect(codesOf(source)).toEqual(["operator-not-supported"])
			expect(helpsOf(source)).toEqual(["Write 'count = count::add(1)'."])
		})

		// NOTE: The binding and the amount are the reader's own. `count` and `1`
		// used to be printed whatever was written, so `tally += 5` was answered
		// with two names nothing declares and an amount nobody asked for.
		it("spells a compound assignment with the operands that were written", () => {
			let source = program("variable tally = 0", "tally += 5")

			expect(codesOf(source)).toEqual(["operator-not-supported"])
			expect(helpsOf(source)).toEqual(["Write 'tally = tally::add(5)'."])
			expect(
				compiles(
					program("variable tally = 0", "tally = tally::add(5)"),
				),
			).toBe(true)
		})

		// NOTE: `count++` is one Identifier, so it is the Enricher that meets it
		// and the binding is in hand there too. The amount is in the operator
		// rather than in the text, which is why nothing is read behind it.
		it("spells the binding a postfix increment counts", () => {
			let source = program("variable hits = 0", "hits++")

			expect(codesOf(source)).toEqual(["operator-not-supported"])
			expect(helpsOf(source)).toEqual(["Write 'hits = hits::add(1)'."])
			expect(
				compiles(program("variable hits = 0", "hits = hits::add(1)")),
			).toBe(true)
		})

		// NOTE: The right operand is spelled only where it is one Token and the
		// whole of what is left of the Statement. Anything longer is an
		// Expression of the reader's own, and half of one printed back is worse
		// than the `…` that says theirs goes here.
		it("writes '…' where the amount is an Expression of its own", () => {
			let source = program(
				"variable tally = 0",
				"constant other = 2",
				"tally += other::add(1)",
			)

			expect(codesOf(source)).toEqual(["operator-not-supported"])
			expect(helpsOf(source)).toEqual(["Write 'tally = tally::add(…)'."])
		})

		// NOTE: What is written here is a REASSIGNMENT, so the Help has to
		// answer an Integer: `divide(by:)` answers a fraction, and the counter
		// it would be written back into is not one.
		it("offers a whole answer for a compound division", () => {
			let source = program("variable count = 10", "count /= 2")

			expect(codesOf(source)).toEqual(["operator-not-supported"])
			expect(helpsOf(source)).toEqual([
				"Write 'count = count::quotient(dividingBy 2)', which answers a whole number.",
				"Or 'count::divide(by 2)' where the answer is a fraction, which is a Rational rather than an Integer.",
			])
			expect(
				compiles(
					program(
						"variable count = 10",
						"count = count::quotient(dividingBy 2)",
					),
				),
			).toBe(true)
		})

		// NOTE: There is no Method to offer for these four, and a Help that
		// says so is a rule wearing an action's clothes. The rule is a Note.
		it("answers a bitwise operator with a Note and no Help", () => {
			let source = program("constant masked = 6 & 3")

			expect(codesOf(source)).toEqual(["operator-not-supported"])
			expect(helpsOf(source)).toEqual([])
			expect(notesOf(source)).toEqual([
				operatorNote,
				"Essence has no bitwise operations, and no Method stands in for one.",
			])
		})

		it("refuses the nullish operator with the Optional's own Method", () => {
			let source = program("constant n = 1", "constant m = n ?? 2")

			expect(codesOf(source)).toEqual(["operator-not-supported"])
			expect(helpsOf(source)).toEqual([
				"Write 'x::value(defaultingTo d)' — a value that may be missing is an Optional.",
			])
		})

		// NOTE: A Statement ends at the end of its Expression, so a `-` opening
		// the next line is a negative Number and not a subtraction anybody wrote.
		it("leaves a Statement that opens on the next line alone", () => {
			expect(
				codesOf(
					program(
						"constant price = 3",
						"Terminal.print(price)",
						"Terminal.print(-1)",
					),
				),
			).toEqual([])
		})
	})

	describe("the shapes another language writes", () => {
		it("refuses a Record member written with a colon", () => {
			let source = program("constant origin = { x: 0, y: 0 }")

			expect(codesOf(source)).toEqual(["foreign-syntax"])
			expect(messagesOf(source)).toEqual([
				"A Record member is written with '='",
			])
			expect(helpsOf(source)).toEqual(["Write 'x = …'."])
		})

		it("refuses an arrow Function literal", () => {
			expect(
				messagesOf(program("constant double = (n: Integer) => n")),
			).toEqual(["A Function literal has no '=>'"])
			expect(
				messagesOf(
					program(
						"constant items = [1, 2]",
						"constant a = items::map(n => n)",
					),
				),
			).toEqual(["A Function literal has no '=>'"])
		})

		it("refuses a conditional operator with the define it stands for", () => {
			let source = program("constant n = true ? 1 : 2")

			expect(codesOf(source)).toEqual(["foreign-syntax"])
			expect(helpsOf(source)).toEqual([
				"Write 'define { as a if c as b otherwise }'.",
			])
		})

		it("refuses a ';' at the end of a Statement", () => {
			expect(messagesOf(program("constant total = 1;"))).toEqual([
				"A Statement does not end with ';'",
			])
			expect(messagesOf(program('Terminal.print("hi");'))).toEqual([
				"A Statement does not end with ';'",
			])
		})

		// NOTE: A `;` ends no name, so `total;` is ONE Identifier and it is the
		// Enricher that meets it, while `1;` is two Tokens and the Parser does.
		// Both read one account — see `semicolonAccount` — because a reader who
		// wrote both was being told two different things about them.
		it("answers a ';' in the same words from either stage", () => {
			let afterNumber = program(
				"constant total = 1;",
				"Terminal.print(total)",
			)
			let afterName = program(
				"constant total = 1",
				"constant doubled = total;",
				"Terminal.print(doubled)",
			)

			expect(messagesOf(afterName)).toEqual([
				"A Statement does not end with ';'",
			])
			expect(notesOf(afterName)).toEqual(notesOf(afterNumber))
			expect(helpsOf(afterName)).toEqual(helpsOf(afterNumber))
			expect(labelsOf(afterName)).toEqual(labelsOf(afterNumber))
		})

		// NOTE: The Statement in front of the habit is whole, so it is kept —
		// see `swallowForeignTail`. A file written with a ';' on every line is
		// one report per line and not one per line plus one per reader of what
		// each line declared.
		it("reads past a ';' and keeps the Statement in front of it", () => {
			expect(
				messagesOf(
					program(
						"constant price = 250;",
						"constant tax = 50;",
						"Terminal.print(price::add(tax));",
					),
				),
			).toEqual([
				"A Statement does not end with ';'",
				"A Statement does not end with ';'",
				"A Statement does not end with ';'",
			])
		})

		it("refuses a Comment written with slashes", () => {
			expect(messagesOf(program("§ fine", "// not fine"))).toEqual([
				"A Comment is written with '§'",
			])
			expect(messagesOf(program("/* not fine */"))).toEqual([
				"A Comment is written with '§'",
			])
		})

		it("reads past a Comment written behind a Statement", () => {
			expect(
				messagesOf(
					program(
						"constant price = 250 // the price",
						"Terminal.print(price)",
					),
				),
			).toEqual(["A Comment is written with '§'"])

			expect(
				messagesOf(
					program(
						"constant price = 250 /* the price */",
						"Terminal.print(price)",
					),
				),
			).toEqual(["A Comment is written with '§'"])
		})

		// NOTE: A '*/' that never arrives is refused where the '/*' stands
		// rather than read past: what a reading past it would swallow is the
		// rest of the file.
		it("refuses a block Comment that never closes", () => {
			expect(
				messagesOf(
					program(
						"constant price = 250 /* the price",
						"Terminal.print(price)",
					),
				),
			).toEqual(["A Comment is written with '§'"])
		})

		it("refuses an assignment to a member with the update it stands for", () => {
			let source = program(
				'constant user = { name = "Ada" }',
				'user.name = "Grace"',
			)

			expect(codesOf(source)).toEqual(["foreign-syntax"])
			expect(helpsOf(source)).toEqual([
				"Write '{ user with name = … }', and bind the answer.",
			])
		})

		it("refuses Type Arguments written at a call", () => {
			let source = program(
				"function identity<infer T>(_ value: T) -> T { <- value }",
				"Terminal.print(identity<Integer>(1))",
			)

			expect(codesOf(source)).toEqual(["foreign-syntax"])
			expect(messagesOf(source)).toEqual([
				"A call writes no Type Arguments",
			])
			// NOTE: ONE Help, and it is the edit: take the brackets out. Where
			// the Arguments decide nothing a reader goes to the Declaration
			// instead, and that is said as a Note — the Parser has not seen the
			// signature and can not know which of the two a reader is in.
			expect(helpsOf(source)).toEqual([
				"Write 'identity(…)' and let the Arguments decide.",
			])
			expect(notesOf(source)[1]).toBe(
				"Where the Arguments do not decide one, the Type Parameter wants a place among the Parameters — a call reads it off an Argument or not at all.",
			)
			expect(
				compiles(
					program(
						"function identity<infer T>(_ value: T) -> T { <- value }",
						"Terminal.print(identity(1)::toString())",
					),
				),
			).toBe(true)
		})

		it("refuses a String written in the other quotes", () => {
			expect(messagesOf(program("constant s = 'hi'"))).toEqual([
				"A String is written in double quotes",
			])
			expect(helpsOf(program("constant s = 'hi'"))).toEqual([
				`Write '"hi"'.`,
			])
		})

		// NOTE: A template literal is NOT one Token — a `{` ends a name, so the
		// holes break the run into a name, a `$`, a Record Literal and a quote
		// standing on its own, and each of the four was answered as a name
		// nothing declares. One String, one report.
		it("refuses a template literal once, holes and all", () => {
			let source = program(
				'constant name = "Ada"',
				"constant s = `Hello ${name}`",
				"Terminal.print(s)",
			)

			expect(codesOf(source)).toEqual(["foreign-syntax"])
			expect(messagesOf(source)).toEqual([
				"A String is written in double quotes",
			])
			expect(helpsOf(source)).toEqual([
				`Write the whole String in double quotes, each hole in braces: '"Hello, {name}"'.`,
			])
			expect(notesOf(source)[1]).toBe(
				"A hole carries no '$' — a '$' written in a String is a '$' the String prints.",
			)
		})

		// NOTE: A run that closed on its own quote is ONE edit, so it keeps its
		// fix; a run broken into pieces is a String the reader has to write out,
		// and offering to rewrite the first piece of it would write a String
		// holding a third of what they wrote.
		it("carries a fix only for a run that closed on its own quote", () => {
			expect(
				onlyDiagnostic(program("constant s = `hi`")).data,
			).toMatchObject({
				kind: "essence-spelling",
				spelling: '"hi"',
			})

			expect(
				onlyDiagnostic(
					program(
						'constant name = "Ada"',
						"constant s = `Hello ${name}`",
					),
				).data,
			).toBeUndefined()
		})

		// NOTE: `#Red` and `# Red` are both Essence, so what makes a `#` a
		// Comment is the WORDS behind the Case: a Case carries its payload in
		// brackets, and no Statement of this language stands behind another on
		// one line.
		it("refuses a Comment written with a '#'", () => {
			let source = program(
				"# count the items",
				"constant items = [1, 2, 3]",
				"Terminal.print(items)",
			)

			expect(codesOf(source)).toEqual(["foreign-syntax"])
			expect(messagesOf(source)).toEqual([
				"A Comment is written with '§'",
			])
			expect(helpsOf(source)).toEqual(["Write '§' in place of '#'."])
		})

		it("leaves a Case written with a '#' alone", () => {
			expect(
				codesOf(
					program(
						"choice Colour { red, green }",
						"constant c: Colour = #red",
						"Terminal.print(c::is(#green))",
					),
				),
			).toEqual([])

			expect(
				codesOf(
					program(
						"choice Light { Red, Green }",
						"constant c: Light = # Red",
						"Terminal.print(c::is(#Green))",
					),
				),
			).toEqual([])
		})

		it("refuses the two postfix habits with the Optional", () => {
			expect(
				messagesOf(
					program(
						'constant user = { name = "Ada" }',
						"Terminal.print(user!)",
					),
				),
			).toEqual(["Essence has no '!' after a value"])
			expect(
				messagesOf(
					program(
						'constant user = { name = "Ada" }',
						"Terminal.print(user?.name)",
					),
				),
			).toEqual(["Essence has no '?' after a value"])
		})

		// NOTE: The member is what the reader was reaching FOR, and the Lookup
		// around the name is the only thing that has it — see `enrichLookupBase`.
		// `.member` is what is left where there is no member to name.
		it("names the member a postfix habit was reaching for", () => {
			expect(
				helpsOf(
					program(
						'constant user = { name = "Ada" }',
						"Terminal.print(user?.name)",
					),
				)[0],
			).toBe(
				"Write 'user::map(.name)' to reach through one, and 'user::value(defaultingTo d)' for the value or a fallback.",
			)

			expect(
				helpsOf(
					program(
						'constant user = { name = "Ada" }',
						"Terminal.print(user?)",
					),
				)[0],
			).toBe(
				"Write 'user::map(.member)' to reach through one, and 'user::value(defaultingTo d)' for the value or a fallback.",
			)
		})
	})

	// NOTE: `primes[0]` — the one habit in the family that is a SHAPE rather
	// than a lexeme: every character of it is Essence, and what is foreign is a
	// value standing flush in front of a List. Written apart it is two
	// Statements and compiles, which is why the mistake used to surface a line
	// or two below with a near miss for a Method nobody was reaching for.
	describe("a value indexed with brackets", () => {
		it("refuses the brackets where they were written", () => {
			let source = program(
				"constant primes = [2, 3, 5]",
				"constant first = primes[0]",
				"Terminal.print(first::add(1))",
			)

			expect(codesOf(source)).toEqual(["foreign-syntax"])
			expect(messagesOf(source)).toEqual([
				"A value is not indexed with brackets",
			])
			expect(labelsOf(source)).toEqual([
				"nothing reads a value with brackets",
			])
			expect(refusedSpan(source)).toBe("[0]")
		})

		// NOTE: The whole of the recovery, and the reason the refusal is
		// reported rather than thrown. Dropping the Statement leaves `first`
		// undeclared and answers one mistake at every line that reads the name;
		// keeping `primes` as its value makes `first` a List and answers
		// `first::add(1)` with a near miss for `pad`.
		it("declares the name and says nothing further about it", () => {
			let source = program(
				"constant primes = [2, 3, 5]",
				"constant first = primes[0]",
				"Terminal.print(first::add(1))",
				"Terminal.print(first)",
			)

			expect(codesOf(source)).toEqual(["foreign-syntax"])
		})

		it("names the Method each collection reads an item with", () => {
			expect(
				helpsOf(
					program(
						"constant primes = [2, 3, 5]",
						"constant first = primes[0]",
						"Terminal.print(first)",
					),
				),
			).toEqual([
				"Write 'primes::item(at 0)' for a List, and 'primes::character(at 0)' for a String.",
				"Write 'primes::value(at 0)' for a Dictionary, whose keys are values of its own key Type rather than positions.",
				"A negative position counts back from the end, and 'firstItem()' and 'lastItem()' name the two ends of a List.",
			])
		})

		// NOTE: A String key says the collection is a Dictionary and says it
		// loudly — a List and a String are read by POSITION, and a position is
		// an Integer and nothing else — so the Dictionary's Method leads and
		// the two position Methods are never handed the String.
		it("leads with the Dictionary where a String was written as the key", () => {
			let source = program(
				'constant ages = ["ada" = 36]',
				'constant adasAge = ages["ada"]',
				"Terminal.print(adasAge)",
			)

			expect(codesOf(source)).toEqual(["foreign-syntax"])
			expect(helpsOf(source)).toEqual([
				`Write 'ages::value(at "ada")' for a Dictionary, which is the collection a String keys.`,
				"A List and a String are read by position instead: 'ages::item(at 0)' and 'ages::character(at 0)'.",
			])
			expect(refusedSpan(source)).toBe('["ada"]')
		})

		it("puts the written key back in front of the reader", () => {
			expect(
				helpsOf(
					program(
						"constant items = [1, 2, 3]",
						"constant index = 1",
						"constant one = items[index]",
						"Terminal.print(one)",
					),
				)[0],
			).toBe(
				"Write 'items::item(at index)' for a List, and 'items::character(at index)' for a String.",
			)
		})

		// NOTE: The receiver is spelled back out where the Parser holds its
		// text — a name, or a path of them. `collection` stands in where it does
		// not, and it is not `value` on purpose: one of the three Methods offered
		// is itself called `value`, and `'value::value(at 0)'` reads as a rule
		// about a Keyword rather than as a name to substitute.
		it("names the receiver where its spelling was written down", () => {
			expect(
				helpsOf(
					program(
						"constant box = { items = [1, 2] }",
						"constant first = box.items[0]",
						"Terminal.print(first)",
					),
				)[0],
			).toBe(
				"Write 'box.items::item(at 0)' for a List, and 'box.items::character(at 0)' for a String.",
			)

			expect(
				helpsOf(
					program(
						"function make() -> List<Integer> { <- [1] }",
						"constant first = make()[0]",
						"Terminal.print(first)",
					),
				)[0],
			).toBe(
				"Write 'collection::item(at 0)' for a List, and 'collection::character(at 0)' for a String.",
			)
		})

		// NOTE: Anything but a single written value falls back to the schema.
		// What stood between the brackets is never parsed — `items.length` is a
		// member read and the `-` an operator, and each would be refused in its
		// own right for a reader who has not written the call yet.
		it("answers a written Expression once, and with the schema", () => {
			let source = program(
				"constant items = [1, 2, 3]",
				"constant last = items[items.length - 1]",
				"Terminal.print(last)",
			)

			expect(codesOf(source)).toEqual(["foreign-syntax"])
			expect(helpsOf(source)[0]).toBe(
				"Write 'items::item(at 0)' for a List, and 'items::character(at 0)' for a String.",
			)
		})

		// NOTE: One habit written twice over. The second `[` stands flush
		// against the first's `]`, which is the rule that made the first an
		// index, so the whole run is read past and answered once.
		it("answers a run of brackets once", () => {
			let source = program(
				"constant matrix = [[1, 2], [3, 4]]",
				"constant cell = matrix[0][1]",
				"Terminal.print(cell)",
			)

			expect(codesOf(source)).toEqual(["foreign-syntax"])
			expect(refusedSpan(source)).toBe("[0][1]")
		})

		it("refuses an index written behind a call, a literal and a member read", () => {
			expect(
				codesOf(
					program(
						"function make() -> List<Integer> { <- [1] }",
						"constant got = make()[0]",
						"Terminal.print(got)",
					),
				),
			).toEqual(["foreign-syntax"])

			expect(
				codesOf(
					program(
						'constant letter = "abc"[0]',
						"Terminal.print(letter)",
					),
				),
			).toEqual(["foreign-syntax"])

			expect(
				codesOf(
					program(
						'constant items = [{ name = "Ada" }]',
						"constant who = items[0].name",
						"Terminal.print(who)",
					),
				),
			).toEqual(["foreign-syntax"])
		})

		// NOTE: In Argument position the name in front of the brackets used to
		// read as a LABEL and the brackets as the List it labelled, so the
		// report was `argument-label-mismatch` about a label nobody wrote. The
		// `[` joins `#` and `.` in `argumentIsLabelled`: written flush it
		// carries the name on, and a label is what stands a space in front of
		// its value.
		it("refuses an index written as an Argument", () => {
			let source = program(
				"constant primes = [2, 3, 5]",
				"Terminal.print(primes[0])",
			)

			expect(codesOf(source)).toEqual(["foreign-syntax"])
			expect(refusedSpan(source)).toBe("[0]")
		})

		it("refuses an index inside each container and inside a String's hole", () => {
			expect(
				codesOf(
					program(
						"constant primes = [2, 3, 5]",
						"constant wrapped = [primes[0], 1]",
						"Terminal.print(wrapped)",
					),
				),
			).toEqual(["foreign-syntax"])

			expect(
				codesOf(
					program(
						"constant primes = [2, 3, 5]",
						"constant held = { first = primes[0] }",
						"Terminal.print(held)",
					),
				),
			).toEqual(["foreign-syntax"])

			expect(
				codesOf(
					program(
						"constant primes = [2, 3, 5]",
						'constant keyed = ["a" = primes[0]]',
						"Terminal.print(keyed)",
					),
				),
			).toEqual(["foreign-syntax"])

			expect(
				codesOf(
					program(
						"constant primes = [2, 3, 5]",
						'Terminal.print("first: {primes[0]}")',
					),
				),
			).toEqual(["foreign-syntax"])
		})

		it("refuses an index written as a subject, an arm and a condition", () => {
			expect(
				codesOf(
					program(
						"constant primes = [2, 3, 5]",
						"constant named = match primes[0] -> String {",
						'\tcase 2 { <- "two" }',
						'\tcase _ { <- "other" }',
						"}",
						"Terminal.print(named)",
					),
				),
			).toEqual(["foreign-syntax"])

			expect(
				codesOf(
					program(
						"constant primes = [2, 3, 5]",
						"constant picked = define -> Integer {",
						"\tas primes[0] if true",
						"\tas 0 otherwise",
						"}",
						"Terminal.print(picked)",
					),
				),
			).toEqual(["foreign-syntax"])

			expect(
				codesOf(
					program(
						"constant primes = [2, 3, 5]",
						"if primes[0]::isLessThan(3) {",
						'\tTerminal.print("low")',
						"} else {",
						'\tTerminal.print("high")',
						"}",
					),
				),
			).toEqual(["foreign-syntax"])
		})

		it("refuses an index written as a whole Statement", () => {
			expect(
				codesOf(program("constant primes = [2, 3, 5]", "primes[0]")),
			).toEqual(["foreign-syntax"])
		})

		// NOTE: The brackets with an `=` behind them, which is a WRITE and was
		// answered as two reports — the refusal, and then `Expected an
		// Expression but found '='` from the Statement loop reading what was
		// left — with three Helps between them, every one of them about a
		// Method that READS.
		describe("and written into", () => {
			let source = program(
				"variable primes = [2, 3, 5]",
				"primes[0] = 5",
				"Terminal.print(primes)",
			)

			it("answers the write once, and about writing", () => {
				expect(codesOf(source)).toEqual(["foreign-syntax"])
				expect(messagesOf(source)).toEqual([
					"A value is not written into with brackets",
				])
				expect(labelsOf(source)).toEqual([
					"nothing writes into a value with brackets",
				])
				expect(refusedSpan(source)).toBe("primes[0]")
			})

			it("names the Method each collection is rebuilt with", () => {
				expect(helpsOf(source)).toEqual([
					"Write 'primes = primes::replace(5, at 0)' for a List.",
					"Write 'primes = primes::set(0, to 5)' for a Dictionary, whose keys are values of its own key Type rather than positions.",
				])
				expect(notesOf(source)).toEqual([
					"Nothing changes a collection in place: a Method that changes one answers a NEW collection, which is why 'primes' is written again.",
					"A name written again is a 'variable' — a 'constant' is bound once.",
				])
			})

			it("leads with the Dictionary where a String was written as the key", () => {
				expect(
					helpsOf(
						program(
							'variable ages = ["ada" = 36]',
							'ages["ada"] = 37',
							"Terminal.print(ages)",
						),
					),
				).toEqual([
					`Write 'ages = ages::set("ada", to 37)' for a Dictionary, which is the collection a String keys.`,
					`Or 'ages = [ages with "ada" = 37]', which is the same Dictionary spelled as a Literal.`,
				])
			})

			// NOTE: The value is read off the Token for the reason the key is,
			// and only where it is the whole of what is left of the Statement.
			// Anything longer is the reader's own Expression, and a Help that
			// quoted half of it would print something nobody wrote.
			it("writes a schema where the value is more than one Token", () => {
				expect(
					helpsOf(
						program(
							"variable primes = [2, 3, 5]",
							"primes[0] = 2::add(3)",
							"Terminal.print(primes)",
						),
					)[0],
				).toBe("Write 'primes = primes::replace(…, at 0)' for a List.")
			})

			// NOTE: `==` is two Tokens and another habit entirely, so it is
			// left to the operator table — the brackets are still read, and the
			// comparison is answered on its own.
			it("leaves a comparison to the operator it is written with", () => {
				expect(
					codesOf(
						program(
							"constant primes = [2, 3, 5]",
							"constant same = primes[0] == 5",
							"Terminal.print(same)",
						),
					),
				).toEqual(["foreign-syntax", "operator-not-supported"])
			})

			it("prints Helps that compile", () => {
				expect(
					codesOf(
						program(
							"variable primes = [2, 3, 5]",
							"primes = primes::replace(5, at 0)",
							'variable ages = ["ada" = 36]',
							'ages = ages::set("ada", to 37)',
							'variable years = ["ada" = 36]',
							'years = [years with "ada" = 37]',
							"Terminal.print(primes)",
							"Terminal.print(ages)",
							"Terminal.print(years)",
						),
					),
				).toEqual([])
			})
		})

		// NOTE: A `[` whose `]` never arrives is left where it stands. Reading
		// past it would swallow the rest of the file to answer a habit, and the
		// List Literal that was never closed is what wants reporting there.
		it("leaves a bracket that never closes to the List Literal", () => {
			expect(
				codesOf(
					program(
						"constant primes = [2, 3, 5]",
						"constant first = primes[0",
					),
				),
			).toEqual(["syntax-error"])
		})

		// NOTE: The one shape this rule takes away. `contentsOf[3, 4]` compiled
		// before it and does not after, and that is the rule `#` and `.` have
		// always been read by: a label stands a SPACE in front of its value,
		// and written flush it carries the name on instead. `esfmt` writes the
		// space, and nothing in the standard library, the fixtures, the
		// examples or the documentation was ever written without it.
		//
		// The `unknown-name` for the label read as a receiver is the Enricher's
		// and stands behind this one; `diagnosticsOf` stops at the Parser for a
		// Program the Parser refused, which is what an `essence check` does too.
		it("reads a List written flush behind a label as an index", () => {
			expect(
				codesOf(
					program(
						"constant readings = [1, 2]",
						"constant more = readings::append(contentsOf[3, 4])",
						"Terminal.print(more)",
					),
				),
			).toEqual(["foreign-syntax"])
		})
	})

	// NOTE: The other half of every rule above — the Essence that is written in
	// the same characters, which none of them may touch. Each of these compiled
	// before the family was written and has to compile after it.
	describe("the Essence written in the same characters", () => {
		it("keeps the two arrows", () => {
			expect(
				codesOf(
					program(
						"choice Light { Red, Green }",
						"function name(_ light: Light) -> String {",
						"\t<- match light -> String {",
						'\t\tcase #Red { <- "red" }',
						'\t\tcase #Green { <- "green" }',
						"\t}",
						"}",
						"Terminal.print(name(#Red))",
					),
				),
			).toEqual([])
		})

		it("keeps a Record Literal, an update and a Dictionary", () => {
			expect(
				codesOf(
					program(
						"constant point = { x = 1, y = 2 }",
						"constant moved = { point with x = 9 }",
						'constant ages = ["ann" = 31]',
						'constant older = [ages with "ann" = 32]',
						"Terminal.print(moved.x)",
						'Terminal.print(older::value(at "ann"))',
					),
				),
			).toEqual([])
		})

		it("keeps a Number written with its groups and its fraction", () => {
			expect(
				codesOf(
					program(
						"constant big = 1_000",
						"constant half = 3/4",
						"constant tenth = 0.1",
						"Terminal.print(big::add(1))",
						"Terminal.print(half::add(tenth))",
					),
				),
			).toEqual([])
		})

		it("keeps a define, a Type annotation and a typed Record Literal", () => {
			expect(
				codesOf(
					program(
						"type Point = { x: Integer }",
						"constant origin = Point ~> { x = 0 }",
						"constant n: Integer = define -> Integer {",
						"\tas 1 if origin.x::isZero()",
						"\tas 2 otherwise",
						"}",
						"Terminal.print(n)",
					),
				),
			).toEqual([])
		})

		it("keeps a Pattern's Type annotation and its renames", () => {
			expect(
				codesOf(
					program(
						"constant point = { x = 1, y = 2 }",
						"constant { x: Integer, y as row } = point",
						"Terminal.print(x::add(row))",
					),
				),
			).toEqual([])
		})

		it("keeps a generic declaration and an applied Type", () => {
			expect(
				codesOf(
					program(
						"function first<infer T>(_ items: List<T>, ifEmpty fallback: T) -> T {",
						"\t<- items::firstItem(defaultingTo fallback)",
						"}",
						"constant held: Optional<Integer> = #Value(1)",
						"Terminal.print(first([1, 2], ifEmpty 0))",
						"Terminal.print(held::hasValue())",
					),
				),
			).toEqual([])
		})

		// NOTE: A Function literal is the shape the `=>` refusal stands next to,
		// and it is written in the same characters as one — a Parameter list, an
		// arrow and a block.
		it("keeps a Function literal in every position one is written", () => {
			expect(
				codesOf(
					program(
						"constant double = (_ n: Integer) -> Integer { <- n::multiply(with 2) }",
						"constant items = [1, 2]",
						"Terminal.print(items::map((_ n: Integer) -> Integer { <- double(n) }))",
						"Terminal.print(double(2))",
					),
				),
			).toEqual([])
		})

		// NOTE: A `-` signs a Number Literal, and every one of these is a place
		// where a Number stands and nothing carries an Expression on.
		it("keeps a negative Number wherever one is written", () => {
			expect(
				codesOf(
					program(
						"constant below = -1",
						"constant range = [-1, -2]",
						"constant sign = match below -> String {",
						'\tcase -1 { <- "one below" }',
						'\tcase _ { <- "something else" }',
						"}",
						"constant picked = define -> Integer {",
						"\tas -1 if below::isNegative()",
						"\tas 0 otherwise",
						"}",
						"Terminal.print(sign)",
						"Terminal.print(picked::add(range::length()))",
					),
				),
			).toEqual([])
		})

		// NOTE: A Record Type is written inline wherever a Type is, and each of
		// these is a `{ … : … }` that no Record Literal rule may claim.
		it("keeps an inline Record Type in every position one is written", () => {
			expect(
				codesOf(
					program(
						"choice Shape { Boxed { size: { width: Integer } }, Bare }",
						"function widen(_ box: { width: Integer }) -> { width: Integer } {",
						"\t<- { box with width = box.width::add(1) }",
						"}",
						"constant held: Optional<{ width: Integer }> = #Value({ width = 1 })",
						"constant nested: { outer: { inner: Integer } } = { outer = { inner = 1 } }",
						"constant shape: Shape = #Boxed({ size = { width = 2 } })",
						"Terminal.print(widen({ width = 1 }).width)",
						"Terminal.print(nested.outer.inner)",
						"Terminal.print(held::hasValue())",
						"Terminal.print(shape::is(#Bare))",
					),
				),
			).toEqual([])
		})

		// NOTE: `~>` is written flush against neither side in the standard
		// library and against both here, so the lexeme is read as one either way.
		it("keeps a typed Record Literal written without its spaces", () => {
			expect(
				codesOf(
					program(
						"type Point = { x: Integer }",
						"constant origin = Point~>{ x = 0 }",
						"Terminal.print(origin.x)",
					),
				),
			).toEqual([])
		})

		// NOTE: Every place a `[` is written behind a value in this repository,
		// swept over the standard library, the fixtures, the examples and every
		// Essence sample in the documentation: a labelled Argument and the rows
		// of a table test, each of them written with the space. Nothing there
		// writes one flush, which is what the index rule is narrowed to.
		it("keeps a List written a space behind a label", () => {
			expect(
				codesOf(
					program(
						"constant readings = [1, 2]",
						"constant more = readings::append(contentsOf [3, 4])",
						"constant shared = more::everyItem(alsoIn [1, 2])",
						"Terminal.print(more::contains(everyItemOf [1, 3]))",
						"Terminal.print(shared::length())",
					),
				),
			).toEqual([])
		})

		it("keeps the rows of a table test", () => {
			expect(
				codesOf(
					[
						"implementation {",
						"\tfunction double(_ n: Integer) -> Integer {",
						"\t\t<- n::multiply(with 2)",
						"\t}",
						"}",
						"tests {",
						'\ttest "doubles" across [',
						"\t\t{ n = 1, doubled = 2 },",
						"\t] ({ n, doubled }: { n: Integer, doubled: Integer }) {",
						"\t\texpect double(n)::is(doubled)",
						"\t}",
						"}",
					].join("\n"),
				),
			).toEqual([])
		})

		// NOTE: The three bracket forms that are not a List at all, and a List
		// opening a Statement of its own on the line under a value — which is
		// the reading the index rule leaves untouched, since nothing carries an
		// Expression across a line break.
		it("keeps a Dictionary, its update, the empty one and a List on its own line", () => {
			expect(
				codesOf(
					program(
						'constant ages = ["ada" = 36]',
						'constant older = [ages with "ada" = 37]',
						"constant none: Dictionary<String, Integer> = [=]",
						"constant items = [1, 2]",
						"[3, 4]::map((_ n: Integer) -> Integer { <- n })",
						'Terminal.print(older::value(at "ada"))',
						"Terminal.print(none::isEmpty())",
						"Terminal.print(items::length())",
					),
				),
			).toEqual([])
		})

		// NOTE: Every word in the foreign table is an ordinary name, and a
		// Program that declares one keeps it — the table is consulted for a name
		// that resolved to NOTHING and never for one that resolved.
		it("keeps the foreign words a Program declares as names", () => {
			expect(
				codesOf(
					program(
						"constant const = 1",
						"constant let = 2",
						"constant var = 3",
						"constant new = 4",
						"constant class = 5",
						"constant print = 6",
						"constant Map = 7",
						"constant Set = 8",
						"constant null = 9",
						"constant this = 10",
						"constant typeof = 11",
						"constant await = 12",
						"Terminal.print(const::add(let)::add(var)::add(new))",
						"Terminal.print(class::add(print)::add(Map)::add(Set))",
						"Terminal.print(null::add(this)::add(typeof)::add(await))",
					),
				),
			).toEqual([])
		})
	})
})
