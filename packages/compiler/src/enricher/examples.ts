import type { common, parser } from "@essence-lang/interfaces"

import { report } from "../diagnostics/index"
import { parseTestBody } from "../parser/descent/index"
import { documentationPrefix } from "../parser/documentation"

// NOTE: `@example` blocks, turned into the tests they are. What is written
// under the tag is Essence compiled in the FILE's own scope and reported under
// a synthetic suite called `examples`, named after the Method or the Function
// the block documents — so an example that drifts from the code it documents
// fails a run instead of quietly lying in hover text.
//
// The example is parsed out of a text this file builds: every line of the file
// blank except the example's, and each of those standing at the column it
// stands at in the source. So every Position the parse produces is the Position
// it has in the file, without a single offset threaded anywhere — a Diagnostic
// about an example underlines the `§§` line it was written on, and a failed
// `expect` inside one is reported there.

// NOTE: A found example, and what to call the test it becomes. The name is the
// Method's full spelling — `Standings::pointsPerGame` — because that is what a
// reader searching a report will look for, and because two Namespaces may
// perfectly well declare a Method of one name.
type FoundExample = {
	name: string
	example: common.DocumentationExample
}

// NOTE: Whether a file's documentation promises anything a run has to keep.
// It is asked before a compile — by `essence test`'s own discovery, which has to
// decide whether a file with no `tests { … }` block is a file with tests.
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
		// NOTE: A Method documenting itself twice gets two tests, numbered.
		// Their identities differ by the name, which is what everything durable
		// is keyed by — so the second example of a Method may not silently be
		// the first one's twin.
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

// NOTE: The synthetic `suite "examples" { … }` the tests are reported under. It
// is written here rather than in the Parser because no source wrote it: a
// reader who asks for a file's tests is shown the ones they wrote and, beside
// them, the ones their documentation promises.
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

	// NOTE: A Diagnostic the example's own parse produced is reported into
	// whatever collection this compile opened — the parse ran in one of its
	// own, because a collection is module state and the enrichment is already
	// inside one.
	for (let diagnostic of diagnostics) {
		report(diagnostic)
	}

	if (body.length === 0) {
		return null
	}

	let position = entry.example.position

	return {
		nodeType: "Test",
		name: { nodeType: "StringValue", value: name, position },
		modifiers: [],
		table: null,
		body,
		keywordPosition: entry.example.tag?.position ?? position,
		position,
	}
}

// NOTE: The text the example is parsed out of: the file, with every line the
// example does not stand on replaced by an empty one, and every line it does
// stand on holding its own content at its own column. Nothing is offset
// afterwards, because nothing moved.
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

// NOTE: The same rule `parseDocumentation` reads a line by — the sigil, and one
// space after it if there is one. It is spelled again rather than shared
// because what this needs is the LENGTH it removed, which is what says at which
// column the code begins.
function stripPrefix(line: string): string {
	let body = line.startsWith(documentationPrefix)
		? line.slice(documentationPrefix.length)
		: line

	return body.startsWith(" ") ? body.slice(1) : body
}

// NOTE: Every `@example` a Program's own declarations carry, in written order,
// paired with what to call it. A Namespace's Methods are spelled
// `Namespace::member` whether they are static or not: that is the Method's own
// spelling, it is unambiguous, and it is what the coverage report already says.
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
					// NOTE: An `overload` block documents itself once, above
					// the block, and each entry may document itself as well.
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
