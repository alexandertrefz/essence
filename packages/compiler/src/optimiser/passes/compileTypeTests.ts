import type { common } from "@essence-lang/interfaces"

import type { OptimiserPass } from "../index"
import {
	matcherResidual,
	matcherResidualOverMembers,
	unionMembersOf,
} from "../residual"
import { rewriteExpressions } from "../walk"

// NOTE: A Match asks the runtime which Type a value has, and it asked in the
// most general way there is: `$type.isValueOfType(_self, { type: "Case",
// choice: "Optional", name: "Value", members: { value: { type: "Integer" } } })`
// builds a descriptor tree at every test, hands it to a function that walks its
// ladder of kind tests to find the arm to take, reads the tag — and then walks
// the payload comparing member Types that the Compiler chose the descriptor
// from in the first place. Where the tag is the whole of what decides it, the
// tag is what is emitted:
//
//   _self[$type.typeKeySymbol] === "Optional#Value"
//
// NOTE: The saving is not only the call. A List Matcher's descriptor check
// walks EVERY ITEM of the List — `isValueOfType` is what a `List<Integer>`
// descriptor means — so `case List` over a ten thousand item List was ten
// thousand Type checks to answer a question the tag answers in one. That is the
// difference between O(n) and O(1) per Handler tested, and a Match inside a loop
// pays it per turn.
//
// NOTE: What decides is `residual.ts`, which is where the erasure rules live and
// which `elide-final-match-test` and (later) `compile-union-dispatch` ask as
// well. This pass is the emission half: it takes a residual of `tag` and writes
// the test, and leaves every other answer exactly as the Simplifier stated it.
//
// NOTE: A Handler with a LITERAL Matcher (`case 0`, `case "beta"`) has no Type
// check to replace — `anyIs(_self, 0)` is the whole test, and it answers false
// across differing Types on its own. What it has instead is a call into the
// universal structural equality to decide something two scalars decide with an
// operator, so where the matched value's Type and the literal are EXACTLY one
// scalar kind, the raw comparison is what is written:
//
//   _self.value === $pool_0.value
//
// That is the same lowering `lower-scalar-operations` performs for `a::is(b)`,
// and it rests on the same argument: `Integer` means an Integer and nothing else
// — not a Union it is a member of, not a Type Parameter that could be one — so
// the value at run time is the branded object the runtime's constructor built,
// holding under `value` the ONE representation the canonical invariant gives it,
// which is what lets the comparison be `===` at all. A Union-typed scrutinee is
// left alone, because a value arriving there may be of any member and `.value`
// is not what decides it. Strings go through `$helpers.stringEquals` rather than `===`, exactly as
// that pass emits them: two Strings are equal when their CHARACTERS are, which
// is a comparison of canonically normalised forms.
//
// NOTE: Member literals and Guards are untouched, for the opposite reason: they
// are ANDed onto whichever test the Matcher produced, so replacing the Matcher's
// half leaves them saying what they said.
//
// NOTE: `memberTypes` — what a Case Matcher's payload Pattern requires — IS
// compiled, because it is a Type check like the Matcher's own and was the one
// left asking the runtime the general question. Each requirement is decided by
// the same `residual.ts` rules against the Type the value declares AT that
// spine, so `case #Fired({ payload: Click })` becomes a tag comparison on
// `_self.payload` where the tag decides it, and otherwise a descriptor `pool-
// constants` can hoist out of the test. Nothing about WHICH values the Handler
// accepts changes; only how it is asked.

export const compileTypeTests: OptimiserPass = {
	name: "compile-type-tests",
	run: (program) => rewriteExpressions(program, compile),
}

function compile(
	node: common.typedSimple.ExpressionNode,
): common.typedSimple.ExpressionNode {
	if (node.nodeType !== "Match") {
		return node
	}

	let handlers = node.handlers.map((handler) => {
		let memberTests = compileMemberTests(handler)

		if (handler.typeTest !== null) {
			return memberTests === handler.memberTests
				? handler
				: { ...handler, memberTests }
		}

		// NOTE: A literal Matcher's test IS the comparison, so the compiled
		// form of it goes where a Type check's compiled form goes — the
		// Rewriter reads `typeTest` first and falls back to `anyIs` over the
		// literal where there is none. The `literal` itself stays: it is what
		// `elide-final-match-test` reads to know that a final Handler with one
		// can still decline a value, and what a build with this pass turned off
		// is emitted from.
		if (handler.literal !== null) {
			let compiled = literalTest(node.value.type, handler.literal)

			if (compiled === null) {
				return memberTests === handler.memberTests
					? handler
					: { ...handler, memberTests }
			}

			return { ...handler, typeTest: compiled, memberTests }
		}

		let residual = matcherResidual(handler.matcher, node.value.type)

		return {
			...handler,
			typeTest:
				residual.kind === "tag"
					? tagTest(node.value.type, residual.tag)
					: typeTest(node.value.type, handler.matcher),
			memberTests,
		}
	})

	if (handlers.every((handler, index) => handler === node.handlers[index])) {
		return node
	}

	return { ...node, handlers }
}

