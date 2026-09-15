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

// NOTE: Asynchrony end to end — the two Keywords, the two Types, the rule that
// makes a body a completing one, and what all of it emits. Every claim about
// what a Program MEANS is made by running it: a future is a description, and the
// difference between a description that ran and one that did not is not visible
// in a Type.
//
// NOTE: `Async.deferred` is the base case every Program here rests on. It is the
// one way to build a future out of nothing — a completing body wraps a future it
// already has, `start` runs one and `complete` reads one — so a Program with no
// native answering a Future can not write one down at all.

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

// NOTE: `await import`, and not because this file prefers it: a Program that
// completes anything at its top level emits a top-level `await`, which is a
// Module a `require` can not read at all.
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

// NOTE: The Type the last top level Constant was inferred at, spelled the way a
// Hover spells it — which is what the claims about `start` and `complete`
// answering are about.
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

		// NOTE: The whole postfix chain belongs to the Keyword, which is what
		// makes the everyday call — a future built by a call and completed —
		// need nothing written around it.
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

		// NOTE: Both words are CONTEXTUAL — the Keyword only in front of an
		// Expression, an ordinary name everywhere else, which is the rule
		// `expect` and `require` are read by. The positions below are the ones
		// the standard library, the fixtures, the examples and the docs write
		// them in, and they are pinned one by one because the rule lives in a
		// single `if` and everything else in the language reads through it.
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

		// NOTE: The one name the two words may not be, and the price of the
		// contextual reading. An Argument's label stands exactly where the
		// prefix form opens, so the Keyword wins there as it wins everywhere —
		// which is what lets `Terminal.print(complete headline(url))` be the
		// wait it reads as.
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

		// NOTE: The line is half the rule. A Statement ending on one of the
		// words and a Statement opening with an Expression read as TWO, because
		// the operand of a `start` begins on the `start`'s own line or the word
		// is a name. Without that, Essence ending a Statement at the end of its
		// Expression and at no Token of its own would make these one, and
		// nothing would report it.
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

		// NOTE: And an operand written over several lines still begins on the
		// Keyword's own line, which is why the line rule costs nothing anybody
		// writes.
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

		// NOTE: The Tokens that begin an Expression and yet only ever stand
		// where one has ENDED — every one of them can follow a value named
		// `start` or `complete`, and the Keyword reading of any of them was a
		// `needless-start` at best. `{` alone covers three forms: an `if`'s
		// block, a `match`'s and a Guard's.
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

	constant moved = { complete with x = 3 }

	constant named = match complete.y -> String {
		case 2 {
			<- "two"
		}
		case _ {
			<- "other"
		}
	}

	Terminal.print(chosen::add(moved.x)::toString())
	Terminal.print(named)
}`),
			).toEqual([])
		})

		// NOTE: And where nothing follows at all the word is a name, so it is
		// the Enricher that answers for one nothing declared — the Parser has
		// no refusal of its own left to make.
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

		// NOTE: A completing body is written as though it answered the value,
		// and the future is what the emission wraps around it — so a `<-`
		// answering the inner Type is what compiles, and one answering the
		// future is the mistake.
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

		// NOTE: A body that completes NOTHING is ordinary — it hands back a
		// future it assembled, and its `<-` answers the future itself.
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

		// NOTE: A `complete` written inside a Function literal belongs to THAT
		// literal — the mark is about the body the word stands in, and a
		// literal has a body of its own.
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

		it("refuses a Future nobody runs", () => {
			let diagnostics = diagnosticsOf(`implementation {
	Async.deferred(() { <- 1 })
}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"unused-future",
			])
			expect(diagnostics[0]!.helps?.[0]).toContain("'complete'")
		})

		// NOTE: Fire and forget is a real thing to write, so it is an
		// Information rather than a complaint.
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

		// NOTE: The four Helps a mismatch gets where the difference is one
		// missing word rather than a wrong value.
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

		// NOTE: The context is `$ctx` where a completing body encloses the site
		// and a fresh root where none does — which is a question about the
		// emitted JavaScript rather than about the Program.
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

		// NOTE: A Match is emitted as a Function the Rewriter calls, and an
		// `await` belongs to the nearest enclosing Function — so a Handler that
		// waits makes that wrapper `async` and the call awaited. It is asked of
		// a Match in an ARGUMENT, because a Match standing where a Statement may
		// be written is lowered to Statements and needs no wrapper at all.
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

		// NOTE: An Essence Boolean is an object, so a Condition reads the
		// `value` off it — and off an `await` that has to be parenthesised, or
		// the read binds to the operand instead.
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

		// NOTE: A Future is a description, so each start is a fresh run. A
		// Started is one run, so completing it twice answers the same value and
		// runs nothing the second time.
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

		// NOTE: A sync closure written inside a completing body closes over its
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
