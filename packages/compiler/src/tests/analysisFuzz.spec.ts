import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { fixturePath } from "@essence-lang/fixtures"
import { type common, lexer as lexerTypes } from "@essence-lang/interfaces"
import { STDLIB_DIRECTORY } from "@essence-lang/standard-library"

import { analyseSource } from "../analysis"
import { Lexer } from "../lexer/index"
import { parseWithDiagnostics } from "../parser/index"

// Every stage runs over a broken Program, so the Validator reads recovered
// Programs. They hold an Error where a name did not resolve, or a body missing
// a dropped Statement. The Validator must never throw there, nor report a
// mistake caused only by the hole. These specs break real sources at spread
// sites.
//
// Every mutant is a function of the corpus text and an index, so a failure
// names a mutant anybody can rebuild. Nothing asserts timing.

const TokenType = lexerTypes.TokenType
type Token = lexerTypes.Token

// Valid sources, so a verdict is about the mutation rather than the file. A
// `declarations` source is left out: its names are already builtins, so an
// ordinary analysis reports each as a redeclaration.
function corpus(): Array<{ name: string; text: string }> {
	let directories = [fixturePath(), STDLIB_DIRECTORY]
	let files: Array<{ name: string; text: string }> = []

	for (let directory of directories) {
		for (let entry of readdirSync(directory, { withFileTypes: true }).sort(
			(left, right) => left.name.localeCompare(right.name),
		)) {
			if (!entry.isFile() || !entry.name.endsWith(".es")) {
				continue
			}

			let text = readFileSync(path.join(directory, entry.name), "utf8")

			if (text.includes("declarations {")) {
				continue
			}

			files.push({ name: entry.name, text })
		}
	}

	return files
}

function tokensOf(source: string): Array<Token> {
	let lexer = new Lexer()

	lexer.ignore(TokenType.Comment)
	lexer.ignore(TokenType.Linebreak)
	lexer.ignore(TokenType.DocComment)
	lexer.reset(source)

	let tokens: Array<Token> = []

	try {
		let token = lexer.next()

		while (token !== undefined) {
			tokens.push(token)
			token = lexer.next()
		}
	} catch {
		// An unterminated String throws. The Tokens before it are still
		// mutation sites.
	}

	return tokens
}

type Mutation = { kind: string; index: number; source: string }

const CLOSERS = new Set([
	TokenType.SymbolRightParen,
	TokenType.SymbolRightBrace,
	TokenType.SymbolRightBracket,
])

const NAMES = new Set([TokenType.Identifier])

// One mutation per mutant, at a Token. It deletes a Token, undeclares a name,
// writes a Number as a String, or drops a `<-` or a closing bracket. These are
// real mistakes, and each reaches a different stage.
function mutationsOf(source: string): Array<Mutation> {
	let tokens = tokensOf(source)
	let mutations: Array<Mutation> = []
	let splice = (from: number, to: number, text: string) =>
		source.slice(0, from) + text + source.slice(to)

	for (let [index, token] of tokens.entries()) {
		mutations.push({
			kind: "delete-token",
			index,
			source: splice(token.start, token.end, ""),
		})

		if (NAMES.has(token.type)) {
			mutations.push({
				kind: "undeclare",
				index,
				source: splice(token.start, token.end, "zqNotDeclared"),
			})
		}

		if (token.type === TokenType.LiteralNumber) {
			mutations.push({
				kind: "retype-literal",
				index,
				source: splice(token.start, token.end, `"${token.value}"`),
			})
		}

		if (
			token.type === TokenType.SymbolLeftAngle &&
			tokens[index + 1]?.type === TokenType.SymbolDash
		) {
			mutations.push({
				kind: "drop-return",
				index,
				source: splice(token.start, tokens[index + 1]!.end, ""),
			})
		}

		if (CLOSERS.has(token.type)) {
			mutations.push({
				kind: "drop-closer",
				index,
				source: splice(token.start, token.end, ""),
			})
		}
	}

	return mutations
}

// A fixed number of sites per file, picked by a stride so the whole file is
// covered. Adding a file to the corpus changes no other file's sites.
const SITES_PER_FILE = 12

