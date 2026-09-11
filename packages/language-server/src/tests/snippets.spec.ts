import { describe, expect, it } from "bun:test"
import * as path from "node:path"

import { parseDocument } from "@essence-lang/compiler/documents"
import { STDLIB_DIRECTORY } from "@essence-lang/standard-library"

import { analyse } from "../analyse"
import { findCompletions } from "../completion"
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
	"method",
	"match",
	"define",
]

// NOTE: The contexts that exist to REFUSE — a Case list, a list of overload
// signatures and a Parameter list each take one shape of writing, and no
// snippet here is it. Written out so that a body claiming one fails the test
// above rather than quietly being offered where nothing parses.
const refusingContexts: Array<SnippetContext> = [
	"choice",
	"overload",
	"parameters",
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

	it("offers nothing in a context that exists to refuse", () => {
		for (let context of refusingContexts) {
			expect([context, snippetsFor(context)]).toEqual([context, []])
		}
	})

	// NOTE: `$0` is where the Editor leaves the cursor once every tab stop has
	// been visited, and a body without one leaves it at the end of what was
	// written — which for a four-line scaffold is the line below it rather than
	// the hole it opened. A body that IS a complete value has nothing left to
	// fill in and says so by carrying none.
	it("leaves the cursor somewhere in every body that opens a hole", () => {
		const complete = new Set(["dictionary-empty"])

		for (let snippet of snippets) {
			let stops = (
				snippet.body.join("\n").match(/\$(?:\{0[:}]|0(?![0-9]))/g) ?? []
			).length

			expect([snippet.prefix, stops]).toEqual([
				snippet.prefix,
				complete.has(snippet.prefix) ? 0 : 1,
			])
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

	// NOTE: `implementation` covers the top of a section as well as a Function
	// body, and the top of a section has nothing to return FROM. Every body
	// offered there is held against the whole pipeline rather than against the
	// Parser alone, because `top-level-return` is the Enricher's to report —
	// the unknown names the placeholders leave behind are the reader's to fill
	// in and are not.
	it("returns from nothing at the top of a section", () => {
		for (let snippet of snippetsFor("implementation")) {
			let source = `implementation {\n${renderPlaceholders(
				snippet.body.join("\n"),
				"value",
			)}\n}`
			let codes = analyse(source).map((diagnostic) => diagnostic.code)

			expect([snippet.prefix, codes]).toEqual([
				snippet.prefix,
				expect.not.arrayContaining(["top-level-return"]),
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
			// NOTE: An Expression inside a Namespace Method, which is the one
			// place `@` names anything.
			case "method":
				return `implementation {\n\tnamespace Name for Integer {\n\t\tmethod() -> Integer {\n\t\t\tconstant value = ${body}\n\n\t\t\t<- 1\n\t\t}\n\t}\n}`
			// NOTE: The three contexts that exist to REFUSE. No body lists one,
			// so nothing is ever wrapped in them — a snippet that starts
			// claiming one has to say here what it parses inside.
			case "choice":
			case "overload":
			case "parameters":
				throw new Error(`'${context}' offers no snippet to parse`)
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

describe("Snippet completion", () => {
	function snippetsAt(
		lines: Array<string>,
		cursor: { line: number; column: number },
		documentPath?: string,
	) {
		return findCompletions(lines.join("\n"), cursor, documentPath)
			.filter((entry) => entry.kind === "snippet")
			.map((entry) => entry.label)
	}

	it("offers the sections above the implementation, and nothing inside one", () => {
		let offered = snippetsAt(["", "implementation {", "}"], {
			line: 1,
			column: 1,
		})

		expect(offered).toContain("import")
		expect(offered).toContain("tests")
		expect(offered).toContain("tests-file")
		expect(offered).not.toContain("constant")
		expect(offered).not.toContain("case")
	})

	// NOTE: A Module has one of each section, so the snippet that opens one is
	// an answer only where that section is missing — accepting it otherwise
	// writes a second, which is a Diagnostic and four lines the reader deletes.
	it("withholds a section the file already writes", () => {
		let offered = snippetsAt(
			["", "implementation {", "}", "", "tests {", "}"],
			{ line: 1, column: 1 },
		)

		expect(offered).not.toContain("implementation")
		expect(offered).not.toContain("declarations")
		expect(offered).not.toContain("tests")
		expect(offered).not.toContain("tests-file")
		expect(offered).toContain("import")
		expect(offered).toContain("export")
	})

	// NOTE: A file being started from scratch is the ONE document where the
	// sections are the whole answer — and the Parser recovers it into a Program
	// whose implementation section spans nothing, which used to read as a
	// cursor standing inside a body that is not there.
	it("offers the sections in a file with nothing in it", () => {
		for (let lines of [[""], ["\n"], ["i"], ["§ only a comment", ""]]) {
			let offered = snippetsAt(lines, { line: 1, column: 1 })

			expect([lines, offered]).toEqual([
				lines,
				expect.arrayContaining([
					"implementation",
					"import",
					"tests",
					"tests-file",
				]),
			])
			expect([lines, offered]).toEqual([
				lines,
				expect.not.arrayContaining(["constant", "function"]),
			])
		}
	})

	it("offers the Statements of an implementation body", () => {
		let offered = snippetsAt(["implementation {", "\t", "}"], {
			line: 2,
			column: 2,
		})

		expect(offered).toContain("constant")
		expect(offered).toContain("destructure")
		expect(offered).toContain("function")
		expect(offered).toContain("narrow")
		expect(offered).not.toContain("static")
		expect(offered).not.toContain("expect")
		expect(offered).not.toContain("test")
	})

	// NOTE: The Program form the standard library opens with, which is decided
	// by the document's path and by nothing in the text.
	it("offers the declarations a standard library file may write", () => {
		let offered = snippetsAt(
			["declarations {", "\t", "}"],
			{ line: 2, column: 2 },
			path.join(STDLIB_DIRECTORY, "Scratch.es"),
		)

		expect(offered).toContain("namespace")
		expect(offered).toContain("type")
		expect(offered).toContain("type-refinement")
		expect(offered).not.toContain("constant")
		expect(offered).not.toContain("expect")
	})

	it("offers the members of a Namespace body", () => {
		let offered = snippetsAt(
			[
				"implementation {",
				"\tnamespace Name for Integer {",
				"\t\t",
				"\t}",
				"}",
			],
			{ line: 3, column: 3 },
		)

		expect(offered).toContain("method")
		expect(offered).toContain("static")
		expect(offered).toContain("static-property")
		expect(offered).toContain("overload")
		expect(offered).not.toContain("constant")
		expect(offered).not.toContain("function")
	})

	// NOTE: A Method's body is a Statement body wherever it is written, so the
	// Namespace around it is not what the cursor stands in — the Function
	// literal it opened is.
	it("reads a Method's own body as a Statement body", () => {
		let offered = snippetsAt(
			[
				"implementation {",
				"\tnamespace Name for Integer {",
				"\t\tmethod() -> Integer {",
				"\t\t\t",
				"\t\t}",
				"\t}",
				"}",
			],
			{ line: 4, column: 4 },
		)

		expect(offered).toContain("constant")
		expect(offered).not.toContain("static")
	})

	it("offers the Methods a Protocol declares", () => {
		let offered = snippetsAt(
			["implementation {", "\tprotocol Name {", "\t\t", "\t}", "}"],
			{ line: 3, column: 3 },
		)

		expect(offered).toContain("method")
		expect(offered).toContain("doc")
		expect(offered).toContain("doc-param")
		expect(offered).not.toContain("static")
		expect(offered).not.toContain("constant")
	})

	it("offers the items of a tests section", () => {
		let offered = snippetsAt(
			["implementation {", "}", "", "tests {", "\t", "}"],
			{ line: 5, column: 2 },
		)

		expect(offered).toContain("test")
		expect(offered).toContain("suite")
		expect(offered).toContain("test-across")
		expect(offered).toContain("constant")
		expect(offered).not.toContain("expect")
		expect(offered).not.toContain("namespace")
	})

	it("offers the assertions of a test body", () => {
		let offered = snippetsAt(
			[
				"implementation {",
				"}",
				"",
				"tests {",
				'\ttest "what it proves" {',
				"\t\t",
				"\t}",
				"}",
			],
			{ line: 6, column: 3 },
		)

		expect(offered).toContain("expect")
		expect(offered).toContain("require")
		expect(offered).toContain("snapshot")
		expect(offered).toContain("constant")
		expect(offered).not.toContain("test")
		expect(offered).not.toContain("namespace")
	})

	it("offers a group inside an import block", () => {
		let offered = snippetsAt(
			["import {", "\t", "}", "", "implementation {", "}"],
			{ line: 2, column: 2 },
		)

		expect(offered).toEqual(["from"])
	})

	it("offers a forwarding group inside an export block", () => {
		let offered = snippetsAt(
			["implementation {", "}", "", "export {", "\t", "}"],
			{ line: 5, column: 2 },
		)

		expect(offered).toEqual(["export-from"])
	})

	it("offers the values of an Expression position", () => {
		let offered = snippetsAt(
			["implementation {", "\tconstant value = ", "}"],
			{ line: 2, column: 19 },
		)

		expect(offered).toContain("with")
		expect(offered).toContain("closure")
		expect(offered).toContain("record")
		expect(offered).toContain("match")
		expect(offered).toContain("define")
		expect(offered).not.toContain("function")
		expect(offered).not.toContain("constant")
	})

	it("offers the Handlers of a match", () => {
		let offered = snippetsAt(
			[
				"implementation {",
				"\tconstant value = match subject -> Integer {",
				"\t\tcase 0 { <- 1 }",
				"\t\t",
				"\t}",
				"}",
			],
			{ line: 4, column: 3 },
		)

		expect(offered).toContain("case")
		expect(offered).toContain("case-where")
		expect(offered).toContain("case-payload")
		expect(offered).not.toContain("constant")
		expect(offered).not.toContain("with")
	})

	// NOTE: The context that earns its place by what it refuses. Nothing but
	// arms may be written between a `define`'s braces, and no body in the table
	// is one — so the answer there is nothing at all, rather than the
	// Statements a block that is not one would offer.
	it("offers nothing between a define's arms", () => {
		let offered = snippetsAt(
			[
				"implementation {",
				"\tconstant value = define {",
				"\t\tas 1 if condition",
				"\t\t",
				"\t\tas 2 otherwise",
				"\t}",
				"}",
			],
			{ line: 4, column: 3 },
		)

		expect(offered).toEqual([])
	})

	// NOTE: A Handler that has just been opened has written no Statement, so it
	// spans nothing of its own and the `match` around it used to answer — which
	// offered the `case` that goes OUTSIDE the Handler to a reader standing
	// inside it. An empty body is spanned from its Matcher to the next Handler
	// instead.
	it("reads an empty match Handler as a Statement body", () => {
		let offered = snippetsAt(
			[
				"implementation {",
				"\tconstant value = match subject -> Integer {",
				"\t\tcase 0 {",
				"\t\t\t",
				"\t\t}",
				"\t}",
				"}",
			],
			{ line: 4, column: 4 },
		)

		expect(offered).toContain("constant")
		expect(offered).not.toContain("case")
	})

	// NOTE: And a Choice's body, which takes a list of Cases and nothing else.
	it("offers nothing between a Choice's Cases", () => {
		let offered = snippetsAt(
			["implementation {", "\tchoice Name {", "\t\t", "\t}", "}"],
			{ line: 3, column: 3 },
		)

		expect(offered).toEqual([])
	})

	// NOTE: And an `overload` group, which takes signatures. Every member the
	// Namespace around it offers is a Parser Diagnostic written between those
	// braces.
	it("offers nothing inside an overload group", () => {
		let offered = snippetsAt(
			[
				"implementation {",
				"\tnamespace Name for Integer {",
				"\t\toverload thing {",
				"\t\t\t",
				"\t\t}",
				"\t}",
				"}",
			],
			{ line: 4, column: 4 },
		)

		expect(offered).toEqual([])
	})

	// NOTE: And a Parameter list, which is neither a Statement position nor a
	// value one — a name, a Type and a default are the whole of what goes
	// there. A default IS a value, and keeps the values.
	it("offers nothing inside a written Parameter list", () => {
		let signature = [
			"implementation {",
			"\tfunction f(a: Integer, b: Integer = 1) -> Integer { <- a }",
			"}",
		]

		expect(snippetsAt(signature, { line: 2, column: 14 })).toEqual([])
		expect(snippetsAt(signature, { line: 2, column: 38 })).toContain(
			"record",
		)
	})

	// NOTE: The bodies reach the Editor as snippet text, which is what makes a
	// tab stop a tab stop rather than four literal characters.
	it("hands the body over as snippet text, and says what it writes", () => {
		let entry = findCompletions(
			["implementation {", "}", "", "tests {", "\t", "}"].join("\n"),
			{ line: 5, column: 2 },
		).find((offer) => offer.kind === "snippet" && offer.label === "test")

		expect(entry?.insertText).toBe(
			['test "${1:what it proves}" {', "\texpect $0", "}"].join("\n"),
		)
		expect(entry?.labelDetail).toBe('test "what it proves" {')
		expect(entry?.detail).toBe("A test — one named body of assertions.")
	})

	// NOTE: The Keyword and the block that share a label are two entries, and
	// the kind is the whole of what tells them apart.
	it("offers a Keyword and its block side by side", () => {
		let entries = findCompletions(
			["implementation {", "}", "", "tests {", "\t", "}"].join("\n"),
			{ line: 5, column: 2 },
		).filter((entry) => entry.label === "constant")

		expect(entries.map((entry) => entry.kind).sort()).toEqual([
			"keyword",
			"snippet",
		])
	})

	it("offers no snippet where the language allows only a name", () => {
		expect(
			snippetsAt(
				["implementation {", '\tconstant text = "Hello"::', "}"],
				{ line: 2, column: 26 },
			),
		).toEqual([])
	})

	// NOTE: No body names a Type, so the Type space offers none — the rule the
	// Keywords are held to, for the same reason.
	it("offers no snippet in the Type space", () => {
		expect(
			snippetsAt(["implementation {", "\tconstant value: ", "}"], {
				line: 2,
				column: 18,
			}),
		).toEqual([])
	})

	// NOTE: Where nothing parses there is no Program to read a block off, and
	// the text reading is what is left: it still tells a value position from a
	// Statement one, and the bodies that need to know more are not offered.
	it("falls back to the text where the document does not parse", () => {
		let offered = snippetsAt(
			["implementation {", "\tnamespace Name for {{{", "\t", "}"],
			{ line: 3, column: 2 },
		)

		expect(offered).toContain("constant")
		expect(offered).not.toContain("static")
	})
})

// NOTE: `snippetsFor` is what Completion asks, so a context nobody answers is
// a context nobody can reach — and the two spellings of that mistake are a
// body listing a context that is never resolved to, and a context resolved to
// that no body lists.
describe("the contexts", () => {
	it("answers with only the bodies that named the context", () => {
		for (let context of contexts) {
			for (let snippet of snippetsFor(context)) {
				// NOTE: `method` is a narrower reading of `expression`, so it
				// answers with what a value position answers with besides its
				// own — see `widerContext`.
				expect(snippet.contexts).toContain(
					context === "method" && !snippet.contexts.includes("method")
						? "expression"
						: context,
				)
			}
		}
	})

	// NOTE: And the narrowing itself: everything a value position offers is
	// offered inside a Method, and `{ @ with … }` is offered nowhere else.
	it("offers a Method body everything a value position offers", () => {
		let value = snippetsFor("expression").map((snippet) => snippet.prefix)
		let method = snippetsFor("method").map((snippet) => snippet.prefix)

		expect(method).toEqual(expect.arrayContaining(value))
		expect(method).toContain("with-self")
		expect(value).not.toContain("with-self")
	})
})
