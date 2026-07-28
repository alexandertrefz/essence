import type { common, parser } from "@essence-lang/interfaces"

import {
	concat,
	type Doc,
	group,
	hardline,
	ifBreak,
	indent,
	join,
	line,
	renderFlat,
	softline,
	stringWidth,
	text,
	type TextDoc,
} from "./doc"
import { compareExportEntries, compareImportEntries } from "./sections"
import type { SourceText } from "./source"
import type { Comment, TriviaCursor } from "./trivia"

// NOTE: One thing to write, paired with where it was written. The line numbers
// are the source's, never the output's — they are read only to decide whether
// the author left a blank line between two things, which is the one piece of
// vertical layout the formatter preserves rather than derives.
type Entry = {
	startLine: number
	endLine: number
	doc: Doc
}

const EMPTY = text("")

// NOTE: The most padding an aligned assignment is worth carrying to reach its
// block's `=` column. A run of assignments is split into blocks whose heads
// span no more than this, so a head that would need more padding than this to
// line up starts a new block rather than dragging every sibling's `=` right to
// meet it — a group of short Declarations above the wide typed ones is the usual
// case, and each lines up on its own.
const MAX_ALIGNMENT_PADDING = 12

function positionLines(position: common.Position): {
	startLine: number
	endLine: number
} {
	return { startLine: position.start.line, endLine: position.end.line }
}

export class Printer {
	private source: SourceText
	private trivia: TriviaCursor

	constructor(source: SourceText, trivia: TriviaCursor) {
		this.source = source
		this.trivia = trivia
	}

	// #region Layout

	private commentEntry(comment: Comment): Entry {
		return {
			startLine: comment.startLine,
			endLine: comment.endLine,
			doc: text(comment.text),
		}
	}

	// NOTE: Lays entries out one per line, keeping a single blank line wherever
	// the author left one or more. `openLine` seeds the check so that the blank
	// line the corpus writes after `implementation {` survives.
	//
	// Whether a blank line was written is asked of the source text rather than
	// worked out from the difference between two line numbers. A Declaration's
	// Position starts at its first keyword, which can sit several lines above
	// the `{` its body opens at once a Parameter list or a conformance clause
	// breaks — and arithmetic on those numbers reads that header as a gap and
	// invents a blank line, differently on each pass.
	private layout(entries: Array<Entry>, openLine: number): Doc {
		let parts: Array<Doc> = []
		let previousEnd = openLine

		for (let entry of entries) {
			if (parts.length > 0) {
				parts.push(hardline)
			}

			if (this.source.hasBlankLineBetween(previousEnd, entry.startLine)) {
				parts.push(hardline)
			}

			parts.push(entry.doc)
			previousEnd = entry.endLine
		}

		return concat(parts)
	}

	// NOTE: Gathers the Comments written above each item into the entry list
	// alongside it, and folds a trailing Comment onto the item's own line. Any
	// Comment nobody claimed is flushed before the closing brace, so a Comment
	// can be moved but never dropped.
	private entriesFor<Item>(
		items: Array<Item>,
		linesOf: (item: Item) => { startLine: number; endLine: number },
		print: (item: Item) => Doc,
	): Array<Entry> {
		let entries: Array<Entry> = []

		for (let item of items) {
			let { startLine, endLine } = linesOf(item)

			for (let comment of this.trivia.takeBefore(startLine)) {
				entries.push(this.commentEntry(comment))
			}

			let trailing = this.trivia.claimTrailingOn(endLine)
			let doc = print(item)

			if (trailing !== null) {
				doc = concat([doc, text(" " + trailing.text)])
			}

			entries.push({ startLine, endLine, doc })
		}

		return entries
	}

	// NOTE: The Statements of one block, with the `=` of a run of adjacent
	// assignments written in one column — the same alignment a `match` gives its
	// Handlers' braces, and built the same way: each Statement is laid out in
	// source order, because that is the order the trivia cursor is walked in,
	// and the padding is written into a Doc node kept aside for it once the
	// widths of a whole run are known.
	//
	// A run ends wherever the column would stop meaning anything: at a Statement
	// that is not an assignment; at a blank line, which is how the author says
	// that two groups of Declarations are not one; between a Declaration and a
	// bare reassignment; and at a value that lays itself out over several lines,
	// for the same reason a guarded `case` is left out of its run. A Comment
	// does not end a run — it is written between two Statements the author kept
	// together, and the run is what they wrote.
	private implementationEntries(
		nodes: Array<parser.ImplementationNode>,
	): Array<Entry> {
		let run: Array<AlignedAssignment> = []
		let kind: AssignmentKind | null = null
		let previousEnd: number | null = null

		// NOTE: The run is broken into blocks that each line up on their own `=`
		// rather than forced to one column, so a long typed Declaration among
		// short ones does not drag every sibling's `=` across the line to meet it.
		// A block is a maximal stretch of adjacent assignments whose heads span no
		// more than `MAX_ALIGNMENT_PADDING` — the widest minus the narrowest — so
		// no member is ever padded further than that to reach its block's column.
		// A block ends where the next head would widen that span past the budget,
		// which is what splits a group of short Declarations from the wide typed
		// ones written below them into their own lined-up blocks. A block of one
		// is left unpadded.
		//
		// The span is measured widest-minus-narrowest rather than against the
		// neighbour above, which would let a slow ramp of widths pad the first
		// member of a block far past the budget. The walk is in source order and
		// greedy rather than optimal — the corpus writes similar widths together,
		// and a greedy left-to-right pass is stable under a second run, which an
		// optimal partition need not be.
		let closeRun = () => {
			let start = 0
			let narrowest = 0
			let widest = 0

			let flushBlock = (end: number) => {
				if (end - start > 1) {
					for (let index = start; index < end; index++) {
						let assignment = run[index] as AlignedAssignment

						assignment.padding.value = " ".repeat(
							widest - assignment.headWidth,
						)
					}
				}

				start = end
			}

			for (let index = 0; index < run.length; index++) {
				let width = (run[index] as AlignedAssignment).headWidth

				if (
					index > start &&
					Math.max(widest, width) - Math.min(narrowest, width) >
						MAX_ALIGNMENT_PADDING
				) {
					flushBlock(index)
				}

				if (index === start) {
					narrowest = width
					widest = width
				} else {
					narrowest = Math.min(narrowest, width)
					widest = Math.max(widest, width)
				}
			}

			flushBlock(run.length)

			run = []
			kind = null
		}

		let entries = this.entriesFor(
			nodes,
			(node) => positionLines(node.position),
			(node) => {
				let separated =
					previousEnd !== null &&
					this.source.hasBlankLineBetween(
						previousEnd,
						node.position.start.line,
					)

				previousEnd = node.position.end.line

				let assignment = assignmentOf(node)

				if (assignment === null) {
					closeRun()

					return this.printImplementationNode(node)
				}

				if (separated || assignmentKind(assignment) !== kind) {
					closeRun()
				}

				let padding = text("")
				let printed = this.printAssignment(assignment, padding)

				if (printed.headWidth === null || !printed.flat) {
					closeRun()

					return printed.doc
				}

				kind = assignmentKind(assignment)
				run.push({ headWidth: printed.headWidth, padding })

				return printed.doc
			},
		)

		closeRun()

		return entries
	}

