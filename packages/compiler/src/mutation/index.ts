import type { common } from "@essence-lang/interfaces"

import { builtinNamespaces, builtinProtocols } from "../enricher/builtins"
import { declaredCases } from "../helpers/describe"
import { overloadIndexOf, resolveOverloadedMethodName } from "../helpers/types"
import { withoutOverloadSuffix } from "../optimiser/purity"
import { rewriteNodes } from "../optimiser/walk"

// A mutant is one deliberate lie about a simplified Program, and a run asks
// whether any test notices it. Every mutant type-checks by construction, since
// nothing enriches it again. See "Type-shaped mutants" in DEVELOPMENT.md.

export type MutationSite = {
	// The site's place in the walk, which names it. See "Sites" in
	// DEVELOPMENT.md.
	id: number
	// The site's file, which the enumerating caller stamps, since a simplified
	// Program does not know its path.
	module: string | null
	position: common.Position
	operator: MutationOperator
	// What a report reads out, such as "swap ::isGreaterThan for
	// ::isGreaterThanOrEqualTo". Spelled once, so every report agrees.
	description: string
}

export type MutationOperator =
	| "comparison"
	| "equality"
	| "arithmetic"
	| "boolean"
	| "branch"
	| "integer"
	| "case"

// At most this many sites on one line, since each mutant costs a compile and
// a test run. The last in walk order are dropped.
const SITES_PER_LINE = 4

// Single steps only, a bound moved or an order reversed, for every member.
// Maps, since an object would answer `toString` out of `Object.prototype`. See
// "Operators" in DEVELOPMENT.md.
const COMPARISON_SWAPS = new Map<string, Array<string>>([
	["isLessThan", ["isLessThanOrEqualTo", "isGreaterThan"]],
	["isLessThanOrEqualTo", ["isLessThan", "isGreaterThanOrEqualTo"]],
	["isGreaterThan", ["isGreaterThanOrEqualTo", "isLessThan"]],
	["isGreaterThanOrEqualTo", ["isGreaterThan", "isLessThanOrEqualTo"]],
])

// A test that asserts a value, rather than only reaching it, kills this one.
const EQUALITY_SWAPS = new Map<string, Array<string>>([
	["is", ["isNot"]],
	["isNot", ["is"]],
])

// No `add` becomes `multiply`, which agrees with the original wherever both
// operands are 2.
const ARITHMETIC_SWAPS = new Map<string, Array<string>>([
	["add", ["subtract"]],
	["subtract", ["add"]],
	["multiply", ["add"]],
])

// #region Enumerating and applying

// Every mutation this Program admits, in walk order, the same on every call.
export function enumerateMutations(
	program: common.typedSimple.Program,
	module: string | null = null,
): Array<MutationSite> {
	let found: Array<MutationSite> = []

	walkMutations(program, (site) => {
		found.push({ ...site, module })

		return false
	})

	return withinLineCap(found)
}

// A fresh Program with one site rewritten, leaving the one handed in alone.
// Throws on an unknown id, which would otherwise report a mutant that was never
// there.
export function applyMutation(
	program: common.typedSimple.Program,
	site: number,
): common.typedSimple.Program {
	let applied = false
	let mutated = walkMutations(program, (candidate) => {
		if (candidate.id !== site) {
			return false
		}

		applied = true

		return true
	})

	if (!applied) {
		throw new Error(`No mutation site ${site} in this Module`)
	}

	return mutated
}

// Applied after the walk, so the cap never renumbers a site.
function withinLineCap(sites: Array<MutationSite>): Array<MutationSite> {
	let perLine = new Map<number, number>()

	return sites.filter((site) => {
		let line = site.position.start.line
		let taken = perLine.get(line) ?? 0

		perLine.set(line, taken + 1)

		return taken < SITES_PER_LINE
	})
}

// #endregion

// #region The walk

// What the walk offers. The id is a running count over the whole walk.
type Candidate = {
	id: number
	position: common.Position
	operator: MutationOperator
	description: string
}

// One lie about one Node, whose replacement is built only when taken.
export type MutationCandidate<Node> = {
	operator: MutationOperator
	description: string
	rewrite: () => Node
}

