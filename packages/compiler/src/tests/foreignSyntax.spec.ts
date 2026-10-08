import { describe, expect, it } from "bun:test"

import type { common } from "@essence-lang/interfaces"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { operatorNote } from "../helpers/foreign"
import { parseWithDiagnostics } from "../parser/index"
import { analysedDiagnosticsFor, compiles } from "./followedHelps"

// What a reader arriving from another language writes, and what the Compiler
// says about it. `a && b` is refused by the Parser and `!a` by the Enricher,
// but both owe the reader the same kind of answer.

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

// The characters a single-line Position covers, so a test can say a fix
// rewrites the `.` without counting columns.
function spanOf(source: string, position: common.Position): string {
	return source
		.split("\n")
		[position.start.line - 1].slice(
			position.start.column - 1,
			position.end.column - 1,
		)
}

// The text the Program's one Diagnostic underlines. Every refusal asked here
// has a Position.
function refusedSpan(source: string): string {
	return spanOf(source, onlyDiagnostic(source).position as common.Position)
}

// One line per Statement, indented with a real tab, as a reader would write.
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

		// `add` takes an Argument, so the Help writes an ellipsis and the
		// payload carries no call.
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

		// A Record has members, so only a name that is none of them is looked
		// up in the Namespace written over it.
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

		// No Method of the name or near it exists, so no Help spells one. The
		// Note says where the name was looked for, as `unknown-method` does.
		it("keeps type-without-members where no Method of the name exists", () => {
			let source = program(
				'constant s: String = "ada"',
				"Terminal.print(s.charAt(0))",
			)

			expect(codesOf(source)).toEqual(["type-without-members"])
			expect(helpsOf(source)).toEqual([])
			expect(notesOf(source)).toEqual([
				"Only Records, Cases and Namespaces have members.",
				"Searched Namespace 'String'.",
			])
			expect(onlyDiagnostic(source).data).toBeUndefined()
		})

		// A Method one edit from the name is spelled as a call, the way
		// `method-called-with-dot` spells the name itself.
		it("names a Method close to the name, called or read", () => {
			let written = (expression: string) =>
				program(
					'constant s: String = "ada"',
					`Terminal.print(${expression}::toString())`,
				)

			expect(helpsOf(written("s.lenght"))).toEqual([
				"Write '::length()' in place of '.lenght' — a Method is called, never read.",
			])
			expect(helpsOf(written("s.lenght()"))).toEqual([
				"Write '::length' in place of '.lenght'.",
			])
			expect(compiles(written("s::length()"))).toBe(true)
		})

		// A call keeps its Arguments, so a near Method that takes none of them
		// would trade this report for a refused call.
		it("offers no Method a call's Arguments do not fit", () => {
			let source = program(
				'constant s: String = "ada"',
				"Terminal.print(s.lenght(1))",
			)

			expect(helpsOf(source)).toEqual([])
			expect(notesOf(source)).toEqual([
				"Only Records, Cases and Namespaces have members.",
				"Searched Namespace 'String'.",
			])
		})

		// One mistake, one report: the refused body must not also report
		// `uninferable-return-type` or `uninferable-type-parameter`.
		it("reports a Method reached with '.' inside a literal once", () => {
			let source = program(
				'constant words = ["a", "bb"]',
				"Terminal.inspect(words::map((w) { <- w.length }))",
			)

			expect(codesOf(source)).toEqual(["method-called-with-dot"])
			expect(
				compiles(
					program(
						'constant words = ["a", "bb"]',
						"Terminal.inspect(words::map((w) { <- w::length() }))",
					),
				),
			).toBe(true)
		})

		// Only `@` in an arm is narrowed, so a member that one Union member
		// declares is read there rather than called as a Method.
		it("matches a Union first where a member of it declares the name", () => {
			let read = (expression: string) =>
				program(
					"type A = { x: Integer }",
					"type B = { y: Integer }",
					"constant v: A | B = { y = 1 }",
					`Terminal.inspect(${expression})`,
				)

			expect(codesOf(read("v.x"))).toEqual(["type-without-members"])
			expect(helpsOf(read("v.x"))).toEqual([
				"Read '@.x' in a Match arm that narrows the value — 'case A { … }'.",
			])
			expect(
				compiles(
					read(
						"match v -> Integer {\n\tcase A { <- @.x }\n\tcase B { <- 0 }\n}",
					),
				),
			).toBe(true)
		})

		// A read is answered as a call is, and nothing near `charAt` answers.
		it("offers no Method for a read where none is close", () => {
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
		// A dropped declaration would leave the name undeclared and report every
		// line that reads it.
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
			// Both Helps, since a binding nothing reassigns is a `constant`.
			expect(helpsOf(source)).toEqual([
				"Write 'variable' in place of 'let'.",
				"Or 'constant', where the value is never reassigned.",
				"Write 'variable' in place of 'var'.",
				"Or 'constant', where the value is never reassigned.",
			])
		})

		// `let mut` is one habit: reported over its span, fixed by one edit,
		// and read on as the Variable it declares.
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

		// The test is the shape alone, two Identifiers and a brace, so a
		// declared name is kept.
		it("leaves a value named 'class' alone", () => {
			expect(
				codesOf(program("constant class = 1", "Terminal.print(class)")),
			).toEqual([])
		})

		// The shapes a block is opened in. See `foreignBlockBraceOffset`.
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

		// A block whose `}` never arrives is not read past, so no later reading
		// loses its Tokens. It is answered once, at the word.
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

		// Each word is an ordinary name here, answered where an `unknown-name`
		// would have been.
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

		// `println!` is keyed with its `!`, as the reader wrote it, so the
		// table answers before any rule reads the `!` alone.
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

		// The shapes where the guess is withheld. See `reportBareCaseName`.
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

		// In the shorthand `{ Red }` the name is the member and its value, and
		// `{ #Red }` is no Record Literal, so the member is spelled out.
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

		// Every operator between two Literals and between two names, in a
		// declaration and inside a call. Inside a call, a name before an operator
		// must not read as an Argument's label.
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

		// A name in front of a value is still a label. A `-` can open a negative
		// Number, so a label may stand in front of it.
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

		// A `(` in Expression position opens a Function literal's Parameter
		// list, since there are no grouping parentheses. The operator inside is
		// still what is reported.
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

		// `!ready` is one Identifier, since a `!` ends no name, so the Enricher
		// meets it with the operand in hand. Its Help replaces the table's
		// placeholder sentence.
		it("names the operand of a prefix '!'", () => {
			let source = program(
				"constant ready = true",
				"constant flipped = !ready",
			)

			expect(codesOf(source)).toEqual(["operator-not-supported"])
			expect(helpsOf(source)).toEqual(["Write 'ready::negate()'."])
		})

		// `- tree::hasItems()` negates the call, so naming `tree` would suggest
		// the wrong edit.
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

		// The Help spells the binding and the amount the reader wrote.
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

		// `hits++` is one Identifier, so the Enricher meets it with the binding
		// in hand. The amount is in the operator.
		it("spells the binding a postfix increment counts", () => {
			let source = program("variable hits = 0", "hits++")

			expect(codesOf(source)).toEqual(["operator-not-supported"])
			expect(helpsOf(source)).toEqual(["Write 'hits = hits::add(1)'."])
			expect(
				compiles(program("variable hits = 0", "hits = hits::add(1)")),
			).toBe(true)
		})

		// `box.hits++` is a Lookup whose member is `hits++`, since a `+` ends no
		// name. A Record's member can not be assigned, so the edit rebuilds it.
		it("spells the member a postfix increment counts", () => {
			let source = program("variable box = { hits = 0 }", "box.hits++")

			expect(codesOf(source)).toEqual(["operator-not-supported"])
			expect(helpsOf(source)).toEqual([
				"Write 'box = { box with hits = box.hits::add(1) }' — a Record's member is not assigned, it is built anew.",
			])
			expect(
				compiles(
					program(
						"variable box = { hits = 0 }",
						"box = { box with hits = box.hits::add(1) }",
						"Terminal.inspect(box.hits::toString())",
					),
				),
			).toBe(true)
		})

		// The habit needs the name without its `++` to be a member.
		it("leaves a member nothing declares to the member report", () => {
			let source = program(
				"constant box = { hits = 0 }",
				"Terminal.inspect(box.total++::toString())",
			)

			expect(codesOf(source)).toEqual(["unknown-member"])
		})

		// The right operand is spelled only where it is one Token ending the
		// Statement. A longer Expression is the reader's, so `…` stands for it.
		it("writes '…' where the amount is an Expression of its own", () => {
			let source = program(
				"variable tally = 0",
				"constant other = 2",
				"tally += other::add(1)",
			)

			expect(codesOf(source)).toEqual(["operator-not-supported"])
			expect(helpsOf(source)).toEqual(["Write 'tally = tally::add(…)'."])
		})

		// A reassignment must answer an Integer, and `divide(by:)` answers a
		// fraction, so `quotient` leads.
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

		// No Method stands in for a bitwise operator, so the rule is a Note
		// rather than a Help.
		it("answers a bitwise operator with a Note and no Help", () => {
			let source = program("constant masked = 6 & 3")

			expect(codesOf(source)).toEqual(["operator-not-supported"])
			expect(helpsOf(source)).toEqual([])
			expect(notesOf(source)).toEqual([
				operatorNote,
				"Essence has no bitwise operations, and no Method stands in for one.",
			])
		})

		// The Help is built from the operands written. The table's placeholder
		// sentence is only for an operand too long to print back.
		it("refuses the nullish operator with the Optional's own Method", () => {
			let source = program(
				"constant held: Optional<Integer> = #Value(1)",
				"constant fallback = 0",
				"constant total = held ?? fallback",
			)

			expect(codesOf(source)).toEqual(["operator-not-supported"])
			expect(helpsOf(source)).toEqual([
				"Write 'held::value(defaultingTo fallback)' — a value that may be missing is an Optional.",
			])
			expect(
				compiles(
					program(
						"constant held: Optional<Integer> = #Value(1)",
						"constant fallback = 0",
						"constant total = held::value(defaultingTo fallback)",
						"Terminal.inspect(total::toString())",
					),
				),
			).toBe(true)
		})

		// A Statement ends with its Expression, so a `-` opening the next line
		// is a negative Number.
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

		// `total;` is one Identifier, which the Enricher meets, and `1;` is two
		// Tokens, which the Parser meets. Both read `semicolonAccount`.
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

		// The Statement in front of the `;` is whole, so it is kept, and each
		// line reports once. See `swallowForeignTail`.
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

		// A '/*' whose '*/' never arrives is refused where it stands rather than
		// swallowing the rest of the file.
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
			// The Help is the edit. The Parser has not seen the signature, so the
			// case where the Arguments decide nothing is a Note.
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

		// A `{` ends a name, so a template literal's holes break it into several
		// Tokens. It is still one String and one report.
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

		// A run that closed on its own quote is one edit and keeps its fix. A run
		// broken by holes is left for the reader to write out.
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

		// `#Red` and `# Red` are both Essence. Words standing behind the name
		// make a Comment, since a Case carries its payload in brackets.
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

		// Only the Lookup around the name knows the member the reader was
		// reaching for. See `enrichLookupBase`.
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
		})

		// With no member reached for, the `map` clause is withheld.
		it("offers only the fallback where nothing was being reached for", () => {
			expect(
				helpsOf(
					program(
						'constant user = { name = "Ada" }',
						"Terminal.print(user?)",
					),
				)[0],
			).toBe(
				"Write 'user::value(defaultingTo d)' for the value or a fallback.",
			)
		})
	})

	// `primes[0]` is a habit of shape rather than lexeme: a value flush in
	// front of a List. Written apart, it is two Statements and compiles.
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

		// Dropping the Statement would report every read of `first`, and keeping
		// `primes` as its value would make `first` a List.
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

		// A List and a String are read by an Integer position, so a String key
		// means a Dictionary, whose Method leads.
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

		// The receiver is spelled back where it is a name or a path of them.
		// Otherwise `collection` stands in, since `value::value(at 0)` would read
		// oddly.
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

		// Anything but a single written value falls back to the schema, and
		// what stood between the brackets is never parsed.
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

		// The second `[` stands flush against the first `]`, so the whole run
		// is one index and one report.
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

		// In `argumentIsLabelled`, a `[` written flush carries the name on, as
		// `#` and `.` do. A label stands a space in front of its value.
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

		// Brackets with an `=` behind them are a write, answered once with
		// Methods that rebuild the collection.
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

			// The value is spelled only where it is one Token ending the
			// Statement.
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

			// `==` is another habit, left to the operator table.
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

		// A `[` whose `]` never arrives is left as an unclosed List Literal
		// rather than swallowing the rest of the file.
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

		// A label stands a space in front of its value, so `contentsOf[3, 4]`
		// is an index. The formatter writes the space. A refused Program stops at
		// the Parser, so the Enricher's `unknown-name` is not reached.
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

	// Essence written in the same characters, which no foreign-syntax rule
	// may touch.
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

		// A Function literal is a Parameter list, an arrow and a block, the
		// characters the `=>` refusal stands next to.
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

		// A `-` signs a Number Literal wherever a Number stands.
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

		// An inline Record Type is a `{ … : … }` no Record Literal rule may claim.
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

		// `~>` is one lexeme whether written flush or spaced.
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

		// Where a `[` follows a value in Essence written here, a labelled
		// Argument or a table test's rows, a space stands between them.
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

		// Bracket forms that are no List, and a List opening a Statement on the
		// line under a value. No Expression carries across a line break.
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

		// The foreign table is consulted only for a name that resolved to
		// nothing.
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

	// `double(self)`: Python's and Rust's receiver Parameter. Essence's
	// receiver is `@`, so the word is dropped and the Method reads on.
	describe("a receiver written as a Parameter", () => {
		let doubling = (head: string) =>
			program(
				"namespace Doubling for Integer {",
				`\t${head} -> Integer {`,
				"\t\t<- @::add(@)",
				"\t}",
				"}",
				"Terminal.print(3::double())",
			)

		it("names the receiver '@' and drops the word", () => {
			let source = doubling("double(self)")
			let refusal = onlyDiagnostic(source)

			expect(refusal.code).toBe("foreign-syntax")
			expect(refusal.message).toBe("A Method takes no 'self' Parameter")
			expect(refusal.helps).toEqual([
				"Remove 'self' from the Parameters, and read the receiver as '@' in the body.",
			])
			expect(refusedSpan(source)).toBe("self")
			expect(compiles(doubling("double()"))).toBe(true)
		})

		it("removes the comma after the word with it", () => {
			let source = program(
				"namespace Scaling for Integer {",
				"\tscaled(this, by factor: Integer) -> Integer {",
				"\t\t<- @::multiply(with factor)",
				"\t}",
				"}",
				"Terminal.print(3::scaled(by 2))",
			)
			let { data } = onlyDiagnostic(source)

			if (data?.kind !== "essence-spelling") {
				throw new Error(
					"Diagnostic carries no essence-spelling payload.",
				)
			}

			expect(data.spelling).toBe("")
			expect(spanOf(source, data.position)).toBe("this, ")
			expect(
				compiles(source.replace("scaled(this, by", "scaled(by")),
			).toBe(true)
		})

		// Only an instance Method has a receiver. In a Function or a static
		// Method the word names nothing, and `@` is refused there too.
		it("names no receiver in a Function or a static Method", () => {
			let heads = (functionHead: string, staticHead: string) =>
				program(
					`function ${functionHead} -> Integer {`,
					"\t<- 2",
					"}",
					"namespace Origins for Integer {",
					`\tstatic ${staticHead} -> Integer {`,
					"\t\t<- 0",
					"\t}",
					"}",
					"Terminal.print(double())",
					"Terminal.print(Origins.origin())",
				)
			let source = heads("double<infer Item>(self)", "origin(self)")

			expect(messagesOf(source)).toEqual([
				"A Function has no receiver for 'self' to name",
				"A static Method has no receiver for 'self' to name",
			])
			expect(helpsOf(source)).toEqual([
				"Remove 'self', or give it a Type, as 'self: …', where it is a Parameter of its own.",
				"Remove 'self', or give it a Type, as 'self: …', where it is a Parameter of its own.",
			])
			expect(compiles(heads("double()", "origin()"))).toBe(true)
		})

		// A Function literal's Parameter may be named `self` and take its
		// Type from the expected signature.
		it("leaves a Parameter named 'self' alone", () => {
			expect(
				codesOf(
					program(
						"function twice(_ self: Integer) -> Integer {",
						"\t<- self::multiply(with 2)",
						"}",
						"Terminal.print([1, 2]::map((self) { <- twice(self) }))",
					),
				),
			).toEqual([])
		})
	})

	// A `(` that wraps a value is refused once and read past, so the Statement
	// keeps its value. See "Grouping parentheses" in
	// packages/compiler/src/parser/DEVELOPMENT.md.
	describe("parentheses that group one value", () => {
		let declarations = [
			"choice Holder {",
			"\tBare,",
			"\tFull { value: Integer },",
			"}",
			"choice Box<T> {",
			"\tEmpty,",
			"\tFull { value: T },",
			"}",
			"constant point = { x = 1 }",
			"constant count = 2",
		]

		// The Help's edit, made with the spans its data names.
		function withoutParentheses(
			source: string,
			diagnostic: common.Diagnostic,
		): string {
			let data = diagnostic.data

			if (data?.kind !== "grouping-parentheses") {
				throw new Error("Expected the spans of both parentheses")
			}

			let lines = source.split("\n")

			for (let { start } of [data.close, data.open]) {
				let line = lines[start.line - 1]!

				lines[start.line - 1] =
					line.slice(0, start.column - 1) + line.slice(start.column)
			}

			return lines.join("\n")
		}

		it.each([
			["constant one = (1)", "constant one = 1"],
			[
				"constant held: Optional<Integer> = (#Empty)",
				"constant held: Optional<Integer> = #Empty",
			],
			["constant bare = (Holder#Bare)", "constant bare = Holder#Bare"],
			[
				"constant full = (Box<Integer>#Full(1))",
				"constant full = Box<Integer>#Full(1)",
			],
			['constant word = ("x")', 'constant word = "x"'],
			["constant read = (point.x)", "constant read = point.x"],
			["constant sum = (count::add(2))", "constant sum = count::add(2)"],
			["constant items = [(1), 2]", "constant items = [1, 2]"],
			[
				"Terminal.print((1::add(2))::multiply(with 3))",
				"Terminal.print(1::add(2)::multiply(with 3))",
			],
			[
				"Terminal.inspect(Holder#Full((3)))",
				"Terminal.inspect(Holder#Full(3))",
			],
		])("refuses %s once and removes both parentheses", (written, fixed) => {
			let source = program(...declarations, written)
			let diagnostics = analysedDiagnosticsFor(source)

			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.code,
					diagnostic.message,
					diagnostic.helps,
				]),
			).toEqual([
				[
					"foreign-syntax",
					"Essence has no grouping parentheses",
					["Remove the parentheses."],
				],
			])

			let followed = withoutParentheses(source, diagnostics[0]!)

			expect(followed).toBe(program(...declarations, fixed))
			expect(compiles(followed)).toBe(true)
		})

		// A pair inside a pair is a second pair, and each Help removes its own.
		it("reports each pair of a nested group", () => {
			expect(codesOf(program("constant one = ((1))"))).toEqual([
				"foreign-syntax",
				"foreign-syntax",
			])
		})

		it("still reads a Function literal", () => {
			expect(
				analysedDiagnosticsFor(
					program(
						"constant one = (_: Integer) -> Integer { <- 1 }",
						"constant labelled = (on value: Integer) -> Integer { <- value }",
						"constant doubled = [1, 2]::map((n) { <- n::multiply(with 2) })",
						"constant odd = [1, 2]::removeEvery(where (n) { <- n::isEven() })",
						"Terminal.inspect([one(1), labelled(on 2)])",
						"Terminal.inspect([doubled, odd])",
					),
				),
			).toEqual([])
		})

		// Another language's arrow goes on past the `)`, and its own refusal
		// is the one report.
		it.each([
			[
				"constant doubled = [1, 2]::map((n) => n)",
				[["foreign-syntax", "A Function literal has no '=>'"]],
			],
			[
				"constant f = (x): Integer => x",
				[["syntax-error", "Expected '{' but found ':'."]],
			],
		])("keeps the arrow's refusal for %s", (written, expected) => {
			expect(
				diagnosticsOf(program(written)).map((diagnostic) => [
					diagnostic.code,
					diagnostic.message,
				]),
			).toEqual(expected)
		})

		// The `)` stands before the `if`'s `{`, so the Function literal's
		// reading and its refusal are kept.
		it.each([
			["if (count::isEven()) {", "Expected a Type but found ':'."],
			["if (ready) {", "Expected '{' but found '}'."],
			["if (count > 3) {", "Expected ')' but found '>'."],
		])("keeps the refusal of %s", (written, message) => {
			let source = program(
				"constant count = 4",
				"constant ready = true",
				written,
				'\tTerminal.print("yes")',
				"}",
			)

			expect(
				diagnosticsOf(source).map((diagnostic) => [
					diagnostic.code,
					diagnostic.message,
				]),
			).toEqual([["syntax-error", message]])
		})
	})
})