	private flushBefore(line: number, entries: Array<Entry>) {
		for (let comment of this.trivia.takeBefore(line)) {
			entries.push(this.commentEntry(comment))
		}
	}

	// NOTE: A braced block breaks, with one exception: a `match` Handler
	// holding a single short Statement is written on one line throughout the
	// corpus — `case Nothing { <- fallback }` — and expanding all of those to
	// three lines each would triple the size of every `match`. `allowFlat`
	// offers that shape to the group, which takes it only if it fits.
	// NOTE: `opening` is the Comment written after the `{` itself — `reduce(…,
	// (sum, n) {  § 11`. It belongs to no Statement inside the block and to no
	// Statement outside it, so unless the block writes it, nothing does. It
	// also runs to the end of its line, which is what rules the flat shape out.
	// NOTE: `prefix` is written before the `{` but lives INSIDE the group, so
	// an `ifBreak` in it answers to this block's own decision. That is what
	// lets a `match` Handler's alignment padding disappear the moment the
	// Handler stops fitting on one line.
	private block(
		entries: Array<Entry>,
		openLine: number,
		closeLine: number,
		allowFlat = false,
		opening: Comment | null = null,
		prefix: Doc = EMPTY,
	): Doc {
		let brace = opening === null ? text("{") : text("{ " + opening.text)

		if (entries.length === 0) {
			return opening === null
				? concat([prefix, text("{}")])
				: concat([prefix, brace, hardline, text("}")])
		}

		if (allowFlat && opening === null && entries.length === 1) {
			return group(
				concat([
					prefix,
					text("{"),
					indent(concat([line, (entries[0] as Entry).doc])),
					line,
					text("}"),
				]),
			)
		}

		return concat([
			prefix,
			brace,
			indent(concat([hardline, this.layout(entries, openLine)])),
			hardline,
			text("}"),
		])
	}

	// NOTE: `closeLine` is where the body's own `}` is, which is NOT the end of
	// the Statement that owns it — an `if … else` Position runs past the true
	// body's brace to the end of the false one, and flushing Comments against
	// that would pull the `else` block's Comments into the `if`.
	private bodyBlock(
		body: Array<parser.ImplementationNode>,
		openLine: number,
		closeLine: number,
		allowFlat = false,
		prefix: Doc = EMPTY,
	): Doc {
		let opening = this.trivia.claimTrailingOn(openLine)

		let entries = this.implementationEntries(body)

		this.flushBefore(closeLine, entries)

		// NOTE: A Comment claimed inside the body means there are more entries
		// than Statements, and a Comment can never share a line with what
		// follows it — so the flat shape is off the table.
		return this.block(
			entries,
			openLine,
			closeLine,
			allowFlat && entries.length === body.length,
			opening,
			prefix,
		)
	}

	// #endregion

	// #region Program

	// NOTE: The whole file, in the order it is written: the `import { … }` block,
	// the implementation, the `export { … }` block. The trivia cursor walks the
	// source, so every Comment has to be claimed in that same order — which is
	// why each section is printed where it stands rather than assembled at the
	// end.
	printProgram(program: parser.Program): Doc {
		let keyword =
			program.kind === "declarations" ? "declarations" : "implementation"

		let parts: Array<Doc> = []

		if (program.imports !== null) {
			parts.push(
				concat(this.headingComments(program.imports.position)),
				this.printModuleSection(
					"import",
					program.imports.position,
					program.imports.entries,
					compareImportEntries,
				),
				hardline,
			)

			if (
				this.source.hasBlankLineBetween(
					program.imports.position.end.line,
					program.position.start.line,
				)
			) {
				parts.push(hardline)
			}
		}

		// NOTE: A file may open with Comments above its `implementation {` —
		// they are outside the Program's own Position, so they have to be
		// written before the keyword rather than flushed into the block.
		let heading = this.headingComments(program.position)
		let opening = this.trivia.claimTrailingOn(program.position.start.line)

		let entries = this.implementationEntries(program.implementation.nodes)

		this.flushBefore(program.position.end.line, entries)

		// NOTE: Whatever is left has nowhere else to go — a Comment below the
		// last Statement, or one the AST simply has no node near. With an
		// `export { … }` block below, the block is still to be printed, so the
		// leftovers are gathered after it instead.
		if (program.exports === null) {
			for (let comment of this.trivia.takeRemaining()) {
				entries.push(this.commentEntry(comment))
			}
		}

		parts.push(
			concat(heading),
			text(keyword + " "),
			this.block(
				entries,
				program.position.start.line,
				program.position.end.line,
				false,
				opening,
			),
		)

		if (program.exports !== null) {
			parts.push(hardline)

			if (
				this.source.hasBlankLineBetween(
					program.position.end.line,
					program.exports.position.start.line,
				)
			) {
				parts.push(hardline)
			}

			parts.push(
				concat(this.headingComments(program.exports.position)),
				this.printModuleSection(
					"export",
					program.exports.position,
					program.exports.entries,
					compareExportEntries,
				),
			)

			let previousEnd = program.exports.position.end.line

			for (let comment of this.trivia.takeRemaining()) {
				parts.push(hardline)

				if (
					this.source.hasBlankLineBetween(
						previousEnd,
						comment.startLine,
					)
				) {
					parts.push(hardline)
				}

				parts.push(text(comment.text))
				previousEnd = comment.endLine
			}
		}

		parts.push(hardline)

		return concat(parts)
	}

	// NOTE: The Comments written above a block's own keyword. They sit outside
	// the block's Position, so they are written before it rather than flushed
	// into it, and a blank line the author left between a Comment and the keyword
	// it introduces is kept.
	private headingComments(position: common.Position): Array<Doc> {
		let line = position.start.line
		let parts: Array<Doc> = []

		for (let comment of this.trivia.takeBefore(line)) {
			parts.push(text(comment.text), hardline)

			if (this.source.hasBlankLineBetween(comment.endLine, line)) {
				parts.push(hardline)
			}
		}

		return parts
	}