// The one walk enumeration and application share. `take` answers whether to
// apply a candidate: enumeration always declines, application accepts once.
function walkMutations(
	program: common.typedSimple.Program,
	take: (candidate: Candidate) => boolean,
): common.typedSimple.Program {
	let context = contextOf(program)
	let next = 0
	// Each candidate of a Node gets its own id, so three nudges of one literal
	// are three sites.
	let offer = <Node>(
		node: Node,
		position: common.Position,
		candidates: Array<MutationCandidate<Node>>,
	): Node => {
		let result = node

		for (let candidate of candidates) {
			let id = next

			next += 1

			if (
				take({
					id,
					position,
					operator: candidate.operator,
					description: candidate.description,
				})
			) {
				result = candidate.rewrite()
			}
		}

		return result
	}

	// The tests section is skipped, so no id is spent inside it.
	let mutated = rewriteNodes(
		{ ...program, tests: null },
		{
			expression: (node) => mutateExpression(node, context, offer),
			statement: (node) => mutateStatement(node, context, offer),
			parameterDefaults: true,
		},
	)

	return mutated.implementation === program.implementation
		? program
		: { ...program, implementation: mutated.implementation }
}

type Offer = <Node>(
	node: Node,
	position: common.Position,
	candidates: Array<MutationCandidate<Node>>,
) => Node

type ExpressionCandidate = MutationCandidate<common.typedSimple.ExpressionNode>

function mutateStatement(
	node: common.typedSimple.ImplementationNode,
	context: MutationContext,
	offer: Offer,
): common.typedSimple.ImplementationNode {
	if (node.nodeType !== "ConditionalStatement") {
		return node
	}

	let position = node.position

	// A synthesized Conditional has no Position, and a report could not point
	// at it.
	if (position === undefined) {
		return node
	}

	// A narrowing condition keeps its bodies, which were typed against what it
	// proves. See "Type-shaped mutants" in DEVELOPMENT.md.
	if (context.narrowed.has(node.condition)) {
		return node
	}

	// Two empty bodies are a Conditional with nothing to swap.
	if (node.trueBody.length === 0 && node.falseBody.length === 0) {
		return node
	}

	return offer(node, position, [
		{
			operator: "branch",
			// Swapping the bodies inverts the condition without inventing a
			// Node.
			description: "swap the branches of this if",
			rewrite: () => ({
				...node,
				trueBody: node.falseBody,
				falseBody: node.trueBody,
			}),
		},
	])
}

function mutateExpression(
	node: common.typedSimple.ExpressionNode,
	context: MutationContext,
	offer: Offer,
): common.typedSimple.ExpressionNode {
	let position = node.position

	// Only what the source wrote. What the simplifier builds has no Position.
	if (position === undefined) {
		return node
	}

	switch (node.nodeType) {
		case "MethodInvocation":
			return offer(node, position, memberSwaps(node, context))
		case "BooleanValue":
			return offer(node, position, [
				{
					operator: "boolean",
					description: `swap ${node.value} for ${!node.value}`,
					rewrite: () => ({ ...node, value: !node.value }),
				},
			])
		case "IntegerValue":
			return offer(node, position, integerNudges(node))
		case "CaseValue":
			return offer(node, position, caseSwaps(node, context))
		case "Define":
			return mutateDefine(node, offer)
		default:
			return node
	}
}

// Swaps one arm's answer with the `otherwise` answer, which is the `define`
// form of the branch swap. Each candidate stands at the `define`'s Position.
// See "Operators" in DEVELOPMENT.md.
function mutateDefine(
	node: common.typedSimple.DefineNode,
	offer: Offer,
): common.typedSimple.ExpressionNode {
	let position = node.position

	// A `define` the simplifier built has no Position.
	if (position === undefined) {
		return node
	}

	if (node.arms.some((arm) => arm.narrows || arm.narrowsBelow)) {
		return node
	}

	return offer(
		node,
		position,
		node.arms.map((_, index) => ({
			operator: "branch" as const,
			description: `swap arm ${index + 1}'s answer for the 'otherwise' one`,
			rewrite: (): common.typedSimple.ExpressionNode =>
				swappedAnswer(node, index),
		})),
	)
}

// Built from the Node as handed in, since a walk takes at most one candidate.
function swappedAnswer(
	node: common.typedSimple.DefineNode,
	index: number,
): common.typedSimple.DefineNode {
	return {
		...node,
		arms: node.arms.map((arm, at) =>
			at === index ? { ...arm, value: node.otherwise } : arm,
		),
		otherwise: node.arms[index]!.value,
	}
}

// One up, one down, and zero, without repeats or the literal itself, which no
// test could kill.
function integerNudges(
	node: common.typedSimple.IntegerValueNode,
): Array<ExpressionCandidate> {
	let value: bigint

	try {
		value = BigInt(node.value)
	} catch {
		// Unreachable for a literal the lexer accepted, but a throw here would
		// end the compile.
		return []
	}

	let nudges = [...new Set([value + 1n, value - 1n, 0n])].filter(
		(nudged) => nudged !== value,
	)

	return nudges.map((nudged) => ({
		operator: "integer" as const,
		description: `swap ${node.value} for ${nudged}`,
		rewrite: (): common.typedSimple.ExpressionNode => ({
			...node,
			value: nudged.toString(),
		}),
	}))
}

