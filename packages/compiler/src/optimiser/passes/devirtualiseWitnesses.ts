import type { common } from "@essence-lang/interfaces"

import type { OptimiserPass } from "../index"
import { rewriteExpressions } from "../walk"

// NOTE: A conformance witness is a method map — `{ toString: Integer.toString }`
// — and it exists so that a Function bounded by a Protocol can be handed one
// and read whichever Method it needs off it. At a site that reads exactly ONE
// of them, and reads it right there, the map is a detour: the Compiler already
// knows which Function `toString` is, so it says so.
//
// NOTE: Today that site is the hole of an interpolated String, and it is the
// only one. Every other witness the Rewriter emits is passed as an ARGUMENT,
// where the callee decides which Method to read and the object has to exist —
// `pool-constants` is what makes those cheap, by building each one once. The
// two passes therefore never contend for a Node: this one runs first and takes
// the witnesses that are consumed on the spot, and the pool takes what is left.
// Turning either off leaves the other answering exactly as it did.
//
// NOTE: What it is worth, honestly: not much time. The hole was already reading
// one property off a pooled object, and reading a property is not what a
// Program spends its time on. What it takes away is the object — a Program that
// interpolates and passes no witness anywhere stops building one at all — and a
// property read whose shape an engine has to keep track of. It is measured in
// bytes and in indirection rather than in nanoseconds, and it is a pass because
// it is a transform, not because it is a lever.

export const devirtualiseWitnesses: OptimiserPass = {
	name: "devirtualise-witnesses",
	run: (program) => rewriteExpressions(program, devirtualise),
}

// NOTE: The interpolated String rather than the witness inside it, because the
// witness is only devirtualisable BY VIRTUE OF where it stands — the walk
// offers an Expression without saying which position it came from, and a
// `ConformanceValue` rewritten wherever one was found would replace an object
// that gets passed somewhere with a Function that does not answer for one.
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

		// NOTE: `toString` because that is the Method the Rewriter calls to
		// render a hole — the one Method `Printable` declares, and the one this
		// site was ever going to read.
		let direct = directMethodOf(segment.witness, "toString")

		if (direct === null) {
			return segment
		}

		changed = true

		return { ...segment, witness: direct }
	})

	return changed ? { ...node, segments } : node
}

// NOTE: The Function a witness's Method resolves to — null wherever the witness
// is not a map of names the Compiler wrote.
//
// NOTE: A CONDITIONAL conformance is refused, and the refusal is the whole of
// what makes this safe to take away: such a witness is
// `boundConformance(<map>, [<witnesses>])`, which curries its own witnesses
// onto every Method in the map, so the Function behind `toString` is one the
// call BUILDS rather than one the Program declares. There is no name to put
// here. `pool-constants` builds it once instead.
//
// NOTE: A witness that is a forwarded Parameter is not a `ConformanceValue` at
// all — it is an Identifier, a different value per call — and is refused by the
// same first line.
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

	let memberName = witness.methodMap[protocolMethodName]

	if (memberName === undefined) {
		return null
	}

	// NOTE: The Position of the witness it replaces, which is the Position the
	// witness was given: it stands where it stood, and nothing moves.
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