	// NOTE: One Module section, written in canonical order with every `from` in
	// one column. The entries are read in WRITTEN order — that is the order the
	// trivia cursor hands Comments out in — and only sorted afterwards, so a
	// Comment travels with the entry it was written against.
	//
	// Alignment is one space past the widest left-hand side among the entries
	// that carry a `from`, and no other entry counts: an `export { … }` block
	// lists what a Module declares alongside what it forwards, and padding a
	// re-export out to the widest local name would push its `from` halfway across
	// the line rather than line anything up.
	private printModuleSection<
		Node extends parser.ImportNode | parser.ExportNode,
	>(
		keyword: string,
		position: common.Position,
		nodes: Array<Node>,
		compare: (left: Node, right: Node) => number,
	): Doc {
		let opening = this.trivia.claimTrailingOn(position.start.line)

		let entries = nodes.map((node): SectionEntry<Node> => {
			let leading = this.trivia.takeBefore(node.position.start.line)
			let trailing = this.trivia.claimTrailingOn(node.position.end.line)

			return { node, leading, trailing, head: entryHead(node) }
		})

		let loose = this.trivia.takeBefore(position.end.line)

		entries.sort((left, right) => compare(left.node, right.node))

		let widest = 0

		for (let entry of entries) {
			if (entry.node.source !== null) {
				widest = Math.max(widest, entry.head.length)
			}
		}

		let lines: Array<Doc> = []

		for (let entry of entries) {
			for (let comment of entry.leading) {
				lines.push(text(comment.text))
			}

			let written = entry.head

			// NOTE: The specifier is written back from the source rather than
			// from the node, for the same reason every String Literal is — the
			// Lexer strips the quotes and leaves the escapes unprocessed.
			if (entry.node.source !== null) {
				written +=
					" ".repeat(widest - entry.head.length) +
					" from " +
					this.source.slice(entry.node.source.position)
			}

			if (entry.trailing !== null) {
				written += " " + entry.trailing.text
			}

			lines.push(text(written))
		}

		// NOTE: A Comment written below the last entry belongs to no entry, so
		// nothing carries it — it is written where it stands, above the block's
		// closing brace.
		for (let comment of loose) {
			lines.push(text(comment.text))
		}

		// NOTE: Every line is laid out as if it were on line 0, which leaves
		// `layout` no blank line to find between any two of them. A Module section
		// is one sorted list: which two entries a gap the author left would end up
		// between is decided by the sort rather than by anything the author said.
		return concat([
			text(keyword + " "),
			this.block(
				lines.map((doc): Entry => ({ startLine: 0, endLine: 0, doc })),
				0,
				0,
				false,
				opening,
			),
		])
	}

	// #endregion

	// #region Statements

	printImplementationNode(node: parser.ImplementationNode): Doc {
		switch (node.nodeType) {
			case "ConstantDeclarationStatement":
			case "VariableDeclarationStatement":
			case "VariableAssignmentStatement":
				return this.printAssignment(node, EMPTY).doc

			case "ReturnStatement":
				return concat([
					text("<- "),
					this.printExpression(node.expression),
				])

			case "IfStatement":
				return concat([
					text("if "),
					this.printExpression(node.condition),
					text(" "),
					this.bodyBlock(
						node.body,
						node.position.start.line,
						node.position.end.line,
					),
				])

			case "IfElseStatement":
				return this.printIfElse(node)

			case "TypeAliasStatement":
				return concat([
					text("type " + node.name.content),
					this.printGenericList(node.generics),
					text(" = "),
					this.printType(node.type),
				])

			case "ChoiceDeclarationStatement":
				return this.printChoice(node)

			case "NamespaceDefinitionStatement":
				return this.printNamespace(node)

			case "ProtocolDeclarationStatement":
				return this.printProtocol(node)

			case "FunctionStatement":
				return concat([
					text("function " + node.name.content),
					this.printFunctionDefinition(node.value, node.position),
				])

			case "NativeFunctionStatement":
				return concat([
					text("function " + node.name.content),
					this.printSignature(node.signature),
				])

			case "OverloadedFunctionStatement":
				return concat([
					text("overload function " + node.name.content + " "),
					this.printOverloadEntries(node.methods, node.position),
				])

			default:
				return this.printExpression(node)
		}
	}

	// NOTE: `padding` is written between the head and the `=`, and is the slot an
	// alignment run fills in once it knows its block's widest member — so the
	// head's width is reported back alongside the Doc. It is null when the head
	// cannot be written on one line at all, which leaves nothing to measure a
	// column against; `flat` says the same of the value, which is what keeps a
	// `match` or a Function literal from dragging its neighbours out of true.
	private printAssignment(
		node: AssignmentNode,
		padding: Doc,
	): { doc: Doc; headWidth: number | null; flat: boolean } {
		let head: Array<Doc> = []

		if (node.nodeType === "VariableAssignmentStatement") {
			head.push(text(node.name.content))
		} else {
			let keyword =
				node.nodeType === "ConstantDeclarationStatement"
					? "constant"
					: "variable"

			head.push(text(keyword + " " + node.name.content))

			if (node.type !== null) {
				head.push(text(": "), this.printType(node.type))
			}
		}

		let written = renderFlat(concat(head))
		let value = this.printExpression(node.value)

		// NOTE: The `=` never breaks away from what it assigns. A value starts on
		// the line its name is written on and gives way inside itself — an
		// Argument list at its commas, a String at one of its holes — which
		// keeps the first thing a reader looks for, the beginning of the value,
		// where the name that introduced it is. Moving the whole value down
		// buys one indent's worth of room and costs that.
		return {
			doc: concat([...head, padding, text(" = "), value]),
			headWidth: written === null ? null : stringWidth(written),
			flat: renderFlat(value) !== null,
		}
	}

	// NOTE: `else if` is one written form, not a block holding an `if`. The
	// parser gives back a false body of exactly one `if`, and rebuilding it as
	// a nested block would indent every arm of a guard cascade one level
	// deeper than it was written.
	private printIfElse(node: parser.IfElseStatementNode): Doc {
		let first = node.falseBody[0]
		let lastTrue = node.trueBody[node.trueBody.length - 1]

		// NOTE: The `} else {` line, found in the source. Everything above it
		// belongs to the true body and everything below it to the false one —
		// including Comments, which is the whole reason this has to be exact.
		let trueClose =
			first === undefined
				? node.position.end.line
				: (this.source.closingBraceLine(
						(lastTrue?.position.end.line ??
							node.position.start.line) + 1,
						first.position.start.line,
					) ?? first.position.start.line - 1)

		let parts: Array<Doc> = [
			text("if "),
			this.printExpression(node.condition),
			text(" "),
			this.bodyBlock(node.trueBody, node.position.start.line, trueClose),
			text(" else "),
		]

		let only = node.falseBody.length === 1 ? node.falseBody[0] : undefined

		if (
			only !== undefined &&
			(only.nodeType === "IfStatement" ||
				only.nodeType === "IfElseStatement")
		) {
			this.trivia.takeBefore(only.position.start.line)
			parts.push(this.printImplementationNode(only))

			return concat(parts)
		}

		parts.push(
			this.bodyBlock(node.falseBody, trueClose, node.position.end.line),
		)

		return concat(parts)
	}

