import type { common, parser } from "@essence-lang/interfaces"

import { walk } from "./codeActions/lookups"
import { contains, isSmaller } from "./positions"
import { programSections } from "./sections"
import type { ModuleSection, SnippetContext } from "./snippets"

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
type Block = {
	position: common.Position
	context: SnippetContext
	// NOTE: Whether the block is a Namespace Method's or a provided Protocol
	// Method's body, which is the one thing an EXPRESSION position needs to
	// know about the blocks around it: `{ @ with … }` means something there and
	// raises `at-outside-method` anywhere else. Read from every containing
	// block rather than from the innermost one, so that a Function literal
	// written inside a Method keeps it.
	method?: boolean
}

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

	// NOTE: A Parameter list is the one block that answers for BOTH readings.
	// What stands between those brackets is a name, a Type and a default, and
	// the text reading calls all of it a value position — so `function f(` is
	// offered every Record, Dictionary and `match` there is, none of which
	// parses where a Parameter goes.
	if (block.context === "parameters") {
		return "parameters"
	}

	// NOTE: Otherwise a value position is a value position whatever block it
	// stands in — what may be written after an `=` inside a test is what may be
	// written after an `=` inside a Method. The one exception is a Method's own
	// body, where `@` names something; `method` is that reading, and it offers
	// everything `expression` offers besides.
	if (atStatementStart) {
		return block.context
	}

	return block.method ? "method" : "expression"
}

// NOTE: The sections the file already WRITES. A Module has one of each, so a
// section snippet is an answer only where the section it opens is missing —
// accepting `tests` in a file that has a tests block writes a second one, which
// is `misplaced-tests-section` and a reader deleting four lines.
//
// A section the file does not write still has a Position: the Parser recovers
// an empty document into a Program whose implementation spans nothing at all.
// So what counts as written is a span something is written in.
export function writtenSections(
	program: parser.Program | null,
): Set<ModuleSection> {
	let written = new Set<ModuleSection>()

	if (program === null) {
		return written
	}

	if (!isEmptySpan(program.implementation.position)) {
		written.add("implementation")
	}

	if (program.tests !== null && !isEmptySpan(program.tests.position)) {
		written.add("tests")
	}

	if (program.imports !== null && !isEmptySpan(program.imports.position)) {
		written.add("import")
	}

	if (program.exports !== null && !isEmptySpan(program.exports.position)) {
		written.add("export")
	}

	return written
}

function blockAt(
	program: parser.Program,
	cursor: common.Cursor,
): { context: SnippetContext; method: boolean } {
	let base = sectionAt(program, cursor)
	let context = base
	let innermost: common.Position | null = null
	let method = false

	for (let block of blocksOf(program, base)) {
		if (!contains(block.position, cursor)) {
			continue
		}

		if (block.method === true) {
			method = true
		}

		// NOTE: Ties keep the block found first, which is the outer one: the
		// walk visits a Node before the Nodes it holds.
		if (innermost !== null && !isSmaller(block.position, innermost)) {
			continue
		}

		innermost = block.position
		context = block.context
	}

	return { context, method }
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
		// NOTE: A section the file does not WRITE still has a Position — the
		// Parser recovers an empty file into a Program whose implementation
		// spans `1:1` to `1:1` — and a zero-width span holds every Cursor that
		// touches it. So a new file would be read as standing inside an
		// implementation block that is not there, and offered the Statements of
		// one instead of the sections it is about to be given. Nothing is
		// written inside a span nothing is written in.
		if (isEmptySpan(candidate.position)) {
			continue
		}

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

				// NOTE: An `overload` group holds signatures and nothing else,
				// so every snippet the Namespace around it offers writes a
				// Parser Diagnostic there. It carries no body to walk into —
				// each entry is a Function literal the walk reaches on its own
				// — and what it contributes is the refusal.
				for (let member of Object.values(node.methods)) {
					if (
						member.nodeType === "OverloadedMethod" ||
						member.nodeType === "OverloadedStaticMethod" ||
						member.nodeType === "OverloadedMethodSignatures" ||
						member.nodeType === "OverloadedStaticMethodSignatures"
					) {
						blocks.push({
							position: member.position,
							context: "overload",
						})
					}
				}

				// NOTE: And the bodies `@` means something in — an INSTANCE
				// Method's, never a static one's, where `@` is refused outright.
				for (let body of instanceBodies(node)) {
					blocks.push({
						position: body.position,
						context: base,
						method: true,
					})
				}

				return
			case "ProtocolDeclarationStatement":
				blocks.push({ position: node.position, context: "protocol" })

				for (let member of Object.values(node.methods)) {
					if (
						member.nodeType === "OverloadedProtocolMethod" ||
						member.nodeType === "OverloadedStaticProtocolMethod"
					) {
						blocks.push({
							position: member.position,
							context: "overload",
						})
					}
				}

				// NOTE: `walk` reaches a provided Method's body on its own; what
				// is said here is whether `@` names the receiver in it.
				for (let body of providedBodies(node)) {
					blocks.push({
						position: body.body.position,
						context: base,
						method: body.instance,
					})
				}

				return
			// NOTE: A Choice's body is a list of Cases and nothing else, so
			// every Statement the section around it offers is a Diagnostic
			// there. Like the `overload` group above, it earns its place by
			// what it refuses.
			case "ChoiceDeclarationStatement":
				blocks.push({ position: node.position, context: "choice" })
				return
			case "Match":
				blocks.push({ position: node.position, context: "match" })

				// NOTE: A Handler carries no Position of its own, so its body
				// is spanned by the Statements written in it — and an EMPTY one
				// spans nothing, which used to leave a reader who had just
				// opened a Handler and pressed Enter being offered the `case`
				// that goes outside it. So an empty body is spanned from the
				// end of its Matcher to the start of whatever comes next: the
				// Handler below it, or the Match's own closing brace.
				for (let [index, handler] of node.handlers.entries()) {
					let body =
						spanOf(handler.body) ?? emptyBody(node, handler, index)

					blocks.push({ position: body, context: base })
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
			// `step` — opens a Statement body of its own. Its Parameter list is
			// neither a Statement nor a value: what may be written between
			// those brackets is a name, a Type and a default, and every value
			// snippet offered there writes a Parser Diagnostic.
			case "FunctionValue":
				blocks.push({ position: node.position, context: base })
				blocks.push(...parameterBlocks(node.value))

				return
			case "FunctionStatement":
				blocks.push(...parameterBlocks(node.value))

				return
			default:
				return
		}
	}

	walk(program, collect)

	return blocks
}

