import type { common } from "@essence-lang/interfaces"

import type { OptimiserPass } from "../index"
import { declaredNamespaces } from "../namespaces"
import { isPureExpression } from "../purity"
import { rewriteNodes } from "../walk"

// NOTE: A Constant nothing reads is a value the Program builds and drops. It is
// rarely written that way on purpose — what leaves them behind is the passes
// ahead of this one, which fold an operation into its answer and inline a walk
// where it stood — and a name nobody reads costs an allocation at the Statement
// it stands on, plus, at a Program's top level, a `const` that is never
// collected.
//
// NOTE: What may go is decided by one question asked twice: is this name READ
// anywhere in the Program, and is what it is bound to something the Program can
// tell the absence of. The first is answered by the whole Program rather than by
// the Scope the Constant stands in — a name read in a Function three blocks away
// is the same string, and refusing on the string is refusing on more than
// necessary, which is the direction to be wrong in. The second is
// `isPureExpression`, which is the same question `lower-scalar-operations` asks
// of an Argument it would skip: a Declaration whose value PRINTS is a Statement
// with an effect, and dropping it drops the effect.
//
// NOTE: Constants alone. A `variable` can be assigned after it is declared, and
// an assignment is a Statement this does not read — so a Program that declares
// one and writes to it keeps both.
//
// NOTE: One reading, not a fixed point. A Constant read only by another
// Constant that is itself dropped stays, because the reference was counted
// before either went. Running this to exhaustion would take a pass that is
// allowed to loop, and what it would buy is the second link of a chain nobody
// wrote on purpose.

export const eliminateDeadCode: OptimiserPass = {
	name: "eliminate-dead-code",
	run: (program) => {
		let shadowed = declaredNamespaces(program).nested
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

// NOTE: Every name the Program READS, which is every Identifier standing in an
// Expression position — and only those. The walk is what makes that exact: a
// Declaration's own name, a Parameter's, a Method's and a Namespace's are
// bindings rather than values and are not offered to it, while the Namespace a
// Method Invocation answers on, the runtime Function a native Invocation names
// and the member a Lookup reads are Identifiers that name no binding at all.
// Counting those would count a Program's `Integer` Methods as reads of a
// Constant somebody called `Integer`.
function namesReadBy(program: common.typedSimple.Program): ReadonlySet<string> {
	let read = new Set<string>()

	rewriteNodes(program, {
		expression: (node) => {
			if (node.nodeType === "Identifier") {
				read.add(node.name)
			}

			return node
		},
		// NOTE: The lowered Statements hold a name where an Expression would
		// have held an Identifier: the temporary a compiled dispatch binds its
		// operands to, the name a lowered Match writes its answer into, the one
		// a lowered walk does. None of them can be a Constant this pass would
		// drop — a lowered Declaration IS the Declaration, and nothing here
		// declares a Constant twice — but they are read here all the same,
		// because the cost of counting a name that was never in question is
		// nothing and the cost of missing one is a `ReferenceError`.
		statement: (node) => {
			if (node.nodeType === "IntrinsicStatement") {
				readIntrinsicStatementNames(node, read)
			}

			return node
		},
	})

	// NOTE: What a Module PUBLISHES is read by Modules this compilation may
	// never see, so every exported name is a root. The alias as well as the
	// name: an entry may publish a binding under another spelling, and which of
	// the two is the local one is a distinction not worth making where being
	// wrong costs an export that resolves to nothing.
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
