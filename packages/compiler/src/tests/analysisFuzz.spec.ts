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

// Whether the Identifier at `index` reads a name rather than binding one. A
// binding is a name after a `DECLARING_TOKEN_TYPES` keyword, a name followed
// by `:` or `=`, or a Function literal's Parameter. That last is the one
// parenthesised run whose `)` is followed by a `{`.
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

	return !insideFunctionLiteralParameters(tokens, index)
}

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
				return tokens[step + 1]?.type === TokenType.SymbolLeftBrace
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
// an undeclared one owes a report. Only a mutation that breaks the parse is
// excused, since reporting it again would be the cascade the recovery removes.
describe("a name nothing declares, in a Program that parsed", () => {
	const NAME_CODES = new Set([
		"unknown-name",
		"unknown-type",
		"unknown-method",
		"unknown-case",
		"unknown-member",
		"unknown-namespace",
	])

	it("is reported where it is written", () => {
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

				// `here` is a subset of `errors`, so this asserts only that some
				// error is reported, not that it stands at the mutation site.
				expect([name, errors.length > 0 || here.length > 0]).toEqual([
					name,
					true,
				])
			}
		}
	}, 60_000)
})

// The undeclared `Seat` is an Error, so `List.of`'s `ItemType` never binds.
// The key's bound is then checked against the renamed Type Parameter, and the
// report must still name `ItemType` the same way every time.
describe("a bound checked against a Type Parameter mid-inference", () => {
	let source = `implementation {
	constant seats: List<Seat> = List.of(integersFrom 0, through 9)
		::map((number) { <- { row = number, seat = 1 } })

	constant noSeats: Dictionary<Seat, Integer> = [=]

	constant taken: Dictionary<Seat, Integer> = seats::reduce(
		startingWith noSeats,
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
})
