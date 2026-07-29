import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"

import { fixturePath } from "@essence-lang/fixtures"
import type { common } from "@essence-lang/interfaces"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import {
	defaultOptimiserOptions,
	type OptimiserOptions,
	optimiserOptionsKey,
	optimiserPasses,
	optimiserPassNames,
} from "../optimiser/index"
import { rewriteExpressions } from "../optimiser/walk"
import { parseWithDiagnostics } from "../parser/index"
import { stdlibPrelude, withOptimiserOptions } from "../rewriter/stdlibPrelude"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// NOTE: The Optimiser's own gates: that the registry says what the command line
// and the documentation read off it, that the shared walk reaches every
// Expression a Program holds, and that a pass changes nothing about what a
// Program prints. The passes' own emission is asserted beside them, in the spec
// of the work package that added them.

function simplified(fileName: string): common.typedSimple.Program {
	let source = readFileSync(fixturePath(fileName), "utf8")
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return simplify(enriched.program)
}

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
})
