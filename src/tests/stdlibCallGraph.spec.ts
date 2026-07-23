import { describe, expect, it } from "bun:test"

import { loadStdlibFrom, parseStdlibSource } from "../enricher/stdlib"
import type { common } from "../interfaces/index"
import {
	buildStdlibPrelude,
	type PreludeNamespace,
	stdlibPrelude,
} from "../rewriter/stdlibPrelude"

// NOTE: The graph is built from the PRELUDE Nodes — `common.typedSimple`,
// after the Simplifier and the Optimiser — and not from the typed Nodes the
// Enricher produced, for two reasons. The Simplifier has already resolved
// every `::` call to the Namespace that answers it, so a Method Invocation
// carries the target Namespace's name in `base` instead of a receiver
// Expression that would have to be typed all over again; and it has already
// mangled each Overload entry to the name it is emitted under, so two entries
// of one `overload` block are two distinct Nodes here rather than one name
// that stands for both. That is exactly the granularity a runtime cycle has:
// what recurses is an emitted Function calling an emitted Function.
type CallGraph = Map<string, Set<string>>

// NOTE: Only the BODIED Methods are Nodes. A native has no body to walk and
// can not begin a cycle of Essence Methods — the cycle this test is planted to
// catch is `Boolean.isNot` -> `Boolean.is` -> `Boolean.isNot`, where every step
// is a Method someone wrote in `src/stdlib`.
function buildCallGraph(prelude: Array<PreludeNamespace>): CallGraph {
	let graph: CallGraph = new Map()

	for (let namespace of prelude) {
		for (let methodName of Object.keys(namespace.node.methods)) {
			graph.set(`${namespace.name}.${methodName}`, new Set())
		}
	}

	for (let namespace of prelude) {
		for (let [methodName, method] of Object.entries(
			namespace.node.methods,
		)) {
			let callers = graph.get(`${namespace.name}.${methodName}`)!

			for (let target of invocationsIn(method.method)) {
				if (graph.has(target)) {
					callers.add(target)
				}
			}
		}
	}

	return graph
}

// NOTE: This recurses into every value rather than knowing the shape of each
// Node ahead of time — a body is walked in full without a per-Node case — but
// it still has to RECOGNISE an invocation by its `nodeType`, and there are
// three spellings a call to a stdlib Method takes after the Simplifier:
//
//   MethodInvocation       an instance call, `@::is(other)` — `base` already
//                          names the answering Namespace.
//   UnionMethodInvocation  an instance call on a Union receiver — one
//                          statically resolved target per member Type.
//   FunctionInvocation     a STATIC call, `Rational.of(…)` or `Number.sum(…)`
//                          — `name` is a `Lookup` whose base Identifier has a
//                          Namespace Type and whose member names the static
//                          Method. (A `Lookup` off a Record — `rec.field` — is
//                          the same Node with a Record base Type, and is not an
//                          edge.)
//
// Missing the third is what an earlier version of this file did: a cycle routed
// through a static helper — and the stdlib is full of static calls — was
// invisible, a stack overflow at run time with no Diagnostic. So the set of
// recognised `nodeType`s below is load-bearing; if a fourth call spelling is
// ever introduced it has to be added here, and the fixtures at the foot of the
// file are what would catch its absence.
function invocationsIn(node: unknown): Array<string> {
	let targets: Array<string> = []

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

		let candidate = value as { nodeType?: string }

		if (candidate.nodeType === "MethodInvocation") {
			let invocation = value as common.typedSimple.MethodInvocationNode

			targets.push(`${invocation.base.name}.${invocation.member.name}`)
		}

		if (candidate.nodeType === "UnionMethodInvocation") {
			let invocation =
				value as common.typedSimple.UnionMethodInvocationNode

			for (let dispatch of invocation.cases) {
				targets.push(`${dispatch.namespaceName}.${dispatch.methodName}`)
			}
		}

		if (candidate.nodeType === "FunctionInvocation") {
			let invocation = value as common.typedSimple.FunctionInvocationNode
			let callee = invocation.name

			// NOTE: A static Method call — `Namespace.method(…)` — lowers to a
			// `FunctionInvocation` off a `Lookup`. The base Type being a
			// Namespace is what tells it apart from a Record field access, which
			// is the same Node shape with a Record base.
			if (
				callee.nodeType === "Lookup" &&
				callee.base.nodeType === "Identifier" &&
				callee.base.type.type === "Namespace" &&
				callee.member.nodeType === "Identifier"
			) {
				targets.push(`${callee.base.name}.${callee.member.name}`)
			}
		}

		for (let entry of Object.values(value)) {
			visit(entry)
		}
	}

	visit(node)

	return targets
}

