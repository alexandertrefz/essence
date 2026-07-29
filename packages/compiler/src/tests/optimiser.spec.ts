import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { fixturePath } from "@essence-lang/fixtures"
import type { common } from "@essence-lang/interfaces"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import {
	defaultOptimiserOptions,
	optimise,
	type OptimiserOptions,
	optimiserOptionsKey,
	optimiserPasses,
	optimiserPassNames,
} from "../optimiser/index"
import { rewriteExpressions } from "../optimiser/walk"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { stdlibPrelude, withOptimiserOptions } from "../rewriter/stdlibPrelude"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: The Optimiser's own gates: that the registry says what the command line
// and the documentation read off it, that the shared walk reaches every
// Expression a Program holds, that each pass emits what it says it emits, and —
// the contract that matters most — that a Program prints the same thing with a
// pass on as with it off.

function simplified(fileName: string): common.typedSimple.Program {
	return simplifiedSource(readFileSync(fixturePath(fileName), "utf8"))
}

function simplifiedSource(source: string): common.typedSimple.Program {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return simplify(enriched.program)
}

// NOTE: The Options reach the Rewriter as well as the Optimiser — the standard
// library's own bodies are optimised inside the prelude the Rewriter builds, so
// a Program compiled with a pass off would otherwise import one compiled with it
// on.
function generate(
	source: string,
	options: OptimiserOptions = defaultOptimiserOptions,
): string {
	return rewrite(optimise(simplifiedSource(source), options), options)
}

// NOTE: The other half of every toggle: not what the two builds LOOK like but
// what they DO. The emitted module is written to a throwaway file and imported
// so its top-level `__print` calls run.
async function outputOf(javaScript: string): Promise<Array<string>> {
	let directory = mkdtempSync(join(tmpdir(), "essence-optimiser-"))
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

// NOTE: The pass contract, as one function: a Program compiled with the named
// pass turned off prints exactly what it prints with the pass on. Every pass
// registers a case of this, over a Program that exercises what it rewrites.
async function expectSamePrintedOutput(
	passName: string,
	source: string,
): Promise<Array<string>> {
	let withPass = await outputOf(generate(source))
	let withoutPass = await outputOf(
		generate(source, {
			enabled: true,
			disabledPasses: new Set([passName]),
		}),
	)

	expect(withPass).toEqual(withoutPass)

	return withPass
}

// NOTE: Records, Lists, Cases with a payload and without, a payload that is a
// Record the Program is holding elsewhere, a member name JavaScript can not
// spell, and a Match reading it all back — the shapes `collapse-construction`
// rewrites, in one Program that prints what it built.
const constructions = `implementation {
	choice Shape {
		Circle { radius: Integer },
		Blank,
	}

	constant point = { x = 1, y = 2 }
	constant single = { only = 1 }
	constant awkward = { ok? = 1 }
	constant items = [1, 2, 3]
	constant nested = [[1], [2]]
	constant payload = { radius = 4 }

	constant circle: Shape = Shape#Circle({ radius = 3 })
	constant held: Shape = Shape#Circle(payload)
	constant blank: Shape = Shape#Blank

	__print(point)
	__print(single)
	__print(awkward)
	__print(items)
	__print(nested)
	__print(circle)
	__print(held)
	__print(blank)
	__print(circle::is(held))
	__print(blank::is(Shape#Blank))
	__print(match circle -> Integer {
		case #Circle { <- @.radius }
		case #Blank { <- 0 }
	})
}`

// NOTE: A Combination whose right-hand side is a literal, one whose right-hand
// side is a Record the Program is holding, one member overridden and both — the
// shapes `collapse-combinations` rewrites. A right-hand side may only be a
// Partial of what it updates, so there is no member here the left-hand side
// does not already have.
const combinations = `implementation {
	constant base = { x = 1, y = 2 }
	constant changes = { x = 9 }

	constant overridden = { base with changes }
	constant both = { base with x = 8, y = 9 }
	constant replaced = { base with x = 7 }

	__print(base)
	__print(overridden)
	__print(both)
	__print(replaced)
	__print(base::is({ x = 1, y = 2 }))
}`

// NOTE: The Node kinds `typedSimple.ExpressionNode` is made of, minus
// `Identifier`. The three Identifier positions the walk leaves alone — the
// Namespace a Method Invocation answers on, the runtime Function a native
// Invocation names, the member a Lookup reads — hold nothing else and are
// nothing the Program computes, so counting Identifiers here would be counting
// the difference between two deliberate answers.
const expressionKinds = new Set([
	"NativeFunctionInvocation",
	"FunctionInvocation",
	"MethodInvocation",
	"UnionMethodInvocation",
	"RecordValue",
	"StringValue",
	"InterpolatedStringValue",
	"IntegerValue",
	"RationalValue",
	"BooleanValue",
	"FunctionValue",
	"ListValue",
	"Lookup",
	"Combination",
	"Match",
	"ConformanceValue",
	"CaseValue",
])

// NOTE: Every Expression the Program holds, found by reading the tree as plain
// data rather than by asking the walk — which is the whole point: a position
// the walk forgot to descend into is a position only an INDEPENDENT reading can
// name. Gathered by object identity, because the same Node kind occurs
// thousands of times and only identity says whether THIS one was reached.
function everyExpressionIn(program: common.typedSimple.Program): Set<unknown> {
	let found = new Set<unknown>()

	let visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (let entry of value) {
				visit(entry)
			}

			return
		}

		if (value === null || typeof value !== "object") {
			return
		}

		let node = value as Record<string, unknown>

		if (expressionKinds.has(node["nodeType"] as string)) {
			found.add(node)
		}

		for (let [key, entry] of Object.entries(node)) {
			// NOTE: A Namespace Method's Function literal is not a value the
			// Program evaluates — the Rewriter emits it as a class member — so
			// the walk offers the body inside it and not the literal itself.
			// `isStatic` is the Method wrapper's own field and nothing else's.
			if (key === "method" && node["isStatic"] !== undefined) {
				visit((entry as Record<string, unknown>)["value"])

				continue
			}

			visit(entry)
		}
	}

	visit(program.implementation.nodes)

	return found
}

