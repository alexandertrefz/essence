import type { common } from "@essence-lang/interfaces"

import type { OptimiserPass } from "../index"
import { isPureExpression } from "../purity"
import { rewriteNodes } from "../walk"

// Drops a Constant whose name the Program never reads and whose value is pure.
// It reads once, not to a fixed point. See "eliminate-dead-code" in
// DEVELOPMENT.md.

export const eliminateDeadCode: OptimiserPass = {
	name: "eliminate-dead-code",
	run: (program, namespaces) => {
		let shadowed = namespaces.nested
		let read = namesReadBy(program)

		return rewriteNodes(program, {
			body: (nodes) => withoutUnreadConstants(nodes, read, shadowed),
		})
	},
}

function withoutUnreadConstants(
	nodes: Array<common.typedSimple.ImplementationNode>,
	read: ReadonlySet<string>,
	shadowed: ReadonlySet<string>,
): Array<common.typedSimple.ImplementationNode> {
	let kept = nodes.filter((node) => {
		if (node.nodeType !== "VariableDeclarationStatement") {
			return true
		}

		if (!node.isConstant || read.has(node.name.name)) {
			return true
		}

		return !isPureExpression(node.value, shadowed)
	})

	return kept.length === nodes.length ? nodes : kept
}

// Every Identifier in an Expression position. The walk offers no bindings, and
// a Method's Namespace or a Lookup's member names no binding.
function namesReadBy(program: common.typedSimple.Program): ReadonlySet<string> {
	let read = new Set<string>()

	rewriteNodes(program, {
		// A Parameter's default reads names too.
		parameterDefaults: true,
		expression: (node) => {
			if (node.nodeType === "Identifier") {
				read.add(node.name)
			}

			return node
		},
		// Names a lowered Statement holds, counted though none can be a droppable
		// Constant, since a miss would be a `ReferenceError`.
		statement: (node) => {
			if (node.nodeType === "IntrinsicStatement") {
				readIntrinsicStatementNames(node, read)
			}

			return node
		},
	})

	// Other Modules read every exported name and alias.
	for (let entry of program.exports?.entries ?? []) {
		read.add(entry.name)

		if (entry.alias !== null) {
			read.add(entry.alias)
		}
	}

	return read
}

function readIntrinsicStatementNames(
	node: common.typedSimple.IntrinsicStatementNode,
	read: Set<string>,
): void {
	if (node.kind === "statement-match" && node.binding.kind === "held") {
		read.add(node.binding.name)
	}

	if (node.kind === "held-expression") {
		for (let temporary of node.temporaries) {
			read.add(temporary.name)
		}
	}

	if (
		node.result.kind === "declaration" ||
		node.result.kind === "assignment"
	) {
		read.add(node.result.name.name)
	}
}
