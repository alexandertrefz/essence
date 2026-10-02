import type { common } from "@essence-lang/interfaces"

// The habits of other languages, and what Essence writes in their place. The
// Parser meets `a && b` as Tokens, and the Enricher meets `!ready` as a name it
// can not find. One table keeps their answers alike.
//
// Every Help names a Method the standard library declares, with the labels it
// takes, so following a Help never leads to another refusal.

// The note under every operator: the rule, where the Helps give the spelling.
export const operatorNote =
	"Arithmetic, comparison and logic are Method calls in Essence, read left to right — there are no operators, and so no precedence to remember."

// Keyed by the operator as written, so a reader who wrote `===` is answered
// about `===`, not `==`.
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
	// A compound assignment names its binding twice, so a site with the
	// operands builds its Help with `compoundAssignmentHelps`. These entries,
	// spelled with `x` and `n`, answer a site without them.
	["+=", ["Write 'x = x::add(n)'."]],
	["-=", ["Write 'x = x::subtract(n)'."]],
	["*=", ["Write 'x = x::multiply(with n)'."]],
	// `quotient`, not `divide`: `divide(by:)` answers a Rational, which an
	// Integer binding can not be reassigned to.
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

// The operators no Method stands in for. They share the code of the rest, but
// are answered with a note, since a Help must be an edit the reader can make.
// `|` is a lexeme of Essence's own, in `essenceLexemes`. `user?.name` lexes as
// `user?`, which the postfix rule answers.
const unsupportedOperators: ReadonlySet<string> = new Set([
	"&",
	"^",
	"<<",
	">>",
])

// The note that stands in place of a Help for `unsupportedOperators`.
export const bitwiseNote =
	"Essence has no bitwise operations, and no Method stands in for one."

// The Helps for an operator Essence does not have, or null for any other text.
// An empty list is an operator answered with a note alone.
export function foreignOperatorHelps(
	operator: string,
): ReadonlyArray<string> | null {
	let helps = operatorHelps.get(operator)

	if (helps !== undefined) {
		return helps
	}

	return unsupportedOperators.has(operator) ? [] : null
}

// The Help for a compound assignment, spelled with the reader's operands:
// `tally += 5` is answered `tally = tally::add(5)`. Null for any other operator.
// `amount` is null where the right operand is not one piece of text, and the
// Help writes `…` there.
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
		// `quotient`, not `divide`: `divide(by:)` answers a Rational, which
		// an Integer binding can not be reassigned to.
		case "/=":
			return [
				`Write '${target} = ${target}::quotient(dividingBy ${written})', which answers a whole number.`,
				`Or '${target}::divide(by ${written})' where the answer is a fraction, which is a Rational rather than an Integer.`,
			]
		case "%=":
			return [
				`Write '${target} = ${target}::remainder(dividingBy ${written})'.`,
			]
		// `??` is no assignment, but both its operands are on the line, so
		// its Help names them too.
		case "??":
			return [
				`Write '${target}::value(defaultingTo ${written})' — a value that may be missing is an Optional.`,
			]
		// `++` and `--` carry their amount in the operator.
		case "++":
			return [`Write '${target} = ${target}::add(1)'.`]
		case "--":
			return [`Write '${target} = ${target}::subtract(1)'.`]
		default:
			return null
	}
}

// The characters other languages build operators of that no written Essence
// name holds. The Lexer still reads `!ready` and `a+b` as one Identifier each,
// since a name is anything but a Symbol, a blank or a sigil. Symbols such as
// `-` and `<` end a name, so the Parser answers operators made of them.
export const foreignPunctuation = new Set("!$%&'*+;?\\^`")

// The run of foreign punctuation a Token opens with, or null. The Lexer reads
// `+2` as one Identifier, and a refusal underlines the operator alone.
export function foreignPunctuationLead(value: string): string | null {
	let end = 0

	while (end < value.length && foreignPunctuation.has(value[end] as string)) {
		end++
	}

	return end === 0 ? null : value.slice(0, end)
}

