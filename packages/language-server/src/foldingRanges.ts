import {
	forEachParserChild,
	type ParserNode,
} from "@essence-lang/compiler/visitor"
import type { common, parser } from "@essence-lang/interfaces"

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

		for (let node of [...section.head, ...section.nodes]) {
			collectFromNode(node, ranges)
		}
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

// A construct written over several lines folds, and so does each one inside
// it. An `if … else` folds as one range, since the Parser keeps no Position
// for `else`. A `define` arm has no closing brace to leave visible, and a
// `start` or `complete` stands on its operand's first line, so neither folds.
function collectFromNode(node: ParserNode, ranges: Array<FoldingRange>) {
	switch (node.nodeType) {
		case "FunctionStatement":
		case "OverloadedFunctionStatement":
		case "NamespaceDefinitionStatement":
		case "ProtocolDeclarationStatement":
		case "ChoiceDeclarationStatement":
		case "TypeAliasStatement":
		case "IfStatement":
		case "IfElseStatement":
		case "Match":
		case "Define":
		case "FunctionValue":
		case "RecordValue":
		case "ListValue":
		case "DictionaryValue":
		case "CaseValue":
		case "MethodInvocation":
		case "FunctionInvocation":
			addRange(ranges, node.position)
			break
	}

	forEachParserChild(node, collectFromNode, ranges)
}
