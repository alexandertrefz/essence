import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { fixturePath } from "@essence/fixtures"
import type { common, parser } from "@essence/interfaces"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parse, parseWithDiagnostics } from "../parser/index"
import { printType } from "../printType"
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

function helpsOf(source: string): Array<string> {
	return diagnosticsOf(source).flatMap((diagnostic) => diagnostic.helps)
}

function notesOf(source: string): Array<string> {
	return diagnosticsOf(source).flatMap((diagnostic) => diagnostic.notes)
}

// NOTE: Emits the Program, writes it to a throwaway module and imports it so
// its top-level `__print` calls run — the counterpart of `generate`, mirroring
// codeGeneration.spec's own `run`, so a generic Choice is exercised end to end
// rather than only type-checked.
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

// NOTE: The declared Type of a named Declaration in an enriched Program — the
// applied Union of a `type Applied = Progress<Integer, String>` alias, or the
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

// NOTE: The Type of a Constant's VALUE — a constructed Case carries its
// instantiated CaseType here, so a test can assert on the members and Type
// Arguments the construction site inferred.
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

			// NOTE: The body Union is anonymous so an application heals its
			// display `alias` onto it.
			expect(body.name).toBeUndefined()
			expect(body.alias).toBeUndefined()

			let done = body.types.find(
				(member): member is common.CaseType =>
					member.type === "Case" && member.name === "Stopped",
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

		// NOTE: A Type Parameter may spell the Choice's own name, and then the
		// payload names the Parameter — no recursion, and as silent as the
		// plain `type Bad<Bad> = { next: Bad }` the same shadowing makes.
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

	// NOTE: Everything the direct check above does NOT catch — a mutual pair, a
	// non-generic Choice, a Type Alias — is caught by the cycle pre-pass before
	// the hoist rounds. `toEqual` throughout, because the point of the pre-pass
	// is as much what it does NOT report: each of these used to be a pile of
	// `unknown-type` Diagnostics about names the Program does declare.
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

		// NOTE: A Generic's default Type is resolved along with the declaration
		// it belongs to, so a cycle through one is just as unresolvable — and it
		// is the position the direct check never looked at.
		it("names a cycle closed by a Generic's default Type", () => {
			expect(
				messagesOf(`implementation {
					type Boxed<Item = Boxed<Integer>> = { value: Item }
				}`),
			).toEqual(["Type 'Boxed' names itself"])
		})

		// NOTE: A default Type resolves in the Scope AROUND the declaration,
		// where the Parameter it belongs to is not visible yet — so the `B` in
		// `type B<B = B>` is the declaration being made, and the shadowing the
		// body enjoys must not be applied here.
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

		// NOTE: The other side of the same coin — a default Type naming what its
		// Parameter shadows in the body is no cycle at all, and stays silent.
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

		// NOTE: The cascade the pre-pass exists to prevent: every name in the
		// cycle stays declared — as an Error — so a declaration naming one of
		// them, above or below, is not reported at all.
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

		// NOTE: A Type Parameter is not the Type its name may also spell
		// further out — the graph resolves the shadowing, so this is no cycle.
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

	// NOTE: `infer` marks a Type Parameter a USE works out for itself. A Choice
	// and a Type Alias have no such use — every one of theirs applies its
	// Arguments outright — so the marker is refused rather than accepted and
	// ignored, which is what it was while a construction's payload could stand in
	// for a use site that worked the Argument out.
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

		// NOTE: The Generic list is the same grammar a Method writes, where the
		// marker is the whole point — which is why this is a Diagnostic and not a
		// parse error.
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

					__print(1::pick((n) { <- n::toString() }))
				}`),
			).toEqual(['"1"'])
		})

		// NOTE: `infer` is a valid Identifier, so `<infer>` declares a Generic
		// NAMED infer and marks nothing — the Parser only reads it as the modifier
		// when a name follows it.
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

		// NOTE: The bare form CARRYING A PAYLOAD is untouched by the
		// applied-Type-Arguments rule, and deliberately so — it is the form a
		// Function literal with no written return Type answers with, where there is
		// no position to read a decision off and the body is the only thing that can
		// say what it returns. The standard library's `List.firstItem(where:)` is
		// written on exactly this, and `#Done`/`#Continue` in a `loop`'s callback
		// are the same shape. The PREFIXED form is what asks to be decided, and so
		// is the bare unit Case below: it has no payload to decide with either.
		it("still reads a bare Case's Type Arguments off its payload", () => {
			expect(
				valueTypeOf(
					`implementation { ${progressChoice}
						constant done = #Stopped({ value = "x" })
					}`,
					"done",
				),
			).toEqual({
				type: "Case",
				choice: "Progress",
				name: "Stopped",
				members: { value: { type: "String" } },
				typeArguments: [
					{ type: "GenericUse", name: "State" },
					{ type: "String" },
				],
			})
		})

		// NOTE: A unit Case has no payload to read a decision off and no Choice
		// name to apply Type Arguments to, so the bare spelling of one is asked to
		// be decided exactly as the prefixed form is. Every position that decides
		// the prefixed form decides this one; nothing around it at all is what
		// reports, instead of the Choice's own Type Parameters standing here as the
		// Type of a value.
		describe("A unit Case of a generic Choice", () => {
			const box = `choice Box<Value> { Full { value: Value }, Empty }`

			it("reports one nothing decides", () => {
				let source = `implementation { ${box}
					constant empty = #Empty
				}`

				expect(codesOf(source)).toEqual(["undecided-type-arguments"])
				expect(messagesOf(source)).toEqual([
					"Nothing decides the Type Arguments of '#Empty'",
				])
				expect(helpsOf(source)).toEqual([
					"Annotate the declaration: 'constant left: Box<Value> = #Empty'.",
					"Or apply the Type Arguments: 'Box<Value>#Empty'.",
				])
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

						__print(describe(#Empty))
					}`),
				).toEqual(['"empty"'])
			})

			// NOTE: And waits for the Argument beside it that decides the Parameter,
			// the same holding-back the prefixed form gets: matching a Case that
			// binds nothing first would only read a Parameter Type nothing has
			// decided yet.
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

						__print(orElse(#Empty, 7)::toString())
					}`),
				).toEqual(['"7"'])
			})
		})
	})

	// NOTE: `case Choice#Case` says which Choice's Case is meant. A Case the
	// matched value can not be is the bare form's error, and used to be a
	// Validator Warning here — the Handler stood, typed by the DECLARED Case,
	// whose members are still the Choice's Type Parameters. A bounded one then
	// solved its bound against a hidden conformance Parameter of a Choice
	// nothing in sight applied, and the emitted Handler read a name no `const`
	// declares.
	describe("Prefixed Case Matchers", () => {
		it("rejects a Case of a foreign Choice", () => {
			expect(
				diagnosticsOf(`implementation {
					choice A { Go }
					choice B { Wait }

					constant command: A = A#Go

					match command -> Nothing {
						case #Go { <- nothing }
						case B#Wait { <- nothing }
					}
				}`).map((diagnostic) => [diagnostic.code, diagnostic.message]),
			).toEqual([
				["unknown-case", "The matched value has no Case 'B#Wait'"],
			])
		})

		it("rejects a bounded Choice's Case the matched value can not be", () => {
			expect(
				codesOf(`implementation {
					choice Box<T is Equatable> { Full { value: T }, Empty }
					choice Other { Thing { name: String } }

					constant other: Other = #Thing({ name = "x" })

					__print(match other -> Boolean {
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

					match undeclared -> Nothing {
						case B#Wait { <- nothing }
					}
				}`),
			).toEqual(["unknown-name"])
		})

		it("still narrows a Case the matched value does have", async () => {
			expect(
				await run(`implementation {
					choice Walk<Result> { Done { value: Result }, Going }

					constant walk: Walk<Integer> = #Done({ value = 3 })

					__print(match walk -> String {
						case Walk#Done { <- @.value::toString() }
						case #Going { <- "going" }
					})
				}`),
			).toEqual(['"3"'])
		})
	})

	// NOTE: Regression tests — a Case's runtime tag is shared by every
	// instantiation of it, so `Box<Integer>#Full` and `Box<String>#Full` are
	// both "Box#Full" and no Matcher and no dispatch branch can tell them apart
	// by tag. The Enricher typed a Matcher by the FIRST instantiation the Union
	// happened to name, so `@.value::add(1)` compiled clean over a payload that
	// was a String at runtime and printed "hello1", and a dispatch on such a
	// Union sent every value to the first branch.
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

			__print(describe(text))
			__print(describe(number))
			__print(describe(nothingInside))
		}`

		it("narrows the payload to what every instantiation carries", () => {
			expect(
				messagesOf(`implementation { ${box}
					constant boxed: Box<Integer> | Box<String> = Box#Full("hello")

					__print(match boxed -> Integer {
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

		// NOTE: The bare form used to call these an ambiguity and name one
		// Choice twice — an ambiguity a prefix could not have resolved, since
		// the prefix says which CHOICE is meant and both candidates are its.
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

					__print(match thing -> String {
						case #Full { <- "full" }
						case #Empty { <- "empty" }
					})
				}`),
			).toContain("ambiguous-case")
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

					__print(text::describe())
					__print(number::describe())
				}`),
			).toEqual(['"String box"', '"Integer box"'])
		})
	})

	// NOTE: A bound on a Choice's Type Parameter is a promise the APPLICATION
	// has to keep — nothing downstream asks again, so `Box<Function>` used to
	// substitute a Type with no equality into a payload declared Equatable and
	// only fall over when something reached for the witness.
	describe("Bounded Generic Choices", () => {
		const boundedBox = `choice Box<T is Equatable> {
			Full { value: T },
			Empty,
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
				function wrap<Value>(_ value: Value) -> Box<Value> {
					<- #Full({ value = value })
				}
			}`

			expect(codesOf(source)).toEqual(["unsatisfied-bound"])
			expect(helpsOf(source)).toEqual([
				"Declare it as '<infer Value is Equatable>'.",
			])
		})

		// NOTE: The Type Argument the annotation decides is what answers for the
		// bound — the payload never decides one, so a construction whose payload
		// is a Function is a `Box<Function>` only where something said so.
		it("rejects a construction whose Type Argument does not conform", () => {
			expect(
				codesOf(`implementation { ${boundedBox}
					constant b: Box<(_ x: Integer) -> Integer> =
						Box#Full({ value = (_ x: Integer) -> Integer { <- x } })
				}`),
			).toEqual(["unsatisfied-bound"])
		})

		// NOTE: The bare form carrying a payload is the one place a payload still
		// decides, so it is the one place a payload can still decide BADLY — and it
		// answers for the bound where it does. A payload that mentions no Generic at
		// all decides none and is asked nothing, which is what keeps an `#Empty` a
		// position DID decide from being an error on sight.
		it("holds a bare construction's payload to the bound it decides", () => {
			expect(
				codesOf(`implementation { ${boundedBox}
					constant b = #Full({ value = (_ x: Integer) -> Integer { <- x } })
				}`),
			).toEqual(["unsatisfied-bound"])
		})

		// NOTE: A unit Case has no payload to decide with, so a bare one nothing
		// around decides is undecided rather than free. It used to stand as a Box of
		// the Choice's OWN Type Parameter: the raw GenericUse left here for the rest
		// of the Program, where the bound had nothing to ask about and the Type
		// Arguments named something no declaration in sight applies.
		it("refuses a bare unit construction nothing decides", () => {
			let source = `implementation { ${boundedBox}
				constant b = #Empty
			}`

			expect(codesOf(source)).toEqual(["undecided-type-arguments"])
			expect(messagesOf(source)).toEqual([
				"Nothing decides the Type Arguments of '#Empty'",
			])
		})

		it("leaves a conforming Type Argument alone", async () => {
			expect(
				await run(`implementation { ${boundedBox}
					constant b: Box<Integer> = #Full({ value = 5 })

					__print(match b -> Boolean {
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

		// NOTE: A Choice's Type Parameters are APPLIED, never inferred — so an
		// undecided construction is no longer a state a Program can reach. It used
		// to be: `Holder#Bare` bound nothing at all and stood as a Holder of its
		// own Type Parameter, and `Holder#Full(f)` let its payload decide, which
		// is the one place a plain Generic behaved as if it were marked `infer`.
		// Both are `undecided-type-arguments` now, and the rails that used to
		// consume the undecided value can not be reached from a construction at
		// all. What is still reachable is a value typed BY a Type Parameter inside
		// generic code, which is a different thing and out of scope here — the
		// annotation that names `Holder<Item>` is what answers for the bound, and
		// the last two of these pin that it still does.
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

			// NOTE: Identically — the payload is checked against the instantiation,
			// it never picks one, so carrying one changes nothing about whether
			// this construction is decided.
			it("reports a prefixed construction with a payload identically", () => {
				expect(
					codesOf(`implementation { ${holder}
						constant full = Holder#Full({ value = 1 })
					}`),
				).toEqual(["undecided-type-arguments"])
			})

			it("names the Choice's own Type Parameters in both ways out", () => {
				expect(
					helpsOf(`implementation { ${holder}
						constant left = Holder#Bare
					}`),
				).toEqual([
					"Annotate the declaration: 'constant left: Holder<Item> = Holder#Bare'.",
					"Or apply the Type Arguments: 'Holder<Item>#Bare'.",
				])
			})

			it("takes the decision from an annotation", async () => {
				expect(
					await run(`implementation { ${holder}
						constant ok: Holder<String> = Holder#Bare

						__print(ok::is(Holder#Bare))
					}`),
				).toEqual(["true"])
			})

			it("takes the decision from a declared return Type", async () => {
				expect(
					await run(`implementation { ${holder}
						function bare() -> Holder<Integer> { <- Holder#Bare }

						__print(match bare() -> String {
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

						__print(describe(Holder#Bare))
						__print(describe(Holder#Full(5)))
					}`),
				).toEqual(['"bare"', '"full"'])
			})

			// NOTE: An item stands in the item position of whatever the List is
			// expected to be, and a member in the position its name has in the
			// expected Record — the same decision the annotation makes for a Case
			// written directly under it.
			it("takes the decision from a List's item position", async () => {
				expect(
					await run(`implementation { ${holder}
						constant items: List<Holder<Integer>> = [Holder#Bare]

						__print(items::length()::toString())
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

			// NOTE: And from the payload position of the Case around it, which is
			// a position like any other once the Case that carries it is decided —
			// so a nesting whose outer Type is spelled out in full decides every
			// construction inside it, however deep and through whatever stands
			// between them.
			it("takes the decision from the payload position around it", async () => {
				expect(
					await run(`implementation {
						choice Box<Value> { Full { value: Value }, Empty }

						constant nested: Box<Box<Integer>> = Box#Full(Box#Full(1))

						__print(match nested -> String {
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

			// NOTE: Through the one-member shorthand and through the Record it is
			// shorthand FOR, and through a List and a Record standing between two
			// constructions — every position that hands an expected Type down
			// hands down what the Case decided for it.
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

						__print(outer::is(inner))
					}`),
				).toEqual(["true"])
			})

			// NOTE: Which instantiation a position offering several of them meant
			// is what the payload answers — so the payload is read once per
			// candidate, under that candidate's own members, and a payload that
			// can not be read under one has not fit it. Read once with no context
			// instead, a nested construction came out an Error, an Error fits
			// everything, and the FIRST arm won whatever was written.
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

			// NOTE: What arm selection asks is asked silently, and the reading it
			// settles on is the one that reports — so a payload that is wrong is
			// wrong once, however many instantiations were offered, and a reading
			// only the LOSING candidate would have complained about says nothing at
			// all.
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

			// NOTE: The reading arm selection chose BY is the reading committed —
			// it was made under the very Case the payload ends up standing in, so
			// reading it again would read the whole subtree beneath it again. Read
			// afresh, a nesting N deep costs 2^N readings of its innermost value:
			// the twenty levels here took two seconds and every added level
			// doubled it, against one reading per level.
			//
			// A construction nested under a position offering ONE instantiation
			// never asks in the first place, and is here so that stays true —
			// paying per candidate where there is nothing to choose between would
			// be the same cost by another route.
			//
			// NOTE: A time, because a count of readings is not something a Program
			// can be asked for — but a generous one: a thousandth of the ceiling
			// when the readings are kept, four times it when they are not, and
			// further apart with every level. Its other half is the shared-Type
			// walk pinned in helpers.spec, which the same nesting depends on.
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

			// NOTE: An Argument is matched by a Case's MEMBERS, and a payload that
			// does not fit them is a Diagnostic one stage later — too late to keep
			// an overload from winning on it. So the probe answers with the
			// declared Case where the payload does not fit what the Parameter
			// decided, and the overload whose payload does fit is the one that
			// wins.
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

						__print(1::take(Box#Full(5)))
						__print(1::take(Box#Full("x")))
					}`),
				).toEqual(['"integer"', '"string"'])
			})

			// NOTE: A partially generic decision is still a decision — `Item` is
			// the enclosing Function's Type Parameter, and the construction is a
			// Holder OF it rather than of nothing.
			it("takes a partially generic decision inside generic code", async () => {
				expect(
					await run(`implementation { ${holder}
						function wrap <infer Item is Equatable>(_ value: Item) -> Holder<Item> {
							<- Holder#Full({ value = value })
						}

						__print(match wrap(5) -> String {
							case Holder#Full { <- "full" }
							case Holder#Bare { <- "bare" }
						})
					}`),
				).toEqual(['"full"'])
			})

			// NOTE: The other side of that — a Parameter Type mentioning the
			// CALL's own Type Parameters decides nothing, because nothing has
			// decided them either. Recorded as a decision it built the undecided
			// state outright: the construction became a `Holder<Item>` whose
			// payload was then forbidden from deciding `Item`, so nothing ever
			// did, and what the reader was shown was a payload reported for not
			// fitting a Type Parameter, followed by an Internal Compiler Error
			// from a call forwarding a conformance witness no caller declares.
			it("refuses a Parameter Type the call has not decided either", () => {
				let source = `implementation { ${holder}
					function take<infer Item is Equatable>(_ h: Holder<Item>) -> String {
						<- "took"
					}

					__print(take(Holder#Full(1)))
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

						__print(1::take(Holder#Full(1)))
					}`),
				).toEqual(["undecided-type-arguments"])
			})

			// NOTE: With no bound in sight either — the shape that used to blame
			// the payload for not being an unsolved Type Parameter, with no help
			// and no mention of Type Arguments at all.
			it("refuses one carrying no bound", () => {
				expect(
					codesOf(`implementation {
						choice Box<Value> { Full { value: Value }, Empty }

						function take<infer Item>(_ b: Box<Item>) -> String {
							<- "took"
						}

						__print(take(Box#Full(1)))
					}`),
				).toEqual(["undecided-type-arguments"])
			})

			// NOTE: And says it ONCE. The unsolved Type Parameter used to travel
			// out through the return Type, where the next Method call searched a
			// Namespace named after the Compiler's own conformance Parameter.
			it("says so once, and lets nothing carry the Parameter onward", () => {
				let source = `implementation {
					choice Result<Value is Equatable> { Ok { value: Value } }

					function unwrap<infer Value is Equatable>(
						_ r: Result<Value>,
					) -> Value {
						<- match r -> Value {
							case #Ok { <- @.value }
						}
					}

					__print(unwrap(Result#Ok(1))::toString())
				}`

				expect(codesOf(source)).toEqual(["undecided-type-arguments"])
			})

			// NOTE: The three spellings that DO decide such a call, which is what
			// makes refusing it a Diagnostic rather than a wall: the Arguments
			// written at the construction, the bare sigil the Parameter's own
			// Choice resolves, and a Constant annotated on the way in.
			it("takes every spelling that decides such a call", async () => {
				expect(
					await run(`implementation { ${holder}
						function take<infer Item is Equatable>(_ h: Holder<Item>) -> String {
							<- "took"
						}

						constant bound: Holder<Integer> = Holder#Full(1)

						__print(take(Holder<Integer>#Full(1)))
						__print(take(#Full(1)))
						__print(take(bound))
					}`),
				).toEqual(['"took"', '"took"', '"took"'])
			})

			// NOTE: And an Argument beside it that DOES decide the Parameter is
			// waited for, the way a callback's Argument is: a construction binds
			// nothing, so matching it before the Arguments that can bind only
			// reads a Parameter Type nothing has decided yet. Which of the two is
			// written first decides nothing at all.
			it("waits for an Argument that decides the Parameter", async () => {
				let orElse = `
					choice Result<Value is Equatable> {
						Ok { value: Value },
						Err,
					}

					function orElse<infer Value is Equatable>(
						_ r: Result<Value>,
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
						__print(orElse(Result#Ok(1), 0)::toString())
						__print(orElse(Result#Err, 7)::toString())
					}`),
				).toEqual(['"1"', '"7"'])
			})

			// NOTE: A receiver is not a position that decides, and deliberately
			// so: dispatch READS the receiver's Type to find the Namespace, so a
			// Namespace found by handing one down would be the Namespace deciding
			// what it is being called on. A construction written directly on a
			// `::` decides for itself or not at all.
			it("offers a construction no decision from the receiver position", () => {
				let namespaces = `
					choice Box<Value> { Full { value: Value }, Empty }

					namespace IntegerBox for Box<Integer> {
						label() -> String { <- "intbox" }
					}
				`

				expect(
					codesOf(`implementation { ${namespaces}
						__print(Box#Full(1)::label())
					}`),
				).toEqual(["undecided-type-arguments"])

				expect(
					messagesOf(`implementation { ${namespaces}
						__print(Box<Integer>#Full(1)::label())
					}`),
				).toEqual([])
			})

			// NOTE: The Alias application rail is where the bound is kept, and the
			// construction reads its instantiation off exactly that — so writing
			// the Type Argument out is as strict here as in any annotation.
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

			// NOTE: What is left of the "Type Parameter does not conform" rail: a
			// value typed by a Type Parameter inside generic code, where the
			// annotation naming `Holder<Item>` is the site that answers. No
			// construction can reach it any more, because no construction can
			// leave an Argument undecided.
			it("still reports an unbounded Type Parameter at the annotation", () => {
				let source = `implementation { ${holder}
					function bare<Item>() -> Holder<Item> { <- Holder#Bare }
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

						__print(left)
					}`),
				).toEqual(["Holder#Bare"])
			})
		})

		// NOTE: The other half of the decision — the Type Arguments written at the
		// construction itself, which is the spelling for every position that hands
		// none down. It is the SAME application an annotation's `Holder<Integer>`
		// is, routed through the same rail, so everything the annotation is held to
		// holds here: the arity, the bounds, and the refusal of a Type that takes
		// no Arguments at all.
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

						__print(left::is(Holder<Integer>#Bare))
					}`),
				).toEqual(["true"])
			})

			// NOTE: Read through `.value` rather than through a Match, because the
			// construction's own Type is the CASE — a Match wants the Choice's
			// Union, which is what an annotation would have made of it.
			it("decides a Case carrying a payload", async () => {
				expect(
					await run(`implementation { ${holder}
						constant left = Holder<Integer>#Full({ value = 1 })

						__print(left.value::toString())
					}`),
				).toEqual(['"1"'])
			})

			// NOTE: The Arguments decide, and THEN the payload is checked against
			// what they decided — which is the one-member shorthand's Record here,
			// wrapped after the instantiation exactly as everywhere else.
			it("takes the one-member shorthand", async () => {
				expect(
					await run(`implementation { ${holder}
						constant left = Holder<String>#Full("packed")

						__print(left.value)
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

			// NOTE: The payload is checked against the instantiation the Arguments
			// decided, which is the whole point of them deciding first.
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

			// NOTE: The written Arguments win, so a position that wanted something
			// else is an ordinary value-does-not-fit — no Diagnostic of its own,
			// because there is nothing special about this way of disagreeing.
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

						__print(take(Holder<Integer>#Full(1))::toString())
					}`),
				).toEqual(["argument-type-mismatch"])
			})

			// NOTE: Both of those are seen because the Case's members differ
			// under the two instantiations. A Case that carries nothing the Type
			// Parameters reach is the same Record under all of them — which
			// `matchesType` reads as one Type on purpose — so nothing downstream
			// could say a word, and the identical mistake was accepted one Case
			// over from where it was reported. The written Arguments are compared
			// against the position's own here, under the code the rail it stands
			// in would have used.
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

						__print(take(Box<Integer>#Tag("x"))::toString())
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

			// NOTE: Agreement is assignability, not sameness — a `Box<Integer>`
			// stands under a `Box<Integer | String>` for the same reason its
			// payload-carrying twin does, and a Union position offering several
			// instantiations is answered by matching any one of them.
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

			// NOTE: An Argument's position is a Parameter Type, and a Parameter
			// Type is only decided once the call is: `id(Box<Integer>#Empty, 1)`
			// is matched while `T` is still open and the Argument beside it is
			// what decides it. Compared against the position as it stood at that
			// moment, every one of these was refused for disagreeing with a `T`
			// the caller can not even name — and the help said to write it.
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

						__print(id(Box<Integer>#Empty, 1))
					}`),
				).toEqual(['"ok"'])

				expect(
					await run(`implementation { ${box}
						namespace Nums for Integer {
							id<infer T>(_ b: Box<T>, _ seed: T) -> String {
								<- "ok"
							}
						}

						__print(1::id(Box<Integer>#Empty, 1))
					}`),
				).toEqual(['"ok"'])

				expect(
					await run(`implementation { ${tagged}
						function id<infer T>(_ b: Tagged<T>, _ seed: T) -> String {
							<- "ok"
						}

						__print(id(Tagged<Integer>#Tag("x"), 1))
					}`),
				).toEqual(['"ok"'])

				expect(
					await run(`implementation { ${box}
						function id<infer T>(with b: Box<T>, seed s: T) -> String {
							<- "ok"
						}

						__print(id(with Box<Integer>#Empty, seed 1))
					}`),
				).toEqual(['"ok"'])
			})

			// NOTE: And still disagrees where the decided position says so — with
			// a note and a help naming the Type the call decided, which is a
			// spelling the caller can write.
			it("says which Arguments the call decided on", () => {
				let source = `implementation {
					choice Box<Value> { Full { value: Value }, Empty }

					function id<infer T>(_ b: Box<T>, _ seed: T) -> String {
						<- "ok"
					}

					__print(id(Box<String>#Empty, 1))
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

			// NOTE: A Type Parameter nothing ever decided is left standing, and
			// left to the call to report — one Diagnostic saying nothing inferred
			// it, rather than that one and a disagreement with the undecided
			// Parameter on top of it.
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

						__print(match empty(1) -> String {
							case #Full  { <- "full" }
							case #Empty { <- "empty" }
						})
					}`),
				).toEqual(['"empty"'])
			})

			// NOTE: A `<` after an Identifier opens nothing else in expression
			// position, but the reading is speculative all the same — what makes it
			// a construction is the `#` on the far side of the Arguments. Reaching
			// no `#` has to leave the Identifier readable as itself.
			it("leaves an Identifier that opens no application alone", () => {
				expect(
					messagesOf(`implementation {
						constant a = 1

						__print(a::isLessThan(2))
					}`),
				).toEqual([])
			})

			// NOTE: An application is written on one line, in a value position for
			// the reason it is in a Type position — a `<` that opens the NEXT line
			// begins something of its own, and reading across the break would let
			// it be swallowed.
			it("does not read Type Arguments across a line break", () => {
				expect(
					codesOf(`implementation {
						choice Box<Value> { Full { value: Value }, Empty }

						constant b = Box
							<Integer>#Empty
					}`),
				).toEqual(["syntax-error"])
			})

			// NOTE: The far side of the same rule. A `#` reaches this parse only
			// when it sits directly against what precedes it — that is what keeps
			// `label #Case` readable as a labelled Argument — and an application
			// standing between the two must not be the way around it.
			it("does not read a '#' that opens the next line", () => {
				expect(
					codesOf(`implementation {
						choice Box<Value> { Full { value: Value }, Empty }

						constant b = Box<Integer>
						#Full(1)
					}`),
				).toEqual(["syntax-error"])
			})

			// NOTE: The line the `#` is held to is the one the Arguments CLOSE
			// on, not the one they open on, so a list written over several lines
			// still constructs.
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

	// NOTE: A *generic* Choice can only derive Equatable CONDITIONALLY — its
	// payloads may be Type Parameters, which are equal exactly when the Types
	// they bind to say so. The derive gains a `where <each payload Parameter> is
	// Equatable` bound, compares each generic payload through that Parameter's
	// witness, and is withheld entirely when a Type Argument brings no equality.
	// Non-generic Choices keep emitting the flat `choiceIs`, byte for byte.
	describe("Generic Derived Equality", () => {
		const maybe = `choice Maybe<T> { Some { value: T }, None }`
		const bag = `choice Bag<T> { Full { items: List<T> } }`
		const opt = `choice Opt<T> { Holding { value: T | Nothing } }`
		const wrap = `choice Wrap<T> { It { value: T } }`

		it("compares two instantiated Cases through their payload's equality", async () => {
			expect(
				await run(`implementation { ${maybe}
					__print(#Some({ value = 1 })::is(#Some({ value = 1 }))::toString())
					__print(#Some({ value = 1 })::is(#Some({ value = 2 }))::toString())
					__print(#Some({ value = 1 })::is(#None)::toString())
				}`),
			).toEqual(['"true"', '"false"', '"false"'])
		})

		it("answers 'isNot' as the negation", async () => {
			expect(
				await run(`implementation { ${maybe}
					__print(#Some({ value = 1 })::isNot(#Some({ value = 2 }))::toString())
					__print(#Some({ value = 1 })::isNot(#Some({ value = 1 }))::toString())
				}`),
			).toEqual(['"true"', '"false"'])
		})

		it("compares a composite payload through composed witnesses", async () => {
			expect(
				await run(`implementation { ${bag}
					constant a: Bag<Integer> = #Full({ items = [1, 2, 3] })
					constant b: Bag<Integer> = #Full({ items = [1, 2, 3] })
					constant c: Bag<Integer> = #Full({ items = [1, 2] })

					__print(a::is(b)::toString())
					__print(a::is(c)::toString())
				}`),
			).toEqual(['"true"', '"false"'])
		})

		it("discriminates a Union payload's Nothing from its generic arm", async () => {
			expect(
				await run(`implementation { ${opt}
					constant a: Opt<Integer> = #Holding({ value = 1 })
					constant b: Opt<Integer> = #Holding({ value = 2 })
					constant n: Opt<Integer> = #Holding({ value = nothing })

					__print(a::is(a)::toString())
					__print(a::is(b)::toString())
					__print(a::is(n)::toString())
					__print(n::is(n)::toString())
				}`),
			).toEqual(['"true"', '"false"', '"false"', '"true"'])
		})

		it("solves as a nested witness inside List's Equatable", async () => {
			expect(
				await run(`implementation { ${maybe}
					constant items: List<Maybe<Integer>> = [#Some({ value = 1 }), #None]

					__print(items::contains(#Some({ value = 1 }))::toString())
					__print(items::contains(#Some({ value = 9 }))::toString())
					__print(items::contains(#None)::toString())
				}`),
			).toEqual(['"true"', '"false"', '"true"'])
		})

		// NOTE: The whole point of routing generic payloads through witnesses
		// rather than the flat structural comparison — `1/2` and `2/4` are equal
		// by Rational's own `is`, and the witness is what carries that here.
		it("compares a Rational payload by its own equality, not by structure", async () => {
			expect(
				await run(`implementation { ${wrap}
					constant a: Wrap<Rational> = #It(1/2)
					constant b: Wrap<Rational> = #It(2/4)

					__print(a::is(b)::toString())
				}`),
			).toEqual(['"true"'])
		})

		it("holds no diagnostics for any of the derived comparisons", () => {
			expect(
				messagesOf(`implementation { ${maybe} ${bag} ${opt}
					constant m: Maybe<Integer> = #Some({ value = 1 })
					constant g: Bag<Integer> = #Full({ items = [1] })
					constant o: Opt<Integer> = #Holding({ value = 1 })

					__print(m::is(#None))
					__print(g::isNot(g))
					__print(o::is(o))
					__print([m]::contains(#None))
				}`),
			).toEqual([])
		})

		// NOTE: A payload whose Type carries no equality withholds the derive
		// rather than crashing — the conformance Diagnostic surfaces instead.
		it("withholds the derive when a payload is not Equatable", () => {
			let diagnostics = diagnosticsOf(`implementation { ${maybe}
				constant f: Maybe<(_ x: Integer) -> Integer> =
					#Some({ value = (_ x: Integer) -> Integer { <- x } })

				__print(f::is(f))
			}`)

			expect(diagnostics).not.toEqual([])
			expect(
				codesOf(`implementation { ${maybe}
				constant f: Maybe<(_ x: Integer) -> Integer> =
					#Some({ value = (_ x: Integer) -> Integer { <- x } })

				__print(f::is(f))
			}`),
			).toContain("unsatisfied-bound")
		})

		it("emits the widened helper and descriptor for a generic Choice", () => {
			let generated = generate(`implementation { ${maybe}
				__print(#Some({ value = 1 })::is(#Some({ value = 1 })))
				__print(#Some({ value = 1 })::isNot(#Some({ value = 1 })))
			}`)

			expect(generated).toContain("$helpers.boundChoiceIs(")
			expect(generated).toContain("$helpers.boundChoiceIsNot(")
			expect(generated).toContain('"Maybe#Some"')
			expect(generated).toContain('"k": "w"')
		})

		// NOTE: The nested witness for `List<Maybe<Integer>>` is the derive
		// curried with the Integer equality it compares payloads through.
		it("wraps the nested derive witness in boundConformance", () => {
			let generated = generate(`implementation { ${maybe}
				constant items: List<Maybe<Integer>> = [#Some({ value = 1 })]

				__print(items::contains(#None))
			}`)

			expect(generated).toContain("$type.boundConformance(")
			expect(generated).toContain("$helpers.boundChoiceIs(")
		})

		// NOTE: Regression tests — a payload Union with SEVERAL arms mentioning
		// the Type Parameter emitted several fallback arms (`tag: null`), and
		// the runtime took the first one it found for everything no arm
		// claimed. A `T | List<T>` payload therefore compared every List
		// through T's own witness: `#Val([2]) is #Val([10])` answered true, and
		// so did `#Val([2]) is #Val(2)`. What tells the arms apart is what the
		// receiver's Type Arguments made of them.
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

						__print(listA::is(listB)::toString())
						__print(listA::is(listC)::toString())
						__print(listA::is(plain)::toString())
						__print(plain::is(listA)::toString())
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

						__print(a::is(b)::toString())
					}`),
				).toEqual(['"true"'])
			})

			// NOTE: With no Type Arguments to shape the arms with, both stand
			// for whatever the eventual Argument turns out to be — no
			// descriptor can be right about that, so the comparison is refused
			// rather than emitted wrong.
			//
			// NOTE: Written inside generic code, because that is the only place
			// left where a Choice's Type Argument IS a Type Parameter — a
			// construction can not leave one undecided any more. The whole set is
			// asserted, not just the refusal: the `unsatisfied-bound` beside it is
			// the derived witness finding the Matcher's `@` carrying `T` without
			// the bound its declaration wrote, which a `toContain` would have hidden.
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
				).toEqual(["unsatisfied-bound", "indistinguishable-union-arms"])
			})

			// NOTE: One generic arm is the fallback it always was, and the
			// descriptor it emits is the one it always emitted.
			it("leaves a single generic arm carrying no shape", () => {
				let generated = generate(`implementation {
					choice Opt<T is Equatable> { Holding { value: T | Nothing } }

					constant a: Opt<Integer> = #Holding({ value = 1 })

					__print(a::is(a))
				}`)

				expect(generated).toContain('"tag": null')
				expect(generated).not.toContain('"shape"')
			})
		})

		// NOTE: A non-generic Choice carries no descriptor, so it keeps emitting
		// the flat helper — the guarantee that this whole feature adds nothing to
		// the code a non-generic Choice already generated.
		it("leaves a non-generic Choice emitting the flat helper", () => {
			let generated = generate(`implementation {
				choice Colour { Red, Green }

				constant red: Colour = #Red

				__print(red::is(#Green))
			}`)

			expect(generated).toContain("$helpers.choiceIs(red,")
			expect(generated).not.toContain("boundChoiceIs")
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
					§§ @param other — the Colour to compare with
					§§ @returns — always true.
					is(_ other: Colour) -> Boolean {
						<- true
					}

					§§ The negation.
					§§
					§§ @param other — the Colour to compare with
					§§ @returns — always false.
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

	// NOTE: A bare or prefixed construction resolves to the DECLARED Case, whose
	// members are still GenericUses; the position it stands in instantiates it,
	// so the value carries a concrete CaseType. This is the shape WP4/WP6/WP7
	// read back.
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
			// NOTE: An instantiated Case drops the declared-only `choiceGenerics`.
			expect(type.choiceGenerics).toBeUndefined()
		})

		// NOTE: A payload that mentions ONE of the Choice's Generics used to leave
		// the others standing as their own Type Parameters, because it was the
		// payload that decided them. The annotation decides every one of them now,
		// the ones no member mentions included.
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

		// NOTE: Plain assignability (null inference context) must REJECT a value
		// of a different instantiation — the whole reason `matchTypes` recurses
		// into Case members rather than trusting the shared tag.
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

					__print(match step -> String {
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

					__print(match step -> String {
						case #Going { <- @.state::append("!") }
						case #Stopped { <- @.value }
					})
				}`),
			).not.toEqual([])
		})
	})

	// NOTE: `#Case(value)` on a single-member Case may hand the value directly;
	// the Enricher wraps it into the one-member Record the rest of the pipeline
	// expects. A payload that already fits the Record is never rewrapped.
	describe("Single-member Shorthand", () => {
		it("wraps a bare value for a single-member Case", () => {
			expect(
				messagesOf(`implementation { ${progressChoice}
					constant done: Progress<String, Integer> = #Stopped(5)
				}`),
			).toEqual([])
		})

		it("emits the same Record whether written long or short", () => {
			let short = generate(`implementation { ${progressChoice}
				constant done: Progress<String, Integer> = #Stopped(5)
			}`)
			let long = generate(`implementation { ${progressChoice}
				constant done: Progress<String, Integer> = #Stopped({ value = 5 })
			}`)

			expect(short).toContain('$type.createCase("Progress#Stopped"')
			expect(short).toContain("value")
			expect(long).toContain('$type.createCase("Progress#Stopped"')
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

	// NOTE: The load-bearing case — a user-defined generic Choice and a user
	// Namespace static Method shaped like the general loop driver, with the
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

					__print(total::toString())
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

					__print(total::toString())
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
})
