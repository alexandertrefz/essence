import { TAB_WIDTH, WIDTH } from "@essence-lang/formatter/doc"
import type { common, parser } from "@essence-lang/interfaces"

import { indentationOf, lineAt, overlaps } from "./geometry"
import type { CodeActionEntry, FixContext } from "./index"
import { walk } from "./lookups"

// Writes the `Generatable` conformance a property test wants after its Type,
// replacing the derived generator. A Record is drawn member by member, a
// Choice by picking a Case.
//
// Never preferred. The Quick Fix leaves a member with no known draw out, with
// a `§` line saying why. The refactoring is not offered then.

const GENERATABLE = "Generatable"
const SOURCE = "source"

// The standard library's draws from a `Randomness`, as an author writes them.
// There is no fallback: drawing an Integer for a refined `Age` would break the
// refinement.
const draws: Readonly<Record<string, Layout>> = {
	Boolean: text(`${SOURCE}::drawBoolean()`),
	Integer: callOf(`${SOURCE}::drawInteger`, ["between 0", "and 100"]),
	Rational: callOf(`${SOURCE}::drawRational`, ["between 0/1", "and 1/1"]),
	String: callOf(`${SOURCE}::drawString`, ["upTo 10"]),
}

// A declaration a value can be built of, read off the parsed source, since the
// body spells member Types and Cases as the author did.
type Buildable = {
	name: string
	node: parser.TypeAliasStatementNode | parser.ChoiceDeclarationStatementNode
}

// What this file can draw besides the standard library's draws. See "Making
// a Type Generatable" in DEVELOPMENT.md.
type Drawing = {
	// Every Alias and Choice a member's Type may name, null for one that
	// can not be drawn.
	declared: Map<string, Buildable | null>
	// The Namespace generating each Type that already conforms.
	generators: Map<string, string>
	// The declarations being drawn, so a Type holding itself is not drawn.
	drawing: Set<string>
}

export function makeGeneratableAction(
	context: FixContext,
): Array<CodeActionEntry> {
	let { diagnostic, program, lines } = context

	if (diagnostic.data?.kind !== "ungeneratable") {
		return []
	}

	let typeName = diagnostic.data.typeName
	let found = generatablesIn(program)
	// Only a Type this file declares, since the Namespace goes after its
	// declaration.
	let buildable = found.buildables.find(
		(candidate) => candidate.name === typeName,
	)

	return buildable === undefined
		? []
		: entryFor(buildable, found, lines, "quickfix", diagnostic)
}

export function makeGeneratableActions(
	program: parser.Program,
	lines: Array<string>,
	range: common.Position,
): Array<CodeActionEntry> {
	let entries: Array<CodeActionEntry> = []
	let found = generatablesIn(program)

	for (let buildable of found.buildables) {
		let line = buildable.node.name.position.start.line
		let head = {
			start: { line, column: 1 },
			end: { line, column: lineAt(lines, line).length + 1 },
		}

		if (!overlaps(head, range)) {
			continue
		}

		entries.push(
			...entryFor(buildable, found, lines, "refactor.rewrite", null),
		)
	}

	return entries
}

function entryFor(
	buildable: Buildable,
	found: Found,
	lines: Array<string>,
	kind: "quickfix" | "refactor.rewrite",
	diagnostic: (common.Diagnostic & { position: common.Position }) | null,
): Array<CodeActionEntry> {
	if (found.covered.has(buildable.name)) {
		return []
	}

	let end = buildable.node.position.end

	// The declaration must end its line, or the Namespace would push what
	// follows onto a new line.
	if (
		lineAt(lines, end.line)
			.slice(end.column - 1)
			.trim() !== ""
	) {
		return []
	}

	let indentation = indentationOf(
		lines,
		buildable.node.name.position.start.line,
	)
	let built = builtFor(buildable, found.drawing)

	// A refactoring promises code that compiles, and a member left out does
	// not.
	if (kind === "refactor.rewrite" && built.undrawable.length > 0) {
		return []
	}

	return [
		{
			title: `Make '${buildable.name}' ${GENERATABLE}`,
			kind,
			diagnosticCode: diagnostic?.code ?? null,
			diagnosticPosition: diagnostic?.position ?? null,
			// A body it could not finish leaves a Diagnostic behind.
			isPreferred: false,
			edits: [
				{
					range: { start: end, end },
					// After the declaration it is about, a blank line
					// between them.
					newText: `\n\n${namespaceFor(buildable.name, built, indentation)}`,
				},
			],
		},
	]
}