function mutantsOf(file: { name: string; text: string }): Array<Mutation> {
	let mutations = mutationsOf(file.text)
	let stride = Math.max(1, Math.floor(mutations.length / SITES_PER_FILE))

	return mutations.filter((_, index) => index % stride === 0)
}

// Every Position the Enricher typed Error, where no Validator Diagnostic may
// point. Walking every field means no Node kind is missed.
function errorSpans(program: common.typed.Program): Array<common.Position> {
	let spans: Array<common.Position> = []
	let seen = new Set<object>()

	let visit = (value: unknown): void => {
		if (value === null || typeof value !== "object" || seen.has(value)) {
			return
		}

		seen.add(value)

		if (Array.isArray(value)) {
			for (let item of value) {
				visit(item)
			}

			return
		}

		let record = value as Record<string, unknown>
		let type = record["type"] as { type?: string } | undefined
		let position = record["position"] as common.Position | undefined

		if (
			type?.type === "Error" &&
			position?.start !== undefined &&
			position.end !== undefined
		) {
			spans.push(position)
		}

		for (let child of Object.values(record)) {
			visit(child)
		}
	}

	visit(program)

	return spans
}

function inside(position: common.Position, span: common.Position): boolean {
	let after =
		position.start.line > span.start.line ||
		(position.start.line === span.start.line &&
			position.start.column >= span.start.column)
	let before =
		position.end.line < span.end.line ||
		(position.end.line === span.end.line &&
			position.end.column <= span.end.column)

	return after && before
}

function positionKey(diagnostic: common.Diagnostic): string {
	let position = diagnostic.position

	return position === null
		? "-"
		: `${position.start.line}:${position.start.column}`
}

// The codes only the Validator reports. A code both stages report is left
// out, since nothing here says which stage reported it.
const VALIDATOR_ONLY_CODES = new Set([
	"missing-return",
	"missing-case",
	"unreachable-case",
	"erased-case-conflict",
	"top-level-return",
	"define-without-cases",
	"literal-match-shape",
	"match-on-non-union",
	"condition-not-boolean",
	"expect-not-boolean",
	"zero-denominator",
	"infinite-recursion",
	"empty-list-overlap",
	"empty-dictionary-overlap",
	"type-argument-overlap",
	"dispatch-overlap",
	"unused-future",
	"unobserved-started",
])

// One corpus and one set of mutants for every describe, so the specs ask
// different questions of the same mutants.
const files = corpus()
const mutants = files.flatMap((file) =>
	mutantsOf(file).map((mutation) => ({ file: file.name, mutation })),
)

// The sweeps restate the budget `scripts/testBudget.ts` gives every spec.
// None asserts performance: each walks a fixed set of mutants.
describe("analysing a broken Program", () => {
	it("has a corpus to break", () => {
		expect(files.length).toBeGreaterThan(20)
		expect(mutants.length).toBeGreaterThan(200)
	})

	it("starts from Programs with nothing wrong with them", () => {
		for (let file of files) {
			expect([
				file.name,
				analyseSource(file.text)
					.diagnostics.filter(
						(diagnostic) => diagnostic.severity === "error",
					)
					.map((diagnostic) => diagnostic.code),
			]).toEqual([file.name, []])
		}
	}, 60_000)

	it("never throws and never blames itself", () => {
		for (let { file, mutation } of mutants) {
			let name = `${file} ${mutation.kind}@${mutation.index}`
			let codes: Array<string> = []

			expect(() => {
				codes = analyseSource(mutation.source).diagnostics.map(
					(diagnostic) => diagnostic.code,
				)
			}).not.toThrow()

			// An `internal-error` here would blame the Compiler for a real mistake.
			expect([
				name,
				codes.filter((code) => code === "internal-error"),
			]).toEqual([name, []])
		}
	}, 60_000)

	// No cascade. A Validator Diagnostic inside a span the Enricher typed
	// Error is about a hole. Two Diagnostics at one Position report one mistake
	// twice.
	it("says nothing about a hole, and nothing twice about one place", () => {
		for (let { file, mutation } of mutants) {
			let name = `${file} ${mutation.kind}@${mutation.index}`
			let analysed = analyseSource(mutation.source)
			let holes = errorSpans(analysed.program)
			let inHole = analysed.diagnostics.filter(
				(diagnostic) =>
					VALIDATOR_ONLY_CODES.has(diagnostic.code) &&
					diagnostic.position !== null &&
					holes.some((hole) => inside(diagnostic.position!, hole)),
			)

			expect([name, inHole.map((diagnostic) => diagnostic.code)]).toEqual(
				[name, []],
			)

			// Only doubles that include a Validator code count. The Parser's
			// own doubles are outside this spec.
			let seen = new Map<string, Array<string>>()

			for (let diagnostic of analysed.diagnostics) {
				let place = positionKey(diagnostic)

				seen.set(place, [...(seen.get(place) ?? []), diagnostic.code])
			}

			let doubled = [...seen]
				.filter(
					([place, codes]) =>
						place !== "-" &&
						codes.length > 1 &&
						codes.some((code) => VALIDATOR_ONLY_CODES.has(code)),
				)
				.map(([place, codes]) => `${place} ${codes.join("+")}`)

			expect([name, doubled]).toEqual([name, []])
		}
	}, 60_000)
})