// NOTE: The Parameter list, and the DEFAULTS written inside it — a default is
// a value like any other, and the one thing between those brackets that a
// value snippet belongs in. Each default is a smaller span than the list around
// it, so the innermost rule hands it back.
function parameterBlocks(
	definition: parser.FunctionDefinitionNode,
): Array<Block> {
	let blocks: Array<Block> = [
		{
			position: definition.parameterListPosition,
			context: "parameters",
		},
	]

	for (let parameter of definition.parameters) {
		if (parameter.defaultValue !== null) {
			blocks.push({
				position: parameter.defaultValue.position,
				context: "expression",
			})
		}
	}

	return blocks
}

function isEmptySpan(position: common.Position): boolean {
	return (
		position.start.line === position.end.line &&
		position.start.column === position.end.column
	)
}

function providedBodies(
	node: parser.ProtocolDeclarationStatementNode,
): Array<{ body: parser.FunctionValueNode; instance: boolean }> {
	let bodies: Array<{ body: parser.FunctionValueNode; instance: boolean }> =
		[]

	for (let member of Object.values(node.methods)) {
		let instance =
			member.nodeType === "SimpleProtocolMethod" ||
			member.nodeType === "OverloadedProtocolMethod"
		let signatures =
			member.nodeType === "OverloadedProtocolMethod" ||
			member.nodeType === "OverloadedStaticProtocolMethod"
				? member.signatures
				: [member.signature]

		for (let signature of signatures) {
			if (signature.body !== null) {
				bodies.push({ body: signature.body, instance })
			}
		}
	}

	return bodies
}

// NOTE: The Function literals of a Namespace's INSTANCE Methods — the bodies
// `@` names the receiver in. A static Method's body is not one of them: `@`
// there is `at-in-static-method`.
function instanceBodies(
	node: parser.NamespaceDefinitionStatementNode,
): Array<parser.FunctionValueNode> {
	let bodies: Array<parser.FunctionValueNode> = []

	for (let member of Object.values(node.methods)) {
		if (member.nodeType === "SimpleMethod") {
			bodies.push(member.method)
		} else if (member.nodeType === "OverloadedMethod") {
			bodies.push(...member.methods)
		} else if (member.nodeType === "OverloadedMethodSignatures") {
			for (let method of member.methods) {
				if (method.nodeType === "FunctionValue") {
					bodies.push(method)
				}
			}
		}
	}

	return bodies
}

// NOTE: Where a Handler that wrote no Statement stands — from the end of what
// it matches on to the start of the Handler below it, or to the Match's own
// closing brace where it is the last. A Position runs one past what it ends
// on, so the Match's end is one past the brace and the brace itself is where
// the last Handler stops.
function emptyBody(
	node: parser.MatchNode,
	handler: parser.MatchNode["handlers"][number],
	index: number,
): common.Position {
	let next = node.handlers[index + 1]
	let start = (handler.guard ?? handler.matcher).position.end

	return {
		start,
		end:
			next === undefined
				? {
						line: node.position.end.line,
						column: node.position.end.column - 1,
					}
				: next.matcher.position.start,
	}
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