// NOTE: Direct self-recursion is not a cycle worth reporting — it is how a
// recursive Method is written, and it terminates on its own base case. What
// this looks for is a cycle THROUGH another Method, which no single
// Declaration reads as wrong and which two separate, individually reasonable
// commits can introduce between them.
function findCycle(graph: CallGraph): Array<string> | null {
	let finished = new Set<string>()
	let path: Array<string> = []
	let onPath = new Set<string>()

	let walk = (method: string): Array<string> | null => {
		path.push(method)
		onPath.add(method)

		for (let target of graph.get(method) ?? []) {
			if (target === method) {
				continue
			}

			if (onPath.has(target)) {
				return [...path.slice(path.indexOf(target)), target]
			}

			if (!finished.has(target)) {
				let cycle = walk(target)

				if (cycle !== null) {
					return cycle
				}
			}
		}

		path.pop()
		onPath.delete(method)
		finished.add(method)

		return null
	}

	for (let method of graph.keys()) {
		if (finished.has(method)) {
			continue
		}

		let cycle = walk(method)

		if (cycle !== null) {
			return cycle
		}
	}

	return null
}

// NOTE: A whole synthetic standard library rather than hand built Nodes, so
// the walker above is exercised on the shapes the real Loader produces — a
// hand written Node would only prove that the code agrees with the test's own
// idea of what a Node looks like.
function preludeOf(source: string): Array<PreludeNamespace> {
	let stdlib = loadStdlibFrom([parseStdlibSource("Synthetic.es", source)])

	return buildStdlibPrelude(stdlib.typedPrograms)
}

