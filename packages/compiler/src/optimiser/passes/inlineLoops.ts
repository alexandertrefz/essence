import type { common } from "@essence-lang/interfaces"

import type { OptimiserPass } from "../index"
import { rewriteNodes } from "../walk"

// Writes a driver call whose callbacks are all literals out as a JavaScript
// `while` or `for`, with each callback's body where its call was. A `Step` is
// read where it is built. See "inline-loops" in DEVELOPMENT.md.

export const inlineLoops: OptimiserPass = {
	name: "inline-loops",
	run: (program, namespaces) => {
		// A nested `List` or `NonEmptyList` Namespace may declare its own walks. The
		// free `loop` entries need no guard, since no name a Program writes holds a `_`.
		let shadowed = namespaces.nested
		let inlining = new Inlining(shadowed)

		return rewriteNodes(program, {
			expression: (node) => inlining.expression(node),
			statement: (node) => inlining.statement(node),
		})
	},
}

// Unspellable in Essence, and numbered across the Program, since an inner
// loop shares the Scope of the loop it is inlined into.
const loopPrefix = "$loop_"

class Inlining {
	private count = 0

	constructor(private readonly shadowed: ReadonlySet<string>) {}

	expression(
		node: common.typedSimple.ExpressionNode,
	): common.typedSimple.ExpressionNode {
		let driver = this.driverOf(node)

		if (driver === null) {
			return node
		}

		return {
			nodeType: "Intrinsic",
			kind: "inline-loop",
			name: `${loopPrefix}${this.count++}`,
			driver,
			type: node.type,
			position: node.position,
		}
	}

	// A loop in a Statement position needs no arrow around it.
	// `lower-matches-to-statements` runs earlier and never sees it, so the lifting
	// is done here.
	statement(
		node: common.typedSimple.ImplementationNode,
	): common.typedSimple.ImplementationNode {
		switch (node.nodeType) {
			case "ReturnStatement":
				return this.lifted(node.expression, { kind: "return" }, node)
			case "VariableDeclarationStatement":
				return this.lifted(
					node.value,
					{ kind: "declaration", name: node.name },
					node,
				)
			case "VariableAssignmentStatement":
				return this.lifted(
					node.value,
					{ kind: "assignment", name: node.name },
					node,
				)
			// Declarations, and Statements already lifted.
			case "NamespaceDefinitionStatement":
			case "ProtocolDeclarationStatement":
			case "TypeAliasStatement":
			case "FunctionStatement":
			case "ConditionalStatement":
			// An assertion is tested where it stands.
			case "TestAssertionStatement":
			// A loop turn has no answer of its own.
			case "TailCallStatement":
			case "IntrinsicStatement":
				return node
			default:
				// An Expression written for its effects, whose answer goes nowhere.
				return this.lifted(node, { kind: "discard" }, node)
		}
	}

	private lifted<Node extends common.typedSimple.ImplementationNode>(
		value: common.typedSimple.ExpressionNode,
		result: common.typedSimple.StatementResult,
		source: Node,
	): Node | common.typedSimple.InlineLoopStatementNode {
		if (value.nodeType !== "Intrinsic" || value.kind !== "inline-loop") {
			return source
		}

		return {
			nodeType: "IntrinsicStatement",
			kind: "inline-loop",
			name: value.name,
			driver: value.driver,
			result,
			position: source.position,
		}
	}

	// Which walk this call is, or null.
	private driverOf(
		node: common.typedSimple.ExpressionNode,
	): common.typedSimple.InlineLoopDriver | null {
		// A call that left an Argument out stays, since the callee's defaults have no
		// binding in the written-out body.
		if (node.nodeType === "FunctionInvocation") {
			return node.omitsArguments === true ? null : this.freeLoop(node)
		}

		if (node.nodeType === "MethodInvocation") {
			return node.omitsArguments === true ? null : this.listWalk(node)
		}

		return null
	}

	private freeLoop(
		node: common.typedSimple.FunctionInvocationNode,
	): common.typedSimple.InlineLoopDriver | null {
		if (node.name.nodeType !== "Identifier") {
			return null
		}

		// The mangled number follows the order of `Loop.es`, so each entry also checks
		// its labels, in order.
		switch (node.name.name) {
			// The `while` walk, and `until`, which reads the condition the other way.
			case "loop__overload$1":
				return this.conditionLoop(node, "while", false)
			case "loop__overload$2":
				return this.conditionLoop(node, "until", true)
			case "loop__overload$3":
				return this.countedLoop(node, "through", false)
			case "loop__overload$4":
				return this.generalLoop(node)
			// The down-counting entry. The `Step` counted entries are written on the
			// general loop instead.
			case "loop__overload$6":
				return this.countedLoop(node, "downTo", true)
			default:
				return null
		}
	}

	private conditionLoop(
		node: common.typedSimple.FunctionInvocationNode,
		label: string,
		until: boolean,
	): common.typedSimple.InlineLoopDriver | null {
		let args = argumentsNamed(node.arguments, ["startingWith", label, null])

		if (args === null) {
			return null
		}

		let [seed, condition, advance] = args
		let predicate = callbackOf(condition!, 1)
		let step = callbackOf(advance!, 1)

		if (predicate === null || step === null) {
			return null
		}

		return { kind: "condition", until, seed: seed!, predicate, step }
	}

