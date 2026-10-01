import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { common, parser } from "@essence-lang/interfaces"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { printType } from "../printType"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// Asynchrony end to end: the two Keywords, the two Types, the rule that makes
// a body a completing one, and what it emits. A future is a description, so
// whether it ran shows only when the Program runs.
//
// `Async.deferred` builds a future out of a Function, the base case most
// Programs here rest on.

function parse(source: string): parser.Program {
	let parsed = parseWithDiagnostics(source)

	expect(parsed.diagnostics).toEqual([])

	return parsed.program
}

function generate(source: string): string {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return rewrite(optimise(simplify(enriched.program)))
}

// A Program that completes anything at its top level emits a top-level
// `await`, which only `await import` can load.
async function run(source: string): Promise<Array<string>> {
	let javaScript = generate(source)
	let directory = mkdtempSync(join(tmpdir(), "essence-asynchrony-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, javaScript)

	let output: Array<string> = []
	let originalLog = console.log

	console.log = (...args: Array<unknown>) => {
		output.push(args.map((argument) => String(argument)).join(" "))
	}

	try {
		await import(file)
	} finally {
		console.log = originalLog
		rmSync(directory, { recursive: true, force: true })
	}

	return output
}

function diagnosticsOf(source: string): Array<common.Diagnostic> {
	let parsed = parseWithDiagnostics(source)

	if (containsErrors(parsed.diagnostics)) {
		return parsed.diagnostics
	}

	let enriched = enrich(parsed.program)

	if (containsErrors(enriched.diagnostics)) {
		return [...parsed.diagnostics, ...enriched.diagnostics]
	}

	return [
		...parsed.diagnostics,
		...enriched.diagnostics,
		...validate(enriched.program),
	]
}

function codesOf(source: string): Array<string> {
	return diagnosticsOf(source).map((diagnostic) => diagnostic.code)
}

// The Type the last top-level Constant was inferred at, spelled the way a
// Hover spells it.
function lastConstantType(source: string): string {
	let enriched = enrich(parseWithDiagnostics(source).program)
	let nodes = enriched.program.implementation.nodes
	let last = nodes[nodes.length - 1]

	if (last?.nodeType !== "ConstantDeclarationStatement") {
		throw new Error("The last Statement is not a Constant Declaration")
	}

	return printType(last.type)
}

const deferredThree = `	function three() -> Future<Integer> {
		<- complete Async.deferred(() { <- 3 })
	}`

describe("Asynchrony", () => {
	describe("the Parser", () => {
		it("reads both Keywords as prefix Expressions", () => {
			let program = parse(`implementation {
	constant work = Async.deferred(() { <- 1 })
	constant running = start work
	constant answer = complete running
}`)
			let nodes = program.implementation.nodes

			expect(
				nodes.map((node) =>
					node.nodeType === "ConstantDeclarationStatement"
						? node.value.nodeType
						: node.nodeType,
				),
			).toEqual(["FunctionInvocation", "Start", "Complete"])
		})

		// The whole postfix chain belongs to the Keyword, so a future built by
		// a call is completed with nothing written around it.
		it("takes the whole postfix chain as the operand", () => {
			let program = parse(`implementation {
	constant answer = complete Async.deferred(() { <- 1 })::map((n) { <- n })
}`)
			let node = program.implementation.nodes[0]

			if (node?.nodeType !== "ConstantDeclarationStatement") {
				throw new Error("expected a Constant Declaration")
			}

			expect(node.value.nodeType).toBe("Complete")

			if (node.value.nodeType === "Complete") {
				expect(node.value.expression.nodeType).toBe("MethodInvocation")
			}
		})

		it("reads one Keyword through the other", () => {
			let program = parse(`implementation {
	constant answer = complete start Async.deferred(() { <- 1 })
}`)
			let node = program.implementation.nodes[0]

			if (node?.nodeType !== "ConstantDeclarationStatement") {
				throw new Error("expected a Constant Declaration")
			}

			expect(node.value.nodeType).toBe("Complete")

			if (node.value.nodeType === "Complete") {
				expect(node.value.expression.nodeType).toBe("Start")
			}
		})

		// Both words are contextual: the Keyword only in front of an
		// Expression, a name everywhere else. See "Asynchrony keywords" in
		// packages/compiler/src/parser/DEVELOPMENT.md.
		it("reads either word as a name a Declaration binds", () => {
			expect(
				codesOf(`implementation {
	constant start = 1
	variable complete = start::add(1)

	complete = complete::add(start)

	Terminal.print(complete::toString())
}`),
			).toEqual([])
		})

		it("reads either word as a Record member", () => {
			expect(
				codesOf(`implementation {
	constant span = { start = 1, complete = 2 }
	constant { start, complete } = span

	Terminal.print(span.start::add(complete)::toString())
}`),
			).toEqual([])
		})

		it("reads either word as a Function and as a Method", () => {
			expect(
				codesOf(`implementation {
	namespace Game for Integer {
		start() -> Integer {
			<- @
		}
	}

	function complete(of game: Integer) -> Integer {
		<- game::start()
	}

	Terminal.print(complete(of 2)::toString())
}`),
			).toEqual([])
		})

		it("reads either word as a Parameter's name behind a label", () => {
			expect(
				codesOf(`implementation {
	function span(from start: Integer, to complete: Integer) -> Integer {
		<- complete::subtract(start)
	}

	Terminal.print(span(from 1, to 4)::toString())
}`),
			).toEqual([])
		})

		// An Argument's label stands where the prefix form opens, so the
		// Keyword wins there. `Terminal.print(complete headline(url))` waits.
		it("reads an Argument that opens with either word as the Keyword", () => {
			let program = parse(`implementation {
	constant answer = compute(start 1)
}`)
			let node = program.implementation.nodes[0]

			if (node?.nodeType !== "ConstantDeclarationStatement") {
				throw new Error("expected a Constant Declaration")
			}

			if (node.value.nodeType !== "FunctionInvocation") {
				throw new Error("expected a Function Invocation")
			}

			expect(node.value.arguments.length).toBe(1)
			expect(node.value.arguments[0]!.name).toBeNull()
			expect(node.value.arguments[0]!.value.nodeType).toBe("Start")
		})

		// No call could write such a label, since `compute(start 1)` is a
		// `start` of `1`. So the signature refuses it once.
		it("refuses either word as a Parameter's label", () => {
			expect(
				codesOf(`implementation {
	function compute(start value: Integer) -> Integer {
		<- value
	}

	Terminal.print(compute(1)::toString())
}`),
			).toEqual(["reserved-parameter-label"])
			expect(
				codesOf(`implementation {
	function compute(complete value: Integer) -> Integer {
		<- value
	}

	Terminal.print(compute(1)::toString())
}`),
			).toEqual(["reserved-parameter-label"])
		})

		// A Parameter named with either word behind a label of its own is
		// fine, since the caller writes only the label.
		it("reads either word as a Parameter's name behind '_'", () => {
			expect(
				codesOf(`implementation {
	function doubled(_ start: Integer) -> Integer {
		<- start::multiply(with 2)
	}

	Terminal.print(doubled(21)::toString())
}`),
			).toEqual([])
		})

		// Where the word does not open the Keyword form in Argument position,
		// it is a name and what follows is read off it.
		it("reads a member path behind either word as a read off a name", () => {
			let program = parse(`implementation {
	constant answer = compute(start .price)
}`)
			let node = program.implementation.nodes[0]

			if (node?.nodeType !== "ConstantDeclarationStatement") {
				throw new Error("expected a Constant Declaration")
			}

			if (node.value.nodeType !== "FunctionInvocation") {
				throw new Error("expected a Function Invocation")
			}

			expect(node.value.arguments[0]!.name).toBeNull()
			expect(node.value.arguments[0]!.value.nodeType).toBe("Lookup")
		})

		// The operand of a `start` begins on the `start`'s own line, or the
		// word is a name. So a Statement ending on the word and the next one
		// stay two.
		it("leaves the Statement below alone where a name ends a line", () => {
			let program = parse(`implementation {
	constant start = 1
	constant held = start
	Terminal.print(held::toString())
}`)
			let nodes = program.implementation.nodes
			let held = nodes[1]

			expect(nodes.length).toBe(3)

			if (held?.nodeType !== "ConstantDeclarationStatement") {
				throw new Error("expected a Constant Declaration")
			}

			expect(held.value.nodeType).toBe("Identifier")
		})

		// An operand written over several lines still begins on the Keyword's
		// own line.
		it("reads an operand whose Arguments are broken over lines", () => {
			let program = parse(`implementation {
	constant answered = complete send(
		1,
		2,
	)
}`)
			let answered = program.implementation.nodes[0]

			if (answered?.nodeType !== "ConstantDeclarationStatement") {
				throw new Error("expected a Constant Declaration")
			}

			expect(answered.value.nodeType).toBe("Complete")
		})

		// Some Tokens begin an Expression yet only stand where one has ended,
		// so a value named `start` or `complete` may stand before them.
		it("leaves either word a name where the Token behind it ends an Expression", () => {
			expect(
				codesOf(`implementation {
	type Point = { x: Integer, y: Integer }

	constant start = true
	constant complete: Point = { x = 1, y = 2 }
	constant flag = false

	if start {
		Terminal.print("yes")
	} else {
		Terminal.print("no")
	}

	constant chosen = define {
		as 2 if flag
		as complete.x otherwise
	}

	constant corner = define {
		as { x = 0, y = 0 } if flag
		as complete otherwise
	}

	constant moved = { complete with x = 3 }

	constant named = match complete.y -> String {
		case 2 {
			<- "two"
		}
		case _ {
			<- "other"
		}
	}

	function label(_ start: Integer) -> String {
		<- match start -> String {
			case 2 {
				<- "two"
			}
			case _ {
				<- "other"
			}
		}
	}

	Terminal.print(chosen::add(moved.x)::add(corner.y)::toString())
	Terminal.print(named)
	Terminal.print(label(2))
}`),
			).toEqual([])
		})

		// With nothing after it the word is a name, so the Enricher reports
		// the undeclared name.
		it("reads a word with nothing behind it as a name", () => {
			expect(
				codesOf(`implementation {
	constant nothing = complete
}`),
			).toEqual(["unknown-name"])
		})
	})

	describe("the Types", () => {
		it("answers a Started for a started Future", () => {
			expect(
				lastConstantType(`implementation {
	constant running = start Async.deferred(() { <- 1 })
}`),
			).toBe("Started<Integer>")
		})

		it("answers the value for a completed Future or Started", () => {
			expect(
				lastConstantType(`implementation {
	constant answer = complete Async.deferred(() { <- "hi" })
}`),
			).toBe("String")
			expect(
				lastConstantType(`implementation {
	constant running = start Async.deferred(() { <- "hi" })
	constant answer = complete running
}`),
			).toBe("String")
		})

		// The runtime reads a Union of work member by member, and so does the
		// Type. A Future is run, a Started is waited for, and anything else is
		// its own answer.
		it("answers a Union of work member by member", () => {
			expect(
				lastConstantType(`implementation {
	function work(_ n: Integer) -> Future<Integer> {
		<- Async.deferred(() { <- n })
	}

	function text(_ s: String) -> Future<String> {
		<- Async.deferred(() { <- s })
	}

	function either(_ flag: Boolean) -> Future<Integer> | Future<String> {
		<- define {
			as work(1) if flag
			as text("a") otherwise
		}
	}

	constant answered = complete either(true)
}`),
			).toBe("Integer | String")
			expect(
				lastConstantType(`implementation {
	function work(_ n: Integer) -> Future<Integer> {
		<- Async.deferred(() { <- n })
	}

	function either(_ flag: Boolean) -> Future<Integer> | String {
		<- define {
			as work(1) if flag
			as "plain" otherwise
		}
	}

	constant answered = complete either(true)
}`),
			).toBe("Integer | String")
			expect(
				lastConstantType(`implementation {
	function work(_ n: Integer) -> Future<Integer> {
		<- Async.deferred(() { <- n })
	}

	function either(_ flag: Boolean) -> Future<Integer> | String {
		<- define {
			as work(1) if flag
			as "plain" otherwise
		}
	}

	constant running = start either(true)
}`),
			).toBe("Started<Integer> | String")
		})

		// A Union with no work in it gets the same Warning a single value does.
		it("still refuses a Union holding no work at all", () => {
			expect(
				codesOf(`implementation {
	function either(_ flag: Boolean) -> Integer | String {
		<- define {
			as 1 if flag
			as "plain" otherwise
		}
	}

	constant answered = complete either(true)
	constant running = start either(true)

	Terminal.inspect(answered)
	Terminal.inspect(running)
}`),
			).toEqual(["needless-complete", "needless-start"])
		})

		// A Statement dropping a Union of work gets the Diagnostics a single
		// Future gets.
		it("names a Union of work dropped in a Statement", () => {
			expect(
				codesOf(`implementation {
	function work(_ n: Integer) -> Future<Integer> {
		<- Async.deferred(() { <- n })
	}

	function either(_ flag: Boolean) -> Future<Integer> | String {
		<- define {
			as work(1) if flag
			as "plain" otherwise
		}
	}

	either(true)
	start either(true)
}`),
			).toEqual(["unused-future", "unobserved-started"])
		})

		// A completing body answers the value, and the emission wraps the
		// future around it. So its `<-` answers the inner Type.
		it("holds a completing body's '<-' to the inner Type", () => {
			expect(
				codesOf(`implementation {
${deferredThree}
}`),
			).toEqual([])
			expect(
				codesOf(`implementation {
	function three() -> Future<Integer> {
		constant ignored = complete Async.deferred(() { <- 3 })

		<- Async.deferred(() { <- 3 })
	}
}`),
			).toEqual(["return-type-mismatch"])
		})

		// The note names the Type the `<-` answers with, not the declared
		// `Future<Integer>`.
		it("names the Type a completing body's '<-' answers with", () => {
			let [diagnostic] = diagnosticsOf(`implementation {
	function noReturn() -> Future<Integer> {
		complete Async.sleep(milliseconds 1)
	}
}`)

			expect(diagnostic?.code).toBe("missing-return")
			expect(diagnostic?.notes[0]).toBe(
				"This body waits, so its '<-' answers with Integer; every path must yield one.",
			)
		})

		// A body that completes nothing answers the future it assembled.
		it("holds an ordinary body to the Future it declared", () => {
			expect(
				codesOf(`implementation {
	function work() -> Future<Integer> {
		<- Async.deferred(() { <- 3 })
	}
}`),
			).toEqual([])
		})

		it("infers a completing closure's Future back around its body", () => {
			expect(
				lastConstantType(`implementation {
	constant answers = [1, 2]::map((value) -> Future<Integer> {
		<- complete Async.deferred(() { <- value })
	})
}`),
			).toBe("NonEmptyList<Future<Integer>>")
		})

		// A `complete` inside a Function literal marks the literal's own body.
		it("marks the nearest body, not the one around it", () => {
			expect(
				codesOf(`implementation {
	function build() -> Integer {
		constant inner = () -> Future<Integer> {
			<- complete Async.deferred(() { <- 1 })
		}

		<- 1
	}
}`),
			).toEqual([])
		})
	})

	describe("the Diagnostics", () => {
		// A bare spelling is refused as a bare `Optional` is. It would mean
		// `Future<Unknown>`, and a completed `Unknown` fits every annotation.
		it("refuses the bare spellings of the two Types", () => {
			let future = diagnosticsOf(`implementation {
	function work() -> Future {
		<- Async.deferred(() { <- 42 })
	}
}`)

			expect(future.map((diagnostic) => diagnostic.code)).toEqual([
				"wrong-type-argument-count",
			])
			expect(future[0]!.message).toBe(
				"Type 'Future' was given the wrong number of Type Arguments",
			)
			expect(future[0]!.notes).toEqual([
				"'Future' takes 1 Type Parameter.",
			])

			expect(
				codesOf(`implementation {
	constant running: Started = start Async.deferred(() { <- 42 })
}`),
			).toEqual(["wrong-type-argument-count"])
		})

		// Refused at the annotation alone. The recovery holds an Error, so
		// nothing downstream is reported.
		it("refuses the laundering a bare Future used to allow", () => {
			expect(
				codesOf(`implementation {
	function work() -> Future {
		<- Async.deferred(() { <- 42 })
	}

	constant got: List<String> = [complete work()]

	Terminal.print(got::join(with " "))
}`),
			).toEqual(["wrong-type-argument-count"])
		})

		it("refuses a 'complete' nothing can wait for", () => {
			let diagnostics = diagnosticsOf(`implementation {
	function three() -> Integer {
		<- complete Async.deferred(() { <- 3 })
	}
}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"complete-outside-future",
			])
			expect(diagnostics[0]!.helps).toEqual([
				"Declare the return Type 'Future<Integer>'.",
			])
		})

		it("refuses a 'complete' where nothing can suspend at all", () => {
			expect(
				codesOf(`implementation {
	function three(_ value: Integer = complete Async.deferred(() { <- 3 })) -> Integer {
		<- value
	}
}`),
			).toEqual(["complete-outside-future"])
		})

		// The word is the one mistake, so `needless-complete` stays quiet and the
		// Help drops the word rather than declaring a Future.
		it("reports a misplaced 'complete' before no work once", () => {
			let diagnostics = diagnosticsOf(`implementation {
	function twice(x: Integer) -> Integer {
		<- complete x
	}
}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"complete-outside-future",
			])
			expect(diagnostics[0]!.helps).toEqual(["Drop the 'complete'."])
			expect(diagnostics[0]!.data).toEqual({ kind: "not-work" })
			expect(
				codesOf(`implementation {
	function twice(_ value: Integer = complete 1) -> Integer {
		<- value
	}
}`),
			).toEqual(["complete-outside-future"])
		})

		// An operand already reported is no evidence that the word is needless,
		// so the misplaced word keeps the Future Help and no Warning cascades.
		it("judges no operand that is already an Error", () => {
			let misplaced = diagnosticsOf(`implementation {
	function g() -> Integer {
		<- complete nope
	}
}`)

			expect(misplaced.map((diagnostic) => diagnostic.code)).toEqual([
				"unknown-name",
				"complete-outside-future",
			])
			expect(misplaced[1]!.helps).toEqual([
				"Declare the return Type 'Future<Integer>'.",
			])
			expect(
				codesOf(`implementation {
	function g() -> Future<Integer> {
		<- complete nope
	}
}`),
			).toEqual(["unknown-name"])
		})

		it("refuses a Future nobody runs", () => {
			let diagnostics = diagnosticsOf(`implementation {
	Async.deferred(() { <- 1 })
}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"unused-future",
			])
			expect(diagnostics[0]!.helps?.[0]).toContain("'complete'")
		})

		// Fire and forget is a real thing to write, so it is an Information.
		it("mentions a Started nobody waits for", () => {
			let diagnostics = diagnosticsOf(`implementation {
	start Async.deferred(() { <- 1 })
}`)

			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.code,
					diagnostic.severity,
				]),
			).toEqual([["unobserved-started", "information"]])
		})

		it("warns about a Keyword with nothing to do", () => {
			expect(
				codesOf(`implementation {
	constant answer = complete 1
}`),
			).toEqual(["needless-complete"])
			expect(
				codesOf(`implementation {
	constant answer = start 1
}`),
			).toEqual(["needless-start"])
			expect(
				codesOf(`implementation {
	constant running = start Async.deferred(() { <- 1 })
	constant again = start running
}`),
			).toEqual(["needless-start"])
		})

		// The Helps a mismatch gets where the difference is one missing word.
		it("says which word a mismatch is missing", () => {
			let unstarted = diagnosticsOf(`implementation {
	constant answer: Integer = Async.deferred(() { <- 1 })
}`)

			expect(unstarted[0]!.code).toBe("assignment-type-mismatch")
			expect(unstarted[0]!.helps?.[0]).toContain("add 'complete'")

			let inFlight = diagnosticsOf(`implementation {
	constant running = start Async.deferred(() { <- 1 })
	constant answer: Integer = running
}`)

			expect(inFlight[0]!.code).toBe("assignment-type-mismatch")
			expect(inFlight[0]!.helps?.[0]).toContain("still in flight")

			let notAFuture = diagnosticsOf(`implementation {
	function three() -> Future<Integer> {
		<- 3
	}
}`)

			expect(notAFuture[0]!.code).toBe("return-type-mismatch")
			expect(notAFuture[0]!.helps?.[0]).toContain("completes nothing")

			let completing = diagnosticsOf(`implementation {
	function three() -> Future<Integer> {
		constant ignored = complete Async.deferred(() { <- 3 })

		<- Async.deferred(() { <- 3 })
	}
}`)

			expect(completing[0]!.code).toBe("return-type-mismatch")
			expect(completing[0]!.helps?.[0]).toContain("Add 'complete'")
		})

		// The same answer as data at every site that reports it, since a Quick
		// Fix must not key on a Help's wording. `not-a-future` has no edit.
		it("carries which word is missing as data", () => {
			let dataOf = (source: string): unknown =>
				diagnosticsOf(source)[0]?.data

			expect(
				dataOf(`implementation {
	constant answer: Integer = Async.deferred(() { <- 1 })
}`),
			).toEqual({ kind: "asynchrony-mismatch", mismatch: "unstarted" })
			expect(
				dataOf(`implementation {
	variable answer = 1
	answer = Async.deferred(() { <- 1 })
}`),
			).toEqual({ kind: "asynchrony-mismatch", mismatch: "unstarted" })
			expect(
				dataOf(`implementation {
	function show(_ value: Integer) -> Integer {
		<- value
	}

	constant shown = show(Async.deferred(() { <- 1 }))
}`),
			).toEqual({ kind: "asynchrony-mismatch", mismatch: "unstarted" })
			expect(
				dataOf(`implementation {
	function three() -> Integer {
		<- Async.deferred(() { <- 3 })
	}
}`),
			).toEqual({ kind: "asynchrony-mismatch", mismatch: "unstarted" })
			expect(
				dataOf(`implementation {
	constant ready = true
	constant answer: Integer = define {
		as Async.deferred(() { <- 1 }) if ready
		as 2 otherwise
	}
}`),
			).toEqual({ kind: "asynchrony-mismatch", mismatch: "unstarted" })
			expect(
				dataOf(`implementation {
	constant running = start Async.deferred(() { <- 1 })
	constant answer: Integer = running
}`),
			).toEqual({ kind: "asynchrony-mismatch", mismatch: "in-flight" })
			expect(
				dataOf(`implementation {
	function three() -> Future<Integer> {
		<- 3
	}
}`),
			).toBeUndefined()
		})
	})

	describe("the emission", () => {
		it("answers a completing body with the future it builds", () => {
			let javaScript = generate(`implementation {
${deferredThree}
	Terminal.inspect(complete three())
}`)

			expect(javaScript).toContain("return $future.of(async $ctx => {")
			expect(javaScript).toContain(
				"return await $future.complete(Async.deferred(",
			)
		})

		// The context is `$ctx` inside a completing body and a fresh root
		// elsewhere.
		it("starts top level work under a root context", () => {
			let javaScript = generate(`implementation {
${deferredThree}
	constant running = start three()

	Terminal.inspect(complete running)
}`)

			expect(javaScript).toContain(
				"$future.start(three(), $future.root())",
			)
			expect(javaScript).toContain(
				"await $future.complete(running, $future.root())",
			)
		})

		// A Match in an Argument is emitted as a Function, so a Handler that
		// waits makes it `async` and the call awaited. A Match in Statement
		// position is lowered to Statements instead.
		it("awaits a wrapper whose body waits", async () => {
			let source = `implementation {
	function answer(_ value: Optional<Integer>) -> Future<Integer> {
		<- 1::add(match value -> Integer {
			case #Value(held) { <- complete Async.deferred(() { <- held }) }
			case #Empty { <- 0 }
		})
	}

	Terminal.inspect(complete answer(#Value(41)))
	Terminal.inspect(complete answer(#Empty))
}`

			expect(generate(source)).toContain("await async function")
			expect(await run(source)).toEqual(["42", "1"])
		})

		// A Condition reads `value` off an Essence Boolean. Off an `await` the
		// read must be parenthesised, or it binds to the operand.
		it("parenthesises a value read off an await", () => {
			let javaScript = generate(`implementation {
	function ready() -> Future<Boolean> {
		<- complete Async.deferred(() { <- true })
	}

	if complete ready() {
		Terminal.inspect("ready")
	}
}`)

			expect(javaScript).toContain("if ((await $future.complete(")
			expect(javaScript).toContain(").value)")
		})
	})

	describe("a Program that runs", () => {
		it("runs nothing until the work is started", async () => {
			expect(
				await run(`implementation {
	constant work = Async.deferred(() {
		Terminal.inspect("ran")

		<- 1
	})

	Terminal.inspect("built")
	Terminal.inspect(complete work)
}`),
			).toEqual(['"built"', '"ran"', "1"])
		})

		// Each start of a Future is a fresh run. A Started is one run, so
		// completing it twice runs nothing the second time.
		it("runs a Future per start and a Started once", async () => {
			expect(
				await run(`implementation {
	constant work = Async.deferred(() {
		Terminal.inspect("ran")

		<- 1
	})

	Terminal.inspect(complete work)
	Terminal.inspect(complete work)

	constant running = start work

	Terminal.inspect(complete running)
	Terminal.inspect(complete running)
}`),
			).toEqual(['"ran"', "1", '"ran"', "1", '"ran"', "1", "1"])
		})

		it("completes work a Method built", async () => {
			expect(
				await run(`implementation {
	namespace Doubling for Integer {
		doubled() -> Future<Integer> {
			<- complete Async.deferred(() { <- @::multiply(with 2) })
		}
	}

	Terminal.inspect(complete 21::doubled())
}`),
			).toEqual(["42"])
		})

		// A sync closure written inside a completing body closes over its
		// `$ctx`, so what it starts belongs to the run that built it.
		it("starts work from inside a closure the body wrote", async () => {
			expect(
				await run(`implementation {
	function total() -> Future<Integer> {
		constant runs = [1, 2, 3]::map((value) {
			<- start Async.deferred(() { <- value })
		})

		<- complete Async.deferred(() { <- runs::length() })
	}

	Terminal.inspect(complete total())
}`),
			).toEqual(["3"])
		})
	})
})
