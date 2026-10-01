import type { common } from "@essence-lang/interfaces"

import type { OptimiserPass } from "../index"
import { isPureExpression } from "../purity"
import { rewriteStatements } from "../walk"

// Writes a Match that stands in a Statement position as a chain of Statements,
// in place of the Function the rewriter would wrap it in. It lifts a compiled
// dispatch that holds operands the same way. See "lower-matches-to-statements"
// in DEVELOPMENT.md.

export const lowerMatchesToStatements: OptimiserPass = {
	name: "lower-matches-to-statements",
	run: (program, namespaces) => {
		// For the one thing this pass drops: a discarded Handler answer, which
		// a Program's own Namespace could make observable.
		let shadowed = namespaces.nested
		let lowering = new Lowering(shadowed)

		return rewriteStatements(program, (node) => lowering.lower(node))
	},
}

// Unspellable in Essence, since the lexer reads `_` as a Symbol. Numbered
// across the Program, so a nested Match never breaks to its own label.
const labelPrefix = "$match_"
const heldScrutineePrefix = "$matched_"

class Lowering {
	private count = 0

	constructor(private readonly shadowed: ReadonlySet<string>) {}

	// Every Statement kind by name, so a new kind fails to compile here.
	lower(
		node: common.typedSimple.ImplementationNode,
	): common.typedSimple.ImplementationNode {
		switch (node.nodeType) {
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
			// Declarations, and Statements whose Expressions have nowhere to
			// write an answer. `unbox-conditions` reads a Conditional's
			// condition.
			case "ConditionalStatement":
			case "NamespaceDefinitionStatement":
			case "ProtocolDeclarationStatement":
			case "TypeAliasStatement":
			case "FunctionStatement":
			// An assertion's Expression is tested where it stands.
			case "TestAssertionStatement":
			// A loop turn's Expressions answer nothing this pass could write.
			case "TailCallStatement":
			case "IntrinsicStatement":
				return node
			default:
				// An Expression written for its effects, whose answer goes
				// nowhere.
				return this.statement(node, { kind: "discard" }, node) ?? node
		}
	}

	// One Expression in one Statement position, or null where there is nothing
	// to write.
	private statement(
		value: common.typedSimple.ExpressionNode,
		result: common.typedSimple.StatementResult,
		source: common.typedSimple.ImplementationNode,
	): common.typedSimple.IntrinsicStatementNode | null {
		if (value.nodeType === "Match") {
			return this.statementMatch(value, result, source)
		}

		// A chain holding nothing is a plain conditional Expression with no
		// wrapper.
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

	// Drops a discarded Handler's final Return of a pure value, which the
	// simplifier adds to every body. A Return elsewhere is control flow and
	// stays.
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
}

// How the matched value reaches `_self`, since `const _self = _self` would be
// a `ReferenceError`.
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

// The name `@` lowers to, both a Method's receiver and a Match's value.
const selfName = "_self"

// Whether `_self` occurs anywhere in the subtree. It over-answers for a nested
// Match's own `_self`, at the cost of one extra block.
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
