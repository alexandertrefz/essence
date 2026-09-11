import { TAB_WIDTH, WIDTH } from "@essence-lang/formatter/doc"
import type { common, parser } from "@essence-lang/interfaces"

import { indentationOf, lineAt, overlaps } from "./geometry"
import type { CodeActionEntry, FixContext } from "./index"
import { walk } from "./lookups"

// NOTE: The `Generatable` conformance a property test wants, written beside the
// Type it is about. A conformance REPLACES the generator a property test would
// derive from the Type, which is what a Type whose values carry an invariant no
// structure can state is for — and the half of it that can be written down here
// is the drawing: a Record filled member by member, a Choice picked a Case of.
//
// Never preferred, and rarely finished: a member this can not draw is left OUT
// of the value it builds rather than filled with something plausible, so what
// is left behind is a Diagnostic naming the member and a `§` line saying why.
// A scaffold that drew the wrong values would be worse than one that stops.

const GENERATABLE = "Generatable"
const SOURCE = "source"

// NOTE: What the standard library gives a `Randomness` to draw with, as an
// author would write it. A Type that is not one of these has no draw to spell,
// and there is deliberately no fallback: `source::drawInteger(…)` for an
// `Age` that is an Integer under a refinement would draw values the refinement
// calls impossible.
const draws: Readonly<Record<string, string>> = {
	Boolean: `${SOURCE}::drawBoolean()`,
	Integer: `${SOURCE}::drawInteger(between 0, and 100)`,
	Rational: `${SOURCE}::drawRational(between 0/1, and 1/1)`,
	String: `${SOURCE}::drawString(upTo 10)`,
}

// NOTE: A declaration a value can be BUILT of, which is the whole of what this
// writes a body for. Read off the parsed source rather than the enriched Type,
// because what goes into the body is source: the member Types as the author
// spelled them, and the Cases under the names the author gave them.
type Buildable = {
	name: string
	node: parser.TypeAliasStatementNode | parser.ChoiceDeclarationStatementNode
}

export function makeGeneratableAction(
	context: FixContext,
): Array<CodeActionEntry> {
	let { diagnostic, program, lines } = context

	if (diagnostic.data?.kind !== "ungeneratable") {
		return []
	}

	let typeName = diagnostic.data.typeName
	// NOTE: Only a Type THIS file declares. The Namespace is written beside the
	// declaration, and a Type another Module publishes has no declaration here
	// to write it beside — nor is a conformance to somebody else's Type
	// something to offer without being asked.
	let buildable = buildablesIn(program).find(
		(candidate) => candidate.name === typeName,
	)

	return buildable === undefined
		? []
		: entryFor(buildable, program, lines, "quickfix", diagnostic)
}

export function makeGeneratableActions(
	program: parser.Program,
	lines: Array<string>,
	range: common.Position,
): Array<CodeActionEntry> {
	let entries: Array<CodeActionEntry> = []

	for (let buildable of buildablesIn(program)) {
		let line = buildable.node.name.position.start.line
		let head = {
			start: { line, column: 1 },
			end: { line, column: lineAt(lines, line).length + 1 },
		}

		if (!overlaps(head, range)) {
			continue
		}

		entries.push(
			...entryFor(buildable, program, lines, "refactor.rewrite", null),
		)
	}

	return entries
}

function entryFor(
	buildable: Buildable,
	program: parser.Program,
	lines: Array<string>,
	kind: "quickfix" | "refactor.rewrite",
	diagnostic: (common.Diagnostic & { position: common.Position }) | null,
): Array<CodeActionEntry> {
	if (alreadyGeneratable(program, buildable.name)) {
		return []
	}

	let end = buildable.node.position.end

	// NOTE: Read back off the buffer, as every edit here is: a Namespace
	// written after something that is still on the declaration's line would
	// push that something onto a line of its own.
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

	return [
		{
			title: `Make '${buildable.name}' ${GENERATABLE}`,
			kind,
			diagnosticCode: diagnostic?.code ?? null,
			diagnosticPosition: diagnostic?.position ?? null,
			// NOTE: Never preferred — see the header. A body it could not
			// finish leaves a Diagnostic of its own behind.
			isPreferred: false,
			edits: [
				{
					range: { start: end, end },
					// NOTE: Under the declaration rather than at the end of the
					// section: a conformance is about ONE Type, and a reader
					// who asked for it standing on that Type's declaration
					// looks for it under the declaration. A blank line between
					// them, which is how every other pair of Statements stands.
					newText: `\n\n${namespaceFor(buildable, indentation)}`,
				},
			],
		},
	]
}

function namespaceFor(buildable: Buildable, indentation: string): string {
	let { name, node } = buildable
	let method = `${indentation}\t`
	let body = `${method}\t`
	let built =
		node.nodeType === "ChoiceDeclarationStatement"
			? pickOfCases(name, node, body)
			: recordOfMembers(
					node.type as parser.RecordTypeDeclarationNode,
					body,
				)
	let notes = built.undrawable
		.map(
			(member) =>
				`${body}§ No draw for '${member}' — write one, or the value below is incomplete.\n`,
		)
		.join("")

	return [
		`${indentation}namespace ${name}${GENERATABLE} for ${name} is ${GENERATABLE} {\n`,
		`${method}static generate(from ${SOURCE}: Randomness) -> ${name} {\n`,
		notes,
		built.text,
		`${method}}\n`,
		// NOTE: No break after the closing brace — the declaration's own line
		// break is still ahead of whatever followed it, and writing a second
		// one would leave a blank line nobody asked for at the end.
		`${indentation}}`,
	].join("")
}