	private printChoice(node: parser.ChoiceDeclarationStatementNode): Doc {
		let opening = this.trivia.claimTrailingOn(node.position.start.line)

		let entries = this.entriesFor(
			node.cases,
			(choiceCase) => positionLines(choiceCase.name.position),
			(choiceCase) => {
				let parts: Array<Doc> = [text(choiceCase.name.content)]

				if (choiceCase.type !== null) {
					parts.push(text(" "), this.printRecordType(choiceCase.type))
				}

				parts.push(text(","))

				return concat(parts)
			},
		)

		this.flushBefore(node.position.end.line, entries)

		return concat([
			text("choice " + node.name.content),
			this.printGenericList(node.generics),
			text(" "),
			this.block(
				entries,
				node.position.start.line,
				node.position.end.line,
				false,
				opening,
			),
		])
	}

	// #endregion

	// #region Namespaces and Protocols

	private printNamespace(node: parser.NamespaceDefinitionStatementNode): Doc {
		let head: Array<Doc> = [
			text("namespace " + node.name.content),
			this.printGenericList(node.generics),
		]

		if (node.targetType !== null) {
			head.push(text(" for "), this.printType(node.targetType))
		}

		let headDoc =
			node.conformsTo.length > 0
				? group(
						concat([
							concat(head),
							indent(
								concat([
									line,
									join(
										concat([text(","), line]),
										node.conformsTo.map((clause) =>
											this.printConformanceClause(clause),
										),
									),
								]),
							),
						]),
					)
				: concat(head)

		// NOTE: One written body reaches the AST as two Records — Properties
		// and Methods — so the order they were written in only survives in
		// their names' Positions. Re-merging on those is what keeps a `static`
		// declared between two Methods where the author put it.
		let members: Array<NamespaceMember> = [
			...Object.values(node.properties).map(
				(property): NamespaceMember => ({
					kind: "property",
					property,
				}),
			),
			...Object.values(node.methods).map(
				(method): NamespaceMember => ({ kind: "method", method }),
			),
		]

		members.sort(
			(left, right) =>
				memberName(left).position.start.line -
				memberName(right).position.start.line,
		)

		let opening = this.trivia.claimTrailingOn(
			this.source.closingBraceLine(
				node.position.start.line,
				node.position.end.line,
			) ?? node.position.start.line,
		)

		let entries = this.entriesFor(
			members,
			(member) => ({
				startLine: memberName(member).position.start.line,
				endLine: this.namespaceMemberEndLine(member),
			}),
			(member) => this.printNamespaceMember(member),
		)

		this.flushBefore(node.position.end.line, entries)

		return concat([
			headDoc,
			text(" "),
			this.block(
				entries,
				node.position.start.line,
				node.position.end.line,
				false,
				opening,
			),
		])
	}

	private printConformanceClause(node: parser.ConformanceClauseNode): Doc {
		let parts: Array<Doc> = [text("is " + node.protocol.content)]

		if (node.conditions.length > 0) {
			parts.push(
				text(" where "),
				join(
					text(", "),
					node.conditions.map((condition) =>
						text(
							condition.generic.content +
								" is " +
								condition.protocol.content,
						),
					),
				),
			)
		}

		return concat(parts)
	}

	private namespaceMemberEndLine(member: NamespaceMember): number {
		if (member.kind === "property") {
			let property = member.property

			return (
				property.value?.position.end.line ??
				property.type?.position.end.line ??
				property.name.position.end.line
			)
		}

		let method = member.method

		switch (method.nodeType) {
			case "SimpleMethod":
			case "StaticMethod":
				return method.method.position.end.line

			case "SimpleMethodSignature":
			case "StaticMethodSignature":
				return method.signature.position.end.line

			default: {
				let entries = method.methods
				let last = entries[entries.length - 1]

				return last === undefined
					? method.name.position.end.line
					: last.position.end.line
			}
		}
	}

	private printNamespaceMember(member: NamespaceMember): Doc {
		if (member.kind === "property") {
			let property = member.property
			let parts: Array<Doc> = [text("static " + property.name.content)]

			if (property.type !== null) {
				parts.push(text(": "), this.printType(property.type))
			}

			if (property.value !== null) {
				parts.push(text(" = "), this.printExpression(property.value))
			}

			return concat(parts)
		}

		let method = member.method

		switch (method.nodeType) {
			case "SimpleMethod":
				return concat([
					text(method.name.content),
					this.printFunctionDefinition(
						method.method.value,
						method.method.position,
					),
				])

			case "StaticMethod":
				return concat([
					text("static " + method.name.content),
					this.printFunctionDefinition(
						method.method.value,
						method.method.position,
					),
				])

			case "SimpleMethodSignature":
				return concat([
					text(method.name.content),
					this.printSignature(method.signature),
				])

			case "StaticMethodSignature":
				return concat([
					text("static " + method.name.content),
					this.printSignature(method.signature),
				])

			case "OverloadedMethod":
			case "OverloadedMethodSignatures":
				return concat([
					text("overload " + method.name.content + " "),
					this.printOverloadEntries(
						method.methods,
						overloadPosition(method.methods, method.name.position),
					),
				])

			case "OverloadedStaticMethod":
			case "OverloadedStaticMethodSignatures":
				return concat([
					text("overload static " + method.name.content + " "),
					this.printOverloadEntries(
						method.methods,
						overloadPosition(method.methods, method.name.position),
					),
				])
		}
	}

	private printProtocol(node: parser.ProtocolDeclarationStatementNode): Doc {
		let methods = Object.values(node.methods)

		methods.sort(
			(left, right) =>
				left.name.position.start.line - right.name.position.start.line,
		)

		let opening = this.trivia.claimTrailingOn(node.position.start.line)

		let entries = this.entriesFor(
			methods,
			(method) => ({
				startLine: method.name.position.start.line,
				endLine: protocolMethodEndLine(method),
			}),
			(method) => this.printProtocolMethod(method),
		)

		this.flushBefore(node.position.end.line, entries)

		return concat([
			text("protocol " + node.name.content + " "),
			this.block(
				entries,
				node.position.start.line,
				node.position.end.line,
				false,
				opening,
			),
		])
	}

