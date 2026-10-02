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

// The ranges in the order they were found, and the lines of each as a key, so
// a repeat is found without a scan.
type Folds = {
	ranges: Array<FoldingRange>
	seen: Set<string>
}

export function findFoldingRanges(
	program: parser.Program,
): Array<FoldingRange> {
	let folds: Folds = { ranges: [], seen: new Set() }

	// The `implementation` block folds, and so do the Module sections around it.
	if (program.imports !== null) {
		addRange(folds, program.imports.position)
		collectGroups(program.imports.groups, folds)
	}

	// Every Section folds as the block it is written as, down to each `test`.
	for (let section of programSections(program)) {
		addRange(folds, section.position)

		for (let node of [...section.head, ...section.nodes]) {
			collectFromNode(node, folds)
		}
	}

	if (program.exports !== null) {
		addRange(folds, program.exports.position)
		collectGroups(program.exports.groups, folds)
	}

	return folds.ranges
}

// A group written over several lines folds; a flat one has nothing to fold.
function collectGroups(
	groups: Array<parser.ImportGroupNode | parser.ExportGroupNode>,
	folds: Folds,
) {
	for (let group of groups) {
		addRange(folds, group.position)
	}
}

function addRange(folds: Folds, position: common.Position) {
	if (position.end.line <= position.start.line) {
		return
	}

	let range = {
		startLine: position.start.line,
		endLine: position.end.line - 1,
	}
	let key = `${range.startLine}:${range.endLine}`

	// Two ranges over the same lines are one fold. A file of only tests has an
	// empty implementation spanning its `tests` block.
	if (folds.seen.has(key)) {
		return
	}

	folds.seen.add(key)
	folds.ranges.push(range)
}

// A construct written over several lines folds, and so does each one inside
// it. An `if … else` folds as one range, since the Parser keeps no Position
// for `else`. A `define` arm has no closing brace to leave visible, and a
// `start` or `complete` stands on its operand's first line, so neither folds.
function collectFromNode(node: ParserNode, folds: Folds) {
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
			addRange(folds, node.position)
			break
	}

	forEachParserChild(node, collectFromNode, folds)
}
