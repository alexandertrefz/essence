import type { common } from "@essence-lang/interfaces"

// NOTE: The habits of the languages people arrive from, and what Essence writes
// in their place. One table rather than one per stage, because WHICH stage meets
// a habit is decided by how it lexes rather than by what it is: `a && b` is three
// Tokens and is refused where the Expression ends, while `!ready` is a single
// Identifier that nothing refuses until a name lookup fails on it. The two sites
// would otherwise answer the same mistake in two voices.
//
// NOTE: Every Help here names a Method the standard library really declares,
// with the labels it really takes — a Help that offers a call which resolves to
// nothing sends a reader from one refusal to the next.

// NOTE: The shared note under every operator. It says the rule rather than the
// spelling, because the spelling is what the Helps are for, and because the rule
// is the one thing that makes the whole family make sense at once.
export const operatorNote =
	"Arithmetic, comparison and logic are Method calls in Essence, read left to right — there are no operators, and so no precedence to remember."

// NOTE: Keyed by the operator EXACTLY as it is written, so that `==` and `===`
// are two entries rather than one normalised away: a reader who wrote `===` is
// answered about `===`.
const operatorHelps: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
	[
		"+",
		[
			"Write 'a::add(b)' for Numbers.",
			"Write 'a::append(b)' to join two Strings.",
		],
	],
	[
		"-",
		[
			"Write 'a::subtract(b)'.",
			"Write 'x::negate()' to flip a sign — a '-' only signs a Number Literal.",
		],
	],
	["*", ["Write 'a::multiply(with b)'."]],
	[
		"/",
		[
			"Write 'a::divide(by b)', which answers an Optional unless 'b' is proven not to be zero.",
		],
	],
	["%", ["Write 'a::remainder(dividingBy b)'."]],
	["**", ["Write 'a::raise(to b)'."]],
	[
		"==",
		[
			"Write 'a::is(b)', which compares Records and Lists by their content.",
		],
	],
	[
		"===",
		[
			"Write 'a::is(b)', which compares Records and Lists by their content.",
		],
	],
	["!=", ["Write 'a::isNot(b)'."]],
	["!==", ["Write 'a::isNot(b)'."]],
	["<", ["Write 'a::isLessThan(b)'."]],
	["<=", ["Write 'a::isLessThanOrEqualTo(b)'."]],
	[">", ["Write 'a::isGreaterThan(b)'."]],
	[">=", ["Write 'a::isGreaterThanOrEqualTo(b)'."]],
	[
		"&&",
		[
			"Write 'a::and(b)' — both sides are worked out, so nest an 'if' where the right one must not run.",
		],
	],
	["||", ["Write 'a::or(b)' — both sides are worked out."]],
	["!", ["Write 'x::negate()'."]],
	// NOTE: The compound assignments are the one family whose table entry is a
	// SCHEMATIC rather than a spelling: what they are short for names the
	// binding twice, so a Help that spells it has to spell the reader's own
	// name or none at all. `count` read as one, and `tally += 5` was answered
	// `Write 'count = count::add(1)'` — two undeclared names and the wrong
	// amount. Every site that meets one has the operands in hand and builds the
	// sentence with `compoundAssignmentHelps`; these stand for the one that
	// somehow does not, and they say `x` and `n` the way the rest of the table
	// does.
	["+=", ["Write 'x = x::add(n)'."]],
	["-=", ["Write 'x = x::subtract(n)'."]],
	["*=", ["Write 'x = x::multiply(with n)'."]],
	// NOTE: `quotient`, not `divide`, because what is written here is a
	// reassignment: `divide(by:)` answers a fraction, and a counter it is
	// written back into is an Integer. The Help that does not type-check is the
	// one that sends a reader from this refusal to the next.
	[
		"/=",
		[
			"Write 'x = x::quotient(dividingBy n)', which answers a whole number.",
			"Or 'x::divide(by n)' where the answer is a fraction, which is a Rational rather than an Integer.",
		],
	],
	["%=", ["Write 'x = x::remainder(dividingBy n)'."]],
	["++", ["Write 'x = x::add(1)'."]],
	["--", ["Write 'x = x::subtract(1)'."]],
	[
		"??",
		[
			"Write 'x::value(defaultingTo d)' — a value that may be missing is an Optional.",
		],
	],
])

