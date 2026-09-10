// NOTE: Every snippet the language ships, held once. Two things read this
// table: Completion offers them as snippet-format entries scoped to the block
// the cursor stands in, and `bun run generate:snippets` writes the VS Code
// `.code-snippets` file out of it for the readers who switch the Server off.
// The file is GENERATED rather than maintained beside this, because two hand
// written copies of one table are two copies that drift — a spec regenerates
// in memory and fails when the checked in file is stale.
//
// A body is written in LSP snippet syntax, which VS Code and the Server share:
// `${1:default}` is a tab stop with text already selected, `$0` is where the
// cursor is left, a tab stop number written twice is one stop edited in two
// places, and `$`, `}` and `\` are escaped with a backslash where they are
// meant literally. Indentation is a tab: an Editor re-indents every line of an
// inserted snippet to the line the cursor stands on, so a body says how deep
// its own lines are relative to each other and nothing about the file.

// NOTE: The block a body parses in, which is what says whether it is offered.
// Some of these carry no body of their own and still earn their place by what
// they REFUSE: a cursor inside a `match` or a `define` is offered the handlers
// and arms that belong there rather than the `function` and `namespace` a
// statement position would offer, neither of which parses inside an
// Expression.
//
// `top` is beside the sections rather than inside one — above the imports,
// between the implementation and the tests, below the exports — which is where
// a whole section is written. `implementation` and `declarations` are the two
// spellings of a Program's body, and a Method's or a Function's body reports
// the section it is written in rather than a block of its own: a Statement is a
// Statement wherever it stands.
export type SnippetContext =
	| "top"
	| "implementation"
	| "declarations"
	| "namespace"
	| "protocol"
	| "tests"
	| "test"
	| "import"
	| "export"
	| "expression"
	| "match"
	| "define"

export type Snippet = {
	// NOTE: What is typed to reach it, and the name it is written under in the
	// generated file — one word, so the two can not disagree.
	prefix: string
	description: string
	body: Array<string>
	contexts: Array<SnippetContext>
}

