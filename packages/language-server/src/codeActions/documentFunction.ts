import { documentationPrefix } from "@essence-lang/compiler/parser"
import type { common, parser } from "@essence-lang/interfaces"

import { methodsOf } from "../namespaceMembers"
import { indentationOf, lineAt, overlaps } from "./geometry"
import type { CodeActionEntry } from "./index"
import { walk } from "./lookups"

// NOTE: The `§§` block a Declaration wants, with a line per Parameter and
// nothing written on any of them. What it buys is the SHAPE: a `@param` line
// documents the Parameter at its own position and names it the way the
// signature does, which is the rule `undocumented-parameter` and
// `misnamed-documentation-parameter` hold a block to — and the rule a reader
// writing the block by hand gets wrong. Applying this and writing nothing
// leaves a block that raises none of them.
//
// Nothing here reads a Type. The block is a question about the SIGNATURE —
// which names it writes, in which order — so this answers off the parsed
// source and offers the same thing in a file that does not enrich.

// NOTE: The em dash a tag's text stands after, which `parseDocumentation`
// splits on. A tag written without it is lifted all the same and reported as
// `missing-documentation-separator`, so the scaffold writes the separator even
// where it has nothing to put after it.
const separator = "—"

// NOTE: What may stand between the start of a Declaration's line and the name
// it declares. A block is written at column 1 of that line, so anything else in
// front of the name means the Declaration does not open its line and there is
// no place above it to write one.
const declarationHead = /^[ \t]*(function[ \t]+|static[ \t]+)?$/

type Documentable = {
	name: string
	// NOTE: Where the name was written, which is the line the block goes above
	// — a `static` keyword or the `function` one stands in front of it on that
	// same line, and a signature broken over several lines still opens on it.
	namePosition: common.Position
	definition: parser.FunctionDefinitionNode
}

export function documentFunctionActions(
	program: parser.Program,
	lines: Array<string>,
	range: common.Position,
): Array<CodeActionEntry> {
	let entries: Array<CodeActionEntry> = []

	for (let documentable of documentablesIn(program)) {
		let entry = documentAction(documentable, lines, range)

		if (entry !== null) {
			entries.push(entry)
		}
	}

	return entries
}

function documentAction(
	documentable: Documentable,
	lines: Array<string>,
	range: common.Position,
): CodeActionEntry | null {
	let { name, namePosition, definition } = documentable

	// NOTE: A Declaration that already carries a block is left alone — what
	// this writes is a skeleton, and writing one over a description somebody
	// wrote would be a rewrite rather than a scaffold.
	if (definition.documentation !== null) {
		return null
	}

	let line = namePosition.start.line
	let text = lineAt(lines, line)
	let head = {
		start: { line, column: 1 },
		end: { line, column: text.length + 1 },
	}

	if (!overlaps(head, range)) {
		return null
	}

	// NOTE: Read back off the buffer, as every edit here is: a Position from a
	// stale analysis, or a Declaration written after something else on its
	// line, would put the block in the middle of a Statement.
	if (!declarationHead.test(text.slice(0, namePosition.start.column - 1))) {
		return null
	}

	let indentation = indentationOf(lines, line)
	let written = [
		// NOTE: The description first and a blank line under it, which is the
		// shape every `§§` block in the standard library has: what the thing
		// does, then what each part of it is.
		documentationPrefix,
		documentationPrefix,
		...definition.parameters.map(
			(parameter) =>
				`${documentationPrefix} @param ${parameterName(parameter)} ${separator}`,
		),
		// NOTE: A Function answering the unit Type answers nothing a reader can
		// be told about, and a `@returns` over it would describe `{}`.
		...(answersSomething(definition)
			? [`${documentationPrefix} @returns ${separator}`]
			: []),
	]
		// NOTE: No trailing space after the separator, though that is where the
		// cursor would like to land: the Formatter strips one, and a scaffold
		// that writes what the Formatter takes straight back out is a scaffold
		// arguing with the Formatter.
		.map((comment) => `${indentation}${comment}\n`)
		.join("")

	return {
		title: `Document '${name}'`,
		kind: "refactor.rewrite",
		diagnosticCode: null,
		diagnosticPosition: null,
		// NOTE: Not preferred: every line of it is empty, so what it leaves
		// behind is a block nobody has written yet.
		isPreferred: false,
		edits: [
			{
				range: {
					start: { line, column: 1 },
					end: { line, column: 1 },
				},
				newText: written,
			},
		],
	}
}

// NOTE: What a `@param` line has to write, which is what the SIGNATURE writes:
// the label, or `_` where the Parameter carries none. The internal name is the
// one the body reads the Parameter under and is deliberately not it — two
// positional Parameters are both `_`, and the rule is positional so they can be.
function parameterName(parameter: parser.ParameterNode): string {
	return parameter.externalName?.content ?? "_"
}

// NOTE: Whether the Declaration answers with anything. `-> {}` is the unit
// Type — the Declaration is written for what it does rather than for what it
// hands back — and a null return Type belongs to a contextually typed Function
// literal, which is not something this offers on.
function answersSomething(definition: parser.FunctionDefinitionNode): boolean {
	let returnType = definition.returnType

	return (
		returnType !== null &&
		!(
			returnType.nodeType === "RecordTypeDeclaration" &&
			Object.keys(returnType.members).length === 0
		)
	)
}

// NOTE: The three Declarations that carry a signature and a name of their own:
// a Function Statement, a Method and a static. An `overload` block is not among
// them — a block above the keyword documents the SET, under a different rule
// (a name any of its entries takes), and the entries under it each carry a
// block of their own.
function documentablesIn(program: parser.Program): Array<Documentable> {
	let documentables: Array<Documentable> = []

	walk(program, (node) => {
		if (node.nodeType === "FunctionStatement") {
			documentables.push({
				name: node.name.content,
				namePosition: node.name.position,
				definition: node.value,
			})

			return
		}

		if (node.nodeType !== "NamespaceDefinitionStatement") {
			return
		}

		for (let member of Object.values(node.methods)) {
			if (
				member.nodeType !== "SimpleMethod" &&
				member.nodeType !== "StaticMethod"
			) {
				continue
			}

			for (let method of methodsOf(member)) {
				documentables.push({
					name: member.name.content,
					namePosition: member.name.position,
					definition: method.value,
				})
			}
		}
	})

	return documentables
}
