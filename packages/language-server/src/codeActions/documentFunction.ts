import { documentationPrefix } from "@essence-lang/compiler/parser"
import type { common, parser } from "@essence-lang/interfaces"

import { methodsOf } from "../namespaceMembers"
import { indentationOf, lineAt, overlaps } from "./geometry"
import type { CodeActionEntry } from "./index"
import { walk } from "./lookups"

// An empty `§§` block for a Declaration, with a `@param` line per Parameter in
// order, named as the signature names it. The empty block raises neither
// `undocumented-parameter` nor `misnamed-documentation-parameter`.
//
// It reads only the parsed signature, so it works in a file that does not
// enrich.

// The separator `parseDocumentation` splits a tag's text on. A tag without
// it is reported as `missing-documentation-separator`, so it is written even
// with no text after it.
const separator = "—"

// What may precede a Declaration's name on its line. Anything else means the
// Declaration does not open its line, so no block can go above it.
const declarationHead = /^[ \t]*(function[ \t]+|static[ \t]+)?$/

type Documentable = {
	name: string
	// The name's line, before which the block goes. A `static` or `function`
	// keyword stands on it too.
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

	// A Declaration that already has a block is left alone.
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

	// Otherwise the block could land inside a Statement. See "Reading the
	// buffer back" in DEVELOPMENT.md.
	if (!declarationHead.test(text.slice(0, namePosition.start.column - 1))) {
		return null
	}

	let indentation = indentationOf(lines, line)
	let written = [
		// The description, a blank line, then the parts, as the standard
		// library writes its blocks.
		documentationPrefix,
		documentationPrefix,
		...definition.parameters.map(
			(parameter) =>
				`${documentationPrefix} @param ${parameterName(parameter)} ${separator}`,
		),
		// No `@returns` for a Function answering the unit Type.
		...(answersSomething(definition)
			? [`${documentationPrefix} @returns ${separator}`]
			: []),
	]
		// No trailing space after the separator, which the formatter would
		// strip.
		.map((comment) => `${indentation}${comment}\n`)
		.join("")

	return {
		title: `Document '${name}'`,
		kind: "refactor.rewrite",
		diagnosticCode: null,
		diagnosticPosition: null,
		// Not preferred: every line of it is still empty.
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

// The name a `@param` line writes: the label, or `_` without one, never the
// internal name. The rule is positional, so two `_` lines are fine.
function parameterName(parameter: parser.ParameterNode): string {
	return parameter.externalName?.content ?? "_"
}

// Whether the Declaration answers with anything other than the unit Type
// `{}`. Only a contextually typed Function literal has no return Type.
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

// Function Statements, Methods and statics. An `overload` set is skipped; its
// block follows another rule, and each entry carries its own.
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