describe("Stdlib Call Graph", () => {
	// NOTE: This now guards real edges — `Ordering.isNot` calls `Ordering.is`,
	// `String.isNot` calls `String.is`, and the conversion adds more Methods
	// written in terms of each other every commit. An accidental cycle among
	// them is a stack overflow at run time with no Diagnostic, which is exactly
	// what this catches before it ships.
	it("has no cycle among the Essence-implemented Methods", () => {
		let cycle = findCycle(buildCallGraph(stdlibPrelude()))

		if (cycle !== null) {
			throw new Error(
				`The Essence-implemented standard library Methods call each other in a cycle, which is a stack overflow at run time:\n\n  ${cycle.join(
					" -> ",
				)}`,
			)
		}
	})

	it("names every Essence-implemented Method as a Node", () => {
		let graph = buildCallGraph(stdlibPrelude())

		expect([...graph.keys()].sort()).toEqual([
			"Algebraic.absolute",
			"Algebraic.is",
			"Algebraic.isNot",
			"Algebraic.subtract__overload$1",
			"Algebraic.subtract__overload$2",
			"Algebraic.subtract__overload$3",
			"Boolean.exclusiveOr",
			"Boolean.isNot",
			"Boolean.toString",
			"Integer.absolute",
			"Integer.clamp",
			"Integer.divide__overload$1",
			"Integer.divide__overload$2",
			"Integer.is",
			"Integer.isEven",
			"Integer.isGreaterThanOrEqualTo__overload$1",
			"Integer.isGreaterThan__overload$1",
			"Integer.isLessThanOrEqualTo__overload$1",
			"Integer.isLessThan__overload$1",
			"Integer.isNegative",
			"Integer.isNot",
			"Integer.isOdd",
			"Integer.isPositive",
			"Integer.isZero",
			"Integer.subtract__overload$1",
			"Integer.subtract__overload$2",
			"Integer.subtract__overload$3",
			"Integer.subtract__overload$4",
			"List.anyItem",
			"List.append__overload$1",
			"List.contains",
			"List.count__overload$1",
			"List.count__overload$2",
			"List.doesNotContain",
			"List.everyItem",
			"List.firstItem__overload$1",
			"List.firstItem__overload$2",
			"List.hasItems",
			"List.insert",
			"List.isEmpty",
			"List.isNot",
			"List.lastItem",
			"List.partition",
			"List.prepend__overload$1",
			"List.prepend__overload$2",
			"List.remove",
			"List.removeDuplicates",
			"List.removeEvery__overload$1",
			"List.removeEvery__overload$2",
			"List.removeFirst__overload$1",
			"List.removeFirst__overload$2",
			"List.removeLast__overload$1",
			"List.removeLast__overload$2",
			"List.repeat",
			"List.replace",
			"List.sorted",
			"Nothing.is",
			"Nothing.isNot",
			"Nothing.toString",
			"Number.greatestNumber__overload$1",
			"Number.greatestNumber__overload$2",
			"Number.greatestNumber__overload$3",
			"Number.greatestNumber__overload$4",
			"Number.is",
			"Number.isBetween",
			"Number.isGreaterThan",
			"Number.isGreaterThanOrEqualTo",
			"Number.isLessThan",
			"Number.isLessThanOrEqualTo",
			"Number.isNot",
			"Number.lowestNumber__overload$1",
			"Number.lowestNumber__overload$2",
			"Number.lowestNumber__overload$3",
			"Number.lowestNumber__overload$4",
			"Number.toString",
			"Optional.otherwise",
			"Ordering.is",
			"Ordering.isNot",
			"Ordering.toString",
			"Rational.absolute",
			"Rational.is",
			"Rational.isGreaterThanOrEqualTo__overload$1",
			"Rational.isGreaterThan__overload$1",
			"Rational.isLessThanOrEqualTo__overload$1",
			"Rational.isLessThan__overload$1",
			"Rational.isNot",
			"Rational.isWholeNumber",
			"Rational.negate",
			"Rational.reciprocal",
			"Rational.roundDown",
			"Rational.roundUp",
			"Rational.subtract__overload$1",
			"Rational.subtract__overload$2",
			"Rational.subtract__overload$3",
			"Rational.subtract__overload$4",
			"Record.isNot",
			"String.character",
			"String.characters",
			"String.contains",
			"String.doesNotContain",
			"String.doesNotEnd",
			"String.doesNotStart",
			"String.ends",
			"String.firstIndex",
			"String.hasAnyContent",
			"String.is",
			"String.isEmpty",
			"String.isNot",
			"String.paddedAtEnd",
			"String.paddedAtStart",
			"String.prepend",
			"String.repeat",
			"String.reverse",
			"String.slice",
			"String.starts",
			"String.toString",
			"String.trimmed",
			"Transcendental.absolute",
			"Transcendental.is",
			"Transcendental.isNot",
			"Transcendental.subtract__overload$1",
			"Transcendental.subtract__overload$2",
			"Transcendental.subtract__overload$3",
		])
	})

	it("records the Methods a body calls, native ones aside", () => {
		let graph = buildCallGraph(
			preludeOf(`declarations {
	namespace Boolean for Boolean {
		§§ Whether the Boolean is not the other one.
		§§
		§§ @param other the Boolean to compare with
		§§ @returns whether they differ.
		isNot(_ other: Boolean) -> Boolean {
			<- @::is(other)::negate()
		}

		§§ Whether both Booleans are the same.
		§§
		§§ @param other the Boolean to compare with
		§§ @returns whether they match.
		is(_ other: Boolean) -> Boolean {
			<- @::and(other)
		}

		§§ Both Booleans at once.
		§§
		§§ @param other the Boolean to combine with
		§§ @returns the conjunction.
		and(_ other: Boolean) -> Boolean

		§§ The other Boolean.
		§§
		§§ @returns the negation.
		negate() -> Boolean
	}
}`),
		)

		// NOTE: `negate` and `and` are natives — invoked, but not Nodes.
		expect(graph.get("Boolean.isNot")).toEqual(new Set(["Boolean.is"]))
		expect(graph.get("Boolean.is")).toEqual(new Set())
	})

	// NOTE: A static Method call is a `FunctionInvocation`, not a
	// `MethodInvocation` — the spelling the walker used to miss. This proves it
	// records the edge for a bodied instance Method that calls a bodied static
	// helper, and for one static calling another.
	it("records an edge to a static Method a body calls", () => {
		let graph = buildCallGraph(
			preludeOf(`declarations {
	namespace Boolean for Boolean {
		§§ Whether the Boolean matches, the long way around.
		§§
		§§ @param other the Boolean to compare with
		§§ @returns whether they match.
		alpha(_ other: Boolean) -> Boolean {
			<- Boolean.beta(other)
		}

		§§ A static helper that defers to another static.
		§§
		§§ @param value the Boolean.
		§§ @returns the Boolean unchanged.
		static beta(_ value: Boolean) -> Boolean {
			<- Boolean.gamma(value)
		}

		§§ A static helper that reads a Record field — a Lookup that is NOT
		§§ a Method call and must not become an edge.
		§§
		§§ @param value the Boolean.
		§§ @returns the Boolean unchanged.
		static gamma(_ value: Boolean) -> Boolean {
			constant boxed = { field = value }
			<- boxed.field
		}
	}
}`),
		)

		expect(graph.get("Boolean.alpha")).toEqual(new Set(["Boolean.beta"]))
		expect(graph.get("Boolean.beta")).toEqual(new Set(["Boolean.gamma"]))
		// NOTE: `boxed.field` is a `Lookup` off a Record, the same Node shape
		// as `Boolean.gamma` but with a Record base — no edge.
		expect(graph.get("Boolean.gamma")).toEqual(new Set())
	})

	// NOTE: The proof that the check is a check. Without it the whole file
	// would pass on a standard library that has no cycles to find, and would go
	// on passing if `findCycle` returned null unconditionally.
	it("reports a cycle as the path around it", () => {
		let cycle = findCycle(
			buildCallGraph(
				preludeOf(`declarations {
	namespace Boolean for Boolean {
		§§ Whether the Boolean is not the other one.
		§§
		§§ @param other the Boolean to compare with
		§§ @returns whether they differ.
		isNot(_ other: Boolean) -> Boolean {
			<- @::is(other)
		}

		§§ Whether both Booleans are the same.
		§§
		§§ @param other the Boolean to compare with
		§§ @returns whether they match.
		is(_ other: Boolean) -> Boolean {
			<- @::isNot(other)
		}
	}
}`),
			),
		)

		expect(cycle).toEqual(["Boolean.isNot", "Boolean.is", "Boolean.isNot"])
	})

	// NOTE: The same proof for a cycle that runs entirely through static
	// Methods — the edges the walker used to miss. Two statics that defer to
	// each other are a stack overflow just as surely as two instance Methods.
	it("reports a cycle between two static Methods", () => {
		let cycle = findCycle(
			buildCallGraph(
				preludeOf(`declarations {
	namespace Boolean for Boolean {
		§§ Beta defers to gamma.
		§§
		§§ @param value the Boolean.
		§§ @returns the Boolean.
		static beta(_ value: Boolean) -> Boolean {
			<- Boolean.gamma(value)
		}

		§§ Gamma defers back to beta.
		§§
		§§ @param value the Boolean.
		§§ @returns the Boolean.
		static gamma(_ value: Boolean) -> Boolean {
			<- Boolean.beta(value)
		}
	}
}`),
			),
		)

		expect(cycle).toEqual(["Boolean.beta", "Boolean.gamma", "Boolean.beta"])
	})

	// NOTE: And a cycle that crosses the instance/static boundary — an
	// instance Method calling a static helper that calls an instance Method
	// back. This needs BOTH the `FunctionInvocation` edge (alpha to the static
	// beta) and the `MethodInvocation` edge (beta to alpha via its argument) to
	// be seen; missing either hides the cycle.
	it("reports a cycle across the instance/static boundary", () => {
		let cycle = findCycle(
			buildCallGraph(
				preludeOf(`declarations {
	namespace Boolean for Boolean {
		§§ Alpha defers to the static beta.
		§§
		§§ @param other the Boolean.
		§§ @returns the Boolean.
		alpha(_ other: Boolean) -> Boolean {
			<- Boolean.beta(other)
		}

		§§ Beta calls alpha back on its argument.
		§§
		§§ @param value the Boolean.
		§§ @returns the Boolean.
		static beta(_ value: Boolean) -> Boolean {
			<- value::alpha(value)
		}
	}
}`),
			),
		)

		expect(cycle).toEqual([
			"Boolean.alpha",
			"Boolean.beta",
			"Boolean.alpha",
		])
	})

	// NOTE: A Method that calls itself is a recursive Method, not a mistake —
	// the standard library will have them, and reporting one would make the
	// check something a developer learns to ignore.
	it("leaves direct self-recursion alone", () => {
		let cycle = findCycle(
			buildCallGraph(
				preludeOf(`declarations {
	namespace Boolean for Boolean {
		§§ Whether both Booleans are the same, the long way around.
		§§
		§§ @param other the Boolean to compare with
		§§ @returns whether they match.
		is(_ other: Boolean) -> Boolean {
			<- @::is(other)
		}
	}
}`),
			),
		)

		expect(cycle).toBeNull()
	})
})
