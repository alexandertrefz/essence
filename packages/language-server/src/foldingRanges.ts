import {
	caseDefaults,
	memberExpression,
	parameterDefaults,
} from "@essence-lang/compiler/helpers"
import type { common, parser } from "@essence-lang/interfaces"

import { assertionExpressions } from "./assertionChildren"
import { defineExpressions } from "./defineArmChildren"
import { methodsOf, nativeSignaturesOf } from "./namespaceMembers"
import { programSections } from "./sections"

// Folding from the Parser AST, so it survives Type errors. Only constructs
// over several lines fold, and the last line stays out so the closing brace
// stays visible.

type FoldingRange = {
	startLine: number
	endLine: number
}

export function findFoldingRanges(
	program: parser.Program,
): Array<FoldingRange> {
	let ranges: Array<FoldingRange> = []

	// The `implementation` block folds, and so do the Module sections around it.
	if (program.imports !== null) {
		addRange(ranges, program.imports.position)
		collectGroups(program.imports.groups, ranges)
	}

	// Every Section folds as the block it is written as, down to each `test`.
	for (let section of programSections(program)) {
		addRange(ranges, section.position)
		collectFromBody([...section.head, ...section.nodes], ranges)
	}

	if (program.exports !== null) {
		addRange(ranges, program.exports.position)
		collectGroups(program.exports.groups, ranges)
	}

	return ranges
}

// A group written over several lines folds; a flat one has nothing to fold.
function collectGroups(
	groups: Array<parser.ImportGroupNode | parser.ExportGroupNode>,
	ranges: Array<FoldingRange>,
) {
	for (let group of groups) {
		addRange(ranges, group.position)
	}
}

function addRange(ranges: Array<FoldingRange>, position: common.Position) {
	if (position.end.line <= position.start.line) {
		return
	}

	let range = {
		startLine: position.start.line,
		endLine: position.end.line - 1,
	}

	// Two ranges over the same lines are one fold. A file of only tests has an
	// empty implementation spanning its `tests` block.
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

// A block-like default, such as `= match …`, folds like anything else.
function collectFromDefaults(
	parameters: Array<parser.ParameterNode>,
	ranges: Array<FoldingRange>,
) {
	for (let defaultValue of parameterDefaults(parameters)) {
		collectFromNode(defaultValue, ranges)
	}
}

// An `overload` block, which only the standard library writes, may mix bodied
// Functions with native signatures. A bodied one folds like a Function literal.
// A signature has no block, but a default written across lines folds. A
// Namespace's Methods are read the same way.
function collectFromOverloads(
	methods: Array<parser.FunctionValueNode | parser.NativeMethodSignatureNode>,
	ranges: Array<FoldingRange>,
) {
	for (let method of methods) {
		if (method.nodeType === "FunctionValue") {
			collectFromNode(method, ranges)
		} else {
			collectFromDefaults(method.parameters, ranges)
		}
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

			collectFromOverloads(node.methods, ranges)
			return
		case "NamespaceDefinitionStatement": {
			addRange(ranges, node.position)

			for (let property of Object.values(node.properties)) {
				// A native static Property has no value to fold.
				if (property.value !== null) {
					collectFromNode(property.value, ranges)
				}
			}

			for (let member of Object.values(node.methods)) {
				collectFromOverloads(methodsOf(member), ranges)
				collectFromOverloads(nativeSignaturesOf(member), ranges)
			}

			return
		}
		case "TypeAliasStatement":
			addRange(ranges, node.position)

			if (node.predicate !== null) {
				collectFromNode(node.predicate, ranges)
			}

			return
		case "ChoiceDeclarationStatement":
			addRange(ranges, node.position)

			// A payload default written across lines folds as in a body.
			for (let defaultValue of caseDefaults(node.cases)) {
				collectFromNode(defaultValue, ranges)
			}

			return
		case "ProtocolDeclarationStatement":
			addRange(ranges, node.position)

			// A provided Method's block folds like a Namespace Method's.
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
			// One range for the whole Statement: the Parser keeps no Position for `else`.
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
		// An assertion is one Statement, but a Function literal inside it folds.
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
				// A Guard may span lines like any call.
				if (handler.guard !== null) {
					collectFromNode(handler.guard, ranges)
				}

				collectFromBody(handler.body, ranges)
			}

			return
		// The block folds, an arm does not: an arm has no closing brace to leave
		// visible. What is inside an arm still folds.
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
		// Neither Keyword folds, but its operand may.
		case "Start":
		case "Complete":
			collectFromNode(node.expression, ranges)
			return
		case "RefusedValue":
			collectFromNode(node.base, ranges)
			return
		// A path folds nothing, but is listed, since this switch has no `default`.
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
