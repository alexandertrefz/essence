import { describe, expect, it } from "bun:test"

import type { common } from "@essence-lang/interfaces"

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

// The graph is built from the prelude's simplified and optimised Nodes. There
// every `::` call names its answering Namespace in `base`. Each Overload entry
// has its emitted name, which is the granularity a runtime cycle has.
type CallGraph = Map<string, Set<string>>

// The bodied Methods and free Functions are the Nodes, since a native can not
// begin a cycle. A free Function is keyed by its emitted `<name>__overload$N`
// name, which has no `.` to collide with a Method's key. A cycle through a free
// Function overflows the stack like any other.
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

// Walks every value, recognising a call by its `nodeType`: a
// `MethodInvocation`, a `UnionMethodInvocation`'s per-member targets, or a
// `FunctionInvocation` off a Namespace-typed `Lookup` or an Identifier. A local
// shadowing a bodied free Function's name draws a false edge, which can only
// over-report a cycle, never hide one. A new call spelling must be added here.
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

			// A Namespace base Type tells a static call apart from a Record
			// field read, which has the same shape.
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

// Self-recursion is how a recursive Method is written, so only a cycle through
// another Method counts. A Property that reads itself is read before its const
// exists, so the Property graph sets `countsSelfEdges`.
function findCycle(
	graph: CallGraph,
	countsSelfEdges = false,
): Array<string> | null {
	let finished = new Set<string>()
	let path: Array<string> = []
	let onPath = new Set<string>()

	let walk = (method: string): Array<string> | null => {
		path.push(method)
		onPath.add(method)

		for (let target of graph.get(method) ?? []) {
			if (target === method && !countsSelfEdges) {
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

// The bodied static Properties, whose edges are reads: a `Lookup` off a
// Namespace-typed Identifier. A Method called in a Property's value runs then,
// so the Properties it reaches through calls are edges too. This is a second
// guard beside the Rewriter's `orderEssenceMembers`, which throws on a cycle.
function buildPropertyGraph(
	prelude: Array<PreludeNamespace>,
	freeFunctions: Array<PreludeFreeFunction> = [],
): CallGraph {
	let graph: CallGraph = new Map()

	for (let namespace of prelude) {
		for (let propertyName of Object.keys(namespace.node.properties)) {
			graph.set(`${namespace.name}.${propertyName}`, new Set())
		}
	}

	let calls = buildCallGraph(prelude, freeFunctions)
	let directReads = new Map<string, Set<string>>()

	let readsOf = (node: unknown): Set<string> =>
		new Set(propertyReadsIn(node).filter((target) => graph.has(target)))

	for (let namespace of prelude) {
		for (let [methodName, method] of Object.entries(
			namespace.node.methods,
		)) {
			directReads.set(
				`${namespace.name}.${methodName}`,
				readsOf(method.method),
			)
		}
	}

	for (let freeFunction of freeFunctions) {
		directReads.set(freeFunction.name, readsOf(freeFunction.node.value))
	}

	// The Properties a callable reads once it runs, through everything it
	// calls. Mutual recursion is not this graph's kind of cycle, so `seen`
	// suffices.
	let readsThrough = (callable: string): Set<string> => {
		let reads = new Set<string>()
		let seen = new Set<string>([callable])
		let pending: Array<string> = [callable]

		while (pending.length > 0) {
			let current = pending.pop()!

			for (let target of directReads.get(current) ?? []) {
				reads.add(target)
			}

			for (let target of calls.get(current) ?? []) {
				if (!seen.has(target)) {
					seen.add(target)
					pending.push(target)
				}
			}
		}

		return reads
	}

	for (let namespace of prelude) {
		for (let [propertyName, value] of Object.entries(
			namespace.node.properties,
		)) {
			let reads = graph.get(`${namespace.name}.${propertyName}`)!

			for (let target of readsOf(value)) {
				reads.add(target)
			}

			for (let target of invocationsIn(value)) {
				if (!calls.has(target)) {
					continue
				}

				for (let read of readsThrough(target)) {
					reads.add(read)
				}
			}
		}
	}

	return graph
}

// A Namespace base Type tells a Property read apart from a Record field read.
// A static Method reference is collected too, and `buildPropertyGraph` drops
// it.
function propertyReadsIn(node: unknown): Array<string> {
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

		if (candidate.nodeType === "Lookup") {
			let lookup = value as common.typedSimple.LookupNode

			if (
				lookup.base.nodeType === "Identifier" &&
				lookup.base.type.type === "Namespace" &&
				lookup.member.nodeType === "Identifier"
			) {
				targets.push(`${lookup.base.name}.${lookup.member.name}`)
			}
		}

		for (let entry of Object.values(value)) {
			visit(entry)
		}
	}

	visit(node)

	return targets
}

// A synthetic standard library rather than hand-built Nodes, so the walkers
// see the shapes the real Loader produces. Its free Functions are collected
// as `buildStdlibArtifacts` collects them, since `stdlibFreeFunctions`
// answers for the process-wide standard library.
function artifactsOf(source: string): {
	prelude: Array<PreludeNamespace>
	freeFunctions: Array<PreludeFreeFunction>
} {
	let stdlib = loadStdlibFrom([parseStdlibSource("Synthetic.es", source)])

	let freeFunctions: Array<PreludeFreeFunction> =
		stdlib.typedPrograms.flatMap((typedProgram) =>
			optimise(
				simplify(structuredClone(typedProgram)),
			).implementation.nodes.flatMap((node) =>
				node.nodeType === "FunctionStatement"
					? [{ name: node.name.name, node }]
					: [],
			),
		)

	return { prelude: buildStdlibPrelude(stdlib), freeFunctions }
}

function graphOf(source: string): CallGraph {
	let { prelude, freeFunctions } = artifactsOf(source)

	return buildCallGraph(prelude, freeFunctions)
}

function propertyGraphOf(source: string): CallGraph {
	let { prelude, freeFunctions } = artifactsOf(source)

	return buildPropertyGraph(prelude, freeFunctions)
}

describe("Stdlib Call Graph", () => {
	// A cycle among the bodied Methods, a Protocol's provided Methods and the
	// bodied free Functions is a stack overflow with no Diagnostic. A Method
	// reached off a conformance witness is chosen by the receiver, so it is no
	// edge.
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
			"Algebraic.add__overload$4",
			"Algebraic.divide__overload$4",
			"Algebraic.divide__overload$5",
			"Algebraic.divide__overload$6",
			"Algebraic.is",
			"Algebraic.isNegative",
			"Algebraic.isPositive",
			"Algebraic.isWholeNumber",
			"Algebraic.isZero",
			"Algebraic.multiply__overload$4",
			"Algebraic.round__overload$2",
			"Algebraic.subtract__overload$1",
			"Algebraic.subtract__overload$2",
			"Algebraic.subtract__overload$3",
			"Algebraic.subtract__overload$4",
			"Algebraic.toString__overload$2",
			"Algebraic.toString__overload$3",
			"Boolean.exclusiveOr",
			"Boolean.toString",
			"Comparable.isGreaterThan",
			"Comparable.isGreaterThanOrEqualTo",
			"Comparable.isLessThan",
			"Comparable.isLessThanOrEqualTo",
			"Dictionary.count",
			"Dictionary.firstEntry__overload$2",
			"Dictionary.hasEntries__overload$1",
			"Dictionary.hasEntries__overload$2",
			"Dictionary.hasKey",
			"Dictionary.hasNoEntries",
			"Dictionary.hasOnlyEntries",
			"Dictionary.hasValue",
			"Dictionary.merge__overload$1",
			"Dictionary.merge__overload$2",
			"Dictionary.of__overload$2",
			"Dictionary.remove__overload$2",
			"Dictionary.update__overload$1",
			"Dictionary.update__overload$2",
			"Dictionary.value__overload$2",
			"Equatable.isNot",
			// Each waits for the receiver and answers something else, in one
			// line of Essence.
			"Future.andThen__overload$1",
			"Future.andThen__overload$2",
			"Future.map",
			"Generatable.shrink",
			// The verbs call the native `Http.send`, which is no Node.
			"Http.delete",
			"Http.get",
			"Http.head",
			"Http.patch",
			"Http.post",
			"Http.put",
			"Integer.add__overload$2",
			"Integer.add__overload$3",
			"Integer.add__overload$4",
			"Integer.approximate",
			"Integer.divide__overload$1",
			"Integer.divide__overload$2",
			"Integer.divide__overload$5",
			"Integer.divide__overload$6",
			"Integer.divide__overload$7",
			"Integer.factorial__overload$2",
			"Integer.isEven",
			"Integer.isGreaterThanOrEqualTo__overload$1",
			"Integer.isGreaterThanOrEqualTo__overload$2",
			"Integer.isGreaterThan__overload$1",
			"Integer.isGreaterThan__overload$2",
			"Integer.isLessThanOrEqualTo__overload$1",
			"Integer.isLessThanOrEqualTo__overload$2",
			"Integer.isLessThan__overload$1",
			"Integer.isLessThan__overload$2",
			"Integer.isMultiple",
			"Integer.isNegative",
			"Integer.isNot__overload$1",
			"Integer.isNot__overload$2",
			"Integer.isOdd",
			"Integer.isPositive",
			"Integer.isWholeNumber",
			"Integer.isZero",
			"Integer.is__overload$1",
			"Integer.is__overload$2",
			"Integer.multiply__overload$2",
			"Integer.multiply__overload$3",
			"Integer.multiply__overload$4",
			"Integer.parse__overload$1",
			"Integer.parse__overload$2",
			"Integer.parse__overload$4",
			"Integer.quotient__overload$3",
			"Integer.quotient__overload$4",
			"Integer.raise__overload$2",
			"Integer.remainder__overload$3",
			"Integer.remainder__overload$4",
			"Integer.round__overload$1",
			"Integer.round__overload$2",
			"Integer.squareRoot__overload$2",
			"Integer.subtract__overload$1",
			"Integer.subtract__overload$2",
			"Integer.subtract__overload$3",
			"Integer.subtract__overload$4",
			"Integer.toRational",
			"Integer.toString__overload$2",
			"Integer.toString__overload$3",
			"Integer.toString__overload$4",
			"Integer.toString__overload$5",
			"Integer.toString__overload$6",
			"Integer.toString__overload$7",
			"IntegerList.average__overload$1",
			"IntegerList.average__overload$2",
			"IntegerList.highestNumber__overload$1",
			"IntegerList.highestNumber__overload$2",
			"IntegerList.lowestNumber__overload$1",
			"IntegerList.lowestNumber__overload$2",
			"IntegerList.median__overload$1",
			"IntegerList.median__overload$2",
			"IntegerList.mode__overload$1",
			"IntegerList.mode__overload$2",
			"IntegerList.percentile__overload$1",
			"IntegerList.percentile__overload$2",
			"IntegerList.product",
			"IntegerList.runningTotal",
			"IntegerList.standardDeviation__overload$1",
			"IntegerList.standardDeviation__overload$2",
			"IntegerList.sum",
			"IntegerList.variance__overload$1",
			"IntegerList.variance__overload$2",
			"KeyedNumberList.average__overload$1",
			"KeyedNumberList.average__overload$2",
			"KeyedNumberList.product__overload$1",
			"KeyedNumberList.product__overload$2",
			"KeyedNumberList.product__overload$3",
			"KeyedNumberList.sum__overload$1",
			"KeyedNumberList.sum__overload$2",
			"KeyedNumberList.sum__overload$3",
			"List.contains__overload$1",
			"List.count__overload$1",
			"List.count__overload$2",
			"List.doesNotContain",
			"List.doesNotEnd",
			"List.doesNotStart",
			"List.ends",
			"List.everyIndex",
			"List.everyValue",
			"List.firstIndex__overload$1",
			"List.firstIndex__overload$2",
			"List.firstIndex__overload$3",
			"List.firstIndex__overload$4",
			"List.firstItem__overload$1",
			"List.firstItem__overload$2",
			"List.firstItem__overload$3",
			"List.firstItem__overload$4",
			"List.firstItems__overload$1",
			"List.firstItems__overload$2",
			"List.hasItems__overload$1",
			"List.hasItems__overload$2",
			"List.hasNoItems",
			"List.hasOnlyItems",
			"List.highestItem__overload$1",
			"List.highestItem__overload$2",
			"List.highestItem__overload$3",
			"List.highestItem__overload$4",
			"List.indices__overload$2",
			"List.isEmpty",
			"List.item__overload$2",
			"List.lastIndex__overload$1",
			"List.lastIndex__overload$2",
			"List.lastIndex__overload$4",
			"List.lastItem__overload$1",
			"List.lastItem__overload$2",
			"List.lastItem__overload$3",
			"List.lastItem__overload$4",
			"List.lastItems__overload$1",
			"List.lastItems__overload$2",
			"List.lowestItem__overload$1",
			"List.lowestItem__overload$2",
			"List.lowestItem__overload$3",
			"List.lowestItem__overload$4",
			"List.of__overload$2",
			"List.of__overload$5",
			"List.onlyItem__overload$1",
			"List.onlyItem__overload$2",
			"List.pad",
			"List.partition__overload$2",
			"List.partition__overload$3",
			"List.prepend__overload$2",
			"List.removeEvery__overload$1",
			"List.removeEvery__overload$2",
			"List.removeFirst__overload$1",
			"List.removeFirst__overload$2",
			"List.removeLast__overload$1",
			"List.removeLast__overload$2",
			"List.repeat__overload$1",
			"List.replace__overload$2",
			"List.split__overload$2",
			"List.starts",
			// `flatten` needs an `Optional<Optional<ItemType>>` receiver, so it
			// is a Node under its own Namespace, as `NestedList::flatten` is.
			"NestedOptional.flatten",
			// The same for a Result whose value is a Result.
			"NestedResult.flatten",
			"NonEmptyIntegerList.average",
			"NonEmptyIntegerList.highestNumber",
			"NonEmptyIntegerList.lowestNumber",
			"NonEmptyIntegerList.median",
			"NonEmptyIntegerList.percentile",
			"NonEmptyIntegerList.standardDeviation",
			"NonEmptyIntegerList.variance",
			"NonEmptyKeyedNumberList.average",
			"NonEmptyList.highestItem__overload$1",
			"NonEmptyList.highestItem__overload$2",
			"NonEmptyList.lowestItem__overload$1",
			"NonEmptyList.lowestItem__overload$2",
			"NonEmptyList.reduce",
			"NonEmptyList.replace__overload$2",
			"NonEmptyNumberList.average",
			"NonEmptyNumberList.highestNumber",
			"NonEmptyNumberList.lowestNumber",
			"NonEmptyNumberList.median",
			"NonEmptyNumberList.percentile",
			"NonEmptyNumberList.standardDeviation",
			"NonEmptyNumberList.variance",
			"NonEmptyRationalList.average",
			"NonEmptyRationalList.highestNumber",
			"NonEmptyRationalList.lowestNumber",
			"NonEmptyRationalList.median",
			"NonEmptyRationalList.percentile",
			"NonEmptyRationalList.standardDeviation",
			"NonEmptyRationalList.variance",
			"NonZeroInteger.multiply__overload$2",
			"NonZeroInteger.multiply__overload$3",
			"Number.average__overload$1",
			"Number.average__overload$2",
			"Number.average__overload$3",
			"Number.average__overload$4",
			"Number.average__overload$5",
			"Number.average__overload$6",
			"Number.average__overload$7",
			"Number.average__overload$8",
			"Number.average__overload$9",
			"Number.highest__overload$1",
			"Number.highest__overload$10",
			"Number.highest__overload$11",
			"Number.highest__overload$12",
			"Number.highest__overload$13",
			"Number.highest__overload$14",
			"Number.highest__overload$2",
			"Number.highest__overload$3",
			"Number.highest__overload$4",
			"Number.highest__overload$5",
			"Number.highest__overload$6",
			"Number.highest__overload$7",
			"Number.highest__overload$8",
			"Number.highest__overload$9",
			"Number.is",
			"Number.lowest__overload$1",
			"Number.lowest__overload$10",
			"Number.lowest__overload$11",
			"Number.lowest__overload$12",
			"Number.lowest__overload$13",
			"Number.lowest__overload$14",
			"Number.lowest__overload$2",
			"Number.lowest__overload$3",
			"Number.lowest__overload$4",
			"Number.lowest__overload$5",
			"Number.lowest__overload$6",
			"Number.lowest__overload$7",
			"Number.lowest__overload$8",
			"Number.lowest__overload$9",
			"Number.parse__overload$1",
			"Number.parse__overload$2",
			"Number.product__overload$1",
			"Number.product__overload$2",
			"Number.product__overload$3",
			"Number.sum__overload$1",
			"Number.sum__overload$2",
			"Number.sum__overload$3",
			"Number.toString",
			"NumberList.average__overload$1",
			"NumberList.average__overload$2",
			"NumberList.highestNumber__overload$1",
			"NumberList.highestNumber__overload$2",
			"NumberList.lowestNumber__overload$1",
			"NumberList.lowestNumber__overload$2",
			"NumberList.median__overload$1",
			"NumberList.median__overload$2",
			"NumberList.mode__overload$1",
			"NumberList.mode__overload$2",
			"NumberList.percentile__overload$1",
			"NumberList.percentile__overload$2",
			"NumberList.product",
			"NumberList.runningTotal",
			"NumberList.standardDeviation__overload$1",
			"NumberList.standardDeviation__overload$2",
			"NumberList.sum",
			"NumberList.variance__overload$1",
			"NumberList.variance__overload$2",
			"Optional.andThen",
			"Optional.hasValue__overload$1",
			"Optional.hasValue__overload$2",
			"Optional.isEmpty",
			"Optional.isNot__overload$1",
			"Optional.isNot__overload$2",
			"Optional.is__overload$1",
			"Optional.is__overload$2",
			"Optional.keep",
			"Optional.map",
			"Optional.or",
			"Optional.pair",
			"Optional.toList",
			"Optional.toResult",
			"Optional.value",
			// These need a `List<Optional<ItemType>>` receiver, so they live in
			// a Namespace of their own.
			"OptionalList.allValues",
			"OptionalList.firstValue",
			"OptionalList.values",
			"Orderable.clamp",
			"Orderable.isBetween",
			"Ordering.then__overload$1",
			"Ordering.then__overload$2",
			"Rational.add__overload$2",
			"Rational.add__overload$3",
			"Rational.add__overload$4",
			"Rational.approximate",
			"Rational.divide__overload$2",
			"Rational.divide__overload$4",
			"Rational.divide__overload$5",
			"Rational.divide__overload$6",
			"Rational.isGreaterThanOrEqualTo__overload$1",
			"Rational.isGreaterThanOrEqualTo__overload$2",
			"Rational.isGreaterThan__overload$1",
			"Rational.isGreaterThan__overload$2",
			"Rational.isLessThanOrEqualTo__overload$1",
			"Rational.isLessThanOrEqualTo__overload$2",
			"Rational.isLessThan__overload$1",
			"Rational.isLessThan__overload$2",
			"Rational.isNegative",
			"Rational.isNot__overload$1",
			"Rational.isNot__overload$2",
			"Rational.isPositive",
			"Rational.isWholeNumber",
			"Rational.isZero",
			"Rational.is__overload$1",
			"Rational.is__overload$2",
			"Rational.multiply__overload$2",
			"Rational.multiply__overload$3",
			"Rational.multiply__overload$4",
			"Rational.negate",
			"Rational.of__overload$3",
			"Rational.parse__overload$1",
			"Rational.parse__overload$2",
			"Rational.quotient__overload$1",
			"Rational.quotient__overload$2",
			"Rational.quotient__overload$3",
			"Rational.raise__overload$2",
			"Rational.reciprocal__overload$1",
			"Rational.reciprocal__overload$2",
			"Rational.remainder__overload$1",
			"Rational.remainder__overload$2",
			"Rational.remainder__overload$3",
			"Rational.round__overload$1",
			"Rational.round__overload$2",
			"Rational.squareRoot__overload$2",
			"Rational.subtract__overload$2",
			"Rational.subtract__overload$3",
			"Rational.subtract__overload$4",
			"Rational.toRational",
			"Rational.toString__overload$1",
			"Rational.toString__overload$6",
			"RationalList.average__overload$1",
			"RationalList.average__overload$2",
			"RationalList.highestNumber__overload$1",
			"RationalList.highestNumber__overload$2",
			"RationalList.lowestNumber__overload$1",
			"RationalList.lowestNumber__overload$2",
			"RationalList.median__overload$1",
			"RationalList.median__overload$2",
			"RationalList.mode__overload$1",
			"RationalList.mode__overload$2",
			"RationalList.percentile__overload$1",
			"RationalList.percentile__overload$2",
			"RationalList.product",
			"RationalList.runningTotal",
			"RationalList.standardDeviation__overload$1",
			"RationalList.standardDeviation__overload$2",
			"RationalList.sum",
			"RationalList.variance__overload$1",
			"RationalList.variance__overload$2",
			// Both read only what the Record holds, so both are written in
			// Essence.
			"Response.header",
			"Response.isSuccessful",
			// Every `Result` Method but `toString` is written in Essence.
			"Result.andThen",
			"Result.hasFailed",
			"Result.hasValue__overload$1",
			"Result.hasValue__overload$2",
			"Result.isNot__overload$1",
			"Result.isNot__overload$2",
			"Result.is__overload$1",
			"Result.is__overload$2",
			"Result.keep",
			"Result.map",
			"Result.mapFailure",
			"Result.or",
			"Result.reason",
			"Result.recover",
			"Result.toList",
			"Result.value__overload$1",
			"Result.value__overload$2",
			// Running a description again starts it again, so the retry calls
			// itself.
			"ResultFuture.attempt__overload$1",
			"ResultFuture.attempt__overload$2",
			// These need a `List<Result<…>>` receiver, as `OptionalList`'s do.
			"ResultList.allValues",
			"ResultList.partition",
			"ResultList.reasons",
			"ResultList.values",
			// The Namespace of the Union `Integer | Rational`. A Node is a body,
			// whatever its Namespace targets.
			"Scalar.add",
			"Scalar.multiply",
			"String.capitalize",
			"String.character__overload$2",
			"String.compare__overload$2",
			"String.contains__overload$1",
			"String.contains__overload$2",
			"String.doesNotContain__overload$1",
			"String.doesNotContain__overload$2",
			"String.doesNotEnd__overload$1",
			"String.doesNotEnd__overload$2",
			"String.doesNotStart__overload$1",
			"String.doesNotStart__overload$2",
			"String.firstCharacter__overload$1",
			"String.firstCharacter__overload$2",
			"String.firstIndex__overload$2",
			"String.hasCharacters",
			"String.indent",
			"String.isEmpty",
			"String.isOneCharacter",
			"String.is__overload$1",
			"String.is__overload$2",
			"String.lastCharacter__overload$1",
			"String.lastCharacter__overload$2",
			"String.lastIndex__overload$2",
			"String.lines",
			"String.pad",
			"String.prepend",
			"String.remove__overload$1",
			"String.remove__overload$2",
			"String.replaceEvery__overload$1",
			"String.replaceFirst__overload$1",
			"String.split__overload$3",
			"String.split__overload$4",
			"String.starts__overload$1",
			"String.toString",
			"String.truncate",
			"Terminal.ask",
			"Terminal.print",
			// `Transcendental.is`, `Transcendental.absolute` and `List.toString`
			// are natives, so they are no Nodes.
			"Transcendental.divide__overload$4",
			"Transcendental.divide__overload$5",
			"Transcendental.divide__overload$6",
			"Transcendental.isNegative",
			"Transcendental.isWholeNumber",
			"Transcendental.isZero",
			"Transcendental.round__overload$2",
			"Transcendental.subtract__overload$1",
			"Transcendental.subtract__overload$2",
			"Transcendental.subtract__overload$3",
			"Transcendental.toString__overload$2",
			"Transcendental.toString__overload$3",
			// The bodied free Functions under their emitted names. `loop`'s
			// `while` and `step` entries are native. The `upTo` entries `$5` and
			// `$8` are written on the `through` entries `$3` and `$7`.
			"loop__overload$2",
			"loop__overload$3",
			"loop__overload$5",
			"loop__overload$6",
			"loop__overload$7",
			"loop__overload$8",
			"loop__overload$9",
		])
	})

	it("records the Methods a body calls, native ones aside", () => {
		let graph = graphOf(`declarations {
	namespace Boolean for Boolean {
		§§ Whether the Boolean is not the other one.
		§§
		§§ @param _ — the Boolean to compare with
		§§ @returns — whether they differ.
		isNot(_ other: Boolean) -> Boolean {
			<- @::is(other)::negate()
		}

		§§ Whether both Booleans are the same.
		§§
		§§ @param _ — the Boolean to compare with
		§§ @returns — whether they match.
		is(_ other: Boolean) -> Boolean {
			<- @::and(other)
		}

		§§ Both Booleans at once.
		§§
		§§ @param _ — the Boolean to combine with
		§§ @returns — the conjunction.
		and(_ other: Boolean) -> Boolean

		§§ The other Boolean.
		§§
		§§ @returns — the negation.
		negate() -> Boolean
	}
}`)

		// `negate` and `and` are natives, invoked but not Nodes.
		expect(graph.get("Boolean.isNot")).toEqual(new Set(["Boolean.is"]))
		expect(graph.get("Boolean.is")).toEqual(new Set())
	})

	// A static Method call is a `FunctionInvocation`, whether an instance
	// Method or another static makes it.
	it("records an edge to a static Method a body calls", () => {
		let graph = graphOf(`declarations {
	namespace Boolean for Boolean {
		§§ Whether the Boolean matches, the long way around.
		§§
		§§ @param _ — the Boolean to compare with
		§§ @returns — whether they match.
		alpha(_ other: Boolean) -> Boolean {
			<- Boolean.beta(other)
		}

		§§ A static helper that defers to another static.
		§§
		§§ @param _ — the Boolean.
		§§ @returns — the Boolean unchanged.
		static beta(_ value: Boolean) -> Boolean {
			<- Boolean.gamma(value)
		}

		§§ A static helper that reads a Record field — a Lookup that is NOT
		§§ a Method call and must not become an edge.
		§§
		§§ @param _ — the Boolean.
		§§ @returns — the Boolean unchanged.
		static gamma(_ value: Boolean) -> Boolean {
			constant boxed = { field = value }
			<- boxed.field
		}
	}
}`)

		expect(graph.get("Boolean.alpha")).toEqual(new Set(["Boolean.beta"]))
		expect(graph.get("Boolean.beta")).toEqual(new Set(["Boolean.gamma"]))
		// `boxed.field` is a `Lookup` off a Record, so it is no edge.
		expect(graph.get("Boolean.gamma")).toEqual(new Set())
	})

	// Without a planted cycle, a `findCycle` that always answered null would
	// pass every other test here.
	it("reports a cycle as the path around it", () => {
		let cycle = findCycle(
			graphOf(`declarations {
	namespace Boolean for Boolean {
		§§ Whether the Boolean is not the other one.
		§§
		§§ @param _ — the Boolean to compare with
		§§ @returns — whether they differ.
		isNot(_ other: Boolean) -> Boolean {
			<- @::is(other)
		}

		§§ Whether both Booleans are the same.
		§§
		§§ @param _ — the Boolean to compare with
		§§ @returns — whether they match.
		is(_ other: Boolean) -> Boolean {
			<- @::isNot(other)
		}
	}
}`),
		)

		expect(cycle).toEqual(["Boolean.isNot", "Boolean.is", "Boolean.isNot"])
	})

	// Two statics that defer to each other overflow the stack just as two
	// instance Methods do.
	it("reports a cycle between two static Methods", () => {
		let cycle = findCycle(
			graphOf(`declarations {
	namespace Boolean for Boolean {
		§§ Beta defers to gamma.
		§§
		§§ @param _ — the Boolean.
		§§ @returns — the Boolean.
		static beta(_ value: Boolean) -> Boolean {
			<- Boolean.gamma(value)
		}

		§§ Gamma defers back to beta.
		§§
		§§ @param _ — the Boolean.
		§§ @returns — the Boolean.
		static gamma(_ value: Boolean) -> Boolean {
			<- Boolean.beta(value)
		}
	}
}`),
		)

		expect(cycle).toEqual(["Boolean.beta", "Boolean.gamma", "Boolean.beta"])
	})

	// A cycle across the instance and static boundary needs both the
	// `FunctionInvocation` and the `MethodInvocation` edge to be seen.
	it("reports a cycle across the instance/static boundary", () => {
		let cycle = findCycle(
			graphOf(`declarations {
	namespace Boolean for Boolean {
		§§ Alpha defers to the static beta.
		§§
		§§ @param _ — the Boolean.
		§§ @returns — the Boolean.
		alpha(_ other: Boolean) -> Boolean {
			<- Boolean.beta(other)
		}

		§§ Beta calls alpha back on its argument.
		§§
		§§ @param _ — the Boolean.
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

	// Free Functions are Nodes of the same graph, and each fixture holds one
	// kind of edge on a library of its own.
	describe("free Functions", () => {
		// A free Function reaching a Method, and a Method reaching a free
		// Function.
		it("records an edge in either direction across the boundary", () => {
			let graph = graphOf(`declarations {
	§§ Doubles the value.
	§§
	§§ @param _ — the Integer to double.
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

		// One entry of an `overload function` block written on another, as
		// `loop`'s bodied entries are.
		it("records an edge between two entries of one overload block", () => {
			let graph = graphOf(`declarations {
	§§ Combines a value with itself.
	§§
	§§ @param value — the Integer.
	§§ @returns — the Integer.
	overload function combine {
		§§ The plain entry.
		§§
		§§ @param first — the Integer.
		§§ @returns — the Integer.
		(first value: Integer) -> Integer {
			<- value
		}

		§§ The entry written on the first.
		§§
		§§ @param second — the Integer.
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
	§§ @param _ — the Integer.
	§§ @returns — the Integer.
	function alpha(_ value: Integer) -> Integer {
		<- beta(value)
	}

	§§ Beta defers back to alpha.
	§§
	§§ @param _ — the Integer.
	§§ @returns — the Integer.
	function beta(_ value: Integer) -> Integer {
		<- alpha(value)
	}
}`),
			)

			expect(cycle).toEqual(["alpha", "beta", "alpha"])
		})

		// A cycle that leaves a Method for a free Function and comes back.
		it("reports a cycle across the Method boundary", () => {
			let cycle = findCycle(
				graphOf(`declarations {
	§§ Alpha calls the Method back on its argument.
	§§
	§§ @param _ — the Integer.
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

	// The static Properties' graph asks whether their consts can be emitted
	// in any order at all.
	describe("static Properties", () => {
		// No standard library Property has a value, so the graph is empty
		// until one does.
		it("has no cycle among the Essence-implemented static Properties", () => {
			let cycle = findCycle(
				buildPropertyGraph(stdlibPrelude(), stdlibFreeFunctions()),
				true,
			)

			if (cycle !== null) {
				throw new Error(
					`The Essence-implemented standard library Properties read each other in a cycle, so no order of their consts can initialise them all:\n\n  ${cycle.join(
						" -> ",
					)}`,
				)
			}
		})

		// The Validator lets a Property read only Properties written before it,
		// so no source can spell a cycle. The cyclic fixtures are built
		// directly.
		it("records a read of one static Property by another", () => {
			let graph = propertyGraphOf(`declarations {
	namespace Other for Integer {
		§§ The base value.
		static BASE: Integer = 2

		§§ Twice the value.
		§§
		§§ @returns — twice the value.
		doubled() -> Integer {
			<- @
		}
	}

	namespace Constants for Integer {
		§§ Twice the base.
		static DOUBLE: Integer = Other.BASE::doubled()
	}
}`)

			expect(graph.get("Constants.DOUBLE")).toEqual(
				new Set(["Other.BASE"]),
			)
			// `Other.doubled` is a Method, so it is no Node of this graph.
			expect(graph.get("Other.BASE")).toEqual(new Set())
		})

		// A Property read through its own Namespace's name, as in
		// `static Tau = Number.Pi`, is an edge too.
		it("records a read of one static Property by another in the same Namespace", () => {
			let graph = propertyGraphOf(`declarations {
	namespace Constants for Integer {
		§§ The base value.
		static BASE: Integer = 2

		§§ The base value, read through the Namespace's own name.
		static ECHO: Integer = Constants.BASE
	}
}`)

			expect(graph.get("Constants.ECHO")).toEqual(
				new Set(["Constants.BASE"]),
			)
			expect(graph.get("Constants.BASE")).toEqual(new Set())
		})

		// `Constants.DOUBLE` calls `Reader.readsBase` where its const stands, so
		// `Other.BASE` is read before it is bound, and that is an edge.
		it("records a read of a static Property through a Method it calls", () => {
			let graph = propertyGraphOf(`declarations {
	namespace Other for Integer {
		§§ The base value.
		static BASE: Integer = 2
	}

	namespace Reader for Integer {
		§§ The base value, read the long way around.
		§§
		§§ @returns — the base value.
		readsBase() -> Integer {
			<- Other.BASE
		}
	}

	namespace Constants for Integer {
		§§ The base value, once removed.
		static DOUBLE: Integer = 3::readsBase()
	}
}`)

			expect(graph.get("Constants.DOUBLE")).toEqual(
				new Set(["Other.BASE"]),
			)
		})

		// The same edge one step longer, through a free Function.
		it("records a read of a static Property through a free Function it calls", () => {
			let graph = propertyGraphOf(`declarations {
	namespace Other for Integer {
		§§ The base value.
		static BASE: Integer = 2
	}

	§§ The base value, read the long way around.
	§§
	§§ @returns — the base value.
	function readsBase() -> Integer {
		<- Other.BASE
	}

	namespace Constants for Integer {
		§§ The base value, once removed.
		static DOUBLE: Integer = readsBase()
	}
}`)

			expect(graph.get("Constants.DOUBLE")).toEqual(
				new Set(["Other.BASE"]),
			)
		})

		it("reports a cycle between two static Properties", () => {
			expect(
				findCycle(
					new Map([
						["A.ONE", new Set(["B.TWO"])],
						["B.TWO", new Set(["A.ONE"])],
					]),
					true,
				),
			).toEqual(["A.ONE", "B.TWO", "A.ONE"])
		})

		// A Property that reads itself is a cycle, where a Method that calls
		// itself is recursion.
		it("reports a static Property that reads itself", () => {
			expect(
				findCycle(new Map([["A.ONE", new Set(["A.ONE"])]]), true),
			).toEqual(["A.ONE", "A.ONE"])
		})
	})

	// A self-call is recursion, not a cycle. It sits behind a base case, since
	// `graphOf` validates and an unconditional self-call is `infinite-recursion`.
	it("leaves direct self-recursion alone", () => {
		let cycle = findCycle(
			graphOf(`declarations {
	namespace Boolean for Boolean {
		§§ Whether both Booleans are the same, the long way around.
		§§
		§§ @param _ — the Boolean to compare with
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
