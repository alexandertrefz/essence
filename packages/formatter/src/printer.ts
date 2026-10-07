import type { common, parser } from "@essence-lang/interfaces"

import {
	type AlignDoc,
	type AlignmentItem,
	alignmentRun,
	alignmentSlot,
	breakParent,
	concat,
	conditionalGroup,
	type Doc,
	expand,
	fill,
	group,
	hardline,
	ifBreak,
	indent,
	join,
	joinAlignment,
	line,
	lineSuffix,
	renderFlat,
	softline,
	stringWidth,
	TAB_WIDTH,
	text,
	verbatim,
} from "./doc"
import { compareEntries, compareGroups } from "./sections"
import type { SourceText } from "./source"
import type { Comment, TriviaCursor } from "./trivia"

// One thing to write, with the source lines it was written on. They decide
// whether the author left a blank line before it.
type Entry = {
	startLine: number
	endLine: number
	doc: Doc
	// Whether the entry ends with a block of its own, such as a Function or an
	// `if`. A blank line always follows one.
	bodied?: boolean
	// Set where the builder decides the blank line before the entry, since a
	// sorted list's neighbours are not the source's.
	blankAbove?: boolean
}

const EMPTY = text("")

// The most padding an aligned `=` is worth. A head that would need more starts
// a new block. See "Aligned columns" in DEVELOPMENT.md.
const MAX_ALIGNMENT_PADDING = 12