// A Diagnostic is text that Snapshots record and bug reports quote. No name
// the Compiler invents may reach it, and it may not depend on what the process
// analysed before.
describe("the same broken Program, analysed twice", () => {
	// A callee's Type Parameters are renamed for one invocation with a
	// zero-width space and a process-wide counter. No source Generic holds that
	// separator, so the spec searches every message for it.
	it("names no Type Parameter the Compiler invented", () => {
		for (let { file, mutation } of mutants) {
			let name = `${file} ${mutation.kind}@${mutation.index}`
			let leaked = analyseSource(mutation.source)
				.diagnostics.filter((diagnostic) =>
					[
						diagnostic.message,
						...(diagnostic.notes ?? []),
						...(diagnostic.helps ?? []),
						...diagnostic.labels.map((label) => label.message),
					].some((text) => text?.includes("​") === true),
				)
				.map((diagnostic) => diagnostic.code)

			expect([name, leaked]).toEqual([name, []])
		}
	}, 60_000)

	// A derived Method borrows its Choice's Type Parameters under the separator
	// with no counter, and a Case is shown with its Type Arguments.
	it("names no Type Parameter a derived Method borrowed", () => {
		let texts = analyseSource(`implementation {
			choice Box<Value> { Full { value: Value }, Empty }

			constant b: Box<Integer> = Box<Integer>#Empty
			constant x = b::is(5)
		}`).diagnostics.flatMap((diagnostic) => [
			diagnostic.message,
			...(diagnostic.notes ?? []),
			...(diagnostic.helps ?? []),
			...diagnostic.labels.map((label) => label.message),
		])

		expect(texts).toContain(
			"'Choice_Equatable::is' takes 1 Argument: Parameter 1 is Box<Value>#Full | Box<Value>#Empty.",
		)
		expect(texts.filter((text) => text.includes("​"))).toEqual([])
	})

	// The whole report three times in one process. A counter, a wrongly keyed
	// cache or a Map filled in another order shows only here, since other specs
	// analyse each source once.
	it("says the same thing three times running", () => {
		for (let { file, mutation } of mutants) {
			let name = `${file} ${mutation.kind}@${mutation.index}`
			let first = fingerprints(mutation.source)

			expect([name, fingerprints(mutation.source)]).toEqual([name, first])
			expect([name, fingerprints(mutation.source)]).toEqual([name, first])
		}
	}, 60_000)
})

// Everything a reader sees, in order: the message, its place and every line
// under it. A check of the codes alone would miss a counter in a Note.
function fingerprints(source: string): Array<string> {
	return analyseSource(source).diagnostics.map((diagnostic) =>
		[
			diagnostic.severity,
			diagnostic.code,
			positionKey(diagnostic),
			diagnostic.message,
			...diagnostic.labels.map((label) => label.message ?? "-"),
			...(diagnostic.notes ?? []),
			...(diagnostic.helps ?? []),
		].join(" | "),
	)
}

