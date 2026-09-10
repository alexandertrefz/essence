import { describe, expect, it } from "bun:test"
import * as path from "node:path"

import { parseDocument } from "@essence-lang/compiler/documents"
import { STDLIB_DIRECTORY } from "@essence-lang/standard-library"

import {
	renderPlaceholders,
	type SnippetContext,
	snippets,
	snippetsFor,
} from "../snippets"

// NOTE: Every member of `SnippetContext`, written out. TypeScript already
// refuses a body that names one that is not there; what this catches is the
// other direction — a context added to the union and given no home, and a
// context spelled in a test that no body ever declares.
const contexts: Array<SnippetContext> = [
	"top",
	"implementation",
	"declarations",
	"namespace",
	"protocol",
	"tests",
	"test",
	"import",
	"export",
	"expression",
	"match",
	"define",
]

// NOTE: The same walk `renderPlaceholders` takes, kept here rather than
// exported beside it: what it answers is a fact about a MALFORMED body, which
// the Server has no reader for.
function placeholderDepth(text: string): number {
	let open = 0
	let index = 0

	while (index < text.length) {
		if (text[index] === "\\" && index + 1 < text.length) {
			index += 2
			continue
		}

		let opening = /^\$\{\d+:/.exec(text.slice(index))

		if (opening !== null) {
			open += 1
			index += opening[0].length
			continue
		}

		if (text[index] === "}" && open > 0) {
			open -= 1
		}

		index += 1
	}

	return open
}

describe("the snippet table", () => {
	it("names every body once", () => {
		let prefixes = snippets.map((snippet) => snippet.prefix)

		expect(new Set(prefixes).size).toBe(prefixes.length)
	})

	it("offers every body somewhere, in a context of the union", () => {
		for (let snippet of snippets) {
			expect(snippet.contexts.length).toBeGreaterThan(0)

			for (let context of snippet.contexts) {
				expect(contexts).toContain(context)
			}
		}
	})

	it("writes well-formed placeholders", () => {
		for (let snippet of snippets) {
			let body = snippet.body.join("\n")

			expect([snippet.prefix, placeholderDepth(body)]).toEqual([
				snippet.prefix,
				0,
			])
			// NOTE: A `$` left in the rendered text is a tab stop the renderer
			// did not recognise — `${1` with no colon and no close, which an
			// Editor writes out verbatim.
			expect([snippet.prefix, renderPlaceholders(body)]).toEqual([
				snippet.prefix,
				renderPlaceholders(body).replace(/\$/g, ""),
			])
		}
	})

	// NOTE: The label detail a Completion list shows is the head of the body
	// with its tab stops rendered, so an empty one is an entry that says
	// nothing about what accepting it writes.
	it("renders a first line for every body", () => {
		for (let snippet of snippets) {
			expect([
				snippet.prefix,
				renderPlaceholders(snippet.body[0] ?? "").length > 0,
			]).toEqual([snippet.prefix, true])
		}
	})
})

// NOTE: The test that keeps the table honest. Every body is rendered as an
// Editor would write it out untouched, wrapped in the smallest Program its
// context implies, and handed to the Parser — so a body that does not parse
// where it is offered fails here rather than in a reader's file.
//
// Parsed as a standard library document throughout, which is the one thing
// that decides whether `declarations { … }` is allowed. Nothing else about a
// document changes what the Parser accepts, so the permission costs every
// other body nothing.
describe("every snippet body", () => {
	const documentPath = path.join(STDLIB_DIRECTORY, "SnippetProbe.es")

	// NOTE: A bare tab stop carries no text of its own, and what stands in for
	// it is decided by where it stands. One written alone on its line is where
	// the next Statement or member goes, and a block with nothing written in it
	// yet is an empty block — while one written INSIDE a line, `<- $0` or
	// `expect $0`, stands where a value goes, and leaving that empty would be a
	// Parser error about the table rather than about the body.
	function rendered(body: Array<string>): string {
		let lines = body.map((line) =>
			/^\s*\$\{?\d+\}?$/.test(line) ? "" : line,
		)

		return renderPlaceholders(lines.join("\n"), "value")
	}

	// NOTE: A `top` body stands beside the sections rather than inside one, and
	// which side decides what has to be written around it: an import block goes
	// above the implementation and an export block below it, while a body that
	// opens a section of its own is already a whole Program.
	function programAround(context: SnippetContext, body: string): string {
		switch (context) {
			case "top":
				if (/^(implementation|declarations|tests)\b/m.test(body)) {
					return body
				}

				return body.startsWith("export")
					? `implementation {\n}\n\n${body}`
					: `${body}\n\nimplementation {\n}`
			case "implementation":
				return `implementation {\n${body}\n}`
			case "declarations":
				return `declarations {\n${body}\n}`
			case "namespace":
				return `implementation {\n\tnamespace Name for Integer {\n${body}\n\t}\n}`
			case "protocol":
				return `implementation {\n\tprotocol Name {\n${body}\n\t}\n}`
			case "tests":
				return `implementation {\n}\n\ntests {\n${body}\n}`
			case "test":
				return `implementation {\n}\n\ntests {\n\ttest "what it proves" {\n${body}\n\t}\n}`
			case "import":
				return `import {\n${body}\n}\n\nimplementation {\n}`
			case "export":
				return `implementation {\n}\n\nexport {\n${body}\n}`
			case "expression":
				return `implementation {\n\tconstant value = ${body}\n}`
			case "match":
				return `implementation {\n\tconstant value = match subject -> Integer {\n${body}\n\t}\n}`
			case "define":
				return `implementation {\n\tconstant value = define {\n${body}\n\t\tas 0 otherwise\n\t}\n}`
		}
	}

	for (let snippet of snippets) {
		for (let context of snippet.contexts) {
			it(`parses where '${snippet.prefix}' is offered — ${context}`, () => {
				let source = programAround(context, rendered(snippet.body))
				let { diagnostics } = parseDocument(source, documentPath)

				expect(
					diagnostics.map((diagnostic) => diagnostic.message),
				).toEqual([])
			})
		}
	}
})

// NOTE: `snippetsFor` is what Completion asks, so a context nobody answers is
// a context nobody can reach — and the two spellings of that mistake are a
// body listing a context that is never resolved to, and a context resolved to
// that no body lists.
describe("the contexts", () => {
	it("answers with only the bodies that named the context", () => {
		for (let context of contexts) {
			for (let snippet of snippetsFor(context)) {
				expect(snippet.contexts).toContain(context)
			}
		}
	})
})
