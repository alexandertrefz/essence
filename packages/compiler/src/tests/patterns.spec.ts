import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { common } from "@essence-lang/interfaces"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"
import { codesOfSource, compiles } from "./followedHelps"

// The full pipeline minus bundling, since every stage has a part in a Pattern.
function generate(source: string): string {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return rewrite(optimise(simplify(enriched.program)))
}

function diagnosticsOf(source: string): Array<common.Diagnostic> {
	let parsed = parseWithDiagnostics(source)

	if (containsErrors(parsed.diagnostics)) {
		return parsed.diagnostics
	}

	let enriched = enrich(parsed.program)

	if (containsErrors(enriched.diagnostics)) {
		return enriched.diagnostics
	}

	return validate(enriched.program)
}

function codesOf(source: string): Array<string> {
	return diagnosticsOf(source).map((diagnostic) => diagnostic.code)
}

function helpsOf(source: string): Array<string> {
	return diagnosticsOf(source).flatMap((diagnostic) => diagnostic.helps)
}

async function run(source: string): Promise<Array<string>> {
	let js = generate(source)
	let directory = mkdtempSync(join(tmpdir(), "essence-pattern-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, js)

	let output: Array<string> = []
	let originalLog = console.log

	console.log = (...args: Array<unknown>) => {
		output.push(args.map((arg) => String(arg)).join(" "))
	}

	try {
		await import(file)
	} finally {
		console.log = originalLog
		rmSync(directory, { recursive: true, force: true })
	}

	return output
}

describe("Patterns", () => {
	describe("in Matcher position", () => {
		const input = `type Click = { x: Integer, y: Integer }
			type KeyPress = { key: String }

			constant input: Click | KeyPress = { x = 0, y = 7 }`

		it("binds a bare member, and one constrained by Type", async () => {
			expect(
				await run(`implementation {
					${input}

					Terminal.inspect(match input -> String {
						case { x = 0, y }               { <- "y axis at {y}" }
						case { x: Integer, y: Integer } { <- "at {x}, {y}" }
						case { key }                    { <- "pressed {key}" }
					})
				}`),
			).toEqual([`"y axis at 7"`])
		})

		// The value is written in the Matcher, so no name is bound for it.
		it("binds nothing for a member constrained by value", () => {
			expect(
				codesOf(`implementation {
					${input}

					Terminal.inspect(match input -> String {
						case { x = 0, y } { <- "{x}" }
						case _            { <- "other" }
					})
				}`),
			).toContain("unknown-name")
		})

		it("lets a Guard see the bindings", async () => {
			expect(
				await run(`implementation {
					${input}

					constant square: Click | KeyPress = { x = 3, y = 3 }

					Terminal.inspect(match square -> String {
						case { x, y } where x::is(y) { <- "diagonal at {x}" }
						case { x, y }                { <- "at {x}, {y}" }
						case { key }                 { <- "pressed {key}" }
					})
				}`),
			).toEqual([`"diagonal at 3"`])
		})

		// `@` is already the scrutinee narrowed to what the Matcher established.
		it("refuses a whole-value binder, naming '@'", () => {
			let source = `implementation {
				${input}

				Terminal.inspect(match input -> String {
					case { x, y } as whole { <- "{whole.x}" }
					case _                 { <- "other" }
				})
			}`

			expect(codesOf(source)).toContain("redundant-pattern-binder")
			// Both edits: rewriting the body alone leaves the refused binder.
			expect(helpsOf(source)).toContain(
				"Drop the 'as whole' and write '@' where 'whole' was meant.",
			)
		})

		// A member with an annotation and a nested binder requires the nested
		// members too, so the arm can decline and the Match is not exhaustive.
		it("declines on an annotated member's nested requirements", async () => {
			const wrapped = `type Click = { x: Integer, y: Integer }
				type KeyPress = { key: String }
				type Wrapped = { payload: Click | KeyPress }
				type Other = { tag: String }

				constant value: Wrapped | Other = { payload = { x = 1, y = 2 } }`

			expect(
				codesOf(`implementation {
					${wrapped}

					constant described = match value -> String {
						case { payload: Click | KeyPress as { key } } { <- key }
						case { tag } { <- tag }
					}
				}`),
			).toContain("missing-case")

			expect(
				await run(`implementation {
					${wrapped}

					Terminal.inspect(match value -> String {
						case { payload: Click | KeyPress as { key } } { <- key }
						case _ { <- "declined" }
					})
				}`),
			).toEqual([`"declined"`])
		})

		it("shadows an outer name, and 'as' declines to", async () => {
			expect(
				await run(`implementation {
					${input}

					constant x = 99

					Terminal.inspect(match input -> String {
						case { x }         { <- "shadowed {x}" }
						case { key }       { <- "pressed {key}" }
					})

					Terminal.inspect(match input -> String {
						case { x as column } { <- "{column}, not {x}" }
						case { key }         { <- "pressed {key}" }
					})
				}`),
			).toEqual([`"shadowed 0"`, `"0, not 99"`])
		})

		// The member is reported where it is written, so its binding raises
		// nothing further, whatever the body asks of it.
		it("reports a member no arm carries once, at the member", () => {
			let diagnostics = diagnosticsOf(`implementation {
				${input}

				function twice(_ n: Integer) -> Integer {
					<- n::multiply(with 2)
				}

				Terminal.inspect(match input -> String {
					case { zq as column } {
						Terminal.print(column)
						Terminal.print(column::toString())
						constant n: Integer = column
						Terminal.print(twice(column))
						if column {
							Terminal.print("yes")
						}
						<- "{column}"
					}
					case _ { <- "other" }
				})
			}`)

			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.code,
					diagnostic.message,
					diagnostic.position?.start,
				]),
			).toEqual([
				[
					"unknown-member",
					"'Click | KeyPress' has no member 'zq'",
					{ line: 12, column: 13 },
				],
			])
		})

		// A Match over a value of one shape is the mistake, so a member its
		// Matcher names and the value lacks is no second one.
		it("reports a Match over no Union once, whatever members its Matchers name", () => {
			let diagnostics = diagnosticsOf(`implementation {
				function first<infer Item>(_ item: Item) -> Integer {
					<- match item -> Integer {
						case { x } { <- x }
						case _     { <- 0 }
					}
				}

				constant point = { x = 1, y = 2 }

				Terminal.print(match point -> Integer {
					case { z }          { <- z }
					case { x as { w } } { <- w }
					case _              { <- 0 }
				})
				Terminal.print(first(1))
			}`)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
				"match-on-non-union",
				"match-on-non-union",
			])
		})

		// A literal Match takes an Integer apart by its values and is not
		// refused whole, so a member its Pattern names is the mistake.
		it("reports a member a literal Match's Pattern names once", () => {
			expect(
				codesOfSource(`implementation {
				constant n = 5

				constant first = match n -> Integer {
					case 1     { <- 10 }
					case { z } { <- z }
				}
				constant second = match n -> Integer {
					case 1     { <- 10 }
					case { z } { <- z }
					case _     { <- 0 }
				}

				Terminal.print(first::add(second))
			}`),
			).toEqual(["unknown-member", "unknown-member"])
		})

		// A Case Matcher over no Union is refused by its own `unknown-case`,
		// which stands the Match's verdict down.
		it("reports a Case Matcher over no Union once", () => {
			expect(
				codesOfSource(`implementation {
				constant n = 5
				constant point = { x = 1, y = 2 }

				constant first = match n -> Integer {
					case #Value { <- 1 }
					case _      { <- 0 }
				}
				constant second = match point -> Integer {
					case #Value { <- 1 }
					case _      { <- 0 }
				}

				Terminal.print(first::add(second))
			}`),
			).toEqual(["unknown-case", "unknown-case"])
		})

		it("offers the member a misspelled one meant", () => {
			expect(
				helpsOf(`implementation {
					${input}

					Terminal.inspect(match input -> String {
						case { kye } { <- kye }
						case _       { <- "other" }
					})
				}`),
			).toEqual([
				"Did you mean 'key'?",
				"Or write its Type, as in 'kye: …', to test for a member the Type leaves out.",
			])
		})

		// A Record may carry members its Type leaves out, so a member written with
		// its Type is a test the value may pass. It compiles, binds the written
		// Type, and is no unreachable arm.
		it("tests for a typed member no candidate declares", async () => {
			let source = `implementation {
				type Point = { x: Integer, y: Integer }

				function named(_ value: Record | Integer) -> String {
					<- match value -> String {
						case { name: String } { <- "named {name::uppercase()}" }
						case _                { <- "other" }
					}
				}

				function labelled(_ value: Point | Integer) -> String {
					<- match value -> String {
						case { label: String } { <- "labelled {label}" }
						case _                 { <- "other" }
					}
				}

				Terminal.inspect(named({ name = "ada" }))
				Terminal.inspect(labelled({ x = 1, y = 2, label = "p" }))
				Terminal.inspect(labelled({ x = 1, y = 2 }))
			}`

			expect(codesOf(source)).toEqual([])
			expect(await run(source)).toEqual([
				`"named ADA"`,
				`"labelled p"`,
				`"other"`,
			])
		})

		it("tests for a typed nested member no candidate declares", async () => {
			let source = `implementation {
				type Wrapped = { payload: { x: Integer } }
				type Other = { tag: String }

				function read(_ value: Wrapped | Other) -> String {
					<- match value -> String {
						case { payload as { note: String } } { <- note }
						case _                               { <- "other" }
					}
				}

				constant wrapped = { payload = { x = 1, note = "kept" } }

				Terminal.inspect(read(wrapped))
				Terminal.inspect(read({ tag = "t" }))
			}`

			expect(codesOf(source)).toEqual([])
			expect(await run(source)).toEqual([`"kept"`, `"other"`])
		})

		// A member no candidate declares may pass, so each arm is judged on the
		// rest. Here the rest contradicts `Point`, or an earlier arm takes it.
		it("keeps an arm unreachable that its declared members rule out", () => {
			let point = `type Point = { x: Integer, y: Integer }`

			expect(
				codesOf(`implementation {
					${point}

					function contradicting(_ value: Point | Integer) -> String {
						<- match value -> String {
							case { x: String, label: String } { <- "string x" }
							case _                            { <- "other" }
						}
					}

					function nested(_ value: { pos: Point } | Integer) -> String {
						<- match value -> String {
							case { pos as { x: String, z: Integer } } { <- "nested" }
							case _                                    { <- "other" }
						}
					}

					function taken(_ value: Point | Integer) -> String {
						<- match value -> String {
							case { x: Integer }                { <- "point" }
							case { x: Integer, label: String } { <- "labelled" }
							case _                             { <- "other" }
						}
					}
				}`),
			).toEqual([
				"unreachable-case",
				"unreachable-case",
				"unreachable-case",
			])
		})

		// The control: a typed member over a Union with no Record in it is a test
		// no value passes.
		it("keeps a typed member over a Union with no Record unreachable", () => {
			expect(
				codesOf(`implementation {
					constant value: Integer | String = 5

					Terminal.inspect(match value -> String {
						case { name: String } { <- name }
						case _                { <- "other" }
					})
				}`),
			).toEqual(["unreachable-case"])
		})

		it("reports a nested member no arm carries once, at the member", () => {
			expect(
				codesOf(`implementation {
					type Wrapped = { payload: { x: Integer } }
					type Other = { tag: String }

					constant value: Wrapped | Other = { tag = "t" }

					Terminal.inspect(match value -> String {
						case { payload as { zq } } { <- "{zq}" }
						case _                     { <- "other" }
					})
				}`),
			).toEqual(["unknown-member"])
		})

		// The control: `key` is a member an arm carries, and the earlier arm has
		// taken every value the later one could.
		it("keeps an arm the earlier arms leave nothing to a Warning", () => {
			expect(
				codesOf(`implementation {
					${input}

					Terminal.inspect(match input -> String {
						case { key } { <- key }
						case { key } { <- "again" }
						case _       { <- "other" }
					})
				}`),
			).toEqual(["unreachable-case"])
		})
	})

	describe("in a Case payload", () => {
		const shape = `choice Shape {
				Rectangle { width: Integer, height: Integer },
				Circle { radius: Integer },
			}`

		it("takes a payload carrying several apart", async () => {
			expect(
				await run(`implementation {
					${shape}

					constant shape: Shape = #Rectangle({ width = 3, height = 4 })

					Terminal.inspect(match shape -> Integer {
						case #Rectangle({ width, height }) {
							<- width::multiply(with height)
						}
						case #Circle({ radius }) { <- radius }
					})
				}`),
			).toEqual(["12"])
		})

		it("names the whole payload alongside its parts", async () => {
			expect(
				await run(`implementation {
					${shape}

					constant shape: Shape = #Rectangle({ width = 3, height = 4 })

					Terminal.inspect(match shape -> Integer {
						case #Rectangle({ width, height } as box) {
							<- width::add(height)::add(box.width)
						}
						case #Circle({ radius }) { <- radius }
					})
				}`),
			).toEqual(["10"])
		})

		// The tag test proves the value is a `#Rectangle`, so the binder has
		// every member it declares, not only those the Pattern names.
		it("gives the 'as' binder every member the Case declares", async () => {
			expect(
				await run(`implementation {
					${shape}

					constant shape: Shape = #Rectangle({ width = 3, height = 4 })

					Terminal.inspect(match shape -> Integer {
						case #Rectangle({ width } as box) {
							<- width::add(box.height)
						}
						case #Circle({ radius }) { <- radius }
					})
				}`),
			).toEqual(["7"])
		})

		it("gives a shorthand reading's 'as' binder the whole payload", async () => {
			expect(
				await run(`implementation {
					choice Progress {
						Going { state: { index: Integer, total: Integer } },
						Stopped,
					}

					constant started: Progress = #Going({
						state = { index = 1, total = 7 },
					})

					Terminal.inspect(match started -> Integer {
						case #Going({ index } as st) { <- index::add(st.total) }
						case #Stopped { <- 0 }
					})
				}`),
			).toEqual(["8"])
		})

		// Construction tries the payload Record first, and the Matcher mirrors
		// it.
		it("reads a one-member payload as the Record where that fits", async () => {
			expect(
				await run(`implementation {
					choice Boxed { Full { value: { value: Integer } } }

					constant boxed: Boxed = #Full({ value = { value = 7 } })

					Terminal.inspect(match boxed -> Integer {
						case #Full({ value }) { <- value.value }
					})
				}`),
			).toEqual(["7"])
		})

		// The shorthand reading applies only where the Record one does not fit.
		it("falls back to the shorthand reading when the Record one does not fit", async () => {
			expect(
				await run(`implementation {
					choice Progress<State, Result> {
						Going { state: State },
						Stopped { value: Result },
					}

					constant started: Progress<{
						index: Integer,
						total: Integer,
					}, Integer> = #Going({ state = { index = 1, total = 7 } })

					Terminal.inspect(match started -> Integer {
						case #Going({ index, total })  { <- index::add(total) }
						case #Stopped(done)            { <- done }
					})

					Terminal.inspect(match started -> Integer {
						case #Going({ state as { index, total } }) {
							<- total::subtract(index)
						}
						case #Stopped(done) { <- done }
					})
				}`),
			).toEqual(["8", "6"])
		})

		// The Rewriter keys a member comparison by the dotted spine that reaches
		// it. Both arms are asked, since an ignored constraint would take the
		// first arm for both values.
		it("constrains a nested member by value, and declines on it", async () => {
			const drawn = `choice Drawn {
					Framed { box: { width: Integer, height: Integer } },
					Blank,
				}

				function describe(_ drawn: Drawn) -> String {
					<- match drawn -> String {
						case #Framed({ box as { width = 0, height } }) {
							<- "flat, {height}"
						}
						case #Framed({ box }) { <- "{box.width}x{box.height}" }
						case #Blank           { <- "blank" }
					}
				}`

			expect(
				await run(`implementation {
					${drawn}

					Terminal.inspect(
						describe(#Framed({ box = { width = 0, height = 4 } })),
					)
					Terminal.inspect(
						describe(#Framed({ box = { width = 2, height = 4 } })),
					)
				}`),
			).toEqual([`"flat, 4"`, `"2x4"`])
		})

		it("still refuses a NAME on a Case carrying several", () => {
			let source = `implementation {
				${shape}

				constant shape: Shape = #Circle({ radius = 1 })

				constant sized = match shape -> Integer {
					case #Rectangle(box)  { <- 0 }
					case #Circle(radius)  { <- radius }
				}
			}`

			expect(codesOf(source)).toContain("unbindable-case-payload")
			expect(helpsOf(source)).toContain(
				"Take the payload apart instead: '#Rectangle({ width, height })'.",
			)
		})
	})

	describe("in Parameter position", () => {
		it("leaves the call site alone", async () => {
			expect(
				await run(`implementation {
					function area(of { width, height }: {
						width: Integer,
						height: Integer,
					}) -> Integer {
						<- width::multiply(with height)
					}

					Terminal.inspect(area(of { width = 6, height = 7 }))
				}`),
			).toEqual(["42"])
		})

		it("takes a Function literal's Parameter apart", async () => {
			expect(
				await run(`implementation {
					Terminal.inspect(
						["a", "b"]::pair(with [1, 2])::map(({
							first,
							second,
						}) { <- "{first}{second}" }),
					)
				}`),
			).toEqual(['[ "a1", "b2" ]'])
		})

		// Return Type inference declares a `loop` callback's Parameters itself,
		// so a Pattern there must reach that pass too.
		it("reaches a callback whose return Type is inferred from its body", async () => {
			expect(
				await run(`implementation {
					constant walked = loop(
						startingWith { index = 1, total = 0 },
						step ({ index, total } as state) {
							if index::isGreaterThan(5) {
								<- #Done(total)
							}

							<- #Continue({ state with
								index = index::add(1),
								total = total::add(index),
							})
						},
					)

					Terminal.inspect(walked)
				}`),
			).toEqual(["15"])
		})

		it("refuses a member constrained by value", () => {
			let source = `implementation {
				function area(of { width = 1, height }: {
					width: Integer,
					height: Integer,
				}) -> Integer {
					<- width::multiply(with height)
				}
			}`

			expect(codesOf(source)).toContain("refutable-pattern")
			// The refused member still binds, so the body reading it is not told
			// the name does not exist.
			expect(codesOf(source)).not.toContain("unknown-name")
		})
	})

	describe("in Declaration position", () => {
		it("binds every name a Pattern names", async () => {
			expect(
				await run(`implementation {
					constant { accepted, refused } = [1, 2, 3, 4]::partition(
						where (n) { <- n::isEven() },
					)

					Terminal.inspect(accepted)
					Terminal.inspect(refused)
				}`),
			).toEqual(["[ 2, 4 ]", "[ 1, 3 ]"])
		})

		// The synthesized base Constant evaluates the value once. See "Pattern
		// declarations" in packages/compiler/src/enricher/DEVELOPMENT.md.
		it("evaluates the value exactly once", async () => {
			expect(
				await run(`implementation {
					function sides() -> { width: Integer, height: Integer } {
						Terminal.inspect("evaluated")

						<- { width = 2, height = 3 }
					}

					constant { width, height } = sides()

					Terminal.inspect(width::multiply(with height))
				}`),
			).toEqual([`"evaluated"`, "6"])
		})

		it("names the whole value alongside its parts", async () => {
			expect(
				await run(`implementation {
					constant { width, height } as size = {
						width = 2,
						height = 5,
					}

					Terminal.inspect(
						width::multiply(with height)::add(size.width),
					)
				}`),
			).toEqual(["12"])
		})

		// Only the bindings follow the Declaration's own keyword.
		it("gives a 'variable' Pattern reassignable names", async () => {
			expect(
				await run(`implementation {
					variable { index, total } = { index = 1, total = 2 }

					index = index::add(10)

					Terminal.inspect(index::add(total))
				}`),
			).toEqual(["13"])
		})

		it("reads a nested Pattern down its spine", async () => {
			expect(
				await run(`implementation {
					constant point = { origin = { x = 1, y = 2 }, label = "p" }

					constant { origin as { x, y } } = point

					Terminal.inspect(x::add(y))
				}`),
			).toEqual(["3"])
		})

		it("refuses a member constrained by value, at any depth", () => {
			expect(
				codesOf(`implementation {
					constant nested = { origin = { x = 1, y = 2 } }

					constant { origin as { x = 0, y } } = nested

					Terminal.inspect(y)
				}`),
			).toContain("refutable-pattern")
		})

		// Unlike a Matcher, a Declaration naming a missing member binds a name
		// to nothing.
		it("reports a member the value has not got", () => {
			let source = `implementation {
				constant { widht } = { width = 3 }

				Terminal.inspect(widht)
			}`

			expect(codesOf(source)).toContain("unknown-member")
			expect(helpsOf(source)).toContain("Did you mean 'width'?")
		})

		it("reports two binders of one name as a duplicate", () => {
			expect(
				codesOf(`implementation {
					constant { width as measure, height as measure } = {
						width = 1,
						height = 2,
					}

					Terminal.inspect(measure)
				}`),
			).toContain("duplicate-variable")
		})

		// The base keeps its Position, or Step Over would leave the body. See
		// "Pattern declarations" in packages/compiler/src/enricher/DEVELOPMENT.md.
		it("gives every Statement it emits a Position", () => {
			let parsed = parseWithDiagnostics(`implementation {
				constant { width, height } = { width = 1, height = 2 }

				Terminal.inspect(width::add(height))
			}`)
			let simplified = simplify(enrich(parsed.program).program)
			let declarations = simplified.implementation.nodes.filter(
				(node) => node.nodeType === "VariableDeclarationStatement",
			)

			// The base, then one Constant per bound name.
			expect(declarations).toHaveLength(3)

			for (let binding of declarations) {
				expect(binding.position).toBeDefined()
			}
		})
	})

	// A Pattern stands for the Constants an author could have written, so it
	// refuses what they are refused for.
	describe("is the Constant it claims to desugar into", () => {
		it("refuses a member of a Union the way a written Lookup does", () => {
			let source = `implementation {
				type A = { x: Integer }
				type B = { y: Integer }

				constant v: A | B = { y = 1 }

				constant { x } = v

				Terminal.inspect(x)
			}`

			expect(codesOf(source)).toContain("type-without-members")
		})

		// A Pattern writes no `.`, so its Help speaks of the Pattern.
		it("names the binding a Pattern on a value with no members wants", () => {
			let source = `implementation {
				constant text = "hello"

				constant { length } = text

				Terminal.inspect(length)
			}`

			expect(codesOf(source)).toEqual(["type-without-members"])
			expect(helpsOf(source)).toEqual([
				"A Pattern takes apart a Record or a Case — bind the whole value instead, and call '::length()' on it.",
			])
			expect(
				compiles(`implementation {
				constant text = "hello"

				constant length = text::length()

				Terminal.inspect(length)
			}`),
			).toBe(true)
		})

		it("checks a member's written annotation against the value", () => {
			let source = `implementation {
				constant box = { width = 3, height = 4 }

				constant { width: String, height } = box

				Terminal.inspect(width)
				Terminal.inspect(height)
			}`

			expect(codesOf(source)).toContain("assignment-type-mismatch")
		})

		it("refuses the same in Parameter position", () => {
			let source = `implementation {
				type A = { x: Integer }
				type B = { y: Integer }

				function readX(_ { x }: A | B) -> Integer { <- x }

				Terminal.inspect(readX({ y = 1 }))
			}`

			expect(codesOf(source)).toContain("type-without-members")
		})
	})

	// A payload Pattern requires the members it reads, so the arm declines a
	// payload without them.
	describe("a payload Pattern's requirements", () => {
		const event = `type Click = { x: Integer, y: Integer }
			type KeyPress = { key: String }

			choice Event {
				Fired { payload: Click | KeyPress },
				Quiet,
			}`

		it("let the arm decline a payload it does not fit", async () => {
			expect(
				await run(`implementation {
					${event}

					constant event: Event = #Fired({ payload = { key = "a" } })

					Terminal.inspect(match event -> String {
						case #Fired({ x, y }) { <- "click {x}, {y}" }
						case #Fired({ key })  { <- "key {key}" }
						case _                { <- "other" }
					})
				}`),
			).toEqual([`"key a"`])
		})

		// The requirement is tested before any value comparison, which may read
		// down the spine it establishes.
		it("are tested before a nested value comparison reads down them", async () => {
			expect(
				await run(`implementation {
					choice Framed {
						Boxed { payload: { origin: { x: Integer } } | { key: String } },
						Bare,
					}

					constant framed: Framed = #Boxed({ payload = { key = "a" } })

					Terminal.inspect(match framed -> String {
						case #Boxed({ payload as { origin as { x = 0 } } }) {
							<- "origin zero"
						}
						case _ { <- "other" }
					})
				}`),
			).toEqual([`"other"`])
		})

		// A requirement narrows, so the arm binds what it proved rather than
		// what the Case declared, as the equivalent Record Matcher does.
		it("narrow what the arm binds, not only what it tests", async () => {
			expect(
				await run(`implementation {
					choice Payload {
						Some { value: Integer | String },
						None,
					}

					constant payload: Payload = #Some({ value = 7 })

					Terminal.inspect(match payload -> Integer {
						case #Some({ value: Integer }) { <- value::add(1) }
						case _                         { <- 0 }
					})
				}`),
			).toEqual(["8"])
		})

		// An arm requiring a member no payload has would never run, so it is
		// reported.
		it("report a member the payload has not got", () => {
			let source = `implementation {
				type Click = { x: Integer, y: Integer }
				type KeyPress = { key: String }

				choice Event {
					Fired { payload: Click | KeyPress },
					Idle,
				}

				constant event: Event = #Fired({ payload = { key = "a" } })

				Terminal.inspect(match event -> String {
					case #Fired({ key, extra }) { <- "key arm" }
					case _                      { <- "other" }
				})
			}`

			expect(codesOf(source)).toContain("unknown-member")
		})

		// A payload is a Record, so it may carry a member its Case leaves out, and
		// a member written with its Type tests for one.
		it("test for a typed member the payload's Case leaves out", async () => {
			let source = `implementation {
				choice Progress {
					Going { state: Integer, total: Integer },
					Stopped,
				}

				function described(_ progress: Progress) -> String {
					<- match progress -> String {
						case #Going({ label: String }) { <- "labelled {label}" }
						case _                         { <- "other" }
					}
				}

				constant carried = { state = 1, total = 2, label = "x" }

				Terminal.inspect(described(#Going(carried)))
				Terminal.inspect(described(#Going({ state = 1, total = 2 })))
			}`

			expect(codesOf(source)).toEqual([])
			expect(await run(source)).toEqual([`"labelled x"`, `"other"`])
		})

		// On a one-member Case the Pattern is read against that member's value,
		// an Integer here, which no typed member could pass.
		it("offer no typed spelling where the member is read against a value with no Record", () => {
			expect(
				helpsOf(`implementation {
					choice Shape {
						Rect { width: Integer },
						Empty,
					}

					constant shape: Shape = #Rect({ width = 2 })

					Terminal.inspect(match shape -> String {
						case #Rect({ tag }) { <- "tagged" }
						case _              { <- "other" }
					})
				}`),
			).toEqual([])
		})

		// The nested Pattern reads members of a value the payload has not got,
		// so they are no second mistake. `state` carries no `stat` either, so
		// the misspelling is the payload's.
		it("report a missing member that takes a nested Pattern at its name", () => {
			let program = (member: string): string => `implementation {
				choice Progress {
					Going { state: { index: Integer, total: Integer } },
					Stopped,
				}

				constant started: Progress = #Going({
					state = { index = 1, total = 7 },
				})

				Terminal.inspect(match started -> String {
					case #Going({ ${member} as { index = 1, total } }) { <- "first" }
					case _ { <- "later" }
				})
			}`
			let diagnostics = diagnosticsOf(program("stat"))

			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.code,
					diagnostic.message,
					diagnostic.position?.start,
				]),
			).toEqual([
				[
					"unknown-member",
					"'Progress#Going' has no member 'stat'",
					{ line: 12, column: 20 },
				],
			])
			expect(diagnostics[0]?.helps).toEqual(["Did you mean 'state'?"])
			expect(diagnostics[0]?.data).toEqual({
				kind: "suggestion",
				suggestion: "state",
			})
			expect(compiles(program("state"))).toBe(true)
		})

		// `{ radus }` names nothing an Integer carries, so it is the payload's
		// `radius` misspelt, not the one member's value taken apart.
		it("report a misspelt member of a one-member payload against the payload", () => {
			let program = (member: string): string => `implementation {
				choice Shape { Circle { radius: Integer }, Square { side: Integer } }

				function area(_ shape: Shape) -> Integer {
					<- match shape -> Integer {
						case #Circle({ ${member} }) { <- 1 }
						case #Square({ side }) { <- side }
					}
				}

				Terminal.print(area(#Square({ side = 2 })))
			}`
			let [refusal] = diagnosticsOf(program("radus"))

			expect(refusal?.message).toBe(
				"'Shape#Circle' has no member 'radus'",
			)
			expect(refusal?.notes).toEqual(["'Shape#Circle' has 'radius'."])
			expect(refusal?.helps).toEqual(["Did you mean 'radius'?"])
			expect(refusal?.data).toEqual({
				kind: "suggestion",
				suggestion: "radius",
			})
			expect(compiles(program("radius"))).toBe(true)
		})

		// `centre` holds a Record, so `{ xx }` may be its one member's value
		// taken apart, where `x` is the near miss. `{ centr }` has a near miss
		// only among the payload's members, so it is the payload misspelt.
		it("report a misspelt member against the reading that holds its near miss", () => {
			let program = (
				member: string,
				read: string,
			): string => `implementation {
				choice Shape { Circle { centre: { x: Integer, y: Integer } }, Square { side: Integer } }

				function px(_ shape: Shape) -> Integer {
					<- match shape -> Integer {
						case #Circle({ ${member} }) { <- ${read} }
						case #Square({ side }) { <- side }
					}
				}

				Terminal.print(px(#Square({ side = 2 })))
			}`
			let [shorthand] = diagnosticsOf(program("xx", "xx"))
			let [payload] = diagnosticsOf(program("centr", "1"))

			expect(shorthand?.message).toBe(
				"'{ x: Integer, y: Integer }' has no member 'xx'",
			)
			expect(shorthand?.helps[0]).toBe("Did you mean 'x'?")
			expect(shorthand?.data).toEqual({
				kind: "suggestion",
				suggestion: "x",
			})
			expect(compiles(program("x as xx", "xx"))).toBe(true)
			expect(payload?.message).toBe(
				"'Shape#Circle' has no member 'centr'",
			)
			expect(payload?.helps).toEqual(["Did you mean 'centre'?"])
			expect(compiles(program("centre", "1"))).toBe(true)
		})

		// The requirement is the annotation with the nested members merged in,
		// so the arm can decline and the Match is not exhaustive.
		it("keep a nested binder's requirements beside a written annotation", async () => {
			expect(
				codesOf(`implementation {
					${event}

					constant fired: Event = #Fired({ payload = { x = 1, y = 2 } })

					constant described = match fired -> String {
						case #Fired({ payload: Click | KeyPress as { key } }) {
							<- key
						}
						case #Quiet { <- "quiet" }
					}
				}`),
			).toContain("missing-case")

			expect(
				await run(`implementation {
					${event}

					constant fired: Event = #Fired({ payload = { x = 1, y = 2 } })

					Terminal.inspect(match fired -> String {
						case #Fired({ payload: Click | KeyPress as { key } }) {
							<- key
						}
						case _ { <- "declined" }
					})
				}`),
			).toEqual([`"declined"`])
		})

		// A Pattern naming only what the Case declares requires nothing new, so
		// the Match stays exhaustive without a 'case _'.
		it("do not make an ordinary payload Pattern conditional", () => {
			expect(
				codesOf(`implementation {
					choice Shape {
						Rectangle { width: Integer, height: Integer },
						Circle { radius: Integer },
					}

					constant shape: Shape = #Circle({ radius = 1 })

					Terminal.inspect(match shape -> Integer {
						case #Rectangle({ width, height }) { <- width }
						case #Circle({ radius })           { <- radius }
					})
				}`),
			).not.toContain("missing-case")
		})
	})

	// `as` is contextual. See "Contextual keywords" in
	// packages/compiler/src/parser/DEVELOPMENT.md.
	it("lets a member be called 'as'", async () => {
		expect(
			await run(`implementation {
				constant { as as as } = { as = "yes" }

				Terminal.inspect(as)
			}`),
		).toEqual(['"yes"'])
	})
})
