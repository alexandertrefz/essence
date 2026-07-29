import type { common } from "@essence-lang/interfaces"

import type { OptimiserPass } from "../index"
import { declaredNamespaces } from "../namespaces"
import { isPureExpression } from "../purity"
import { rewriteStatements } from "../walk"

// NOTE: A Match is an Expression in Essence and its Handlers are Statements, so
// the Rewriter had one way of saying it: wrap the chain in a Function and call
// it, which is the only Expression JavaScript lets hold Statements.
//
//   (function (_self) {
//     if (_self[$type.typeKeySymbol] === "Optional#Value") { return … }
//     return …
//   })(value)
//
// That is a closure built and called on every evaluation, of every Match, of
// every turn of whatever loop reaches one — and it is built to hold Statements
// in a place where Statements were never allowed. Where the Match itself stands
// in a Statement position, they are: the chain is simply written.
//
//   const _self = value;
//   if (_self[$type.typeKeySymbol] === "Optional#Value") { return … }
//   return …
//
// NOTE: THREE positions, which are the three places an Expression's answer has
// somewhere a Statement can name: a Return Statement's Expression, a Variable
// Declaration's initialiser (or an assignment's right-hand side), and a
// Statement written for its effects. A Match anywhere ELSE — an Argument, a
// Record member, an interpolation hole — keeps its wrapper, because there is
// nothing there to write Statements into.
//
// NOTE: What a Handler's Return Statement MEANS is the whole of the difference
// between the three. Under the wrapper it was a JavaScript Return and answered
// the wrapper; in Return position it answers the enclosing Function, which is
// what a Return already does, so those Handlers are emitted exactly as written
// and nothing is held at all. Everywhere else the answer is written where it
// goes and the chain is left through a labelled `break` — which is emitted only
// where a Handler answers somewhere other than its last Statement, because a
// Handler that answers last has nothing after it to skip.
//
// NOTE: `_self` is the name every Handler reads the matched value under, and
// binding it is the one thing the wrapper did that a block has to do
// differently. A Parameter is bound from OUTSIDE the Scope it declares, and a
// `const` is not: `const _self = _self` reads the name being declared and is a
// `ReferenceError`, not the enclosing receiver. So `match @ -> …` binds nothing
// at all — the value is already `_self` — and a scrutinee that merely MENTIONS
// `_self` reads it in a Scope of its own first. See `MatchedValueBinding`.
//
// NOTE: This pass also lifts a compiled Union dispatch that HOLDS operands. Such
// a chain stands in an Expression position too, and `compile-union-dispatch`
// binds its names as the Parameters of an arrow it calls at once — for the same
// reason, and with the same answer where the dispatch is what a Statement
// computes: the names become the `const`s of a block and the arrow is gone.
//
// NOTE: And it collapses the ONE place a lowered Boolean was built only to be
// read back. `if a::isLessThan(b)` lowers to
// `(a.value < b.value ? Boolean.trueInstance : Boolean.falseInstance).value`,
// because an `if` reads `.value` off the Essence Boolean its condition answers.
// A condition is a Statement's question, so it belongs to the pass that answers
// Statements' questions: where the condition IS an `essence-boolean`, the test
// it was built from is emitted and the Boolean is never built.

export const lowerMatchesToStatements: OptimiserPass = {
	name: "lower-matches-to-statements",
	run: (program) => {
		// NOTE: Asked for the one thing this pass drops rather than moves: a
		// Handler answering a value nobody reads, in a Match written for its
		// effects. Whether answering it can be observed is the same question
		// `lower-scalar-operations` asks of an `and`'s Argument, and it is asked
		// the same way — of the Program's own Namespaces, because a Namespace a
		// Program declares can answer under a builtin's name and do anything at
		// all.
		let shadowed = declaredNamespaces(program).nested
		let lowering = new Lowering(shadowed)

		return rewriteStatements(program, (node) => lowering.lower(node))
	},
}

// NOTE: Unspellable in Essence, like every other name the Compiler binds for
// itself: the Lexer reads `_` as a Symbol, so no user identifier holds one, and
// the `$` keeps it clear of `_self`. Numbered across the whole Program rather
// than per Match, so that a label a nested Match breaks out of can not be the
// one its own chain declares.
const labelPrefix = "$match_"
const heldScrutineePrefix = "$matched_"

class Lowering {
	private count = 0

	constructor(private readonly shadowed: ReadonlySet<string>) {}

	// NOTE: Every Statement kind by name, so that a kind added to `typedSimple`
	// is a compile error here rather than an Expression this reads for a value —
	// exactly as the walk itself is written.
	lower(
		node: common.typedSimple.ImplementationNode,
	): common.typedSimple.ImplementationNode {
		switch (node.nodeType) {
			case "ConditionalStatement":
				return this.collapseCondition(node)
			case "ReturnStatement":
				return (
					this.statement(node.expression, { kind: "return" }, node) ??
					node
				)
			case "VariableDeclarationStatement":
				return (
					this.statement(
						node.value,
						{ kind: "declaration", name: node.name },
						node,
					) ?? node
				)
			case "VariableAssignmentStatement":
				return (
					this.statement(
						node.value,
						{ kind: "assignment", name: node.name },
						node,
					) ?? node
				)
			// NOTE: A declaration, and nothing this pass reads. A lowered
			// Statement is one this pass already wrote.
			case "NamespaceDefinitionStatement":
			case "ProtocolDeclarationStatement":
			case "TypeAliasStatement":
			case "FunctionStatement":
			case "IntrinsicStatement":
				return node
			default:
				// NOTE: An Expression written for its effects — the Node stands
				// in a Statement position and is its own value, so what it
				// answers goes nowhere.
				return this.statement(node, { kind: "discard" }, node) ?? node
		}
	}