	private printProtocolMethod(method: parser.ProtocolMethods[string]): Doc {
		switch (method.nodeType) {
			case "SimpleProtocolMethod":
				return concat([
					text(method.name.content),
					this.printProtocolSignature(method.signature),
				])

			case "StaticProtocolMethod":
				return concat([
					text("static " + method.name.content),
					this.printProtocolSignature(method.signature),
				])

			case "OverloadedProtocolMethod":
			case "OverloadedStaticProtocolMethod": {
				let keyword =
					method.nodeType === "OverloadedProtocolMethod"
						? "overload "
						: "overload static "

				let entries = this.entriesFor(
					method.signatures,
					(signature) => positionLines(signature.position),
					(signature) => this.printProtocolSignature(signature),
				)

				let first = method.signatures[0]
				let last = method.signatures[method.signatures.length - 1]

				return concat([
					text(keyword + method.name.content + " "),
					this.block(
						entries,
						(first?.position.start.line ??
							method.name.position.start.line) - 1,
						(last?.position.end.line ??
							method.name.position.end.line) + 1,
					),
				])
			}
		}
	}

	private printProtocolSignature(
		signature: parser.ProtocolMethodSignatureNode,
	): Doc {
		return concat([
			this.printParameterList(signature.parameters),
			text(" -> "),
			this.printType(signature.returnType),
		])
	}

	private printSignature(signature: parser.NativeMethodSignatureNode): Doc {
		return concat([
			this.printGenericList(signature.generics),
			this.printParameterList(signature.parameters),
			text(" -> "),
			this.printType(signature.returnType),
		])
	}

	// NOTE: An `overload` block's entries are written without a name — the
	// block already carries it — and in a `declarations { … }` Program a single
	// block may mix bodied entries with body-less native signatures.
	private printOverloadEntries(
		entries: Array<
			parser.FunctionValueNode | parser.NativeMethodSignatureNode
		>,
		position: common.Position,
	): Doc {
		let opening = this.trivia.claimTrailingOn(position.start.line)

		let laid = this.entriesFor(
			entries,
			(entry) => positionLines(entry.position),
			(entry) =>
				entry.nodeType === "FunctionValue"
					? this.printFunctionDefinition(entry.value, entry.position)
					: this.printSignature(entry),
		)

		this.flushBefore(position.end.line, laid)

		return this.block(
			laid,
			position.start.line,
			position.end.line,
			false,
			opening,
		)
	}

	// #endregion

	// #region Functions

	// NOTE: The name, and the `static`/`overload` keywords that can precede it,
	// are written by the caller — an `overload` block's entries carry none of
	// them, and a Function literal in Argument position has no name at all.
	//
	// `allowFlatBody` is set for a Function literal and nothing else. The
	// corpus writes a short callback inline — `map((n) { <- n::toString() })` —
	// but never a Declaration, whose body always opens a block of its own.
	private printFunctionDefinition(
		definition: parser.FunctionDefinitionNode,
		position: common.Position,
		allowFlatBody = false,
	): Doc {
		let parts: Array<Doc> = [this.printGenericList(definition.generics)]

		parts.push(this.printParameterList(definition.parameters))

		if (definition.returnType !== null) {
			parts.push(text(" -> "), this.printType(definition.returnType))
		}

		parts.push(
			text(" "),
			this.bodyBlock(
				definition.body,
				position.start.line,
				position.end.line,
				allowFlatBody,
			),
		)

		return concat(parts)
	}

	// NOTE: A Parameter carrying its own `§§` block forces the list to break,
	// whatever the width. Collapsing it would put the block on the same line as
	// the Parameter below it, and Documentation attaches by line adjacency —
	// the docs would silently detach.
	private printParameterList(parameters: Array<parser.ParameterNode>): Doc {
		if (parameters.length === 0) {
			return text("()")
		}

		let documented = false
		let parts: Array<Doc> = []

		for (let index = 0; index < parameters.length; index++) {
			let parameter = parameters[index] as parser.ParameterNode
			let leading = this.trivia.takeBefore(parameter.position.start.line)

			if (index > 0) {
				parts.push(text(","), line)
			}

			for (let comment of leading) {
				documented = true
				parts.push(text(comment.text), hardline)
			}

			parts.push(this.printParameter(parameter))
		}

		return group(
			concat([
				text("("),
				indent(
					concat([
						softline,
						concat(parts),
						ifBreak(text(","), EMPTY),
					]),
				),
				softline,
				text(")"),
			]),
			{ shouldBreak: documented },
		)
	}

	private printParameter(parameter: parser.ParameterNode): Doc {
		let { externalName, internalName, type } = parameter

		// NOTE: An unannotated Parameter of a contextually typed literal —
		// `(item) { … }` — takes both its Type and its label from the expected
		// signature. `(_ item)` says the same thing and parses to the same
		// node, so the written form is read back off the source rather than
		// rebuilt, which would turn one spelling into the other.
		if (type === null) {
			return text(
				this.source.slice(parameter.position).trim() ||
					(internalName?.content ?? "_"),
			)
		}

		let name: string

		if (externalName !== null && externalName === internalName) {
			// NOTE: The parser reuses one IdentifierNode for both names when
			// the internal name doubles as the label, so identity — not
			// equality of content — is what tells `count: Integer` apart from
			// `count count: Integer`.
			name = externalName.content
		} else {
			let external = externalName === null ? "_" : externalName.content

			name =
				internalName === null
					? external
					: external + " " + internalName.content
		}

		return concat([text(name + ": "), this.printType(type)])
	}

	private printGenericList(
		generics: Array<parser.GenericDeclarationNode>,
	): Doc {
		if (generics.length === 0) {
			return EMPTY
		}

		let parts = generics.map((generic) => {
			let inner: Array<Doc> = [
				text((generic.inferred ? "infer " : "") + generic.name.content),
			]

			if (generic.constraint !== null) {
				inner.push(text(" is " + generic.constraint.content))
			}

			if (generic.defaultType !== null) {
				inner.push(text(" = "), this.printType(generic.defaultType))
			}

			return concat(inner)
		})

		return concat([text("<"), join(text(", "), parts), text(">")])
	}

	// #endregion

	// #region Expressions

	printExpression(node: parser.ExpressionNode): Doc {
		switch (node.nodeType) {
			case "Identifier":
				return text(node.content)

			case "Self":
				return text("@")

			case "Lookup":
				return concat([
					this.printExpression(node.base),
					text("." + node.member.content),
				])

			case "MethodInvocation":
				return this.printMethodChain(node)

			case "FunctionInvocation":
				return concat([
					this.printExpression(node.name),
					this.printArgumentList(node.arguments),
				])

			case "NativeFunctionInvocation":
				return concat([
					text(node.name.content),
					this.printArgumentList(node.arguments),
				])

			case "Combination":
				return this.printCombination(node)

			case "Match":
				return this.printMatch(node)

			case "CaseValue":
				return this.printCaseValue(node)

			default:
				return this.printValue(node)
		}
	}

