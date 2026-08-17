import type { common } from "@essence-lang/interfaces"

import type { OptimiserPass } from "../index"
import { rewriteNodes } from "../walk"

// NOTE: Essence has no loop Statement. A walk is a driver Function handed
// callbacks — `loop(startingWith 0, while (n) { … }, step (n) { … })` — and the
// driver calls them, one closure call per callback per turn, threading whatever
// they answer with between them. That is the language's whole answer to
// iteration, and it is a good one: the control flow is a value, so a Match can
// read it and `<-` keeps its one meaning. It is also the most expensive shape a
// Program can be written in, because the Compiler knows every part of it and
// emitted none of it:
//
//   loop__overload$1(state, function (n) { … }, function (n) { … })
//
// Which driver it is, is the name. What the callbacks do, is their bodies. So
// the walk is written out where the call stands — a real `while` or `for` — with
// each body where the call to it was:
//
//   let $loop_0_state = state;
//   while (true) {
//     { const n = $loop_0_state; if (!(…)) break $loop_0; }
//     { const n = $loop_0_state; $loop_0_state = …; }
//   }
//
// NOTE: The counted entry does not go through its driver at all. `loop(from:
// through:startingWith:step:)` is written in Essence on the `while` driver and
// threads `{ index, carried }` — a Record built per turn, around an Integer
// built per turn, checked by a closure and advanced by another. Inlined it is a
// `for` over the bigint the Integers hold, and the only allocation left is the
// Integer the body is handed.
//
// NOTE: A `Step` a callback answers with is read where it is BUILT. The general
// loop and `reduce`'s early-stopping entry both decide by a tag the body has
// just written — `#Done(x)` stops the walk with `x`, `#Continue(x)` carries `x`
// on — so where the Compiler can see the construction at the answering position,
// the Case is never built: the walk assigns and leaves. Where it can not see one
// — a `Step` held under a name, or one a nested walk answers with — the tag is
// read exactly as the driver read it, at that one site.
//
// NOTE: What decides whether a call is inlined at all is whether every callback
// is written AT the call. A Function-valued name is whatever was bound to it,
// which is a value this pass can not read, so the call stays exactly what it
// was. That is also why the standard library's own walks inline: `firstItem
// (where:)`, `firstIndex(of:)`, `count(where:)` and the rest are written on
// `reduce` and `keepEvery` with literal callbacks, so the loop inside each of
// THEM is written out, once, in the prelude — the Program's own call still calls
// that Method, and what it calls no longer allocates a `Step` per item.

export const inlineLoops: OptimiserPass = {
	name: "inline-loops",
	run: (program, namespaces) => {
		// NOTE: `List` is a name a Program may take for itself — nested, where
		// it is not taken yet — and a `namespace List for List` writing its own
		// `map` answers under exactly the name and shape this pass is written
		// for. `NonEmptyList`, which the walk below reads for the same Method,
		// is such a name too. The same set answers it for every other pass that
		// reads a Namespace by name: a name a Program declares below its own top
		// level is not the standard library's here.
		//
		// NOTE: The free `loop` entries need no such guard. They are reached by
		// their mangled `loop__overload$N` name, an `overload function` block is
		// refused outside the standard library, and no name a Program can write
		// holds a `_` — the Lexer reads it as a Symbol. There is no Program that
		// can put a different Function behind those four names.
		let shadowed = namespaces.nested
		let inlining = new Inlining(shadowed)

		return rewriteNodes(program, {
			expression: (node) => inlining.expression(node),
			statement: (node) => inlining.statement(node),
		})
	},
}