// NOTE: What a body reads as before anything is typed: every tab stop's
// default text in its place, and a bare stop — `$0`, which carries none —
// replaced by whatever the caller stands in for it. Completion shows the first
// line of this beside the prefix, and the spec compiles the whole of it to
// prove the table parses.
//
// The walk is a scanner rather than one regular expression because a default
// may hold a tab stop of its own — `${2:: ${3:Type}}` is the annotation of the
// `constant` snippet — and nesting is the one thing a regular expression can
// not count. An unescaped `}` inside a placeholder is therefore always the one
// closing it, which is exactly the rule the escape exists for.
export function renderPlaceholders(text: string, tabstop = ""): string {
	let rendered = ""
	let open = 0
	let index = 0

	while (index < text.length) {
		let rest = text.slice(index)
		let character = text[index] as string

		if (character === "\\" && index + 1 < text.length) {
			rendered += text[index + 1]
			index += 2
			continue
		}

		let opening = /^\$\{\d+:/.exec(rest)

		if (opening !== null) {
			open += 1
			index += opening[0].length
			continue
		}

		let bare = /^\$(?:\{(\d+)\}|(\d+))/.exec(rest)

		if (bare !== null) {
			rendered += tabstop
			index += bare[0].length
			continue
		}

		if (character === "}" && open > 0) {
			open -= 1
			index += 1
			continue
		}

		rendered += character
		index += 1
	}

	return rendered
}

export function snippetsFor(context: SnippetContext): Array<Snippet> {
	return snippets.filter((snippet) => snippet.contexts.includes(context))
}

// NOTE: Ordered by what each one writes rather than alphabetically — a reader
// adding one belongs beside the forms it is a variant of, and the Completion
// list is sorted by the Editor anyway.
export const snippets: Array<Snippet> = [
	/* The sections a file is made of */

	{
		prefix: "implementation",
		description: "An implementation block — the body of a Program.",
		body: ["implementation {", "\t$0", "}"],
		contexts: ["top"],
	},
	{
		prefix: "declarations",
		description:
			"A declarations block — the body of a standard library file.",
		body: ["declarations {", "\t$0", "}"],
		contexts: ["top"],
	},
	{
		prefix: "tests",
		description:
			"A tests block — written below the implementation, and dropped from every build.",
		body: ["tests {", "\t$0", "}"],
		contexts: ["top"],
	},

	/* Declarations */

	{
		prefix: "constant",
		description: "A constant declaration.",
		body: ["constant ${1:name}${2:: ${3:Type}} = ${0:value}"],
		contexts: ["implementation", "tests", "test"],
	},
	{
		prefix: "variable",
		description: "A variable declaration.",
		body: ["variable ${1:name}${2:: ${3:Type}} = ${0:value}"],
		contexts: ["implementation", "tests", "test"],
	},
	{
		prefix: "function",
		description: "A function declaration.",
		body: [
			"function ${1:name}(${2:_} ${3:parameter}: ${4:Type}) -> ${5:ReturnType} {",
			"\t<- $0",
			"}",
		],
		contexts: ["implementation", "tests", "test"],
	},
	{
		prefix: "namespace",
		description: "A namespace of Methods for a Type.",
		body: [
			"namespace ${1:Name} for ${2:Type}${3: is ${4:Protocol}} {",
			"\t$0",
			"}",
		],
		contexts: ["implementation", "declarations"],
	},
	{
		prefix: "protocol",
		description: "A protocol declaration.",
		body: [
			"protocol ${1:Name} {",
			"\t${2:method}(${3:_} ${4:parameter}: ${5:Type}) -> ${0:ReturnType}",
			"}",
		],
		contexts: ["implementation", "declarations"],
	},
	{
		prefix: "choice",
		description: "A choice declaration.",
		body: [
			"choice ${1:Name} {",
			"\t${2:Case} { ${3:member}: ${4:Type} },",
			"\t${0:OtherCase},",
			"}",
		],
		contexts: ["implementation", "declarations"],
	},
	{
		prefix: "choice-generic",
		description: "A generic choice declaration.",
		body: [
			"choice ${1:Name}<${2:Parameter}> {",
			"\t${3:Case} { ${4:member}: ${2:Parameter} },",
			"\t${0:OtherCase},",
			"}",
		],
		contexts: ["implementation", "declarations"],
	},
	{
		prefix: "type",
		description: "A type alias.",
		body: ["type ${1:Name} = ${0:Type}"],
		contexts: ["implementation", "declarations"],
	},
	{
		prefix: "type-record",
		description: "A Record type alias.",
		body: ["type ${1:Name} = { ${2:member}: ${0:Type} }"],
		contexts: ["implementation", "declarations"],
	},

	/* Namespace and Protocol members */

	{
		prefix: "overload",
		description: "An overload group of same-named signatures.",
		body: [
			"overload ${1:name} {",
			"\t(${2:_} ${3:parameter}: ${4:Type}) -> ${5:ReturnType} {",
			"\t\t<- $0",
			"\t}",
			"}",
		],
		contexts: ["namespace"],
	},

	/* Tests */

	{
		prefix: "test",
		description: "A test — one named body of assertions.",
		body: ['test "${1:what it proves}" {', "\texpect $0", "}"],
		contexts: ["tests"],
	},
	{
		prefix: "for any",
		description: "A property test — one body run over generated values.",
		body: [
			'test "${1:what holds}" for any (${2:value}: ${3:Type}) {',
			"\texpect $0",
			"}",
		],
		contexts: ["tests"],
	},
	{
		prefix: "benchmark",
		description: "A benchmark — one named body, timed rather than judged.",
		body: ['benchmark "${1:what it measures}" {', "\t$0", "}"],
		contexts: ["tests"],
	},
	{
		prefix: "suite",
		description: "A suite — a group of tests sharing a scope.",
		body: ['suite "${1:name}" {', "\t$0", "}"],
		contexts: ["tests"],
	},

	/* Values */

	{
		prefix: "record-typed",
		description: "A typed Record literal.",
		body: ["${1:Type} ~> { ${2:member} = ${0:value} }"],
		contexts: ["expression"],
	},

	/* Control flow */

	{
		prefix: "if",
		description: "An if statement.",
		body: ["if ${1:condition} {", "\t$0", "}"],
		contexts: ["implementation", "tests", "test"],
	},
	{
		prefix: "ifelse",
		description: "An if statement with an else branch.",
		body: ["if ${1:condition} {", "\t$2", "} else {", "\t$0", "}"],
		contexts: ["implementation", "tests", "test"],
	},
	{
		prefix: "match",
		description: "A match expression.",
		body: [
			"match ${1:value} -> ${2:ReturnType} {",
			"\tcase ${3:Matcher} { <- ${4:value} }",
			"\tcase ${5:_}       { <- ${0:value} }",
			"}",
		],
		contexts: ["expression"],
	},
	{
		prefix: "case",
		description: "A case handler within a match expression.",
		body: ["case ${1:Matcher} { <- ${0:value} }"],
		contexts: ["match"],
	},
	{
		prefix: "case-where",
		description: "A guarded case handler within a match expression.",
		body: ["case ${1:Matcher} where ${2:condition} { <- ${0:value} }"],
		contexts: ["match"],
	},
	{
		prefix: "define",
		description: "A definition by cases.",
		body: [
			"define {",
			"\tas ${1:value} if ${2:condition}",
			"\tas ${0:value} otherwise",
			"}",
		],
		contexts: ["expression"],
	},

	/* Documentation */

	{
		prefix: "doc",
		description: "A §§ documentation block.",
		body: [
			"§§ ${1:What it does.}",
			"§§",
			"§§ @param ${2:name} — ${3:what it carries}",
			"§§ @returns — ${0:what it answers with}",
		],
		contexts: ["implementation", "declarations", "namespace", "protocol"],
	},
]