	private countedLoop(
		node: common.typedSimple.FunctionInvocationNode,
		label: string,
		descending: boolean,
	): common.typedSimple.InlineLoopDriver | null {
		let args = argumentsNamed(node.arguments, [
			"from",
			label,
			"startingWith",
			null,
		])

		if (args === null) {
			return null
		}

		let [from, through, seed, advance] = args

		// The emission reads the raw value each bound holds, so they are
		// checked to be Integers.
		if (from!.type.type !== "Integer" || through!.type.type !== "Integer") {
			return null
		}

		let step = callbackOf(advance!, 2)

		if (step === null) {
			return null
		}

		return {
			kind: "counted",
			descending,
			from: from!,
			through: through!,
			seed: seed!,
			step,
		}
	}

	private generalLoop(
		node: common.typedSimple.FunctionInvocationNode,
	): common.typedSimple.InlineLoopDriver | null {
		let args = argumentsNamed(node.arguments, ["startingWith", "step"])

		if (args === null) {
			return null
		}

		let [seed, advance] = args
		let step = callbackOf(advance!, 1)

		if (step === null) {
			return null
		}

		return { kind: "general", seed: seed!, step }
	}

	private listWalk(
		node: common.typedSimple.MethodInvocationNode,
	): common.typedSimple.InlineLoopDriver | null {
		if (this.shadowed.has(node.base.name)) {
			return null
		}

		// `NonEmptyList` re-declares `map` as `List`'s own, so the same walk runs.
		// No other walk is declared on both.
		if (node.base.name === "NonEmptyList") {
			return node.member.name === "map" ? this.mapWalk(node) : null
		}

		if (node.base.name !== "List") {
			return null
		}

		switch (node.member.name) {
			case "map":
				return this.mapWalk(node)
			// The filter is mangled, since `everyItem(alsoIn:)` stands beside it as a
			// native with no walk to write out.
			case "everyItem__overload$1":
				return this.keepWalk(node)
			case "reduce__overload$1":
				return this.foldWalk(node, false)
			case "reduce__overload$2":
				return this.foldWalk(node, true)
			default:
				return null
		}
	}

	private mapWalk(
		node: common.typedSimple.MethodInvocationNode,
	): common.typedSimple.InlineLoopDriver | null {
		let args = listArguments(node, [null])

		if (args === null) {
			return null
		}

		let [items, transform] = args
		let callback = callbackOf(transform!, 1)

		if (callback === null) {
			return null
		}

		return { kind: "map", items: items!, transform: callback }
	}

	private keepWalk(
		node: common.typedSimple.MethodInvocationNode,
	): common.typedSimple.InlineLoopDriver | null {
		let args = listArguments(node, ["where"])

		if (args === null) {
			return null
		}

		let [items, check] = args
		let callback = callbackOf(check!, 1)

		if (callback === null) {
			return null
		}

		return { kind: "keep", items: items!, check: callback }
	}

	private foldWalk(
		node: common.typedSimple.MethodInvocationNode,
		stepped: boolean,
	): common.typedSimple.InlineLoopDriver | null {
		let args = listArguments(node, [
			"startingWith",
			stepped ? "step" : null,
		])

		if (args === null) {
			return null
		}

		let [items, seed, combine] = args
		let step = callbackOf(combine!, 2)

		if (step === null) {
			return null
		}

		return { kind: "fold", stepped, items: items!, seed: seed!, step }
	}
}

// The Arguments under the labels the entry declares, in that order, which is
// the order they are evaluated in. Null for any other call.
function argumentsNamed(
	args: Array<common.typedSimple.ArgumentNode>,
	names: Array<string | null>,
): Array<common.typedSimple.ExpressionNode> | null {
	if (args.length !== names.length) {
		return null
	}

	let values: Array<common.typedSimple.ExpressionNode> = []

	for (let [index, name] of names.entries()) {
		let argument = args[index]

		if (argument === undefined || argument.name !== name) {
			return null
		}

		values.push(argument.value)
	}

	return values
}

// The receiver and the labelled Arguments. The receiver has to be exactly a
// List, whose `.value` the walk reads.
function listArguments(
	node: common.typedSimple.MethodInvocationNode,
	names: Array<string | null>,
): Array<common.typedSimple.ExpressionNode> | null {
	let args = argumentsNamed(node.arguments, ["@", ...names])

	if (args === null || args[0]!.type.type !== "List") {
		return null
	}

	return args
}

// A Function literal of the shape the driver calls, or null. Two Parameters
// under one name would declare a `const` twice.
function callbackOf(
	value: common.typedSimple.ExpressionNode,
	parameterCount: number,
): common.typedSimple.InlineLoopCallback | null {
	if (value.nodeType !== "FunctionValue") {
		return null
	}

	// A completing callback stays, since its `await`s would land in a Function
	// that can not wait.
	if (value.value.completing === true) {
		return null
	}

	// The parser refuses a default on a Function literal's Parameter, and a
	// `const` has nowhere to put one.
	if (
		value.value.parameters.some(
			(parameter) => parameter.defaultValue !== null,
		)
	) {
		return null
	}

	let parameters = value.value.parameters.map(
		(parameter) => parameter.internalName,
	)

	if (parameters.length !== parameterCount) {
		return null
	}

	if (
		new Set(parameters.map((parameter) => parameter.name)).size !==
		parameterCount
	) {
		return null
	}

	return { parameters, body: value.value.body }
}
