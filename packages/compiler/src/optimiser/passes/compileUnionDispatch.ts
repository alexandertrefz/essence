import type { common } from "@essence-lang/interfaces"

import type { OptimiserPass } from "../index"
import { isPureExpression } from "../purity"
import { type MatcherResidual, matcherResidualOverMembers } from "../residual"
import { rewriteExpressions } from "../walk"

// Writes a Union dispatch as a chain of tag tests and calls, in place of the
// runtime's `dispatchMethod` search. The cases keep their order, and the last
// becomes the `else` where its check is a tag comparison. See
// "compile-union-dispatch" in DEVELOPMENT.md.

export const compileUnionDispatch: OptimiserPass = {
	name: "compile-union-dispatch",
	run: (program, namespaces) => {
		// `isPureExpression` reads Namespace names, so it needs the nested set.
		let shadowed = namespaces.nested

		return rewriteExpressions(program, (node) => compile(node, shadowed))
	},
}

// Unspellable in Essence, since the lexer reads `_` as a Symbol. A nested
// chain may reuse a number, which is harmless, since a chain reads only its own
// names.
const temporaryPrefix = "$dispatch_"

function compile(
	node: common.typedSimple.ExpressionNode,
	shadowed: ReadonlySet<string>,
): common.typedSimple.ExpressionNode {
	if (node.nodeType !== "UnionMethodInvocation") {
		return node
	}

	// The enricher never emits a dispatch without cases.
	if (node.cases.length === 0) {
		return node
	}

	if (
		!node.cases.every((dispatchCase) =>
			caseArgumentsArePure(dispatchCase, shadowed),
		)
	) {
		return node
	}

	let branches = collapsedIfUniform(planBranches(node.cases))
	// The receiver and shared Arguments, in the order they must stay in.
	let operands = [
		node.base,
		...node.arguments.map((argument) => argument.value),
	]
	let isHeld = holdPlan(branches, operands, shadowed)
	let temporaries: Array<common.typedSimple.DispatchTemporaryNode> = []

	let reads = operands.map((operand, index) => {
		if (!isHeld[index]) {
			return () => ({ ...operand })
		}

		let name = `${temporaryPrefix}${temporaries.length}`

		temporaries.push({ name, value: operand })

		// No Position. The held Expression keeps its own, where a debugger
		// stops.
		return (): common.typedSimple.ExpressionNode => ({
			nodeType: "Identifier",
			name,
			type: operand.type,
		})
	})

	let readReceiver = reads[0]!
	let readArguments = reads.slice(1)

	return {
		nodeType: "Intrinsic",
		kind: "dispatch-chain",
		temporaries,
		receiver: readReceiver(),
		arguments: readArguments.map((read) => read()),
		cases: branches.map((branch) => ({
			test:
				branch.residual === null
					? null
					: testOf(
							branch.residual,
							readReceiver(),
							branch.dispatchCase.memberType,
						),
			namespaceName: branch.dispatchCase.namespaceName,
			methodName: branch.dispatchCase.methodName,
			conformanceArguments: branch.dispatchCase.conformanceArguments.map(
				(argument) => argument.value,
			),
			contextualArguments: branch.dispatchCase.contextualArguments.map(
				(contextual) => ({
					index: contextual.index,
					value: contextual.argument.value,
				}),
			),
			omittedParameterIndices:
				branch.dispatchCase.omittedParameterIndices,
			derivedDescriptor: branch.dispatchCase.derivedDescriptor,
			...(branch.dispatchCase.derivedMembers === undefined
				? {}
				: { derivedMembers: branch.dispatchCase.derivedMembers }),
			providedBy: branch.dispatchCase.providedBy,
		})),
		type: node.type,
		position: node.position,
	}
}

type PlannedBranch = {
	dispatchCase: common.typedSimple.UnionMethodDispatchCase
	// What this branch's check reduces to, or null where the chain ends.
	residual: MatcherResidual | null
}

// The branches in case order, each check measured against the cases, one per
// member of the Union. Two cases sharing a tag keep their full checks.
function planBranches(
	cases: ReadonlyArray<common.typedSimple.UnionMethodDispatchCase>,
): Array<PlannedBranch> {
	let memberTypes = cases.map((dispatchCase) => dispatchCase.memberType)
	let branches: Array<PlannedBranch> = []

	for (let [index, dispatchCase] of cases.entries()) {
		let residual = matcherResidualOverMembers(
			dispatchCase.memberType,
			memberTypes,
		)
		// An `always` branch makes the cases after it unreachable, so they go.
		// The last branch is untested only where its check is a tag comparison.
		let isDecided =
			residual.kind === "always" ||
			(index === cases.length - 1 && residual.kind === "tag")

		branches.push({ dispatchCase, residual: isDecided ? null : residual })

		if (isDecided) {
			break
		}
	}

	return branches
}

