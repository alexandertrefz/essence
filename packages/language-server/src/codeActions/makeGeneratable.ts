import { TAB_WIDTH, WIDTH } from "@essence-lang/formatter/doc"
import type { common, parser } from "@essence-lang/interfaces"

import { indentationOf, lineAt, overlaps } from "./geometry"
import type { CodeActionEntry, FixContext } from "./index"
import { walk } from "./lookups"

// Writes the `Generatable` conformance a property test wants after its Type,
// replacing the derived generator. A Record is drawn member by member, a
// Choice by picking a Case.
//
// Never preferred. A member with no known draw is left out of the value, with
// a `§` line saying why, rather than drawn wrongly.

const GENERATABLE = "Generatable"
const SOURCE = "source"

// The standard library's draws from a `Randomness`, as an author writes them.
// There is no fallback: drawing an Integer for a refined `Age` would break the
// refinement.
const draws: Readonly<Record<string, string>> = {
	Boolean: `${SOURCE}::drawBoolean()`,
	Integer: `${SOURCE}::drawInteger(between 0, and 100)`,
	Rational: `${SOURCE}::drawRational(between 0/1, and 1/1)`,
	String: `${SOURCE}::drawString(upTo 10)`,
}

// A declaration a value can be built of, read off the parsed source, since the
// body spells member Types and Cases as the author did.
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
	let found = generatablesIn(program)
	// Only a Type this file declares, since the Namespace goes after its
	// declaration.
	let buildable = found.buildables.find(
		(candidate) => candidate.name === typeName,
	)

	return buildable === undefined
		? []
		: entryFor(buildable, found.covered, lines, "quickfix", diagnostic)
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
			...entryFor(
				buildable,
				found.covered,
				lines,
				"refactor.rewrite",
				null,
			),
		)
	}

	return entries
}

function entryFor(
	buildable: Buildable,
	covered: Set<string>,
	lines: Array<string>,
	kind: "quickfix" | "refactor.rewrite",
	diagnostic: (common.Diagnostic & { position: common.Position }) | null,
): Array<CodeActionEntry> {
	if (covered.has(buildable.name)) {
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
		// No line break after the brace: the declaration's own break
		// follows it.
		`${indentation}}`,
	].join("")
}

// What a body answers with, and the members it could not draw, which the `§`
// lines name.
type Built = { text: string; undrawable: Array<string> }

// One Record's members: drawn where possible, named where not.
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

// A Case is chosen by `pick` over a List of every Case built, which needs no
// Match over a drawn number.
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

		// Named with its Case, since payloads may share member names.
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

// One line where it fits, one entry per line otherwise, measured as the
// formatter measures, so formatting leaves the scaffold as written.
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
	// Only a written name. An applied, Record or Function Type has no
	// single-call draw, so it is left to the reader.
	if (type.nodeType !== "IdentifierTypeDeclaration") {
		return null
	}

	return draws[type.type.content] ?? null
}

// The Record Aliases and Choices a value is built of, and in one walk the
// Types a `Generatable` Namespace already covers.
//
// A generic declaration is left out: `generate` takes no Argument to infer
// its Type Parameters from, so `unreachable-conformance` would refuse it. A
// refinement is left out too, since a draw cannot satisfy its predicate.
function generatablesIn(program: parser.Program): {
	buildables: Array<Buildable>
	// Types whose Namespace exists already, or that conform already.
	covered: Set<string>
} {
	let buildables: Array<Buildable> = []
	let covered = new Set<string>()

	walk(program, (node) => {
		if (node.nodeType === "ChoiceDeclarationStatement") {
			if (node.generics.length === 0) {
				buildables.push({ name: node.name.content, node })
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

	return { buildables, covered }
}
