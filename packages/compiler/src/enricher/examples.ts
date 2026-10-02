import type { common, parser } from "@essence-lang/interfaces"

import { primary, report, reportWarning, secondary } from "../diagnostics/index"
import { patternBindings } from "../helpers/patterns"
import { parseTestBody } from "../parser/descent/parse"
import { documentationPrefix } from "../parser/documentation"
import { forEachParserChild, type ParserNode } from "../visitor/index"

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

	reportNestedExamples(program, found)

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

// Every `@example` the top-level declarations carry, in written order: a
// declaration's own block, then each of its Parameters'. A Namespace's or a
// Protocol's Methods are named `Namespace::member`, static or not. The tests
// section's setup counts, since the `examples` suite stands inside it.
function findExamples(program: parser.Program): Array<FoundExample> {
	let found: Array<FoundExample> = []

	let add: AddExamples = (name, documentation, parameters = []) => {
		for (let block of [
			documentation,
			...parameters.map((parameter) => parameter.documentation),
		]) {
			for (let example of block?.examples ?? []) {
				found.push({ name, example })
			}
		}
	}

	for (let node of topLevelNodes(program)) {
		switch (node.nodeType) {
			case "FunctionStatement":
				add(
					node.name.content,
					node.value.documentation,
					node.value.parameters,
				)
				break
			case "OverloadedFunctionStatement":
				add(node.name.content, node.documentation)

				for (let method of node.methods) {
					addEntry(add, node.name.content, method)
				}

				break
			case "ConstantDeclarationStatement":
			case "VariableDeclarationStatement":
				add(declaredName(node.name), node.documentation)
				break
			case "TypeAliasStatement":
			case "ChoiceDeclarationStatement":
				add(node.name.content, node.documentation)
				break
			case "ProtocolDeclarationStatement":
				protocolExamples(node, add)
				break
			case "NamespaceDefinitionStatement":
				namespaceExamples(node, add)
				break
			default:
				break
		}
	}

	return found
}

// The implementation's nodes, then the tests section's.
function topLevelNodes(program: parser.Program): Array<parser.TestsNode> {
	return [...program.implementation.nodes, ...(program.tests?.nodes ?? [])]
}

type AddExamples = (
	name: string,
	documentation: common.Documentation | null,
	parameters?: Array<parser.ParameterNode>,
) => void

// A Pattern Declaration is named by the names it binds.
function declaredName(
	name: parser.IdentifierNode | parser.PatternNode,
): string {
	if (name.nodeType === "Identifier") {
		return name.content
	}

	let names = patternBindings(name).map((binding) => binding.name.content)

	return `{ ${names.join(", ")} }`
}

// One entry of an `overload` set, bodied or native.
function addEntry(
	add: AddExamples,
	name: string,
	entry: parser.FunctionValueNode | parser.NativeMethodSignatureNode,
): void {
	if (entry.nodeType === "FunctionValue") {
		add(name, entry.value.documentation, entry.value.parameters)
	} else {
		add(name, entry.documentation, entry.parameters)
	}
}

function namespaceExamples(
	node: parser.NamespaceDefinitionStatementNode,
	add: AddExamples,
): void {
	let namespace = node.name.content

	add(namespace, node.documentation)

	for (let property of Object.values(node.properties)) {
		add(`${namespace}.${property.name.content}`, property.documentation)
	}

	for (let method of Object.values(node.methods)) {
		let name = `${namespace}::${method.name.content}`

		switch (method.nodeType) {
			case "SimpleMethod":
			case "StaticMethod":
				addEntry(add, name, method.method)
				break
			case "SimpleMethodSignature":
			case "StaticMethodSignature":
				addEntry(add, name, method.signature)
				break
			default:
				// An `overload` block may document itself, and each entry
				// may too.
				add(name, method.documentation)

				for (let entry of method.methods) {
					addEntry(add, name, entry)
				}
		}
	}
}

// A provided Method's block is its signature's, which its body shares.
function protocolExamples(
	node: parser.ProtocolDeclarationStatementNode,
	add: AddExamples,
): void {
	let protocol = node.name.content

	add(protocol, node.documentation)

	for (let method of Object.values(node.methods)) {
		let name = `${protocol}::${method.name.content}`
		let signatures =
			method.nodeType === "SimpleProtocolMethod" ||
			method.nodeType === "StaticProtocolMethod"
				? [method.signature]
				: method.signatures

		if (
			method.nodeType === "OverloadedProtocolMethod" ||
			method.nodeType === "OverloadedStaticProtocolMethod"
		) {
			add(name, method.documentation)
		}

		for (let signature of signatures) {
			add(name, signature.documentation, signature.parameters)
		}
	}
}

// #region Nested examples

// A declaration nested in a body, a test or a suite may read what its
// enclosing item declares, which the `examples` suite can not see. Its
// examples are reported rather than run.
function reportNestedExamples(
	program: parser.Program,
	found: Array<FoundExample>,
): void {
	let reachable = new Set(found.map((entry) => entry.example))

	for (let outer of topLevelNodes(program)) {
		let visit = (node: ParserNode, name: string | null): void => {
			let own = nestedName(node) ?? name

			for (let example of examplesOn(node)) {
				if (!reachable.has(example)) {
					reportNestedExample(
						example,
						own ?? "this declaration",
						outer,
					)
				}
			}

			forEachParserChild(node, (child) => visit(child, own))
		}

		visit(outer, null)
	}
}

function reportNestedExample(
	example: common.DocumentationExample,
	name: string,
	outer: parser.TestsNode,
): void {
	let position = example.tag?.position ?? example.position
	let inTestOrSuite = outer.nodeType === "Test" || outer.nodeType === "Suite"
	let outerName =
		"name" in outer && outer.name !== null && "position" in outer.name
			? outer.name.position
			: null

	reportWarning(`This '@example' of '${name}' never runs`, position, {
		code: "nested-example",
		labels: [
			primary(position, "no test is made from this example"),
			...(outerName === null
				? []
				: [secondary(outerName, `'${name}' is declared inside this`)]),
		],
		notes: [
			"An '@example' runs as a test beside the file's top-level declarations, and a nested declaration is in scope only inside what declares it.",
		],
		helps: [
			inTestOrSuite
				? `Write it as a test where '${name}' is in scope, or remove the '@example' tag to keep these lines as prose.`
				: `Show it through an '@example' on the top-level declaration '${name}' is nested in, or remove the '@example' tag to keep these lines as prose.`,
		],
	})
}

function examplesOn(node: ParserNode): Array<common.DocumentationExample> {
	return "documentation" in node ? (node.documentation?.examples ?? []) : []
}

// The name a nested declaration is reported under. A Function's block sits on
// its definition and its Parameters, which inherit the name.
function nestedName(node: ParserNode): string | null {
	switch (node.nodeType) {
		case "FunctionStatement":
		case "OverloadedFunctionStatement":
		case "TypeAliasStatement":
		case "ChoiceDeclarationStatement":
		case "ProtocolDeclarationStatement":
		case "NamespaceDefinitionStatement":
			return node.name.content
		case "ConstantDeclarationStatement":
		case "VariableDeclarationStatement":
			return declaredName(node.name)
		default:
			return null
	}
}

// #endregion
