import type { common } from "@essence-lang/interfaces"

import { declaredCases, describeType } from "../../helpers/describe"
import type { OptimiserPass } from "../index"
import { rewriteNodes } from "../walk"

// Counts what ran, for `essence test --coverage`, and does nothing otherwise.
// It runs first, so each counter stands where the author wrote what it counts.
// See "instrument-coverage" in DEVELOPMENT.md.

export const instrumentCoverage: OptimiserPass = {
	name: "instrument-coverage",
	run: (program, _namespaces, options) =>
		options.coverage === true ? instrument(program) : program,
}

// Where a Method or a free Function stands, found by Position, so a point can
// name the one it is in.
type CoverageScope = { name: string; position: common.Position }

function instrument(
	program: common.typedSimple.Program,
): common.typedSimple.Program {
	let points: Array<common.typedSimple.CoveragePoint> = []
	let scopes = scopesOf(program)

	let mark = (
		kind: common.typedSimple.CoveragePointKind,
		label: string,
		position: common.Position,
		extra: { refinement?: boolean; tag?: string } = {},
	): number => {
		points.push({
			kind,
			label,
			scope: scopeAt(scopes, position),
			position,
			refinement: extra.refinement ?? false,
			tag: extra.tag ?? null,
		})

		return points.length - 1
	}

	// A Statement position takes a value-less counter, and an Expression
	// position one that answers with its value. `leads` says which side of the
	// value it counts on.
	let counter = (
		point: number,
		position: common.Position,
		value: common.typedSimple.ExpressionNode | null = null,
		leads = false,
	): common.typedSimple.CoverageCounterNode => ({
		nodeType: "CoverageCounter",
		point,
		value,
		leads,
		type: value === null ? { type: "Record", members: {} } : value.type,
		position,
	})

	// The implementation is instrumented whole, Parameter defaults included.
	// The tests section counts only Case constructions, which are claims about
	// what the tests did.
	let implementation = rewriteNodes(
		{ ...program, tests: null },
		{
			body: (nodes) => instrumentBody(nodes, mark, counter),
			statement: (node) => instrumentStatement(node, mark, counter),
			expression: (node) => instrumentExpression(node, mark, counter),
			parameterDefaults: true,
			parameterDefault: (node) => instrumentDefault(node, mark, counter),
		},
	)
	let instrumentedTests = rewriteNodes(
		{
			...program,
			implementation: { nodeType: "ImplementationSection", nodes: [] },
		},
		{
			expression: (node) => instrumentConstruction(node, mark),
			parameterDefaults: true,
		},
	)

	let choices = choicesOf(program)

	// A Module with nothing to count or declare carries no table, and stays out
	// of every report.
	if (points.length === 0 && choices.length === 0) {
		return program
	}

	return {
		...program,
		implementation: implementation.implementation,
		tests: instrumentedTests.tests,
		coverage: { nodeType: "CoverageSection", points, choices },
	}
}

// #region The points

type Mark = (
	kind: common.typedSimple.CoveragePointKind,
	label: string,
	position: common.Position,
	extra?: { refinement?: boolean; tag?: string },
) => number

type Counter = (
	point: number,
	position: common.Position,
	value?: common.typedSimple.ExpressionNode | null,
	leads?: boolean,
) => common.typedSimple.CoverageCounterNode

// One counter before every Statement the source wrote, apart from
// declarations, which are there whether or not anything ran.
function instrumentBody(
	nodes: Array<common.typedSimple.ImplementationNode>,
	mark: Mark,
	counter: Counter,
): Array<common.typedSimple.ImplementationNode> {
	if (!nodes.some(countsAsStatement)) {
		return nodes
	}

	let instrumented: Array<common.typedSimple.ImplementationNode> = []

	for (let node of nodes) {
		if (countsAsStatement(node)) {
			instrumented.push(
				counter(mark("statement", "", node.position!), node.position!),
			)
		}

		instrumented.push(node)
	}

	return instrumented
}

function countsAsStatement(
	node: common.typedSimple.ImplementationNode,
): boolean {
	if (node.position === undefined) {
		return false
	}

	switch (node.nodeType) {
		case "CoverageCounter":
		case "NamespaceDefinitionStatement":
		case "ProtocolDeclarationStatement":
		case "TypeAliasStatement":
		case "FunctionStatement":
			return false
		default:
			return true
	}
}