// NOTE: The operators that carry no Method at all. They are answered with the
// same code as the rest, because what a reader needs to hear is the same
// sentence: this is not how Essence says things. What is said about them is a
// NOTE rather than a Help, though — "Essence has no bitwise operations" is a
// rule in an action's clothes, and a reader who follows a Help is owed an edit
// they can make where they are standing.
//
// NOTE: `|` is not here, and neither is `?.`. A `|` written between two values
// is Essence's own Union lexeme wherever a Type is read, so it is excluded from
// the family outright — see `essenceLexemes` — and an entry for it would never
// be reached. A `?.` never forms as a lexeme either: a `.` ends a name, so
// `user?.name` arrives as `user?` and is answered by the postfix rule, which
// has the operand in hand and can name it.
const unsupportedOperators: ReadonlySet<string> = new Set([
	"&",
	"^",
	"<<",
	">>",
])

// NOTE: What stands in a Help's place for those four. It says the whole of what
// is true — the language has none of this, and there is nothing to write
// instead — which is what makes a Help unnecessary rather than merely absent.
export const bitwiseNote =
	"Essence has no bitwise operations, and no Method stands in for one."

// NOTE: Whether a written text is an operator this language deliberately has
// none of, and what to write instead. Null for everything else, which is what
// makes this the whole test at every site that asks it; an EMPTY list is an
// operator that is answered with a Note alone.
export function foreignOperatorHelps(
	operator: string,
): ReadonlyArray<string> | null {
	let helps = operatorHelps.get(operator)

	if (helps !== undefined) {
		return helps
	}

	return unsupportedOperators.has(operator) ? [] : null
}

// NOTE: The compound assignments, spelled with the operands the reader wrote.
// `tally += 5` is short for `tally = tally::add(5)`, and the whole of what makes
// that Help worth printing is that it names `tally` and `5` rather than a
// binding nobody declared. Null for every other operator, which is what lets a
// site ask this of whatever it met and print the table's own answer otherwise.
//
// `amount` is null where the right operand is not one piece of text this site
// can hand over — a call, a parenthesised Expression, a second line — and the
// Help writes `…` in its place rather than a number nobody wrote.
export function compoundAssignmentHelps(
	operator: string,
	target: string,
	amount: string | null,
): ReadonlyArray<string> | null {
	let written = amount ?? "…"

	switch (operator) {
		case "+=":
			return [`Write '${target} = ${target}::add(${written})'.`]
		case "-=":
			return [`Write '${target} = ${target}::subtract(${written})'.`]
		case "*=":
			return [`Write '${target} = ${target}::multiply(with ${written})'.`]
		// NOTE: `quotient`, not `divide`, because what is written here is a
		// reassignment: `divide(by:)` answers a fraction, and a counter it is
		// written back into is an Integer. The Help that does not type-check is
		// the one that sends a reader from this refusal to the next.
		case "/=":
			return [
				`Write '${target} = ${target}::quotient(dividingBy ${written})', which answers a whole number.`,
				`Or '${target}::divide(by ${written})' where the answer is a fraction, which is a Rational rather than an Integer.`,
			]
		case "%=":
			return [
				`Write '${target} = ${target}::remainder(dividingBy ${written})'.`,
			]
		// NOTE: `++` and `--` carry their amount in the operator, so the right
		// operand is not read from the text and is never `…`.
		case "++":
			return [`Write '${target} = ${target}::add(1)'.`]
		case "--":
			return [`Write '${target} = ${target}::subtract(1)'.`]
		default:
			return null
	}
}

// NOTE: The characters an Essence name never holds and another language's
// operators are made of. A name is everything that is not a Symbol, a blank or a
// sigil, which is why the Lexer reads `!ready` and `a+b` as ONE Identifier each
// — there is no other class to put them in. This is what tells them apart again.
//
// The Symbols are deliberately absent: `-`, `/`, `<`, `>`, `=`, `|` and `:` each
// end a name where they stand, so an operator written out of them reaches the
// Parser as Tokens and is answered there.
export const foreignPunctuation = new Set("!$%&'*+;?\\^`")

// NOTE: The run of foreign punctuation a Token OPENS with, or null where it
// opens with none. The Lexer reads `+2` as one Identifier — a digit ends no name
// — so the operator and the operand arrive together, and what a refusal
// underlines is the operator alone.
export function foreignPunctuationLead(value: string): string | null {
	let end = 0

	while (end < value.length && foreignPunctuation.has(value[end] as string)) {
		end++
	}

	return end === 0 ? null : value.slice(0, end)
}