	// NOTE: `a::b()::c()` nests to the left, so a chain has to be flattened
	// before it can be laid out. Breaking is all-or-nothing: either the whole
	// chain fits on its line, or every link gets one of its own.
	private printMethodChain(node: parser.MethodInvocationNode): Doc {
		let links: Array<parser.MethodInvocationNode> = []
		let current: parser.ExpressionNode = node

		while (current.nodeType === "MethodInvocation") {
			links.unshift(current)
			current = current.base
		}

		let head = this.printExpression(current)

		let linkDocs = links.map((link) => {
			let specifier =
				link.namespaceSpecifier === null
					? ""
					: "<" + link.namespaceSpecifier.content + ">"

			return concat([
				text("::" + specifier + link.member.content),
				this.printArgumentList(link.arguments),
			])
		})

		if (linkDocs.length === 1) {
			return concat([head, linkDocs[0] as Doc])
		}

		return group(
			concat([
				head,
				indent(
					concat(
						linkDocs.map((linkDoc) => concat([softline, linkDoc])),
					),
				),
			]),
		)
	}

	private printArgumentList(argumentNodes: Array<parser.ArgumentNode>): Doc {
		if (argumentNodes.length === 0) {
			return text("()")
		}

		let parts = argumentNodes.map((argument) => {
			let value = this.printExpression(argument.value)

			return argument.name === null
				? value
				: concat([text(argument.name.content + " "), value])
		})

		// NOTE: A trailing `match` or Function literal brings its own braces and
		// its own line breaks. Breaking the Argument list around it as well
		// would push a one-line call head onto four lines and indent the block
		// a level deeper than it was written.
		let last = argumentNodes[
			argumentNodes.length - 1
		] as parser.ArgumentNode

		if (isBlockLike(last.value)) {
			return concat([text("("), join(text(", "), parts), text(")")])
		}

		return group(
			concat([
				text("("),
				indent(
					concat([
						softline,
						join(concat([text(","), line]), parts),
						ifBreak(text(","), EMPTY),
					]),
				),
				softline,
				text(")"),
			]),
		)
	}

	// NOTE: `{ a with x = 1 }` reaches the AST as a Combination whose right
	// side is a Record the source never braced. A genuinely braced right side
	// — `{ a with { x = 1 } }` — is only distinguishable by looking at what was
	// written at its Position.
	private printCombination(node: parser.CombinationNode): Doc {
		let right: Doc

		if (
			node.rhs.nodeType === "RecordValue" &&
			!this.source.slice(node.rhs.position).trimStart().startsWith("{")
		) {
			right = this.printRecordMembers(node.rhs)
		} else {
			right = this.printExpression(node.rhs)
		}

		return group(
			concat([
				text("{ "),
				this.printExpression(node.lhs),
				text(" with "),
				right,
				text(" }"),
			]),
		)
	}

	// NOTE: Handlers are built in source order, because that is the order the
	// trivia cursor is walked in, and only then aligned — the padding is written
	// into a Doc node kept aside for it, once the widths of a whole run are
	// known.
	private printMatch(node: parser.MatchNode): Doc {
		let entries: Array<Entry> = []
		let run: Array<AlignedHandler> = []

		// NOTE: Padding is only worth writing where it lines something up, so a
		// run of one is left alone.
		let closeRun = () => {
			if (run.length > 1) {
				let widest = Math.max(
					...run.map((handler) => handler.matcherWidth),
				)

				for (let handler of run) {
					handler.padding.value = " ".repeat(
						widest - handler.matcherWidth,
					)
				}
			}

			run = []
		}

		for (let handler of node.handlers) {
			let startLine = handler.matcher.position.start.line
			let endLine = handlerEndLine(handler)

			for (let comment of this.trivia.takeBefore(startLine)) {
				entries.push(this.commentEntry(comment))
			}

			let trailing = this.trivia.claimTrailingOn(endLine)

			let matcher = this.printMatcher(handler.matcher)
			let matcherText = renderFlat(matcher) ?? ""
			let padding = text("")

			let head: Array<Doc> = [text("case "), matcher]

			if (handler.guard !== null) {
				head.push(text(" where "), this.printExpression(handler.guard))
			}

			let body = this.bodyBlock(
				handler.body,
				handler.matcher.position.end.line,
				endLine + 1,
				true,
				// NOTE: Padded whether or not this Handler ends up on one line.
				// A Handler that breaks still opens its brace right after its
				// Matcher, so it has a brace in the run's column like every
				// other — and skipping it would leave a gap in the middle of an
				// otherwise aligned `match`.
				padding,
			)

			let doc = concat([concat(head), text(" "), body])

			if (trailing !== null) {
				doc = concat([doc, text(" " + trailing.text)])
			}

			entries.push({ startLine, endLine, doc })

			// NOTE: A run is consecutive Handlers that all stay on one line and
			// none of which is guarded. A `where` clause is an arbitrary
			// Expression — usually the longest thing in the `match` — and
			// padding every sibling out to it would push the braces off to the
			// right rather than line them up. One that breaks ends the run for
			// the same reason it is not in it.
			if (handler.guard === null && renderFlat(body) !== null) {
				run.push({ matcherWidth: stringWidth(matcherText), padding })
			} else {
				closeRun()
			}
		}

		closeRun()

		this.flushBefore(node.position.end.line, entries)

		return concat([
			text("match "),
			this.printExpression(node.value),
			text(" -> "),
			this.printType(node.returnType),
			text(" "),
			this.block(
				entries,
				node.position.start.line,
				node.position.end.line,
			),
		])
	}

	// NOTE: Never broken, for the same reason a Type application is not — a `<`
	// that opens the line after the Choice's name reads as a new declaration, and
	// the `#` has to stay against the `>` for the construction to be recognised
	// at all.
	private printCaseValue(node: parser.CaseValueNode): Doc {
		let parts: Array<Doc> = []

		if (node.choice !== null) {
			parts.push(text(node.choice.content))
		}

		if (node.typeArguments !== null) {
			parts.push(
				text("<"),
				join(
					text(", "),
					node.typeArguments.map((argument) =>
						this.printType(argument),
					),
				),
				text(">"),
			)
		}

		parts.push(text("#" + node.caseName.content))

		if (node.value !== null) {
			parts.push(text("("), this.printExpression(node.value), text(")"))
		}

		return concat(parts)
	}

	// #endregion

	// #region Values

