import {
	caseDefaults,
	memberExpression,
	parameterDefaults,
} from "@essence-lang/compiler/helpers"
import type { common, parser } from "@essence-lang/interfaces"

import { assertionExpressions } from "./assertionChildren"
import { defineExpressions } from "./defineArmChildren"
import { programSections } from "./sections"

// NOTE: Folding is derived from the Parser AST, so it keeps working while the
// Program has Type errors. Only constructs that span more than one line are
// worth folding, and the last line is excluded so that the closing brace
// stays visible when the range is collapsed.

export type FoldingRange = {
	startLine: number
	endLine: number
}

export function findFoldingRanges(
	program: parser.Program,
): Array<FoldingRange> {
	let ranges: Array<FoldingRange> = []

	// NOTE: The `implementation { … }` block itself is foldable too, and so are
	// the two Module sections framing it — an entry list is the one part of a
	// file a reader is done with once they know what it says.
	if (program.imports !== null) {
		addRange(ranges, program.imports.position)
	}

	// NOTE: Every Section folds as the block it is written as — the
	// implementation, the `tests { … }` block below it, and each `suite` and
	// `test` inside that. A reader who is done with what a file PROVES collapses
	// one line, exactly as they collapse the import list.
	for (let section of programSections(program)) {
		addRange(ranges, section.position)
		collectFromBody([...section.head, ...section.nodes], ranges)
	}

	if (program.exports !== null) {
		addRange(ranges, program.exports.position)
	}

	return ranges
}

function addRange(ranges: Array<FoldingRange>, position: common.Position) {
	if (position.end.line <= position.start.line) {
		return
	}

	let range = {
		startLine: position.start.line,
		endLine: position.end.line - 1,
	}

	// NOTE: Two ranges over the same lines are one fold, and a file that is
	// nothing but tests hands out exactly that — its implementation section is
	// an empty stand-in spanning the `tests { … }` block, so both Sections
	// cover the same lines. A Statement wrapping a single Expression has always
	// produced the same pair.
	if (
		ranges.some(
			(existing) =>
				existing.startLine === range.startLine &&
				existing.endLine === range.endLine,
		)
	) {
		return
	}

	ranges.push(range)
}

function collectFromBody(
	nodes: Array<parser.ImplementationNode>,
	ranges: Array<FoldingRange>,
) {
	for (let node of nodes) {
		collectFromNode(node, ranges)
	}
}

// NOTE: A block-like default — `= match …`, `= { … }`, a Function literal —
// lays itself out over lines of its own and folds like anything else that does.
function collectFromDefaults(
	parameters: Array<parser.ParameterNode>,
	ranges: Array<FoldingRange>,
) {
	for (let defaultValue of parameterDefaults(parameters)) {
		collectFromNode(defaultValue, ranges)
	}
}