// NOTE: What a body answers with, and what it could not draw. The two travel
// together because a member left out is exactly what the `§` line above the
// value has to name.
type Built = { text: string; undrawable: Array<string> }

// NOTE: One Record's members, drawn where they can be and named where they can
// not. A member left out is what makes the value incomplete, which is the hole
// the `§` line above it and the Diagnostic under it both point at.
type Members = { written: Array<string>; undrawable: Array<string> }

function drawnMembers(record: parser.RecordTypeDeclarationNode): Members {
	let written: Array<string> = []
	let undrawable: Array<string> = []

	for (let [name, member] of Object.entries(record.members)) {
		let draw = drawOf(member.type)

		if (draw === null) {
			undrawable.push(name)
		} else {
			written.push(`${name} = ${draw}`)
		}
	}

	return { written, undrawable }
}

function recordOfMembers(
	record: parser.RecordTypeDeclarationNode,
	indentation: string,
): Built {
	let { written, undrawable } = drawnMembers(record)

	return {
		text: laidOut(
			"<- {",
			written,
			"}",
			written.length === 0 ? "<- {}" : `<- { ${written.join(", ")} }`,
			indentation,
		),
		undrawable,
	}
}

// NOTE: A Case is chosen by `pick`, which is what the standard library gives a
// draw over a written List — every Case is built, and the source hands one of
// them back. `drawInteger` and a Match over the number would draw the same
// Case and need a Handler per Case to say which one it meant.
function pickOfCases(
	name: string,
	choice: parser.ChoiceDeclarationStatementNode,
	indentation: string,
): Built {
	let written: Array<string> = []
	let undrawable: Array<string> = []

	for (let caseNode of choice.cases) {
		let head = `${name}#${caseNode.name.content}`

		if (caseNode.type === null) {
			written.push(head)

			continue
		}

		let payload = drawnMembers(caseNode.type)

		// NOTE: Named by the Case it belongs to — a Choice may carry the same
		// member name in more than one payload, and a line saying `radius`
		// alone would not say which of them is missing.
		undrawable.push(
			...payload.undrawable.map(
				(member) => `${caseNode.name.content}.${member}`,
			),
		)

		written.push(
			payload.written.length === 0
				? `${head}({})`
				: `${head}({ ${payload.written.join(", ")} })`,
		)
	}

	return {
		text: laidOut(
			`<- ${SOURCE}::pick(from [`,
			written,
			"])",
			`<- ${SOURCE}::pick(from [${written.join(", ")}])`,
			indentation,
		),
		undrawable,
	}
}

// NOTE: One line where one line fits, and one entry per line where it does not
// — measured the way the Formatter measures, against its own page width and
// its own reading of a tab, so that what this writes is what a format would
// leave. A scaffold laid out differently would be rewritten the moment the file
// is saved, and every diff of it would show that rewrite instead of the change.
function laidOut(
	opening: string,
	entries: Array<string>,
	closing: string,
	flat: string,
	indentation: string,
): string {
	if (fits(indentation, flat)) {
		return `${indentation}${flat}\n`
	}

	let written = entries.map((entry) => `${indentation}\t${entry},\n`).join("")

	return `${indentation}${opening}\n${written}${indentation}${closing}\n`
}

function fits(indentation: string, text: string): boolean {
	let width = indentation.length * TAB_WIDTH + text.length

	return width <= WIDTH
}

function drawOf(type: parser.TypeDeclarationNode): string | null {
	// NOTE: A written NAME and nothing else. An applied Type (`List<Integer>`),
	// a Record written in place and a Function Type all have shapes a draw
	// could be composed for, and none of them has one the standard library
	// spells in a single call — so they are left to the reader rather than
	// guessed at.
	if (type.nodeType !== "IdentifierTypeDeclaration") {
		return null
	}

	return draws[type.type.content] ?? null
}

function alreadyGeneratable(program: parser.Program, name: string): boolean {
	let found = false

	walk(program, (node) => {
		if (node.nodeType !== "NamespaceDefinitionStatement") {
			return
		}

		// NOTE: The name this would write is taken, or the conformance it would
		// declare is already declared. Either way there is nothing to offer:
		// the second declaration would collide with the first, and a Type that
		// already conforms draws through what is written.
		let target = node.targetType

		if (
			node.name.content === `${name}${GENERATABLE}` ||
			(target !== null &&
				target.nodeType === "IdentifierTypeDeclaration" &&
				target.type.content === name &&
				node.conformsTo.some(
					(clause) => clause.protocol.content === GENERATABLE,
				))
		) {
			found = true
		}
	})

	return found
}

// NOTE: The declarations a value is built of, which is a Record Alias and a
// Choice. A GENERIC one is left out: `generate` is a static taking a source and
// nothing else, so a call has no Argument for the Type Parameters to be worked
// out from — which is what `unreachable-conformance` refuses, and offering to
// write a conformance the Compiler then refuses would be a fix that breaks the
// file. A refinement is left out too: its predicate is what a drawn value has to
// satisfy, and nothing here can hold one.
function buildablesIn(program: parser.Program): Array<Buildable> {
	let buildables: Array<Buildable> = []

	walk(program, (node) => {
		if (node.nodeType === "ChoiceDeclarationStatement") {
			if (node.generics.length === 0) {
				buildables.push({ name: node.name.content, node })
			}

			return
		}

		if (
			node.nodeType === "TypeAliasStatement" &&
			node.generics.length === 0 &&
			node.predicate === null &&
			node.type.nodeType === "RecordTypeDeclaration"
		) {
			buildables.push({ name: node.name.content, node })
		}
	})

	return buildables
}