// A `match` lines up all its Handlers however far apart their Matchers read,
// since a Handler out of the column would read as another `match`'s.
const UNBLOCKED_ALIGNMENT = Number.POSITIVE_INFINITY

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
			doc: verbatim(comment.text),
		}
	}

	// One entry per line, keeping one blank line wherever the author left any.
	// See "Blank lines" in DEVELOPMENT.md.
	private layout(entries: Array<Entry>, openLine: number | null): Doc {
		let parts: Array<Doc> = []
		let previousEnd = openLine
		let previousBodied = false

		for (let entry of entries) {
			if (parts.length > 0) {
				parts.push(hardline)
			}

			if (
				previousBodied ||
				(entry.blankAbove ??
					(previousEnd !== null &&
						this.source.hasBlankLineBetween(
							previousEnd,
							entry.startLine,
						)))
			) {
				parts.push(hardline)
			}

			parts.push(entry.doc)
			previousEnd = entry.endLine
			previousBodied = entry.bodied === true
		}

		return concat(parts)
	}

	// Each item after the Comments written before it, with its trailing
	// Comment kept on the item's line.
	private entriesFor<Item>(
		items: Array<Item>,
		linesOf: (item: Item) => {
			startLine: number
			endLine: number
			bodied?: boolean
		},
		print: (item: Item) => Doc,
	): Array<Entry> {
		let entries: Array<Entry> = []

		for (let item of items) {
			let { startLine, endLine, bodied } = linesOf(item)

			for (let comment of this.trivia.takeBefore(startLine)) {
				entries.push(this.commentEntry(comment))
			}

			let trailing = this.trivia.claimTrailingOn(endLine)
			let doc = print(item)

			// Nothing may follow the Comment on its line, so its block never
			// prints flat. See "The document algebra" in DEVELOPMENT.md.
			if (trailing !== null) {
				doc = concat([
					doc,
					lineSuffix(" " + trailing.text),
					breakParent,
				])
			}

			entries.push({ startLine, endLine, doc, bodied })
		}

		return entries
	}

	// The Statements of a block, with the `=` of adjacent assignments in one
	// column. See "Aligned columns" in DEVELOPMENT.md.
	private implementationEntries(
		nodes: Array<parser.TestsNode>,
	): Array<Entry> {
		let run = alignmentRun(MAX_ALIGNMENT_PADDING)
		let kind: AssignmentKind | null = null
		let previousEnd: number | null = null

		let closeRun = () => {
			run = alignmentRun(MAX_ALIGNMENT_PADDING)
			kind = null
		}

		let entries = this.entriesFor(
			nodes,
			(node) => ({
				...positionLines(node.position),
				bodied: isBodiedStatement(node),
			}),
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

					return this.printTestsNode(node)
				}

				if (separated || assignmentKind(assignment) !== kind) {
					closeRun()
				}

				let padding = alignmentSlot()
				let printed = this.printAssignment(assignment, padding)

				if (printed.headWidth === null) {
					closeRun()

					return printed.doc
				}

				kind = assignmentKind(assignment)
				joinAlignment(run, padding, {
					headWidth: printed.headWidth,
					// The `=` follows the head wherever it ends, and a wide
					// value breaks inside itself, so the run never takes an
					// assignment out.
					fitWidth: null,
				})

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

	// A braced block. It breaks unless `allowFlat` offers one line to a single
	// Statement, as in `case #Empty { <- fallback }`. The `opening` Comment
	// after the `{` belongs to no Statement, so only the block can write it. The
	// `prefix` is measured with the block, so that a Handler's alignment
	// padding counts. A Handler's body is never hugged, so it is not expandable.
	private block(
		entries: Array<Entry>,
		openLine: number | null,
		allowFlat = false,
		opening: Comment | null = null,
		prefix: Doc = EMPTY,
		expandable = allowFlat,
	): Doc {
		let brace =
			opening === null
				? text("{")
				: concat([text("{"), lineSuffix(" " + opening.text)])

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
				{ expandable },
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

	// The `closeLine` is the line of the body's own `}`, since an `if … else`
	// Position runs on to the end of the false body. The `{` is looked for from
	// `headLine`, where the owner starts.
	private bodyBlock(
		body: Array<parser.TestsNode>,
		headLine: number,
		closeLine: number,
		allowFlat = false,
		prefix: Doc = EMPTY,
	): Doc {
		let { entries, opening, flatAllowed } = this.bodyEntries(
			body,
			headLine,
			closeLine,
		)

		return this.block(
			entries,
			null,
			allowFlat && flatAllowed,
			opening,
			prefix,
		)
	}

	// A body's entries, built once, since building moves the trivia cursor.
	// Flat is not allowed once a Comment was claimed inside the body.
	private bodyEntries(
		body: Array<parser.TestsNode>,
		headLine: number,
		closeLine: number,
	): {
		entries: Array<Entry>
		opening: Comment | null
		flatAllowed: boolean
	} {
		let openLine = this.braceLine(
			headLine,
			body[0]?.position.start.line ?? null,
			closeLine,
		)
		let opening = this.trivia.claimTrailingOn(openLine)

		let entries = this.implementationEntries(body)

		this.flushBefore(closeLine, entries)

		return { entries, opening, flatAllowed: entries.length === body.length }
	}

	// The line of a block's `{`, which the tree does not record. A header can
	// put it lines below the keyword, so it is looked for up to the first line
	// inside the block.
	private braceLine(
		headLine: number,
		firstInnerLine: number | null,
		closeLine: number,
	): number {
		let to = (firstInnerLine ?? closeLine) - 1

		if (firstInnerLine === null && closeLine > headLine) {
			let found = this.source.openingBraceLine(closeLine, closeLine)

			if (found !== null) {
				return found
			}
		}

		if (to < headLine) {
			return headLine
		}

		return this.source.openingBraceLine(headLine, to) ?? headLine
	}

	// #endregion

	// #region Program

	// The sections in written order, each printed where it stands, since the
	// trivia cursor hands out Comments in that order.
	printProgram(program: parser.Program): Doc {
		let keyword =
			program.kind === "declarations" ? "declarations" : "implementation"

		let parts: Array<Doc> = []

		if (program.imports !== null) {
			parts.push(
				concat(this.headingComments(program.imports.position)),
				this.printModuleSection("import", program.imports),
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

		// A file of nothing but tests has no implementation block, and its
		// Program Position is the tests block's.
		if (program.kind !== "tests") {
			// Comments before `implementation {` stand outside the Program's
			// Position, so they are written before the keyword.
			let heading = this.headingComments(program.position)
			let opening = this.trivia.claimTrailingOn(
				program.position.start.line,
			)

			let entries = this.implementationEntries(
				program.implementation.nodes,
			)

			this.flushBefore(program.position.end.line, entries)

			parts.push(
				concat(heading),
				text(keyword + " "),
				this.block(
					entries,
					program.position.start.line,
					false,
					opening,
				),
			)

			// A Comment trailing the Program's own `}` stays on it.
			let closing = this.trivia.claimTrailingOn(program.position.end.line)

			if (closing !== null) {
				parts.push(lineSuffix(" " + closing.text))
			}
		}

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
				this.printModuleSection("export", program.exports),
			)
		}

		if (program.tests !== null) {
			// Only the `import` block writes a separator after itself, and it
			// is the one before the tests in a file of nothing but tests.
			if (program.kind !== "tests") {
				parts.push(hardline)

				if (
					this.source.hasBlankLineBetween(
						(program.exports ?? program).position.end.line,
						program.tests.position.start.line,
					)
				) {
					parts.push(hardline)
				}
			}

			parts.push(this.printTestsSection(program.tests))

			let closing = this.trivia.claimTrailingOn(
				program.tests.position.end.line,
			)

			if (closing !== null) {
				parts.push(lineSuffix(" " + closing.text))
			}
		}

		// Comments after the last block stay after it, since moving one into
		// the block would cross a brace and be refused.
		let previousEnd = (program.tests ?? program.exports ?? program).position
			.end.line

		for (let comment of this.trivia.takeRemaining()) {
			parts.push(hardline)

			if (
				this.source.hasBlankLineBetween(previousEnd, comment.startLine)
			) {
				parts.push(hardline)
			}

			parts.push(verbatim(comment.text))
			previousEnd = comment.endLine
		}

		parts.push(hardline)

		return concat(parts)
	}

	// The `tests { … }` block, laid out as the implementation block is.
	private printTestsSection(node: parser.TestsSectionNode): Doc {
		let heading = this.headingComments(node.position)
		let opening = this.trivia.claimTrailingOn(node.position.start.line)

		let entries = this.implementationEntries(node.nodes)

		this.flushBefore(node.position.end.line, entries)

		return concat([
			concat(heading),
			text("tests "),
			this.block(entries, node.position.start.line, false, opening),
		])
	}

	private printTestsNode(node: parser.TestsNode): Doc {
		switch (node.nodeType) {
			case "Test":
				return concat([
					this.printItemHead(
						node.form,
						node.name,
						node.modifiers,
						node.table,
						node.properties,
					),
					this.bodyBlock(
						node.body,
						node.position.start.line,
						node.position.end.line,
					),
				])

			case "Suite":
				return concat([
					this.printItemHead(
						"suite",
						node.name,
						node.modifiers,
						null,
						null,
					),
					this.bodyBlock(
						node.nodes,
						node.position.start.line,
						node.position.end.line,
					),
				])

			default:
				return this.printImplementationNode(node)
		}
	}

	// `test "name" skipped "reason"` and its block. When the head stops fitting,
	// the Modifiers go one per line and the `{` returns to the item's column.
	// The space before the `{` is in this group rather than the block, since
	// the block's hard break would keep the group from printing flat.
	private printItemHead(
		keyword: string,
		name: parser.TestNode["name"],
		modifiers: Array<parser.TestModifierNode>,
		table: parser.TestTableNode | null,
		properties: parser.TestPropertiesNode | null,
	): Doc {
		let head: Array<Doc> = [text(keyword + " "), this.printValue(name)]

		if (modifiers.length === 0 && table === null && properties === null) {
			return concat([...head, text(" ")])
		}

		// The table and the property list stand outside the group. They break
		// over lines of their own, which would put every Modifier on its own
		// line too. A test that writes both is refused as
		// `contradictory-test-forms`, but printing both keeps what it says.
		let tail: Doc = concat([
			table === null
				? EMPTY
				: concat([this.printTestTable(table), text(" ")]),
			properties === null
				? EMPTY
				: concat([this.printTestProperties(properties), text(" ")]),
		])

		if (modifiers.length === 0) {
			return concat([...head, text(" "), tail])
		}

		return concat([
			group(
				concat([
					...head,
					indent(
						concat(
							modifiers.flatMap((modifier) => [
								line,
								this.printTestModifier(modifier),
							]),
						),
					),
					line,
				]),
			),
			tail,
		])
	}

	// `across [ … ] (row: Row)`, between the Modifiers and the body. The rows
	// print as the List they are.
	private printTestTable(node: parser.TestTableNode): Doc {
		return concat([
			text("across "),
			this.printExpression(node.value),
			text(" "),
			this.printParameterList(
				node.parameters,
				null,
				node.parameterListPosition,
			),
		])
	}

	// `for any (a: Integer, b: String)`, in a table's slot. The Parameters
	// print as a closure's.
	private printTestProperties(node: parser.TestPropertiesNode): Doc {
		return concat([
			text("for any "),
			this.printParameterList(
				node.parameters,
				null,
				node.parameterListPosition,
			),
		])
	}

	private printTestModifier(node: parser.TestModifierNode): Doc {
		if (node.arguments.length === 0) {
			return text(node.name.content)
		}

		return concat([
			text(node.name.content + " "),
			join(
				text(", "),
				node.arguments.map((argument) =>
					argument.nodeType === "Identifier"
						? text(argument.content)
						: this.printValue(argument),
				),
			),
		])
	}

	// The Comments before a block's keyword, which stand outside its Position.
	// A blank line the author left between them and the keyword is kept.
	private headingComments(position: common.Position): Array<Doc> {
		let line = position.start.line
		let parts: Array<Doc> = []
		let comments = this.trivia.takeBefore(line)

		for (let [index, comment] of comments.entries()) {
			parts.push(verbatim(comment.text), hardline)

			// Judged against what follows this Comment, the next one or the
			// keyword, so that a run of Comments is not written double-spaced.
			let next = comments[index + 1]?.startLine ?? line

			if (this.source.hasBlankLineBetween(comment.endLine, next)) {
				parts.push(hardline)
			}
		}

		return parts
	}

	// One Module section in canonical order. The members are walked in written
	// order, the order the trivia cursor hands out Comments, and sorted after,
	// so each Comment travels with its member. Nothing in a section is aligned,
	// so adding a wide name rewrites no other line.
	private printModuleSection(
		keyword: string,
		section: parser.ImportSectionNode | parser.ExportSectionNode,
	): Doc {
		let opening = this.trivia.claimTrailingOn(section.position.start.line)

		let bare: Array<SectionEntry> = []
		let groups: Array<SectionGroup> = []

		for (let [written, member] of writtenMembers(section).entries()) {
			if (member.nodeType === "Export") {
				bare.push(this.sectionEntry(member, written))
			} else {
				groups.push(this.sectionGroup(member, written))
			}
		}

		// A Comment after the last member belongs to no member, and is written
		// before the closing brace.
		let loose = this.trivia.takeBefore(section.position.end.line)

		bare.sort((left, right) => compareEntries(left.node, right.node))
		groups.sort((left, right) =>
			compareGroups(groupHead(left), groupHead(right)),
		)

		let lines = this.sectionLines(
			[
				...bare.map((entry) => ({
					...entry,
					doc: this.entryDoc(entry),
				})),
				...groups.map((group) => ({
					...group,
					doc: this.groupDoc(group),
				})),
			],
			loose,
		)

		return concat([
			text(keyword + " "),
			this.block(lines, null, false, opening),
		])
	}

	// The lines of a sorted list, each member after its Comments. A blank line
	// is kept only where the sort leaves the lines around it together.
	private sectionLines(
		members: Array<SectionMember>,
		loose: Array<Comment>,
	): Array<Entry> {
		let lines: Array<Entry> = []
		// Where the previous line ends in the source, or null when the sort
		// did not keep it before this one.
		let previousEnd: number | null = null

		let add = (doc: Doc, startLine: number, endLine: number) => {
			lines.push({
				startLine,
				endLine,
				doc,
				blankAbove:
					previousEnd !== null &&
					this.source.hasBlankLineBetween(previousEnd, startLine),
			})
			previousEnd = endLine
		}

		for (let [index, member] of members.entries()) {
			if (members[index - 1]?.written !== member.written - 1) {
				previousEnd = null
			}

			for (let comment of member.leading) {
				add(verbatim(comment.text), comment.startLine, comment.endLine)
			}

			add(
				member.doc,
				member.node.position.start.line,
				member.node.position.end.line,
			)
		}

		if (members[members.length - 1]?.written !== members.length - 1) {
			previousEnd = null
		}

		for (let comment of loose) {
			add(verbatim(comment.text), comment.startLine, comment.endLine)
		}

		return lines
	}

	private sectionEntry(
		node: parser.ImportNode | parser.ExportNode,
		written: number,
	): SectionEntry {
		let leading = this.trivia.takeBefore(node.position.start.line)
		let trailing = this.trivia.claimTrailingOn(node.position.end.line)

		return { node, leading, trailing, written }
	}

	// A group's Comments are claimed around its entries, and the two trailing
	// its own lines last. So a Comment after a flat group of one entry is the
	// entry's, and stays on the entry's line if the group breaks.
	private sectionGroup(
		node: parser.ImportGroupNode | parser.ExportGroupNode,
		written: number,
	): SectionGroup {
		let leading = this.trivia.takeBefore(node.position.start.line)
		let entries = node.entries.map((entry, index) =>
			this.sectionEntry(entry, index),
		)
		let loose = this.trivia.takeBefore(node.position.end.line)
		let opening = this.trivia.claimTrailingOn(node.position.start.line)
		let closing = this.trivia.claimTrailingOn(node.position.end.line)

		entries.sort((left, right) => compareEntries(left.node, right.node))

		return { node, leading, opening, entries, loose, closing, written }
	}

	private entryDoc(entry: SectionEntry): Doc {
		let doc: Doc = text(entryHead(entry.node))

		return entry.trailing === null
			? doc
			: concat([doc, lineSuffix(" " + entry.trailing.text)])
	}

	// `from "./Module.es" { … }`, on one line for a single name and one name
	// per line for more. The specifier is sliced from the source, since the
	// tree holds it without quotes and with its escapes decoded.
	private groupDoc(group: SectionGroup): Doc {
		let lines = this.sectionLines(
			group.entries.map((entry) => ({
				...entry,
				doc: this.entryDoc(entry),
			})),
			group.loose,
		)

		let doc: Doc = concat([
			text("from " + this.source.slice(group.node.source.position) + " "),
			this.block(lines, null, true, group.opening),
		])

		if (group.closing !== null) {
			doc = concat([doc, lineSuffix(" " + group.closing.text)])
		}

		return doc
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
					this.printIfHead(node.condition),
					this.bodyBlock(
						node.body,
						node.position.start.line,
						node.position.end.line,
					),
				])

			case "IfElseStatement":
				return this.printIfElse(node)

			case "TypeAliasStatement": {
				let head = concat([
					text("type " + node.name.content),
					this.printGenericList(node.generics),
				])
				let parts: Array<Doc> = [
					head,
					text(" = "),
					this.printAliasedType(node.type, head),
				]

				// A refinement's `where` stays on the Type's line while it
				// fits, and otherwise moves whole to the next line, indented.
				// The Parser still reads it as the clause there.
				if (node.predicate !== null) {
					parts.push(
						group(
							indent(
								concat([
									line,
									text("where "),
									this.printExpression(node.predicate),
								]),
							),
						),
					)
				}

				return concat(parts)
			}

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

			case "OverloadedFunctionStatement":
				return concat([
					text("overload function " + node.name.content + " "),
					this.printOverloadEntries(node.methods, node.position),
				])

			case "ExpectStatement":
			case "RequireStatement":
				return this.printAssertion(node)

			default:
				return this.printExpression(node)
		}
	}

	// `expect value` and `require #Value(item) = value`. A `require` Matcher
	// stands where a Declaration's name does, and breaks as one does. Unlike a
	// Handler's Matcher, it has no column to stay flat for.
	private printAssertion(
		node: parser.ExpectStatementNode | parser.RequireStatementNode,
	): Doc {
		let keyword =
			node.nodeType === "ExpectStatement" ? "expect " : "require "

		if (node.matcher !== null) {
			return concat([
				text(keyword),
				this.printMatcher(node.matcher, true),
				text(" = "),
				this.printExpression(node.value),
			])
		}

		let value = this.printExpression(node.value)

		if (node.snapshot === null) {
			return concat([text(keyword), value])
		}

		// `matches snapshot …` follows the value, or moves to its own line when
		// that keeps the value on one line. A value that breaks anyway keeps
		// the clause after its closing bracket.
		let snapshot = this.printSnapshot(node.snapshot)

		return concat([
			text(keyword),
			conditionalGroup([
				concat([value, text(" "), snapshot]),
				concat([value, indent(concat([hardline, snapshot]))]),
				concat([value, text(" "), snapshot]),
			]),
		])
	}

	// `matches snapshot`, `matches snapshot "…"` holding a recorded value, or
	// `matches snapshot from "name"` naming an entry in `__snapshots__`.
	private printSnapshot(node: parser.SnapshotNode): Doc {
		if (node.name !== null) {
			return concat([
				text("matches snapshot from "),
				this.printValue(node.name),
			])
		}

		if (node.value !== null) {
			return concat([
				text("matches snapshot "),
				this.printValue(node.value),
			])
		}

		return text("matches snapshot")
	}

	// The head's width comes back with the Doc, for the alignment run that
	// fills `padding`, or null when the head cannot stay on one line. The value
	// does not count, since the `=` stays on the head's line whatever follows.
	private printAssignment(
		node: AssignmentNode,
		padding: Doc,
	): { doc: Doc; headWidth: number | null } {
		let head: Array<Doc> = []
		let takesApart = false

		if (node.nodeType === "VariableAssignmentStatement") {
			head.push(text(node.name.content))
		} else {
			let keyword =
				node.nodeType === "ConstantDeclarationStatement"
					? "constant"
					: "variable"

			takesApart = node.name.nodeType === "Pattern"

			head.push(
				text(keyword + " "),
				node.name.nodeType === "Pattern"
					? this.printPattern(node.name, true)
					: text(node.name.content),
			)

			if (node.type !== null) {
				head.push(text(": "), this.printType(node.type))
			}
		}

		// A Pattern head lays itself out, so it reports no width and ends the
		// run. Padded beside a similar sibling, both could break and strand
		// their padding after the closing brace.
		let written = takesApart ? null : renderFlat(concat(head))
		let value = this.printExpression(node.value)

		// The `=` never breaks from its value. The value starts on the name's
		// line and breaks inside itself, so a reader finds its start beside the
		// name.
		return {
			doc: concat([...head, padding, text(" = "), value]),
			headWidth: written === null ? null : stringWidth(written),
		}
	}

	// `else if` is one written form, not a block holding an `if`. As a nested
	// block, each arm of a guard cascade would be indented one level deeper.
	private printIfElse(node: parser.IfElseStatementNode): Doc {
		let first = node.falseBody[0]
		let lastTrue = node.trueBody[node.trueBody.length - 1]

		// The `} else {` line, found in the source. Everything before it,
		// Comments included, belongs to the true body.
		let trueClose =
			first === undefined
				? node.position.end.line
				: (this.source.closingBraceLine(
						(lastTrue?.position.end.line ??
							node.position.start.line) + 1,
						first.position.start.line,
					) ?? first.position.start.line - 1)

		let parts: Array<Doc> = [
			this.printIfHead(node.condition),
			this.bodyBlock(node.trueBody, node.position.start.line, trueClose),
			text(" else "),
		]

		let only = node.falseBody.length === 1 ? node.falseBody[0] : undefined

		// The Parser gives `else if …` and `else { if … }` one tree, so the
		// source says which was written: only whitespace between `else` and `if`
		// means the chained form. Printing the other would drop two braces.
		if (
			only !== undefined &&
			(only.nodeType === "IfStatement" ||
				only.nodeType === "IfElseStatement") &&
			this.writtenAsElseIf(trueClose, only.position.start)
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

	// `if condition {`. A condition chain that breaks puts the `{` on a line of
	// its own, since its links are indented as far as the body's Statements.
	// The chain decides, as only it knows whether it broke.
	private printIfHead(condition: parser.ExpressionNode): Doc {
		if (condition.nodeType === "MethodInvocation") {
			return concat([
				text("if "),
				this.printMethodChain(condition, text(" "), hardline),
			])
		}

		return concat([text("if "), this.printExpression(condition), text(" ")])
	}

	private writtenAsElseIf(elseLine: number, ifStart: common.Cursor): boolean {
		let between = this.source.slice({
			start: { line: elseLine, column: 1 },
			end: ifStart,
		})
		let keyword = between.lastIndexOf("else")

		return keyword !== -1 && between.slice(keyword + 4).trim() === ""
	}

	private printChoice(node: parser.ChoiceDeclarationStatementNode): Doc {
		let opening = this.trivia.claimTrailingOn(
			this.braceLine(
				node.position.start.line,
				node.cases[0]?.name.position.start.line ?? null,
				node.position.end.line,
			),
		)

		let entries = this.entriesFor(
			node.cases,
			(choiceCase) => positionLines(choiceCase.name.position),
			(choiceCase) => {
				let parts: Array<Doc> = [text(choiceCase.name.content)]

				if (choiceCase.type !== null) {
					parts.push(text(" "), this.printRecordType(choiceCase.type))
				}

				this.printDefaultValueInto(parts, choiceCase)

				parts.push(text(","))

				return concat(parts)
			},
		)

		this.flushBefore(node.position.end.line, entries)

		return concat([
			text("choice " + node.name.content),
			this.printGenericList(node.generics),
			text(" "),
			this.block(entries, null, false, opening),
		])
	}

	// #endregion

	// #region Namespaces and Protocols

	private printNamespace(node: parser.NamespaceDefinitionStatementNode): Doc {
		let head: Array<Doc> = [
			text("namespace " + node.name.content),
			this.printGenericList(node.generics),
		]

		// A body reaches the tree as two Records, Properties and Methods, so
		// the written order is rebuilt from their names' Positions.
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
			this.braceLine(
				node.position.start.line,
				members[0] === undefined
					? null
					: memberName(members[0]).position.start.line,
				node.position.end.line,
			),
		)

		// Adjacent `static` properties line up their `=` as Declarations do. A
		// Method, a blank line, a property with no value, or a head that cannot
		// stay on one line ends the run.
		let run = alignmentRun(MAX_ALIGNMENT_PADDING)
		let previousEnd: number | null = null

		let closeRun = () => {
			run = alignmentRun(MAX_ALIGNMENT_PADDING)
		}

		let entries = this.entriesFor(
			members,
			(member) => ({
				startLine: memberName(member).position.start.line,
				endLine: this.namespaceMemberEndLine(member),
				bodied:
					member.kind === "method" &&
					isBodiedNamespaceMethod(member.method),
			}),
			(member) => {
				let startLine = memberName(member).position.start.line
				let separated =
					previousEnd !== null &&
					this.source.hasBlankLineBetween(previousEnd, startLine)

				previousEnd = this.namespaceMemberEndLine(member)

				if (
					member.kind !== "property" ||
					member.property.value === null
				) {
					closeRun()

					return this.printNamespaceMember(member)
				}

				if (separated) {
					closeRun()
				}

				let padding = alignmentSlot()
				let printed = this.printProperty(member.property, padding)

				if (printed.headWidth === null) {
					closeRun()

					return printed.doc
				}

				// No `fitWidth`, since a property's `=` stays on its head's
				// line too.
				joinAlignment(run, padding, {
					headWidth: printed.headWidth,
					fitWidth: null,
				})

				return printed.doc
			},
		)

		closeRun()

		this.flushBefore(node.position.end.line, entries)

		let headDoc = this.printDeclarationHead(
			concat(head),
			node.targetType === null ? null : this.printType(node.targetType),
			node.conformsTo.map((clause) =>
				this.printConformanceClause(clause),
			),
			entries.length === 0,
		)

		return concat([headDoc, this.block(entries, null, false, opening)])
	}

	// A Namespace or Protocol head, with its `for` clause and conformance list,
	// and the space before its `{`. See "Broken heads" in DEVELOPMENT.md.
	private printDeclarationHead(
		name: Doc,
		target: Doc | null,
		clauses: Array<Doc>,
		emptyBody: boolean,
	): Doc {
		// With no `is` clauses, the `for` clause is the whole head. It moves
		// down rather than leave the `{` alone under a full line.
		let forClause =
			target === null
				? EMPTY
				: indent(concat([line, text("for "), target]))
		let named =
			clauses.length > 0 && target !== null
				? group(concat([name, forClause]))
				: concat([name, forClause])

		let parts: Array<Doc> = [named]

		if (clauses.length > 0) {
			parts.push(
				indent(
					concat([line, join(concat([text(","), line]), clauses)]),
				),
			)
		}

		parts.push(emptyBody ? text(" ") : ifBreak(hardline, text(" ")))

		return group(concat(parts))
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

	// A `static` property, with the same padding slot before its `=` a
	// Declaration carries, so that a run of them can line up.
	private printProperty(
		property: parser.NamespacePropertyNode,
		padding: Doc,
	): { doc: Doc; headWidth: number | null } {
		let head: Array<Doc> = [text("static " + property.name.content)]

		if (property.type !== null) {
			head.push(text(": "), this.printType(property.type))
		}

		if (property.value === null) {
			return { doc: concat(head), headWidth: null }
		}

		let written = renderFlat(concat(head))
		let value = this.printExpression(property.value)

		return {
			doc: concat([...head, padding, text(" = "), value]),
			headWidth: written === null ? null : stringWidth(written),
		}
	}

	private printNamespaceMember(member: NamespaceMember): Doc {
		if (member.kind === "property") {
			return this.printProperty(member.property, EMPTY).doc
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

		let opening = this.trivia.claimTrailingOn(
			this.braceLine(
				node.position.start.line,
				methods[0]?.name.position.start.line ?? null,
				node.position.end.line,
			),
		)

		let entries = this.entriesFor(
			methods,
			(method) => ({
				startLine: method.name.position.start.line,
				endLine: protocolMethodEndLine(method),
				bodied: isBodiedProtocolMethod(method),
			}),
			(method) => this.printProtocolMethod(method),
		)

		this.flushBefore(node.position.end.line, entries)

		let headDoc = this.printDeclarationHead(
			text("protocol " + node.name.content),
			null,
			node.conformsTo.map((clause) =>
				this.printConformanceClause(clause),
			),
			entries.length === 0,
		)

		return concat([headDoc, this.block(entries, null, false, opening)])
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
					(signature) => ({
						startLine: signature.position.start.line,
						endLine: protocolSignatureEndLine(signature),
					}),
					(signature) => this.printProtocolSignature(signature),
				)

				return concat([
					text(keyword + method.name.content + " "),
					this.block(entries, null),
				])
			}
		}
	}

	// A provided Method prints as the Function Definition the Parser built over
	// this signature's own Parameter and return Type nodes.
	private printProtocolSignature(
		signature: parser.ProtocolMethodSignatureNode,
	): Doc {
		if (signature.body !== null) {
			return this.printFunctionDefinition(
				signature.body.value,
				signature.body.position,
			)
		}

		return this.printParameterList(
			signature.parameters,
			this.printType(signature.returnType),
			signatureListPosition(signature),
		)
	}

	private printSignature(signature: parser.NativeMethodSignatureNode): Doc {
		return concat([
			this.printGenericList(signature.generics),
			this.printParameterList(
				signature.parameters,
				this.printType(signature.returnType),
				signatureListPosition(signature),
			),
		])
	}

	// An `overload` block's entries carry no name. In a `declarations { … }`
	// Program, one block may mix bodied entries with native signatures.
	private printOverloadEntries(
		entries: Array<
			parser.FunctionValueNode | parser.NativeMethodSignatureNode
		>,
		position: common.Position,
	): Doc {
		let opening = this.trivia.claimTrailingOn(
			this.braceLine(
				position.start.line,
				entries[0]?.position.start.line ?? null,
				position.end.line,
			),
		)

		let laid = this.entriesFor(
			entries,
			(entry) => ({
				...positionLines(entry.position),
				bodied: entry.nodeType === "FunctionValue",
			}),
			(entry) =>
				entry.nodeType === "FunctionValue"
					? this.printFunctionDefinition(entry.value, entry.position)
					: this.printSignature(entry),
		)

		this.flushBefore(position.end.line, laid)

		return this.block(laid, null, false, opening)
	}

	// #endregion

	// #region Functions

	// The caller writes the name and any `static` or `overload` keyword. Only a
	// Function literal allows a flat body, as in `map((n) { <- n::toString() })`.
	private printFunctionDefinition(
		definition: parser.FunctionDefinitionNode,
		position: common.Position,
		allowFlatBody = false,
	): Doc {
		let parts: Array<Doc> = [this.printGenericList(definition.generics)]

		parts.push(
			this.printParameterList(
				definition.parameters,
				definition.returnType === null
					? null
					: this.printType(definition.returnType),
				definition.parameterListPosition,
				true,
			),
		)

		parts.push(
			this.bodyBlock(
				definition.body,
				position.start.line,
				position.end.line,
				allowFlatBody,
			),
		)

		return concat(parts)
	}

	// A Parameter list with its return Type, and the space before a body's `{`
	// when `opensBody` is set. The `listPosition` places the Comments after the
	// `(` and before the `)`. See "Parameter lists" in DEVELOPMENT.md.
	private printParameterList(
		parameters: Array<parser.ParameterNode>,
		returnType: Doc | null = null,
		listPosition: common.Position | null = null,
		opensBody = false,
	): Doc {
		let bodySpace = opensBody ? text(" ") : EMPTY

		if (parameters.length === 0) {
			if (returnType === null) {
				return concat([text("()"), bodySpace])
			}

			return group(
				concat([
					text("()"),
					indent(concat([line, text("-> "), returnType])),
					opensBody ? ifBreak(hardline, text(" ")) : EMPTY,
				]),
			)
		}

		let suffix =
			returnType === null ? EMPTY : concat([text(" -> "), returnType])

		let first = parameters[0] as parser.ParameterNode
		let opening =
			listPosition !== null &&
			first.position.start.line > listPosition.start.line
				? this.trivia.claimTrailingOn(listPosition.start.line)
				: null

		let items = this.listItems(
			parameters,
			(parameter) => parameter.position,
			(parameter) => this.printParameter(parameter),
		)

		if (opening !== null) {
			;(items[0] as ListItem).leading.unshift(opening)
		}

		let loose =
			listPosition === null
				? []
				: this.trivia.takeBefore(listPosition.end.line)
		let { interior, commented } = this.listInterior(items, loose)

		// A trailing default that lays itself out over lines of its own is
		// joined with plain commas, so its hard breaks cannot break the header.
		// See "Parameter lists" in DEVELOPMENT.md.
		let last = parameters[parameters.length - 1] as parser.ParameterNode
		let lastPrinted = (items[items.length - 1] as ListItem).doc

		if (
			!commented &&
			last.defaultValue !== null &&
			(opensBlock(last.defaultValue) || renderFlat(lastPrinted) === null)
		) {
			return concat([
				text("("),
				join(
					text(", "),
					items.map((item) => item.doc),
				),
				text(")"),
				suffix,
				bodySpace,
			])
		}

		return concat([
			group(
				concat([
					text("("),
					indent(concat([softline, interior])),
					softline,
					text(")"),
					suffix,
				]),
				{ shouldBreak: commented },
			),
			bodySpace,
		])
	}

	// The items of a bracketed list, each with its Comments claimed before it
	// prints. See "Bracketed lists" in DEVELOPMENT.md.
	private listItems<Item>(
		items: Array<Item>,
		positionOf: (item: Item) => common.Position,
		print: (item: Item) => Doc,
	): Array<ListItem> {
		return items.map((item) => {
			let { start, end } = positionOf(item)
			let leading = this.trivia.takeBefore(start.line)
			let trailing = this.endsItsLine(end)
				? this.trivia.claimTrailingOn(end.line)
				: null

			return { doc: print(item), leading, trailing }
		})
	}

	private endsItsLine(end: common.Cursor): boolean {
		let rest = this.source.lineAt(end.line).slice(end.column - 1)
		let comment = rest.indexOf("§")
		let code = comment === -1 ? rest : rest.slice(0, comment)

		return code.trim() === "" || code.trim() === ","
	}

	// The inside of the brackets, with every Comment where it was written. Any
	// Comment sets `commented`, which keeps the list off one line.
	private listInterior(
		items: Array<ListItem>,
		loose: Array<Comment>,
		separator: Doc = line,
		keepLastComma = false,
	): { interior: Doc; commented: boolean } {
		let parts: Array<Doc> = []
		let commented = loose.length > 0

		for (let [index, item] of items.entries()) {
			let last = index === items.length - 1

			for (let comment of item.leading) {
				commented = true
				parts.push(verbatim(comment.text), hardline)
			}

			parts.push(item.doc)
			parts.push(
				last && !keepLastComma ? ifBreak(text(","), EMPTY) : text(","),
			)

			if (item.trailing !== null) {
				commented = true
				parts.push(lineSuffix(" " + item.trailing.text), breakParent)
			}

			if (!last) {
				parts.push(separator)
			}
		}

		for (let comment of loose) {
			parts.push(hardline, verbatim(comment.text))
		}

		return { interior: concat(parts), commented }
	}

	private printParameter(parameter: parser.ParameterNode): Doc {
		let { externalName, internalName, type } = parameter

		// A Pattern in the internal name's place, as in `of { width, height }:
		// Rectangle`. It is printed rather than sliced, since it lays itself out,
		// and the source says whether a `_` was written before it.
		if (internalName?.nodeType === "Pattern") {
			let parts: Array<Doc> = []

			if (externalName !== null) {
				parts.push(text(externalName.content + " "))
			} else if (
				this.source
					.slice({
						start: parameter.position.start,
						end: internalName.position.start,
					})
					.trim() !== ""
			) {
				parts.push(text("_ "))
			}

			parts.push(this.printPattern(internalName, true))

			if (type !== null) {
				parts.push(text(": "), this.printType(type))
			}

			this.printDefaultValueInto(parts, parameter)

			return concat(parts)
		}

		// An unannotated Parameter, as in `(item) { … }`, is sliced from the
		// source, since `(_ item)` parses to the same node.
		if (type === null) {
			// The Parser refuses a default on a Function literal, and the slice
			// would lose one, so it is asserted here.
			if (parameter.defaultValue !== null) {
				throw new Error(
					"A Parameter with no Type can not carry a default",
				)
			}

			return text(
				this.source.slice(parameter.position).trim() ||
					(internalName?.content ?? "_"),
			)
		}

		let name: string

		if (externalName !== null && externalName === internalName) {
			// The Parser reuses one node when the internal name is also the
			// label, so identity tells `count: Integer` from `count count:
			// Integer`.
			name = externalName.content
		} else {
			let external = externalName === null ? "_" : externalName.content

			// `on _: Integer` keeps its `_`, or the label would become a name.
			name =
				internalName === null && externalName === null
					? external
					: external + " " + (internalName?.content ?? "_")
		}

		let parts: Array<Doc> = [text(name + ": "), this.printType(type)]

		this.printDefaultValueInto(parts, parameter)

		return concat(parts)
	}

	// `= expression`, after a Parameter's Type or a Case's payload shape.
	private printDefaultValueInto(
		parts: Array<Doc>,
		written: { defaultValue: parser.ExpressionNode | null },
	): void {
		let { defaultValue } = written

		if (defaultValue === null) {
			return
		}

		parts.push(text(" = "), this.printHeldExpression(defaultValue))
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

		// Breaks as a Parameter list does, but only once the Parameter list
		// after it has given way. See "Parameter lists" in DEVELOPMENT.md.
		return group(
			concat([
				text("<"),
				indent(
					concat([
						softline,
						join(concat([text(","), line]), parts),
						ifBreak(text(","), EMPTY),
					]),
				),
				softline,
				text(">"),
			]),
		)
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

			// One space, then the operand, which takes the whole postfix chain
			// after it. Essence has no grouping parentheses, so a call on the
			// result is written by binding it first, and none are ever needed.
			case "Start":
				return concat([
					text("start "),
					this.printExpression(node.expression),
				])

			case "Complete":
				return concat([
					text("complete "),
					this.printExpression(node.expression),
				])

			case "Combination":
				return this.printCombination(node)

			case "Match":
				return this.printMatch(node)

			case "Define":
				return this.printDefine(node)

			case "CaseValue":
				return this.printCaseValue(node)

			case "MemberPath":
				return text(
					"." + node.steps.map((step) => step.content).join("."),
				)

			// Only in a tree the Parser reported an error on, which is never
			// formatted. The brackets it was refused for are not in the tree.
			case "RefusedValue":
				return this.printExpression(node.base)

			default:
				return this.printValue(node)
		}
	}

	// A chain, with `brokenSuffix` in place of `suffix` when it breaks.
	// See "Method chains" in DEVELOPMENT.md.
	private printMethodChain(
		node: parser.MethodInvocationNode,
		suffix: Doc = EMPTY,
		brokenSuffix: Doc = suffix,
	): Doc {
		let links = chainLinks(node)
		let current: parser.ExpressionNode = (
			links[0] as parser.MethodInvocationNode
		).base

		let head = this.printExpression(current)

		// Kept for a chain of one link, which lays its link out itself. Built in
		// this one walk, since printing the Arguments moves the trivia cursor.
		let linkParts: Array<{
			name: Doc
			arguments: ReturnType<Printer["argumentList"]>
		}> = []

		let items = this.listItems(
			links,
			(link) => ({
				start: link.member.position.start,
				end: link.position.end,
			}),
			(link) => {
				let specifier =
					link.namespaceSpecifier === null
						? ""
						: "<" + link.namespaceSpecifier.content + ">"
				let name = text("::" + specifier + link.member.content)
				let listed = this.argumentList(link.arguments)

				linkParts.push({ name, arguments: listed })

				return concat([name, listed.doc])
			},
		)

		let commented = items.some(
			(item) => item.leading.length > 0 || item.trailing !== null,
		)

		// A chain of one link on a head that is not a name is offered three
		// layouts. See "Method chains" in DEVELOPMENT.md.
		if (items.length === 1 && !commented) {
			let link = (items[0] as ListItem).doc
			let fused = concat([head, link, suffix])

			if (isName(current)) {
				return fused
			}

			let { name, arguments: listed } = linkParts[0]!

			// Measured with the Arguments hugged when a callback or a `match`
			// closes them, since a nested `conditional` measures flat from
			// outside. A trailing Record or List does not count.
			let last = links[0]!.arguments[links[0]!.arguments.length - 1]
			let fusedHugged =
				listed.hugged !== null &&
				last !== undefined &&
				opensBlock(last.value)
					? concat([head, name, listed.hugged, suffix])
					: fused

			// A `conditional` stops a hard break, so a chain over several lines
			// tells the list holding it with a `breakParent`. See "Argument
			// lists" in DEVELOPMENT.md.
			let breaks = renderFlat(head) === null || listed.breaks

			return concat([
				breaks ? breakParent : EMPTY,
				conditionalGroup([
					fusedHugged,
					concat([
						head,
						expand(
							concat([
								indent(concat([hardline, link])),
								brokenSuffix,
							]),
						),
					]),
					fused,
				]),
			])
		}

		let first = items[0] as ListItem

		let headWidth = renderFlat(head)

		// A short head keeps its first link, unless that link lays out over
		// several lines. A bare `@` keeps it regardless.
		if (
			first.leading.length === 0 &&
			headWidth !== null &&
			stringWidth(headWidth) <= TAB_WIDTH &&
			(current.nodeType === "Self" || renderFlat(first.doc) !== null)
		) {
			head = concat([head, first.doc])

			if (first.trailing !== null) {
				head = concat([
					head,
					lineSuffix(" " + first.trailing.text),
					breakParent,
				])
			}

			items = items.slice(1)
		}

		let linkDocs = items.map((item) => {
			let parts: Array<Doc> = [softline]

			for (let comment of item.leading) {
				parts.push(verbatim(comment.text), hardline)
			}

			parts.push(item.doc)

			if (item.trailing !== null) {
				parts.push(lineSuffix(" " + item.trailing.text), breakParent)
			}

			return concat(parts)
		})

		return group(
			concat([
				head,
				indent(concat(linkDocs)),
				ifBreak(brokenSuffix, suffix),
			]),
			{ shouldBreak: commented },
		)
	}

	// A call's Arguments, one per line when they break, with a trailing block
	// hugged. See "Argument lists" in DEVELOPMENT.md.
	private printArgumentList(argumentNodes: Array<parser.ArgumentNode>): Doc {
		return this.argumentList(argumentNodes).doc
	}

	// The list's layouts, kept apart for a chain of one link. The `hugged`
	// layout is null where nothing hugs, and `breaks` says an Argument holds a
	// hard break.
	private argumentList(argumentNodes: Array<parser.ArgumentNode>): {
		doc: Doc
		hugged: Doc | null
		broken: Doc
		breaks: boolean
	} {
		if (argumentNodes.length === 0) {
			let doc = text("()")

			return { doc, hugged: null, broken: doc, breaks: false }
		}

		let items = this.listItems(
			argumentNodes,
			(argument) => ({
				start: (argument.name ?? argument.value).position.start,
				end: argument.value.position.end,
			}),
			(argument) => {
				let value = this.printHeldExpression(argument.value)

				return argument.name === null
					? value
					: concat([text(argument.name.content + " "), value])
			},
		)
		let { interior, commented } = this.listInterior(items, [])

		let broken = group(
			concat([
				text("("),
				indent(concat([softline, interior])),
				softline,
				text(")"),
			]),
			{ shouldBreak: commented },
		)

		let last = argumentNodes[
			argumentNodes.length - 1
		] as parser.ArgumentNode

		let docs = items.map((item) => item.doc)

		// A Record or List hugs after other Arguments only when all of them
		// read on one line, or it would write `}, fallback {})`.
		let earlierFlat = docs
			.slice(0, -1)
			.every((doc) => renderFlat(doc) !== null)

		if (
			commented ||
			!(
				opensBlock(last.value) ||
				(isBlockLike(last.value) && earlierFlat)
			)
		) {
			return { doc: broken, hugged: null, broken, breaks: false }
		}
		let hugged = concat([
			text("("),
			join(text(", "), docs.slice(0, -1)),
			docs.length > 1 ? text(", ") : EMPTY,
			expand(docs[docs.length - 1] as Doc),
			text(")"),
		])

		// A `conditional` stops a hard break, so the call tells the list
		// holding it with a `breakParent`. See "Argument lists" in
		// DEVELOPMENT.md.
		let breaks = docs.some((doc) => renderFlat(doc) === null)

		return {
			doc: concat([
				breaks ? breakParent : EMPTY,
				conditionalGroup([hugged, broken]),
			]),
			hugged,
			broken,
			breaks,
		}
	}

	// The brackets come from the node, since `[d with other]` and `{ record
	// with other }` mean different things.
	private printCombination(node: parser.CombinationNode): Doc {
		let brackets = node.brackets === true
		// Whether the right side is the update's own key list, as in `[ages
		// with "kim" = 7]`, or a whole value, as in `[ages with ["kim" = 7]]`.
		// Only the Parser knows, since a bare key list's Position starts at its
		// first key.
		let bare = node.bare === true

		// Too wide for its line, a Combination opens like a Record, with the
		// overridden members indented after the `with`. A braced right side
		// lays itself out after the `with`.
		let right = bare
			? indent(
					concat([
						line,
						node.rhs.nodeType === "DictionaryValue"
							? this.dictionaryInterior(node.rhs).interior
							: this.recordInterior(
									node.rhs as parser.RecordValueNode,
									onlyKeyIsBare(
										node.rhs as parser.RecordValueNode,
									),
								).interior,
					]),
				)
			: concat([text(" "), this.printExpression(node.rhs)])

		// Brackets hold no padding and braces do, as in the literals
		// `["a", "b"]` and `{ a = 1, b = 2 }`.
		let opening = brackets ? softline : line

		return group(
			concat([
				text(brackets ? "[" : "{"),
				indent(
					concat([
						opening,
						this.printExpression(node.lhs),
						text(" with"),
						right,
					]),
				),
				opening,
				text(brackets ? "]" : "}"),
			]),
		)
	}

	// A `match`, its Handlers' `{` aligned. A `hugged` one keeps its head on one
	// line. See "Match" in DEVELOPMENT.md.
	private printMatch(node: parser.MatchNode, hugged = false): Doc {
		let entries: Array<Entry> = []
		let run = alignmentRun(UNBLOCKED_ALIGNMENT, { partedByBreaks: true })

		// Claimed before the Handlers, or the first Handler's `takeBefore`
		// would stall on it and it would end up after the whole `match`.
		let opening = this.trivia.claimTrailingOn(
			this.braceLine(
				node.position.start.line,
				node.handlers[0]?.matcher.position.start.line ?? null,
				node.position.end.line,
			),
		)

		let closeRun = () => {
			run = alignmentRun(UNBLOCKED_ALIGNMENT, { partedByBreaks: true })
		}

		for (let [index, handler] of node.handlers.entries()) {
			let startLine = handler.matcher.position.start.line
			let endLine = handlerEndLine(handler)

			// The Handler's own `}` line, found in the source, since a Handler
			// has no Position. A Comment trailing it belongs to the Handler.
			let next = node.handlers[index + 1]
			let closeLine =
				this.source.closingBraceLine(
					endLine + 1,
					(next?.matcher.position.start.line ??
						node.position.end.line) - 1,
				) ?? endLine

			for (let comment of this.trivia.takeBefore(startLine)) {
				entries.push(this.commentEntry(comment))
			}

			let trailing = this.trivia.claimTrailingOn(closeLine)

			let matcher = this.printMatcher(handler.matcher)
			// A flat width, not a measured flat rendering, since a Matcher
			// holding a String written across lines has no width.
			let matcherWidth = flatWidth(matcher)
			let padding = alignmentSlot()

			let guard =
				handler.guard === null
					? null
					: concat([
							text("where "),
							this.printExpression(handler.guard),
						])

			let {
				entries: bodyEntries,
				opening: bodyOpening,
				flatAllowed,
			} = this.bodyEntries(
				handler.body,
				handler.matcher.position.end.line,
				closeLine,
			)
			// The padding is inside the body's group, so the flat shape is
			// measured with it.
			let body = this.block(
				bodyEntries,
				null,
				flatAllowed,
				bodyOpening,
				padding,
				false,
			)

			// A guard too wide for the Handler's line moves down whole, and the
			// `{` takes a line of its own.
			let doc =
				guard === null
					? concat([text("case "), matcher, text(" "), body])
					: this.headWithTail(
							concat([text("case "), matcher]),
							guard,
							body,
							this.block(
								bodyEntries,
								null,
								false,
								bodyOpening,
								padding,
							),
						)

			if (trailing !== null) {
				doc = concat([doc, lineSuffix(" " + trailing.text)])
			}

			entries.push({ startLine, endLine: closeLine, doc })

			// A guarded Handler, or one that can never print flat, ends the
			// run. One that does not fit is for the run to take out.
			// See "Match" in DEVELOPMENT.md.
			let bodyWidth = flatWidth(body)

			if (
				handler.guard === null &&
				matcherWidth !== null &&
				bodyWidth !== null
			) {
				joinAlignment(run, padding, {
					headWidth: matcherWidth,
					fitWidth:
						stringWidth("case ") + matcherWidth + 1 + bodyWidth,
				})
			} else {
				closeRun()
			}
		}

		closeRun()

		this.flushBefore(node.position.end.line, entries)

		// A head too wide for its line breaks before the `->`, not inside the
		// value. See "Heads with a closing clause" in DEVELOPMENT.md.
		let head = concat([text("match "), this.printExpression(node.value)])
		let tail = concat([text("-> "), this.printType(node.returnType)])

		// The block stays outside the head's layouts, so that its hard breaks
		// reach the callback or Handler holding the `match`.
		return concat([
			hugged
				? concat([head, text(" "), tail, text(" ")])
				: this.headWithTail(head, tail, EMPTY),
			this.block(entries, null, false, opening),
		])
	}

	// An Expression held by something, where a `match` is `hugged`.
	private printHeldExpression(node: parser.ExpressionNode): Doc {
		return node.nodeType === "Match"
			? this.printMatch(node, true)
			: this.printExpression(node)
	}

	// A head, the clause that closes it and the block they open, as in
	// `match value -> Type {` or `case matcher where guard {`.
	// See "Heads with a closing clause" in DEVELOPMENT.md.
	private headWithTail(
		head: Doc,
		tail: Doc,
		body: Doc,
		brokenBody: Doc = body,
	): Doc {
		let fused = concat([head, text(" "), tail, text(" "), expand(body)])
		let fusedBroken =
			brokenBody === body
				? fused
				: concat([head, text(" "), tail, text(" "), expand(brokenBody)])

		return conditionalGroup([
			fused,
			fusedBroken,
			concat([
				head,
				expand(
					concat([
						indent(concat([hardline, tail])),
						hardline,
						brokenBody,
					]),
				),
			]),
			fusedBroken,
		])
	}

	// One arm per line, the `if` of adjacent arms in one column.
	// See "Define" in DEVELOPMENT.md.
	private printDefine(node: parser.DefineNode): Doc {
		let entries: Array<Entry> = []
		let run = alignmentRun(MAX_ALIGNMENT_PADDING)

		let closeRun = () => {
			run = alignmentRun(MAX_ALIGNMENT_PADDING)
		}

		// Claimed before the arms, or the first arm's `takeBefore` would stall
		// on it and it would end up after the whole `define`.
		let opening = this.trivia.claimTrailingOn(
			this.braceLine(
				node.position.start.line,
				node.arms[0]?.position.start.line ??
					node.otherwise.position.start.line,
				node.position.end.line,
			),
		)

		// A function rather than a Doc, so the arm's Comments are claimed
		// before anything inside it prints. The arm places the padding it is
		// handed.
		let pushArm = (
			position: common.Position,
			write: (padding: AlignDoc) => {
				doc: Doc
				// The arm's widths for the run, or `"ends"` where the arm
				// ends the table and the next arms start a run of their own.
				column: AlignmentItem | "ends"
			},
		) => {
			for (let comment of this.trivia.takeBefore(position.start.line)) {
				entries.push(this.commentEntry(comment))
			}

			let trailing = this.trivia.claimTrailingOn(position.end.line)
			let padding = alignmentSlot()
			let written = write(padding)
			let doc = written.doc

			// An answer that opens a block ends the run. An arm that is only
			// too wide joins it, and the run takes it out.
			if (written.column === "ends") {
				closeRun()
			} else {
				joinAlignment(run, padding, written.column)
			}

			if (trailing !== null) {
				doc = concat([doc, lineSuffix(" " + trailing.text)])
			}

			entries.push({ ...positionLines(position), doc })
		}

		for (let arm of node.arms) {
			pushArm(arm.position, (padding) => {
				let answer = this.printExpression(arm.value)
				let headWidth = flatWidth(concat([text("as "), answer]))
				let condition = this.printExpression(arm.condition)

				// An answer over several lines keeps its `if` after the brace
				// it closes with, as in `} if …`.
				if (headWidth === null) {
					return {
						doc: concat([
							text("as "),
							answer,
							text(" if "),
							condition,
						]),
						column: "ends",
					}
				}

				// A condition over several lines keeps its `if` on the answer's
				// line, and the arm stays in the run.
				let conditionWidth = flatWidth(condition)

				if (conditionWidth === null) {
					return {
						doc: concat([
							text("as "),
							answer,
							padding,
							text(" if "),
							condition,
						]),
						// Only the answer and the `if`, since an answer too
						// wide for that carries the `if` away from the column.
						column: {
							headWidth,
							fitWidth: headWidth + stringWidth(" if "),
						},
					}
				}

				// An arm too long for its line breaks before its `if`. The run
				// decides which arms break, and leaves those unpadded.
				return {
					doc: group(
						concat([
							text("as "),
							answer,
							padding,
							indent(concat([line, text("if "), condition])),
						]),
					),
					column: {
						headWidth,
						fitWidth:
							headWidth + stringWidth(" if ") + conditionWidth,
					},
				}
			})
		}

		// `otherwise` never breaks from its answer, since moving one keyword
		// down buys no room.
		pushArm(node.otherwise.position, (padding) => {
			let answer = this.printExpression(node.otherwise.value)
			let headWidth = flatWidth(concat([text("as "), answer]))

			// An answer that breaks carries `otherwise` away from the column,
			// so the run takes the arm out. One that opens a block ends the run.
			return {
				doc: concat([text("as "), answer, padding, text(" otherwise")]),
				column:
					headWidth === null
						? "ends"
						: {
								headWidth,
								fitWidth: headWidth + stringWidth(" otherwise"),
							},
			}
		})

		closeRun()

		this.flushBefore(node.position.end.line, entries)

		return concat([
			text("define"),
			node.returnType === null
				? EMPTY
				: concat([text(" -> "), this.printType(node.returnType)]),
			text(" "),
			this.block(entries, null, false, opening),
		])
	}

	// Never broken, like a Type application. The `#` has to stay against the
	// `>` for the construction to be read as one.
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

		// A braced payload hugs its parentheses through any wrapping Cases, so
		// `}))` closes the stack without a staircase. One that opens a block
		// hugs only while its head fits. Anything else is one Argument, without
		// the trailing comma the grammar refuses.
		if (node.value !== null) {
			let value = this.printHeldExpression(node.value)
			let listed = group(
				concat([
					text("("),
					indent(concat([softline, value])),
					softline,
					text(")"),
				]),
			)

			if (!hugsPayload(node.value)) {
				parts.push(listed)
			} else if (!opensBlock(node.value)) {
				parts.push(text("("), value, text(")"))
			} else {
				parts.push(
					renderFlat(value) === null ? breakParent : EMPTY,
					conditionalGroup([
						concat([text("("), expand(value), text(")")]),
						listed,
					]),
				)
			}
		}

		return concat(parts)
	}

	// #endregion

	// #region Values

	private printValue(node: parser.ValueNode): Doc {
		switch (node.nodeType) {
			// Sliced from the source, since the tree turns `1_000` into `1000`,
			// records `0.75` as the fraction 75/100 and decodes a String's
			// escapes. Verbatim, since a multi-line String's trailing spaces
			// belong to the value.
			case "IntegerValue":
			case "RationalValue":
			case "StringValue":
				return verbatim(this.source.slice(node.position))

			case "InterpolatedStringValue":
				return this.printInterpolatedString(node)

			case "BooleanValue":
				return text(node.value ? "true" : "false")

			case "RecordValue":
				return this.printRecord(node)

			case "ListValue":
				return this.printList(node)

			case "DictionaryValue":
				return this.printDictionary(node)

			case "FunctionValue":
				return this.printFunctionDefinition(
					node.value,
					node.position,
					true,
				)
		}
	}

	// The text sliced from the source, and each hole printed as its Expression.
	// See "Interpolated Strings" in DEVELOPMENT.md.
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

			// Anything but whitespace between a brace and what it holds is a
			// Comment in the hole. Then the String is written back whole.
			if (before === null) {
				return verbatim(this.source.slice(node.position))
			}

			parts.push(verbatim(before), this.printHole(segment.expression))

			cursor = hole.end
			closing = true
		}

		let written = this.source.slice({
			start: cursor,
			end: node.position.end,
		})
		let tail = holeText(written, closing, false)

		if (tail === null) {
			return verbatim(this.source.slice(node.position))
		}

		parts.push(verbatim(tail))

		return concat(parts)
	}

	// A hole with its braces, which break only where that helps.
	// See "Interpolated Strings" in DEVELOPMENT.md.
	private printHole(expression: parser.ExpressionNode): Doc {
		let doc = this.printExpression(expression)
		let flat = renderFlat(doc)

		if (flat === null) {
			return concat([text("{"), doc, text("}")])
		}

		if (isName(expression)) {
			return text("{" + flat + "}")
		}

		return group(
			concat([
				text("{"),
				indent(concat([softline, text(flat)])),
				softline,
				text("}"),
			]),
			{ breakIfTailFits: text("}") },
		)
	}

	private printRecord(node: parser.RecordValueNode): Doc {
		let members = Object.values(node.members)

		// `Type ~> { a = b }` is one typed Record, while `Type { a = b }` parses
		// as a name and then an untyped Record. The prefix stays outside the
		// group, so it never breaks from its brace.
		let prefix =
			node.type === null
				? EMPTY
				: concat([this.printType(node.type), text(" ~> ")])

		if (members.length === 0) {
			return concat([prefix, text("{}")])
		}

		let { interior, commented } = this.recordInterior(node)

		return group(
			concat([
				prefix,
				text("{"),
				indent(concat([line, interior])),
				line,
				text("}"),
			]),
			{ shouldBreak: commented, expandable: true },
		)
	}

	// Members keep their spelling: `a = a` never becomes `a` or the other way,
	// and the path keys `a.b = 1, a.c = 2` are never gathered up.
	private recordInterior(
		node: parser.RecordValueNode,
		// Whether the last comma stays where the list fits on one line.
		keepLastComma = false,
	): {
		interior: Doc
		commented: boolean
	} {
		let items = this.listItems(
			Object.values(node.members),
			(member) => ({
				start: member.name.position.start,
				end: (member.value ?? member.group!).position.end,
			}),
			(member) => this.printRecordMember(member),
		)

		return this.listInterior(
			items,
			this.trivia.takeBefore(node.position.end.line),
			line,
			keepLastComma,
		)
	}

	// A Record member as it was spelled: a bare name, `key = value`, or a braced
	// descend, which lays out as a Record does.
	private printRecordMember(member: parser.RecordValueMemberNode): Doc {
		if (member.group !== undefined) {
			let descend = member.group

			if (Object.keys(descend.members).length === 0) {
				return text(memberKey(member) + ".{}")
			}

			let { interior, commented } = this.recordInterior(descend)

			return group(
				concat([
					text(memberKey(member) + ".{"),
					indent(concat([line, interior])),
					line,
					text("}"),
				]),
				{ shouldBreak: commented, expandable: true },
			)
		}

		if (member.shorthand === true) {
			return text(memberKey(member))
		}

		return concat([
			text(memberKey(member) + " = "),
			this.printExpression(member.value!),
		])
	}

	// A List of nothing but atoms, such as Numbers, Booleans or bare Cases, is
	// filled, as many to a line as fit. Any other List, or one holding a
	// Comment, breaks one item per line.
	private printList(node: parser.ListValueNode): Doc {
		if (node.values.length === 0) {
			return text("[]")
		}

		let items = this.listItems(
			node.values,
			(value) => value.position,
			(value) => this.printExpression(value),
		)
		let loose = this.trivia.takeBefore(node.position.end.line)
		let { interior, commented } = this.listInterior(items, loose)

		if (!commented && node.values.every((value) => isAtom(value))) {
			let filled: Array<Doc> = []

			for (let [index, item] of items.entries()) {
				if (index > 0) {
					filled.push(concat([text(","), line]))
				}

				filled.push(item.doc)
			}

			interior = concat([fill(filled), ifBreak(text(","), EMPTY)])
		}

		return group(
			concat([
				text("["),
				indent(concat([softline, interior])),
				softline,
				text("]"),
			]),
			{ shouldBreak: commented, expandable: true },
		)
	}

	// A Dictionary breaks one entry per line and never fills, since an entry is
	// two values and a `=`. The empty one prints as `[=]`, which the `=` tells
	// apart from the empty List.
	private printDictionary(node: parser.DictionaryValueNode): Doc {
		if (node.entries.length === 0) {
			return text("[=]")
		}

		let { interior, commented } = this.dictionaryInterior(node)

		return group(
			concat([
				text("["),
				indent(concat([softline, interior])),
				softline,
				text("]"),
			]),
			{ shouldBreak: commented, expandable: true },
		)
	}

	// The entries without the brackets, which the literal and an update each
	// write for themselves, as with `recordInterior`.
	private dictionaryInterior(node: parser.DictionaryValueNode): {
		interior: Doc
		commented: boolean
	} {
		let items = this.listItems(
			node.entries,
			(entry) => entry.position,
			(entry) => this.printDictionaryEntry(entry),
		)

		return this.listInterior(
			items,
			this.trivia.takeBefore(node.position.end.line),
		)
	}

	// `key = value`, both printed, since a key is an Expression like any other.
	private printDictionaryEntry(entry: parser.DictionaryEntryNode): Doc {
		return concat([
			this.printExpression(entry.key),
			text(" = "),
			this.printExpression(entry.value),
		])
	}

	// #endregion

	// #region Matchers

	// `breakable` is what `printPattern` takes: false where the Matcher
	// heads a Handler and its width holds a column open, true on a `require`.
	printMatcher(node: parser.MatcherNode, breakable = false): Doc {
		switch (node.nodeType) {
			case "WildcardMatcher":
				return text("_")

			case "LiteralMatcher":
				return this.printValue(node.value)

			case "CaseMatcher": {
				// The payload binder stays on the Matcher's line, since
				// `case #Value(item)` reads as one thing and counts toward the
				// Matcher's width in the `match` alignment.
				let head = text(
					(node.choice === null ? "" : node.choice.content) +
						"#" +
						node.caseName.content,
				)

				if (node.binding === null) {
					return head
				}

				return concat([
					head,
					text("("),
					node.binding.nodeType === "Pattern"
						? this.printPattern(node.binding, breakable)
						: text(node.binding.content),
					text(")"),
				])
			}

			case "Pattern":
				return this.printPattern(node, breakable)

			default:
				return this.printType(node)
		}
	}

	// #endregion

	// #region Patterns

	// One Pattern, as written, in any position that takes a value apart. It
	// stays flat unless `breakable`. See "Patterns" in DEVELOPMENT.md.
	private printPattern(node: parser.PatternNode, breakable: boolean): Doc {
		let members = Object.values(node.members)

		// Outside the group, so that `as name` never breaks from its brace.
		let binder =
			node.binder === null ? EMPTY : text(" as " + node.binder.content)

		if (members.length === 0) {
			return concat([text("{}"), binder])
		}

		let doc = group(
			concat([
				text("{"),
				indent(
					concat([
						line,
						join(
							concat([text(","), line]),
							members.map((member) =>
								this.printPatternMember(member, breakable),
							),
						),
						ifBreak(text(","), EMPTY),
					]),
				),
				line,
				text("}"),
				binder,
			]),
		)

		return breakable ? doc : flattened(doc)
	}

	// `name` binds, `name: Type` also constrains the Type, `name = literal`
	// constrains the value and binds nothing, and `as` rebinds or nests. Each
	// prints only what the node records.
	private printPatternMember(
		member: parser.PatternMemberNode,
		breakable: boolean,
	): Doc {
		if (member.kind === "Value") {
			return concat([
				text(member.name.content + " = "),
				this.printValue(member.value),
			])
		}

		let parts: Array<Doc> = [text(member.name.content)]

		if (member.type !== null) {
			parts.push(text(": "), this.printType(member.type))
		}

		if (member.binder !== null) {
			parts.push(
				text(" as "),
				member.binder.nodeType === "Pattern"
					? this.printPattern(member.binder, breakable)
					: text(member.binder.content),
			)
		}

		return concat(parts)
	}

	// #endregion

	// #region Types

	printType(node: parser.TypeDeclarationNode): Doc {
		switch (node.nodeType) {
			case "IdentifierTypeDeclaration":
				return text(node.type.content)

			case "RecordTypeDeclaration":
				return this.printRecordType(node)

			// The last resort for a Union too wide for a line of its own,
			// since a Parameter list gives way first. The indent keeps it
			// apart from a block that opens after it.
			case "UnionTypeDeclaration":
				return group(
					indent(
						join(
							concat([line, text("| ")]),
							node.types.map((member) => this.printType(member)),
						),
					),
				)

			// Laid out like a Parameter list, with `) -> Type` whole after
			// the last Parameter.
			case "FunctionTypeDeclaration":
				return group(
					concat([
						text("("),
						indent(
							concat([
								softline,
								join(
									concat([text(","), line]),
									node.parameterTypes.map((parameter) =>
										concat([
											text(
												this.functionTypeParameterName(
													parameter,
												) + ": ",
											),
											this.printType(parameter.type),
										]),
									),
								),
								ifBreak(text(","), EMPTY),
							]),
						),
						softline,
						text(") -> "),
						this.printType(node.returnType),
					]),
				)

			// Never broken, since the Parser reads a `<` that opens a line as
			// the start of a new declaration.
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

	// Everything before the `:`, verbatim, such as `_`, `_ rootTwo` or `label`.
	// The node keeps only the external name.
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

	// A Union too wide for its alias's line keeps its first member on the `=`
	// line. While the head reads on one line, each later `|` stands under `=`:
	//
	//     type Quote = Priced
	//                | Rejected
	private printAliasedType(node: parser.TypeDeclarationNode, head: Doc): Doc {
		let headWidth = flatWidth(head)

		if (node.nodeType !== "UnionTypeDeclaration" || headWidth === null) {
			return this.printType(node)
		}

		let column = ifBreak(text(" ".repeat(headWidth + 1)), EMPTY)

		return group(
			join(
				concat([line, column, text("| ")]),
				node.types.map((member) => this.printType(member)),
			),
		)
	}

	private printRecordType(node: parser.RecordTypeDeclarationNode): Doc {
		let members = Object.values(node.members)

		if (members.length === 0) {
			return text("{}")
		}

		let items = this.listItems(
			members,
			(member) => ({
				start: member.name.position.start,
				end: member.type.position.end,
			}),
			(member) =>
				concat([
					text(member.name.content + ": "),
					this.printType(member.type),
				]),
		)
		let { interior, commented } = this.listInterior(
			items,
			this.trivia.takeBefore(node.position.end.line),
		)

		return group(
			concat([
				text("{"),
				indent(concat([line, interior])),
				line,
				text("}"),
			]),
			{ shouldBreak: commented },
		)
	}

	// #endregion
}

// One item of a bracketed list with the Comments written around it.
type ListItem = {
	doc: Doc
	leading: Array<Comment>
	trailing: Comment | null
}

// The links of `a::b()::c()`, outermost last, since the tree nests them the
// other way round.
function chainLinks(
	node: parser.MethodInvocationNode,
): Array<parser.MethodInvocationNode> {
	let links: Array<parser.MethodInvocationNode> = []
	let current: parser.ExpressionNode = node

	while (current.nodeType === "MethodInvocation") {
		links.unshift(current)
		current = current.base
	}

	return links
}

// A signature carries no Position for its Parameter list; the `(` is
// where the signature starts and the `)` is on the return Type's line.
function signatureListPosition(
	signature:
		| parser.NativeMethodSignatureNode
		| parser.ProtocolMethodSignatureNode,
): common.Position {
	return {
		start: signature.position.start,
		end: signature.returnType.position.start,
	}
}

function isNumberLiteral(node: parser.ExpressionNode): boolean {
	return node.nodeType === "IntegerValue" || node.nodeType === "RationalValue"
}

// A bare name, or member reads on one such as `game.board.cells`, with no call
// in it.
function isName(node: parser.ExpressionNode): boolean {
	return (
		node.nodeType === "Identifier" ||
		node.nodeType === "Self" ||
		(node.nodeType === "Lookup" && isName(node.base))
	)
}

// A value with nothing inside it to lay out, the kind a List fills. A Case
// with a payload is not one, since `#Value(1)` reads as a thing.
function isAtom(node: parser.ExpressionNode): boolean {
	return (
		isNumberLiteral(node) ||
		node.nodeType === "BooleanValue" ||
		(node.nodeType === "CaseValue" && node.value === null)
	)
}

type AssignmentNode =
	| parser.ConstantDeclarationStatementNode
	| parser.VariableDeclarationStatementNode
	| parser.VariableAssignmentStatementNode

// How wide a Doc reads on one line. Null when it cannot be on one line, or
// holds a multi-line String, whose flat rendering reaches no real column.
function flatWidth(doc: Doc): number | null {
	let written = renderFlat(doc)

	return written === null || written.includes("\n")
		? null
		: stringWidth(written)
}

// The Statements written as `… = …`, which alignment runs are made of. A
// `type` alias is left out, or a Type's name would share a value's column.
function assignmentOf(node: parser.TestsNode): AssignmentNode | null {
	switch (node.nodeType) {
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
		case "VariableAssignmentStatement":
			return node

		default:
			return null
	}
}

// The String's text in a slice between holes, without the braces the Printer
// writes itself. The `}` closing a hole is the first one written, and the `{`
// opening the next is the last. So escaped braces in the text are left alone.
// Null when more than whitespace stands between a brace and its hole.
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

// A Declaration and a bare reassignment never share a run.
// See "Aligned columns" in DEVELOPMENT.md.
function assignmentKind(node: AssignmentNode): AssignmentKind {
	return node.nodeType === "VariableAssignmentStatement"
		? "assignment"
		: "declaration"
}

// One name of a Module section with the Comments that move with it when the
// section is sorted. Its `written` is its place in written order.
type SectionEntry = {
	node: parser.ImportNode | parser.ExportNode
	leading: Array<Comment>
	trailing: Comment | null
	written: number
}

// One group with the Comments that move with it: before its `from` line, after
// its `{`, after its last name, and after its `}`.
type SectionGroup = {
	node: parser.ImportGroupNode | parser.ExportGroupNode
	leading: Array<Comment>
	opening: Comment | null
	entries: Array<SectionEntry>
	loose: Array<Comment>
	closing: Comment | null
	written: number
}

// A name or a group as its sorted list lays it out.
type SectionMember = {
	node: { position: common.Position }
	leading: Array<Comment>
	written: number
	doc: Doc
}

function entryHead(entry: parser.ImportNode | parser.ExportNode): string {
	return entry.alias === null
		? entry.name.content
		: entry.name.content + " as " + entry.alias.content
}

// A section's bare entries and groups in written order, the order their
// Comments are claimed in. An import section has only groups, in order.
function writtenMembers(
	section: parser.ImportSectionNode | parser.ExportSectionNode,
): Array<parser.ExportNode | parser.ImportGroupNode | parser.ExportGroupNode> {
	if (section.nodeType === "ImportSection") {
		return section.groups
	}

	let members: Array<parser.ExportNode | parser.ExportGroupNode> = [
		...section.entries.filter((entry) => entry.source === null),
		...section.groups,
	]

	return members.sort(
		(left, right) =>
			left.position.start.line - right.position.start.line ||
			left.position.start.column - right.position.start.column,
	)
}

// What `compareGroups` orders a group by, read off the Printer's group, whose
// entries are sorted by then.
function groupHead(group: SectionGroup) {
	return {
		source: group.node.source,
		entries: group.entries.map((entry) => entry.node),
	}
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
			// A provided Method ends at its closing brace, since the Comments
			// in its block are claimed against these lines.
			return protocolSignatureEndLine(method.signature)

		default: {
			let last = method.signatures[method.signatures.length - 1]

			return last === undefined
				? method.name.position.end.line
				: protocolSignatureEndLine(last)
		}
	}
}