// A default runs on each call that leaves its Argument out, and counts as a
// Statement would, before its value is built.
function instrumentDefault(
	node: common.typedSimple.ExpressionNode,
	mark: Mark,
	counter: Counter,
): common.typedSimple.ExpressionNode {
	if (node.position === undefined) {
		return node
	}

	return counter(
		mark("statement", "", node.position),
		node.position,
		node,
		true,
	)
}

// Both sides of every Conditional, so an `if` without an `else` still reports
// a condition that was never false. Each side's `refinement` is its own claim.
function instrumentStatement(
	node: common.typedSimple.ImplementationNode,
	mark: Mark,
	counter: Counter,
): common.typedSimple.ImplementationNode {
	if (
		node.nodeType !== "ConditionalStatement" ||
		node.position === undefined
	) {
		return node
	}

	let truePosition = node.trueBody[0]?.position ?? node.position
	let falsePosition = node.falseBody[0]?.position ?? node.position

	return {
		...node,
		trueBody: [
			counter(
				mark("branch", "if", truePosition, {
					refinement: node.narrows,
				}),
				truePosition,
			),
			...node.trueBody,
		],
		falseBody: [
			counter(
				mark("branch", "else", falsePosition, {
					refinement: node.narrowsFalse,
				}),
				falsePosition,
			),
			...node.falseBody,
		],
	}
}

// A Match's arms, a `define`'s arms and every Case construction.
function instrumentExpression(
	node: common.typedSimple.ExpressionNode,
	mark: Mark,
	counter: Counter,
): common.typedSimple.ExpressionNode {
	if (node.nodeType === "Match") {
		return { ...node, handlers: instrumentHandlers(node, mark, counter) }
	}

	if (node.nodeType === "Define") {
		return instrumentArms(node, mark, counter)
	}

	return instrumentConstruction(node, mark)
}

// A `define` arm is a branch point that wraps the arm's answer, since it has no
// body. The `otherwise` point is a refinement where an arm's complement
// narrows.
function instrumentArms(
	node: common.typedSimple.DefineNode,
	mark: Mark,
	counter: Counter,
): common.typedSimple.DefineNode {
	let narrows = node.arms.some((arm) => arm.narrowsBelow)
	let arms = node.arms.map((arm) => {
		let position = arm.value.position

		if (position === undefined) {
			return arm
		}

		return {
			...arm,
			value: counter(
				mark("branch", "if", position, { refinement: arm.narrows }),
				position,
				arm.value,
				true,
			),
		}
	})
	let position = node.otherwise.position

	if (position === undefined) {
		return { ...node, arms }
	}

	return {
		...node,
		arms,
		otherwise: counter(
			mark("branch", "otherwise", position, { refinement: narrows }),
			position,
			node.otherwise,
			true,
		),
	}
}

function instrumentHandlers(
	node: common.typedSimple.MatchNode,
	mark: Mark,
	counter: Counter,
): Array<common.typedSimple.MatchHandler> {
	return node.handlers.map((handler) => {
		let position = handler.body[0]?.position ?? node.position

		if (position === undefined) {
			return handler
		}

		return {
			...handler,
			body: [
				counter(
					mark("case", matcherLabel(handler), position),
					position,
				),
				...handler.body,
			],
		}
	})
}

// Only a construction the source wrote, which has a Position.
function instrumentConstruction(
	node: common.typedSimple.ExpressionNode,
	mark: Mark,
): common.typedSimple.ExpressionNode {
	if (node.nodeType !== "CaseValue" || node.position === undefined) {
		return node
	}

	if (node.type.type !== "Case") {
		return node
	}

	return {
		nodeType: "CoverageCounter",
		point: mark("construction", `#${node.type.name}`, node.position, {
			tag: node.tag,
		}),
		value: node,
		// Counted after the value, so a payload that throws counts nothing.
		leads: false,
		type: node.type,
		position: node.position,
	}
}

