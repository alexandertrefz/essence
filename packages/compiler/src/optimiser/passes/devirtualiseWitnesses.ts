import type { common } from "@essence-lang/interfaces"

import type { OptimiserPass } from "../index"
import { rewriteExpressions } from "../walk"

// Where a witness's method map is read on the spot, names the Function instead,
// such as `Integer.toString` for `{ toString: Integer.toString }`. The only such
// site is an interpolated String's hole. Every other witness is an Argument,
// which `pool-constants` builds once. The two passes never contend for a Node.

export const devirtualiseWitnesses: OptimiserPass = {
	name: "devirtualise-witnesses",
	run: (program) => rewriteExpressions(program, devirtualise),
}

// The interpolated String rather than its witnesses, since only a hole's position
// makes a witness safe to replace with a Function.
function devirtualise(
	node: common.typedSimple.ExpressionNode,
): common.typedSimple.ExpressionNode {
	if (node.nodeType !== "InterpolatedStringValue") {
		return node
	}

	let changed = false
	let segments = node.segments.map((segment) => {
		if (segment.kind !== "expression") {
			return segment
		}

		// The rewriter renders a hole with `toString`, the Method `Printable` declares.
		let direct = directMethodOf(segment.witness, "toString")

		if (direct === null) {
			return segment
		}

		changed = true

		return { ...segment, witness: direct }
	})

	return changed ? { ...node, segments } : node
}

// The Function a witness's Method resolves to, or null. A conditional witness
// curries Functions the call builds, so it has no name to give. A forwarded
// Parameter is an Identifier, and a derived `Enumerable` witness maps no
// `toString`.
function directMethodOf(
	witness: common.typedSimple.ExpressionNode,
	protocolMethodName: string,
): common.typedSimple.DirectMethodNode | null {
	if (witness.nodeType !== "ConformanceValue") {
		return null
	}

	if (witness.conditions.length !== 0) {
		return null
	}

	// Not a plain index, which would find `toString` on `Object.prototype`.
	let memberName = Object.hasOwn(witness.methodMap, protocolMethodName)
		? witness.methodMap[protocolMethodName]
		: undefined

	if (memberName === undefined) {
		return null
	}

	// The witness's own Position, since nothing moves.
	return {
		nodeType: "Intrinsic",
		kind: "direct-method",
		namespaceName: witness.namespaceName,
		memberName,
		derivedDescriptor: witness.derivedDescriptor,
		type: witness.type,
		position: witness.position,
	}
}
