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
// they refuse: a cursor inside a `match` is offered the handlers that belong
// there rather than the `function` and `namespace` a statement position would
// offer, neither of which parses inside an Expression. `define`, `choice`,
// `overload` and `parameters` are refusals and nothing else: an arm list, a
// Case list, a list of signatures and a Parameter list each take one shape of
// writing that no snippet here is.
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
	| "method"
	| "match"
	| "define"
	| "choice"
	| "overload"
	| "parameters"

// NOTE: A context that is a NARROWER reading of another: everything the wider
// one offers is offered here too, and a snippet that needs the narrower one
// says so and is offered nowhere else. `method` is a value position inside a
// Namespace Method or a provided Protocol Method, which is the one place `{ @
// with … }` means anything — everywhere else it raises `at-outside-method`.
const widerContext: Partial<Record<SnippetContext, SnippetContext>> = {
	method: "expression",
}

// NOTE: The Module sections a file is made of. `implementation` stands for the
// BODY section under either of its two spellings — a file that opened one has
// no room for a `declarations { … }` beside it, and none for a second
// `implementation { … }` either.
export type ModuleSection = "implementation" | "tests" | "import" | "export"

export type Snippet = {
	// NOTE: What is typed to reach it, and the name it is written under in the
	// generated file — one word, so the two can not disagree.
	prefix: string
	description: string
	body: Array<string>
	contexts: Array<SnippetContext>
	// NOTE: The sections the body OPENS, for the six that open one. A second
	// `tests { … }` is a Diagnostic and so is a second implementation section,
	// so a file that already writes one is not offered the snippet that writes
	// it again — `tests-file` is the one body that writes two.
	writes?: Array<ModuleSection>
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
	let wider = widerContext[context]

	return snippets.filter(
		(snippet) =>
			snippet.contexts.includes(context) ||
			(wider !== undefined && snippet.contexts.includes(wider)),
	)
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
		writes: ["implementation"],
	},
	{
		prefix: "declarations",
		description:
			"A declarations block — the body of a standard library file.",
		body: ["declarations {", "\t$0", "}"],
		contexts: ["top"],
		writes: ["implementation"],
	},
	{
		prefix: "tests",
		description:
			"A tests block — written below the implementation, and dropped from every build.",
		body: ["tests {", "\t$0", "}"],
		contexts: ["top"],
		writes: ["tests"],
	},
	{
		prefix: "import",
		description:
			"An import block — every name this Module takes from another one.",
		body: ["import {", '\tfrom "${1:./Module.es}" { ${0:Name} }', "}"],
		contexts: ["top"],
		writes: ["import"],
	},
	{
		prefix: "export",
		description:
			"An export block — the names this Module offers; everything else stays private.",
		body: ["export {", "\t${0:Name}", "}"],
		contexts: ["top"],
		writes: ["export"],
	},
	{
		prefix: "tests-file",
		description:
			"A file that is nothing but tests — an import block and a tests block, and no implementation.",
		body: [
			"import {",
			'\tfrom "${1:./Module.es}" { ${2:Name} }',
			"}",
			"",
			"tests {",
			'\ttest "${3:what it proves}" {',
			"\t\texpect $0",
			"\t}",
			"}",
		],
		contexts: ["top"],
		writes: ["import", "tests"],
	},
	{
		prefix: "from",
		description: "One import group — every name taken from one dependency.",
		body: ['from "${1:./Module.es}" { ${0:Name} }'],
		contexts: ["import"],
	},
	{
		prefix: "export-from",
		description:
			"One export group — a dependency's name forwarded without ever being bound here.",
		body: ['from "${1:./Module.es}" { ${0:Name} }'],
		contexts: ["export"],
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
		prefix: "destructure",
		description:
			"A declaration that takes its value apart — the Pattern names the members it wants.",
		body: ["constant { ${1:first}, ${2:second} } = ${0:value}"],
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
		prefix: "function-generic",
		description:
			"A generic function — the Type Parameter is inferred from the Argument.",
		body: [
			"function ${1:name}<infer ${2:Item}>(${3:_} ${4:parameter}: ${2:Item}) -> ${5:ReturnType} {",
			"\t<- $0",
			"}",
		],
		contexts: ["implementation", "tests", "test"],
	},
	{
		prefix: "function-bounded",
		description:
			"A generic function whose Type Parameter must conform to a Protocol.",
		body: [
			"function ${1:name}<infer ${2:Item} is ${3:Protocol}>(${4:_} ${5:parameter}: ${2:Item}) -> ${6:ReturnType} {",
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
		prefix: "namespace-static",
		description:
			"A namespace belonging to no particular value — statics alone.",
		body: ["namespace ${1:Name} {", "\t$0", "}"],
		contexts: ["implementation", "declarations"],
	},
	{
		prefix: "namespace-generic",
		description:
			"A generic namespace — written once, and bound to an Item by each receiver.",
		body: [
			"namespace ${1:Name}<infer ${2:Item}> for ${3:List}<${2:Item}> {",
			"\t$0",
			"}",
		],
		contexts: ["implementation", "declarations"],
	},
	{
		prefix: "namespace-where",
		description:
			"A conditional conformance — the Type conforms only where its Type Parameter does.",
		body: [
			"namespace ${1:Name}<infer ${2:Item}> for ${3:Type}",
			"\tis ${4:Protocol} where ${2:Item} is ${5:Bound}",
			"{",
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
		prefix: "protocol-extends",
		description:
			"A protocol extending others — conforming to it owes every requirement of theirs too.",
		body: [
			"protocol ${1:Name} is ${2:Protocol} {",
			"\t${3:method}(${4:_} ${5:parameter}: ${6:Type}) -> ${0:ReturnType}",
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
	{
		prefix: "type-union",
		description: "A union type alias — a value of either Type.",
		body: ["type ${1:Name} = ${2:Type} | ${0:OtherType}"],
		contexts: ["implementation", "declarations"],
	},
	{
		prefix: "type-generic",
		description:
			"A generic type alias — the Type Parameter is written at every use.",
		body: ["type ${1:Name}<${2:Item}> = ${0:List}<${2:Item}>"],
		contexts: ["implementation", "declarations"],
	},
	{
		prefix: "type-refinement",
		description:
			"A checked refinement — a Type carrying the evidence its values satisfy a predicate.",
		body: ["type ${1:Name} = ${2:Integer} where @::${3:isNot}(${0:0})"],
		contexts: ["implementation", "declarations"],
	},
	{
		prefix: "generatable",
		description:
			"A Generatable conformance — what a property test draws a value of this Type from.",
		body: [
			"namespace ${1:Name} for ${2:Type} is Generatable {",
			"\tstatic generate(from source: Randomness) -> ${2:Type} {",
			"\t\t<- $0",
			"\t}",
			"}",
		],
		contexts: ["implementation"],
	},

	/* Namespace and Protocol members */

	{
		prefix: "method",
		description: "A Method — written on `@`, the value it is called on.",
		body: [
			"${1:name}(${2:_} ${3:parameter}: ${4:Type}) -> ${5:ReturnType} {",
			"\t<- $0",
			"}",
		],
		contexts: ["namespace", "protocol"],
	},
	{
		prefix: "static",
		description:
			"A static Method — one belonging to the Namespace rather than to a value.",
		body: [
			"static ${1:name}(${2:_} ${3:parameter}: ${4:Type}) -> ${5:ReturnType} {",
			"\t<- $0",
			"}",
		],
		contexts: ["namespace"],
	},
	{
		prefix: "static-property",
		description:
			"A static Property — a value belonging to the Namespace itself.",
		body: ["static ${1:name} = ${0:value}"],
		contexts: ["namespace"],
	},
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
	{
		prefix: "overload-static",
		description: "An overload group of static signatures.",
		body: [
			"overload static ${1:name} {",
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
		prefix: "test-tagged",
		description:
			"A tagged test — the tags a run selects on, plus every enclosing suite's.",
		body: [
			'test "${1:what it proves}" tagged ${2:slow} {',
			"\texpect $0",
			"}",
		],
		contexts: ["tests"],
	},
	{
		prefix: "test-skipped",
		description:
			"A skipped test — still compiled and Type-checked, and the reason is mandatory.",
		body: [
			'test "${1:what it proves}"',
			'\tskipped "${2:why it is skipped}"',
			"{",
			"\texpect $0",
			"}",
		],
		contexts: ["tests"],
	},
	{
		prefix: "test-focused",
		description:
			"A focused test — while one exists, only focused tests run, and the run says so.",
		body: ['test "${1:what it proves}" focused {', "\texpect $0", "}"],
		contexts: ["tests"],
	},
	{
		prefix: "test-across",
		description: "A table test — one run per row of a written List.",
		body: [
			'test "${1:what it proves}" across [',
			"\t{ ${2:member} = ${3:value} },",
			"] ({ ${2:member} }: ${4:Row}) {",
			"\texpect $0",
			"}",
		],
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
	{
		prefix: "expect",
		description:
			"An assertion — it records its result and carries on, so one test can report several failures.",
		body: ["expect ${1:value}::is($0)"],
		contexts: ["test"],
	},
	{
		prefix: "require",
		description:
			"A Case taken apart — a failed require ends the test where it stands.",
		body: ["require #${1:Value}(${2:binding}) = $0"],
		contexts: ["test"],
	},
	{
		prefix: "require-pattern",
		description:
			"A Pattern taken apart, with the whole of what it proved named beside its members.",
		body: ["require { ${1:member} } as ${2:whole} = $0"],
		contexts: ["test"],
	},
	{
		prefix: "snapshot",
		description:
			"An inline snapshot — the first run writes the value back here, through the formatter.",
		body: ["expect ${0:value} matches snapshot"],
		contexts: ["test"],
	},
	{
		prefix: "snapshot-from",
		description:
			"A named snapshot, kept in `__snapshots__` beside the file — where output too large to read inline belongs.",
		body: ['expect ${1:value} matches snapshot from "${0:name}"'],
		contexts: ["test"],
	},

	/* Values */

	{
		prefix: "record",
		description: "A Record literal.",
		body: ["{ ${1:member} = ${0:value} }"],
		contexts: ["expression"],
	},
	{
		prefix: "record-typed",
		description: "A typed Record literal.",
		body: ["${1:Type} ~> { ${2:member} = ${0:value} }"],
		contexts: ["expression"],
	},
	{
		prefix: "with",
		description:
			"An update — it answers a new Record and leaves the one it read alone.",
		body: ["{ ${1:record} with ${2:member} = ${0:value} }"],
		contexts: ["expression"],
	},
	{
		prefix: "with-self",
		description: "An update of `@`, the value a Method was called on.",
		body: ["{ @ with ${1:member} = ${0:value} }"],
		contexts: ["method"],
	},
	{
		prefix: "with-path",
		description:
			"An update through a path key — it reaches into a member rather than replacing it.",
		body: ["{ ${1:record} with ${2:member}.${3:nested} = ${0:value} }"],
		contexts: ["expression"],
	},
	{
		prefix: "with-descend",
		description:
			"An update that descends — a whole member list written one level down.",
		body: ["{ ${1:record} with ${2:member}.{ ${3:nested} = ${0:value} } }"],
		contexts: ["expression"],
	},
	{
		prefix: "dictionary",
		description:
			"A Dictionary literal — the same brackets a List is written in, and the `=` is the whole difference.",
		body: ['[${1:"key"} = ${0:value}]'],
		contexts: ["expression"],
	},
	{
		prefix: "dictionary-empty",
		description:
			"The empty Dictionary — spelled with the `=` that tells it from the empty List.",
		body: ["[=]"],
		contexts: ["expression"],
	},
	{
		prefix: "dictionary-with",
		description:
			"A Dictionary update — it sets its entries against a base and answers a new Dictionary.",
		body: ['[${1:dictionary} with ${2:"key"} = ${0:value}]'],
		contexts: ["expression"],
	},
	{
		prefix: "case-value",
		description: "A Case built with its payload written out.",
		body: ["#${1:Case}({ ${2:member} = ${0:value} })"],
		contexts: ["expression"],
	},
	{
		prefix: "case-prefixed",
		description:
			"A Case named through its Choice, for where no annotation says which Choice is meant.",
		body: ["${1:Choice}#${0:Case}"],
		contexts: ["expression"],
	},
	{
		prefix: "closure",
		description:
			"A Function literal — its Parameter Types come from where it is written.",
		body: ["(${1:item}) { <- $0 }"],
		contexts: ["expression"],
	},
	{
		prefix: "closure-typed",
		description:
			"A Function literal stating its own Types, for where nothing else does.",
		body: ["(_ ${1:item}: ${2:Type}) -> ${3:ReturnType} { <- $0 }"],
		contexts: ["expression"],
	},
	{
		prefix: "method-namespaced",
		description:
			"A Method call naming the Namespace that answers it, for where several would fit.",
		body: ["${1:value}::<${2:Namespace}>${3:method}($0)"],
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
		prefix: "elseif",
		description: "An if statement with a second condition behind it.",
		body: [
			"if ${1:condition} {",
			"\t$2",
			"} else if ${3:condition} {",
			"\t$0",
			"}",
		],
		contexts: ["implementation", "tests", "test"],
	},
	{
		prefix: "narrow",
		description:
			"A refinement doorway — the branch that proved the predicate is the only one reaching the operation demanding it.",
		// NOTE: The doorway HOLDS its answer rather than returning it. This is
		// offered wherever a Statement may stand, and the top of a section is
		// one of those places — a `<-` written there is a `top-level-return`,
		// which makes this a scaffold that writes a Diagnostic into the
		// reader's file.
		body: [
			"if ${1:value}::${2:isNot}(${3:0}) {",
			"\tconstant ${4:answer} = ${0:proven}(${1:value})",
			"}",
		],
		contexts: ["implementation"],
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
		prefix: "case-payload",
		description: "A case handler naming what the Case's constructor took.",
		body: ["case #${1:Case}(${2:binding}) { <- ${0:value} }"],
		contexts: ["match"],
	},
	{
		prefix: "case-pattern",
		description: "A case handler taking the Case's payload apart.",
		body: ["case #${1:Case}({ ${2:member} }) { <- ${0:value} }"],
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
	{
		prefix: "define-typed",
		description:
			"A definition by cases saying what the whole of it answers.",
		body: [
			"define -> ${1:ReturnType} {",
			"\tas ${2:value} if ${3:condition}",
			"\tas ${0:value} otherwise",
			"}",
		],
		contexts: ["expression"],
	},
	{
		prefix: "loop",
		description:
			"The counted loop — once per Integer from one end to the other, threading a State.",
		body: [
			"loop(from ${1:1}, through ${2:10}, startingWith ${3:0}, (${4:index}, ${5:total}) {",
			"\t<- $0",
			"})",
		],
		contexts: ["expression"],
	},
	{
		prefix: "loop-step",
		description:
			"The loop that can leave early — a `step` answers `#Continue` to carry on and `#Done` to stop.",
		body: [
			"loop(",
			"\tstartingWith ${1:state},",
			"\tstep (${2:current}) {",
			"\t\tif ${3:condition} {",
			"\t\t\t<- #Done(${4:result})",
			"\t\t}",
			"",
			"\t\t<- #Continue($0)",
			"\t},",
			")",
		],
		contexts: ["expression"],
	},
	{
		prefix: "loop-while",
		description:
			"The condition-driven loop — it checks before each step, so a predicate already decided answers the seed.",
		body: [
			"loop(",
			"\tstartingWith ${1:1},",
			"\twhile (${2:value}) { <- ${3:condition} },",
			"\t(${4:value}) { <- $0 },",
			")",
		],
		contexts: ["expression"],
	},

	/* Asynchrony */

	{
		prefix: "complete",
		description:
			"Wait for what a Future or a Started answers with — legal in a body that declares one, and at the top of a Program.",
		body: ["complete ${0:future}"],
		contexts: ["expression"],
	},
	{
		prefix: "start",
		description:
			"Put a Future in flight and answer the one run of it, without waiting for it.",
		body: ["start ${0:future}"],
		contexts: ["expression"],
	},
	{
		prefix: "function-completing",
		description:
			"A function that waits for something — it answers a Future, and its '<-' answers with the value inside one.",
		body: [
			"function ${1:name}(${2:_} ${3:parameter}: ${4:Type}) -> Future<${5:ReturnType}> {",
			"\tconstant ${6:value} = complete ${7:future}",
			"",
			"\t<- $0",
			"}",
		],
		contexts: ["implementation", "tests", "test"],
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
	{
		prefix: "doc-example",
		description:
			"An @example block — its assertions are compiled and run as tests of their own.",
		body: ["§§ @example", "§§   expect ${1:value}::is(${0:expected})"],
		contexts: ["implementation", "declarations", "namespace", "protocol"],
	},
	{
		prefix: "doc-param",
		description:
			"An @param tag — the em-dash is what separates the name from its description.",
		body: ["§§ @param ${1:name} — ${0:what it carries}"],
		contexts: ["implementation", "declarations", "namespace", "protocol"],
	},
]
