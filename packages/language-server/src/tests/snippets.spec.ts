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

// Every member of `SnippetContext`, written out. TypeScript refuses a body
// naming a missing one. This catches a context added with no home, and one a
// spec spells that no body declares.
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

// The contexts that exist to refuse. A Case list, an `overload` group and a
// Parameter list each take a shape no snippet writes, so a body claiming one
// fails a spec.
const refusingContexts: Array<SnippetContext> = [
	"choice",
	"overload",
	"parameters",
]

// The walk `renderPlaceholders` takes, kept here rather than exported, since
// it answers about a malformed body the Server never reads.
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

	// `$0` is where the Editor leaves the cursor after the last tab stop.
	// Without one the cursor lands after the scaffold, not in the hole it opened.
	// A body that is a complete value carries none.
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
			// A `$` left in the rendered text is a tab stop the renderer did not
			// recognise, such as an unclosed `${1`. An Editor writes it out verbatim.
			expect([snippet.prefix, renderPlaceholders(body)]).toEqual([
				snippet.prefix,
				renderPlaceholders(body).replace(/\$/g, ""),
			])
		}
	})

	// `implementation` covers the top of a section, which has nothing to return
	// from. The Enricher reports `top-level-return`, so these bodies go through
	// the whole pipeline. The placeholders' unknown names are not checked.
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

	// The label detail is the body's head with its tab stops rendered. An empty
	// one says nothing about what accepting the entry writes.
	it("renders a first line for every body", () => {
		for (let snippet of snippets) {
			expect([
				snippet.prefix,
				renderPlaceholders(snippet.body[0] ?? "").length > 0,
			]).toEqual([snippet.prefix, true])
		}
	})
})

