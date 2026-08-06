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

// NOTE: The full pipeline minus bundling, mirroring choices.spec — a Pattern
// is only implemented once every stage agrees on it.
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

		// NOTE: The value is written right there, so there is nothing for a name
		// to say that the Matcher has not said already.
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

		// NOTE: `@` is the scrutinee narrowed to what the Matcher established,
		// which is exactly what a whole-value binder would name a second time.
		it("refuses a whole-value binder, naming '@'", () => {
			let source = `implementation {
				${input}

				Terminal.inspect(match input -> String {
					case { x, y } as whole { <- "{whole.x}" }
					case _                 { <- "other" }
				})
			}`

			expect(codesOf(source)).toContain("redundant-pattern-binder")
			expect(helpsOf(source)).toContain(
				"Write '@' where 'whole' was meant.",
			)
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

		// NOTE: Decision 2 — construction answers the same fork by trying the
		// payload Record first, and the Matcher mirrors it, so a reader who
		// knows how a value is built knows how it comes apart.
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

		// NOTE: …and falls back to the shorthand reading only where the Record
		// one does not fit, which is what makes the nested spelling worth
		// having at all.
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

		// NOTE: The Rewriter keys a member comparison by the DOTTED spine that
		// reaches it, which is what lets a nested member constrain by value.
		// Both arms are asked: a constraint that is written and then ignored
		// would take the FIRST arm for both values, which is what this once did.
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

		// NOTE: A `loop` callback's return Type is inferred from its body, and
		// that pass declares the Parameters itself — a Pattern there has to
		// reach it, or a perfectly well-typed body reports no return Type.
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
			// NOTE: …and the refused member still BINDS, so the body reading it
			// is not told a second time that the name does not exist.
			expect(codesOf(source)).not.toContain("unknown-name")
		})
	})

	describe("in Declaration position", () => {
		it("binds every name a Pattern names", async () => {
			expect(
				await run(`implementation {
					constant { matching, rest } = [1, 2, 3, 4]::partition(
						where (n) { <- n::isEven() },
					)

					Terminal.inspect(matching)
					Terminal.inspect(rest)
				}`),
			).toEqual(["[ 2, 4 ]", "[ 1, 3 ]"])
		})

		// NOTE: The Declaration holds ONE Expression, so it runs once — an
		// author reading `partition(…)` twice is not what was written. This is
		// the property the synthesized base Constant exists for.
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

		// NOTE: Only the bindings follow the Declaration's own keyword — the
		// value itself is held once whatever it was written as.
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

		// NOTE: A Matcher naming a member no arm carries merely writes an arm
		// nothing takes; a Declaration naming one has bound a name to nothing.
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

		// NOTE: The base is synthesized in that no source wrote its NAME, but
		// what it holds is the Declaration's own value Expression — so it keeps
		// its Position like any other Statement. Dropping it was tried and is
		// wrong: an unmapped statement is how the debug adapter recognises
		// Compiler glue, so it answered a Step Over there with a step OUT, and
		// one step across a Pattern Declaration abandoned the rest of the body.
		it("gives every Statement it emits a Position", () => {
			let parsed = parseWithDiagnostics(`implementation {
				constant { width, height } = { width = 1, height = 2 }

				Terminal.inspect(width::add(height))
			}`)
			let simplified = simplify(enrich(parsed.program).program)
			let declarations = simplified.implementation.nodes.filter(
				(node) => node.nodeType === "VariableDeclarationStatement",
			)

			// NOTE: The base, then one Constant per bound name.
			expect(declarations).toHaveLength(3)

			for (let binding of declarations) {
				expect(binding.position).toBeDefined()
			}
		})
	})

	// NOTE: A Pattern PROMISES to be the Constants an author could have written,
	// so it may not admit what those are refused for. Every one of these
	// compiled clean and crashed at runtime before the Diagnostic each names
	// was wired up.
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

	// NOTE: A payload Pattern has to say what must BE there, not only where to
	// read — otherwise the arm accepts every value of its Case and reads
	// members off a payload that has none.
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

		// NOTE: The requirement has to be tested BEFORE any value comparison,
		// because a comparison may read down the very spine it establishes.
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

		// NOTE: A requirement is a NARROWING, so the arm binds what it proved
		// and not what the Case declared — the same answer the equivalent
		// Record Matcher gives, which is the point of the two spellings meaning
		// one thing. The arm below could not use the value it had just narrowed.
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

		// NOTE: The Validator reads only `matcher` for a Case Matcher, which is
		// the tag — so a member nothing carries is invisible to it, and the
		// emitted test demanded a member nothing has: the arm never ran, and
		// nothing was said.
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

		// NOTE: …and a Pattern naming only what the Case already declares asks
		// nothing new, so the arm stays UNCONDITIONAL and a Match over a Choice
		// is still exhaustive without a 'case _'.
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

	// NOTE: `as` is a Keyword only where a binder can follow it, which the
	// Module grammar already established for its own use of the word.
	it("lets a member be called 'as'", async () => {
		expect(
			await run(`implementation {
				constant { as as as } = { as = "yes" }

				Terminal.inspect(as)
			}`),
		).toEqual(['"yes"'])
	})
})