// NOTE: The scalar kinds a literal Matcher can be compiled for, and null for
// everything else. BOTH Types must be exactly the kind: the matched value's,
// because a Union-typed scrutinee may hold a value of any member and reading
// `.value` off it decides nothing, and the literal's, because the two have to be
// the same question. `Boolean` is absent because a Match over one is refused
// before this ever sees it — a Type with a single shape has a single outcome —
// and a Case, a Record or a List literal is left to `anyIs`, which is a walk
// rather than a comparison.
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

// NOTE: One compiled check per requirement, under the spine that reaches it.
// The value each is asked OF is the member read, not `_self` — the Rewriter
// builds the same read from `memberTypes`, and building it here instead is what
// puts the descriptor somewhere `pool-constants` can see.
//
// The Type the residual is measured against is what the value DECLARES at that
// spine, which is the set of values that can arrive there — the same argument
// `matcherResidual` takes for the Matcher's own check, one level down.
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

		tests[path] =
			residual.kind === "tag"
				? tagTestOf(read, residual.tag)
				: typeTestOf(read, required)
	}

	return tests
}

// NOTE: The read the requirement is asked of — `_self.payload.origin` — built
// from the spine the Enricher keyed it by. A member name can hold no dot, so
// splitting on one can not mistake anything else for a spine.
function memberRead(
	valueType: common.Type,
	steps: Array<string>,
): common.typedSimple.ExpressionNode {
	let node = matchedValue(valueType)
	let type = valueType

	for (let step of steps) {
		type = memberTypeAt(type, step)
		node = {
			nodeType: "Lookup",
			base: node,
			member: { nodeType: "Identifier", name: step, type },
			type,
		}
	}

	return node
}

function declaredTypeAtPath(
	valueType: common.Type,
	steps: Array<string>,
): common.Type {
	return steps.reduce(memberTypeAt, valueType)
}

// NOTE: Silent, and `Unknown` where nothing carries the member — the Enricher
// has already reported anything worth reporting about a Pattern's members, and
// an Optimiser pass says nothing about a Program either way.
function memberTypeAt(type: common.Type, name: string): common.Type {
	let found = unionMembersOf(type).flatMap((member: common.Type) =>
		member.type === "Record" || member.type === "Case"
			? (member.members[name] ?? [])
			: [],
	)

	return found.length === 1 ? found[0]! : { type: "Unknown" }
}

// NOTE: `_self` is the name the Rewriter binds the matched value to, and the
// name `@` lowers to inside a Handler's body — one value under one name, so a
// test written here reads what the body reads.
//
// NOTE: No Position, deliberately. A Handler's Type check is not a thing anyone
// wrote: the source says `case #Value(count)`, and the span of that is the
// Handler, whose body carries its own Positions. Mapping the test to the whole
// Match — the only Position in reach — would put every Handler's `if` on the
// Match's first line for a debugger, where today they map to nothing and are
// stepped over.
function tagTest(
	valueType: common.Type,
	tag: string,
): common.typedSimple.ExpressionNode {
	return tagTestOf(matchedValue(valueType), tag)
}

// NOTE: The same check asked of an arbitrary read rather than of `_self` — what
// a payload requirement needs, since it is about a member of the matched value
// and not the value itself.
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
		type: { type: "Boolean" },
	}
}

// NOTE: The check the runtime performs, written out where the Matcher stood.
// The BYTES are what they were — this is the same call over the same
// descriptor, which is what the Rewriter emits for a Handler this pass left
// alone — and what changes is where the descriptor sits: in an Expression
// position, which is a place another pass can reach. `pool-constants` is what
// reaches it, and hoists a descriptor rebuilt at every test into a constant
// built once.
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