// The keywords a name is declared after. Renaming a declaration leaves the
// reads elsewhere to report, or nothing where nothing reads it, so these sites
// are skipped.
const DECLARING_TOKEN_TYPES = new Set([
	TokenType.KeywordConstant,
	TokenType.KeywordVariable,
	TokenType.KeywordFunction,
	TokenType.KeywordOverload,
	TokenType.KeywordType,
	TokenType.KeywordChoice,
	TokenType.KeywordNamespace,
	TokenType.KeywordProtocol,
	TokenType.KeywordStatic,
	TokenType.KeywordInfer,
	TokenType.KeywordAs,
	TokenType.KeywordCase,
])

// Whether the Identifier at `index` reads a name in scope. A name after a
// `DECLARING_TOKEN_TYPES` keyword or before `:` or `=` binds one, as each shape
// in the list does. A label, a member key or an export reads nothing.
function readsAName(tokens: Array<Token>, index: number): boolean {
	let previous = tokens[index - 1]
	let next = tokens[index + 1]

	if (previous !== undefined && DECLARING_TOKEN_TYPES.has(previous.type)) {
		return false
	}

	if (
		next?.type === TokenType.SymbolColon ||
		next?.type === TokenType.SymbolEqual
	) {
		return false
	}

	return ![
		insideFunctionLiteralParameters,
		labelsAnArgument,
		declaresACase,
		declaresAMethod,
		declaresATypeParameter,
		startsAMemberPath,
		listsAnExport,
	].some((shape) => shape(tokens, index))
}

// A name in `export { … }`, which the Module linker checks. `analyseSource`
// reads one file and links nothing.
function listsAnExport(tokens: Array<Token>, index: number): boolean {
	let opener = enclosingOpener(tokens, index)

	return (
		opener !== null && tokens[opener - 1]?.type === TokenType.KeywordExport
	)
}

// Tokens that end an operand, so a name before one is the operand itself. A
// `.` after a space opens a member path, as in `on .value`.
const OPERAND_ENDS = new Set([
	TokenType.SymbolComma,
	TokenType.SymbolRightParen,
	TokenType.SymbolRightBrace,
	TokenType.SymbolRightBracket,
	TokenType.SymbolColon,
	TokenType.SymbolEqual,
])

// A label opens an Argument or a Parameter, and its value or internal name
// follows after a space, as in `to 2`, `where (n) { … }` or `against other:`.
function labelsAnArgument(tokens: Array<Token>, index: number): boolean {
	let previous = tokens[index - 1]?.type
	let next = tokens[index + 1]

	return (
		(previous === TokenType.SymbolLeftParen ||
			previous === TokenType.SymbolComma) &&
		next !== undefined &&
		next.start > tokens[index]!.end &&
		!OPERAND_ENDS.has(next.type)
	)
}

// A Case a `choice` declares, as `Red` in `choice Light { Red, Green }`.
function declaresACase(tokens: Array<Token>, index: number): boolean {
	let opener = enclosingOpener(tokens, index)

	if (
		opener === null ||
		tokens[opener]!.type !== TokenType.SymbolLeftBrace ||
		(tokens[index - 1]!.type !== TokenType.SymbolLeftBrace &&
			tokens[index - 1]!.type !== TokenType.SymbolComma)
	) {
		return false
	}

	let before = opener - 1

	// Past the Type Parameters of `choice Progress<State, Result> {`.
	if (tokens[before]?.type === TokenType.SymbolRightAngle) {
		while (
			before > 0 &&
			tokens[before]!.type !== TokenType.SymbolLeftAngle
		) {
			before--
		}

		before--
	}

	return tokens[before - 1]?.type === TokenType.KeywordChoice
}

// A Method a Namespace or a Protocol declares, written `name(…) -> Type` or
// `name<infer T>(…) -> Type`. A call written so stands after a receiver or
// after `match` instead.
function declaresAMethod(tokens: Array<Token>, index: number): boolean {
	let previous = tokens[index - 1]?.type
	let opener = index + 1

	if (tokens[opener]?.type === TokenType.SymbolLeftAngle) {
		while (
			opener < tokens.length &&
			tokens[opener]!.type !== TokenType.SymbolRightAngle
		) {
			opener++
		}

		opener++
	}

	if (
		tokens[opener]?.type !== TokenType.SymbolLeftParen ||
		previous === TokenType.SymbolColon ||
		previous === TokenType.SymbolDot ||
		previous === TokenType.KeywordMatch
	) {
		return false
	}

	let closer = matchingParen(tokens, opener)

	return (
		closer !== null &&
		tokens[closer + 1]?.type === TokenType.SymbolDash &&
		tokens[closer + 2]?.type === TokenType.SymbolRightAngle
	)
}