function namespaceFor(name: string, built: Built, indentation: string): string {
	let method = `${indentation}\t`
	let body = `${method}\t`
	let notes = built.undrawable
		.map(
			(member) =>
				`${body}§ No draw for '${member}' — write one, or the value below is incomplete.\n`,
		)
		.join("")

	return [
		...headLines(name, indentation),
		...signatureLines(name, method),
		notes,
		`${laidOut(built.layout, body, "<- ", "")}\n`,
		`${method}}\n`,
		// No line break after the brace: the declaration's own break
		// follows it.
		`${indentation}}`,
	].join("")
}

// The Namespace's head as the formatter breaks it: the conformance moves
// down first, then the `for` clause, and the `{` stands alone.
function headLines(name: string, indentation: string): Array<string> {
	let named = `namespace ${name}${GENERATABLE} for ${name}`
	let whole = `${named} is ${GENERATABLE} {`

	if (fits(indentation, whole)) {
		return [`${indentation}${whole}\n`]
	}

	let head = fits(indentation, named)
		? [`${indentation}${named}\n`]
		: [
				`${indentation}namespace ${name}${GENERATABLE}\n`,
				`${indentation}\tfor ${name}\n`,
			]

	return [...head, `${indentation}\tis ${GENERATABLE}\n`, `${indentation}{\n`]
}

function signatureLines(name: string, indentation: string): Array<string> {
	let whole = `static generate(from ${SOURCE}: Randomness) -> ${name} {`

	if (fits(indentation, whole)) {
		return [`${indentation}${whole}\n`]
	}

	return [
		`${indentation}static generate(\n`,
		`${indentation}\tfrom ${SOURCE}: Randomness,\n`,
		`${indentation}) -> ${name} {\n`,
	]
}

// What a body answers with, and the members it could not draw, which the `§`
// lines name.
type Built = { layout: Layout; undrawable: Array<string> }

// One Record's members: drawn where possible, named where not.
type Members = { written: Array<Entry>; undrawable: Array<string> }

// A value as the formatter lays it out. See "Making a Type Generatable" in
// DEVELOPMENT.md.
type Layout =
	| {
			kind: "text"
			text: string
			// A Case without a payload, which a List fills.
			atom?: true
	  }
	| {
			kind: "list"
			open: string
			entries: Array<Entry>
			close: string
			// A Record's braces hold a space inside them on one line.
			padded: boolean
			// Broken, a List of atoms holds as many to a line as fit.
			filled: boolean
	  }

// An entry and what is written before it on its line, such as `name = `.
type Entry = { lead: string; value: Layout }

function text(value: string): Layout {
	return { kind: "text", text: value }
}

function callOf(callee: string, args: Array<string>): Layout {
	return {
		kind: "list",
		open: `${callee}(`,
		entries: args.map((argument) => ({ lead: "", value: text(argument) })),
		close: ")",
		padded: false,
		filled: false,
	}
}

// A Record, or an empty one written whole, inside whatever wraps it.
function recordOf(entries: Array<Entry>, before = "", after = ""): Layout {
	if (entries.length === 0) {
		return text(`${before}{}${after}`)
	}

	return {
		kind: "list",
		open: `${before}{`,
		entries,
		close: `}${after}`,
		padded: true,
		filled: false,
	}
}