function protocolSignatureEndLine(
	signature: parser.ProtocolMethodSignatureNode,
): number {
	return signature.body?.position.end.line ?? signature.position.end.line
}

// An `overload` block has no Position, only its entries do, so the braces go
// around the span the entries cover.
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

// A Doc reduced to the one line it reads as, where no break may be spent. A
// Pattern always has one, and a Doc without one comes back untouched.
function flattened(doc: Doc): Doc {
	let written = renderFlat(doc)

	return written === null ? doc : text(written)
}

// How a Record Literal's key was spelled: its dotted path, or its name. A
// braced descend's key is its steps, and its braces print as a Record.
function memberKey(member: parser.RecordValueMemberNode): string {
	return member.steps === undefined
		? member.name.content
		: member.steps.map((step) => step.content).join(".")
}

// An Expression that opens a block of its own to break inside. A trailing
// Argument of this kind is offered a hug, taken if the line to its brace fits.
function opensBlock(node: parser.ExpressionNode): boolean {
	return (
		node.nodeType === "Match" ||
		node.nodeType === "Define" ||
		node.nodeType === "FunctionValue"
	)
}

// An Expression that lays itself out over several lines and closes with
// a brace of its own.
function isBlockLike(node: parser.ExpressionNode): boolean {
	return (
		node.nodeType === "Match" ||
		node.nodeType === "Define" ||
		node.nodeType === "FunctionValue" ||
		node.nodeType === "RecordValue" ||
		node.nodeType === "ListValue" ||
		node.nodeType === "DictionaryValue" ||
		node.nodeType === "Combination"
	)
}