	private printValue(node: parser.ValueNode): Doc {
		switch (node.nodeType) {
			// NOTE: Reprinted from the source rather than the node. The AST
			// normalises `1_000` to `1000`, a Rational's parts must stay flush
			// to keep parsing as one literal, and the Lexer decodes a String's
			// escapes — so only the source still holds a String exactly as it
			// was written.
			case "IntegerValue":
			case "RationalValue":
			case "StringValue":
				return text(this.source.slice(node.position))

			case "InterpolatedStringValue":
				return this.printInterpolatedString(node)

			case "BooleanValue":
				return text(node.value ? "true" : "false")

			case "NothingValue":
				return text("nothing")

			case "RecordValue":
				return this.printRecord(node)

			case "ListValue":
				return this.printList(node)

			case "FunctionValue":
				return this.printFunctionDefinition(
					node.value,
					node.position,
					true,
				)
		}
	}

	// NOTE: Everything outside a hole is written back from the source and
	// everything inside one is printed like the Expression it is, so a `match`
	// interpolated into a String has its Handlers laid out and aligned like any
	// other instead of keeping the shape it was first typed with.
	//
	// The text between two holes is sliced rather than rebuilt from the
	// segments, which carry the DECODED text and no Position of their own — the
	// slice from one hole's end to the next one's start is `}`, the text as it
	// was written with its escapes intact, and `{`, which is exactly what has to
	// be written back. The same slice taken from the String's own start and to
	// its own end carries the quotes. A String with no hole never reaches here.
	//
	// A hole owns its own braces, which is what lets a String that does not fit
	// give way AT one — the padding between a brace and what it holds is inside
	// the hole, so a line break put there is layout rather than a character of
	// the String, and the text on either side is left whole:
	//
	//     "the quick brown fox {
	//         alpha
	//     } jumped over the lazy dog"
	//
	// This is the only break a String has to offer. Its text can not carry one:
	// a newline written into THAT is a character, which is what a multi-line
	// String Literal is made of. A hole holding an Expression that has to break
	// anyway — a `match`, a Function with a body — keeps its braces closed up
	// against it and lets the Expression lay itself out instead.
	private printInterpolatedString(
		node: parser.InterpolatedStringValueNode,
	): Doc {
		let parts: Array<Doc> = []
		let cursor = node.position.start
		let closing = false

		for (let segment of node.segments) {
			if (segment.kind !== "expression") {
				continue
			}

			let hole = segment.expression.position
			let written = this.source.slice({ start: cursor, end: hole.start })
			let before = holeText(written, closing, true)

			// NOTE: Only whitespace can stand between a brace and what it holds,
			// so a slice that reads otherwise is not shaped the way this takes
			// it to be — a Comment written inside a hole is the one way to get
			// there. The whole String goes back verbatim rather than being taken
			// apart on an assumption that did not hold.
			if (before === null) {
				return text(this.source.slice(node.position))
			}

			parts.push(text(before), this.printHole(segment.expression))

			cursor = hole.end
			closing = true
		}

		let written = this.source.slice({
			start: cursor,
			end: node.position.end,
		})
		let tail = holeText(written, closing, false)

		if (tail === null) {
			return text(this.source.slice(node.position))
		}

		parts.push(text(tail))

		return concat(parts)
	}

	// NOTE: The braces are written here rather than sliced with the text, so
	// they can be laid out with what they hold. An Expression that has to break
	// is left against them — a `match` opens its own block on the same line, the
	// way it would anywhere else — while one that fits on a line is offered a
	// group, which spends the break only if the String around it has run out of
	// room.
	private printHole(expression: parser.ExpressionNode): Doc {
		let doc = this.printExpression(expression)
		let flat = renderFlat(doc)

		if (flat === null) {
			return concat([text("{"), doc, text("}")])
		}

		return group(
			concat([
				text("{"),
				indent(concat([softline, text(flat)])),
				softline,
				text("}"),
			]),
		)
	}

	private printRecord(node: parser.RecordValueNode): Doc {
		let members = Object.values(node.members)

		// NOTE: The `~>` is load-bearing, not decoration: `Type ~> { a = b }` is
		// one typed Record value, while `Type { a = b }` re-parses as a constant
		// bound to the Identifier `Type` followed by a bare untyped Record. The
		// prefix has to stay outside the group so it never breaks away from the
		// brace it introduces.
		let prefix =
			node.type === null
				? EMPTY
				: concat([this.printType(node.type), text(" ~> ")])

		if (members.length === 0) {
			return concat([prefix, text("{}")])
		}

		return group(
			concat([
				prefix,
				text("{"),
				indent(
					concat([
						line,
						this.printRecordMembers(node),
						ifBreak(text(","), EMPTY),
					]),
				),
				line,
				text("}"),
			]),
		)
	}

	private printRecordMembers(node: parser.RecordValueNode): Doc {
		let members = Object.values(node.members)

		return join(
			concat([text(","), line]),
			members.map((member) =>
				concat([
					text(member.name.content + " = "),
					this.printExpression(member.value),
				]),
			),
		)
	}

	private printList(node: parser.ListValueNode): Doc {
		if (node.values.length === 0) {
			return text("[]")
		}

		return group(
			concat([
				text("["),
				indent(
					concat([
						softline,
						join(
							concat([text(","), line]),
							node.values.map((value) =>
								this.printExpression(value),
							),
						),
						ifBreak(text(","), EMPTY),
					]),
				),
				softline,
				text("]"),
			]),
		)
	}

	// #endregion

	// #region Matchers

	printMatcher(node: parser.MatcherNode): Doc {
		switch (node.nodeType) {
			case "WildcardMatcher":
				return text("_")

			case "LiteralMatcher":
				return this.printValue(node.value)

			case "CaseMatcher":
				return text(
					(node.choice === null ? "" : node.choice.content) +
						"#" +
						node.caseName.content,
				)

			case "RecordMatcher": {
				let members = Object.values(node.members)

				if (members.length === 0) {
					return text("{}")
				}

				return group(
					concat([
						text("{"),
						indent(
							concat([
								line,
								join(
									concat([text(","), line]),
									members.map((member) =>
										member.kind === "Type"
											? concat([
													text(
														member.name.content +
															": ",
													),
													this.printType(member.type),
												])
											: concat([
													text(
														member.name.content +
															" = ",
													),
													this.printValue(
														member.value,
													),
												]),
									),
								),
							]),
						),
						line,
						text("}"),
					]),
				)
			}

			default:
				return this.printType(node)
		}
	}

	// #endregion

	// #region Types