// NOTE: The operator hiding inside a name that resolves to nothing — the first
// run of punctuation in it, where that run is an operator some language has.
// Null for a name that merely holds an odd character, which is left to report as
// the undeclared name it is.
export function foreignOperatorIn(name: string): string | null {
	let start = [...name].findIndex((character) =>
		foreignPunctuation.has(character),
	)

	if (start === -1) {
		return null
	}

	let operator = foreignPunctuationLead(name.slice(start))

	if (operator === null || foreignOperatorHelps(operator) === null) {
		return null
	}

	return operator
}

// NOTE: One habit's worth of account, spelled once for the two stages that meet
// one. Which of them does is decided by how the habit lexes rather than by what
// it is, and what differs between them is what happens NEXT — the Parser throws
// this, the Enricher reports it — never what is said. Written twice, they drift:
// the `;` was answered with two different Notes depending on whether the Token
// in front of it ended a word.
export type ForeignAccount = {
	code: common.DiagnosticCode
	message: string
	label: string
	notes: Array<string>
	helps: Array<string>
}

// NOTE: `leadingHelps` is what the SITE knows and the table can not — the
// operand of a prefix operator, which only the Enricher has in hand. It
// REPLACES the table's own Help rather than standing above it: the table's is
// the same sentence with a placeholder where the reader's own name would go,
// and printing both said `Write 'ready::negate()'` and then `Write
// 'x::negate()'`.
export function foreignOperatorAccount(
	operator: string,
	leadingHelps: ReadonlyArray<string> = [],
): ForeignAccount | null {
	let helps = foreignOperatorHelps(operator)

	if (helps === null) {
		return null
	}

	return {
		code: "operator-not-supported",
		message: `Essence has no '${operator}' operator`,
		label: "this is not a Method call",
		notes: unsupportedOperators.has(operator)
			? [operatorNote, bitwiseNote]
			: [operatorNote],
		helps: leadingHelps.length === 0 ? [...helps] : [...leadingHelps],
	}
}

// NOTE: The `;` is the one habit BOTH stages meet, and for a reason neither of
// them chose: a `;` ends no name, so `total;` arrives as one Identifier and is
// answered by the Enricher, while `1;` is two Tokens and is answered by the
// Parser. A reader who wrote both in one file was told two different things
// about them.
export const semicolonAccount: ForeignAccount = {
	code: "foreign-syntax",
	message: "A Statement does not end with ';'",
	label: "nothing ends a Statement",
	notes: [
		"A Statement ends where its Expression ends — the Parser reads no line breaks either, so nothing has to be written between two of them.",
	],
	helps: ["Remove the ';'."],
}

// NOTE: What a habit written as a WORD is answered with. `spelling` is the text
// Essence writes in its place where one word replaces one word — which is what a
// Quick Fix rewrites — and null where the answer is a shape rather than a word:
// nothing is written in place of `throw`, a Result is returned instead.
export type ForeignWord = {
	spelling: string | null
	note: string
	helps: ReadonlyArray<string>
}