// A Statement that ends with a block of its own, as `Entry.bodied` says. A
// `type` alias of a Record Type is not one, since it may fit on one line.
function isBodiedStatement(node: parser.TestsNode): boolean {
	switch (node.nodeType) {
		case "FunctionStatement":
		case "OverloadedFunctionStatement":
		case "NamespaceDefinitionStatement":
		case "ChoiceDeclarationStatement":
		case "ProtocolDeclarationStatement":
		case "IfStatement":
		case "IfElseStatement":
		case "Test":
		case "Suite":
			return true

		default:
			return false
	}
}

// A bare signature is one line and closes with no brace; every other
// Method opens a block, an `overload` of signatures included.
function isBodiedNamespaceMethod(
	method: parser.NamespaceMethods[string],
): boolean {
	return (
		method.nodeType !== "SimpleMethodSignature" &&
		method.nodeType !== "StaticMethodSignature"
	)
}

function isBodiedProtocolMethod(
	method: parser.ProtocolMethods[string],
): boolean {
	switch (method.nodeType) {
		case "SimpleProtocolMethod":
		case "StaticProtocolMethod":
			return method.signature.body !== null

		default:
			return true
	}
}

// Whether a Case payload hugs its parentheses: a value that closes with its
// own brace, or a Case wrapping one at any depth.
function hugsPayload(value: parser.ExpressionNode): boolean {
	return (
		isBlockLike(value) ||
		(value.nodeType === "CaseValue" &&
			value.value !== null &&
			hugsPayload(value.value))
	)
}

function handlerEndLine(handler: parser.MatchNode["handlers"][number]): number {
	let last = handler.body[handler.body.length - 1]

	return last === undefined
		? handler.matcher.position.end.line
		: last.position.end.line
}

// An update whose only key is bare, as `{ base with port, }`, keeps its comma,
// which is what tells it from `{ base with port }`, the value `port` merged in.
function onlyKeyIsBare(keys: parser.RecordValueNode): boolean {
	let members = Object.values(keys.members)

	return members.length === 1 && members[0]?.shorthand === true
}
