import type { common } from "@essence-lang/interfaces"

import type { OptimiserPass } from "../index"
import { memberReadOf, memberTypeAt } from "../reads"
import {
	matcherResidual,
	matcherResidualOverMembers,
	unionMembersOf,
} from "../residual"
import { rewriteNodes } from "../walk"

// Compiles a Handler's Type check: to a tag comparison where `matcherResidual`
// answers `tag`, else to a `type-test` whose descriptor `pool-constants` can
// hoist. It also compiles scalar literal Matchers and payload requirements. See
// "compile-type-tests" in DEVELOPMENT.md.

// An assertion such as `require #Value(first) = x` is compiled as a Handler.
export const compileTypeTests: OptimiserPass = {
	name: "compile-type-tests",
	run: (program) =>
		rewriteNodes(program, {
			expression: compile,
			statement: compileAssertion,
		}),
}

function compile(
	node: common.typedSimple.ExpressionNode,
): common.typedSimple.ExpressionNode {
	if (node.nodeType !== "Match") {
		return node
	}

	let handlers = node.handlers.map((handler) =>
		compileHandler(handler, node.value.type),
	)

	if (handlers.every((handler, index) => handler === node.handlers[index])) {
		return node
	}

	return { ...node, handlers }
}

function compileAssertion(
	node: common.typedSimple.ImplementationNode,
): common.typedSimple.ImplementationNode {
	if (node.nodeType !== "TestAssertionStatement" || node.matcher === null) {
		return node
	}

	let matcher = compileHandler(node.matcher, node.value.type)

	return matcher === node.matcher ? node : { ...node, matcher }
}

function compileHandler(
	handler: common.typedSimple.MatchHandler,
	valueType: common.Type,
): common.typedSimple.MatchHandler {
	let memberTests = compileMemberTests(handler)

	if (handler.typeTest !== null) {
		return memberTests === handler.memberTests
			? handler
			: { ...handler, memberTests }
	}

	// A literal Matcher's compiled comparison goes where a Type check's would.
	// The `literal` stays, for `elide-final-match-test` and for builds without
	// this pass.
	if (handler.literal !== null) {
		let compiled = literalTest(valueType, handler.literal)

		if (compiled === null) {
			return memberTests === handler.memberTests
				? handler
				: { ...handler, memberTests }
		}

		return { ...handler, typeTest: compiled, memberTests }
	}

	let residual = matcherResidual(handler.matcher, valueType)

	return {
		...handler,
		typeTest:
			residual.kind === "tag"
				? tagTest(valueType, residual.tag)
				: typeTest(valueType, handler.matcher),
		memberTests,
	}
}

// Both the scrutinee and the literal must be exactly `Integer` or `String`.
// A Union-typed scrutinee is not decided by `.value`.
function literalTest(
	valueType: common.Type,
	literal: common.typedSimple.ExpressionNode,
): common.typedSimple.ExpressionNode | null {
	if (valueType.type !== "Integer" && valueType.type !== "String") {
		return null
	}

	if (literal.type.type !== valueType.type) {
		return null
	}

	return {
		nodeType: "Intrinsic",
		kind: "raw-equals",
		scalar: valueType.type,
		left: matchedValue(valueType),
		right: literal,
		negated: false,
		type: { type: "Boolean" },
	}
}

// One compiled check per requirement, asked of the member read and measured
// against the Type the value declares at that path.
function compileMemberTests(
	handler: common.typedSimple.MatchHandler,
): Record<string, common.typedSimple.ExpressionNode> | null {
	if (handler.memberTypes === null || handler.memberTests !== null) {
		return handler.memberTests
	}

	let tests: Record<string, common.typedSimple.ExpressionNode> = {}

	for (let [path, required] of Object.entries(handler.memberTypes)) {
		let steps = path.split(".")
		let declared = declaredTypeAtPath(handler.matcher, steps)
		let read = memberRead(handler.matcher, steps)
		let residual = matcherResidualOverMembers(
			required,
			unionMembersOf(declared),
		)

		// A member the Case does not declare may be absent, which only the
		// runtime's check reads safely.
		tests[path] =
			residual.kind === "tag" && declared.type !== "Unknown"
				? tagTestOf(read, residual.tag)
				: typeTestOf(read, required)
	}

	return tests
}

// A read such as `_self.payload.origin`. A member name holds no dot.
function memberRead(
	valueType: common.Type,
	steps: Array<string>,
): common.typedSimple.ExpressionNode {
	return memberReadOf(matchedValue(valueType), steps)
}

function declaredTypeAtPath(
	valueType: common.Type,
	steps: Array<string>,
): common.Type {
	return steps.reduce(memberTypeAt, valueType)
}

// `_self` is the matched value's name in the Handler body too. The test has no
// Position, since nobody wrote it.
function tagTest(
	valueType: common.Type,
	tag: string,
): common.typedSimple.ExpressionNode {
	return tagTestOf(matchedValue(valueType), tag)
}

// The same check, asked of a member read.
function tagTestOf(
	value: common.typedSimple.ExpressionNode,
	tag: string,
): common.typedSimple.ExpressionNode {
	return {
		nodeType: "Intrinsic",
		kind: "tag-test",
		value,
		tag,
		negated: false,
		optional: false,
		type: { type: "Boolean" },
	}
}

// The runtime's own check, now in an Expression position where
// `pool-constants` can hoist its descriptor.
function typeTest(
	valueType: common.Type,
	matcher: common.Type,
): common.typedSimple.ExpressionNode {
	return typeTestOf(matchedValue(valueType), matcher)
}

function typeTestOf(
	value: common.typedSimple.ExpressionNode,
	matcher: common.Type,
): common.typedSimple.ExpressionNode {
	return {
		nodeType: "Intrinsic",
		kind: "type-test",
		value,
		descriptor: {
			nodeType: "Intrinsic",
			kind: "type-descriptor",
			descriptor: matcher,
			type: { type: "Unknown" },
		},
		type: { type: "Boolean" },
	}
}

function matchedValue(
	valueType: common.Type,
): common.typedSimple.ExpressionNode {
	return { nodeType: "Identifier", name: "_self", type: valueType }
}