describe("Optimiser", () => {
	describe("the registry", () => {
		it("names every pass in kebab-case", () => {
			let misspelled = optimiserPassNames.filter(
				(name) => !/^[a-z]+(-[a-z]+)*$/.test(name),
			)

			expect(misspelled).toEqual([])
		})

		it("names each pass once", () => {
			expect([...optimiserPassNames]).toEqual([
				...new Set(optimiserPassNames),
			])
		})

		it("lists the names in the order the passes run", () => {
			expect([...optimiserPassNames]).toEqual(
				optimiserPasses.map((pass) => pass.name),
			)
		})
	})

	describe("the Options key", () => {
		it("tells the phase turned off from the phase turned on", () => {
			expect(
				optimiserOptionsKey({
					...defaultOptimiserOptions,
					enabled: false,
				}),
			).not.toBe(optimiserOptionsKey(defaultOptimiserOptions))
		})

		it("reads one set of disabled passes as one key", () => {
			let first: OptimiserOptions = {
				enabled: true,
				disabledPasses: new Set(["b-pass", "a-pass"]),
			}
			let second: OptimiserOptions = {
				enabled: true,
				disabledPasses: new Set(["a-pass", "b-pass"]),
			}

			expect(optimiserOptionsKey(first)).toBe(optimiserOptionsKey(second))
		})

		it("tells a disabled pass from none", () => {
			expect(
				optimiserOptionsKey({
					enabled: true,
					disabledPasses: new Set(["a-pass"]),
				}),
			).not.toBe(optimiserOptionsKey(defaultOptimiserOptions))
		})
	})

	// NOTE: The prelude is the standard library's own bodies, optimised once per
	// process and shared by every file compiled in it. It is the one cache the
	// Options have to reach: built under one set and handed to a compilation
	// under another, it would put passes into a Program that asked for them to
	// be left out — and in a test suite, where one process compiles under
	// several, that is not a corner case.
	describe("the prelude cache", () => {
		it("builds one prelude per set of Options", () => {
			let optimised = withOptimiserOptions(defaultOptimiserOptions, () =>
				stdlibPrelude(),
			)
			let again = withOptimiserOptions(defaultOptimiserOptions, () =>
				stdlibPrelude(),
			)
			let unoptimised = withOptimiserOptions(
				{ enabled: false, disabledPasses: new Set() },
				() => stdlibPrelude(),
			)

			expect(again).toBe(optimised)
			expect(unoptimised).not.toBe(optimised)
			expect(
				withOptimiserOptions(
					{ enabled: false, disabledPasses: new Set() },
					() => stdlibPrelude(),
				),
			).toBe(unoptimised)
		})
	})

	// NOTE: `Everyday.es` and `Match.es` between them hold every Expression
	// shape a Program can carry — Records, Lists, Cases, Combinations, Matches
	// with guards and literal Matchers, interpolation, Namespaces with static
	// Properties, conformance witnesses and a Union-typed receiver.
	describe("the shared walk", () => {
		for (let fileName of ["Everyday.es", "Match.es", "Loops.es"]) {
			it(`reaches every Expression of ${fileName} exactly once`, () => {
				let program = simplified(fileName)
				let offered: Array<unknown> = []
				let walked = rewriteExpressions(program, (node) => {
					if (node.nodeType !== "Identifier") {
						offered.push(node)
					}

					return node
				})

				let expected = everyExpressionIn(program)

				expect(offered.length).toBeGreaterThan(50)
				// NOTE: Once, not merely at least once — a position walked twice
				// would let a pass rewrite its own output, which is the one
				// thing a bottom-up walk promises not to do.
				expect(offered.length).toBe(new Set(offered).size)
				expect(new Set(offered)).toEqual(expected)
				// NOTE: A walk that changed nothing hands back what it was
				// given, whole. Passes are pure functions of their input, and
				// the standard library's Programs are optimised once and read
				// many times.
				expect(walked).toBe(program)
			})
		}

		it("leaves the Program it was given untouched", () => {
			// NOTE: A value no fixture writes, so counting it counts the
			// rewrite and nothing else.
			const marker = "987654321"

			let program = simplified("Everyday.es")
			let markers = (walked: common.typedSimple.Program): number =>
				[...everyExpressionIn(walked)].filter(
					(node) =>
						(node as Record<string, unknown>)["nodeType"] ===
							"IntegerValue" &&
						(node as Record<string, unknown>)["value"] === marker,
				).length

			expect(markers(program)).toBe(0)

			let rewritten = rewriteExpressions(program, (node) =>
				node.nodeType === "IntegerValue" && node.value === "2"
					? { ...node, value: marker }
					: node,
			)

			expect(rewritten).not.toBe(program)
			expect(markers(rewritten)).toBeGreaterThan(0)
			// NOTE: A pass that wrote into its input would corrupt the standard
			// library for every later compilation in the process.
			expect(markers(program)).toBe(0)
		})
	})

	describe("collapse-construction", () => {
		it("builds a Record in one allocation", () => {
			let generated = generate(constructions)

			expect(generated).toContain('[$type.typeKeySymbol]: "Record"')
			expect(generated).not.toContain("Record.createRecord(")
		})

		it("builds a List in one allocation", () => {
			let generated = generate(constructions)

			expect(generated).toContain('[$type.typeKeySymbol]: "List"')
			expect(generated).not.toContain("List.createList(")
		})

		it("writes a Case's tag onto the Record its payload builds", () => {
			let generated = generate(constructions)

			expect(generated).toContain('[$type.typeKeySymbol]: "Shape#Circle"')
			// NOTE: A payload the Program holds elsewhere is SPREAD rather than
			// shared, which is what `createCase` does with it — the members are
			// copied onto a value of the Case's own.
			expect(generated).toContain("...payload")
			// NOTE: A unit Case keeps its constructor, which hands out one
			// instance per tag rather than a literal per construction.
			expect(generated).toContain('$type.createCase("Shape#Blank")')
		})

		it("quotes a member name JavaScript can not spell", () => {
			expect(generate(constructions)).toContain('"ok?": ')
		})

		// NOTE: The standard library's own bodies go through the same pass, in
		// the prelude the Rewriter builds — which is where most of a Program's
		// Record and List construction actually happens.
		it("collapses the standard library's bodies too", () => {
			const source = `implementation {
				__print([1, 2, 2]::removeDuplicates())
			}`

			let generated = generate(source)

			// NOTE: `removeDuplicates` folds onto a `[]` it declares, and
			// `append` builds a one-item List to concatenate — both of them
			// Essence bodies, emitted as prelude consts.
			expect(generated).toContain("$es_List_removeDuplicates")
			expect(generated).not.toContain("List.createList(")

			let unoptimised = generate(source, {
				enabled: true,
				disabledPasses: new Set(["collapse-construction"]),
			})

			expect(unoptimised).toContain("List.createList(")
		})

		it("emits the constructors again when it is turned off", () => {
			let generated = generate(constructions, {
				enabled: true,
				disabledPasses: new Set(["collapse-construction"]),
			})

			expect(generated).toContain("Record.createRecord(")
			expect(generated).toContain("List.createList(")
			expect(generated).toContain('$type.createCase("Shape#Circle"')
			expect(generated).not.toContain('[$type.typeKeySymbol]: "Record"')
		})

		it("prints the same thing with the pass off", async () => {
			expect(
				await expectSamePrintedOutput(
					"collapse-construction",
					constructions,
				),
			).toEqual([
				"{ x = 1, y = 2 }",
				"{ only = 1 }",
				"{ ok? = 1 }",
				"[ 1, 2, 3 ]",
				"[ [ 1 ], [ 2 ] ]",
				"Shape#Circle(3)",
				"Shape#Circle(4)",
				"Shape#Blank",
				"false",
				"true",
				"3",
			])
		})

		it("prints the same thing with the pass off for every fixture shape", async () => {
			await expectSamePrintedOutput(
				"collapse-construction",
				readFileSync(fixturePath("Loops.es"), "utf8"),
			)
			await expectSamePrintedOutput(
				"collapse-construction",
				readFileSync(fixturePath("Everyday.es"), "utf8"),
			)
		})
	})

	describe("collapse-combinations", () => {
		it("combines two Records with one spread", () => {
			let generated = generate(combinations)

			expect(generated).toContain("...base")
			expect(generated).not.toContain("Object.assign(")
		})

		it("spreads a right-hand side that is not a literal", () => {
			expect(generate(combinations)).toContain("...changes")
		})

		it("assigns again when it is turned off", () => {
			let generated = generate(combinations, {
				enabled: true,
				disabledPasses: new Set(["collapse-combinations"]),
			})

			expect(generated).toContain("Object.assign(")
		})

		// NOTE: The two collapses meet on `{ base with x = 1 }`, whose
		// right-hand side is a Record literal — and neither may assume the
		// other ran. With construction off the literal is still written out
		// member by member rather than built and copied.
		it("writes the members out with the other collapse off", () => {
			let generated = generate(combinations, {
				enabled: true,
				disabledPasses: new Set(["collapse-construction"]),
			})

			expect(generated).toContain("...base")
			expect(generated).not.toContain("Object.assign(")
		})

		it("prints the same thing with the pass off", async () => {
			expect(
				await expectSamePrintedOutput(
					"collapse-combinations",
					combinations,
				),
			).toEqual([
				"{ x = 1, y = 2 }",
				"{ x = 9, y = 2 }",
				"{ x = 8, y = 9 }",
				"{ x = 7, y = 2 }",
				"true",
			])
		})

		it("prints the same thing with both collapses off", async () => {
			let all = await outputOf(generate(combinations))
			let neither = await outputOf(
				generate(combinations, {
					enabled: true,
					disabledPasses: new Set([
						"collapse-construction",
						"collapse-combinations",
					]),
				}),
			)
			let none = await outputOf(
				generate(combinations, {
					enabled: false,
					disabledPasses: new Set(),
				}),
			)

			expect(neither).toEqual(all)
			expect(none).toEqual(all)
		})
	})
})