// A Type Parameter a declaration introduces, as `Value` in `choice Box<Value>`.
function declaresATypeParameter(tokens: Array<Token>, index: number): boolean {
	let step = index - 1

	while (tokens[step]?.type === TokenType.SymbolComma) {
		step -= 2
	}

	return (
		tokens[step]?.type === TokenType.SymbolLeftAngle &&
		tokens[step - 1]?.type === TokenType.Identifier &&
		tokens[step - 2] !== undefined &&
		DECLARING_TOKEN_TYPES.has(tokens[step - 2]!.type)
	)
}

// A member path key in a Record Literal, as `server` in `server.port = 1` or
// `server.{ … }`. It names a member of the Type, not a name in scope.
function startsAMemberPath(tokens: Array<Token>, index: number): boolean {
	let previous = tokens[index - 1]?.type

	if (
		previous !== TokenType.SymbolLeftBrace &&
		previous !== TokenType.SymbolComma
	) {
		return false
	}

	let step = index + 1

	while (
		tokens[step]?.type === TokenType.SymbolDot &&
		tokens[step + 1]?.type === TokenType.Identifier
	) {
		step += 2
	}

	let end = tokens[step]?.type

	return (
		(step > index + 1 && end === TokenType.SymbolEqual) ||
		(end === TokenType.SymbolDot &&
			tokens[step + 1]?.type === TokenType.SymbolLeftBrace)
	)
}

// A `(` written against the name before it, as a call's is.
function opensACall(tokens: Array<Token>, opener: number | null): boolean {
	let callee = opener === null ? undefined : tokens[opener - 1]

	return (
		callee?.type === TokenType.Identifier &&
		callee.end === tokens[opener!]!.start
	)
}

// The `)` that closes the `(` at `index`.
function matchingParen(tokens: Array<Token>, index: number): number | null {
	let depth = 0

	for (let step = index; step < tokens.length; step++) {
		let type = tokens[step]!.type

		if (type === TokenType.SymbolLeftParen) {
			depth++
		} else if (type === TokenType.SymbolRightParen && --depth === 0) {
			return step
		}
	}

	return null
}

const OPENERS = new Set([
	TokenType.SymbolLeftParen,
	TokenType.SymbolLeftBrace,
	TokenType.SymbolLeftBracket,
])

// The nearest bracket opened before `index` and not yet closed.
function enclosingOpener(tokens: Array<Token>, index: number): number | null {
	let depth = 0

	for (let step = index - 1; step >= 0; step--) {
		let type = tokens[step]!.type

		if (CLOSERS.has(type)) {
			depth++
		} else if (OPENERS.has(type)) {
			if (depth === 0) {
				return step
			}

			depth--
		}
	}

	return null
}

// A Function literal's Parameter, inside the one parenthesised run whose `)`
// is followed by `{`, or by `->` where the `(` opens no call.
function insideFunctionLiteralParameters(
	tokens: Array<Token>,
	index: number,
): boolean {
	let depth = 0

	for (let step = index + 1; step < tokens.length; step++) {
		let token = tokens[step]!

		if (token.type === TokenType.SymbolLeftParen) {
			depth++
		} else if (token.type === TokenType.SymbolRightParen) {
			if (depth === 0) {
				return (
					tokens[step + 1]?.type === TokenType.SymbolLeftBrace ||
					(tokens[step + 1]?.type === TokenType.SymbolDash &&
						tokens[step + 2]?.type === TokenType.SymbolRightAngle &&
						!opensACall(tokens, enclosingOpener(tokens, index)))
				)
			}

			depth--
		} else if (
			token.type === TokenType.SymbolLeftBrace ||
			token.type === TokenType.SymbolRightBrace
		) {
			return false
		}
	}

	return false
}

