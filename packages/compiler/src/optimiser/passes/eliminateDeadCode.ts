import type { common } from "@essence-lang/interfaces"

import { forEachSimpleChild, type SimpleNode } from "../../visitor/typedSimple"
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

// Every Identifier in an Expression position, Parameter defaults included.
// See "eliminate-dead-code" in DEVELOPMENT.md.
function namesReadBy(program: common.typedSimple.Program): ReadonlySet<string> {
	let read = new Set<string>()

	collectReads(program, read)

	// Other Modules read every exported name and alias.
	for (let entry of program.exports?.entries ?? []) {
		read.add(entry.name)

		if (entry.alias !== null) {
			read.add(entry.alias)
		}
	}

	return read
}

function collectReads(node: SimpleNode, read: Set<string>): void {
	switch (node.nodeType) {
		case "Identifier":
			read.add(node.name)

			return
		case "MethodInvocation":
			forEachSimpleChild(node, pastBase, read)

			return
		case "Lookup":
			forEachSimpleChild(node, pastMember, read)

			return
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement":
		case "NamespaceDefinitionStatement":
		case "ProtocolDeclarationStatement":
		case "TypeAliasStatement":
		case "FunctionStatement":
			forEachSimpleChild(node, pastName, read)

			return
		case "Parameter":
			forEachSimpleChild(node, pastParameterNames, read)

			return
		case "Intrinsic":
			if (node.kind === "inline-loop") {
				forEachSimpleChild(node, pastParameters, read)

				return
			}

			break
		case "IntrinsicStatement":
			readIntrinsicStatementNames(node, read)

			if (node.kind === "inline-loop") {
				forEachSimpleChild(node, pastParameters, read)

				return
			}

			break
	}

	forEachSimpleChild(node, collectReads, read)
}

// Reads every child but those in the fields named, which hold a binding or a
// member name rather than a read.
function readsPast(
	...fields: Array<string>
): (child: SimpleNode, read: Set<string>, field: string) => void {
	return (child, read, field) => {
		if (!fields.includes(field)) {
			collectReads(child, read)
		}
	}
}

// A Method's Namespace.
const pastBase = readsPast("base")

const pastMember = readsPast("member")

// A declared or assigned name.
const pastName = readsPast("name")

const pastParameterNames = readsPast("externalName", "internalName")

// An inlined loop callback's Parameters.
const pastParameters = readsPast("parameters")

// Names a lowered Statement holds as text, counted though none can be a
// droppable Constant, since a miss would be a `ReferenceError`. The name its
// answer goes to is an Identifier, and is read with the rest.
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
}
