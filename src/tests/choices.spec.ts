import { describe, expect, it } from "bun:test"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import type { common, parser } from "../interfaces/index"
import { printType } from "../lsp/printType"
import { optimise } from "../optimiser/index"
import { parse, parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: The full pipeline minus bundling, mirroring codeGeneration.spec — a
// Choice is only implemented once every stage agrees on it.
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

function messagesOf(source: string): Array<string> {
	return diagnosticsOf(source).map((diagnostic) => diagnostic.message)
}

function codesOf(source: string): Array<string> {
	return diagnosticsOf(source).map((diagnostic) => diagnostic.code)
}

// NOTE: The declared Type of a named Declaration in an enriched Program — the
// applied Union of a `type Applied = Step<Integer, String>` alias, or the
// Generic Alias a generic `choice` resolves to — so a test can read a Type off
// the tree without also constructing a value for it.
function declaredTypeOf(source: string, name: string): common.Type {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let node = enrich(parsed.program).program.implementation.nodes.find(
		(candidate) =>
			(candidate.nodeType === "TypeAliasStatement" ||
				candidate.nodeType === "ChoiceDeclarationStatement") &&
			candidate.name.content === name,
	) as
		| common.typed.TypeAliasStatementNode
		| common.typed.ChoiceDeclarationStatementNode
		| undefined

	if (node === undefined) {
		throw new Error(`No Declaration named '${name}'`)
	}

	return node.type
}

const stepChoice = `
	choice Step<State, Result> {
		Continue { state: State },
		Done { value: Result },
	}
`

const calculatorChoice = `
	choice CalculatorOperation {
		Add { left: Integer, right: Integer },
		Negate { number: Integer },
		ClearAll,
	}
`

describe("Choices", () => {
	describe("Parser", () => {
		it("parses a Choice Declaration with payload, unit Cases and a trailing comma", () => {
			let program = parse(`implementation { ${calculatorChoice} }`)
			let statement = program.implementation.nodes[0]

			expect(statement.nodeType).toBe("ChoiceDeclarationStatement")

			let choice = statement as parser.ChoiceDeclarationStatementNode

			expect(choice.name.content).toBe("CalculatorOperation")
			expect(choice.cases.map((c) => c.name.content)).toEqual([
				"Add",
				"Negate",
				"ClearAll",
			])
			expect(choice.cases[0].type?.nodeType).toBe("RecordTypeDeclaration")
			expect(choice.cases[2].type).toBeNull()
		})

		it("parses a Choice Declaration with a Generic clause", () => {
			let program = parse(`implementation {
				choice Step<State, Result> {
					Continue { state: State },
					Done { value: Result },
				}
			}`)
			let choice = program.implementation
				.nodes[0] as parser.ChoiceDeclarationStatementNode

			expect(choice.nodeType).toBe("ChoiceDeclarationStatement")
			expect(choice.generics).toHaveLength(2)
			expect(choice.generics.map((g) => g.name.content)).toEqual([
				"State",
				"Result",
			])
			expect(choice.generics[0].inferred).toBe(false)
			expect(choice.generics[0].defaultType).toBeNull()
			expect(choice.cases.map((c) => c.name.content)).toEqual([
				"Continue",
				"Done",
			])
		})

		it("parses a Choice Declaration with a defaulted Generic", () => {
			let program = parse(`implementation {
				choice Box<Value = Integer> {
					Full { value: Value },
					Empty,
				}
			}`)
			let choice = program.implementation
				.nodes[0] as parser.ChoiceDeclarationStatementNode

			expect(choice.generics).toHaveLength(1)
			expect(choice.generics[0].name.content).toBe("Value")
			expect(choice.generics[0].inferred).toBe(false)
			expect(choice.generics[0].defaultType).not.toBeNull()
		})

		it("reports an empty Generic clause on a Choice", () => {
			let { diagnostics } = parseWithDiagnostics(`implementation {
				choice Foo<> { A }
			}`)

			expect(containsErrors(diagnostics)).toBe(true)
		})

		it("parses a non-generic Choice with an empty Generic list", () => {
			let program = parse(`implementation { ${calculatorChoice} }`)
			let choice = program.implementation
				.nodes[0] as parser.ChoiceDeclarationStatementNode

			expect(choice.generics).toEqual([])
		})

		it("parses a prefixed Case construction", () => {
			let program = parse(`implementation {
				constant operation = CalculatorOperation#Add({ left = 1, right = 1 })
			}`)
			let statement = program.implementation
				.nodes[0] as parser.ConstantDeclarationStatementNode
			let value = statement.value as parser.CaseValueNode

			expect(value.nodeType).toBe("CaseValue")
			expect(value.choice?.content).toBe("CalculatorOperation")
			expect(value.caseName.content).toBe("Add")
			expect(value.value?.nodeType).toBe("RecordValue")
		})

		it("parses a unit Case construction without parens", () => {
			let program = parse(`implementation {
				constant operation = CalculatorOperation#ClearAll
			}`)
			let statement = program.implementation
				.nodes[0] as parser.ConstantDeclarationStatementNode
			let value = statement.value as parser.CaseValueNode

			expect(value.nodeType).toBe("CaseValue")
			expect(value.value).toBeNull()
		})

		it("parses bare and prefixed Case Matchers", () => {
			let program = parse(`implementation {
				match operation -> Nothing {
					case #Add { <- nothing }
					case CalculatorOperation#ClearAll { <- nothing }
				}
			}`)
			let match = program.implementation.nodes[0] as parser.MatchNode
			let [bare, prefixed] = match.handlers.map(
				(handler) => handler.matcher,
			)

			expect(bare.nodeType).toBe("CaseMatcher")
			expect((bare as parser.CaseMatcherNode).choice).toBeNull()
			expect((bare as parser.CaseMatcherNode).caseName.content).toBe(
				"Add",
			)

			expect(prefixed.nodeType).toBe("CaseMatcher")
			expect((prefixed as parser.CaseMatcherNode).choice?.content).toBe(
				"CalculatorOperation",
			)
		})

		it("keeps 'choice' usable as an Identifier", () => {
			let { diagnostics } = parseWithDiagnostics(`implementation {
				variable choice = 1
				choice = 2
				__print(choice)
			}`)

			expect(containsErrors(diagnostics)).toBe(false)
		})

		it("parses a generic clause on a Choice", () => {
			let program = parse(`implementation { ${stepChoice} }`)
			let choice = program.implementation
				.nodes[0] as parser.ChoiceDeclarationStatementNode

			expect(
				choice.generics.map((generic) => generic.name.content),
			).toEqual(["State", "Result"])
			expect(choice.cases.map((c) => c.name.content)).toEqual([
				"Continue",
				"Done",
			])
		})

		it("leaves a non-generic Choice with an empty generics clause", () => {
			let program = parse(`implementation { ${calculatorChoice} }`)
			let choice = program.implementation
				.nodes[0] as parser.ChoiceDeclarationStatementNode

			expect(choice.generics).toEqual([])
		})
	})

	describe("Enricher", () => {
		it("accepts construction, narrowing and payload member access", () => {
			expect(
				messagesOf(`implementation { ${calculatorChoice}
					constant operation: CalculatorOperation = CalculatorOperation#Add({ left = 1, right = 1 })

					__print(match operation -> Integer {
						case #Add { <- @.left::add(@.right) }
						case #Negate { <- @.number::multiply(with 2) }
						case #ClearAll { <- 0 }
					})
				}`),
			).toEqual([])
		})

		it("reports an unknown Choice", () => {
			expect(
				messagesOf(`implementation {
					constant operation = Missing#Add({ left = 1 })
				}`),
			).toContain("Type 'Missing' is not declared")
		})

		it("reports an unknown Case", () => {
			expect(
				messagesOf(`implementation { ${calculatorChoice}
					constant operation = CalculatorOperation#Modulo({ left = 1 })
				}`),
			).toContain("'CalculatorOperation' has no Case '#Modulo'")
		})

		it("reports a bare Case Matcher the matched Union does not declare", () => {
			expect(
				messagesOf(`implementation { ${calculatorChoice}
					constant operation: CalculatorOperation = CalculatorOperation#ClearAll

					match operation -> Nothing {
						case #Modulo { <- nothing }
						case _ { <- nothing }
					}
				}`),
			).toContain("The matched value has no Case '#Modulo'")
		})

		it("asks for the prefixed form when two Choices share a Case name", () => {
			expect(
				messagesOf(`implementation {
					choice A { Go { speed: Integer }, Stop }
					choice B { Go { speed: Integer }, Wait }

					constant command: A | B = A#Stop

					match command -> Nothing {
						case #Go { <- nothing }
						case _ { <- nothing }
					}
				}`),
			).toContain("Case '#Go' is declared by more than one Choice")
		})

		it("reports unknown payload members on Lookup", () => {
			expect(
				messagesOf(`implementation { ${calculatorChoice}
					constant operation: CalculatorOperation = CalculatorOperation#Add({ left = 1, right = 1 })

					match operation -> Nothing {
						case #Add { __print(@.missing) <- nothing }
						case _ { <- nothing }
					}
				}`),
			).toContain(
				"Case 'CalculatorOperation#Add' has no member 'missing'",
			)
		})

		it("keeps Cases nominal — a structurally identical Record is not a Case", () => {
			expect(
				messagesOf(`implementation { ${calculatorChoice}
					constant operation: CalculatorOperation = { left = 1, right = 1 }
				}`),
			).toContain(
				"This value does not fit the declared Type of Constant 'operation'",
			)

			expect(
				messagesOf(`implementation { ${calculatorChoice}
					constant record: { left: Integer, right: Integer } = CalculatorOperation#Add({ left = 1, right = 1 })
				}`),
			).toContain(
				"This value does not fit the declared Type of Constant 'record'",
			)
		})

		it("keeps Cases of different Choices apart", () => {
			expect(
				messagesOf(`implementation {
					choice A { Go { speed: Integer } }
					choice B { Go { speed: Integer } }

					constant command: A = B#Go({ speed = 1 })
				}`),
			).toContain(
				"This value does not fit the declared Type of Constant 'command'",
			)
		})

		it("rejects an empty Choice", () => {
			expect(
				messagesOf(`implementation {
					choice Empty { }
				}`),
			).toContain("A Choice must declare at least one Case")
		})

		it("rejects duplicate Cases", () => {
			expect(
				messagesOf(`implementation {
					choice Duplicated { Go, Go }
				}`),
			).toContain("Case '#Go' is declared more than once")
		})

		it("hoists Choices so use may precede declaration", () => {
			expect(
				messagesOf(`implementation {
					constant operation: CalculatorOperation = CalculatorOperation#ClearAll
					${calculatorChoice}
				}`),
			).toEqual([])
		})

		it("resolves a Choice through a Type Alias", () => {
			expect(
				messagesOf(`implementation { ${calculatorChoice}
					type Operation = CalculatorOperation

					constant operation: Operation = Operation#ClearAll
				}`),
			).toEqual([])
		})
	})

	describe("Generic Choices", () => {
		it("resolves a generic Choice to a Generic Alias over the anonymous Union of its declared Cases", () => {
			let type = declaredTypeOf(
				`implementation { ${stepChoice} }`,
				"Step",
			)

			expect(type.type).toBe("GenericAlias")

			let alias = type as common.GenericAliasType

			expect(alias.name).toBe("Step")
			expect(alias.generics.map((generic) => generic.name)).toEqual([
				"State",
				"Result",
			])
			expect(alias.aliasedType.type).toBe("UnionType")

			let body = alias.aliasedType as common.UnionType

			// NOTE: The body Union is anonymous so an application heals its
			// display `alias` onto it.
			expect(body.name).toBeUndefined()
			expect(body.alias).toBeUndefined()

			let done = body.types.find(
				(member): member is common.CaseType =>
					member.type === "Case" && member.name === "Done",
			)!

			// NOTE: A declared Case records the Choice's Generics and keeps its
			// members as GenericUses until a use site binds them — the interface
			// construction-side instantiation reads back.
			expect(done.choiceGenerics?.map((generic) => generic.name)).toEqual(
				["State", "Result"],
			)
			expect(done.typeArguments).toBeUndefined()
			expect(done.members.value).toEqual({
				type: "GenericUse",
				name: "Result",
			})
		})

		it("applies Type Arguments to concrete member Types carrying the applied spelling", () => {
			let type = declaredTypeOf(
				`implementation { ${stepChoice}
					type Applied = Step<Integer, String>
				}`,
				"Applied",
			)

			expect(type.type).toBe("UnionType")

			let union = type as common.UnionType

			expect(union.alias).toEqual({
				name: "Step",
				typeArguments: [{ type: "Integer" }, { type: "String" }],
			})

			let done = union.types.find(
				(member): member is common.CaseType =>
					member.type === "Case" && member.name === "Done",
			)!

			expect(done.members.value).toEqual({ type: "String" })
			expect(done.typeArguments).toEqual([
				{ type: "Integer" },
				{ type: "String" },
			])

			let cont = union.types.find(
				(member): member is common.CaseType =>
					member.type === "Case" && member.name === "Continue",
			)!

			expect(cont.members.state).toEqual({ type: "Integer" })
		})

		it("prints an applied generic Choice as written", () => {
			let type = declaredTypeOf(
				`implementation { ${stepChoice}
					type Applied = Step<Integer, String>
				}`,
				"Applied",
			)

			expect(printType(type)).toBe("Step<Integer, String>")
		})

		it("hoists a generic Choice so a use may precede its declaration", () => {
			expect(
				messagesOf(`implementation {
					type Applied = Step<Integer, String>
					${stepChoice}
				}`),
			).toEqual([])
		})

		it("resolves a prefixed unit Case of a generic Choice", () => {
			expect(
				messagesOf(`implementation {
					choice Box<T> { Full { value: T }, Empty }
					constant empty = Box#Empty
				}`),
			).toEqual([])
		})

		it("resolves a bare Case of a generic Choice through the scope scan", () => {
			expect(
				messagesOf(`implementation { ${stepChoice}
					constant applied: Step<Integer, String> = #Done({ value = "x" })
				}`),
			).toEqual([])
		})

		it("rejects a generic Choice that names itself directly in a payload", () => {
			expect(
				codesOf(`implementation {
					choice Bad<T> { A { next: Bad<T> } }
				}`),
			).toContain("recursive-generic-choice")
		})

		it("rejects a generic Choice that names itself in a nested payload position", () => {
			expect(
				codesOf(`implementation {
					choice Bad<T> { A { items: List<Bad<T>> } }
				}`),
			).toContain("recursive-generic-choice")
		})

		it("rejects too few Type Arguments to a generic Choice", () => {
			expect(
				codesOf(`implementation { ${stepChoice}
					type One = Step<Integer>
				}`),
			).toContain("wrong-type-argument-count")
		})

		it("rejects a bare generic Choice used without Type Arguments", () => {
			expect(
				codesOf(`implementation { ${stepChoice}
					type Zero = Step
				}`),
			).toContain("wrong-type-argument-count")
		})

		// NOTE: The `combinationTypeOf` TODO (resolvers.ts) is about applied
		// Types in `{ … with … }`. An applied Generic Alias of a Record already
		// resolves to a plain Record at annotation time, so the update reads its
		// members straight off — the TODO's remaining work is applied *non*-alias
		// Types, and this case must keep passing meanwhile.
		it("updates a value annotated with an applied generic Alias of a Record", () => {
			expect(
				messagesOf(`implementation {
					type Boxed<T> = { value: T }
					constant b: Boxed<Integer> = { value = 1 }
					constant updated = { b with value = 2 }
					__print(updated.value::toString())
				}`),
			).toEqual([])
		})
	})

	describe("Validator", () => {
		it("reports unhandled Cases by name", () => {
			expect(
				messagesOf(`implementation { ${calculatorChoice}
					constant operation: CalculatorOperation = CalculatorOperation#ClearAll

					match operation -> Nothing {
						case #Add { <- nothing }
						case #ClearAll { <- nothing }
					}
				}`),
			).toContain("This Match Expression does not handle every Case")
		})

		it("treats a Union containing a Choice as the Union of its Cases", () => {
			expect(
				messagesOf(`implementation { ${calculatorChoice}
					constant operation: CalculatorOperation | Nothing = nothing

					match operation -> Nothing {
						case #Add { <- nothing }
						case #Negate { <- nothing }
						case #ClearAll { <- nothing }
						case Nothing { <- nothing }
					}
				}`),
			).toEqual([])
		})

		it("warns about Cases of a foreign Choice", () => {
			let diagnostics = diagnosticsOf(`implementation {
				choice A { Go }
				choice B { Wait }

				constant command: A = A#Go

				match command -> Nothing {
					case #Go { <- nothing }
					case B#Wait { <- nothing }
				}
			}`)

			expect(
				diagnostics.map((diagnostic) => diagnostic.message),
			).toContain("This Case can never match")
		})

		it("requires a payload for payload-carrying Cases", () => {
			expect(
				messagesOf(`implementation { ${calculatorChoice}
					constant operation = CalculatorOperation#Add
				}`),
			).toContain("Case '#Add' requires a payload")
		})

		it("rejects a payload on a unit Case", () => {
			expect(
				messagesOf(`implementation { ${calculatorChoice}
					constant operation = CalculatorOperation#ClearAll({ left = 1 })
				}`),
			).toContain("Case '#ClearAll' does not carry a payload")
		})

		it("rejects a payload of the wrong shape", () => {
			expect(
				messagesOf(`implementation { ${calculatorChoice}
					constant operation = CalculatorOperation#Add({ left = 1 })
				}`),
			).toContain("This payload does not fit Case '#Add'")
		})
	})

	describe("Bare Case Expressions", () => {
		it("resolves a bare Case against the Choices in scope", () => {
			expect(
				messagesOf(`implementation { ${calculatorChoice}
					constant operation: CalculatorOperation = #Add({ left = 1, right = 1 })
					constant cleared: CalculatorOperation = #ClearAll
				}`),
			).toEqual([])
		})

		it("reports a bare Case no Choice in scope declares", () => {
			expect(
				messagesOf(`implementation { ${calculatorChoice}
					constant operation = #Modulo({ left = 1 })
				}`),
			).toContain("No Choice in scope declares a Case '#Modulo'")
		})

		it("asks for the prefix when two Choices in scope share the Case name", () => {
			expect(
				messagesOf(`implementation {
					choice A { Go { speed: Integer }, Stop }
					choice B { Go { speed: Integer }, Wait }

					constant command = #Go({ speed = 1 })
				}`),
			).toContain("Case '#Go' is declared by more than one Choice")
		})

		it("resolves bare Ordering Cases", () => {
			expect(
				messagesOf(`implementation {
					constant smaller: Ordering = #Less

					__print(smaller::is(1::compareTo(2)))
				}`),
			).toEqual([])
		})
	})

	describe("Contextual Case Resolution", () => {
		// NOTE: `A` and `B` deliberately share the Case name `Go` — the scope
		// scan alone can not resolve it, so these only pass when the expected
		// Type of the position is consulted first, like a Matcher consults
		// the scrutinee.
		const sharedCaseChoices = `
			choice A { Go { speed: Integer }, Stop }
			choice B { Go { speed: Integer }, Wait }
		`

		it("resolves a shared bare Case through a Declaration's annotation", () => {
			expect(
				messagesOf(`implementation { ${sharedCaseChoices}
					constant command: A = #Go({ speed = 1 })
				}`),
			).toEqual([])
		})

		it("resolves a shared bare Case through an Assignment's target", () => {
			expect(
				messagesOf(`implementation { ${sharedCaseChoices}
					variable command: A = A#Stop
					command = #Go({ speed = 1 })
				}`),
			).toEqual([])
		})

		it("resolves a shared bare Case through a Function's declared return Type", () => {
			expect(
				messagesOf(`implementation { ${sharedCaseChoices}
					function go() -> A {
						<- #Go({ speed = 1 })
					}
				}`),
			).toEqual([])
		})

		it("resolves a shared bare Case through a Match's declared return Type", () => {
			expect(
				messagesOf(`implementation { ${sharedCaseChoices}
					constant command: A = A#Stop

					constant next: A = match command -> A {
						case #Stop { <- #Go({ speed = 1 }) }
						case _ { <- @ }
					}
				}`),
			).toEqual([])
		})

		it("still reports ambiguity when the expected Type itself declares the Case twice", () => {
			expect(
				messagesOf(`implementation { ${sharedCaseChoices}
					constant command: A | B = #Go({ speed = 1 })
				}`),
			).toContain("Case '#Go' is declared by more than one Choice")
		})

		it("falls back to the scope scan when the expected Type has no such Case", () => {
			let messages = messagesOf(`implementation {
				choice OnlyGo { Go }

				constant command: Integer = #Go
			}`)

			expect(messages).toContain(
				"This value does not fit the declared Type of Constant 'command'",
			)
			expect(messages).not.toContain(
				"No Choice in scope declares a Case '#Go'",
			)
		})
	})

	describe("Ordering as a Choice", () => {
		it("constructs and matches Ordering Cases like any other Choice", () => {
			expect(
				messagesOf(`implementation {
					__print(match 1::compareTo(2) -> String {
						case #Less { <- "smaller" }
						case #Equal { <- "same" }
						case #Greater { <- "bigger" }
					})

					__print(Ordering#Less::is(1::compareTo(2)))
				}`),
			).toEqual([])
		})

		it("no longer exposes the Cases as Namespace properties", () => {
			expect(
				messagesOf(`implementation {
					constant smaller = Ordering.less
				}`),
			).toContain("Namespace 'Ordering' has no member 'less'")
		})

		it("no longer declares the Cases as standalone Types", () => {
			expect(
				messagesOf(`implementation {
					constant smaller: Less = Ordering#Less
				}`),
			).toContain("Type 'Less' is not declared")
		})
	})

	// NOTE: Every Choice is Equatable without anyone writing it — a Case is
	// decided by its tag and its payload is a Record, which the language
	// already compares. These cover the four things that has to mean: the
	// Methods resolve, the conformance solves, a written Namespace still wins,
	// and a Type that is not a Choice derives nothing.
	describe("Derived Equality", () => {
		const colourChoice = `
			choice Colour {
				Red,
				Green,
			}
		`

		it("answers 'is' and 'isNot' with no Namespace in sight", () => {
			expect(
				messagesOf(`implementation { ${colourChoice}
					constant red: Colour = #Red
					constant green: Colour = #Green

					__print(red::is(green))
					__print(red::isNot(green))
				}`),
			).toEqual([])
		})

		it("answers for a receiver narrowed to a single Case", () => {
			expect(
				messagesOf(`implementation { ${colourChoice}
					constant red: Colour = #Red

					__print(match red -> Boolean {
						case #Red { <- @::is(#Green) }
						case _ { <- false }
					})
				}`),
			).toEqual([])
		})

		it("satisfies an Equatable bound, so a List of Choices compares", () => {
			expect(
				messagesOf(`implementation { ${colourChoice}
					constant red: Colour = #Red

					__print([red]::contains(#Green))
					__print([red]::is([red]))
				}`),
			).toEqual([])
		})

		it("compares payload Cases by tag and then by payload", () => {
			expect(
				messagesOf(`implementation { ${calculatorChoice}
					constant one: CalculatorOperation = #Add({ left = 1, right = 1 })
					constant two: CalculatorOperation = #Negate({ number = 1 })

					__print(one::is(two))
				}`),
			).toEqual([])
		})

		it("accepts a declared 'is Equatable' that writes neither Method", () => {
			expect(
				messagesOf(`implementation { ${colourChoice}
					namespace Colour for Colour is Equatable { }

					constant red: Colour = #Red

					__print(red::is(#Green))
				}`),
			).toEqual([])
		})

		it("derives nothing for a Union that is not a Choice", () => {
			expect(
				messagesOf(`implementation {
					constant value: Integer | Boolean = 5

					__print(value::is(5))
				}`),
			).not.toEqual([])
		})
	})

	describe("Code Generation", () => {
		it("emits the runtime helper for a derived 'is'", () => {
			let generated = generate(`implementation {
				choice Colour { Red, Green }

				constant red: Colour = #Red

				__print(red::is(#Green))
				__print(red::isNot(#Green))
			}`)

			expect(generated).toContain("$helpers.choiceIs(")
			expect(generated).toContain("$helpers.choiceIsNot(")
		})

		// NOTE: A written Namespace is not merely PREFERRED over the derive at
		// the call — the WITNESS has to be the written Method too, or a bounded
		// Method would compare by tag while a direct call compared the
		// Namespace's way, and the same two values would be both equal and not.
		// Both spellings are asserted for exactly that reason.
		//
		// NOTE: Asserted by what the Colour call sites emit rather than by the
		// absence of `choiceIs` anywhere: the standard library's own Choices
		// derive their equality now, so an inlined `List.contains` drags
		// `Ordering`'s derived `is` into this Program no matter what Colour does.
		it("emits the written Method at the call AND in the witness", () => {
			let generated = generate(`implementation {
				choice Colour { Red, Green }

				namespace Colour for Colour is Equatable {
					§§ Every Colour is the same Colour.
					§§
					§§ @param other the Colour to compare with
					§§ @returns always true.
					is(_ other: Colour) -> Boolean {
						<- true
					}

					§§ The negation.
					§§
					§§ @param other the Colour to compare with
					§§ @returns always false.
					isNot(_ other: Colour) -> Boolean {
						<- @::is(other)::negate()
					}
				}

				constant red: Colour = #Red

				__print(red::is(#Green))
				__print([red]::contains(#Green))
			}`)

			expect(generated).toContain("Colour.is(red,")
			expect(generated).toContain("is: Colour.is")
			expect(generated).toContain("isNot: Colour.isNot")
		})

		it("emits tagged Case constructions", () => {
			let generated = generate(`implementation { ${calculatorChoice}
				constant operation: CalculatorOperation = CalculatorOperation#Add({ left = 1, right = 1 })
				constant cleared: CalculatorOperation = CalculatorOperation#ClearAll
			}`)

			expect(generated).toContain(
				'$type.createCase("CalculatorOperation#Add", Record.createRecord',
			)
			expect(generated).toContain(
				'$type.createCase("CalculatorOperation#ClearAll")',
			)
		})

		it("emits nominal Case Matchers", () => {
			let generated = generate(`implementation { ${calculatorChoice}
				constant operation: CalculatorOperation = CalculatorOperation#ClearAll

				__print(match operation -> Integer {
					case #Add { <- @.left }
					case _ { <- 0 }
				})
			}`)

			expect(generated).toContain('type: "Case"')
			expect(generated).toContain('choice: "CalculatorOperation"')
			expect(generated).toContain('name: "Add"')
		})

		it("erases the Choice Declaration itself", () => {
			let generated = generate(`implementation {
				choice Simple { Go }
			}`)

			expect(generated).not.toContain("Simple")
		})
	})
})
