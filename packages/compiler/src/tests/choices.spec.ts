import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { fixturePath } from "@essence-lang/fixtures"
import type { common, parser } from "@essence-lang/interfaces"
import { readStdlibFiles } from "@essence-lang/standard-library"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { loadStdlibFrom, parseStdlibSource } from "../enricher/stdlib"
import {
	defaultOptimiserOptions,
	optimise,
	type OptimiserOptions,
} from "../optimiser/index"
import { parse, parseWithDiagnostics } from "../parser/index"
import { printType } from "../printType"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"
import { codesOfSource, compiles } from "./followedHelps"

// The full pipeline minus bundling, since a Choice works only once every stage
// agrees on it. The Options are a Parameter so a spec can turn off
// `lower-unit-case-equality` and see the Rewriter's own derived equality.
function generate(
	source: string,
	optimiserOptions: OptimiserOptions = defaultOptimiserOptions,
): string {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return rewrite(optimise(simplify(enriched.program), optimiserOptions))
}

const withoutLoweredUnitCaseEquality: OptimiserOptions = {
	enabled: true,
	disabledPasses: new Set(["lower-unit-case-equality"]),
}

const withoutCompiledTypeTests: OptimiserOptions = {
	enabled: true,
	disabledPasses: new Set(["compile-type-tests"]),
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

function helpsOf(source: string): Array<string> {
	return diagnosticsOf(source).flatMap((diagnostic) => diagnostic.helps)
}

function notesOf(source: string): Array<string> {
	return diagnosticsOf(source).flatMap((diagnostic) => diagnostic.notes)
}

// The Label messages, which name the Type Parameters an undecided
// construction is missing.
function labelsOf(source: string): Array<string> {
	return diagnosticsOf(source).flatMap((diagnostic) =>
		diagnostic.labels.map((label) => label.message),
	)
}

// Runs the emitted Program and captures what `Terminal.inspect` prints.
async function run(source: string): Promise<Array<string>> {
	let js = generate(source)
	let directory = mkdtempSync(join(tmpdir(), "essence-choice-"))
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

function messagesOf(source: string): Array<string> {
	return diagnosticsOf(source).map((diagnostic) => diagnostic.message)
}

function codesOf(source: string): Array<string> {
	return diagnosticsOf(source).map((diagnostic) => diagnostic.code)
}

// The declared Type of a named Type Alias or Choice, read without
// constructing a value.
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

// The Type of a Constant's value, where a constructed Case carries the
// members and Type Arguments its construction inferred.
function valueTypeOf(source: string, name: string): common.Type {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let node = enrich(parsed.program).program.implementation.nodes.find(
		(candidate) =>
			candidate.nodeType === "ConstantDeclarationStatement" &&
			candidate.name.content === name,
	) as common.typed.ConstantDeclarationStatementNode | undefined

	if (node === undefined) {
		throw new Error(`No Constant named '${name}'`)
	}

	return node.value.type
}

const progressChoice = `
	choice Progress<State, Result> {
		Going { state: State },
		Stopped { value: Result },
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

		it("parses a payload default written after the payload shape", () => {
			let program = parse(`implementation {
				choice Fetch {
					Get { url: String, retries: Integer } = { retries = 0 },
					Head,
				}
			}`)
			let choice = program.implementation
				.nodes[0] as parser.ChoiceDeclarationStatementNode

			expect(choice.cases[0].defaultValue?.nodeType).toBe("RecordValue")
			expect(
				Object.keys(
					(choice.cases[0].defaultValue as parser.RecordValueNode)
						.members,
				),
			).toEqual(["retries"])
			expect(choice.cases[1].defaultValue).toBeNull()
		})

		it("parses a payload default that is not a Record literal", () => {
			let program = parse(`implementation {
				choice Fetch {
					Get { url: String } = blank,
				}
			}`)
			let choice = program.implementation
				.nodes[0] as parser.ChoiceDeclarationStatementNode

			expect(choice.cases[0].defaultValue?.nodeType).toBe("Identifier")
		})

		it("refuses a default on a Case that carries no payload", () => {
			expect(
				codesOf(`implementation {
					choice Direction {
						Up = { degrees = 0 },
						Down,
					}
				}`),
			).toContain("case-default-without-payload")
		})

		it("compiles either way the payload-less default's Help is followed", () => {
			expect(
				helpsOf(`implementation {
					choice Direction {
						Up = { degrees = 0 },
						Down,
					}
				}`),
			).toEqual(["Give '#Up' a payload shape, or write it on its own."])

			for (let up of [
				"Up { degrees: Integer } = { degrees = 0 }",
				"Up",
			]) {
				expect(
					compiles(`implementation {
					choice Direction {
						${up},
						Down,
					}
				}`),
				).toBe(true)
			}
		})

		it("keeps reading the Case list after refusing a payload-less default", () => {
			let { program } = parseWithDiagnostics(`implementation {
				choice Direction {
					Up = { degrees = 0 },
					Down,
				}
			}`)
			let choice = program.implementation
				.nodes[0] as parser.ChoiceDeclarationStatementNode

			expect(choice.cases.map((entry) => entry.name.content)).toEqual([
				"Up",
				"Down",
			])
			expect(choice.cases[0].defaultValue).toBeNull()
		})

		it("parses a Choice Declaration with a Generic clause", () => {
			let program = parse(`implementation {
				choice Progress<State, Result> {
					Going { state: State },
					Stopped { value: Result },
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
				"Going",
				"Stopped",
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
				match operation -> {} {
					case #Add { <- {} }
					case CalculatorOperation#ClearAll { <- {} }
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

		it("parses a payload binding on bare and prefixed Case Matchers", () => {
			let program = parse(`implementation {
				match operation -> {} {
					case #Add(pair) { <- {} }
					case CalculatorOperation#ClearAll { <- {} }
					case Wrapper#Held(item) { <- {} }
				}
			}`)
			let match = program.implementation.nodes[0] as parser.MatchNode
			let [bare, unit, prefixed] = match.handlers.map(
				(handler) => handler.matcher as parser.CaseMatcherNode,
			)

			expect((bare!.binding as parser.IdentifierNode).content).toBe(
				"pair",
			)
			// The Matcher's Position reaches the closing paren, so an editor greys
			// out a dead Handler's binding too.
			expect(bare!.position.end.column).toBeGreaterThan(
				bare!.caseName.position.end.column,
			)

			expect(unit!.binding).toBeNull()

			expect(prefixed!.choice?.content).toBe("Wrapper")
			expect((prefixed!.binding as parser.IdentifierNode).content).toBe(
				"item",
			)
		})

		it("keeps 'choice' usable as an Identifier", () => {
			let { diagnostics } = parseWithDiagnostics(`implementation {
				variable choice = 1
				choice = 2
				Terminal.inspect(choice)
			}`)

			expect(containsErrors(diagnostics)).toBe(false)
		})

		it("parses a generic clause on a Choice", () => {
			let program = parse(`implementation { ${progressChoice} }`)
			let choice = program.implementation
				.nodes[0] as parser.ChoiceDeclarationStatementNode

			expect(
				choice.generics.map((generic) => generic.name.content),
			).toEqual(["State", "Result"])
			expect(choice.cases.map((c) => c.name.content)).toEqual([
				"Going",
				"Stopped",
			])
		})

		it("leaves a non-generic Choice with an empty generics clause", () => {
			let program = parse(`implementation { ${calculatorChoice} }`)
			let choice = program.implementation
				.nodes[0] as parser.ChoiceDeclarationStatementNode

			expect(choice.generics).toEqual([])
		})

		// A Case payload is one value, so a trailing comma is refused where it is
		// written. The applied form is read speculatively, and a coded refusal
		// survives the rewind where a `syntax-error` would not. See "Refusals of
		// the text" in packages/compiler/src/parser/DEVELOPMENT.md.
		it("refuses a trailing comma in a Case payload where it is written", () => {
			expect(
				codesOf(`implementation {
	constant x = Optional<Integer>#Value(
		1,
	)
}`),
			).toEqual(["case-payload-is-one-value"])
			expect(
				codesOf(`implementation {
	constant x = Optional#Value(1,)
}`),
			).toEqual(["case-payload-is-one-value"])
		})
	})

	describe("Enricher", () => {
		it("accepts construction, narrowing and payload member access", () => {
			expect(
				messagesOf(`implementation { ${calculatorChoice}
					constant operation: CalculatorOperation = CalculatorOperation#Add({ left = 1, right = 1 })

					Terminal.inspect(match operation -> Integer {
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

					match operation -> {} {
						case #Modulo { <- {} }
						case _ { <- {} }
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

					match command -> {} {
						case #Go { <- {} }
						case _ { <- {} }
					}
				}`),
			).toContain("Case '#Go' is declared by more than one Choice")
		})

		it("reports unknown payload members on Lookup", () => {
			expect(
				messagesOf(`implementation { ${calculatorChoice}
					constant operation: CalculatorOperation = CalculatorOperation#Add({ left = 1, right = 1 })

					match operation -> {} {
						case #Add { Terminal.inspect(@.missing) <- {} }
						case _ { <- {} }
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
				`implementation { ${progressChoice} }`,
				"Progress",
			)

			expect(type.type).toBe("GenericAlias")

			let alias = type as common.GenericAliasType

			expect(alias.name).toBe("Progress")
			expect(alias.generics.map((generic) => generic.name)).toEqual([
				"State",
				"Result",
			])
			expect(alias.aliasedType.type).toBe("UnionType")

			let body = alias.aliasedType as common.UnionType

			// The body Union is anonymous, so an application can give it a
			// display `alias`.
			expect(body.name).toBeUndefined()
			expect(body.alias).toBeUndefined()

			let done = body.types.find(
				(member): member is common.CaseType =>
					member.type === "Case" && member.name === "Stopped",
			)!

			// A declared Case records the Choice's Generics and keeps its members
			// as GenericUses until a use site binds them.
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
				`implementation { ${progressChoice}
					type Applied = Progress<Integer, String>
				}`,
				"Applied",
			)

			expect(type.type).toBe("UnionType")

			let union = type as common.UnionType

			expect(union.alias).toEqual({
				name: "Progress",
				typeArguments: [{ type: "Integer" }, { type: "String" }],
			})

			let done = union.types.find(
				(member): member is common.CaseType =>
					member.type === "Case" && member.name === "Stopped",
			)!

			expect(done.members.value).toEqual({ type: "String" })
			expect(done.typeArguments).toEqual([
				{ type: "Integer" },
				{ type: "String" },
			])

			let cont = union.types.find(
				(member): member is common.CaseType =>
					member.type === "Case" && member.name === "Going",
			)!

			expect(cont.members.state).toEqual({ type: "Integer" })
		})

		it("prints an applied generic Choice as written", () => {
			let type = declaredTypeOf(
				`implementation { ${progressChoice}
					type Applied = Progress<Integer, String>
				}`,
				"Applied",
			)

			expect(printType(type)).toBe("Progress<Integer, String>")
		})

		it("hoists a generic Choice so a use may precede its declaration", () => {
			expect(
				messagesOf(`implementation {
					type Applied = Progress<Integer, String>
					${progressChoice}
				}`),
			).toEqual([])
		})

		it("resolves a prefixed unit Case of a generic Choice", () => {
			expect(
				messagesOf(`implementation {
					choice Box<T> { Full { value: T }, Empty }
					constant empty: Box<Integer> = Box#Empty
				}`),
			).toEqual([])
		})

		it("resolves a bare Case of a generic Choice through the scope scan", () => {
			expect(
				messagesOf(`implementation { ${progressChoice}
					constant applied: Progress<Integer, String> = #Stopped({ value = "x" })
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

		it("points a self-naming generic Choice at breaking the cycle", () => {
			expect(
				helpsOf(`implementation {
					choice Bad<T> { A { next: Bad<T> } }
				}`),
			).toEqual([
				"Recursive Type declarations are not part of the language yet — break the cycle.",
			])
		})

		// A Type Parameter may spell the Choice's own name, and then the payload
		// names the Parameter, so there is no recursion.
		it("reads a payload as the Type Parameter shadowing the Choice's name", () => {
			expect(
				messagesOf(`implementation {
					choice Bad<Bad> { A { next: Bad } }
					constant boxed: Bad<Integer> = Bad#A({ next = 1 })
				}`),
			).toEqual([])
		})

		it("rejects too few Type Arguments to a generic Choice", () => {
			expect(
				codesOf(`implementation { ${progressChoice}
					type One = Progress<Integer>
				}`),
			).toContain("wrong-type-argument-count")
		})

		it("rejects a bare generic Choice used without Type Arguments", () => {
			expect(
				codesOf(`implementation { ${progressChoice}
					type Zero = Progress
				}`),
			).toContain("wrong-type-argument-count")
		})

		// An applied Generic Alias of a Record resolves to a plain Record at the
		// annotation, so an update reads its members directly.
		it("updates a value annotated with an applied generic Alias of a Record", () => {
			expect(
				messagesOf(`implementation {
					type Boxed<T> = { value: T }
					constant b: Boxed<Integer> = { value = 1 }
					constant updated = { b with value = 2 }
					Terminal.inspect(updated.value::toString())
				}`),
			).toEqual([])
		})
	})

	// The cycle pre-pass before the hoist rounds catches a mutual pair, a
	// non-generic Choice and a Type Alias. The specs use `toEqual`, since it
	// must also report no `unknown-type` about names the Program declares.
	describe("Recursive Type Declarations", () => {
		it("names the cycle of a mutually recursive Choice pair", () => {
			let source = `implementation {
				choice Signal { Wrapped { command: Command } }
				choice Command { Wrapping { signal: Signal } }
			}`

			expect(codesOf(source)).toEqual([
				"recursive-type-declaration",
				"recursive-type-declaration",
			])

			expect(messagesOf(source)).toEqual([
				"Choice 'Signal' names itself through 'Command'",
				"Choice 'Command' names itself through 'Signal'",
			])
		})

		it("names a non-generic Choice that names itself", () => {
			let source = `implementation {
				choice Tree { Leaf, Node { child: Tree } }
			}`

			expect(codesOf(source)).toEqual(["recursive-type-declaration"])
			expect(messagesOf(source)).toEqual(["Choice 'Tree' names itself"])
		})

		it("names a Type Alias that names itself", () => {
			let source = `implementation {
				type Node = { next: Node }
			}`

			expect(codesOf(source)).toEqual(["recursive-type-declaration"])
			expect(messagesOf(source)).toEqual(["Type 'Node' names itself"])
		})

		it("names a Type Alias that names itself through a Union arm", () => {
			expect(
				messagesOf(`implementation {
					type Node = Integer | Node
				}`),
			).toEqual(["Type 'Node' names itself"])
		})

		it("names a cycle that runs through both an Alias and a Choice", () => {
			let source = `implementation {
				type Wrapper = Wrapped
				choice Wrapped { Inner { wrapper: Wrapper } }
			}`

			expect(messagesOf(source)).toEqual([
				"Type 'Wrapper' names itself through 'Wrapped'",
				"Choice 'Wrapped' names itself through 'Wrapper'",
			])
		})

		// A default Type resolves with its declaration, so a cycle through one
		// is a cycle too.
		it("names a cycle closed by a Generic's default Type", () => {
			expect(
				messagesOf(`implementation {
					type Boxed<Item = Boxed<Integer>> = { value: Item }
				}`),
			).toEqual(["Type 'Boxed' names itself"])
		})

		// A default Type resolves around the declaration, where its own
		// Parameter is not visible, so the `B` in `type B<B = B>` is the
		// declaration itself.
		it("names a cycle a Parameter's own name closes in its default Type", () => {
			expect(
				messagesOf(`implementation {
					type B<B = B> = { x: Integer }
				}`),
			).toEqual(["Type 'B' names itself"])
		})

		it("names the same cycle on a generic Choice", () => {
			expect(
				messagesOf(`implementation {
					choice B<B = B> { Full { value: Integer } }
				}`),
			).toEqual(["Choice 'B' names itself"])
		})

		it("names a mutual cycle a Parameter's name would have hidden", () => {
			expect(
				messagesOf(`implementation {
					type A<B = B> = { x: B }
					type B = { a: A }
				}`),
			).toEqual([
				"Type 'A' names itself through 'B'",
				"Type 'B' names itself through 'A'",
			])
		})

		// A default Type naming what its Parameter shadows in the body is no
		// cycle.
		it("reads a default Type as the declaration its Parameter shadows", () => {
			expect(
				messagesOf(`implementation {
					type Item = Integer
					type Boxed<Item = Item> = { value: Item }
					constant boxed: Boxed = { value = 1 }
				}`),
			).toEqual([])
		})

		it("spells the whole way round a longer cycle in a note", () => {
			expect(
				notesOf(`implementation {
					type A = B
					type B = C
					type C = A
				}`).filter((note) => note.startsWith("'A'")),
			).toEqual([
				"'A' names 'B', which names 'C', which names 'A' again.",
			])
		})

		it("leaves a generic Choice naming itself in a payload to its own code", () => {
			expect(
				codesOf(`implementation {
					choice Bad<T> { A { next: Bad<T> } }
				}`),
			).toEqual(["recursive-generic-choice"])
		})

		// Every name in a cycle stays declared as an Error, so a declaration
		// naming one is not reported.
		it("leaves declarations that merely name a cycle member alone", () => {
			expect(
				codesOf(`implementation {
					type Head = Body
					type Body = { tail: Tail }
					type Tail = { body: Body }
					type Alongside = { body: Body }
				}`),
			).toEqual([
				"recursive-type-declaration",
				"recursive-type-declaration",
			])
		})

		it("still reports a genuine unknown Type inside a cycle", () => {
			expect(
				codesOf(`implementation {
					type Left = { right: Right, nope: Nope }
					type Right = { left: Left }
				}`),
			).toEqual([
				"recursive-type-declaration",
				"recursive-type-declaration",
				"unknown-type",
			])
		})

		it("resolves a name a cycle member only reaches after the rounds", () => {
			expect(
				codesOf(`implementation {
					type Left = { right: Right, count: Counter }
					type Right = { left: Left }
					type Counter = Integer
				}`),
			).toEqual([
				"recursive-type-declaration",
				"recursive-type-declaration",
			])
		})

		// The graph resolves a Type Parameter's shadowing, so this is no cycle.
		it("does not read a Type Parameter as naming the declaration it shadows", () => {
			expect(
				messagesOf(`implementation {
					type Item = Integer
					choice Holder<Item> { Full { value: Item } }
					constant held: Holder<String> = #Full({ value = "x" })
				}`),
			).toEqual([])
		})
	})

	// `infer` marks a Type Parameter a use works out for itself. Every use of a
	// Choice or a Type Alias applies its Arguments, so the marker is refused.
	describe("'infer' on an Applied Type Parameter", () => {
		it("refuses it on a Choice", () => {
			let source = `implementation {
				choice Box<infer Value> { Full { value: Value }, Empty }
			}`

			expect(codesOf(source)).toEqual(["infer-on-applied-parameter"])
			expect(messagesOf(source)).toEqual([
				"A Choice's Type Parameters can not be inferred",
			])
		})

		it("refuses it on a bounded Choice Parameter", () => {
			expect(
				codesOf(`implementation {
					choice Box<infer Value is Equatable> {
						Full { value: Value },
						Empty,
					}
				}`),
			).toEqual(["infer-on-applied-parameter"])
		})

		it("refuses it on a generic Type Alias", () => {
			let source = `implementation {
				type Boxed<infer T> = { value: T }
			}`

			expect(codesOf(source)).toEqual(["infer-on-applied-parameter"])
			expect(messagesOf(source)).toEqual([
				"A Type Alias's Type Parameters can not be inferred",
			])
		})

		it("names the Parameter to unmark", () => {
			expect(
				helpsOf(`implementation {
					choice Pair<Left, infer Right> {
						Both { left: Left, right: Right },
					}
				}`),
			).toEqual(["Remove the 'infer' before 'Right'."])
		})

		// A Method's Generic list has the same grammar and needs the marker, so
		// the refusal is a Diagnostic, not a parse error.
		it("leaves a Method's own Type Parameters alone", async () => {
			expect(
				await run(`implementation {
					namespace Nums for Integer {
						pick<infer Target>(
							_ transform: (_ value: Integer) -> Target,
						) -> Target {
							<- transform(@)
						}
					}

					Terminal.inspect(1::pick((n) { <- n::toString() }))
				}`),
			).toEqual(['"1"'])
		})

		// `infer` is a valid Identifier, so `<infer>` declares a Generic named
		// `infer`. The Parser reads the modifier only when a name follows.
		it("leaves a Type Parameter actually named 'infer' alone", () => {
			expect(
				messagesOf(`implementation {
					type Boxed<infer> = { value: infer }
					constant b: Boxed<Integer> = { value = 1 }
				}`),
			).toEqual([])
		})
	})

	describe("Validator", () => {
		it("reports unhandled Cases by name", () => {
			expect(
				messagesOf(`implementation { ${calculatorChoice}
					constant operation: CalculatorOperation = CalculatorOperation#ClearAll

					match operation -> {} {
						case #Add { <- {} }
						case #ClearAll { <- {} }
					}
				}`),
			).toContain("This Match Expression does not handle every Case")
		})

		// A Choice in a Union contributes its Cases, so exhaustiveness needs
		// every Case plus every other member.
		it("treats a Union containing a Choice as the Union of its Cases", () => {
			expect(
				messagesOf(`implementation { ${calculatorChoice}
					constant operation: CalculatorOperation | String = "cleared"

					match operation -> {} {
						case #Add { <- {} }
						case #Negate { <- {} }
						case #ClearAll { <- {} }
						case String { <- {} }
					}
				}`),
			).toEqual([])
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

					Terminal.inspect(smaller::is(1::compare(to 2)))
				}`),
			).toEqual([])
		})

		// A bare Case's payload binds only the Type Parameters its members
		// mention. After the payload, the position and the Argument's Parameter
		// Type, whatever is still open is reported. See "Instantiating a generic
		// Case from its payload" in packages/compiler/src/enricher/DEVELOPMENT.md.
		describe("A payload-carrying bare Case nothing finishes deciding", () => {
			it("reports the Parameter the payload does not mention", () => {
				let source = `implementation { ${progressChoice}
					constant done = #Stopped({ value = "x" })
				}`

				expect(codesOf(source)).toEqual(["undecided-type-arguments"])
				expect(messagesOf(source)).toEqual([
					"Nothing decides the Type Arguments of '#Stopped(…)'",
				])
				expect(labelsOf(source)).toEqual([
					"its payload decides 'Result', and nothing decides 'State'",
				])
				expect(notesOf(source)).toEqual([
					"'Progress' takes 2 Type Parameters: 'State', 'Result'.",
					"A payload binds only the Type Parameters its own members mention — the rest are applied, at the construction or by the position around it.",
				])
				// The decided Argument is spelled out and the open one is an
				// ellipsis, since the Choice's Parameter names are out of scope here.
				expect(helpsOf(source)).toEqual([
					"Annotate the Declaration this is written into with 'Progress<…, String>', which is what decides them.",
					"Or apply the Type Arguments here — 'Progress<…, String>#Stopped(…)', with the Type you mean in place of each '…'.",
				])

				// The spelling with its blank filled in compiles, written at the
				// construction or on the Declaration.
				expect(
					compiles(`implementation { ${progressChoice}
					constant done = Progress<Integer, String>#Stopped({ value = "x" })
				}`),
				).toBe(true)
				expect(
					compiles(`implementation { ${progressChoice}
					constant done: Progress<Integer, String> = #Stopped({ value = "x" })
				}`),
				).toBe(true)
			})

			// An Argument stands in no Declaration, so no annotation there
			// decides the construction. A `define` arm passes its Declaration's
			// annotation on, so the Help stands there.
			it("offers the annotation only where a Declaration takes the value", () => {
				let holder = "choice Holder<Item> { Full { item: Item }, Bare }"

				expect(
					helpsOf(`implementation { ${holder}
					Terminal.inspect(Holder#Bare)
				}`),
				).toEqual([
					"Apply the Type Arguments here — 'Holder<…>#Bare', with the Type you mean in place of each '…'.",
				])
				expect(
					compiles(`implementation { ${holder}
					Terminal.inspect(Holder<Integer>#Bare)
				}`),
				).toBe(true)

				for (let value of [
					"Holder#Bare",
					"define { as Holder#Bare if true as Holder#Bare otherwise }",
				]) {
					expect(
						helpsOf(`implementation { ${holder}
					constant held = ${value}
				}`)[0],
					).toBe(
						"Annotate the Declaration this is written into with 'Holder<…>', which is what decides them.",
					)
					expect(
						compiles(`implementation { ${holder}
					constant held: Holder<Integer> = ${value}
				}`),
					).toBe(true)
				}
			})

			// A payload that mentions no Type Parameter decides nothing.
			it("reports one whose payload decides nothing at all", () => {
				let source = `implementation {
					choice Box<Value> { Full { value: Value }, Tag { label: String } }

					constant tagged = #Tag({ label = "x" })
				}`

				expect(codesOf(source)).toEqual(["undecided-type-arguments"])
				expect(labelsOf(source)).toEqual([
					"its payload decides none of them",
				])
			})

			// A written payload is evidence about the Types it was written with,
			// never about an enclosing Function's own `Item`, which a caller
			// decides.
			it("proves nothing about an enclosing Function's own Type Parameter", async () => {
				const box = `choice Box<Item> {
					Full { items: NonEmptyList<Item> },
					Rows { rows: List<NonEmptyList<Item>> },
					Empty,
				}`
				let wrapped = (payload: string) => `implementation { ${box}
					function wrap<infer Item>(_ x: Item) -> Box<Item> {
						<- ${payload}
					}

					constant b: Box<String> = wrap("a")
				}`

				for (let payload of [
					"#Full({ items = [1] })",
					"#Full([1])",
					"Box<Item>#Full([1])",
					"#Rows([[1]])",
				]) {
					expect([payload, codesOf(wrapped(payload))]).toEqual([
						payload,
						["payload-type-mismatch"],
					])
				}

				expect(
					await run(`implementation { ${box}
						function wrap<infer Item>(_ x: Item) -> Box<Item> {
							<- #Full({ items = [x] })
						}

						function twice<infer Item>(_ x: Item) -> Box<Item> {
							<- #Full([x, x])
						}

						Terminal.inspect(wrap("a"))
						Terminal.inspect(twice(1))
					}`),
				).toEqual(['Box#Full([ "a" ])', "Box#Full([ 1, 1 ])"])
			})

			// The rule asks only where a payload stands for the Case. A missing
			// payload is `missing-payload`, and one that does not fit is
			// `payload-type-mismatch`.
			it("leaves a payload that was never given to its own Diagnostic", () => {
				const box = `choice Box<Value> { Full { value: Value } }`

				expect(
					codesOf(`implementation { ${box}
						constant full = #Full
					}`),
				).toEqual(["missing-payload"])
				expect(
					codesOf(`implementation { ${box}
						constant full = #Full()
					}`),
				).toEqual(["missing-payload"])
			})

			it("leaves a payload that does not fit to its own Diagnostic", () => {
				const pair = `choice Pair<A, B> { Both { a: A, b: B } }`

				expect(
					codesOf(`implementation { ${pair}
						constant both = #Both({ a = 1 })
					}`),
				).toEqual(["payload-type-mismatch"])
				expect(
					codesOf(`implementation { ${pair}
						constant both = #Both({ a = 1, c = 2 })
					}`),
				).toEqual(["payload-type-mismatch"])
			})

			it("takes the decision from an annotation", () => {
				expect(
					valueTypeOf(
						`implementation { ${progressChoice}
							constant done: Progress<Integer, String> = #Stopped({ value = "x" })
						}`,
						"done",
					),
				).toEqual({
					type: "Case",
					choice: "Progress",
					name: "Stopped",
					members: { value: { type: "String" } },
					typeArguments: [{ type: "Integer" }, { type: "String" }],
				})
			})

			// A payload mentioning every Parameter needs no position, since the
			// rule asks what is left open.
			it("leaves one its payload decides entirely alone", () => {
				expect(
					valueTypeOf(
						`implementation {
							choice Box<Value> { Full { value: Value } }

							constant full = #Full(1)
						}`,
						"full",
					),
				).toEqual({
					type: "Case",
					choice: "Box",
					name: "Full",
					members: { value: { type: "Integer" } },
					typeArguments: [{ type: "Integer" }],
				})
			})
		})

		// An Argument position decides a bare construction as it decides the
		// prefixed one.
		it("decides a bare construction from the Argument position", async () => {
			let program = `implementation {
				constant steps: List<Step<Integer, Integer>> = [
					Step<Integer, Integer>#Done(2),
				]

				Terminal.inspect(steps::contains(#Done(2)))
			}`

			expect(await run(program)).toEqual(["true"])
			expect(messagesOf(program)).toEqual([])
		})

		// Whatever the Overload order. A probe reads the payload silently, so a
		// candidate that decides nothing leaves no report or Error behind.
		it("decides one from the Argument position whatever the Overload order", async () => {
			let program = `implementation {
				choice Pair<A, B> { Both { a: A, b: B }, Left { a: A }, None }

				namespace Taker for Integer {
					overload take {
						(_ text: String) -> String { <- "text" }
						(_ pair: Pair<String, String>) -> String { <- "strings" }
						(_ pair: Pair<Integer, Integer>) -> String { <- "integers" }
					}
				}

				Terminal.inspect(1::take(#Left({ a = 1 })))
				Terminal.inspect(1::take(#Left({ a = "x" })))
				Terminal.inspect(1::take("x"))
			}`

			expect(messagesOf(program)).toEqual([])
			expect(await run(program)).toEqual([
				'"integers"',
				'"strings"',
				'"text"',
			])
		})

		// A bare unit Case has no payload and no written Type Arguments, so only
		// its position decides it. Where nothing does, it is reported.
		describe("A unit Case of a generic Choice", () => {
			const box = `choice Box<Value> { Full { value: Value }, Empty }`

			// `Optional` declares `#Empty` too, so a bare `#Empty` is ambiguous
			// before anything asks what decides it. This Choice names its unit Case
			// `Blank` to reach the undecided report.
			const blankBox = `choice Box<Value> { Full { value: Value }, Blank }`

			it("reports one nothing decides", () => {
				let source = `implementation { ${blankBox}
					constant blank = #Blank
				}`

				expect(codesOf(source)).toEqual(["undecided-type-arguments"])
				expect(messagesOf(source)).toEqual([
					"Nothing decides the Type Arguments of '#Blank'",
				])
				expect(helpsOf(source)).toEqual([
					"Annotate the Declaration this is written into with 'Box<…>', which is what decides them.",
					"Or apply the Type Arguments here — 'Box<…>#Blank', with the Type you mean in place of each '…'.",
				])

				expect(
					compiles(`implementation { ${blankBox}
					constant blank = Box<Integer>#Blank
				}`),
				).toBe(true)
			})

			// Which Choice is meant is settled before its Type Arguments, so a bare
			// `#Empty` is ambiguous. A position naming `Box` settles both.
			it("reports a bare one the builtin Optional also declares", () => {
				let source = `implementation { ${box}
					constant empty = #Empty
				}`

				expect(codesOf(source)).toEqual(["ambiguous-case"])
				expect(messagesOf(source)).toEqual([
					"Case '#Empty' is declared by more than one Choice",
				])
				expect(notesOf(source)).toEqual([
					"'Optional' declares '#Empty'.",
					"'Box' declares '#Empty'.",
				])
			})

			// For a generic Choice the Help also asks for the Type Arguments, with
			// an ellipsis for each. A non-generic Choice gets the bare prefixed name.
			it("asks a generic Choice's Help for the Type Arguments too", () => {
				expect(
					helpsOf(`implementation { ${box}
						constant empty = #Empty
					}`),
				).toEqual([
					"Write 'Optional<…>#Empty' with its Type Arguments to pick 'Optional'.",
					"Write 'Box<…>#Empty' with its Type Arguments to pick 'Box'.",
				])

				expect(
					helpsOf(`implementation {
						choice Colour { Red, Blue }
						choice Shade { Red, Dark }

						constant red = #Red
					}`),
				).toEqual([
					"Write 'Colour#Red' to pick 'Colour'.",
					"Write 'Shade#Red' to pick 'Shade'.",
				])
			})

			// The `data` carries only the names, since a Quick Fix writing `<…>`
			// would not parse.
			it("carries the candidate Choices as data, generic or not", () => {
				expect(
					diagnosticsOf(`implementation { ${box}
						constant empty = #Empty
					}`)[0].data,
				).toEqual({
					kind: "choice-candidates",
					names: ["Optional", "Box"],
				})

				expect(
					diagnosticsOf(`implementation {
						choice Colour { Red, Blue }
						choice Shade { Red, Dark }

						constant red = #Red
					}`)[0].data,
				).toEqual({
					kind: "choice-candidates",
					names: ["Colour", "Shade"],
				})
			})

			it("takes the decision from an annotation", () => {
				expect(
					messagesOf(`implementation { ${box}
						constant empty: Box<Integer> = #Empty
					}`),
				).toEqual([])
			})

			it("takes the decision from the Parameter it is passed to", async () => {
				expect(
					await run(`implementation { ${box}
						function describe(_ b: Box<Integer>) -> String {
							<- match b -> String {
								case #Full { <- "full" }
								case #Empty { <- "empty" }
							}
						}

						Terminal.inspect(describe(#Empty))
					}`),
				).toEqual(['"empty"'])
			})

			// It is matched after the Argument that decides the Parameter, as the
			// prefixed form is.
			it("waits for an Argument that decides the Parameter", async () => {
				expect(
					await run(`implementation { ${box}
						function orElse<infer Value is Equatable>(
							_ b: Box<Value>,
							_ fallback: Value,
						) -> Value {
							<- match b -> Value {
								case #Full { <- @.value }
								case #Empty { <- fallback }
							}
						}

						Terminal.inspect(orElse(#Empty, 7)::toString())
					}`),
				).toEqual(['"7"'])
			})

			// The Type Parameters there are blanks, so a payload is still asked
			// for each member its Case declares.
			it("still asks a payload for its members where nothing decides it", () => {
				expect(
					codesOfSource(`implementation {
						choice Pairing<Item> { Both { left: Item, right: Item }, Neither }

						constant misspelt = sumBy(Pairing#Both({ lft = 1, right = 2 }))
						constant written = sumBy(Pairing#Both({ left = 1, right = 2 }))
					}`),
				).toEqual([
					"unknown-name",
					"payload-type-mismatch",
					"unknown-name",
				])
			})

			// A call that resolved to nothing names no Parameter to decide a
			// construction, and its own refusal is the mistake. A Case no Choice
			// declares is still one of its own.
			it("reports only the call around one it would have decided", () => {
				let source = `implementation { ${blankBox}
					constant valued = sumBy(#Value(1))
					constant emptied = [1]::sumBy(#Empty)
					constant blanked = sumBy(#Blank)
					constant prefixed = sumBy(Box#Blank)
					constant filled = sumBy(Box#Full(1))
					constant unknown = sumBy(#Red)
				}`

				expect(
					diagnosticsOf(source).map((diagnostic) => [
						diagnostic.code,
						diagnostic.position?.start.line,
					]),
				).toEqual([
					["unknown-name", 2],
					["unknown-method", 3],
					["unknown-name", 4],
					["unknown-name", 5],
					["unknown-name", 6],
					["unknown-name", 7],
					["unknown-case", 7],
				])
			})

			// A lone signature leaves its mismatch to the validator, even where a
			// bound makes the call answer an Error. So its Arguments still report.
			it("reports one a bounded lone signature that took nothing decides", () => {
				let source = `implementation { ${blankBox}
					function count<infer Item is Printable>(
						_ items: List<Item>,
						_ box: Box<Item>,
					) -> Integer {
						<- items::length()
					}

					Terminal.inspect(count(5, #Blank))
				}`

				expect(codesOf(source)).toEqual(["undecided-type-arguments"])
			})

			// Through a generic Alias, the Alias's own Type Parameters are the
			// blanks, so the payload is asked for its members all the same.
			it("decides no construction a generic Alias prefixes there", () => {
				expect(
					codesOfSource(`implementation { ${blankBox}
						choice Pairing<Item> { Both { left: Item, right: Item }, Neither }
						type Crate<Item> = Box<Item>
						type Twin<Item> = Pairing<Item>

						constant crated = sumBy(Crate#Full(1))
						constant misspelt = sumBy(Twin#Both({ lft = 1, right = 2 }))
					}`),
				).toEqual([
					"unknown-name",
					"unknown-name",
					"payload-type-mismatch",
				])
			})
		})
	})

	// `case Choice#Case` names which Choice is meant. A Case the matched value
	// cannot be is an error, as it is for the bare form.
	describe("Prefixed Case Matchers", () => {
		it("rejects a Case of a foreign Choice", () => {
			expect(
				diagnosticsOf(`implementation {
					choice A { Go }
					choice B { Wait }

					constant command: A = A#Go

					match command -> {} {
						case #Go { <- {} }
						case B#Wait { <- {} }
					}
				}`).map((diagnostic) => [diagnostic.code, diagnostic.message]),
			).toEqual([
				["unknown-case", "The matched value has no Case 'B#Wait'"],
			])
		})

		// A Quick Fix replaces only the name, so the near miss is sought among
		// this Choice's Cases in the matched Union.
		it("suggests a Case of this Choice the matched value still has", () => {
			let [diagnostic] = diagnosticsOf(`implementation {
					choice Stride { Walk, Walks }

					constant taken: Stride = Stride#Walk

					match taken -> {} {
						case Stride#Walk { <- {} }
						case _ {
							match @ -> {} {
								case Stride#Walk { <- {} }
								case _ { <- {} }
							}
						}
					}
				}`)

			expect(diagnostic.code).toBe("unknown-case")
			expect(diagnostic.helps).toEqual(["Did you mean '#Walks'?"])
			expect(diagnostic.data).toEqual({
				kind: "suggestion",
				suggestion: "Walks",
			})
		})

		// Where the prefix is wrong, no rewrite of the name helps, so nothing is
		// suggested.
		it("suggests nothing where the prefix names another Choice", () => {
			let [diagnostic] = diagnosticsOf(`implementation {
					choice A { Wait, Go }
					choice B { Wait, Stop }

					constant command: A = A#Wait

					match command -> {} {
						case B#Wait { <- {} }
						case _ { <- {} }
					}
				}`)

			expect(diagnostic.code).toBe("unknown-case")
			expect(diagnostic.helps).toEqual([])
			expect(diagnostic.data).toBeUndefined()
		})

		it("rejects a bounded Choice's Case the matched value can not be", () => {
			expect(
				codesOf(`implementation {
					choice Box<T is Equatable> { Full { value: T }, Empty }
					choice Other { Thing { name: String } }

					constant other: Other = #Thing({ name = "x" })

					Terminal.inspect(match other -> Boolean {
						case Box#Full { <- @.value::is(@.value) }
						case #Thing { <- true }
					})
				}`),
			).toEqual(["unknown-case"])
		})

		it("stays silent about a Matcher on a scrutinee that is already broken", () => {
			expect(
				codesOf(`implementation {
					choice A { Go }
					choice B { Wait }

					match undeclared -> {} {
						case B#Wait { <- {} }
					}
				}`),
			).toEqual(["unknown-name"])
		})

		it("still narrows a Case the matched value does have", async () => {
			expect(
				await run(`implementation {
					choice Walk<Result> { Done { value: Result }, Going }

					constant walk: Walk<Integer> = #Done({ value = 3 })

					Terminal.inspect(match walk -> String {
						case Walk#Done { <- @.value::toString() }
						case #Going { <- "going" }
					})
				}`),
			).toEqual(['"3"'])
		})
	})

	// Every instantiation of a Case shares its runtime tag, so no Matcher or
	// dispatch branch can tell `Box<Integer>#Full` from `Box<String>#Full` by tag.
	// A Matcher is typed by what every instantiation carries.
	describe("Cases of Several Instantiations", () => {
		const box = `choice Box<Value> {
			Full { value: Value },
			Empty,
		}`

		const describeBox = (
			fullMatcher: string,
			emptyMatcher: string,
		) => `implementation { ${box}
			function describe(_ boxed: Box<Integer> | Box<String>) -> String {
				<- match boxed -> String {
					case ${fullMatcher} {
						<- match @.value -> String {
							case Integer { <- @::toString() }
							case String { <- @ }
						}
					}
					case ${emptyMatcher} { <- "empty" }
				}
			}

			constant text: Box<Integer> | Box<String> = Box#Full("hello")
			constant number: Box<Integer> | Box<String> = Box#Full(5)
			constant nothingInside: Box<Integer> | Box<String> = Box#Empty

			Terminal.inspect(describe(text))
			Terminal.inspect(describe(number))
			Terminal.inspect(describe(nothingInside))
		}`

		it("narrows the payload to what every instantiation carries", () => {
			expect(
				messagesOf(`implementation { ${box}
					constant boxed: Box<Integer> | Box<String> = Box#Full("hello")

					Terminal.inspect(match boxed -> Integer {
						case Box#Full { <- @.value::add(1) }
						case Box#Empty { <- 0 }
					})
				}`),
			).toEqual(["No Method named 'add' for String"])
		})

		it("routes every instantiation through the one Matcher", async () => {
			expect(await run(describeBox("Box#Full", "Box#Empty"))).toEqual([
				'"hello"',
				'"5"',
				'"empty"',
			])
		})

		// A written payload is evidence for a refined Type Argument, both where
		// it chooses among instantiations and where an Argument's Parameter
		// decides one.
		it("lets a written payload prove the instantiation it stands in", async () => {
			let source = (value: string) => `implementation { ${box}
				function take(_ boxed: Box<PositiveInteger>) -> String {
					<- "positive"
				}

				constant boxed: Box<String> | Box<PositiveInteger> = Box#Full(${value})
				constant record: Box<String> | Box<PositiveInteger> = Box#Full({ value = ${value} })

				Terminal.inspect(take(#Full(${value})))
				Terminal.inspect([boxed, record])
			}`

			expect(await run(source("3"))).toEqual([
				'"positive"',
				"[ Box#Full(3), Box#Full(3) ]",
			])
			expect(codesOf(source("0"))).toEqual([
				"payload-type-mismatch",
				"payload-type-mismatch",
				"argument-type-mismatch",
			])
		})

		// Instantiations of one Choice are no ambiguity, since a prefix could
		// not tell them apart either.
		it("takes a bare Matcher for the instantiations of one Choice", async () => {
			expect(await run(describeBox("#Full", "#Empty"))).toEqual([
				'"hello"',
				'"5"',
				'"empty"',
			])
		})

		it("still reports a bare Matcher two Choices declare", () => {
			expect(
				codesOf(`implementation { ${box}
					choice Crate { Full { weight: Integer } }

					constant thing: Box<Integer> | Crate = Crate#Full({ weight = 2 })

					Terminal.inspect(match thing -> String {
						case #Full { <- "full" }
						case #Empty { <- "empty" }
					})
				}`),
			).toContain("ambiguous-case")
		})

		// A Case Matcher covers every instantiation and takes no Type Arguments,
		// so each Choice gets one Help, and is counted once.
		it("offers a bare Matcher one Help per Choice", () => {
			let source = `implementation { ${box}
				choice Crate { Full { weight: Integer } }

				constant thing: Box<Integer> | Box<String> | Crate = Crate#Full({ weight = 2 })

				Terminal.inspect(match thing -> String {
					case #Full { <- "full" }
					case _ { <- "other" }
				})
			}`

			expect(helpsOf(source)).toEqual([
				"Write 'Box#Full' to pick 'Box'.",
				"Write 'Crate#Full' to pick 'Crate'.",
			])
			expect(labelsOf(source)).toEqual([
				"2 Choices in the matched Union declare it",
			])
			expect(notesOf(source)).toEqual([
				"'Box' declares '#Full'.",
				"'Crate' declares '#Full'.",
			])
		})

		// A construction can write the Type Arguments, and they are what tells
		// the candidates apart.
		it("names each instantiation a bare construction could mean", () => {
			let source = `implementation { ${box}
				constant boxed: Box<Integer> | Box<String> = #Full("hello")
			}`

			expect(helpsOf(source)).toEqual([
				"Write 'Box<Integer>#Full' to pick 'Box<Integer>'.",
				"Write 'Box<String>#Full' to pick 'Box<String>'.",
			])
			expect(diagnosticsOf(source)[0]?.data).toEqual({
				kind: "choice-candidates",
				names: ["Box<Integer>", "Box<String>"],
			})
		})

		// One Choice declares the Case once, however often the Type applies it.
		it("speaks of applications where one Choice is applied twice", () => {
			let source = `implementation { ${box}
				constant boxed: Box<Integer> | Box<String> = #Full("hello")
			}`

			expect(messagesOf(source)).toEqual([
				"Case '#Full' fits more than one application of 'Box'",
			])
			expect(labelsOf(source)).toEqual([
				"2 applications of 'Box' in the expected Type have it",
			])
			expect(notesOf(source)).toEqual(["'Box' declares '#Full'."])
		})

		it("builds the construction the Help writes", async () => {
			expect(
				await run(`implementation { ${box}
					constant boxed: Box<Integer> | Box<String> = Box<String>#Full("hello")

					Terminal.inspect(boxed)
				}`),
			).toEqual(['Box#Full("hello")'])
		})

		// A Choice with one candidate is told apart by its name alone, and the
		// position decides its Type Arguments.
		it("spells Type Arguments only where they tell candidates apart", async () => {
			expect(
				helpsOf(`implementation { ${box}
					constant thing: Box<Integer> | Box<String> | Optional<Integer> = #Empty
				}`),
			).toEqual([
				"Write 'Box<Integer>#Empty' to pick 'Box<Integer>'.",
				"Write 'Box<String>#Empty' to pick 'Box<String>'.",
				"Write 'Optional#Empty' to pick 'Optional'.",
			])
			expect(
				await run(`implementation { ${box}
					constant thing: Box<Integer> | Box<String> | Optional<Integer> = Optional#Empty

					Terminal.inspect(thing)
				}`),
			).toEqual(["Optional#Empty"])
		})

		it("picks each instantiation's own dispatch branch", async () => {
			expect(
				await run(`implementation {
					choice Box<Value> {
						Full { value: Value },
					}

					namespace IntegerBox for Box<Integer> {
						describe() -> String {
							<- match @ -> String {
								case #Full { <- "Integer box" }
							}
						}
					}

					namespace StringBox for Box<String> {
						describe() -> String {
							<- match @ -> String {
								case #Full { <- "String box" }
							}
						}
					}

					constant text: Box<Integer> | Box<String> = Box#Full("hello")
					constant number: Box<Integer> | Box<String> = Box#Full(5)

					Terminal.inspect(text::describe())
					Terminal.inspect(number::describe())
				}`),
			).toEqual(['"String box"', '"Integer box"'])
		})
	})

	// The application must keep a bound on a Choice's Type Parameter, since
	// nothing downstream asks again.
	describe("Bounded Generic Choices", () => {
		const boundedBox = `choice Box<T is Equatable> {
			Full { value: T },
			Empty,
		}`

		// `Optional` declares `#Empty` too, so this Choice's unit Case is named
		// `Blank` to reach the undecided report.
		const blankBox = `choice Box<T is Equatable> {
			Full { value: T },
			Blank,
		}`

		it("rejects an annotation whose Type Argument does not conform", () => {
			let source = `implementation { ${boundedBox}
				constant b: Box<(_ x: Integer) -> Integer> = #Empty
			}`

			expect(codesOf(source)).toEqual(["unsatisfied-bound"])
			expect(messagesOf(source)).toEqual([
				"(_: Integer) -> Integer does not conform to 'Equatable'",
			])
		})

		it("tells an unbounded Type Parameter what to declare", () => {
			let source = `implementation { ${boundedBox}
				function wrap<infer Value>(_ value: Value) -> Box<Value> {
					<- #Full({ value = value })
				}
			}`

			expect(codesOf(source)).toEqual(["unsatisfied-bound"])
			expect(helpsOf(source)).toEqual([
				"Declare it as '<infer Value is Equatable>'.",
			])
		})

		// The Quick Fix edits the declaration while the Diagnostic stands at the
		// use, so the data names the Parameter.
		it("carries that Parameter and Protocol as data", () => {
			expect(
				diagnosticsOf(`implementation { ${boundedBox}
					function wrap<infer Value>(_ value: Value) -> Box<Value> {
						<- #Full({ value = value })
					}
				}`)[0].data,
			).toEqual({
				kind: "required-protocol",
				protocol: "Equatable",
				parameter: "Value",
			})
		})

		// A concrete Type needs a Namespace declaring the conformance, which is
		// no edit to a span, so no Parameter is named.
		it("names no Parameter for a concrete Type that does not conform", () => {
			expect(
				diagnosticsOf(`implementation { ${boundedBox}
					constant b: Box<(_ x: Integer) -> Integer> = #Empty
				}`)[0].data,
			).toEqual({
				kind: "required-protocol",
				protocol: "Equatable",
				parameter: null,
			})
		})

		// The annotation's Type Argument answers for the bound, since a prefixed
		// construction's payload decides nothing.
		it("rejects a construction whose Type Argument does not conform", () => {
			expect(
				codesOf(`implementation { ${boundedBox}
					constant b: Box<(_ x: Integer) -> Integer> =
						Box#Full({ value = (_ x: Integer) -> Integer { <- x } })
				}`),
			).toEqual(["unsatisfied-bound"])
		})

		// A bare Case's payload can decide a Type Argument, so it answers for
		// the bound. A payload mentioning no Generic decides nothing and is asked
		// nothing.
		it("holds a bare construction's payload to the bound it decides", () => {
			expect(
				codesOf(`implementation { ${boundedBox}
					constant b = #Full({ value = (_ x: Integer) -> Integer { <- x } })
				}`),
			).toEqual(["unsatisfied-bound"])
		})

		// A bare unit Case that nothing decides is undecided, not free.
		it("refuses a bare unit construction nothing decides", () => {
			let source = `implementation { ${blankBox}
				constant b = #Blank
			}`

			expect(codesOf(source)).toEqual(["undecided-type-arguments"])
			expect(messagesOf(source)).toEqual([
				"Nothing decides the Type Arguments of '#Blank'",
			])
		})

		it("leaves a conforming Type Argument alone", async () => {
			expect(
				await run(`implementation { ${boundedBox}
					constant b: Box<Integer> = #Full({ value = 5 })

					Terminal.inspect(match b -> Boolean {
						case Box#Full { <- @.value::is(5) }
						case #Empty { <- false }
					})
				}`),
			).toEqual(["true"])
		})

		it("leaves an unbounded Choice free to hold anything", () => {
			expect(
				messagesOf(`implementation {
					choice Holder<T> { Held { value: T } }

					constant held: Holder<(_ x: Integer) -> Integer> =
						#Held({ value = (_ x: Integer) -> Integer { <- x } })
				}`),
			).toEqual([])
		})

		// A Choice's Type Parameters are applied, never inferred, so `Holder#Bare`
		// and `Holder#Full(f)` with nothing deciding them are undecided. Inside
		// generic code, an annotation naming `Holder<Item>` answers for the bound.
		describe("The decision a prefixed construction asks for", () => {
			const holder = `choice Holder<Item is Equatable> {
				Bare,
				Full { value: Item },
			}`

			it("reports a prefixed unit construction nothing decides", () => {
				let source = `implementation { ${holder}
					constant left = Holder#Bare
				}`

				expect(codesOf(source)).toEqual(["undecided-type-arguments"])
				expect(messagesOf(source)).toEqual([
					"Nothing decides the Type Arguments of 'Holder#Bare'",
				])
			})

			// A prefixed payload is checked against the instantiation and never
			// picks one, so carrying one changes nothing here.
			it("reports a prefixed construction with a payload identically", () => {
				expect(
					codesOf(`implementation { ${holder}
						constant full = Holder#Full({ value = 1 })
					}`),
				).toEqual(["undecided-type-arguments"])
			})

			it("shows an application, with a blank per Argument, in both ways out", () => {
				expect(
					helpsOf(`implementation { ${holder}
						constant left = Holder#Bare
					}`),
				).toEqual([
					"Annotate the Declaration this is written into with 'Holder<…>', which is what decides them.",
					"Or apply the Type Arguments here — 'Holder<…>#Bare', with the Type you mean in place of each '…'.",
				])
			})

			// The Help keeps the parentheses on a Case that carries a payload, or
			// following it would meet `missing-payload`.
			it("keeps the payload on a Case that takes one", () => {
				expect(
					helpsOf(`implementation { ${holder}
						constant full = Holder#Full({ value = 1 })
					}`),
				).toEqual([
					"Annotate the Declaration this is written into with 'Holder<…>', which is what decides them.",
					"Or apply the Type Arguments here — 'Holder<…>#Full(…)', with the Type you mean in place of each '…'.",
				])

				expect(
					compiles(`implementation { ${holder}
						constant full = Holder<Integer>#Full({ value = 1 })
					}`),
				).toBe(true)
			})

			it("takes the decision from an annotation", async () => {
				expect(
					await run(`implementation { ${holder}
						constant ok: Holder<String> = Holder#Bare

						Terminal.inspect(ok::is(Holder#Bare))
					}`),
				).toEqual(["true"])
			})

			it("takes the decision from a declared return Type", async () => {
				expect(
					await run(`implementation { ${holder}
						function bare() -> Holder<Integer> { <- Holder#Bare }

						Terminal.inspect(match bare() -> String {
							case Holder#Full { <- "full" }
							case Holder#Bare { <- "bare" }
						})
					}`),
				).toEqual(['"bare"'])
			})

			it("takes the decision from the Parameter it is passed to", async () => {
				expect(
					await run(`implementation { ${holder}
						function describe(_ holder: Holder<Integer>) -> String {
							<- match holder -> String {
								case Holder#Full { <- "full" }
								case Holder#Bare { <- "bare" }
							}
						}

						Terminal.inspect(describe(Holder#Bare))
						Terminal.inspect(describe(Holder#Full(5)))
					}`),
				).toEqual(['"bare"', '"full"'])
			})

			// A List item and a Record member stand in the positions the expected
			// Type gives them.
			it("takes the decision from a List's item position", async () => {
				expect(
					await run(`implementation { ${holder}
						constant items: List<Holder<Integer>> = [Holder#Bare]

						Terminal.inspect(items::length()::toString())
					}`),
				).toEqual(['"1"'])
			})

			it("takes the decision from a Record member's position", () => {
				expect(
					messagesOf(`implementation { ${holder}
						constant held: { inner: Holder<Integer> } = {
							inner = Holder#Full(1),
						}
					}`),
				).toEqual([])
			})

			// A decided Case's payload is a position too, so a fully spelled outer
			// Type decides every construction nested inside it.
			it("takes the decision from the payload position around it", async () => {
				expect(
					await run(`implementation {
						choice Box<Value> { Full { value: Value }, Empty }

						constant nested: Box<Box<Integer>> = Box#Full(Box#Full(1))

						Terminal.inspect(match nested -> String {
							case #Full {
								<- match @.value -> String {
									case #Full { <- @.value::toString() }
									case #Empty { <- "inner empty" }
								}
							}
							case #Empty { <- "outer empty" }
						})
					}`),
				).toEqual(['"1"'])
			})

			it("reaches a nesting spelled out three deep", () => {
				expect(
					messagesOf(`implementation {
						choice Box<Value> { Full { value: Value }, Empty }

						constant nested: Box<Box<Box<Integer>>> =
							Box#Full(Box#Full(Box#Full(1)))
					}`),
				).toEqual([])
			})

			// Through the one-member shorthand, its Record, a List and a Record
			// standing between two constructions.
			it("reaches through what stands between two constructions", () => {
				expect(
					messagesOf(`implementation {
						choice Box<Value> { Full { value: Value }, Empty }
						choice Wrap<Value> { One { value: Value }, None }

						constant items: Box<List<Box<Integer>>> =
							Box#Full([Box#Empty, Box#Full(2)])
						constant member: Wrap<{ b: Box<Integer> }> =
							Wrap#One({ b = Box#Empty })
						constant written: Box<Box<Integer>> =
							Box#Full({ value = Box#Full(1) })
					}`),
				).toEqual([])
			})

			it("mixes the bare and the prefixed spelling in one nesting", async () => {
				expect(
					await run(`implementation {
						choice Box<Value> { Full { value: Value }, Empty }

						constant outer: Box<Box<Integer>> = Box#Full(#Full(1))
						constant inner: Box<Box<Integer>> = #Full(Box#Full(1))

						Terminal.inspect(outer::is(inner))
					}`),
				).toEqual(["true"])
			})

			// The payload is read once per offered instantiation, under its own
			// members. See "Case construction" in
			// packages/compiler/src/enricher/DEVELOPMENT.md.
			it("reads the payload under each instantiation the position offers", () => {
				expect(
					valueTypeOf(
						`implementation {
							choice Box<Value> { Full { value: Value }, Empty }

							constant chosen: Box<String> | Box<Box<Integer>> =
								Box#Full(Box#Full(1))
						}`,
						"chosen",
					),
				).toMatchObject({
					type: "Case",
					choice: "Box",
					name: "Full",
					typeArguments: [
						{
							type: "UnionType",
							alias: {
								name: "Box",
								typeArguments: [{ type: "Integer" }],
							},
						},
					],
				})
			})

			// Selection is silent, and only the committed reading reports, so a
			// losing candidate's complaints are never seen.
			it("reports the reading it committed, and only that one", () => {
				expect(
					codesOf(`implementation {
						choice Box<Value> { Full { value: Value }, Empty }

						constant chosen: Box<Integer> | Box<String> =
							Box#Full(nope)
					}`),
				).toEqual(["unknown-name"])

				expect(
					messagesOf(`implementation {
						choice Box<Value> { Full { value: Value }, Empty }

						constant chosen: Box<String> | Box<Box<Integer>> =
							Box#Full(Box#Full(1))
					}`),
				).toEqual([])
			})

			// The chosen reading is committed rather than read again, or a
			// nesting would be read exponentially often. A single instantiation is
			// never chosen at all. No Program reports a count of readings, so the
			// limit is a generous time.
			it("reads a nesting's payload once per level", () => {
				let nesting = (level: number): string =>
					level === 0 ? "1" : `Box#Full(${nesting(level - 1)})`
				let offered = (levels: number): string =>
					Array.from(
						{ length: levels },
						(_, level) =>
							`type T${level + 1} = Box<T${level}> | Box<List<T${level}>>`,
					).join("\n")
				let decided = (level: number): string =>
					level === 0 ? "Integer" : `Box<${decided(level - 1)}>`

				let several = `implementation {
						choice Box<Value> { Full { value: Value }, Empty }

						type T0 = Integer
						${offered(20)}

						constant nested: T20 = ${nesting(20)}
					}`
				let one = `implementation {
						choice Box<Value> { Full { value: Value }, Empty }

						constant nested: ${decided(40)} = ${nesting(40)}
					}`

				for (let source of [several, one]) {
					let start = performance.now()

					expect(messagesOf(source)).toEqual([])
					expect(performance.now() - start).toBeLessThan(500)
				}
			}, 30000)

			// A payload that does not fit is reported only a stage later, so the
			// probe answers the declared Case where it does not fit. The overload
			// whose instantiation the payload fits wins.
			it("picks the overload whose instantiation the payload fits", async () => {
				expect(
					await run(`implementation {
						choice Box<Value> { Full { value: Value }, Empty }

						namespace Taker for Integer {
							overload take {
								(_ b: Box<String>) -> String { <- "string" }
								(_ b: Box<Integer>) -> String { <- "integer" }
							}
						}

						Terminal.inspect(1::take(Box#Full(5)))
						Terminal.inspect(1::take(Box#Full("x")))
					}`),
				).toEqual(['"integer"', '"string"'])
			})

			// The bare spelling asks the position first, so a candidate that
			// decides but does not fit must leave no recording behind.
			it("picks the same overload from the bare spelling", async () => {
				expect(
					await run(`implementation {
						choice Box<Value> { Full { value: Value }, Empty }

						namespace Taker for Integer {
							overload take {
								(_ b: Box<String>) -> String { <- "string" }
								(_ b: Box<Integer>) -> String { <- "integer" }
							}
						}

						Terminal.inspect(1::take(#Full(5)))
						Terminal.inspect(1::take(#Full("x")))
					}`),
				).toEqual(['"integer"', '"string"'])
			})

			// `Item` is the enclosing Function's Type Parameter, so this is a
			// decision.
			it("takes a partially generic decision inside generic code", async () => {
				expect(
					await run(`implementation { ${holder}
						function wrap <infer Item is Equatable>(_ value: Item) -> Holder<Item> {
							<- Holder#Full({ value = value })
						}

						Terminal.inspect(match wrap(5) -> String {
							case Holder#Full { <- "full" }
							case Holder#Bare { <- "bare" }
						})
					}`),
				).toEqual(['"full"'])
			})

			// A Parameter Type mentioning the call's own open Type Parameters
			// decides nothing, so the construction is undecided.
			it("refuses a Parameter Type the call has not decided either", () => {
				let source = `implementation { ${holder}
					function take<infer Item is Equatable>(_ h: Holder<Item>) -> String {
						<- "took"
					}

					Terminal.inspect(take(Holder#Full(1)))
				}`

				expect(codesOf(source)).toEqual(["undecided-type-arguments"])
				expect(messagesOf(source)).toEqual([
					"Nothing decides the Type Arguments of 'Holder#Full'",
				])
			})

			it("refuses one at a Method identically", () => {
				expect(
					codesOf(`implementation { ${holder}
						namespace Takers for Integer {
							take<infer Item is Equatable>(_ h: Holder<Item>) -> String {
								<- "took"
							}
						}

						Terminal.inspect(1::take(Holder#Full(1)))
					}`),
				).toEqual(["undecided-type-arguments"])
			})

			// The same without any bound.
			it("refuses one carrying no bound", () => {
				expect(
					codesOf(`implementation {
						choice Box<Value> { Full { value: Value }, Empty }

						function take<infer Item>(_ b: Box<Item>) -> String {
							<- "took"
						}

						Terminal.inspect(take(Box#Full(1)))
					}`),
				).toEqual(["undecided-type-arguments"])
			})

			// `Crate` renames `Box`, so a Case written through it is decided as
			// one through `Box` is: by its position, or not at all. The Helps
			// write `Crate`, the name the construction used.
			it("decides a Case written through a generic Alias as the Choice's", async () => {
				let program = (body: string): string => `implementation {
					choice Box<Value> { Full { value: Value }, Empty }
					type Crate<V> = Box<V>
					choice Bag { Full { value: Integer }, Empty }

					${body}
				}`
				let undecided = program("Terminal.inspect(Crate#Full(1))")

				expect(messagesOf(undecided)).toEqual([
					"Nothing decides the Type Arguments of 'Crate#Full'",
				])
				expect(helpsOf(undecided)).toEqual([
					"Apply the Type Arguments here — 'Crate<…>#Full(…)', with the Type you mean in place of each '…'.",
				])
				expect(
					await run(
						program(`constant applied = Crate<Integer>#Full(1)
					constant annotated: Crate<Integer> = Crate#Full(2)
					constant either: Crate<Integer> | Bag = Crate#Full(3)

					Terminal.inspect(applied)
					Terminal.inspect(annotated)
					Terminal.inspect(either)`),
					),
				).toEqual(["Box#Full(1)", "Box#Full(2)", "Box#Full(3)"])
			})

			// `Boxes` writes only a List's application of `Box`, so the
			// `Box<Integer>` the position offers decides nothing for it.
			it("decides through a generic Alias only what the Alias can write", () => {
				expect(
					messagesOf(`implementation {
						choice Box<Value> { Full { value: Value }, Empty }
						type Boxes<A> = Box<List<A>>

						constant box: Box<Integer> = Boxes#Full([1])
					}`),
				).toEqual([
					"Nothing decides the Type Arguments of 'Boxes#Full'",
				])
			})

			// An Alias of an application holds the Choice's Cases applied, `W`
			// and all. A bare Case still resolves as `Box` declares it, in every
			// position, whichever Aliases are declared and wherever.
			it("resolves a bare Case as its Choice declares it beside Aliases of it", async () => {
				let program = (
					declarations: string,
					name: string,
				): string => `implementation {
					${declarations}

					function take<infer Item>(_ b: Box<Item>) -> String {
						<- "took"
					}

					constant h = #Full(1)
					constant c: ${name}<Integer> = #Full(2)
					constant boxed: Box<Integer> = #Full(3)

					Terminal.inspect(h)
					Terminal.inspect(c)
					Terminal.inspect(${name}<Integer>#Full(4))
					Terminal.inspect(#Full("five"))
					Terminal.inspect([#Full(6), #Full(7)])
					Terminal.inspect(take(#Full(8)))
					Terminal.inspect(match boxed -> String {
						case #Full { <- "full" }
						case #Empty { <- "empty" }
					})
				}`
				let box = "choice Box<Value> { Full { value: Value }, Empty }\n"
				let crate = "type Crate<W> = Box<W>\n"
				let others =
					"type Boxes<A> = Box<List<A>>\ntype Ints = Box<Integer>\n"
				let printed = [
					"Box#Full(1)",
					"Box#Full(2)",
					"Box#Full(4)",
					'Box#Full("five")',
					"[ Box#Full(6), Box#Full(7) ]",
					'"took"',
					'"full"',
				]

				expect(await run(program(box, "Box"))).toEqual(printed)
				expect(await run(program(box + crate, "Crate"))).toEqual(
					printed,
				)
				expect(await run(program(crate + box, "Crate"))).toEqual(
					printed,
				)
				expect(
					await run(program(others + box + crate, "Crate")),
				).toEqual(printed)
			})

			// Without the Alias, `Box#Empty` leaves its Type Arguments undecided,
			// so the Help writes them. The Alias changes nothing.
			it("names a bare Case's Choice in an ambiguity as without an Alias of it", () => {
				let program = (
					alias: string,
					body: string,
				): string => `implementation {
					choice Box<Value> { Full { value: Value }, Empty }
					${alias}
					choice Bag { Full { value: Integer }, Empty }

					${body}
				}`
				let crate = "type Crate<W> = Box<W>"
				let ambiguous = program(crate, "constant e = #Full(1)")

				expect(helpsOf(ambiguous)).toEqual(
					helpsOf(program("", "constant e = #Full(1)")),
				)
				expect(helpsOf(ambiguous)).toEqual([
					"Write 'Box<…>#Full' with its Type Arguments to pick 'Box'.",
					"Write 'Bag#Full' to pick 'Bag'.",
				])
				expect(
					compiles(
						program(crate, "constant e = Box<Integer>#Full(1)"),
					),
				).toBe(true)
				expect(
					compiles(program(crate, "constant e = Bag#Full(1)")),
				).toBe(true)
			})

			// Reported once, since no unsolved Type Parameter leaves through the
			// return Type to be reported again.
			it("says so once, and lets nothing carry the Parameter onward", () => {
				let source = `implementation {
					choice Outcome<Value is Equatable> { Ok { value: Value } }

					function unwrap<infer Value is Equatable>(
						_ r: Outcome<Value>,
					) -> Value {
						<- match r -> Value {
							case #Ok { <- @.value }
						}
					}

					Terminal.inspect(unwrap(Outcome#Ok(1))::toString())
				}`

				expect(codesOf(source)).toEqual(["undecided-type-arguments"])
			})

			// Spellings that do decide such a call: written Type Arguments, the
			// bare sigil, and an annotated Constant.
			it("takes every spelling that decides such a call", async () => {
				expect(
					await run(`implementation { ${holder}
						function take<infer Item is Equatable>(_ h: Holder<Item>) -> String {
							<- "took"
						}

						constant bound: Holder<Integer> = Holder#Full(1)

						Terminal.inspect(take(Holder<Integer>#Full(1)))
						Terminal.inspect(take(#Full(1)))
						Terminal.inspect(take(bound))
					}`),
				).toEqual(['"took"', '"took"', '"took"'])
			})

			// A construction binds nothing, so it is matched after an Argument that
			// decides the Parameter, whichever is written first.
			it("waits for an Argument that decides the Parameter", async () => {
				let orElse = `
					choice Outcome<Value is Equatable> {
						Ok { value: Value },
						Err,
					}

					function orElse<infer Value is Equatable>(
						_ r: Outcome<Value>,
						_ fallback: Value,
					) -> Value {
						<- match r -> Value {
							case #Ok { <- @.value }
							case #Err { <- fallback }
						}
					}
				`

				expect(
					await run(`implementation { ${orElse}
						Terminal.inspect(orElse(Outcome#Ok(1), 0)::toString())
						Terminal.inspect(orElse(Outcome#Err, 7)::toString())
					}`),
				).toEqual(['"1"', '"7"'])
			})

			// Dispatch reads the receiver's Type to find the Namespace, so the
			// receiver position decides nothing. A construction on a `::` decides
			// for itself.
			it("offers a construction no decision from the receiver position", () => {
				let namespaces = `
					choice Box<Value> { Full { value: Value }, Empty }

					namespace IntegerBox for Box<Integer> {
						label() -> String { <- "intbox" }
					}
				`

				expect(
					codesOf(`implementation { ${namespaces}
						Terminal.inspect(Box#Full(1)::label())
					}`),
				).toEqual(["undecided-type-arguments"])

				expect(
					messagesOf(`implementation { ${namespaces}
						Terminal.inspect(Box<Integer>#Full(1)::label())
					}`),
				).toEqual([])
			})

			// An application here is held to the bound as in any annotation.
			it("holds the Choice's own application as strictly as ever", () => {
				let source = `implementation { ${holder}
					function take(_ holder: Holder<(_ x: Integer) -> Integer>) -> Integer {
						<- 1
					}
				}`

				expect(codesOf(source)).toEqual(["unsatisfied-bound"])
				expect(messagesOf(source)).toEqual([
					"(_: Integer) -> Integer does not conform to 'Equatable'",
				])
			})

			// Inside generic code, the annotation naming `Holder<Item>` answers for
			// the bound.
			it("still reports an unbounded Type Parameter at the annotation", () => {
				let source = `implementation { ${holder}
					function bare<infer Item>() -> Holder<Item> { <- Holder#Bare }
				}`

				expect(codesOf(source)).toEqual(["unsatisfied-bound"])
				expect(messagesOf(source)).toEqual([
					"Type Parameter 'Item' does not conform to 'Equatable'",
				])
			})

			it("prints a decided unit Case", async () => {
				expect(
					await run(`implementation { ${holder}
						constant left: Holder<Integer> = Holder#Bare

						Terminal.inspect(left)
					}`),
				).toEqual(["Holder#Bare"])
			})
		})

		// Type Arguments written at the construction are the same application as
		// an annotation's, held to the same arity and bounds. See "Written Type
		// Arguments at a construction" in packages/compiler/src/enricher/DEVELOPMENT.md.
		describe("Type Arguments applied at the construction", () => {
			const holder = `choice Holder<Item is Equatable> {
				Bare,
				Full { value: Item },
			}`

			const pair = `choice Pair<Left, Right> {
				Both { left: Left, right: Right },
				Neither,
			}`

			it("decides a unit Case with nothing else in sight", async () => {
				expect(
					await run(`implementation { ${holder}
						constant left = Holder<Integer>#Bare

						Terminal.inspect(left::is(Holder<Integer>#Bare))
					}`),
				).toEqual(["true"])
			})

			// Read through `.value`, since the construction's Type is the Case,
			// not the Choice's Union a Match wants.
			it("decides a Case carrying a payload", async () => {
				expect(
					await run(`implementation { ${holder}
						constant left = Holder<Integer>#Full({ value = 1 })

						Terminal.inspect(left.value::toString())
					}`),
				).toEqual(['"1"'])
			})

			// The Arguments decide first, then the shorthand is wrapped into the
			// instantiated Record.
			it("takes the one-member shorthand", async () => {
				expect(
					await run(`implementation { ${holder}
						constant left = Holder<String>#Full("packed")

						Terminal.inspect(left.value)
					}`),
				).toEqual(['"packed"'])
			})

			it("takes a nested Type Argument", () => {
				expect(
					messagesOf(`implementation {
						choice Box<Value> { Full { value: Value }, Empty }

						constant left = Box<List<Integer>>#Full([1, 2])
					}`),
				).toEqual([])
			})

			it("takes a Choice's several Type Arguments in order", () => {
				expect(
					valueTypeOf(
						`implementation { ${pair}
							constant both =
								Pair<Integer, String>#Both({ left = 1, right = "x" })
						}`,
						"both",
					),
				).toEqual({
					type: "Case",
					choice: "Pair",
					name: "Both",
					members: {
						left: { type: "Integer" },
						right: { type: "String" },
					},
					typeArguments: [{ type: "Integer" }, { type: "String" }],
				})
			})

			it("reports the wrong number of Type Arguments", () => {
				let source = `implementation { ${pair}
					constant left = Pair<Integer>#Neither
				}`

				expect(codesOf(source)).toEqual(["wrong-type-argument-count"])
				expect(messagesOf(source)).toEqual([
					"Type 'Pair' was given the wrong number of Type Arguments",
				])
			})

			it("reports a Type Argument that does not satisfy its bound", () => {
				let source = `implementation { ${holder}
					constant left = Holder<(_ x: Integer) -> Integer>#Bare
				}`

				expect(codesOf(source)).toEqual(["unsatisfied-bound"])
				expect(messagesOf(source)).toEqual([
					"(_: Integer) -> Integer does not conform to 'Equatable'",
				])
			})

			// The payload is checked against the instantiation the Arguments
			// decided.
			it("checks the payload against what the Arguments decided", () => {
				expect(
					codesOf(`implementation { ${holder}
						constant left = Holder<Integer>#Full("x")
					}`),
				).toEqual(["payload-type-mismatch"])
			})

			it("refuses Type Arguments at a Choice that takes none", () => {
				expect(
					codesOf(`implementation {
						choice Colour { Red, Green }

						constant c = Colour<Integer>#Red
					}`),
				).toEqual(["type-not-generic"])
			})

			it("agrees with a position that decided the same thing", () => {
				expect(
					messagesOf(`implementation { ${holder}
						constant left: Holder<Integer> = Holder<Integer>#Full(1)
					}`),
				).toEqual([])
			})

			// The written Arguments win, so a disagreeing position is an ordinary
			// value that does not fit.
			it("leaves a disagreeing annotation to the assignment", () => {
				let source = `implementation { ${holder}
					constant left: Holder<String> = Holder<Integer>#Full(1)
				}`

				expect(codesOf(source)).toEqual(["assignment-type-mismatch"])
				expect(messagesOf(source)).toEqual([
					"This value does not fit the declared Type of Constant 'left'",
				])
			})

			it("leaves a disagreeing Parameter to the Argument check", () => {
				expect(
					codesOf(`implementation { ${holder}
						function take(_ held: Holder<String>) -> Integer { <- 1 }

						Terminal.inspect(take(Holder<Integer>#Full(1))::toString())
					}`),
				).toEqual(["argument-type-mismatch"])
			})

			// A Case whose members mention no Type Parameter is one Type under every
			// instantiation. So its written Arguments are compared with the position's
			// directly, under the code the position would use.
			const tagged = `choice Box<Value> {
				Full { value: Value },
				Tag { name: String },
			}`

			it("reports a disagreement the Case's members can not carry", () => {
				let source = `implementation { ${tagged}
					constant left: Box<Integer> = Box<String>#Tag("x")
				}`

				expect(codesOf(source)).toEqual(["assignment-type-mismatch"])
				expect(messagesOf(source)).toEqual([
					"These Type Arguments are not the ones this position decided",
				])
				expect(helpsOf(source)).toEqual([
					"Write 'Box<Integer>#Tag'.",
					"Or leave the Type Arguments out, and let the position decide them.",
				])
			})

			it("reports one at an Argument as the Argument check would", () => {
				expect(
					codesOf(`implementation { ${tagged}
						function take(_ b: Box<String>) -> Integer { <- 1 }

						Terminal.inspect(take(Box<Integer>#Tag("x"))::toString())
					}`),
				).toEqual(["argument-type-mismatch"])
			})

			it("reports one in a List's item position", () => {
				expect(
					codesOf(`implementation {
						choice Box<Value> { Full { value: Value }, Empty }

						constant items: List<Box<String>> = [Box<Integer>#Empty]
					}`),
				).toEqual(["assignment-type-mismatch"])
			})

			// Agreement is assignability, and a Union position is answered by any
			// one of its instantiations.
			it("takes Arguments the position's own accept", () => {
				expect(
					messagesOf(`implementation {
						choice Box<Value> { Full { value: Value }, Empty }

						constant wider: Box<Integer | String> = Box<Integer>#Empty
						constant offered: Box<Integer> | Box<String> =
							Box<String>#Empty
					}`),
				).toEqual([])
			})

			// A Parameter Type is decided only once the call is, so the comparison
			// uses the finished call. In `id(Box<Integer>#Empty, 1)` the second
			// Argument decides `T`.
			it("compares against the position the call finally decided", async () => {
				let box = `choice Box<Value> { Full { value: Value }, Empty }`
				let tagged = `choice Tagged<Value> {
					Full { value: Value },
					Tag { name: String },
				}`

				expect(
					await run(`implementation { ${box}
						function id<infer T>(_ b: Box<T>, _ seed: T) -> String {
							<- "ok"
						}

						Terminal.inspect(id(Box<Integer>#Empty, 1))
					}`),
				).toEqual(['"ok"'])

				expect(
					await run(`implementation { ${box}
						namespace Nums for Integer {
							id<infer T>(_ b: Box<T>, _ seed: T) -> String {
								<- "ok"
							}
						}

						Terminal.inspect(1::id(Box<Integer>#Empty, 1))
					}`),
				).toEqual(['"ok"'])

				expect(
					await run(`implementation { ${tagged}
						function id<infer T>(_ b: Tagged<T>, _ seed: T) -> String {
							<- "ok"
						}

						Terminal.inspect(id(Tagged<Integer>#Tag("x"), 1))
					}`),
				).toEqual(['"ok"'])

				expect(
					await run(`implementation { ${box}
						function id<infer T>(with b: Box<T>, seed s: T) -> String {
							<- "ok"
						}

						Terminal.inspect(id(with Box<Integer>#Empty, seed 1))
					}`),
				).toEqual(['"ok"'])
			})

			// A real disagreement names the Type the call decided.
			it("says which Arguments the call decided on", () => {
				let source = `implementation {
					choice Box<Value> { Full { value: Value }, Empty }

					function id<infer T>(_ b: Box<T>, _ seed: T) -> String {
						<- "ok"
					}

					Terminal.inspect(id(Box<String>#Empty, 1))
				}`

				expect(codesOf(source)).toEqual(["argument-type-mismatch"])
				expect(notesOf(source)).toEqual([
					"The position decided Box<Integer>.",
				])
				expect(helpsOf(source)).toEqual([
					"Write 'Box<Integer>#Empty'.",
					"Or leave the Type Arguments out, and let the position decide them.",
				])
			})

			// A Type Parameter nothing decides is left to the call's own report,
			// with no disagreement on top.
			it("leaves an undecided call its own Diagnostic", () => {
				expect(
					codesOf(`implementation {
						choice Box<Value> { Full { value: Value }, Empty }

						function id<infer T>(_ b: Box<T>) -> Box<T> { <- b }

						constant b: Box<Integer> = id(Box<Integer>#Empty)
					}`),
				).toEqual(["uninferable-type-parameter"])
			})

			it("applies a Type Parameter of the enclosing Function", async () => {
				expect(
					await run(`implementation {
						choice Box<Value> { Full { value: Value }, Empty }

						function empty <infer Value>(_ seed: Value) -> Box<Value> {
							<- Box<Value>#Empty
						}

						Terminal.inspect(match empty(1) -> String {
							case #Full  { <- "full" }
							case #Empty { <- "empty" }
						})
					}`),
				).toEqual(['"empty"'])
			})

			// Only the `#` after the Arguments makes a construction, so the reading
			// is speculative. Without a `#` the Identifier reads as itself.
			it("leaves an Identifier that opens no application alone", () => {
				expect(
					messagesOf(`implementation {
						constant a = 1

						Terminal.inspect(a::isLessThan(2))
					}`),
				).toEqual([])
			})

			// An application stays on one line, so a `<` opening the next line
			// begins something else.
			it("does not read Type Arguments across a line break", () => {
				expect(
					codesOf(`implementation {
						choice Box<Value> { Full { value: Value }, Empty }

						constant b = Box
							<Integer>#Empty
					}`),
				).toEqual(["syntax-error"])
			})

			// A `#` must sit directly against what precedes it, which keeps
			// `label #Case` a labelled Argument. Its own code carries the refusal out
			// of the speculative reading.
			it("does not read a '#' that opens the next line", () => {
				expect(
					codesOf(`implementation {
						choice Box<Value> { Full { value: Value }, Empty }

						constant b = Box<Integer>
						#Full(1)
					}`),
				).toEqual(["case-application-across-lines"])
				expect(
					compiles(`implementation {
						choice Box<Value> { Full { value: Value }, Empty }

						constant b = Box<Integer>#Full(1)
					}`),
				).toBe(true)
			})

			// The `#` is held to the line the Arguments close on, so they may span
			// several lines.
			it("holds the '#' to the line the Arguments close on", () => {
				expect(
					messagesOf(`implementation {
						choice Box<Value> { Full { value: Value }, Empty }

						constant b = Box<
							Integer,
						>#Full(1)
					}`),
				).toEqual([])
			})

			it("names the Case with its Type Arguments where a report shows it", () => {
				let labels = labelsOf(`implementation {
					type Item = { price: Integer, tag: Integer }

					constant items: List<Item> = [{ price = 3, tag = Optional<String>#Empty }, { price = 4, tag = 1 }]
				}`)

				expect(labels).toHaveLength(1)
				expect(labels[0]).toContain("tag: Optional<String>#Empty }")
			})
		})
	})

	describe("Contextual Case Resolution", () => {
		// `A` and `B` both declare `Go`, so these pass only when the position's
		// expected Type is consulted before the scope scan.
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
					Terminal.inspect(match 1::compare(to 2) -> String {
						case #Less { <- "smaller" }
						case #Equal { <- "same" }
						case #Greater { <- "bigger" }
					})

					Terminal.inspect(Ordering#Less::is(1::compare(to 2)))
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

	// Every Choice is Equatable without a written Namespace, since a Case is its
	// tag and a Record payload. The Methods resolve, the conformance solves, and
	// a Type that is not a Choice derives nothing.
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

					Terminal.inspect(red::is(green))
					Terminal.inspect(red::isNot(green))
				}`),
			).toEqual([])
		})

		it("answers for a receiver narrowed to a single Case", () => {
			expect(
				messagesOf(`implementation { ${colourChoice}
					constant red: Colour = #Red

					Terminal.inspect(match red -> Boolean {
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

					Terminal.inspect([red]::contains(#Green))
					Terminal.inspect([red]::is([red]))
				}`),
			).toEqual([])
		})

		it("compares payload Cases by tag and then by payload", () => {
			expect(
				messagesOf(`implementation { ${calculatorChoice}
					constant one: CalculatorOperation = #Add({ left = 1, right = 1 })
					constant two: CalculatorOperation = #Negate({ number = 1 })

					Terminal.inspect(one::is(two))
				}`),
			).toEqual([])
		})

		it("accepts a declared 'is Equatable' that writes neither Method", () => {
			expect(
				messagesOf(`implementation { ${colourChoice}
					namespace Colour for Colour is Equatable { }

					constant red: Colour = #Red

					Terminal.inspect(red::is(#Green))
				}`),
			).toEqual([])
		})

		it("derives nothing for a Union that is not a Choice", () => {
			expect(
				messagesOf(`implementation {
					constant value: Integer | Boolean = 5

					Terminal.inspect(value::is(5))
				}`),
			).not.toEqual([])
		})
	})

	// How a Choice reads is a decision, so printing is derived only where a
	// Namespace declares `is Printable` and no Case carries a payload.
	describe("Derived Printing", () => {
		const colourChoice = `
			choice Colour {
				Red,
				Green,
			}
		`

		it("answers 'toString' for a Namespace that declares only the conformance", () => {
			expect(
				messagesOf(`implementation { ${colourChoice}
					namespace Colour for Colour is Printable { }

					constant red: Colour = #Red

					Terminal.inspect(red::toString())
				}`),
			).toEqual([])
		})

		// `inspect` is what the harness captures, and it quotes a String.
		it("answers the Case's name, without the sigil", async () => {
			expect(
				await run(`implementation { ${colourChoice}
					namespace Colour for Colour is Equatable, is Printable { }

					constant red: Colour = #Red

					Terminal.inspect(red::toString())
					Terminal.inspect("a {red} one")
				}`),
			).toEqual(['"Red"', '"a Red one"'])
		})

		// A bounded Method's witness is the derived Method too.
		it("hands the derived Method over as a Printable witness", async () => {
			expect(
				await run(`implementation { ${colourChoice}
					namespace Colour for Colour is Printable { }

					function label <infer Value is Printable>(_ value: Value) -> String {
						<- "{value}"
					}

					constant red: Colour = #Red

					Terminal.inspect(label(red))
				}`),
			).toEqual(['"Red"'])
		})

		it("answers for a receiver narrowed to a single Case", async () => {
			expect(
				await run(`implementation { ${colourChoice}
					namespace Colour for Colour is Printable { }

					constant red: Colour = #Red

					Terminal.inspect(match red -> String {
						case #Red { <- @::toString() }
						case _ { <- "other" }
					})
				}`),
			).toEqual(['"Red"'])
		})

		// Without a Namespace declaring `is Printable`, nothing is derived.
		it("derives nothing for a Choice no Namespace declares Printable", () => {
			expect(
				messagesOf(`implementation { ${colourChoice}
					constant red: Colour = #Red

					Terminal.print(red)
				}`),
			).not.toEqual([])
		})

		// A Case carrying a payload has no name that stands for it, so the
		// declaration is refused.
		it("refuses a declared 'is Printable' on a Choice with a payload", () => {
			expect(
				codesOf(`implementation { ${calculatorChoice}
					namespace CalculatorOperation for CalculatorOperation is Printable { }

					constant sum: CalculatorOperation = #Add({ left = 1, right = 1 })

					Terminal.print(sum)
				}`),
			).toContain("nonconforming-namespace")
		})

		// A written `toString` wins over the derive, at the call and in the
		// witness.
		it("keeps a written 'toString' at the call and in the witness", async () => {
			expect(
				await run(`implementation { ${colourChoice}
					namespace Colour for Colour is Printable {
						§§ The Colour's initial.
						§§
						§§ @returns — one character.
						toString() -> String {
							<- match @ -> String {
								case #Red   { <- "R" }
								case #Green { <- "G" }
							}
						}
					}

					constant red: Colour = #Red

					Terminal.inspect(red::toString())
					Terminal.inspect("{red}")
				}`),
			).toEqual(['"R"', '"R"'])
		})
	})

	// `Enumerable::cases` is a static spelled on the Choice's name. Like
	// equality it is derived without a declaration. A Choice with a payload
	// anywhere derives none, since such a Case has no value to list.
	describe("Derived Case Listing", () => {
		const colourChoice = `
			choice Colour {
				Red,
				Green,
				Blue,
			}
		`

		// The Cases come in declaration order, as the `§§` promises.
		it("answers every Case of a builtin Choice in declaration order", async () => {
			expect(
				await run(`implementation {
					Terminal.inspect(Side.cases()::toString())
					Terminal.inspect(Ordering.cases()::toString())
				}`),
			).toEqual(['"[Start, End, BothEnds]"', '"[Less, Equal, Greater]"'])
		})

		// A Choice with no Namespace still answers through the derive.
		it("answers for a Choice no Namespace was written for", async () => {
			expect(
				await run(`implementation { ${colourChoice}
					Terminal.inspect(Colour.cases()::length())
				}`),
			).toEqual(["3"])
		})

		it("answers for a Choice a Namespace was written for", async () => {
			expect(
				await run(`implementation { ${colourChoice}
					namespace Colour for Colour is Printable { }

					Terminal.inspect(Colour.cases()::toString())
				}`),
			).toEqual(['"[Red, Green, Blue]"'])
		})

		// A Choice declares at least one Case, so the answer is a `NonEmptyList`
		// and `firstItem` answers an item.
		it("answers a List proven to hold an item", async () => {
			expect(
				await run(`implementation { ${colourChoice}
					namespace Colour for Colour is Printable { }

					Terminal.inspect(Colour.cases()::firstItem()::toString())
				}`),
			).toEqual(['"Red"'])
		})

		// A Choice with a payload derives no `cases`.
		it("derives nothing for a Choice with a payload", () => {
			expect(
				codesOf(`implementation {
					choice Shape {
						Circle { radius: Integer },
						Square { side: Integer },
					}

					namespace Shape for Shape is Printable {
						§§ The Shape's name.
						§§
						§§ @returns — a name.
						toString() -> String {
							<- "shape"
						}
					}

					Terminal.print(Shape.cases()::length()::toString())
				}`),
			).toEqual(["unknown-member"])
		})

		// A written `cases` replaces the derive where the Namespace declares the
		// conformance, on the direct and the bounded rail alike.
		it("keeps a written 'cases' in place of the derived one", async () => {
			expect(
				await run(`implementation { ${colourChoice}
					namespace Colour for Colour is Enumerable {
						§§ The Colours worth offering.
						§§
						§§ @returns — one Colour.
						static cases() -> NonEmptyList<Colour> {
							<- [#Red]
						}
					}

					Terminal.inspect(Colour.cases()::length())
				}`),
			).toEqual(["1"])
		})

		// A written `cases` reached through the Choice's name, the Namespace's
		// name and a bound, whatever the Namespace is called.
		const bothRails = (
			namespaceName: string,
		) => `implementation { ${colourChoice}
			namespace ${namespaceName} for Colour is Enumerable {
				§§ The Colours worth offering.
				§§
				§§ @returns — one Colour.
				static cases() -> NonEmptyList<Colour> {
					<- [#Red]
				}
			}

			function countOf <infer Mode is Enumerable>(_ example: Mode) -> Integer {
				<- Mode.cases()::length()
			}

			constant red: Colour = #Red

			Terminal.inspect(Colour.cases()::length())
			Terminal.inspect(${namespaceName}.cases()::length())
			Terminal.inspect(countOf(red))
		}`

		it("answers a written 'cases' the same way on every rail", async () => {
			expect(await run(bothRails("Colour"))).toEqual(["1", "1", "1"])
			expect(await run(bothRails("Colours"))).toEqual(["1", "1", "1"])
		})

		it("emits the Namespace a 'cases' reached through the Choice is written in", () => {
			expect(
				generate(`implementation { ${colourChoice}
					namespace Colours for Colour is Enumerable {
						§§ The Colours worth offering.
						§§
						§§ @returns — one Colour.
						static cases() -> NonEmptyList<Colour> {
							<- [#Red]
						}
					}

					Terminal.inspect(Colour.cases()::length())
				}`),
			).toContain("Colours.cases()")
		})

		// Without the clause the direct rail would read the written Method and a
		// bound would read the derive. So the Namespace is refused.
		it("refuses a written 'cases' the Namespace does not declare", () => {
			let source = `implementation { ${colourChoice}
				namespace Colours for Colour {
					§§ The Colours worth offering.
					§§
					§§ @returns — one Colour.
					static cases() -> NonEmptyList<Colour> {
						<- [#Red]
					}
				}

				Terminal.print("x")
			}`

			expect(codesOf(source)).toEqual(["undeclared-conformance"])
			expect(helpsOf(source)).toEqual([
				"Declare the conformance: 'is Enumerable' on this Namespace.",
			])
		})

		// The conformance belongs on the Namespace's head, so no Parameter is
		// named.
		it("carries that Protocol as data with no Parameter", () => {
			expect(
				diagnosticsOf(`implementation { ${colourChoice}
					namespace Colours for Colour {
						§§ The Colours worth offering.
						§§
						§§ @returns — one Colour.
						static cases() -> NonEmptyList<Colour> {
							<- [#Red]
						}
					}

					Terminal.print("x")
				}`)[0].data,
			).toEqual({
				kind: "required-protocol",
				protocol: "Enumerable",
				parameter: null,
			})
		})

		// The guard is by name, as the derive's replacement is, so a `cases` of
		// the wrong shape is refused too.
		it("refuses a written 'cases' of the wrong shape", () => {
			expect(
				codesOf(`implementation { ${colourChoice}
					namespace Colours for Colour {
						§§ How many Colours there are.
						§§
						§§ @returns — a count.
						cases() -> Integer {
							<- 3
						}
					}

					Terminal.print("x")
				}`),
			).toEqual(["undeclared-conformance"])
		})

		// Equality splits the same way, so a written `is` without the clause is
		// refused. `isNot` is provided rather than required, so it is accepted.
		it("refuses a written 'is' the Namespace does not declare", () => {
			let source = `implementation { ${colourChoice}
				namespace Colours for Colour {
					§§ Compares two Colours.
					§§
					§§ @param _ — the Colour to compare with
					§§ @returns — always true.
					is(_ other: Colour) -> Boolean {
						<- true
					}
				}

				Terminal.print("x")
			}`

			expect(codesOf(source)).toEqual(["undeclared-conformance"])
			expect(helpsOf(source)).toEqual([
				"Declare the conformance: 'is Equatable' on this Namespace.",
			])
		})

		it("accepts a written 'isNot' the Namespace does not declare", () => {
			expect(
				codesOf(`implementation { ${colourChoice}
					namespace Colours for Colour {
						§§ Spells the difference.
						§§
						§§ @param _ — the tag
						§§ @returns — the tag.
						isNot(_ tag: String) -> String {
							<- tag
						}
					}

					Terminal.print("x")
				}`),
			).toEqual([])
		})

		// Printing derives only where a Namespace declares it, so a written
		// `toString` without the clause replaces nothing and is accepted.
		it("accepts a written 'toString' the Namespace does not declare", () => {
			expect(
				codesOf(`implementation { ${colourChoice}
					namespace Colours for Colour {
						§§ The Colour as a String.
						§§
						§§ @returns — a name.
						toString() -> String {
							<- "colour"
						}
					}

					Terminal.print("x")
				}`),
			).toEqual([])
		})

		// A Choice with a payload derives no listing, so a written `cases`
		// replaces nothing.
		it("accepts a written 'cases' for a Choice that derives none", () => {
			expect(
				codesOf(`implementation {
					choice Shape {
						Circle { radius: Integer },
					}

					namespace Shapes for Shape {
						§§ The Shapes worth drawing.
						§§
						§§ @returns — one Shape.
						static cases() -> NonEmptyList<Shape> {
							<- [#Circle(1)]
						}
					}

					Terminal.print("x")
				}`),
			).toEqual([])
		})

		// Declaring a conformance the Choice already has is neither needed nor
		// refused.
		it("accepts a declared conformance a Choice already has", () => {
			expect(
				messagesOf(`implementation { ${colourChoice}
					namespace Colour for Colour is Enumerable { }

					Terminal.print(Colour.cases()::length()::toString())
				}`),
			).toEqual([])
		})

		it("refuses a declared conformance a Choice with a payload can not answer", () => {
			expect(
				codesOf(`implementation {
					choice Shape {
						Circle { radius: Integer },
					}

					namespace Shape for Shape is Enumerable { }

					Terminal.print("x")
				}`),
			).toEqual(["nonconforming-namespace"])
		})

		it("refuses a declared conformance on a Namespace over no Choice", () => {
			expect(
				codesOf(`implementation {
					namespace Counter for Integer is Enumerable { }

					Terminal.print("x")
				}`),
			).toEqual(["nonconforming-namespace"])
		})

		// A bounded body calls the static on its Type Parameter, as
		// `T.cases()`, and the witness answers.
		it("answers through a Protocol bound, from an Essence body", async () => {
			expect(
				await run(`implementation { ${colourChoice}
					namespace Colour for Colour is Printable { }

					function namesOf <infer T is Enumerable>(_ example: T) -> Integer {
						<- T.cases()::length()
					}

					constant red: Colour = #Red
					constant start: Side = #Start

					Terminal.inspect(namesOf(red))
					Terminal.inspect(namesOf(start))
				}`),
			).toEqual(["3", "3"])
		})

		// A Choice with a payload reaches the bound by writing the Method.
		it("answers through a bound for a written conformance", async () => {
			expect(
				await run(`implementation {
					choice Shape {
						Circle { radius: Integer },
						Square { side: Integer },
					}

					namespace Shape for Shape is Enumerable {
						§§ The Shapes worth drawing.
						§§
						§§ @returns — the Shapes.
						static cases() -> NonEmptyList<Shape> {
							<- [#Circle(1), #Square(1)]
						}
					}

					function countOf <infer T is Enumerable>(_ example: T) -> Integer {
						<- T.cases()::length()
					}

					constant circle: Shape = #Circle(1)

					Terminal.inspect(countOf(circle))
				}`),
			).toEqual(["2"])
		})

		// `Self` stands in the answer, so a single Case would promise a List of
		// that Case but get the Choice's. The Case is refused.
		it("refuses a bound bound to a single Case", () => {
			let source = `implementation { ${colourChoice}
				function countOf <infer T is Enumerable>(_ example: T) -> Integer {
					<- T.cases()::length()
				}

				Terminal.print(countOf(Colour#Red)::toString())
			}`

			expect(codesOf(source)).toEqual(["unsatisfied-bound"])
			// No Namespace can target one Case, so the Help names the Choice.
			expect(helpsOf(source)).toEqual([
				"Annotate the value at 'Colour': a bare Case binds the Case, not the Choice.",
			])
		})

		// A value annotated at the Choice, as the Help asks.
		it("answers a bound for a value annotated at the Choice", async () => {
			expect(
				await run(`implementation { ${colourChoice}
					function countOf <infer T is Enumerable>(_ example: T) -> Integer {
						<- T.cases()::length()
					}

					constant red: Colour = #Red

					Terminal.inspect(countOf(red))
				}`),
			).toEqual(["3"])
		})

		// Every payload-free library Choice answers without declaring it. The
		// Choices and their Cases are read off the sources, so a new one is
		// asked too.
		it("answers for every mode Choice the library declares", async () => {
			let modes = readStdlibFiles().flatMap(({ filePath, sourceText }) =>
				parseStdlibSource(filePath, sourceText)
					.program.implementation.nodes.filter(
						(node): node is parser.ChoiceDeclarationStatementNode =>
							node.nodeType === "ChoiceDeclarationStatement" &&
							node.generics.length === 0 &&
							node.cases.every(
								(choiceCase) => choiceCase.type === null,
							),
					)
					.map((choice) => ({
						name: choice.name.content,
						cases: choice.cases.map(
							(choiceCase) => choiceCase.name.content,
						),
					})),
			)

			expect(modes.map((mode) => mode.name)).toEqual(
				expect.arrayContaining(["Side", "HttpMethod", "Redirects"]),
			)
			expect(
				await run(
					`implementation {\n${modes
						.map(
							(mode) =>
								`\tTerminal.inspect(${mode.name}.cases()::toString())`,
						)
						.join("\n")}\n}`,
				),
			).toEqual(modes.map((mode) => `"[${mode.cases.join(", ")}]"`))
		})

		// A generic payload-free Choice answers through a bound, where its Type
		// Arguments are applied. Its bare name is no value, so `Flag.cases()` is
		// an `unknown-name`.
		it("answers a generic Choice through a bound, and not on its name", async () => {
			const flag = `
				choice Flag<T> {
					On,
					Off,
				}
			`

			expect(
				await run(`implementation { ${flag}
					function count <infer Mode is Enumerable>(_ example: Mode) -> Integer {
						<- Mode.cases()::length()
					}

					constant on: Flag<Integer> = Flag<Integer>#On

					Terminal.inspect(count(on))
				}`),
			).toEqual(["2"])

			expect(
				codesOf(`implementation { ${flag}
					Terminal.print(Flag.cases()::length()::toString())
				}`),
			).toEqual(["unknown-name"])
		})

		// A static has no receiver to read the Choice from, so the helper is
		// curried with the Case tags.
		it("emits the helper curried with the Case tags", () => {
			let js = generate(`implementation { ${colourChoice}
				Terminal.print(Colour.cases()::length()::toString())
			}`)

			expect(js).toContain("$helpers.choiceCases([")
			expect(js).toContain('"Colour#Red"')
			expect(js).toContain('"Colour#Blue"')
		})
	})

	// A generic Choice derives Equatable conditionally: each payload Parameter
	// is bounded and compared through its witness. The derive is withheld when a
	// Type Argument has no equality. A non-generic Choice emits the flat
	// `choiceIs`.
	describe("Generic Derived Equality", () => {
		const maybe = `choice Maybe<T> { Some { value: T }, None }`
		const bag = `choice Bag<T> { Full { items: List<T> } }`
		const opt = `choice Opt<T> { Holding { value: T | String } }`
		const wrap = `choice Wrap<T> { It { value: T } }`
		const tagged = `choice Tagged<T, Phantom> { Val { value: T }, Empty }`

		it("compares two instantiated Cases through their payload's equality", async () => {
			expect(
				await run(`implementation { ${maybe}
					Terminal.inspect(#Some({ value = 1 })::is(#Some({ value = 1 }))::toString())
					Terminal.inspect(#Some({ value = 1 })::is(#Some({ value = 2 }))::toString())
					Terminal.inspect(#Some({ value = 1 })::is(#None)::toString())
				}`),
			).toEqual(['"true"', '"false"', '"false"'])
		})

		it("answers 'isNot' as the negation", async () => {
			expect(
				await run(`implementation { ${maybe}
					Terminal.inspect(#Some({ value = 1 })::isNot(#Some({ value = 2 }))::toString())
					Terminal.inspect(#Some({ value = 1 })::isNot(#Some({ value = 1 }))::toString())
				}`),
			).toEqual(['"true"', '"false"'])
		})

		it("compares a composite payload through composed witnesses", async () => {
			expect(
				await run(`implementation { ${bag}
					constant a: Bag<Integer> = #Full({ items = [1, 2, 3] })
					constant b: Bag<Integer> = #Full({ items = [1, 2, 3] })
					constant c: Bag<Integer> = #Full({ items = [1, 2] })

					Terminal.inspect(a::is(b)::toString())
					Terminal.inspect(a::is(c)::toString())
				}`),
			).toEqual(['"true"', '"false"'])
		})

		// The concrete arm of a payload Union claims its own tag and the generic
		// arm takes the rest. Neither is compared through the other's witness.
		it("discriminates a Union payload's concrete arm from its generic arm", async () => {
			expect(
				await run(`implementation { ${opt}
					constant a: Opt<Integer> = #Holding({ value = 1 })
					constant b: Opt<Integer> = #Holding({ value = 2 })
					constant text: Opt<Integer> = #Holding({ value = "x" })

					Terminal.inspect(a::is(a)::toString())
					Terminal.inspect(a::is(b)::toString())
					Terminal.inspect(a::is(text)::toString())
					Terminal.inspect(text::is(text)::toString())
				}`),
			).toEqual(['"true"', '"false"', '"false"', '"true"'])
		})

		it("solves as a nested witness inside List's Equatable", async () => {
			expect(
				await run(`implementation { ${maybe}
					constant items: List<Maybe<Integer>> = [#Some({ value = 1 }), #None]

					Terminal.inspect(items::contains(#Some({ value = 1 }))::toString())
					Terminal.inspect(items::contains(#Some({ value = 9 }))::toString())
					Terminal.inspect(items::contains(#None)::toString())
				}`),
			).toEqual(['"true"', '"false"', '"true"'])
		})

		// The witness carries Rational's own `is`, by which `1/2` and `2/4` are
		// equal.
		it("compares a Rational payload by its own equality, not by structure", async () => {
			expect(
				await run(`implementation { ${wrap}
					constant a: Wrap<Rational> = #It(1/2)
					constant b: Wrap<Rational> = #It(2/4)

					Terminal.inspect(a::is(b)::toString())
				}`),
			).toEqual(['"true"'])
		})

		it("holds no diagnostics for any of the derived comparisons", () => {
			expect(
				messagesOf(`implementation { ${maybe} ${bag} ${opt}
					constant m: Maybe<Integer> = #Some({ value = 1 })
					constant g: Bag<Integer> = #Full({ items = [1] })
					constant o: Opt<Integer> = #Holding({ value = 1 })

					Terminal.inspect(m::is(#None))
					Terminal.inspect(g::isNot(g))
					Terminal.inspect(o::is(o))
					Terminal.inspect([m]::contains(#None))
				}`),
			).toEqual([])
		})

		// A payload without equality withholds the derive and reports the bound.
		it("withholds the derive when a payload is not Equatable", () => {
			let diagnostics = diagnosticsOf(`implementation { ${maybe}
				constant f: Maybe<(_ x: Integer) -> Integer> =
					#Some({ value = (_ x: Integer) -> Integer { <- x } })

				Terminal.inspect(f::is(f))
			}`)

			expect(diagnostics).not.toEqual([])
			expect(
				codesOf(`implementation { ${maybe}
				constant f: Maybe<(_ x: Integer) -> Integer> =
					#Some({ value = (_ x: Integer) -> Integer { <- x } })

				Terminal.inspect(f::is(f))
			}`),
			).toContain("unsatisfied-bound")
		})

		it("emits the widened helper and descriptor for a generic Choice", () => {
			let generated = generate(`implementation { ${maybe}
				Terminal.inspect(#Some({ value = 1 })::is(#Some({ value = 1 })))
				Terminal.inspect(#Some({ value = 1 })::isNot(#Some({ value = 1 })))
			}`)

			expect(generated).toContain("$helpers.boundChoiceIs(")
			expect(generated).toContain("$helpers.boundChoiceIsNot(")
			expect(generated).toContain('"Maybe#Some"')
			expect(generated).toContain('"k": "w"')
		})

		// The nested witness is the derive curried with Integer's equality.
		it("wraps the nested derive witness in boundConformance", () => {
			let generated = generate(`implementation { ${maybe}
				constant items: List<Maybe<Integer>> = [#Some({ value = 1 })]

				Terminal.inspect(items::contains(#None))
			}`)

			expect(generated).toContain("$type.boundConformance(")
			expect(generated).toContain("$helpers.boundChoiceIs(")
		})

		// A List of a generic Choice compares through the Choice's conditional
		// conformance as a nested witness.
		it("compares two Lists of a generic Choice", async () => {
			expect(
				await run(`implementation { ${maybe}
					constant a: List<Maybe<Integer>> = [#Some({ value = 1 }), #None]
					constant b: List<Maybe<Integer>> = [#Some({ value = 1 }), #None]
					constant c: List<Maybe<Integer>> = [#Some({ value = 2 }), #None]

					Terminal.inspect(a::is(b)::toString())
					Terminal.inspect(a::is(c)::toString())
				}`),
			).toEqual(['"true"', '"false"'])
		})

		// The bound is reported where the List asks its item for equality.
		it("reports the bound at a List element site too", () => {
			expect(
				codesOf(`implementation { ${maybe}
					constant f: Maybe<(_ x: Integer) -> Integer> =
						#Some({ value = (_ x: Integer) -> Integer { <- x } })

					Terminal.inspect([f]::contains(f))
				}`),
			).toContain("unsatisfied-bound")
		})

		// Only Parameters a payload mentions are bounded, so a phantom Parameter
		// needs no equality. The Rational payload shows the witness still applies.
		it("needs no bound for a Parameter no payload mentions", async () => {
			expect(
				await run(`implementation { ${tagged}
					constant a: Tagged<Rational, (_ x: Integer) -> Integer> =
						#Val({ value = 1/2 })
					constant b: Tagged<Rational, (_ x: Integer) -> Integer> =
						#Val({ value = 2/4 })

					Terminal.inspect(a::is(b)::toString())
					Terminal.inspect(a::is(#Empty)::toString())
					Terminal.inspect([a]::contains(b)::toString())
				}`),
			).toEqual(['"true"', '"false"', '"true"'])
		})

		// The outer `Maybe`'s payload witness is the inner `Maybe`'s derive,
		// curried with Integer's equality.
		it("chains one derive's condition onto another's", async () => {
			expect(
				await run(`implementation { ${maybe}
					constant a: Maybe<Maybe<Integer>> = #Some({ value = #Some({ value = 1 }) })
					constant b: Maybe<Maybe<Integer>> = #Some({ value = #Some({ value = 1 }) })
					constant c: Maybe<Maybe<Integer>> = #Some({ value = #Some({ value = 2 }) })

					Terminal.inspect(a::is(b)::toString())
					Terminal.inspect(a::is(c)::toString())
					Terminal.inspect([a]::contains(c)::toString())
				}`),
			).toEqual(['"true"', '"false"', '"false"'])
		})

		// A written Namespace beats the derive at the call and in the witness, as
		// for a plain Choice.
		it("lets a written Namespace beat the derive for a generic Choice", async () => {
			expect(
				await run(`implementation { ${maybe}
					namespace Maybe<infer T> for Maybe<T> is Equatable {
						§§ Every Maybe is the same Maybe.
						§§
						§§ @param _ — the Maybe to compare with
						§§ @returns — always true.
						is(_ other: Maybe<T>) -> Boolean {
							<- true
						}

						§§ The negation.
						§§
						§§ @param _ — the Maybe to compare with
						§§ @returns — always false.
						isNot(_ other: Maybe<T>) -> Boolean {
							<- @::is(other)::negate()
						}
					}

					constant a: Maybe<Integer> = #Some({ value = 1 })
					constant b: Maybe<Integer> = #Some({ value = 2 })

					Terminal.inspect(a::is(b)::toString())
					Terminal.inspect(a::isNot(b)::toString())
					Terminal.inspect([a]::contains(b)::toString())
				}`),
			).toEqual(['"true"', '"false"', '"true"'])
		})

		// A generic helper and the Choice both name their Type Parameter `T`.
		// The caller's `T` must stay apart from the Choice's own.
		it("derives for a caller whose Type Parameter shares the Choice's name", async () => {
			expect(
				await run(`implementation { ${maybe}
					function same<infer T is Equatable>(_ a: Maybe<T>, _ b: Maybe<T>) -> Boolean {
						<- a::is(b)
					}

					function differs<infer T is Equatable>(_ a: Maybe<T>, _ b: Maybe<T>) -> Boolean {
						<- a::isNot(b)
					}

					constant x: Maybe<Rational> = #Some({ value = 1/2 })
					constant y: Maybe<Rational> = #Some({ value = 2/4 })
					constant z: Maybe<Rational> = #Some({ value = 1/3 })

					Terminal.inspect(same(x, y)::toString())
					Terminal.inspect(same(x, z)::toString())
					Terminal.inspect(differs(x, z)::toString())
					Terminal.inspect(same(x, #None)::toString())
				}`),
			).toEqual(['"true"', '"false"', '"true"', '"false"'])
		})

		// Collisions are per name, so a partly colliding caller works too.
		it("derives where only some of the caller's names collide", async () => {
			expect(
				await run(`implementation {
					choice Pair<A, B> { Both { a: A, b: B }, Neither }

					function same<infer A is Equatable, infer Z is Equatable>(
						_ x: Pair<A, Z>,
						_ y: Pair<A, Z>,
					) -> Boolean {
						<- x::is(y)
					}

					constant p: Pair<Rational, String> = #Both({ a = 1/2, b = "x" })
					constant q: Pair<Rational, String> = #Both({ a = 2/4, b = "x" })
					constant r: Pair<Rational, String> = #Both({ a = 2/4, b = "y" })

					Terminal.inspect(same(p, q)::toString())
					Terminal.inspect(same(p, r)::toString())
				}`),
			).toEqual(['"true"', '"false"'])
		})

		// A missing bound is reported the same way under a colliding name.
		it("names the missing bound the same way under a colliding name", () => {
			const unbounded = (parameter: string) =>
				`implementation { ${maybe}
					function same<infer ${parameter}>(
						_ a: Maybe<${parameter}>,
						_ b: Maybe<${parameter}>,
					) -> Boolean {
						<- a::is(b)
					}
				}`

			expect(codesOf(unbounded("T"))).toEqual(["unsatisfied-bound"])
			expect(messagesOf(unbounded("T"))).toEqual([
				"Type Parameter 'T' does not conform to 'Equatable'",
			])
			expect(codesOf(unbounded("Elem"))).toEqual(["unsatisfied-bound"])
		})

		// The List witness handles a colliding name too.
		it("takes a colliding name through the List witness too", async () => {
			expect(
				await run(`implementation { ${maybe}
					function has<infer T is Equatable>(_ xs: List<Maybe<T>>, _ b: Maybe<T>) -> Boolean {
						<- xs::contains(b)
					}

					constant x: Maybe<Rational> = #Some({ value = 1/2 })
					constant y: Maybe<Rational> = #Some({ value = 2/4 })
					constant z: Maybe<Rational> = #Some({ value = 1/3 })

					Terminal.inspect(has([x], y)::toString())
					Terminal.inspect(has([x], z)::toString())
				}`),
			).toEqual(['"true"', '"false"'])
		})

		// Without `infer` the Namespace's Type Parameter binds nothing, so it
		// would match no receiver and the derive would answer instead. The
		// declaration is refused.
		it("refuses a written Namespace that forgot 'infer' rather than deriving past it", () => {
			expect(
				codesOf(`implementation { ${maybe}
					namespace Maybe<T> for Maybe<T> is Equatable {
						§§ Every Maybe is the same Maybe.
						§§
						§§ @param _ — the Maybe to compare with
						§§ @returns — always true.
						is(_ other: Maybe<T>) -> Boolean {
							<- true
						}

						§§ The negation.
						§§
						§§ @param _ — the Maybe to compare with
						§§ @returns — always false.
						isNot(_ other: Maybe<T>) -> Boolean {
							<- false
						}
					}

					constant a: Maybe<Integer> = #Some({ value = 1 })

					Terminal.inspect(a::is(a)::toString())
				}`),
			).toEqual(["uninferred-namespace-parameter"])
		})

		// A generic Record needs no derive: its members compare by their own
		// Types, so a Rational member compares as a Rational.
		it("leaves a generic Record comparing structurally", async () => {
			expect(
				await run(`implementation {
					type Boxed<Item> = { value: Item }

					constant a: Boxed<Rational> = { value = 1/2 }
					constant b: Boxed<Rational> = { value = 2/4 }
					constant c: Boxed<Rational> = { value = 1/3 }

					Terminal.inspect(a::is(b)::toString())
					Terminal.inspect(a::is(c)::toString())
					Terminal.inspect([a]::contains(b)::toString())
				}`),
			).toEqual(['"true"', '"false"', '"true"'])
		})

		// A `T | List<T>` payload has two arms mentioning `T`. The receiver's Type
		// Arguments tell them apart, so a List is not compared through `T`'s
		// witness.
		describe("Several generic arms in one payload", () => {
			const wrapped = `choice Wrapped<T is Equatable> {
				Val { v: T | List<T> },
				None,
			}`

			it("tells a Parameter's values from a List of them", async () => {
				expect(
					await run(`implementation { ${wrapped}
						constant listA: Wrapped<Integer> = #Val({ v = [2] })
						constant listB: Wrapped<Integer> = #Val({ v = [10] })
						constant listC: Wrapped<Integer> = #Val({ v = [2] })
						constant plain: Wrapped<Integer> = #Val({ v = 2 })

						Terminal.inspect(listA::is(listB)::toString())
						Terminal.inspect(listA::is(listC)::toString())
						Terminal.inspect(listA::is(plain)::toString())
						Terminal.inspect(plain::is(listA)::toString())
					}`),
				).toEqual(['"false"', '"true"', '"false"', '"false"'])
			})

			it("compares each arm by the equality its own Type has", async () => {
				expect(
					await run(`implementation {
						choice Wrapped<T is Equatable> {
							Val { v: T | List<T> },
							None,
						}

						constant a: Wrapped<Rational> = #Val({ v = [1/2] })
						constant b: Wrapped<Rational> = #Val({ v = [2/4] })

						Terminal.inspect(a::is(b)::toString())
					}`),
				).toEqual(['"true"'])
			})

			// Where the Type Argument is a Type Parameter, as inside generic code,
			// no descriptor can tell the arms apart, so the comparison is refused.
			// The whole list is asserted, since the derive must see the caller's
			// bounded `T`, not the Choice's.
			it("refuses the comparison where no Type Argument tells them apart", () => {
				expect(
					codesOf(`implementation { ${wrapped}
						function same <infer T is Equatable>(_ w: Wrapped<T>) -> Boolean {
							<- match w -> Boolean {
								case #Val  { <- true }
								case #None { <- @::is(@) }
							}
						}
					}`),
				).toEqual(["indistinguishable-union-arms"])
			})

			// A single generic arm is a plain fallback with no shape.
			it("leaves a single generic arm carrying no shape", () => {
				let generated = generate(`implementation {
					choice Opt<T is Equatable> { Holding { value: T | String } }

					constant a: Opt<Integer> = #Holding({ value = 1 })

					Terminal.inspect(a::is(a))
				}`)

				expect(generated).toContain('"tag": null')
				expect(generated).not.toContain('"shape"')
			})
		})

		// A non-generic Choice carries no descriptor and emits the flat helper.
		it("leaves a non-generic Choice emitting the flat helper", () => {
			let generated = generate(
				`implementation {
				choice Colour { Red, Green }

				constant red: Colour = #Red

				Terminal.inspect(red::is(#Green))
			}`,
				withoutLoweredUnitCaseEquality,
			)

			expect(generated).toContain("$helpers.choiceIs(red,")
			expect(generated).not.toContain("boundChoiceIs")
		})
	})

	describe("Code Generation", () => {
		it("emits the runtime helper for a derived 'is'", () => {
			let generated = generate(
				`implementation {
				choice Colour { Red, Green }

				constant red: Colour = #Red

				Terminal.inspect(red::is(#Green))
				Terminal.inspect(red::isNot(#Green))
			}`,
				withoutLoweredUnitCaseEquality,
			)

			expect(generated).toContain("$helpers.choiceIs(")
			expect(generated).toContain("$helpers.choiceIsNot(")
		})

		// The witness is the written Method too, or a bounded call and a direct
		// one would disagree. The spec reads Colour's call sites, since the
		// library's own Choices bring `choiceIs` in anyway.
		it("emits the written Method at the call AND in the witness", () => {
			let generated = generate(`implementation {
				choice Colour { Red, Green }

				namespace Colour for Colour is Equatable {
					§§ Every Colour is the same Colour.
					§§
					§§ @param _ — the Colour to compare with
					§§ @returns — always true.
					is(_ other: Colour) -> Boolean {
						<- true
					}

					§§ The negation.
					§§
					§§ @param _ — the Colour to compare with
					§§ @returns — always false.
					isNot(_ other: Colour) -> Boolean {
						<- @::is(other)::negate()
					}
				}

				constant red: Colour = #Red

				Terminal.inspect(red::is(#Green))
				Terminal.inspect([red]::contains(#Green))
			}`)

			expect(generated).toContain("Colour.is(red,")
			expect(generated).toContain("is: Colour.is")
			// A written `isNot` replaces the provided one in the witness too.
			expect(generated).toContain("isNot: Colour.isNot")
		})

		// One helper serves every Choice, rather than a `match` per Choice.
		it("emits the runtime helper for a derived 'toString'", () => {
			let generated = generate(`implementation {
				choice Colour { Red, Green }

				namespace Colour for Colour is Printable { }

				constant red: Colour = #Red

				Terminal.print(red::toString())
				Terminal.print(red)
			}`)

			expect(generated).toContain("$helpers.choiceName(")
			expect(generated).toContain("toString: $helpers.choiceName")
			expect(generated).not.toContain('"Red"')
		})

		it("emits tagged Case constructions", () => {
			// Printed, since `eliminate-dead-code` drops a Constant nothing reads.
			let generated = generate(`implementation { ${calculatorChoice}
				constant operation: CalculatorOperation = CalculatorOperation#Add({ left = 1, right = 1 })
				constant cleared: CalculatorOperation = CalculatorOperation#ClearAll

				Terminal.inspect(operation)
				Terminal.inspect(cleared)
			}`)

			// `collapse-construction` builds a payload Case in one object literal.
			expect(generated).toContain(
				'[$type.typeKeySymbol]: "CalculatorOperation#Add"',
			)
			// A unit Case keeps `createCase`, which hands out one instance per tag.
			expect(generated).toContain(
				'$type.createCase("CalculatorOperation#ClearAll")',
			)
		})

		it("emits nominal Case Matchers", () => {
			const source = `implementation { ${calculatorChoice}
				constant operation: CalculatorOperation = CalculatorOperation#ClearAll

				Terminal.inspect(match operation -> Integer {
					case #Add { <- @.left }
					case _ { <- 0 }
				})
			}`

			// `compile-type-tests` reduces the Matcher to a tag test. `#Add` is the
			// only member carrying that tag, and the Matcher does not narrow its
			// Integer payload.
			expect(generate(source)).toContain(
				'_self[$type.typeKeySymbol] === "CalculatorOperation#Add"',
			)

			// Without the pass, the runtime walks a descriptor.
			let unoptimised = generate(source, withoutCompiledTypeTests)

			expect(unoptimised).toContain('type: "Case"')
			expect(unoptimised).toContain('choice: "CalculatorOperation"')
			expect(unoptimised).toContain('name: "Add"')
		})

		it("erases the Choice Declaration itself", () => {
			let generated = generate(`implementation {
				choice Simple { Go }
			}`)

			expect(generated).not.toContain("Simple")
		})
	})

	// A construction resolves to the declared Case, and its position
	// instantiates it, so the value carries a concrete CaseType.
	describe("Generic Case Instantiation", () => {
		it("instantiates a constructed Case from the position it stands in", () => {
			let type = valueTypeOf(
				`implementation { ${progressChoice}
					constant done: Progress<Integer, String> = Progress#Stopped({ value = "x" })
				}`,
				"done",
			) as common.CaseType

			expect(type.type).toBe("Case")
			expect(type.name).toBe("Stopped")
			expect(type.members.value).toEqual({ type: "String" })
			expect(type.typeArguments).toEqual([
				{ type: "Integer" },
				{ type: "String" },
			])
			// An instantiated Case drops the declared-only `choiceGenerics`.
			expect(type.choiceGenerics).toBeUndefined()
		})

		// The annotation decides every Generic, including one no member
		// mentions.
		it("decides a Generic no payload mentions", () => {
			let type = valueTypeOf(
				`implementation {
					choice Box<Value> { Full { value: Value }, Empty }
					constant empty: Box<Integer> = Box#Empty
				}`,
				"empty",
			) as common.CaseType

			expect(type.name).toBe("Empty")
			expect(type.typeArguments).toEqual([{ type: "Integer" }])
			expect(type.choiceGenerics).toBeUndefined()
		})

		it("accepts a value of the same instantiation", () => {
			expect(
				messagesOf(`implementation { ${progressChoice}
					constant a: Progress<Integer, String> = #Stopped("x")
					constant b: Progress<Integer, String> = a
				}`),
			).toEqual([])
		})

		// Plain assignability refuses another instantiation, since it compares
		// Case members rather than the shared tag.
		it("rejects a value of a different instantiation", () => {
			expect(
				messagesOf(`implementation { ${progressChoice}
					constant done: Progress<Integer, String> = #Stopped("x")
					constant wrong: Progress<String, Integer> = done
				}`),
			).toContain(
				"This value does not fit the declared Type of Constant 'wrong'",
			)
		})

		it("narrows instantiated Cases to their concrete member Types", () => {
			expect(
				messagesOf(`implementation { ${progressChoice}
					constant step: Progress<Integer, String> = #Going({ state = 5 })

					Terminal.inspect(match step -> String {
						case #Going { <- @.state::toString() }
						case #Stopped { <- @.value }
					})
				}`),
			).toEqual([])
		})

		it("rejects the wrong member Type when narrowing an instantiated Case", () => {
			expect(
				messagesOf(`implementation { ${progressChoice}
					constant step: Progress<Integer, String> = #Going({ state = 5 })

					Terminal.inspect(match step -> String {
						case #Going { <- @.state::append("!") }
						case #Stopped { <- @.value }
					})
				}`),
			).not.toEqual([])
		})
	})

	// `#Case(value)` on a single-member Case is wrapped into the one-member
	// Record. A payload that already fits the Record is not rewrapped.
	describe("Single-member Shorthand", () => {
		it("wraps a bare value for a single-member Case", () => {
			expect(
				messagesOf(`implementation { ${progressChoice}
					constant done: Progress<String, Integer> = #Stopped(5)
				}`),
			).toEqual([])
		})

		it("emits the same Record whether written long or short", () => {
			// Printed, since `eliminate-dead-code` drops a Constant nothing reads.
			let short = generate(`implementation { ${progressChoice}
				constant done: Progress<String, Integer> = #Stopped(5)

				Terminal.inspect(done)
			}`)
			let long = generate(`implementation { ${progressChoice}
				constant done: Progress<String, Integer> = #Stopped({ value = 5 })

				Terminal.inspect(done)
			}`)

			expect(short).toContain('[$type.typeKeySymbol]: "Progress#Stopped"')
			expect(short).toContain("value")
			expect(long).toContain('[$type.typeKeySymbol]: "Progress#Stopped"')
			// The shorthand is rewrapped into the long form's Record, so both emit
			// the same text.
			expect(short).toBe(long)
		})

		it("reads a Record that fits the shape as the Record, not the value", () => {
			expect(
				messagesOf(`implementation {
					choice Wrap { Only { inner: { a: Integer } } }
					constant explicit: Wrap = #Only({ inner = { a = 1 } })
				}`),
			).toEqual([])
		})

		it("wraps a Record that only fits the member Type", () => {
			expect(
				messagesOf(`implementation {
					choice Wrap { Only { inner: { a: Integer } } }
					constant shorthand: Wrap = #Only({ a = 1 })
				}`),
			).toEqual([])
		})

		it("keeps the unit-Case diagnostic for a zero-member Case", () => {
			expect(
				messagesOf(`implementation {
					choice Box<Value> { Full { value: Value }, Empty }
					constant boxed: Box<Integer> = Box#Empty({ value = 1 })
				}`),
			).toContain("Case '#Empty' does not carry a payload")
		})

		it("keeps the mismatch diagnostic for a multi-member Case, with the shorthand hint", () => {
			let source = `implementation {
				choice Pair { Both { left: Integer, right: Integer } }
				constant pair = #Both(5)
			}`

			expect(messagesOf(source)).toContain(
				"This payload does not fit Case '#Both'",
			)
			expect(helpsOf(source)).toContain(
				"The one-member shorthand '#Case(value)' only applies to single-member Cases.",
			)
		})

		it("does not add the shorthand hint to a single-member mismatch", () => {
			let source = `implementation {
				choice Wrap { Only { value: Integer } }
				constant wrong = #Only("text")
			}`

			expect(messagesOf(source)).toContain(
				"This payload does not fit Case '#Only'",
			)
			expect(helpsOf(source)).not.toContain(
				"The one-member shorthand '#Case(value)' only applies to single-member Cases.",
			)
		})
	})

	// A user's generic Choice and a static Method shaped like `loop`, with the
	// callback's `Result` inferred through the `#Stopped` payload.
	describe("End-to-end Inference", () => {
		const driver = `${progressChoice}
			namespace Loop {
				static run<infer State, infer Result>(
					startingWith state: State,
					step advance: (_ state: State) -> Progress<State, Result>,
				) -> Result {
					<- match advance(state) -> Result {
						case #Going { <- Loop.run(startingWith @.state, step advance) }
						case #Stopped { <- @.value }
					}
				}
			}
		`

		it("infers the callback Parameter from startingWith and binds Result through the payload", () => {
			expect(
				messagesOf(`implementation { ${driver}
					constant total: Integer = Loop.run(
						startingWith { index = 1, total = 0 },
						step (state) {
							if state.index::isGreaterThan(3) { <- #Stopped(state.total) }

							<- #Going({ state with
								index = state.index::add(1),
								total = state.total::add(state.index),
							})
						})

					Terminal.inspect(total::toString())
				}`),
			).toEqual([])
		})

		it("binds the invocation's return Type to the payload Type of #Stopped", () => {
			expect(
				valueTypeOf(
					`implementation { ${driver}
						constant total = Loop.run(
							startingWith 0,
							step (state) { <- #Stopped(state::toString()) })
					}`,
					"total",
				),
			).toEqual({ type: "String" })
		})

		it("reports an unbound Result for a callback that never returns #Stopped", () => {
			expect(
				codesOf(`implementation { ${driver}
					constant looped = Loop.run(
						startingWith 0,
						step (state) { <- #Going({ state = state::add(1) }) })
				}`),
			).toContain("uninferable-type-parameter")
		})

		it("compiles and runs the driver, summing through the threaded State", async () => {
			expect(
				await run(`implementation { ${driver}
					constant total: Integer = Loop.run(
						startingWith { index = 1, total = 0 },
						step (state) {
							if state.index::isGreaterThan(5) { <- #Stopped(state.total) }

							<- #Going({ state with
								index = state.index::add(1),
								total = state.total::add(state.index),
							})
						})

					Terminal.inspect(total::toString())
				}`),
			).toEqual(['"15"'])
		})

		it("compiles and runs GenericChoice.es end to end", async () => {
			let source = readFileSync(fixturePath("GenericChoice.es"), {
				encoding: "utf-8",
			})

			expect(await run(source)).toEqual([
				"0",
				'"15"',
				"42",
				'"packed"',
				'"nothing"',
			])
		})
	})

	// In `case #Value(item)` the binder names what the constructor takes, and
	// `@` still reads the whole Case.
	describe("Case Matcher payload bindings", () => {
		const shape = `choice Shape {
				Circle { radius: Integer },
				Rect { width: Integer, height: Integer },
				Dot,
			}`

		it("binds the payload of a one-member Case", async () => {
			expect(
				await run(`implementation {
					${shape}

					constant drawn: Shape = #Circle(3)

					Terminal.inspect(match drawn -> Integer {
						case #Circle(radius) { <- radius }
						case #Rect           { <- 0 }
						case #Dot            { <- 0 }
					})
				}`),
			).toEqual(["3"])
		})

		it("leaves '@' meaning the whole Case alongside a binding", async () => {
			expect(
				await run(`implementation {
					${shape}

					constant drawn: Shape = #Circle(4)

					Terminal.inspect(match drawn -> String {
						case #Circle(radius) {
							<- "{radius} / {@.radius}"
						}
						case #Rect { <- "" }
						case #Dot  { <- "" }
					})
				}`),
			).toEqual(['"4 / 4"'])
		})

		it("hands the whole Case onwards from a bound arm", async () => {
			// `@` stays the Case, so passing it on needs no rebuilt Case.
			expect(
				await run(`implementation {
					${shape}

					constant drawn: Shape = #Circle(5)

					constant same = match drawn -> Shape {
						case #Circle(radius) { <- @ }
						case #Rect           { <- @ }
						case #Dot            { <- @ }
					}

					Terminal.inspect(match same -> Integer {
						case #Circle(radius) { <- radius }
						case #Rect           { <- 0 }
						case #Dot            { <- 0 }
					})
				}`),
			).toEqual(["5"])
		})

		it("refuses a binding on a Case that carries nothing", () => {
			let source = `implementation {
				${shape}

				constant drawn: Shape = #Dot

				Terminal.inspect(match drawn -> Integer {
					case #Circle { <- 0 }
					case #Rect   { <- 0 }
					case #Dot(what) { <- 0 }
				})
			}`

			expect(diagnosticsOf(source).map(({ code }) => code)).toContain(
				"unbindable-case-payload",
			)
			expect(labelsOf(source)).toContain("this Case carries no value")
			expect(helpsOf(source)).toContain(
				"Drop the binding — the Matcher alone is the test.",
			)
			expect(
				compiles(source.replace("case #Dot(what)", "case #Dot")),
			).toBe(true)
		})

		// A multi-member Case has no single value to bind a name to, so the
		// Help offers a Pattern that takes it apart.
		it("refuses a NAME on a Case that carries several, naming them", () => {
			let source = `implementation {
				${shape}

				constant drawn: Shape = #Dot

				Terminal.inspect(match drawn -> Integer {
					case #Circle    { <- 0 }
					case #Rect(box) { <- 0 }
					case #Dot       { <- 0 }
				})
			}`

			expect(diagnosticsOf(source).map(({ code }) => code)).toContain(
				"unbindable-case-payload",
			)
			expect(notesOf(source)).toContain(
				"Its values are 'width', 'height'.",
			)
			expect(helpsOf(source)).toContain(
				"Take the payload apart instead: '#Rect({ width, height })'.",
			)
			expect(
				compiles(
					source.replace(
						"case #Rect(box)",
						"case #Rect({ width, height })",
					),
				),
			).toBe(true)
		})

		it("lets a Guard name the binding", async () => {
			// The Guard runs in the Handler's test, before the body's constant
			// exists, so the name reads `@.radius` there. The Matcher's own check
			// runs first.
			expect(
				await run(`implementation {
					${shape}

					function describe(_ shape: Shape) -> String {
						<- match shape -> String {
							case #Circle(radius) where radius::isLessThan(2) {
								<- "small {radius}"
							}
							case #Circle(radius) { <- "big {radius}" }
							case #Rect           { <- "rect" }
							case #Dot            { <- "dot" }
						}
					}

					Terminal.inspect(describe(#Circle(1)))
					Terminal.inspect(describe(#Circle(9)))
				}`),
			).toEqual(['"small 1"', '"big 9"'])
		})

		it("lets a Handler's own binding shadow the one a Guard was lent", async () => {
			// The callback's own Parameter `radius` shadows the binding inside
			// the callback.
			expect(
				await run(`implementation {
					${shape}

					constant drawn: Shape = #Circle(3)

					Terminal.inspect(match drawn -> String {
						case #Circle(radius) where [10, 20]::hasItems(where (radius) {
							<- radius::isGreaterThan(15)
						}) {
							<- "guarded {radius}"
						}
						case #Circle(radius) { <- "plain {radius}" }
						case #Rect           { <- "rect" }
						case #Dot            { <- "dot" }
					})
				}`),
			).toEqual(['"guarded 3"'])
		})

		it("does not leak the binding into a sibling Handler's Guard", () => {
			expect(
				diagnosticsOf(`implementation {
					${shape}

					constant drawn: Shape = #Dot

					Terminal.inspect(match drawn -> Integer {
						case #Circle(radius)                    { <- radius }
						case #Rect where radius::isLessThan(2)  { <- 0 }
						case #Dot                               { <- 0 }
					})
				}`).map(({ code }) => code),
			).toContain("unknown-name")
		})

		it("does not leak the binding into a sibling Handler", () => {
			expect(
				diagnosticsOf(`implementation {
					${shape}

					constant drawn: Shape = #Dot

					Terminal.inspect(match drawn -> Integer {
						case #Circle(radius) { <- radius }
						case #Rect           { <- radius }
						case #Dot            { <- 0 }
					})
				}`).map(({ code }) => code),
			).toContain("unknown-name")
		})
	})

	// A payload default travels on the Case Type and is spliced into each
	// construction. See "Case payload defaults" in
	// packages/compiler/src/enricher/DEVELOPMENT.md.
	describe("Case payload defaults", () => {
		let fetchChoice = `choice Fetch {
			Get { url: String, retries: Integer } = { retries = 0 },
			Blank { tags: List<String>, title: String } = { tags = [], title = "" },
		}`

		it("carries the members the default fills in on the Case Type", () => {
			let union = declaredTypeOf(
				`implementation { ${fetchChoice} }`,
				"Fetch",
			) as common.UnionType
			let cases = union.types as Array<common.CaseType>

			expect(cases[0].payloadDefault?.members).toEqual(["retries"])
			expect(cases[1].payloadDefault?.members).toEqual(["tags", "title"])
		})

		it("accepts a payload that leaves the defaulted members out", () => {
			expect(
				messagesOf(`implementation { ${fetchChoice}
					constant call: Fetch = #Get({ url = "/x" })
				}`),
			).toEqual([])
		})

		it("fills the members the payload left out", async () => {
			expect(
				await run(`implementation { ${fetchChoice}
					constant call: Fetch = #Get({ url = "/x" })

					Terminal.inspect(call)
				}`),
			).toEqual(['Fetch#Get { url = "/x", retries = 0 }'])
		})

		// `Call#Post { host = …, body = "x" }`, as the Case declares it, alone
		// and as a member.
		it("prints a defaulted member in its declared place", async () => {
			expect(
				await run(`implementation {
					choice Call {
						Post { host: String, body: String, port: Integer } = {
							host = "h",
							port = 80,
						},
					}

					constant call = Call#Post({ body = "x" })

					Terminal.inspect(call)
					Terminal.inspect({ call })
				}`),
			).toEqual([
				'Call#Post { host = "h", body = "x", port = 80 }',
				'{ call = Call#Post { host = "h", body = "x", port = 80 } }',
			])
		})

		// A Record Literal evaluates its members as written, so a payload
		// written out of declared order keeps its order.
		it("keeps the order of the written members", async () => {
			expect(
				await run(`implementation {
					choice Call {
						Post { server: String, body: String, port: Integer } = {
							port = 80,
						},
					}

					Terminal.inspect(Call#Post({ body = "x", server = "s" }))
				}`),
			).toEqual(['Call#Post { body = "x", server = "s", port = 80 }'])
		})

		it("leaves a member the payload wrote alone", async () => {
			expect(
				await run(`implementation { ${fetchChoice}
					constant call: Fetch = #Get({ url = "/x", retries = 3 })

					Terminal.inspect(call)
				}`),
			).toEqual(['Fetch#Get { url = "/x", retries = 3 }'])
		})

		// A payload merges into its default as an Argument does into a
		// Parameter's, so it takes path keys. The merge is spliced per site.
		describe("a path key in a payload", () => {
			let limited = `type Limits = { calls: Integer, burst: Integer }

				choice Fetch {
					Get { url: String, limits: Limits } = {
						limits = { calls = 1, burst = 2 },
					},
				}`

			it("merges into the member the default fills in", async () => {
				expect(
					await run(`implementation { ${limited}
						constant call: Fetch = #Get({ url = "/x", limits.calls = 5 })

						Terminal.inspect(call)
					}`),
				).toEqual([
					'Fetch#Get { url = "/x", limits = { calls = 5, burst = 2 } }',
				])
			})

			// A defaulted member takes its declared place at every level.
			it("takes a braced descend the same way", async () => {
				expect(
					await run(`implementation { ${limited}
						constant call: Fetch = #Get({ url = "/x", limits.{ burst = 9 } })

						Terminal.inspect(call)
					}`),
				).toEqual([
					'Fetch#Get { url = "/x", limits = { calls = 1, burst = 9 } }',
				])
			})

			// A member written whole replaces the default rather than merging.
			it("leaves a member written whole a replacement", async () => {
				expect(
					await run(`implementation { ${limited}
						constant call: Fetch = #Get({
							url = "/x",
							limits = { calls = 7, burst = 8 },
						})

						Terminal.inspect(call)
					}`),
				).toEqual([
					'Fetch#Get { url = "/x", limits = { calls = 7, burst = 8 } }',
				])
			})

			it("refuses a path into a member no default fills in", () => {
				expect(
					codesOf(`implementation {
						type Limits = { calls: Integer, burst: Integer }

						choice Fetch {
							Get { limits: Limits, quota: Limits } = {
								limits = { calls = 1, burst = 2 },
							},
						}

						constant call: Fetch = #Get({
							limits.calls = 5,
							quota.calls = 1,
						})
					}`),
				).toContain("path-key-without-default")
			})
		})

		it("builds a wholly defaulted payload from an empty Record", async () => {
			expect(
				await run(`implementation { ${fetchChoice}
					constant call: Fetch = #Blank({})

					Terminal.inspect(call)
				}`),
			).toEqual(['Fetch#Blank { tags = [], title = "" }'])
		})

		// A bare `#Case` stays a unit Case's spelling however much of the payload
		// is defaulted, as the marshaller's bare-Case strings assume.
		it("still refuses a bare Case whose payload is defaulted in full", () => {
			expect(
				codesOf(`implementation { ${fetchChoice}
					constant call: Fetch = #Blank
				}`),
			).toContain("missing-payload")
			expect(
				helpsOf(`implementation { ${fetchChoice}
					constant call: Fetch = #Blank
				}`),
			).toEqual([
				"Its default fills every member in — write '#Blank({})'.",
			])
			expect(
				compiles(`implementation { ${fetchChoice}
					constant call: Fetch = #Blank({})
				}`),
			).toBe(true)
		})

		// The shape is spelled with a blank per member, filled in here.
		it("follows the missing payload's Help to a Program that compiles", () => {
			let written = `implementation { ${fetchChoice}
				constant call = Fetch#Get
			}`

			expect(helpsOf(written)).toEqual([
				"Write the payload, filling each member in: '#Get({ url = …, retries = … })'.",
			])
			expect(
				compiles(`implementation { ${fetchChoice}
				constant call = Fetch#Get({ url = "a", retries = 1 })
			}`),
			).toBe(true)
		})

		it("follows the unexpected payload's Help to a Program that compiles", () => {
			let written = `implementation { ${fetchChoice}
				choice Signal { Ping, Pong }

				constant signal: Signal = #Ping(1)
			}`

			expect(codesOf(written)).toEqual(["unexpected-payload"])
			expect(helpsOf(written)).toEqual(["Write '#Ping' on its own."])
			expect(compiles(written.replace("#Ping(1)", "#Ping"))).toBe(true)
		})

		it("names the members a payload had to write and did not", () => {
			let reported = diagnosticsOf(`implementation { ${fetchChoice}
				constant call: Fetch = #Get({})
			}`)

			expect(reported.map(({ code }) => code)).toEqual([
				"incomplete-record-argument",
			])
			expect(reported[0].message).toBe(
				"This payload is missing 1 member the default does not fill in",
			)
		})

		// The same `data` an Argument's partial carries, so one scaffold answers
		// both.
		it("carries those members as data for the scaffold", () => {
			expect(
				diagnosticsOf(`implementation { ${fetchChoice}
					constant call: Fetch = #Get({})
				}`)[0].data,
			).toEqual({ kind: "missing-members", names: ["url"] })
		})

		// A member of the wrong Type is no partial, so the payload is measured
		// whole.
		it("keeps payload-type-mismatch for a member of the wrong Type", () => {
			expect(
				codesOf(`implementation { ${fetchChoice}
					constant call: Fetch = #Get({ url = 1 })
				}`),
			).toContain("payload-type-mismatch")
		})

		// Only a Record Literal payload may leave a member out. Any other value
		// may carry members its Type does not name, which the splice would
		// overwrite.
		it("refuses a partial payload that is not a Record Literal", () => {
			expect(
				codesOf(`implementation { ${fetchChoice}
					constant partial = { url = "/x" }
					constant call: Fetch = #Get(partial)
				}`),
			).toContain("payload-type-mismatch")
		})

		it("refuses a default that names a member the payload does not declare", () => {
			expect(
				codesOf(`implementation {
					choice Fetch {
						Get { url: String } = { retries = 0 },
					}
				}`),
			).toContain("default-type-mismatch")
		})

		it("refuses a default whose member is of another Type", () => {
			expect(
				codesOf(`implementation {
					choice Fetch {
						Get { url: String, retries: Integer } = { retries = "none" },
					}
				}`),
			).toContain("default-type-mismatch")
		})

		// A written member is evidence for a refined member, however deep it
		// stands, and only where the predicate holds of it.
		it("admits a default whose written member proves a refinement", async () => {
			expect(
				await run(`implementation {
					type Server = { port: PositiveInteger, host: String }

					choice Call {
						Post { server: Server, body: String } = { server = { port = 80, host = "a" } },
						Idle,
					}

					constant call: Call = #Post({ body = "x" })

					Terminal.inspect(call)
				}`),
			).toEqual([
				'Call#Post { server = { port = 80, host = "a" }, body = "x" }',
			])
			expect(
				codesOf(`implementation {
					type Server = { port: PositiveInteger, host: String }

					choice Call {
						Post { server: Server, body: String } = { server = { port = 0, host = "a" } },
						Idle,
					}
				}`),
			).toEqual(["default-type-mismatch"])
		})

		it("refuses a default that is not a Record Literal", () => {
			expect(
				codesOf(`implementation {
					constant blank = { retries = 0 }

					choice Fetch {
						Get { url: String, retries: Integer } = blank,
					}
				}`),
			).toContain("case-default-not-a-literal")
		})

		it("refuses a default value that is worked out where it stands", () => {
			expect(
				codesOf(`implementation {
					constant sizes = [1, 2, 3]

					choice Fetch {
						Get { url: String, retries: Integer } = { retries = sizes::length() },
					}
				}`),
			).toContain("case-default-not-a-literal")
		})

		// A Constant of the declaring Module is read at the declaration and its
		// value baked into the Case Type as data.
		describe("a default value that names a Constant", () => {
			it("bakes the Constant's value in", async () => {
				expect(
					await run(`implementation {
						constant standardHeaders: List<String> = ["Accept"]

						choice Fetch {
							Get { url: String, headers: List<String> } = {
								headers = standardHeaders,
							},
						}

						constant call: Fetch = #Get({ url = "/x" })

						Terminal.inspect(call)
					}`),
				).toEqual(['Fetch#Get { url = "/x", headers = [ "Accept" ] }'])
			})

			it("follows one Constant through to the next", async () => {
				expect(
					await run(`implementation {
						constant defaultCalls = 10
						constant baseLimits = { calls = defaultCalls }

						choice Fetch {
							Get { url: String, limits: { calls: Integer } } = {
								limits = baseLimits,
							},
						}

						constant call: Fetch = #Get({ url = "/x" })

						Terminal.inspect(call)
					}`),
				).toEqual(['Fetch#Get { url = "/x", limits = { calls = 10 } }'])
			})

			it("bakes a Case value a Constant holds", async () => {
				expect(
					await run(`implementation {
						choice Mode { Loud, Quiet }

						constant defaultMode: Mode = #Quiet

						choice Fetch {
							Get { url: String, mode: Mode } = { mode = defaultMode },
						}

						constant call: Fetch = #Get({ url = "/x" })

						Terminal.inspect(call)
					}`),
				).toEqual(['Fetch#Get { url = "/x", mode = Mode#Quiet }'])
			})

			it("refuses a Constant whose value is worked out", () => {
				let reported = diagnosticsOf(`implementation {
					constant sizes = [1, 2, 3]
					constant biggest = sizes::length()

					choice Fetch {
						Get { url: String, retries: Integer } = { retries = biggest },
					}
				}`)

				expect(reported.map(({ code }) => code)).toEqual([
					"case-default-not-a-literal",
				])
				expect(reported[0].message).toBe(
					"The Constant 'biggest' does not hold a literal",
				)
			})

			// The refusal follows the chain of Constants and reports at the name
			// the default wrote.
			it("refuses a Constant that reaches a worked-out value", () => {
				let reported = diagnosticsOf(`implementation {
					constant sizes = [1, 2, 3]
					constant biggest = sizes::length()
					constant baseLimits = { calls = biggest }

					choice Fetch {
						Get { url: String, limits: { calls: Integer } } = {
							limits = baseLimits,
						},
					}
				}`)

				expect(reported.map(({ code }) => code)).toEqual([
					"case-default-not-a-literal",
				])
				expect(reported[0].message).toBe(
					"The Constant 'baseLimits' does not hold a literal",
				)
			})

			// A Constant bound by a Pattern reads a member off a value, so it holds
			// no literal and is refused as such.
			it("refuses a Constant a Pattern Declaration binds", () => {
				let reported = diagnosticsOf(`implementation {
					constant sizes = { small = 1, large = 9 }
					constant { small } = sizes

					choice Fetch {
						Get { url: String, retries: Integer } = { retries = small },
					}
				}`)

				expect(reported.map(({ code }) => code)).toEqual([
					"case-default-not-a-literal",
				])
				expect(reported[0].message).toBe(
					"The Constant 'small' does not hold a literal",
				)
				// The binding's value stands at its name's span, so no separate
				// declaration label is added.
				expect(reported[0].labels).toHaveLength(2)
			})

			it("refuses a Variable", () => {
				let reported = diagnosticsOf(`implementation {
					variable attempts = 0

					choice Fetch {
						Get { url: String, retries: Integer } = { retries = attempts },
					}
				}`)

				expect(reported.map(({ code }) => code)).toEqual([
					"case-default-not-a-literal",
				])
				expect(reported[0].message).toBe(
					"'attempts' is not a Constant of this Module",
				)
			})

			// Each standard library file has its own top-level Scope, so the rule
			// holds there too. The loader throws on any Diagnostic, so loading is
			// the assertion.
			it("holds in a standard library file", () => {
				expect(() =>
					loadStdlibFrom([
						parseStdlibSource(
							"Synthetic.es",
							`declarations {
								constant standardHeaders: List<String> = []

								choice Fetch {
									Get {
										url: String,
										headers: List<String>,
									} = { headers = standardHeaders },
								}
							}`,
						),
					]),
				).not.toThrow()
			})

			// A Constant does not hoist and the default is read at the Choice, so
			// a later Constant is an `unknown-name`.
			it("refuses a Constant declared below the Choice", () => {
				expect(
					codesOf(`implementation {
						choice Fetch {
							Get { url: String, retries: Integer } = { retries = later },
						}

						constant later = 3
					}`),
				).toEqual(["unknown-name"])
			})

			// The Constant is read off its declaring Scope, so a closer binding
			// that shadows it answers nothing.
			it("refuses a binding that shadows a Constant", () => {
				expect(
					codesOf(`implementation {
						constant retryCount = 3

						function build() -> Integer {
							constant retryCount = 9

							choice Fetch {
								Get { url: String, retries: Integer } = {
									retries = retryCount,
								},
							}

							<- 0
						}
					}`),
				).toContain("case-default-not-a-literal")
			})
		})

		it("takes a List, a Record and a Case value as literals", () => {
			expect(
				messagesOf(`implementation {
					type Header = { name: String, value: String }

					choice Fetch {
						Get {
							headers: List<Header>,
							proxy: Optional<String>,
							limits: { calls: Integer },
						} = {
							headers = [{ name = "Accept", value = "*/*" }],
							proxy = #Empty,
							limits = { calls = 10 },
						},
					}

					constant call: Fetch = #Get({})
				}`),
			).toEqual([])
		})

		it("refuses a payload default on a generic Choice", () => {
			expect(
				codesOf(`implementation {
					choice Box<Value> {
						Full { value: Value, seen: Integer } = { seen = 0 },
						Empty,
					}
				}`),
			).toContain("case-default-on-generic-choice")
		})

		// With a default, the shorthand asks whether the payload is a partial of
		// the Record, so `#Only({})` is a payload. Anything else is wrapped.
		describe("against the one-member shorthand", () => {
			let wrapChoice = `choice Wrap {
				Only { inner: { a: Integer } } = { inner = { a = 1 } },
			}`

			it("reads an empty Record as the payload", async () => {
				expect(
					await run(`implementation { ${wrapChoice}
						constant wrapped: Wrap = #Only({})

						Terminal.inspect(wrapped)
					}`),
				).toEqual(["Wrap#Only({ a = 1 })"])
			})

			it("still wraps a Record that only fits the member Type", async () => {
				expect(
					await run(`implementation { ${wrapChoice}
						constant wrapped: Wrap = #Only({ a = 2 })

						Terminal.inspect(wrapped)
					}`),
				).toEqual(["Wrap#Only({ a = 2 })"])
			})
		})
	})
})