// Every body, rendered as an Editor writes it untouched, is wrapped in the
// smallest Program its context implies and parsed. Each is parsed as a standard
// library document, the only kind that allows `declarations { … }`.
describe("every snippet body", () => {
	const documentPath = path.join(STDLIB_DIRECTORY, "SnippetProbe.es")

	// A bare tab stop alone on its line becomes nothing, leaving an empty
	// block. One inside a line, such as `<- $0`, stands where a value goes and
	// renders as `value`.
	function rendered(body: Array<string>): string {
		let lines = body.map((line) =>
			/^\s*\$\{?\d+\}?$/.test(line) ? "" : line,
		)

		return renderPlaceholders(lines.join("\n"), "value")
	}

	// A `top` body stands beside the sections. An import block goes before the
	// implementation and an export block after it, and a body opening a section
	// is already a whole Program.
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
			// An Expression inside a Namespace Method, where `@` names the
			// receiver.
			case "method":
				return `implementation {\n\tnamespace Name for Integer {\n\t\tmethod() -> Integer {\n\t\t\tconstant value = ${body}\n\n\t\t\t<- 1\n\t\t}\n\t}\n}`
			// The refusing contexts. No body lists one, so a snippet claiming one
			// must say here what it parses inside.
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

	// A Module has one of each section, so a section snippet is offered only
	// where that section is missing.
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

	// In a file started from scratch the sections are the whole answer. The
	// Parser recovers it into a Program whose implementation spans nothing, which
	// must not read as a cursor inside a body.
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

	// The Program form the standard library opens with, which is decided
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

	// A Method's body is a Statement body wherever it is written. The cursor
	// stands in the Function literal, not in the Namespace around it.
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

	// `start` and `complete` are values, and the completing Function is a
	// Statement, as the `closure` and `function` snippets are.
	it("offers the asynchrony bodies where each of them parses", () => {
		let value = snippetsAt(
			["implementation {", "\tconstant value = ", "}"],
			{ line: 2, column: 19 },
		)

		expect(value).toContain("complete")
		expect(value).toContain("start")
		expect(value).not.toContain("function-completing")

		let statement = snippetsAt(["implementation {", "\t", "}"], {
			line: 2,
			column: 2,
		})

		expect(statement).toContain("function-completing")
		expect(statement).not.toContain("complete")
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

	// Only arms may be written between a `define`'s braces, and no body in the
	// table is one, so nothing is offered there.
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

	// A Handler just opened has no Statement to span. Its empty body spans from
	// its Matcher to the next Handler, so the `match` around it does not answer.
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

	// And a Choice's body, which takes a list of Cases and nothing else.
	it("offers nothing between a Choice's Cases", () => {
		let offered = snippetsAt(
			["implementation {", "\tchoice Name {", "\t\t", "\t}", "}"],
			{ line: 3, column: 3 },
		)

		expect(offered).toEqual([])
	})

	// An `overload` group takes signatures only. A member the Namespace around
	// it offers would be a Parser Diagnostic there.
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

	// A Parameter list takes a name, a Type and a default. A default is a value
	// and keeps the values.
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

	it("offers nothing inside a provided Method's Parameter list", () => {
		let offered = snippetsAt(
			[
				"implementation {",
				"\tprotocol Ranked {",
				"\t\tisAbove(_ mark: Integer) -> Boolean",
				"",
				"\t\tisAtMost(_ mark: Integer) -> Boolean {",
				"\t\t\t<- @::isAbove(mark)",
				"\t\t}",
				"\t}",
				"}",
			],
			{ line: 5, column: 14 },
		)

		expect(offered).toEqual([])
	})

	it("offers nothing inside the Parameter list of a bodied overload function entry", () => {
		let offered = snippetsAt(
			[
				"declarations {",
				"\toverload function combine {",
				"\t\t(first value: Integer) -> Integer {",
				"\t\t\t<- value",
				"\t\t}",
				"\t}",
				"}",
			],
			{ line: 3, column: 10 },
			path.join(STDLIB_DIRECTORY, "Scratch.es"),
		)

		expect(offered).toEqual([])
	})

	// A native signature has no Function literal for the walk to reach, so
	// its span is read as a Parameter list. Its defaults keep the values.
	it("offers nothing inside a native signature's Parameter list", () => {
		let lines = [
			"declarations {",
			"\toverload function combine {",
			"\t\t(first value: Integer) -> Integer {",
			"\t\t\t<- value",
			"\t\t}",
			"\t\t(first value: String, by step: Integer = 1) -> String",
			"\t}",
			"",
			"\tnamespace Sizes for Integer {",
			"\t\tgrow(by amount: Integer) -> Integer",
			"\t\tstatic make(from amount: Integer) -> Integer",
			"",
			"\t\toverload shrink {",
			"\t\t\t(by amount: Integer = 2) -> Integer",
			"\t\t}",
			"\t}",
			"}",
		]
		let file = path.join(STDLIB_DIRECTORY, "Scratch.es")
		let offeredAt = (line: number, text: string) =>
			snippetsAt(
				lines,
				{ line, column: (lines[line - 1] as string).indexOf(text) + 1 },
				file,
			)

		expect(offeredAt(6, "value")).toEqual([])
		expect(offeredAt(10, "amount")).toEqual([])
		expect(offeredAt(11, "amount")).toEqual([])
		expect(offeredAt(14, "amount")).toEqual([])
		expect(offeredAt(6, "1)")).toContain("record")
		expect(offeredAt(14, "2)")).toContain("record")
	})

	// A requirement is a signature without a body, read as a native one is.
	it("offers nothing inside a Protocol requirement's Parameter list", () => {
		let offered = snippetsAt(
			[
				"implementation {",
				"\tprotocol Ranked {",
				"\t\tisAbove(_ mark: Integer) -> Boolean",
				"\t}",
				"}",
			],
			{ line: 3, column: 13 },
		)

		expect(offered).toEqual([])
	})

	// The bodies reach the Editor as snippet text, or a tab stop would be
	// literal characters.
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

	// The Keyword and the block that share a label are two entries, told apart
	// by their kind.
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

	// No body names a Type, so the Type space offers none, as with Keywords.
	it("offers no snippet in the Type space", () => {
		expect(
			snippetsAt(["implementation {", "\tconstant value: ", "}"], {
				line: 2,
				column: 18,
			}),
		).toEqual([])
	})

	// Where nothing parses, the text reading still tells a value position from
	// a Statement one. The bodies that need more are not offered.
	it("falls back to the text where the document does not parse", () => {
		let offered = snippetsAt(
			["implementation {", "\tnamespace Name for {{{", "\t", "}"],
			{ line: 3, column: 2 },
		)

		expect(offered).toContain("constant")
		expect(offered).not.toContain("static")
	})
})

// `snippetsFor` is what Completion asks, so a body listing a context nothing
// resolves to is never offered.
describe("the contexts", () => {
	it("answers with only the bodies that named the context", () => {
		for (let context of contexts) {
			for (let snippet of snippetsFor(context)) {
				// `method` narrows `expression` and answers with its bodies too.
				// See `widerContext`.
				expect(snippet.contexts).toContain(
					context === "method" && !snippet.contexts.includes("method")
						? "expression"
						: context,
				)
			}
		}
	})

	// Everything a value position offers is offered inside a Method, and
	// `{ @ with … }` is offered nowhere else.
	it("offers a Method body everything a value position offers", () => {
		let value = snippetsFor("expression").map((snippet) => snippet.prefix)
		let method = snippetsFor("method").map((snippet) => snippet.prefix)

		expect(method).toEqual(expect.arrayContaining(value))
		expect(method).toContain("with-self")
		expect(value).not.toContain("with-self")
	})
})