// NOTE: The words. Each is a name that resolves to nothing — every one of them
// would be an ordinary `unknown-name` — so a Program is free to declare any of
// them and this table is never consulted for it.
const foreignWords: ReadonlyMap<string, ForeignWord> = new Map([
	[
		"const",
		{
			spelling: "constant",
			note: "A binding is declared with 'constant', or with 'variable' where it is reassigned; there is no third form.",
			helps: ["Write 'constant' in place of 'const'."],
		},
	],
	[
		"let",
		{
			spelling: "variable",
			note: "A binding is declared with 'constant', or with 'variable' where it is reassigned; there is no third form.",
			helps: [
				"Write 'variable' in place of 'let'.",
				"Or 'constant', where the value is never reassigned.",
			],
		},
	],
	[
		"var",
		{
			spelling: "variable",
			note: "A binding is declared with 'constant', or with 'variable' where it is reassigned; there is no third form.",
			helps: [
				"Write 'variable' in place of 'var'.",
				"Or 'constant', where the value is never reassigned.",
			],
		},
	],
	// NOTE: Rust's `let mut x`, which is two words where Essence writes one. The
	// `let` is answered by its own entry, so what is left to say about the `mut`
	// is that it goes — and the empty spelling is what a Quick Fix removes it
	// with.
	[
		"mut",
		{
			spelling: "",
			note: "A binding is declared with 'constant', or with 'variable' where it is reassigned; there is no third form.",
			helps: ["Write 'variable' in place of 'let mut'."],
		},
	],
	[
		"return",
		{
			spelling: "<-",
			note: "A value leaves a Function through '<-', which is the arrow its signature writes its return Type with.",
			helps: ["Write '<-' in place of 'return'."],
		},
	],
	[
		"null",
		{
			spelling: "#Empty",
			note: "There is no null: a value that may be missing is an Optional, which is '#Value(x)' or '#Empty'.",
			helps: ["Write '#Empty'."],
		},
	],
	[
		"undefined",
		{
			spelling: "#Empty",
			note: "There is no undefined: a value that may be missing is an Optional, which is '#Value(x)' or '#Empty'.",
			helps: ["Write '#Empty'."],
		},
	],
	[
		"nil",
		{
			spelling: "#Empty",
			note: "A value that may be missing is an Optional, which is '#Value(x)' or '#Empty'.",
			helps: ["Write '#Empty'."],
		},
	],
	[
		"None",
		{
			spelling: "#Empty",
			note: "A value that may be missing is an Optional, which is '#Value(x)' or '#Empty'.",
			helps: ["Write '#Empty'."],
		},
	],
	[
		"Some",
		{
			spelling: "#Value",
			note: "A value that may be missing is an Optional, which is '#Value(x)' or '#Empty'.",
			helps: ["Write '#Value(x)' in place of 'Some(x)'."],
		},
	],
	[
		"this",
		{
			spelling: "@",
			note: "'@' is the receiver inside a Method — the value the Method was called on.",
			helps: ["Write '@' in place of 'this'."],
		},
	],
	[
		"self",
		{
			spelling: "@",
			note: "'@' is the receiver inside a Method — the value the Method was called on.",
			helps: ["Write '@' in place of 'self'."],
		},
	],
	[
		"print",
		{
			spelling: "Terminal.print",
			note: "Printing is a static Method of the 'Terminal' Namespace, reached through its name.",
			helps: ["Write 'Terminal.print(…)'."],
		},
	],
	// NOTE: The same word in four more languages. `println!` is keyed with its
	// `!`, which is what a reader wrote and what the Lexer hands over: a `!` ends
	// no name, so the macro arrives as one Identifier.
	[
		"println",
		{
			spelling: "Terminal.print",
			note: "Printing is a static Method of the 'Terminal' Namespace, reached through its name.",
			helps: ["Write 'Terminal.print(…)'."],
		},
	],
	[
		"println!",
		{
			spelling: "Terminal.print",
			note: "Printing is a static Method of the 'Terminal' Namespace, reached through its name — there are no macros, so nothing is spelled with a '!'.",
			helps: [
				"Write 'Terminal.print(\"count: {n}\")' — every String interpolates, so there is no format String to pass.",
			],
		},
	],
	[
		"puts",
		{
			spelling: "Terminal.print",
			note: "Printing is a static Method of the 'Terminal' Namespace, reached through its name.",
			helps: ["Write 'Terminal.print(…)'."],
		},
	],
	[
		"echo",
		{
			spelling: "Terminal.print",
			note: "Printing is a static Method of the 'Terminal' Namespace, reached through its name.",
			helps: ["Write 'Terminal.print(…)'."],
		},
	],
	// NOTE: No spelling. `fmt.Println(…)` would become `Terminal.Println(…)`,
	// which is a Method the Namespace does not declare — a fix that trades one
	// refusal for another.
	[
		"fmt",
		{
			spelling: null,
			note: "Printing is a static Method of the 'Terminal' Namespace, reached through its name.",
			helps: [
				"Write 'Terminal.print(…)' to print a value, and 'Terminal.inspect(…)' to print its structure.",
			],
		},
	],
	[
		"len",
		{
			spelling: null,
			note: "How much a value holds is a Method on the value itself, as every question about one is.",
			helps: [
				"Write 'items::length()', which answers for a List, a String and a Dictionary alike.",
			],
		},
	],
	[
		"console",
		{
			spelling: null,
			note: "Printing is a static Method of the 'Terminal' Namespace, reached through its name.",
			helps: [
				"Write 'Terminal.print(…)' to print a value, and 'Terminal.inspect(…)' to print its structure.",
			],
		},
	],
	[
		"Math",
		{
			spelling: null,
			note: "The Numbers carry their own Methods, and the 'Number' Namespace holds the ones that take two.",
			helps: [
				"Write 'n::absolute()', 'x::round()' or 'n::raise(to 2)' on the Number itself.",
				"Write 'Number.highest(a, b)' and 'Number.lowest(a, b)' for the two-value ones.",
			],
		},
	],
	[
		"parseInt",
		{
			spelling: "Integer.parse",
			note: "Reading a Number out of a String can fail, so it answers an Optional rather than a Number.",
			helps: [
				"Write 'Integer.parse(\"42\")', which answers '#Value(42)'.",
			],
		},
	],
	[
		"parseFloat",
		{
			spelling: "Rational.parse",
			note: "There is no floating point: an exact fraction is a Rational, and reading one out of a String answers an Optional.",
			helps: ["Write 'Rational.parse(\"0.5\")'."],
		},
	],
	[
		"NaN",
		{
			spelling: null,
			note: "There is no NaN and no Infinity: an operation that can fail answers an Optional instead.",
			helps: [
				"Write '#Empty' for the missing answer, and read one with 'match' or 'value(defaultingTo:)'.",
			],
		},
	],
	[
		"Infinity",
		{
			spelling: null,
			note: "There is no NaN and no Infinity: an operation that can fail answers an Optional instead.",
			helps: [
				"Write '#Empty' for the missing answer, and read one with 'match' or 'value(defaultingTo:)'.",
			],
		},
	],
	[
		"new",
		{
			spelling: null,
			note: "There is no 'new' and there are no classes: a Literal builds a value, and a static Method makes one where building it takes work.",
			helps: [
				"Write the Literal — '{ x = 1 }' for a Record, '[1, 2]' for a List, '[\"a\" = 1]' for a Dictionary.",
			],
		},
	],
	[
		"class",
		{
			spelling: null,
			note: "There are no classes: a 'type' names the shape and a 'namespace' holds the Methods over it.",
			helps: [
				"Write 'type Money = { euros: Integer }' and 'namespace Monies for Money { … }'.",
			],
		},
	],
	// NOTE: The word three more languages declare a Function with. One word
	// replaces one word, and what a reader then has to add is the annotations —
	// which the Help writes out, because a signature is where every Type in
	// Essence is written down.
	[
		"def",
		{
			spelling: "function",
			note: "A Function is declared with 'function', and its signature writes the Type of every Parameter and of what it answers.",
			helps: ["Write 'function greet(_ name: String) -> String { … }'."],
		},
	],
	[
		"fn",
		{
			spelling: "function",
			note: "A Function is declared with 'function', and its signature writes the Type of every Parameter and of what it answers.",
			helps: ["Write 'function greet(_ name: String) -> String { … }'."],
		},
	],
	[
		"func",
		{
			spelling: "function",
			note: "A Function is declared with 'function', and its signature writes the Type of every Parameter and of what it answers.",
			helps: ["Write 'function greet(_ name: String) -> String { … }'."],
		},
	],
	[
		"elif",
		{
			spelling: "else if",
			note: "An 'if' takes an Expression and a block, and 'else' carries the next one — there is no third word.",
			helps: ["Write 'else if' in place of 'elif'."],
		},
	],
	// NOTE: Swift's early exit. Nothing leaves a block early in Essence, so the
	// answer is a shape rather than a word: the value is taken apart, and both
	// Cases answer.
	[
		"guard",
		{
			spelling: null,
			note: "Nothing leaves a block early: an 'if' answers on both sides, and a 'match' takes a value apart and covers every Case.",
			helps: [
				"Write 'match held -> String { case #Value(value) { … } case #Empty { … } }'.",
			],
		},
	],
	[
		"enum",
		{
			spelling: "choice",
			note: "A closed set of Cases is a 'choice', and each of its Cases is written with a '#'.",
			helps: ["Write 'choice Colour { Red, Green }', used as '#Red'."],
		},
	],
	[
		"interface",
		{
			spelling: null,
			note: "A shape is a 'type' and a contract is a 'protocol'; nothing here is called an interface.",
			helps: [
				"Write 'type Point = { x: Integer }' for a shape.",
				"Write 'protocol Named { name() -> String }' for a contract.",
			],
		},
	],
	[
		"implements",
		{
			spelling: null,
			note: "A Namespace declares conformance in its head, and having the Methods is not conforming.",
			helps: ["Write 'namespace People for Person is Named { … }'."],
		},
	],
	[
		"extends",
		{
			spelling: null,
			note: "A Type Parameter is bounded by a Protocol, and a Protocol extends another in its own head.",
			helps: [
				"Write '<infer T is Comparable>' for a bound.",
				"Write 'protocol Loud is Named' for a Protocol that extends one.",
			],
		},
	],
	[
		"switch",
		{
			spelling: "match",
			note: "'match' branches on a value's Case, writes its answer Type, and has to cover every Case.",
			helps: ["Write 'match value -> String { case #Red { … } }'."],
		},
	],
	[
		"typeof",
		{
			spelling: null,
			note: "Nothing asks a value what it is at run time: a 'match' narrows a Union, and that is the whole of it.",
			helps: ["Write 'match value -> T { case Integer { … } }'."],
		},
	],
	[
		"instanceof",
		{
			spelling: null,
			note: "Nothing asks a value what it is at run time: a 'match' narrows a Union, and that is the whole of it.",
			helps: ["Write 'match value -> T { case Integer { … } }'."],
		},
	],
	[
		"throw",
		{
			spelling: null,
			note: "There are no exceptions: a failure that carries a reason is a Result, which is '#Value(value)' or '#Failure(reason)'.",
			helps: [
				"Answer '#Failure(reason)' from a Function whose return Type is a 'Result<T, F>'.",
			],
		},
	],
	[
		"try",
		{
			spelling: null,
			note: "There are no exceptions: a failure that carries a reason is a Result, which is '#Value(value)' or '#Failure(reason)'.",
			helps: [
				"Read one with 'match', with 'recover(with:)' or with 'reason()'.",
			],
		},
	],
	[
		"catch",
		{
			spelling: null,
			note: "There are no exceptions: a failure that carries a reason is a Result, which is '#Value(value)' or '#Failure(reason)'.",
			helps: [
				"Read one with 'match', with 'recover(with:)' or with 'reason()'.",
			],
		},
	],
	[
		"while",
		{
			spelling: null,
			note: "There is no loop Statement: iteration is 'map', 'reduce' and the 'loop' family, each of which answers a value.",
			helps: ["Write 'loop(startingWith state, while condition, step)'."],
		},
	],
	[
		"Map",
		{
			spelling: null,
			note: "A Dictionary is the keyed collection, and it is written in brackets rather than built.",
			helps: ["Write '[\"ann\" = 31]', or '[=]' for an empty one."],
		},
	],
	[
		"Set",
		{
			spelling: null,
			note: "There is no Set: a List answers the two questions one is kept for.",
			helps: [
				"Write a List and call 'removeDuplicates()' on it, and 'contains' to ask whether an item is in it.",
			],
		},
	],
	[
		"break",
		{
			spelling: null,
			note: "There is no loop Statement, so there is nothing to break out of: a stepped loop says when it is done with the value it answers.",
			helps: [
				"Answer '#Done(value)' from the step to stop, and '#Continue(next)' to go round again.",
			],
		},
	],
	[
		"continue",
		{
			spelling: null,
			note: "There is no loop Statement, so there is nothing to continue: a stepped loop says when it is done with the value it answers.",
			helps: [
				"Answer '#Done(value)' from the step to stop, and '#Continue(next)' to go round again.",
			],
		},
	],
	[
		"async",
		{
			spelling: null,
			note: "There is no 'async' and no 'await': work that has not run is a 'Future', which is a value like any other.",
			helps: [
				"Write 'start work' to put a Future in flight, and 'complete started' to wait for what it answers.",
			],
		},
	],
	[
		"await",
		{
			spelling: "complete",
			note: "There is no 'async' and no 'await': work that has not run is a 'Future', which is a value like any other.",
			helps: ["Write 'complete' in place of 'await'."],
		},
	],
	[
		"require",
		{
			spelling: null,
			note: "A Module is named by a relative path to an '.es' file, in an 'import' block above the implementation.",
			helps: ["Write 'import { from \"./Money.es\" { twice } }'."],
		},
	],
])

export function foreignWord(name: string): ForeignWord | null {
	return foreignWords.get(name) ?? null
}