// NOTE: Unspellable in Essence, like every other name the Compiler binds for
// itself, and numbered across the whole Program rather than per Function: a loop
// inlined into another loop's body stands in the Scope that one threads its
// State in, and two loops numbered from zero would declare one name twice.
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

	// NOTE: A loop standing where a Statement may be written, which is where the
	// arrow around it is not needed — the same three positions
	// `lower-matches-to-statements` lifts a Match out of, and a fourth: a walk
	// written for its effects. That pass runs BEFORE this one and can not see a
	// loop this one has not made yet, so the lifting is done here rather than
	// there.
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
			// NOTE: A declaration holds no Expression standing for its own
			// answer, and a lowered Statement is one already lifted.
			case "NamespaceDefinitionStatement":
			case "ProtocolDeclarationStatement":
			case "TypeAliasStatement":
			case "FunctionStatement":
			case "ConditionalStatement":
			case "IntrinsicStatement":
				return node
			default:
				// NOTE: An Expression written for its effects — what it answers
				// goes nowhere, and the walk still runs.
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

	// NOTE: WHICH walk this call is, and null for every call that is not one of
	// them or that was handed a callback this pass can not read.
	private driverOf(
		node: common.typedSimple.ExpressionNode,
	): common.typedSimple.InlineLoopDriver | null {
		// NOTE: A call that left an Argument out is left alone. This pass writes
		// the CALLEE'S BODY out where the call stands, and the callee's own
		// default parameters are what would have filled the Argument in — there
		// is no binding here for them to fill, and the Argument list this pass
		// reads is the one the call WROTE. None of the seven callees it inlines
		// carries a default today (`loop`'s entries and `reduce`'s are dispatched
		// by their label sets, which is what an `overload` block is for), so this
		// costs nothing; it is here so that a default written on one of them
		// later is a missed optimisation rather than a wrong Program.
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

		// NOTE: The mangled number is which ENTRY of the Overload was resolved,
		// which is decided by the order they are written in `Loop.es` — so it is
		// not on its own what says which walk this is. Each entry below also
		// names the labels it expects, in the order the entry declares them, and
		// a call whose labels do not match is left alone: a `Loop.es` written in
		// a different order can not make one of these read as another, it can
		// only stop them reading at all.
		switch (node.name.name) {
			// NOTE: The `while` driver and its `until` sibling, which is the
			// same call with the predicate read the other way round —
			// `loop__overload$2` IS `loop__overload$1` with a negating closure
			// around the condition, and inlining reads the answer the other way
			// instead of building one.
			case "loop__overload$1":
				return this.conditionLoop(node, "while", false)
			case "loop__overload$2":
				return this.conditionLoop(node, "until", true)
			case "loop__overload$3":
				return this.countedLoop(node)
			case "loop__overload$4":
				return this.generalLoop(node)
			default:
				return null
		}
	}

	private conditionLoop(
		node: common.typedSimple.FunctionInvocationNode,
		label: string,
		until: boolean,
	): common.typedSimple.InlineLoopDriver | null {
		let args = argumentsNamed(node.arguments, [
			"startingWith",
			label,
			"step",
		])

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
	): common.typedSimple.InlineLoopDriver | null {
		let args = argumentsNamed(node.arguments, [
			"from",
			"through",
			"startingWith",
			"step",
		])

		if (args === null) {
			return null
		}

		let [from, through, seed, advance] = args

		// NOTE: The bounds are Integers, always — the Overload takes no other
		// Type — and the emission reads the bigint each of them holds. Asked
		// anyway, because what an emission rests on is what the pass has to
		// check.
		if (from!.type.type !== "Integer" || through!.type.type !== "Integer") {
			return null
		}

		let step = callbackOf(advance!, 2)

		if (step === null) {
			return null
		}

		return {
			kind: "counted",
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

		// NOTE: A refinement is erased at the head of the stage, before the
		// first pass runs, so a List a Program has proven has something in it
		// arrives here as the ordinary List it always was — the Type gate below
		// asks that unchanged. What survives erasure is the Namespace the
		// Simplifier NAMED, and `NonEmptyList` declares a `map` of its own so
		// that it may promise the answer is not empty either. That promise is
		// the whole of the difference: the runtime Method behind it is `List`'s
		// own `map`, re-exported, so the walk written out here is the walk that
		// would have run.
		//
		// NOTE: Per Method rather than per Namespace, and `map` is the only one
		// the two share. `keepEvery` and both `reduce` entries are not declared
		// on `NonEmptyList` at all — each can answer with fewer items than it
		// was handed — so a proven receiver reaches `List`'s own entry by
		// widening and is emitted under `List`'s own name, which is why they
		// were never affected. Everything else that Namespace declares stays
		// refused until somebody weighs it: `reverse` and `sort` are re-exports
		// this pass does not walk, and `prepend(contentsOf:)`,
		// `removeDuplicates` and `replace` are not `List`'s Functions at all.
		if (node.base.name === "NonEmptyList") {
			return node.member.name === "map" ? this.mapWalk(node) : null
		}

		if (node.base.name !== "List") {
			return null
		}

		switch (node.member.name) {
			case "map":
				return this.mapWalk(node)
			case "keepEvery":
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

// NOTE: The Arguments a call was given, in the order it evaluated them, and null
// where the call is not the one this pass is looking for. The names are the
// labels the entry declares and the ORDER is the one it declares them in:
// Essence refuses a call that labels them any other way, so the order the
// Arguments arrive in is the order they are evaluated in, and the emission
// evaluates them in exactly that order.
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

// NOTE: A Method's Arguments, which are the receiver and then the labelled ones.
// The receiver has to BE a List: a Method Invocation carries the Namespace that
// answers it, and a covering Namespace or a Type Parameter standing where a List
// is expected is not the value these walks read `.value` off.
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

// NOTE: One callback, and null unless it is a Function LITERAL of exactly the
// shape the driver calls it with. A name bound to a Function is a value this
// pass can not read; a Parameter count that disagrees is a call shape it did not
// expect; and two Parameters under one name — which the Enricher refuses, and
// which is checked here because the emission binds each of them as a `const` —
// would be a name declared twice.
function callbackOf(
	value: common.typedSimple.ExpressionNode,
	parameterCount: number,
): common.typedSimple.InlineLoopCallback | null {
	if (value.nodeType !== "FunctionValue") {
		return null
	}

	// NOTE: A callback's Parameter can not carry a default — a Function literal
	// is refused one at the Parser, since its arity is fixed by the Function
	// Type it was written for — and this pass binds each Parameter as a `const`,
	// which has nowhere to put one. Asked rather than assumed, because what
	// makes it true is a rule somewhere else.
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