// The first run of punctuation in an unresolved name, where that run is an
// operator of another language. Null otherwise, and the name is reported as
// undeclared.
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

// What a Diagnostic about one habit says, whether the Parser throws it or the
// Enricher reports it.
export type ForeignAccount = {
	code: common.DiagnosticCode
	message: string
	label: string
	notes: Array<string>
	helps: Array<string>
}

// `leadingHelps` names the operand of a prefix operator, which only the
// Enricher has. It replaces the table's Help, which says the same with `x`.
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

// `total;` lexes as one Identifier and the Enricher answers it, while `1;` is
// two Tokens and the Parser answers it. Both say this.
export const semicolonAccount: ForeignAccount = {
	code: "foreign-syntax",
	message: "A Statement does not end with ';'",
	label: "nothing ends a Statement",
	notes: [
		"A Statement ends where its Expression ends — the Parser reads no line breaks either, so nothing has to be written between two of them.",
	],
	helps: ["Remove the ';'."],
}

// The words another language names the receiver with, Python's and Rust's
// `self` and JavaScript's `this`, written bare as a first Parameter.
export const receiverWords: ReadonlySet<string> = new Set(["self", "this"])

// Whose Parameter list a receiver word was written in. Only an instance
// Method has a receiver.
export type ParameterListOwner = "Method" | "static Method" | "Function"

// `double(self)`: a receiver written as a first Parameter. In an instance
// Method the receiver is `@`. A static Method or a Function has none.
export function writtenReceiverAccount(
	word: string,
	owner: ParameterListOwner,
): ForeignAccount {
	if (owner !== "Method") {
		return {
			code: "foreign-syntax",
			message: `A ${owner} has no receiver for '${word}' to name`,
			label: "there is no receiver here",
			notes: [
				`Only an instance Method has a receiver, which it reads as '@'. A ${owner} takes only the Arguments its call writes.`,
			],
			helps: [
				`Remove '${word}', or give it a Type, as '${word}: …', where it is a Parameter of its own.`,
			],
		}
	}

	return {
		code: "foreign-syntax",
		message: `A Method takes no '${word}' Parameter`,
		label: "Essence's receiver is '@'",
		notes: [
			"A Method reads its receiver as '@', which no Parameter declares. A call passes it before the '::'.",
		],
		helps: [
			`Remove '${word}' from the Parameters, and read the receiver as '@' in the body.`,
		],
	}
}

// What a habit written as a word is answered with. `spelling` is the word a
// Quick Fix writes in its place, or null where the answer is a shape. Nothing
// replaces `throw`: a Result is returned instead.
export type ForeignWord = {
	spelling: string | null
	note: string
	helps: ReadonlyArray<string>
}

// Each word is otherwise an `unknown-name`, so a Program may declare any of
// them, and the table is then not consulted.
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
	// Rust's `let mut x`. The `let` has its own entry, and the empty spelling
	// makes a Quick Fix remove the `mut`.
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
	// `println!` is keyed with its `!`, since a `!` ends no name and the
	// Lexer hands over the macro as one Identifier.
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
	// No spelling, since `fmt.Println(…)` would become `Terminal.Println(…)`,
	// which the Namespace does not declare.
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
	// The Help writes out a whole signature, since a reader replacing the
	// word still has to add every annotation.
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
	// Swift's early exit. The answer is a shape rather than a word: a `match`
	// that takes the value apart.
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
	// The answer is not written where `require` stands: an `import` block
	// goes before the implementation. So the Help says where, with `…` for the
	// path and the names.
	[
		"require",
		{
			spelling: null,
			note: "A Module is named by a relative path to an '.es' file, in an 'import' block above the implementation.",
			helps: [
				"Write the block above the implementation — 'import { from \"….es\" { … } }' — and name what it brings in where this call stands.",
			],
		},
	],
])

export function foreignWord(name: string): ForeignWord | null {
	return foreignWords.get(name) ?? null
}
