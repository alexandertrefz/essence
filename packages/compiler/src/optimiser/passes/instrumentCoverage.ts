import type { common } from "@essence-lang/interfaces"

import { describeType, displayChoiceName } from "../../helpers/index"
import type { OptimiserPass } from "../index"
import { rewriteNodes } from "../walk"

// NOTE: Coverage is instrumentation, not an improvement — it is the one entry
// in the registry that makes a Program do MORE work, and it runs only where the
// caller asked to be told what ran. `essence test --coverage` is that caller,
// and `OptimiserOptions.coverage` is how it asks. Every other compile finds
// this pass a no-op, which is why it can stand in the registry beside passes
// that are always right to run.
//
// NOTE: It is FIRST in the order, and that is the whole of what makes the
// answer about the source rather than about the Program the Optimiser made of
// it. A counter written before `lower-matches-to-statements` stands in the arm
// the author wrote; one written after it stands in a Statement the Compiler
// invented, at a Position that may not exist in the file. Coverage is a claim
// about a file, so it is measured on the shape the file has.
//
// NOTE: What that costs is honest and worth writing down: a later pass may
// remove code a counter stands in — `fold-constants` folds a Conditional whose
// condition is known, `prune-dead-match-arms` drops an arm no value can reach —
// and the point stays in the table, counted zero, and is reported as never
// taken. Which it is: a branch nothing can enter was never entered. Nothing is
// ever counted that did not run, which is the direction that matters.
//
// NOTE: A counter is impure (`purity.ts`), so no pass pools one, hoists it out
// of the branch it belongs to, or drops it where the value it answers with is
// unread.
//
// NOTE: The standard library is never instrumented. The prelude is built with
// coverage stripped out of the Options (see `withOptimiserOptions` in
// `rewriter/stdlibPrelude.ts`) — a report about a project is a report about the
// project's own files, and instrumenting seventeen library Programs into every
// bundle would cost far more than the answer is worth.

export const instrumentCoverage: OptimiserPass = {
	name: "instrument-coverage",
	run: (program, _namespaces, options) =>
		options.coverage === true ? instrument(program) : program,
}

// NOTE: Where a Namespace Method or a free Function stands, so that a point can
// say which one it is in — `Standings::compute › case #Postponed` reads without
// the reader opening the file. It is answered by POSITION rather than carried
// down a walk: the shared walk offers Nodes bottom-up and says nothing about
// what encloses them, and a Position is a fact every instrumented Node has.
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

	let counter = (
		point: number,
		position: common.Position,
	): common.typedSimple.CoverageCounterNode => ({
		nodeType: "CoverageCounter",
		point,
		value: null,
		type: { type: "Record", members: {} },
		position,
	})

	// NOTE: The implementation is instrumented WHOLE — every Statement, every
	// branch, every arm, every Case construction. The tests section is
	// instrumented for constructions and for nothing else: what a report is
	// about is the code under test, and counting a test's own Statements would
	// answer "how much of this file ran" with the tests that ran it. A Case
	// built inside a test body is another matter — "no test ever builds a
	// `#Forfeited`" is a claim about what the tests DID, and a test that builds
	// one is exactly what makes it false.
	let implementation = rewriteNodes(
		{ ...program, tests: null },
		{
			body: (nodes) => instrumentBody(nodes, mark, counter),
			statement: (node) => instrumentStatement(node, mark, counter),
			expression: (node) => instrumentExpression(node, mark, counter),
		},
	)
	let instrumentedTests = rewriteNodes(
		{
			...program,
			implementation: { nodeType: "ImplementationSection", nodes: [] },
		},
		{ expression: (node) => instrumentConstruction(node, mark) },
	)

	let choices = choicesOf(program)

	// NOTE: A Module with nothing to count and nothing to declare carries no
	// table at all — which is what keeps a `Foo.tests.es` whose tests build no
	// Case, and a Module of nothing but imports, out of every report.
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
) => common.typedSimple.CoverageCounterNode

// NOTE: One counter in front of every Statement a reader wrote. Declarations
// are skipped — a `namespace`, a `type`, a `protocol` and a `function` are
// there whether or not anything ran, and counting them would report a file that
// declares and is never called as covered. So is anything with no Position: the
// Simplifier synthesizes Statements nobody wrote — a unit-returning Function's
// trailing Return, a conformance witness — and a report can not point at one.
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

