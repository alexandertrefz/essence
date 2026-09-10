import type { common, parser } from "@essence-lang/interfaces"

import { walk, walkNode } from "./codeActions/lookups"
import { contains, isSmaller } from "./positions"
import { programSections } from "./sections"
import type { SnippetContext } from "./snippets"

// NOTE: Which block a cursor stands in, which is the whole of what says WHICH
// snippets are an answer there: `static` parses in a Namespace body and nowhere
// else, `expect` in a test body and nowhere else, and offering either anywhere
// else is offering a Parser Diagnostic.
//
// Read off the parsed Program rather than off the text. Keywords are offered
// from the text alone — see the NOTE on `keywordCompletions`, which declines
// exactly this analysis — and the reason the two differ is what each costs to
// be wrong about: a Keyword offered where it will not parse is one word the
// reader deletes, while a snippet is four lines of scaffold. The Program is
// already parsed for every other reading Completion takes, so the analysis is
// a walk rather than a compile.
//
// A block is a SPAN here, and the innermost span containing the cursor wins.
// That is what lets a Namespace's Method bodies read as Statement bodies while
// the member list between them reads as the Namespace it is: the Method's own
// Function literal is a smaller span inside the Namespace's, and the same rule
// answers a `match` nested in a Method nested in a Namespace without any of the
// three knowing about the others.
type Block = { position: common.Position; context: SnippetContext }

// NOTE: `atStatementStart` is the reading `keywordCompletions` already takes
// off the text, handed in rather than taken again. It is what tells the two
// halves of one block apart — a fresh line inside a `match`'s braces is where a
// Handler is written, and the same braces halfway through `case X { <- ` are
// where a value is — and the Parser can not answer it, because the text that
// asks it is text that does not parse yet.
export function snippetContextAt(
	program: parser.Program | null,
	cursor: common.Cursor,
	atStatementStart: boolean,
): SnippetContext {
	// NOTE: A document that does not parse still has a cursor in it. The text
	// reading alone is what is left, and it can tell a value position from a
	// Statement one — so the ordinary Statement snippets are offered, and the
	// ones that need to know they stand in a Namespace or a test are not.
	if (program === null) {
		return atStatementStart ? "implementation" : "expression"
	}

	// NOTE: Ahead of everything below, and on their own: the Module sections
	// take no Expression and no Statement at all, so neither the block walk nor
	// the text reading has anything to say about a cursor inside one.
	if (
		program.imports !== null &&
		contains(program.imports.position, cursor)
	) {
		return "import"
	}

	if (
		program.exports !== null &&
		contains(program.exports.position, cursor)
	) {
		return "export"
	}

	let block = blockAt(program, cursor)

	// NOTE: A value position is a value position whatever block it stands in —
	// what may be written after an `=` inside a test is what may be written
	// after an `=` inside a Method.
	return atStatementStart ? block : "expression"
}

function blockAt(
	program: parser.Program,
	cursor: common.Cursor,
): SnippetContext {
	let base = sectionAt(program, cursor)
	let context = base
	let innermost: common.Position | null = null

	for (let block of blocksOf(program, base)) {
		if (!contains(block.position, cursor)) {
			continue
		}

		// NOTE: Ties keep the block found first, which is the outer one: the
		// walk visits a Node before the Nodes it holds.
		if (innermost !== null && !isSmaller(block.position, innermost)) {
			continue
		}

		innermost = block.position
		context = block.context
	}

	return context
}

// NOTE: The section the cursor stands in, which is the block every Statement
// walk below falls back to. `programSections` is depth first and outermost
// first, so the LAST section containing the cursor is the innermost one — and
// taking the last is what settles the tie a file that is nothing but tests
// creates, where the empty implementation section spans the very same lines
// the `tests { … }` block does.
function sectionAt(
	program: parser.Program,
	cursor: common.Cursor,
): SnippetContext {
	let section: SnippetContext = "top"

	for (let candidate of programSections(program)) {
		if (!contains(candidate.position, cursor)) {
			continue
		}

		if (candidate.kind === "test") {
			section = "test"
		} else if (candidate.kind === "implementation") {
			section =
				program.kind === "declarations"
					? "declarations"
					: "implementation"
		} else {
			section = "tests"
		}
	}

	return section
}

// NOTE: Every block a Statement or a value may be written in, other than the
// sections themselves. The ones carrying `base` are the blocks that RE-OPEN a
// Statement body inside something that is not one — a Method's body inside a
// Namespace, a Handler's body inside a `match` — and they carry the section's
// own reading, because a Statement written there is a Statement of that
// section.
function blocksOf(program: parser.Program, base: SnippetContext): Array<Block> {
	let blocks: Array<Block> = []

	let collect = (node: parser.ImplementationNode) => {
		switch (node.nodeType) {
			case "NamespaceDefinitionStatement":
				blocks.push({ position: node.position, context: "namespace" })
				return
			case "ProtocolDeclarationStatement":
				blocks.push({ position: node.position, context: "protocol" })

				// NOTE: The Nodes below a Protocol are the one part of the tree
				// `walk` does not reach — a provided Method's body is a body
				// like any other, so it is walked here rather than left out.
				for (let body of providedBodies(node)) {
					blocks.push({ position: body.position, context: base })

					for (let statement of body.value.body) {
						walkNode(statement, collect)
					}
				}

				return
			case "Match":
				blocks.push({ position: node.position, context: "match" })

				// NOTE: A Handler carries no Position of its own, so its body
				// is spanned by the Statements written in it. An empty one
				// spans nothing, and the `match` around it answers instead.
				for (let handler of node.handlers) {
					let body = spanOf(handler.body)

					if (body !== null) {
						blocks.push({ position: body, context: base })
					}
				}

				return
			case "Define":
				blocks.push({ position: node.position, context: "define" })

				// NOTE: An arm is one Expression from `as` to the end of its
				// Condition — nothing inside it is a Statement, and the two
				// halves are both values.
				for (let arm of node.arms) {
					blocks.push({
						position: arm.position,
						context: "expression",
					})
				}

				blocks.push({
					position: node.otherwise.position,
					context: "expression",
				})

				return
			// NOTE: Every Function literal — a Namespace Method, a callback, a
			// `step` — opens a Statement body of its own.
			case "FunctionValue":
				blocks.push({ position: node.position, context: base })
				return
			default:
				return
		}
	}

	walk(program, collect)

	return blocks
}

function providedBodies(
	node: parser.ProtocolDeclarationStatementNode,
): Array<parser.FunctionValueNode> {
	let bodies: Array<parser.FunctionValueNode> = []

	for (let member of Object.values(node.methods)) {
		let signatures =
			member.nodeType === "OverloadedProtocolMethod" ||
			member.nodeType === "OverloadedStaticProtocolMethod"
				? member.signatures
				: [member.signature]

		for (let signature of signatures) {
			if (signature.body !== null) {
				bodies.push(signature.body)
			}
		}
	}

	return bodies
}

function spanOf(
	nodes: Array<parser.ImplementationNode>,
): common.Position | null {
	let first = nodes[0]
	let last = nodes[nodes.length - 1]

	if (first === undefined || last === undefined) {
		return null
	}

	return { start: first.position.start, end: last.position.end }
}