// A construction swapped for a sibling Case of the same Choice.
function caseSwaps(
	node: common.typedSimple.CaseValueNode,
	context: MutationContext,
): Array<ExpressionCandidate> {
	if (node.type.type !== "Case") {
		return []
	}

	let sibling = nextSibling(node.type, context)

	if (sibling === null) {
		return []
	}

	return [
		{
			operator: "case",
			description: `swap #${node.type.name} for #${sibling.name}`,
			rewrite: (): common.typedSimple.ExpressionNode => ({
				...node,
				tag: `${sibling.choice}#${sibling.name}`,
				type: sibling,
			}),
		},
	]
}

// The next Case in the context's order, wrapping around, with the same member
// names, since the payload is kept. One sibling, not all of them.
function nextSibling(
	type: common.CaseType,
	context: MutationContext,
): common.CaseType | null {
	let siblings = context.choices.get(type.choice)

	if (siblings === undefined) {
		return null
	}

	let index = siblings.findIndex((each) => each.name === type.name)

	if (index === -1) {
		return null
	}

	let members = Object.keys(type.members).join(",")

	for (let step = 1; step < siblings.length; step++) {
		let candidate = siblings[(index + step) % siblings.length]!

		if (Object.keys(candidate.members).join(",") === members) {
			return candidate
		}
	}

	return null
}

// The Method-name swaps, always in the same order.
function memberSwaps(
	node: common.typedSimple.MethodInvocationNode,
	context: MutationContext,
): Array<ExpressionCandidate> {
	let member = withoutOverloadSuffix(node.member.name)
	let families: Array<[MutationOperator, Array<string>]> = [
		["equality", EQUALITY_SWAPS.get(member) ?? []],
		["comparison", COMPARISON_SWAPS.get(member) ?? []],
		["arithmetic", ARITHMETIC_SWAPS.get(member) ?? []],
	]
	let swaps: Array<ExpressionCandidate> = []

	// Nothing inside a narrowing condition, which typed the body it opens.
	if (context.narrowed.has(node)) {
		return []
	}

	for (let [operator, targets] of families) {
		for (let target of targets) {
			let name = swappableMember(node, member, target, context)

			if (name === null) {
				continue
			}

			swaps.push({
				operator,
				description: `swap ::${member} for ::${target}`,
				rewrite: (): common.typedSimple.ExpressionNode => ({
					...node,
					member: { name },
				}),
			})
		}
	}

	return swaps
}

// The mangled name to call instead, or null where the swap can not be shown
// sound. A call to a missing member would count as a kill no test earned. See
// "Type-shaped mutants" in DEVELOPMENT.md.
function swappableMember(
	node: common.typedSimple.MethodInvocationNode,
	member: string,
	target: string,
	context: MutationContext,
): string | null {
	let overload = overloadIndexOf(node.member.name)

	if (node.providedBy !== undefined) {
		// A provided Method is emitted under its plain name, so a mangled call
		// is refused.
		return overload === null && provides(node.providedBy, target)
			? target
			: null
	}

	let declared = context.namespaces.get(node.base.name)

	if (declared === undefined) {
		return null
	}

	// A Module's Namespace holds its Methods by mangled name. Both kinds check
	// the arity, since the call's Arguments are handed on unchanged.
	if (declared.kind === "module") {
		let name =
			overload === null
				? target
				: resolveOverloadedMethodName(target, overload)
		let replacement = ownMethod(declared.methods, name)
		let original = ownMethod(declared.methods, node.member.name)

		return replacement !== undefined &&
			original !== undefined &&
			replacement.isStatic === original.isStatic &&
			replacement.method.value.parameters.length ===
				original.method.value.parameters.length
			? name
			: null
	}

	let method = ownMethod(declared.methods, target)

	if (method === undefined) {
		return null
	}

	if (overload === null) {
		return method.type === "SimpleMethod" || method.type === "StaticMethod"
			? target
			: null
	}

	if (
		method.type !== "OverloadedMethod" &&
		method.type !== "OverloadedStaticMethod"
	) {
		return null
	}

	let replacement = method.overloads[overload]
	let original = ownMethod(declared.methods, member)

	if (
		replacement === undefined ||
		original === undefined ||
		original.type !== method.type
	) {
		return null
	}

	// Labels need not agree, since the emitted call is positional. Every member
	// of a swap table takes the same operand Types.
	let originalOverload = original.overloads[overload]

	return originalOverload !== undefined &&
		originalOverload.parameterTypes.length ===
			replacement.parameterTypes.length
		? resolveOverloadedMethodName(target, overload)
		: null
}