// An arm's label as written: `case #Postponed`, a literal's value such as
// `case 0`, or else the Type it tests for.
function matcherLabel(handler: common.typedSimple.MatchHandler): string {
	if (handler.literal !== null) {
		return `case ${literalLabel(handler.literal)}`
	}

	if (handler.matcher.type === "Case") {
		return `case #${handler.matcher.name}`
	}

	let members =
		handler.memberLiterals === null
			? []
			: Object.entries(handler.memberLiterals).map(
					([name, value]) => `${name} = ${literalLabel(value)}`,
				)

	return members.length === 0
		? `case ${describeType(handler.matcher)}`
		: `case { ${members.join(", ")} }`
}

// A literal as written, or else its Type, since a fragment of emitted
// JavaScript would be a worse label.
function literalLabel(node: common.typedSimple.ExpressionNode): string {
	switch (node.nodeType) {
		case "StringValue":
			return JSON.stringify(node.value)
		case "IntegerValue":
			return node.value
		case "RationalValue":
			return `${node.numerator}/${node.denominator}`
		case "BooleanValue":
			return node.value ? "true" : "false"
		default:
			return describeType(node.type)
	}
}

// #endregion

// #region Scopes and Choices

// Collected through the shared walk, which reaches a Namespace nested anywhere.
// Nothing is rewritten.
function scopesOf(program: common.typedSimple.Program): Array<CoverageScope> {
	let scopes: Array<CoverageScope> = []

	rewriteNodes(
		{ ...program, tests: null },
		{
			statement: (node) => {
				if (
					node.nodeType === "FunctionStatement" &&
					node.position !== undefined
				) {
					scopes.push({
						name: displayMemberName(node.name.name),
						position: node.position,
					})
				}

				// A Protocol's provided Methods are named like a Namespace's.
				if (
					node.nodeType === "NamespaceDefinitionStatement" ||
					node.nodeType === "ProtocolDeclarationStatement"
				) {
					for (let [member, method] of Object.entries(node.methods)) {
						let position = method.method.position

						if (position === undefined) {
							continue
						}

						scopes.push({
							name: `${node.name.name}::${displayMemberName(member)}`,
							position,
						})
					}
				}

				return node
			},
		},
	)

	return scopes
}

// The innermost scope holding the point. On a tie the first collected wins,
// which is the nested one, since the walk is bottom-up.
function scopeAt(
	scopes: Array<CoverageScope>,
	position: common.Position,
): string {
	let found = ""
	let width = Number.POSITIVE_INFINITY

	for (let scope of scopes) {
		if (!holds(scope.position, position)) {
			continue
		}

		let span = scope.position.end.line - scope.position.start.line

		if (span < width) {
			found = scope.name
			width = span
		}
	}

	return found
}

// How two spans of one file stand to each other. `essence test --mutate` joins
// its sites onto these points with the same definitions.
export function before(left: common.Cursor, right: common.Cursor): boolean {
	return (
		left.line < right.line ||
		(left.line === right.line && left.column < right.column)
	)
}

export function holds(outer: common.Position, inner: common.Position): boolean {
	return !before(inner.start, outer.start) && !before(outer.end, inner.end)
}

export function overlaps(
	left: common.Position,
	right: common.Position,
): boolean {
	return !before(left.end, right.start) && !before(right.end, left.start)
}

// A report shows a Method's name without its overload suffix.
const overloadSuffix = /__overload\$\d+$/

function displayMemberName(name: string): string {
	return name.replace(overloadSuffix, "")
}

// Every Choice the Module declares, with the tag of each of its Cases.
function choicesOf(
	program: common.typedSimple.Program,
): Array<common.typedSimple.CoverageChoice> {
	let choices: Array<common.typedSimple.CoverageChoice> = []

	rewriteNodes(
		{ ...program, tests: null },
		{
			statement: (node) => {
				if (
					node.nodeType === "TypeAliasStatement" &&
					node.position !== undefined
				) {
					let cases = declaredCases(node.type, node.name.name)

					if (cases !== null) {
						choices.push({
							name: node.name.name,
							cases: cases.map(
								(member) => `${member.choice}#${member.name}`,
							),
							position: node.position,
						})
					}
				}

				return node
			},
		},
	)

	return choices
}

// #endregion
