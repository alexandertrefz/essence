import type { common, parser } from "@essence-lang/interfaces"

import { report } from "../diagnostics/index"
import { parseTestBody } from "../parser/descent/parse"
import { documentationPrefix } from "../parser/documentation"

// `@example` blocks become tests in a synthetic `examples` suite, compiled in
// the file's own scope. An example that drifts from its code fails a run.
// Each is parsed at its own line and column, so its Diagnostics need no offset.

// A found example, named by the Method's full spelling, such as
// `Standings::pointsPerGame`, since two Namespaces may declare one name.
type FoundExample = {
	name: string
	example: common.DocumentationExample
}

// Asked before a compile by `essence test`'s discovery, so a file with no
// `tests { … }` block can still be a file with tests.
export function hasDocumentationExamples(program: parser.Program): boolean {
	return findExamples(program).length > 0
}

export function exampleTestsOf(
	program: parser.Program,
	source: string | undefined,
): Array<parser.TestNode> {
	if (source === undefined) {
		return []
	}

	let found = findExamples(program)

	if (found.length === 0) {
		return []
	}

	let lines = source.replace(/\r\n?/g, "\n").split("\n")
	let counts = new Map<string, number>()

	return found.flatMap((entry) => {
		// A second example of one Method gets a numbered name, since tests
		// are keyed by name.
		let seen = (counts.get(entry.name) ?? 0) + 1

		counts.set(entry.name, seen)

		let node = exampleTest(
			entry,
			seen === 1
				? `${entry.name} example`
				: `${entry.name} example ${seen}`,
			lines,
		)

		return node === null ? [] : [node]
	})
}

// The synthetic `suite "examples" { … }` the tests are reported under. No
// source wrote it, so the parser does not build it.
export function exampleSuite(
	tests: Array<parser.TestNode>,
	position: common.Position,
): parser.SuiteNode {
	return {
		nodeType: "Suite",
		name: { nodeType: "StringValue", value: "examples", position },
		modifiers: [],
		nodes: tests,
		keywordPosition: position,
		position,
	}
}

function exampleTest(
	entry: FoundExample,
	name: string,
	lines: Array<string>,
): parser.TestNode | null {
	let { body, diagnostics } = parseTestBody(sourceOf(entry.example, lines))

	// The parse collected its Diagnostics apart, so they are reported into
	// the collection this compile opened.
	for (let diagnostic of diagnostics) {
		report(diagnostic)
	}

	if (body.length === 0) {
		return null
	}

	let position = entry.example.position

	return {
		nodeType: "Test",
		form: "test",
		name: { nodeType: "StringValue", value: name, position },
		modifiers: [],
		table: null,
		properties: null,
		body,
		keywordPosition: entry.example.tag?.position ?? position,
		position,
	}
}

// The file with every line but the example's blanked, and each example line
// at its own column, so every parsed Position is the file's own.
function sourceOf(
	example: common.DocumentationExample,
	lines: Array<string>,
): string {
	let padded = lines.map(() => "")

	for (let line of example.lines) {
		let body = stripPrefix(line.text)
		let column =
			line.position.start.column + (line.text.length - body.length)

		padded[line.position.start.line - 1] = " ".repeat(column - 1) + body
	}

	return padded.join("\n")
}

// The rule `parseDocumentation` reads a line by: the sigil, then one optional
// space. It is repeated here because the length removed gives the column.
function stripPrefix(line: string): string {
	let body = line.startsWith(documentationPrefix)
		? line.slice(documentationPrefix.length)
		: line

	return body.startsWith(" ") ? body.slice(1) : body
}

// Every `@example` a Program's own declarations carry, in written order. A
// Namespace's Methods are named `Namespace::member`, static or not.
function findExamples(program: parser.Program): Array<FoundExample> {
	let found: Array<FoundExample> = []

	let add = (name: string, documentation: common.Documentation | null) => {
		for (let example of documentation?.examples ?? []) {
			found.push({ name, example })
		}
	}

	for (let node of program.implementation.nodes) {
		if (node.nodeType === "FunctionStatement") {
			add(node.name.content, node.value.documentation)

			continue
		}

		if (node.nodeType === "OverloadedFunctionStatement") {
			add(node.name.content, node.documentation)

			for (let method of node.methods) {
				add(
					node.name.content,
					method.nodeType === "FunctionValue"
						? method.value.documentation
						: method.documentation,
				)
			}

			continue
		}

		if (node.nodeType !== "NamespaceDefinitionStatement") {
			continue
		}

		let namespace = node.name.content

		for (let property of Object.values(node.properties)) {
			add(`${namespace}.${property.name.content}`, property.documentation)
		}

		for (let method of Object.values(node.methods)) {
			let name = `${namespace}::${method.name.content}`

			switch (method.nodeType) {
				case "SimpleMethod":
				case "StaticMethod":
					add(name, method.method.value.documentation)
					break
				case "SimpleMethodSignature":
				case "StaticMethodSignature":
					add(name, method.signature.documentation)
					break
				default:
					// An `overload` block may document itself, and each entry
					// may too.
					add(name, method.documentation)

					for (let entry of method.methods) {
						add(
							name,
							entry.nodeType === "FunctionValue"
								? entry.value.documentation
								: entry.documentation,
						)
					}
			}
		}
	}

	return found
}