// A Case is chosen by `pick` over a List of every Case built, which needs no
// Match over a drawn number.
function pickOf(items: Array<Layout>): Layout {
	return {
		kind: "list",
		open: `${SOURCE}::pick(from [`,
		entries: items.map((item) => ({ lead: "", value: item })),
		close: "])",
		padded: false,
		filled: items.every(
			(item) => item.kind === "text" && item.atom === true,
		),
	}
}

function flatOf(layout: Layout): string {
	if (layout.kind === "text") {
		return layout.text
	}

	let pad = layout.padded ? " " : ""
	let entries = layout.entries
		.map((entry) => `${entry.lead}${flatOf(entry.value)}`)
		.join(", ")

	return `${layout.open}${pad}${entries}${pad}${layout.close}`
}

// One line where it fits, one entry per line otherwise, measured as the
// formatter measures, so formatting leaves the scaffold as written. Each
// entry is laid out again on its own line.
function laidOut(
	layout: Layout,
	indentation: string,
	lead: string,
	trail: string,
): string {
	let flat = `${lead}${flatOf(layout)}${trail}`

	if (layout.kind === "text" || fits(indentation, flat)) {
		return `${indentation}${flat}`
	}

	let inner = `${indentation}\t`
	let entries = layout.filled
		? filledLines(layout.entries, inner)
		: layout.entries.map((entry) =>
				laidOut(entry.value, inner, entry.lead, ","),
			)

	return [
		`${indentation}${lead}${layout.open}`,
		...entries,
		`${indentation}${layout.close}${trail}`,
	].join("\n")
}

// Atoms packed as the formatter fills them: one joins the line when it fits
// there after the one before it.
function filledLines(
	entries: Array<Entry>,
	indentation: string,
): Array<string> {
	let lines: Array<string> = []
	let current = ""

	for (let [index, entry] of entries.entries()) {
		current += flatOf(entry.value)

		let next = entries[index + 1]

		if (
			next !== undefined &&
			fits(indentation, `${current}, ${flatOf(next.value)}`)
		) {
			current += ", "
		} else {
			lines.push(`${indentation}${current},`)
			current = ""
		}
	}

	return lines
}

function fits(indentation: string, line: string): boolean {
	let width = indentation.length * TAB_WIDTH + line.length

	return width <= WIDTH
}

// The body answering a value of the declaration. The declaration counts as
// being drawn, so a member of its own Type is not.
function builtFor(buildable: Buildable, drawing: Drawing): Built {
	let { name, node } = buildable

	drawing.drawing.add(name)

	let built: Built

	if (node.nodeType === "ChoiceDeclarationStatement") {
		let { written, undrawable } = builtCases(name, node, drawing)

		built = { layout: pickOf(written), undrawable }
	} else {
		let { written, undrawable } = drawnMembers(
			node.type as parser.RecordTypeDeclarationNode,
			drawing,
		)

		built = { layout: recordOf(written), undrawable }
	}

	drawing.drawing.delete(name)

	return built
}

function drawnMembers(
	record: parser.RecordTypeDeclarationNode,
	drawing: Drawing,
): Members {
	let written: Array<Entry> = []
	let undrawable: Array<string> = []

	for (let [name, member] of Object.entries(record.members)) {
		let draw = drawOf(member.type, drawing)

		if (draw === null) {
			undrawable.push(name)
		} else {
			written.push({ lead: `${name} = `, value: draw })
		}
	}

	return { written, undrawable }
}

function builtCases(
	name: string,
	choice: parser.ChoiceDeclarationStatementNode,
	drawing: Drawing,
): { written: Array<Layout>; undrawable: Array<string> } {
	let written: Array<Layout> = []
	let undrawable: Array<string> = []

	for (let caseNode of choice.cases) {
		let head = `${name}#${caseNode.name.content}`

		// A Case whose payload declares no member, as `On {}`, refuses
		// `Signal#On({})`.
		if (
			caseNode.type === null ||
			Object.keys(caseNode.type.members).length === 0
		) {
			written.push({ kind: "text", text: head, atom: true })

			continue
		}

		let payload = drawnMembers(caseNode.type, drawing)

		// Named with its Case, since payloads may share member names.
		undrawable.push(
			...payload.undrawable.map(
				(member) => `${caseNode.name.content}.${member}`,
			),
		)

		written.push(recordOf(payload.written, `${head}(`, ")"))
	}

	return { written, undrawable }
}

