import { describe, expect, it } from "bun:test"

import type { common } from "@essence/interfaces"

import { loadStdlibFrom, parseStdlibSource } from "../enricher/stdlib"
import { optimise } from "../optimiser/index"
import {
	buildStdlibPrelude,
	type PreludeFreeFunction,
	type PreludeNamespace,
	stdlibFreeFunctions,
	stdlibPrelude,
} from "../rewriter/stdlibPrelude"
import { simplify } from "../simplifier/index"

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
// is a Method someone wrote in `packages/stdlib/sources`.
//
// NOTE: The bodied free Functions are Nodes on the same footing, keyed by the
// bare `<name>__overload$N` name they are emitted under — a name that can carry
// no `.`, so it can not collide with a Method's key. They belong in the SAME
// graph rather than in one of their own: a bodied `loop` entry is written on
// another entry of its own family, and a cycle that leaves a Method for a free
// Function and comes back is a stack overflow like any other. Kept out, every
// edge through one of them is invisible.
function buildCallGraph(
	prelude: Array<PreludeNamespace>,
	freeFunctions: Array<PreludeFreeFunction> = [],
): CallGraph {
	let graph: CallGraph = new Map()

	for (let namespace of prelude) {
		for (let methodName of Object.keys(namespace.node.methods)) {
			graph.set(`${namespace.name}.${methodName}`, new Set())
		}
	}

	for (let freeFunction of freeFunctions) {
		graph.set(freeFunction.name, new Set())
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

	for (let freeFunction of freeFunctions) {
		let callers = graph.get(freeFunction.name)!

		for (let target of invocationsIn(freeFunction.node.value)) {
			if (graph.has(target)) {
				callers.add(target)
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
//                          edge.) Off a bare Identifier it is a FREE Function
//                          call instead — `loop__overload$1(…)` by now — and the
//                          name IS the graph key. A call on a Function-typed
//                          local or Parameter (`advance(current)`, which every
//                          `loop` body makes) is the same Node shape; it names no
//                          Node, so the `graph.has` filter drops it, and a local
//                          that SHADOWS a bodied free Function's name would draw
//                          an edge that is not there — an over-approximation, so
//                          it can only report a cycle for a developer to read,
//                          never hide one.
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

			if (callee.nodeType === "Identifier") {
				targets.push(callee.name)
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
//
// NOTE: The free Functions are collected the way `buildStdlibArtifacts` collects
// the real ones — the copy before the Simplifier included, since it writes into
// the Nodes it is handed. They can not be read off `stdlibFreeFunctions`, which
// answers for the process-wide standard library rather than for this source.
function graphOf(source: string): CallGraph {
	let typedPrograms = loadStdlibFrom([
		parseStdlibSource("Synthetic.es", source),
	]).typedPrograms

	let freeFunctions: Array<PreludeFreeFunction> = typedPrograms.flatMap(
		(typedProgram) =>
			optimise(
				simplify(structuredClone(typedProgram)),
			).implementation.nodes.flatMap((node) =>
				node.nodeType === "FunctionStatement"
					? [{ name: node.name.name, node }]
					: [],
			),
	)

	return buildCallGraph(buildStdlibPrelude(typedPrograms), freeFunctions)
}

describe("Stdlib Call Graph", () => {
	// NOTE: This now guards real edges — `String.isNot` calls `String.is`,
	// `Rational.isNot` calls `Rational.is`, and the conversion adds more
	// Methods written in terms of each other every commit. An accidental cycle
	// among them is a stack overflow at run time with no Diagnostic, which is
	// exactly what this catches before it ships. A Choice's `is`/`isNot` are
	// no longer among them: they are derived, so they are not written in
	// Essence and have no edges to cycle through.
	//
	// NOTE: The free Functions are in the same graph, which is what makes `loop`'s
	// two bodied entries answerable for: each is written on the native primitive
	// of its family today, and an entry written on ANOTHER bodied entry tomorrow
	// is a cycle two individually reasonable commits can close between them.
	it("has no cycle among the Essence-implemented Methods", () => {
		let cycle = findCycle(
			buildCallGraph(stdlibPrelude(), stdlibFreeFunctions()),
		)

		if (cycle !== null) {
			throw new Error(
				`The Essence-implemented standard library Methods call each other in a cycle, which is a stack overflow at run time:\n\n  ${cycle.join(
					" -> ",
				)}`,
			)
		}
	})

	it("names every Essence-implemented Method and free Function as a Node", () => {
		let graph = buildCallGraph(stdlibPrelude(), stdlibFreeFunctions())

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
			"Case.toString",
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
			"List.firstIndex",
			"List.firstItem__overload$1",
			"List.firstItem__overload$2",
			"List.hasItems",
			"List.insert",
			"List.isEmpty",
			"List.isNot",
			"List.lastIndex",
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
			"NormalizationForm.toString",
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
			"NumberFormat.toString",
			"Optional.hasValue",
			"Optional.isNothing",
			"Optional.otherwise",
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
			"Side.toString",
			"String.character",
			"String.characters",
			"String.compareTo__overload$2",
			"String.contains",
			"String.doesNotContain",
			"String.doesNotEnd",
			"String.doesNotStart",
			"String.firstIndex",
			"String.hasAnyContent",
			"String.isEmpty",
			"String.isNot",
			"String.is__overload$1",
			"String.is__overload$2",
			"String.lastIndex",
			"String.normalized__overload$1",
			"String.pad__overload$1",
			"String.pad__overload$2",
			"String.prepend",
			"String.repeat",
			"String.replaceEvery",
			"String.replaceFirst",
			"String.reverse",
			"String.slice",
			"String.starts",
			"String.toString",
			"String.trim__overload$1",
			"Transcendental.absolute",
			"Transcendental.is",
			"Transcendental.isNot",
			"Transcendental.subtract__overload$1",
			"Transcendental.subtract__overload$2",
			"Transcendental.subtract__overload$3",
			// NOTE: The bodied free Functions, keyed by the bare name they are
			// emitted under. `loop`'s other two entries are native — there is no
			// body to walk, exactly as for a native Method.
			"loop__overload$2",
			"loop__overload$3",
		])
	})

	it("records the Methods a body calls, native ones aside", () => {
		let graph = graphOf(`declarations {
	namespace Boolean for Boolean {
		§§ Whether the Boolean is not the other one.
		§§
		§§ @param other — the Boolean to compare with
		§§ @returns — whether they differ.
		isNot(_ other: Boolean) -> Boolean {
			<- @::is(other)::negate()
		}

		§§ Whether both Booleans are the same.
		§§
		§§ @param other — the Boolean to compare with
		§§ @returns — whether they match.
		is(_ other: Boolean) -> Boolean {
			<- @::and(other)
		}

		§§ Both Booleans at once.
		§§
		§§ @param other — the Boolean to combine with
		§§ @returns — the conjunction.
		and(_ other: Boolean) -> Boolean

		§§ The other Boolean.
		§§
		§§ @returns — the negation.
		negate() -> Boolean
	}
}`)

		// NOTE: `negate` and `and` are natives — invoked, but not Nodes.
		expect(graph.get("Boolean.isNot")).toEqual(new Set(["Boolean.is"]))
		expect(graph.get("Boolean.is")).toEqual(new Set())
	})

	// NOTE: A static Method call is a `FunctionInvocation`, not a
	// `MethodInvocation` — the spelling the walker used to miss. This proves it
	// records the edge for a bodied instance Method that calls a bodied static
	// helper, and for one static calling another.
	it("records an edge to a static Method a body calls", () => {
		let graph = graphOf(`declarations {
	namespace Boolean for Boolean {
		§§ Whether the Boolean matches, the long way around.
		§§
		§§ @param other — the Boolean to compare with
		§§ @returns — whether they match.
		alpha(_ other: Boolean) -> Boolean {
			<- Boolean.beta(other)
		}

		§§ A static helper that defers to another static.
		§§
		§§ @param value — the Boolean.
		§§ @returns — the Boolean unchanged.
		static beta(_ value: Boolean) -> Boolean {
			<- Boolean.gamma(value)
		}

		§§ A static helper that reads a Record field — a Lookup that is NOT
		§§ a Method call and must not become an edge.
		§§
		§§ @param value — the Boolean.
		§§ @returns — the Boolean unchanged.
		static gamma(_ value: Boolean) -> Boolean {
			constant boxed = { field = value }
			<- boxed.field
		}
	}
}`)

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
			graphOf(`declarations {
	namespace Boolean for Boolean {
		§§ Whether the Boolean is not the other one.
		§§
		§§ @param other — the Boolean to compare with
		§§ @returns — whether they differ.
		isNot(_ other: Boolean) -> Boolean {
			<- @::is(other)
		}

		§§ Whether both Booleans are the same.
		§§
		§§ @param other — the Boolean to compare with
		§§ @returns — whether they match.
		is(_ other: Boolean) -> Boolean {
			<- @::isNot(other)
		}
	}
}`),
		)

		expect(cycle).toEqual(["Boolean.isNot", "Boolean.is", "Boolean.isNot"])
	})

	// NOTE: The same proof for a cycle that runs entirely through static
	// Methods — the edges the walker used to miss. Two statics that defer to
	// each other are a stack overflow just as surely as two instance Methods.
	it("reports a cycle between two static Methods", () => {
		let cycle = findCycle(
			graphOf(`declarations {
	namespace Boolean for Boolean {
		§§ Beta defers to gamma.
		§§
		§§ @param value — the Boolean.
		§§ @returns — the Boolean.
		static beta(_ value: Boolean) -> Boolean {
			<- Boolean.gamma(value)
		}

		§§ Gamma defers back to beta.
		§§
		§§ @param value — the Boolean.
		§§ @returns — the Boolean.
		static gamma(_ value: Boolean) -> Boolean {
			<- Boolean.beta(value)
		}
	}
}`),
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
			graphOf(`declarations {
	namespace Boolean for Boolean {
		§§ Alpha defers to the static beta.
		§§
		§§ @param other — the Boolean.
		§§ @returns — the Boolean.
		alpha(_ other: Boolean) -> Boolean {
			<- Boolean.beta(other)
		}

		§§ Beta calls alpha back on its argument.
		§§
		§§ @param value — the Boolean.
		§§ @returns — the Boolean.
		static beta(_ value: Boolean) -> Boolean {
			<- value::alpha(value)
		}
	}
}`),
		)

		expect(cycle).toEqual([
			"Boolean.alpha",
			"Boolean.beta",
			"Boolean.alpha",
		])
	})

	// NOTE: The free Functions, which are Nodes of the same graph. `loop`'s bodied
	// entries are both written on the family's native `while`, so the real library
	// draws no edge between two Nodes here yet — these fixtures are what answer
	// for the day it does.
	describe("free Functions", () => {
		// NOTE: Both directions across the boundary at once, which is what makes
		// the shared graph worth having: a free Function's body reaching a Method,
		// and a Method's body reaching a free Function.
		it("records an edge in either direction across the boundary", () => {
			let graph = graphOf(`declarations {
	§§ Doubles the value.
	§§
	§§ @param value — the Integer to double.
	§§ @returns — twice the value.
	function double(_ value: Integer) -> Integer {
		<- value::twice()
	}

	namespace Inner for Integer {
		§§ Four times the value, by way of the free Function.
		§§
		§§ @returns — four times the value.
		fourTimes() -> Integer {
			<- double(double(@))
		}

		§§ Twice the value.
		§§
		§§ @returns — twice the value.
		twice() -> Integer {
			<- @
		}
	}
}`)

			expect(graph.get("double")).toEqual(new Set(["Inner.twice"]))
			expect(graph.get("Inner.fourTimes")).toEqual(new Set(["double"]))
			expect(graph.get("Inner.twice")).toEqual(new Set())
		})

		// NOTE: The edge the acyclicity check was blind to until the free
		// Functions became Nodes — one entry of an `overload function` block
		// written on another, which is exactly how `loop`'s bodied entries are
		// written on the family's native `while`.
		it("records an edge between two entries of one overload block", () => {
			let graph = graphOf(`declarations {
	§§ Combines a value with itself.
	§§
	§§ @param value — the Integer.
	§§ @returns — the Integer.
	overload function combine {
		§§ The plain entry.
		§§
		§§ @param value — the Integer.
		§§ @returns — the Integer.
		(first value: Integer) -> Integer {
			<- value
		}

		§§ The entry written on the first.
		§§
		§§ @param value — the Integer.
		§§ @returns — the Integer.
		(second value: Integer) -> Integer {
			<- combine(first value)
		}
	}
}`)

			expect(graph.get("combine__overload$2")).toEqual(
				new Set(["combine__overload$1"]),
			)
			expect(graph.get("combine__overload$1")).toEqual(new Set())
		})

		it("reports a cycle between two free Functions", () => {
			let cycle = findCycle(
				graphOf(`declarations {
	§§ Alpha defers to beta.
	§§
	§§ @param value — the Integer.
	§§ @returns — the Integer.
	function alpha(_ value: Integer) -> Integer {
		<- beta(value)
	}

	§§ Beta defers back to alpha.
	§§
	§§ @param value — the Integer.
	§§ @returns — the Integer.
	function beta(_ value: Integer) -> Integer {
		<- alpha(value)
	}
}`),
			)

			expect(cycle).toEqual(["alpha", "beta", "alpha"])
		})

		// NOTE: A cycle that leaves a Method for a free Function and comes back —
		// the shape neither half of the graph could see on its own.
		it("reports a cycle across the Method boundary", () => {
			let cycle = findCycle(
				graphOf(`declarations {
	§§ Alpha calls the Method back on its argument.
	§§
	§§ @param value — the Integer.
	§§ @returns — the Integer.
	function alpha(_ value: Integer) -> Integer {
		<- value::beta()
	}

	namespace Inner for Integer {
		§§ Beta defers to the free Function.
		§§
		§§ @returns — the Integer.
		beta() -> Integer {
			<- alpha(@)
		}
	}
}`),
			)

			expect(cycle).toEqual(["Inner.beta", "alpha", "Inner.beta"])
		})
	})

	// NOTE: A Method that calls itself is a recursive Method, not a mistake —
	// the standard library will have them, and a cycle among DIFFERENT Methods
	// is what this walker is for. The self-call here sits behind a base case on
	// purpose: an UNCONDITIONAL self-call never returns, and that is caught by
	// the `infinite-recursion` Diagnostic — which `graphOf` runs through
	// validation, so the fixture has to be a Method that actually terminates.
	it("leaves direct self-recursion alone", () => {
		let cycle = findCycle(
			graphOf(`declarations {
	namespace Boolean for Boolean {
		§§ Whether both Booleans are the same, the long way around.
		§§
		§§ @param other — the Boolean to compare with
		§§ @returns — whether they match.
		is(_ other: Boolean) -> Boolean {
			if @ {
				<- other
			} else {
				<- @::is(other)
			}
		}
	}
}`),
		)

		expect(cycle).toBeNull()
	})
})