// A real mistake is never silenced by a stand-down. Replacing a read name with
// an undeclared one owes a report at that name. Only a mutation that breaks the
// parse is excused, since reporting it again would be the cascade the recovery
// removes.
describe("a name nothing declares, in a Program that parsed", () => {
	const NAME_CODES = new Set([
		"unknown-name",
		"unknown-type",
		"unknown-method",
		"unknown-case",
		"unknown-member",
		"unknown-protocol",
		"unknown-where-generic",
		"method-not-on-protocol",
	])

	it("is reported where it is written", () => {
		let misses: Array<string> = []

		for (let file of files) {
			let tokens = tokensOf(file.text)
			// The implementation only. A `tests { … }` block is not enriched
			// unless the compile asks for tests.
			let testsLine =
				file.text.split("\n").findIndex((line) => line === "tests {") +
				1
			let sites = tokens
				.map((token, index) => ({ token, index }))
				.filter(
					({ token, index }) =>
						token.type === TokenType.Identifier &&
						(testsLine === 0 ||
							token.position.start.line < testsLine) &&
						readsAName(tokens, index),
				)
			let stride = Math.max(1, Math.floor(sites.length / SITES_PER_FILE))

			for (let [step, { token, index }] of sites.entries()) {
				if (step % stride !== 0) {
					continue
				}

				let source =
					file.text.slice(0, token.start) +
					"zqNotDeclared" +
					file.text.slice(token.end)

				// Only a mutation that broke the parse is excused.
				if (
					(parseWithDiagnostics(source).program.recovery?.lines
						.length ?? 0) > 0
				) {
					continue
				}

				let name = `${file.name} undeclare@${index}`
				let errors = analyseSource(source).diagnostics.filter(
					(diagnostic) => diagnostic.severity === "error",
				)
				let here = errors.filter(
					(diagnostic) =>
						NAME_CODES.has(diagnostic.code) &&
						diagnostic.position?.start.line ===
							token.position.start.line &&
						diagnostic.position.start.column ===
							token.position.start.column,
				)

				if (here.length === 0) {
					let reported = errors.map(
						(error) => `${error.code}@${positionKey(error)}`,
					)

					misses.push(
						`${name} '${token.value}' -> ${reported.join(" ")}`,
					)
				}
			}
		}

		expect(misses).toEqual([])
	}, 60_000)
})

// An empty List leaves `reduce`'s `ItemType` unbound, so the key's bound is
// checked against the renamed Type Parameter. The report must still name
// `ItemType` the same way every time.
describe("a bound checked against a Type Parameter mid-inference", () => {
	let source = `implementation {
	constant seats = []

	constant taken = seats::reduce(
		startingWith [=],
		(dictionary, seat) { <- dictionary::set(seat, to 1) },
	)
}
`

	it("names the Type Parameter the source wrote", () => {
		expect(
			analyseSource(source)
				.diagnostics.filter(
					(diagnostic) => diagnostic.code === "unsatisfied-bound",
				)
				.map((diagnostic) => diagnostic.message),
		).toEqual(["Type Parameter 'ItemType' does not conform to 'Equatable'"])
	})

	it("says the same thing twice in one process", () => {
		expect(fingerprints(source)).toEqual(fingerprints(source))
	})

	// The undeclared `Seat` is an Error, which `List.of`'s `ItemType` binds, so
	// no bound is checked against it and `Seat` is all that is reported.
	it("reports an undeclared key Type and no bound beside it", () => {
		let undeclared = `implementation {
	constant seats: List<Seat> = List.of(integersFrom 0, through 9)
		::map((number) { <- { row = number, seat = 1 } })

	constant noSeats: Dictionary<Seat, Integer> = [=]

	constant taken: Dictionary<Seat, Integer> = seats::reduce(
		startingWith noSeats,
		(dictionary, seat) { <- dictionary::set(seat, to 1) },
	)
}
`

		expect(
			analyseSource(undeclared).diagnostics.map(
				(diagnostic) => diagnostic.code,
			),
		).toEqual(["unknown-type", "unknown-type", "unknown-type"])
	})
})