// One Expression drawing a value of the Type, or null where nothing here can
// draw it. An applied or Function Type is left to the reader.
function drawOf(
	type: parser.TypeDeclarationNode,
	drawing: Drawing,
): Layout | null {
	if (type.nodeType === "RecordTypeDeclaration") {
		let { written, undrawable } = drawnMembers(type, drawing)

		return undrawable.length > 0 ? null : recordOf(written)
	}

	if (type.nodeType !== "IdentifierTypeDeclaration") {
		return null
	}

	let name = type.type.content
	let generator = drawing.generators.get(name)

	if (generator !== undefined) {
		return callOf(`${generator}.generate`, [`from ${SOURCE}`])
	}

	let declared = drawing.declared.get(name)

	if (declared === undefined) {
		return draws[name] ?? null
	}

	if (declared === null || drawing.drawing.has(name)) {
		return null
	}

	drawing.drawing.add(name)

	let draw = declaredDraw(declared, drawing)

	drawing.drawing.delete(name)

	return draw
}

function declaredDraw(declared: Buildable, drawing: Drawing): Layout | null {
	let { name, node } = declared

	if (node.nodeType === "TypeAliasStatement") {
		return drawOf(node.type, drawing)
	}

	let { written, undrawable } = builtCases(name, node, drawing)

	return undrawable.length > 0 ? null : pickOf(written)
}

type Found = {
	buildables: Array<Buildable>
	// Types whose Namespace exists already, or that conform already.
	covered: Set<string>
	drawing: Drawing
}

// The Record Aliases and Choices a value is built of, and in one walk the
// Types a `Generatable` Namespace already covers.
//
// A generic declaration is left out: `generate` takes no Argument to infer
// its Type Parameters from, so `unreachable-conformance` would refuse it. A
// refinement is left out too, since a draw cannot satisfy its predicate.
function generatablesIn(program: parser.Program): Found {
	let buildables: Array<Buildable> = []
	let covered = new Set<string>()
	let drawing: Drawing = {
		declared: new Map(),
		generators: new Map(),
		drawing: new Set(),
	}

	// A name declared twice is drawn by neither declaration, since the walk
	// can not tell which one a member's Type names. Nor is a generic or
	// refined one, passed as null.
	let declare = (name: string, buildable: Buildable | null) => {
		let { declared } = drawing

		declared.set(name, declared.has(name) ? null : buildable)
	}

	walk(program, (node) => {
		if (node.nodeType === "ChoiceDeclarationStatement") {
			let buildable =
				node.generics.length === 0
					? { name: node.name.content, node }
					: null

			declare(node.name.content, buildable)

			if (buildable !== null) {
				buildables.push(buildable)
			}

			return
		}

		if (node.nodeType === "NamespaceDefinitionStatement") {
			if (node.name.content.endsWith(GENERATABLE)) {
				covered.add(node.name.content.slice(0, -GENERATABLE.length))
			}

			let target = node.targetType

			if (
				target !== null &&
				target.nodeType === "IdentifierTypeDeclaration" &&
				node.conformsTo.some(
					(clause) => clause.protocol.content === GENERATABLE,
				)
			) {
				covered.add(target.type.content)
				drawing.generators.set(target.type.content, node.name.content)
			}

			return
		}

		if (node.nodeType !== "TypeAliasStatement") {
			return
		}

		let buildable =
			node.generics.length === 0 && node.predicate === null
				? { name: node.name.content, node }
				: null

		declare(node.name.content, buildable)

		if (
			buildable !== null &&
			node.type.nodeType === "RecordTypeDeclaration"
		) {
			buildables.push(buildable)
		}
	})

	return { buildables, covered, drawing }
}
