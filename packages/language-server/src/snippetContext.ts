import type { common, parser } from "@essence-lang/interfaces"

import { walk } from "./codeActions/lookups"
import { contains, isSmaller } from "./positions"
import { programSections } from "./sections"
import type { ModuleSection, SnippetContext } from "./snippets"

// Which block a cursor stands in, which decides which snippets parse there.
// See "Where a snippet is offered" in DEVELOPMENT.md.
type Block = {
	position: common.Position
	context: SnippetContext
	// Whether a containing block is an instance Method's body, where
	// `{ @ with … }` means something. Read from every containing block, so a
	// Function literal inside a Method keeps it.
	method?: boolean
}

// `atStatementStart` is `keywordCompletions`'s text reading, which tells a
// fresh line in a `match` from the value after `case X { <- `.
export function snippetContextAt(
	program: parser.Program | null,
	cursor: common.Cursor,
	atStatementStart: boolean,
): SnippetContext {
	// A document that does not parse still has a cursor. The text reading offers
	// the ordinary Statement snippets, but none needing a Namespace or a test.
	if (program === null) {
		return atStatementStart ? "implementation" : "expression"
	}

	// The Module sections first and alone: they hold no Expression or Statement.
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

	// A Parameter list answers for both readings, since the text reading would
	// call it a value position.
	if (block.context === "parameters") {
		return "parameters"
	}

	// A value position is the same in every block, except a Method's own body,
	// where `@` names the receiver; `method` offers everything `expression` does.
	if (atStatementStart) {
		return block.context
	}

	return block.method ? "method" : "expression"
}

// The sections the file writes. A section snippet is offered only where its
// section is missing. A recovered empty section has a Position but nothing in
// it, so only a span with something written in it counts.
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

		// Ties keep the outer block, which the walk finds first.
		if (innermost !== null && !isSmaller(block.position, innermost)) {
			continue
		}

		innermost = block.position
		context = block.context
	}

	return { context, method }
}

// The section the cursor stands in. `programSections` is outermost first, so
// the last match is the innermost, which settles a file of only tests.
function sectionAt(
	program: parser.Program,
	cursor: common.Cursor,
): SnippetContext {
	let section: SnippetContext = "top"

	for (let candidate of programSections(program)) {
		// A recovered empty file's implementation spans `1:1` to `1:1`, which holds
		// every Cursor touching it. Only a span with something written in it counts.
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

// Every block a Statement or value may stand in, besides the sections. A
// block carrying `base` re-opens a section's Statement body, such as a Method
// body in a Namespace.
function blocksOf(program: parser.Program, base: SnippetContext): Array<Block> {
	let blocks: Array<Block> = []

	let collect = (node: parser.ImplementationNode) => {
		switch (node.nodeType) {
			case "NamespaceDefinitionStatement":
				blocks.push({ position: node.position, context: "namespace" })

				// An `overload` group holds signatures only, so it refuses every
				// snippet. Its entries with bodies are Function literals the walk
				// reaches.
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

				for (let signature of nativeSignatures(
					Object.values(node.methods),
				)) {
					blocks.push(
						...parameterBlocks(
							signature.position,
							signature.parameters,
						),
					)
				}

				// The bodies `@` names the receiver in: an instance Method's, not a static
				// one's.
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

				for (let { signature, instance } of protocolSignatures(node)) {
					// A requirement is a signature without a body, read as a
					// native one is.
					if (signature.body === null) {
						blocks.push(
							...parameterBlocks(
								signature.position,
								signature.parameters,
							),
						)
					} else {
						// `walk` reaches a provided Method's body; this says `@`
						// names the receiver in it.
						blocks.push({
							position: signature.body.position,
							context: base,
							method: instance,
						})
					}
				}

				return
			// A Choice's body is a list of Cases, so it refuses every snippet.
			case "ChoiceDeclarationStatement":
				blocks.push({ position: node.position, context: "choice" })
				return
			case "Match":
				blocks.push({ position: node.position, context: "match" })

				// A Handler has no Position, so its body is spanned by its
				// Statements. An empty body spans from the end of its Matcher to
				// the next Handler or the Match's closing brace.
				for (let [index, handler] of node.handlers.entries()) {
					let body =
						spanOf(handler.body) ?? emptyBody(node, handler, index)

					blocks.push({ position: body, context: base })
				}

				return
			case "Define":
				blocks.push({ position: node.position, context: "define" })

				// An arm is one Expression from `as` to the end of its Condition;
				// both halves are values.
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
			// Every Function literal opens a Statement body. Its Parameter list holds
			// names, Types and defaults, where no value snippet parses.
			case "FunctionValue":
				blocks.push({ position: node.position, context: base })
				blocks.push(
					...parameterBlocks(
						node.value.parameterListPosition,
						node.value.parameters,
					),
				)

				return
			case "FunctionStatement":
				blocks.push(
					...parameterBlocks(
						node.value.parameterListPosition,
						node.value.parameters,
					),
				)

				return
			case "OverloadedFunctionStatement":
				for (let signature of nativeSignatures(node.methods)) {
					blocks.push(
						...parameterBlocks(
							signature.position,
							signature.parameters,
						),
					)
				}

				return
			default:
				return
		}
	}

	walk(program, collect)

	return blocks
}

// The Parameter list, and the defaults in it, which are values. Each default
// is a smaller span, so the innermost rule finds it.
function parameterBlocks(
	position: common.Position,
	parameters: Array<parser.ParameterNode>,
): Array<Block> {
	let blocks: Array<Block> = [{ position, context: "parameters" }]

	for (let parameter of parameters) {
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

// Every signature a Protocol writes, and whether it is an instance Method's.
function protocolSignatures(
	node: parser.ProtocolDeclarationStatementNode,
): Array<{ signature: parser.ProtocolMethodSignatureNode; instance: boolean }> {
	return Object.values(node.methods).flatMap((member) => {
		let instance =
			member.nodeType === "SimpleProtocolMethod" ||
			member.nodeType === "OverloadedProtocolMethod"
		let signatures =
			member.nodeType === "OverloadedProtocolMethod" ||
			member.nodeType === "OverloadedStaticProtocolMethod"
				? member.signatures
				: [member.signature]

		return signatures.map((signature) => ({ signature, instance }))
	})
}

// The native signatures among a declarations file's members. A native
// signature has no body, so the walk reaches no Function literal in it. Its
// span starts at its `(`, after any Type Parameters, and ends with its return
// Type. All of it reads as a Parameter list.
function nativeSignatures(
	members: Array<
		| parser.NamespaceMethods[string]
		| parser.FunctionValueNode
		| parser.NativeMethodSignatureNode
	>,
): Array<parser.NativeMethodSignatureNode> {
	return members.flatMap((member) => {
		switch (member.nodeType) {
			case "NativeMethodSignature":
				return [member]
			case "SimpleMethodSignature":
			case "StaticMethodSignature":
				return [member.signature]
			case "OverloadedMethodSignatures":
			case "OverloadedStaticMethodSignatures":
				return nativeSignatures(member.methods)
			default:
				return []
		}
	})
}

// The Function literals of a Namespace's instance Methods, where `@` names the
// receiver. A static Method's `@` is `at-in-static-method`.
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

// Where a Handler without Statements stands: from the end of its Matcher to
// the next Handler, or to the Match's closing brace. A Position ends one past
// its last character.
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