function collectFromNode(
	node: parser.ImplementationNode,
	ranges: Array<FoldingRange>,
) {
	switch (node.nodeType) {
		case "FunctionStatement":
			addRange(ranges, node.position)
			collectFromDefaults(node.value.parameters, ranges)
			collectFromBody(node.value.body, ranges)
			return
		case "OverloadedFunctionStatement":
			addRange(ranges, node.position)

			// NOTE: An `overload function` block mixes bodied Function literals
			// with body-less native signatures — only the bodied entries have a
			// block to fold.
			for (let method of node.methods) {
				if (method.nodeType === "FunctionValue") {
					addRange(ranges, method.position)
					collectFromBody(method.value.body, ranges)
				}
			}

			return
		case "NamespaceDefinitionStatement": {
			addRange(ranges, node.position)

			for (let property of Object.values(node.properties)) {
				// NOTE: A native static Property has no value to fold.
				if (property.value !== null) {
					collectFromNode(property.value, ranges)
				}
			}

			for (let member of Object.values(node.methods)) {
				// NOTE: Only bodied Methods have a block to fold — the body-less
				// native signatures (declarations mode) have none, so they are
				// skipped.
				let methods: Array<parser.FunctionValueNode> = []

				if (
					member.nodeType === "SimpleMethod" ||
					member.nodeType === "StaticMethod"
				) {
					methods = [member.method]
				} else if (
					member.nodeType === "OverloadedMethod" ||
					member.nodeType === "OverloadedStaticMethod"
				) {
					methods = member.methods
				} else if (
					member.nodeType === "OverloadedMethodSignatures" ||
					member.nodeType === "OverloadedStaticMethodSignatures"
				) {
					methods = member.methods.filter(
						(entry): entry is parser.FunctionValueNode =>
							entry.nodeType === "FunctionValue",
					)
				}

				for (let method of methods) {
					addRange(ranges, method.position)
					collectFromBody(method.value.body, ranges)
				}
			}

			return
		}
		case "TypeAliasStatement":
			addRange(ranges, node.position)
			return
		case "ChoiceDeclarationStatement":
			addRange(ranges, node.position)

			// NOTE: A payload default may itself be a Record or a List written
			// across lines, which folds the way one written in a body does.
			for (let defaultValue of caseDefaults(node.cases)) {
				collectFromNode(defaultValue, ranges)
			}

			return
		case "ProtocolDeclarationStatement":
			addRange(ranges, node.position)

			// NOTE: A PROVIDED Method's block folds on its own, exactly as a
			// Namespace Method's does — it is a body like any other.
			for (let member of Object.values(node.methods)) {
				let signatures =
					member.nodeType === "OverloadedProtocolMethod" ||
					member.nodeType === "OverloadedStaticProtocolMethod"
						? member.signatures
						: [member.signature]

				for (let signature of signatures) {
					if (signature.body === null) {
						continue
					}

					addRange(ranges, signature.body.position)
					collectFromBody(signature.body.value.body, ranges)
				}
			}

			return
		case "IfStatement":
			addRange(ranges, node.position)
			collectFromNode(node.condition, ranges)
			collectFromBody(node.body, ranges)
			return
		case "IfElseStatement":
			// NOTE: One range for the whole Statement — the Parser keeps no
			// Position for the `else` keyword, so the branches cannot be
			// folded separately.
			addRange(ranges, node.position)
			collectFromNode(node.condition, ranges)
			collectFromBody(node.trueBody, ranges)
			collectFromBody(node.falseBody, ranges)
			return
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement":
			collectFromNode(node.value, ranges)
			return
		case "ReturnStatement":
			collectFromNode(node.expression, ranges)
			return
		// NOTE: An assertion folds nothing of its own — it is one Statement —
		// but a Function literal written inside one lays itself out over lines
		// and folds like any other.
		case "ExpectStatement":
		case "RequireStatement":
			for (let expression of assertionExpressions(node)) {
				collectFromNode(expression, ranges)
			}

			return
		case "Match":
			addRange(ranges, node.position)
			collectFromNode(node.value, ranges)

			for (let handler of node.handlers) {
				// NOTE: A Guard is an ordinary Expression and can be spelled
				// across as many lines as any other call.
				if (handler.guard !== null) {
					collectFromNode(handler.guard, ranges)
				}

				collectFromBody(handler.body, ranges)
			}

			return
		// NOTE: The block folds, an arm does not. An arm has a Position of its
		// own and could be handed out as a range, but folding is a brace's
		// affair — the last line is dropped so the closing brace stays
		// visible, and an arm has none to leave behind. What is inside one
		// still folds: a Record or a Function literal written across lines is
		// laid out the same in an arm as anywhere else.
		case "Define":
			addRange(ranges, node.position)

			for (let expression of defineExpressions(node)) {
				collectFromNode(expression, ranges)
			}

			return
		case "FunctionValue":
			addRange(ranges, node.position)
			collectFromDefaults(node.value.parameters, ranges)
			collectFromBody(node.value.body, ranges)
			return
		case "RecordValue":
			addRange(ranges, node.position)

			for (let member of Object.values(node.members)) {
				collectFromNode(memberExpression(member), ranges)
			}

			return
		case "ListValue":
			addRange(ranges, node.position)

			for (let value of node.values) {
				collectFromNode(value, ranges)
			}

			return
		case "DictionaryValue":
			addRange(ranges, node.position)

			for (let entry of node.entries) {
				collectFromNode(entry.key, ranges)
				collectFromNode(entry.value, ranges)
			}

			return
		case "InterpolatedStringValue":
			for (let segment of node.segments) {
				if (segment.kind === "expression") {
					collectFromNode(segment.expression, ranges)
				}
			}

			return
		case "CaseValue":
			addRange(ranges, node.position)

			if (node.value !== null) {
				collectFromNode(node.value, ranges)
			}

			return
		case "MethodInvocation":
			addRange(ranges, node.position)
			collectFromNode(node.base, ranges)
			collectFromArguments(node.arguments, ranges)
			return
		case "FunctionInvocation":
			addRange(ranges, node.position)
			collectFromNode(node.name, ranges)
			collectFromArguments(node.arguments, ranges)
			return
		case "Combination":
			collectFromNode(node.lhs, ranges)
			collectFromNode(node.rhs, ranges)
			return
		case "Lookup":
			collectFromNode(node.base, ranges)
			return
		// NOTE: A path is written on one line and folds nothing, but it has to
		// be named here all the same — this switch has no `default`, so a
		// nodeType it does not list is a hole nothing reports.
		case "MemberPath":
		case "Identifier":
		case "Self":
		case "StringValue":
		case "IntegerValue":
		case "RationalValue":
		case "BooleanValue":
			return
	}
}

function collectFromArguments(
	nodeArguments: Array<parser.ArgumentNode>,
	ranges: Array<FoldingRange>,
) {
	for (let argument of nodeArguments) {
		collectFromNode(argument.value, ranges)
	}
}