// A chain whose branches all make the same call, written as that call. The
// tests only pick which Method sees the receiver, so here they decide nothing.
// See "compile-union-dispatch" in DEVELOPMENT.md.
function collapsedIfUniform(
	branches: Array<PlannedBranch>,
): Array<PlannedBranch> {
	let first = branches[0]

	if (first === undefined || branches.length === 1) {
		return branches
	}

	let isUniform = branches.every(
		(branch) =>
			branch.dispatchCase.namespaceName ===
				first.dispatchCase.namespaceName &&
			branch.dispatchCase.methodName === first.dispatchCase.methodName &&
			// A provided Method and a written one can share both names.
			branch.dispatchCase.providedBy === first.dispatchCase.providedBy &&
			branch.dispatchCase.derivedDescriptor === undefined &&
			branch.dispatchCase.derivedMembers === undefined &&
			branch.dispatchCase.conformanceArguments.length === 0 &&
			branch.dispatchCase.contextualArguments.length === 0 &&
			// Different omitted Parameters make different calls.
			branch.dispatchCase.omittedParameterIndices.join() ===
				first.dispatchCase.omittedParameterIndices.join(),
	)

	if (!isUniform) {
		return branches
	}

	// One untested branch, which `holdPlan` emits as the plain call.
	return [{ dispatchCase: first.dispatchCase, residual: null }]
}

// Which operands the chain holds, evaluated once and in order before any test,
// and which it writes where the branches use them. See "Held operands" in
// DEVELOPMENT.md.
function holdPlan(
	branches: ReadonlyArray<PlannedBranch>,
	operands: ReadonlyArray<common.typedSimple.ExpressionNode>,
	shadowed: ReadonlySet<string>,
): Array<boolean> {
	// Every branch reads the receiver. No branch reads an Argument every branch
	// overrides.
	let isRead = operands.map(
		(_, index) =>
			index === 0 || !isOverriddenEverywhere(branches, index - 1),
	)
	// With one untested branch every read operand is written out, but an unread
	// one has no place to be written.
	let writesOperandsOut =
		branches.length === 1 && branches[0]!.residual === null
	let isHeld = operands.map((operand, index) => {
		if (!isRead[index]) {
			return !isPureExpression(operand, shadowed)
		}

		return !writesOperandsOut && !isReReadable(operand)
	})

	// Back to front, since a held operand after a name makes it unsafe to
	// leave.
	let heldAfter = false

	for (let index = operands.length - 1; index >= 0; index--) {
		if (isHeld[index]) {
			heldAfter = true
		} else if (
			heldAfter &&
			isRead[index] &&
			operands[index]!.nodeType === "Identifier"
		) {
			isHeld[index] = true
		}
	}

	return isHeld
}

// A name or a literal, which can be evaluated where a branch uses it.
function isReReadable(node: common.typedSimple.ExpressionNode): boolean {
	switch (node.nodeType) {
		case "Identifier":
		case "IntegerValue":
		case "StringValue":
		case "RationalValue":
		case "BooleanValue":
			return true
		default:
			return false
	}
}

// Whether every branch passes its own Argument in this place.
function isOverriddenEverywhere(
	branches: ReadonlyArray<PlannedBranch>,
	index: number,
): boolean {
	return branches.every((branch) =>
		branch.dispatchCase.contextualArguments.some(
			(contextual) => contextual.index === index,
		),
	)
}

// The branch's check, as `compile-type-tests` writes a Handler's. The
// descriptor stands where `pool-constants` can hoist it.
function testOf(
	residual: MatcherResidual,
	value: common.typedSimple.ExpressionNode,
	memberType: common.Type,
): common.typedSimple.ExpressionNode {
	if (residual.kind === "tag") {
		return {
			nodeType: "Intrinsic",
			kind: "tag-test",
			value,
			tag: residual.tag,
			negated: false,
			optional: false,
			type: { type: "Boolean" },
		}
	}

	return {
		nodeType: "Intrinsic",
		kind: "type-test",
		value,
		descriptor: {
			nodeType: "Intrinsic",
			kind: "type-descriptor",
			descriptor: memberType,
			type: { type: "Unknown" },
		},
		type: { type: "Boolean" },
	}
}

// Whether this case's own Arguments may be built in its branch rather than at
// the call, which is observable only if they are impure.
function caseArgumentsArePure(
	dispatchCase: common.typedSimple.UnionMethodDispatchCase,
	shadowed: ReadonlySet<string>,
): boolean {
	return (
		dispatchCase.conformanceArguments.every((argument) =>
			isPureExpression(argument.value, shadowed),
		) &&
		dispatchCase.contextualArguments.every((contextual) =>
			isPureExpression(contextual.argument.value, shadowed),
		)
	)
}