	printType(node: parser.TypeDeclarationNode): Doc {
		switch (node.nodeType) {
			case "IdentifierTypeDeclaration":
				return text(node.type.content)

			case "RecordTypeDeclaration":
				return this.printRecordType(node)

			case "UnionTypeDeclaration":
				return group(
					join(
						concat([line, text("| ")]),
						node.types.map((member) => this.printType(member)),
					),
				)

			case "FunctionTypeDeclaration":
				return concat([
					text("("),
					join(
						text(", "),
						node.parameterTypes.map((parameter) =>
							concat([
								text(
									this.functionTypeParameterName(parameter) +
										": ",
								),
								this.printType(parameter.type),
							]),
						),
					),
					text(") -> "),
					this.printType(node.returnType),
				])

			// NOTE: Never broken. A `<` that opens the line after its base Type
			// begins a new declaration as far as the parser is concerned, so a
			// Type application has to stay on one line.
			case "GenericTypeDeclaration":
				return concat([
					this.printType(node.baseType),
					text("<"),
					join(
						text(", "),
						node.generics.map((generic) => this.printType(generic)),
					),
					text(">"),
				])
		}
	}

	// NOTE: Everything written before the `:`, verbatim — `_`, `_ rootTwo` or
	// `label`. FunctionTypeParameter keeps only the external name, so an
	// internal one exists in the source and nowhere else.
	private functionTypeParameterName(
		parameter: parser.FunctionTypeParameterNode,
	): string {
		let written = this.source
			.slice({
				start: parameter.position.start,
				end: parameter.type.position.start,
			})
			.trim()

		if (written.endsWith(":")) {
			written = written.slice(0, -1).trim()
		}

		if (written === "") {
			return parameter.externalName === null
				? "_"
				: parameter.externalName.content
		}

		return written
	}

	private printRecordType(node: parser.RecordTypeDeclarationNode): Doc {
		let members = Object.values(node.members)

		if (members.length === 0) {
			return text("{}")
		}

		return group(
			concat([
				text("{"),
				indent(
					concat([
						line,
						join(
							concat([text(","), line]),
							members.map((member) =>
								concat([
									text(member.name.content + ": "),
									this.printType(member.type),
								]),
							),
						),
						ifBreak(text(","), EMPTY),
					]),
				),
				line,
				text("}"),
			]),
		)
	}

	// #endregion
}

// NOTE: One Handler's share of an alignment run — how wide its Matcher reads,
// and the Doc node its padding is written into once the run is complete.
type AlignedHandler = {
	matcherWidth: number
	padding: TextDoc
}

// NOTE: The same, for one assignment of a run of them: how wide it reads left
// of its `=`, and the slot the padding that carries it to its block's column is
// written into.
type AlignedAssignment = {
	headWidth: number
	padding: TextDoc
}

type AssignmentNode =
	| parser.ConstantDeclarationStatementNode
	| parser.VariableDeclarationStatementNode
	| parser.VariableAssignmentStatementNode

// NOTE: The Statements written as `… = …`, which are the ones an alignment run
// is made of. A `type` alias carries an `=` too, but it is a Declaration of a
// different kind written among Declarations of this one, and lining the two up
// would put a Type's name in the same column as a value's.
function assignmentOf(node: parser.ImplementationNode): AssignmentNode | null {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement":
			return node

		default:
			return null
	}
}

// NOTE: The String's own text out of a slice that runs between two holes, with
// the braces at either end and the padding they hold dropped — the printer
// writes those itself. `closes` says the slice begins by closing a hole and
// `opens` that it ends by opening the next one; the ends of the String are the
// two slices that do neither.
//
// The braces are found from the outside in: the one that closes a hole is the
// FIRST `}` written, and the one that opens the next is the LAST `{`, because
// only whitespace can stand between a brace and the Expression it holds. That
// is what leaves an escaped `\{` or `\}` written in the text between them
// alone. Null when something other than whitespace turns up in that gap, which
// means the slice is not shaped the way this reads it.
function holeText(
	written: string,
	closes: boolean,
	opens: boolean,
): string | null {
	let text = written

	if (closes) {
		let brace = text.indexOf("}")

		if (brace === -1 || text.slice(0, brace).trim() !== "") {
			return null
		}

		text = text.slice(brace + 1)
	}

	if (opens) {
		let brace = text.lastIndexOf("{")

		if (brace === -1 || text.slice(brace + 1).trim() !== "") {
			return null
		}

		text = text.slice(0, brace)
	}

	return text
}

type AssignmentKind = "declaration" | "assignment"

// NOTE: A Declaration and a bare reassignment never share a run. `constant` and
// `variable` are the same width, so Declarations line up on their names by
// themselves — but a reassignment writes no keyword at all, and padding it out
// to one would leave a keyword's worth of empty column in the middle of the run.
function assignmentKind(node: AssignmentNode): AssignmentKind {
	return node.nodeType === "VariableAssignmentStatement"
		? "assignment"
		: "declaration"
}

// NOTE: One entry of a Module section with everything that rides along when the
// block is sorted: the Comments written above it, the one trailing it, and
// `head` — everything written left of the `from`, which is what the block's
// column is measured against, `PI as Pi` at its full spelling.
type SectionEntry<Node> = {
	node: Node
	leading: Array<Comment>
	trailing: Comment | null
	head: string
}

function entryHead(entry: parser.ImportNode | parser.ExportNode): string {
	return entry.alias === null
		? entry.name.content
		: entry.name.content + " as " + entry.alias.content
}

type NamespaceMember =
	| { kind: "property"; property: parser.NamespacePropertyNode }
	| { kind: "method"; method: parser.NamespaceMethods[string] }

function memberName(member: NamespaceMember): parser.IdentifierNode {
	return member.kind === "property"
		? member.property.name
		: member.method.name
}

function protocolMethodEndLine(method: parser.ProtocolMethods[string]): number {
	switch (method.nodeType) {
		case "SimpleProtocolMethod":
		case "StaticProtocolMethod":
			return method.signature.position.end.line

		default: {
			let last = method.signatures[method.signatures.length - 1]

			return last === undefined
				? method.name.position.end.line
				: last.position.end.line
		}
	}
}

// NOTE: An `overload` block carries no Position of its own — only its entries
// do — so the braces are placed around the span the entries cover.
function overloadPosition(
	entries: Array<parser.FunctionValueNode | parser.NativeMethodSignatureNode>,
	fallback: common.Position,
): common.Position {
	let first = entries[0]
	let last = entries[entries.length - 1]

	if (first === undefined || last === undefined) {
		return fallback
	}

	return {
		start: { line: first.position.start.line - 1, column: 1 },
		end: { line: last.position.end.line + 1, column: 1 },
	}
}

// NOTE: An Expression that lays itself out over several lines and closes with
// a brace of its own.
function isBlockLike(node: parser.ExpressionNode): boolean {
	return (
		node.nodeType === "Match" ||
		node.nodeType === "FunctionValue" ||
		node.nodeType === "RecordValue" ||
		node.nodeType === "ListValue"
	)
}

function handlerEndLine(handler: parser.MatchNode["handlers"][number]): number {
	let last = handler.body[handler.body.length - 1]

	return last === undefined
		? handler.matcher.position.end.line
		: last.position.end.line
}