// A bare read of `methods["toString"]` would answer out of `Object.prototype`.
function ownMethod<Method>(
	methods: Record<string, Method>,
	name: string,
): Method | undefined {
	return Object.hasOwn(methods, name) ? methods[name] : undefined
}

// Whether this Protocol, not an ancestor, wrote the body the swap would call.
function provides(protocolName: string, member: string): boolean {
	return (
		ownMethod(builtinProtocols(), protocolName)?.providedMethods?.[
			member
		] === protocolName
	)
}

// #endregion

// #region What the walk has to know

// A Namespace the Module declares, keyed by mangled name, or a builtin one. An
// imported Namespace is neither, so a swap onto it is refused.
type KnownNamespace =
	| { kind: "module"; methods: common.typedSimple.Methods }
	| { kind: "builtin"; methods: Record<string, common.MethodType> }

type MutationContext = {
	namespaces: Map<string, KnownNamespace>
	// Each Choice's Cases with their whole Types, from the Module's own Type
	// Aliases in declaration order, then from the constructions as met.
	choices: Map<string, Array<common.CaseType>>
	// Every Node of a condition that narrows in either direction. It is
	// gathered first, since the walk reaches a condition's Nodes before its
	// `if`.
	narrowed: Set<common.typedSimple.ExpressionNode>
}

// One context per Program, since a run walks one Program once per mutant and
// never changes it. Weak, so a finished Program takes its context with it.
const CONTEXTS = new WeakMap<common.typedSimple.Program, MutationContext>()

function contextOf(program: common.typedSimple.Program): MutationContext {
	let held = CONTEXTS.get(program)

	if (held !== undefined) {
		return held
	}

	let context = readContext(program)

	CONTEXTS.set(program, context)

	return context
}

function readContext(program: common.typedSimple.Program): MutationContext {
	let namespaces = new Map<string, KnownNamespace>()

	for (let namespace of builtinNamespaces()) {
		namespaces.set(namespace.name, {
			kind: "builtin",
			methods: namespace.methods,
		})
	}

	let choices = new Map<string, Array<common.CaseType>>()

	let remember = (type: common.CaseType): void => {
		let held = choices.get(type.choice)

		if (held === undefined) {
			choices.set(type.choice, [type])

			return
		}

		if (!held.some((each) => each.name === type.name)) {
			held.push(type)
		}
	}

	// A declaration orders its Choice's Cases, whatever the walk met first.
	let declare = (cases: Array<common.CaseType>): void => {
		let met = choices.get(cases[0]!.choice) ?? []

		choices.set(cases[0]!.choice, [
			...cases,
			...met.filter(
				(type) => !cases.some((each) => each.name === type.name),
			),
		])
	}

	let narrowed = new Set<common.typedSimple.ExpressionNode>()

	// One walk gathers the Namespaces, the Choices and the narrowing
	// conditions.
	rewriteNodes(
		{ ...program, tests: null },
		{
			statement: (node) => {
				if (node.nodeType === "NamespaceDefinitionStatement") {
					namespaces.set(node.name.name, {
						kind: "module",
						methods: node.methods,
					})
				}

				if (node.nodeType === "TypeAliasStatement") {
					let cases = declaredCases(node.type, node.name.name)

					if (cases !== null) {
						declare(cases)
					}
				}

				// Both claims, since `separator::isEmpty()` proves
				// `NonEmptyString` for the `else`.
				if (
					node.nodeType === "ConditionalStatement" &&
					(node.narrows || node.narrowsFalse)
				) {
					collectCondition(program, node.condition, narrowed)
				}

				return node
			},
			expression: (node) => {
				if (
					node.nodeType === "CaseValue" &&
					node.type.type === "Case"
				) {
					remember(node.type)
				}

				// An arm's Condition likewise, for its own answer or the arms
				// after it.
				if (node.nodeType === "Define") {
					for (let arm of node.arms) {
						if (arm.narrows || arm.narrowsBelow) {
							collectCondition(program, arm.condition, narrowed)
						}
					}
				}

				return node
			},
			// The mutation walk reaches the defaults, so this one does too.
			parameterDefaults: true,
		},
	)

	return { namespaces, choices, narrowed }
}

// Every Node of one condition, walked as a Program of its own. Nothing is
// rebuilt, so the mutation walk meets the same identities.
function collectCondition(
	program: common.typedSimple.Program,
	condition: common.typedSimple.ExpressionNode,
	found: Set<common.typedSimple.ExpressionNode>,
): void {
	rewriteNodes(
		{
			...program,
			implementation: { ...program.implementation, nodes: [condition] },
			tests: null,
		},
		{
			expression: (node) => {
				found.add(node)

				return node
			},
			parameterDefaults: true,
		},
	)
}

// #endregion