	// NOTE: One Expression standing in one Statement position, and null where
	// there is nothing here this pass knows how to write.
	private statement(
		value: common.typedSimple.ExpressionNode,
		result: common.typedSimple.StatementResult,
		source: common.typedSimple.ImplementationNode,
	): common.typedSimple.IntrinsicStatementNode | null {
		if (value.nodeType === "Match") {
			return this.statementMatch(value, result, source)
		}

		// NOTE: A chain holding nothing has no wrapper to take away — it is the
		// conditional Expression itself, which stands in a Statement position as
		// happily as in any other.
		if (
			value.nodeType === "Intrinsic" &&
			value.kind === "dispatch-chain" &&
			value.temporaries.length > 0
		) {
			return {
				nodeType: "IntrinsicStatement",
				kind: "held-expression",
				temporaries: value.temporaries,
				expression: { ...value, temporaries: [] },
				result,
				position: source.position,
			}
		}

		return null
	}

	private statementMatch(
		node: common.typedSimple.MatchNode,
		result: common.typedSimple.StatementResult,
		source: common.typedSimple.ImplementationNode,
	): common.typedSimple.StatementMatchNode {
		let index = this.count++

		return {
			nodeType: "IntrinsicStatement",
			kind: "statement-match",
			value: node.value,
			binding: bindingOf(node.value, `${heldScrutineePrefix}${index}`),
			handlers:
				result.kind === "discard"
					? node.handlers.map((handler) =>
							this.withoutDiscardedAnswer(handler),
						)
					: node.handlers,
			finalHandlerIsElse: node.finalHandlerIsElse,
			result,
			label: `${labelPrefix}${index}`,
			position: source.position,
		}
	}

	// NOTE: A Handler whose answer nobody reads and whose last Statement answers
	// something that observes nothing has nothing left to do. The Simplifier
	// gives every Handler body a Return — appending `<- {}` where the body has
	// none — so without this every Handler of a Match written for its effects
	// would end in an empty Record built and dropped.
	//
	// NOTE: The LAST Statement only. A Return anywhere else is control flow as
	// well as an answer: it says the rest of the body does not run, and taking
	// it away would run it.
	private withoutDiscardedAnswer(
		handler: common.typedSimple.MatchHandler,
	): common.typedSimple.MatchHandler {
		let last = handler.body.at(-1)

		if (
			last === undefined ||
			last.nodeType !== "ReturnStatement" ||
			!isPureExpression(last.expression, this.shadowed)
		) {
			return handler
		}

		return { ...handler, body: handler.body.slice(0, -1) }
	}

	// NOTE: The condition of an `if`, which the Rewriter reads `.value` off
	// because an Essence Boolean is an object and every object is true. Where
	// the Boolean is one an earlier pass BUILT out of a JavaScript test — an
	// `essence-boolean` and nothing else — the test is what the `if` should ask,
	// and the Boolean between them is built and read back for nothing.
	private collapseCondition(
		node: common.typedSimple.ConditionalStatementNode,
	): common.typedSimple.ConditionalStatementNode {
		if (node.conditionIsRaw) {
			return node
		}

		let condition = node.condition

		if (
			condition.nodeType !== "Intrinsic" ||
			condition.kind !== "essence-boolean"
		) {
			return node
		}

		return { ...node, condition: condition.value, conditionIsRaw: true }
	}
}

// NOTE: How the matched value reaches `_self`. The wrapper bound it as a
// Parameter, which is evaluated OUTSIDE the Scope the name is declared in; a
// `const` is not, and that is the whole of what these three answer.
function bindingOf(
	value: common.typedSimple.ExpressionNode,
	heldName: string,
): common.typedSimple.MatchedValueBinding {
	if (value.nodeType === "Identifier" && value.name === selfName) {
		return { kind: "self" }
	}

	return mentionsSelf(value)
		? { kind: "held", name: heldName }
		: { kind: "block" }
}

// NOTE: The name `@` lowers to — the receiver Parameter of every Method, and
// the value a Match binds for its Handlers. One name for both is what lets a
// Handler write `@` and mean the value that matched.
const selfName = "_self"

// NOTE: Whether this Expression can READ `_self`, asked of the whole subtree and
// answered yes wherever the name occurs at all. It over-answers on purpose: an
// occurrence under a nested Match's own `_self` is not the enclosing one, and
// telling the two apart is a Scope analysis where the cost of not doing it is
// one extra block. Structural, so a position added to `typedSimple` later is
// searched without this having to hear about it.
function mentionsSelf(value: unknown): boolean {
	if (Array.isArray(value)) {
		return value.some((entry) => mentionsSelf(entry))
	}

	if (value === null || typeof value !== "object") {
		return false
	}

	let node = value as Record<string, unknown>

	if (node["nodeType"] === "Identifier" && node["name"] === selfName) {
		return true
	}

	return Object.values(node).some((entry) => mentionsSelf(entry))
}