// NOTE: Both sides of every Conditional, counted apart — which is what branch
// coverage IS, and why an `if` with no `else` still gets one: "the condition
// was never false" is the thing worth being told. `narrows` rides along on both
// halves, because a branch whose condition established something is a doorway,
// and the question a report asks about a doorway is exactly whether the guarded
// path and the fallback were each reached.
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
					refinement: node.narrows,
				}),
				falsePosition,
			),
			...node.falseBody,
		],
	}
}

// NOTE: A Match's arms, and every Case construction. The two are the whole of
// what makes coverage in an exhaustive language more precise than lines: a
// `match` names every Case it can meet, so "which arms never ran" is a complete
// statement, and a `choice` names every Case there is, so "which were never
// built" is one too.
function instrumentExpression(
	node: common.typedSimple.ExpressionNode,
	mark: Mark,
	counter: Counter,
): common.typedSimple.ExpressionNode {
	if (node.nodeType === "Match") {
		return { ...node, handlers: instrumentHandlers(node, mark, counter) }
	}

	return instrumentConstruction(node, mark)
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

// NOTE: Only a construction the SOURCE wrote. The Simplifier and the Enricher
// build Cases nobody asked for — an Optional wrapped around a value, a witness
// — and those carry no Position, which is exactly the line between the two.
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
		type: node.type,
		position: node.position,
	}
}

// NOTE: What a report calls an arm, spelled the way the arm itself was written.
// A Case Matcher is `case #Postponed`; a Matcher that tests a VALUE is that
// value, because `case 0` and `case Integer` are two different arms of one
// `match` and a report that called them both `case Integer` would name neither.
// Everything else names the Type it tests for.
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

// NOTE: A literal as a reader wrote it. Anything that is not one — which a
// Matcher's literal never is, but the Type says it could be — falls back to the
// Type, because a label that is a fragment of emitted JavaScript is worse than
// a label that is vague.
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

// NOTE: Collected through the shared walk rather than through a reading of the
// tree's shape written here: a Namespace nested inside a Function is still a
// Namespace, and a second walk would be a second chance to disagree about where
// one can stand. Nothing is rewritten — every hook answers with what it was
// given.
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

				if (node.nodeType === "NamespaceDefinitionStatement") {
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

// NOTE: The INNERMOST scope holding the point — a Function literal written
// inside a Method is the Method's business, and a Method written inside a
// Namespace inside a Function is its own. A tie goes to the one collected
// FIRST, and the walk that collects them is bottom-up, so on a tie the nested
// one is the one that was collected first.
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

// NOTE: How two spans of one file stand to each other, spelled HERE because a
// coverage point's span is this pass's own — the span of the Node it stood in
// front of. `essence test --mutate` joins its mutation sites onto these points
// by position, and agreement with this pass about what "holds" and "overlaps"
// mean IS that join's correctness. A second spelling over there would be a
// second answer waiting to happen.
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

// NOTE: The overload suffix the Simplifier mangles a Method's name with is not
// what the author wrote, and a report is read by the author.
const overloadSuffix = /__overload\$\d+$/

function displayMemberName(name: string): string {
	return name.replace(overloadSuffix, "")
}

// NOTE: Every Choice the Module DECLARES. A Choice erases to a Type Alias by
// this point, so what tells one apart from an ordinary alias is that its Union
// is Cases, that they all belong to one Choice, and that the Choice is the one
// the alias names — `type Answer = Optional<Integer>` is a Union of Cases too,
// and is not a declaration of anything.
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
							cases,
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

function declaredCases(type: common.Type, name: string): Array<string> | null {
	if (type.type === "GenericAlias") {
		return declaredCases(type.aliasedType, name)
	}

	if (type.type !== "UnionType" || type.types.length === 0) {
		return null
	}

	let tags: Array<string> = []

	for (let member of type.types) {
		if (
			member.type !== "Case" ||
			displayChoiceName(member.choice) !== name
		) {
			return null
		}

		tags.push(`${member.choice}#${member.name}`)
	}

	return tags
}

// #endregion
