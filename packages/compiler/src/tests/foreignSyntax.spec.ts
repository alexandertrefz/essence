import { describe, expect, it } from "bun:test"

import type { common } from "@essence-lang/interfaces"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
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
			expect(helpsOf(source)).toEqual([
				"Write 'variable' in place of 'let'.",
				"Write 'variable' in place of 'var'.",
			])
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
			// NOTE: The second Help is where a reader whose Arguments decide
			// nothing goes next, and it may not send them to the annotation:
			// the annotation does not bind a Type Parameter either, so that
			// Help led back here through `uninferable-type-parameter`.
			expect(helpsOf(source)[1]).toBe(
				"Where the Arguments do not decide, give the Type Parameter a place among the Parameters.",
			)
		})

		it("refuses a String written in the other quotes", () => {
			expect(messagesOf(program("constant s = 'hi'"))).toEqual([
				"A String is written in double quotes",
			])
			expect(helpsOf(program("constant s = 'hi'"))).toEqual([
				`Write '"hi"'.`,
			])
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
