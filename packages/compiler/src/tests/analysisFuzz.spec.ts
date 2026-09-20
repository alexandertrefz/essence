import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { fixturePath } from "@essence-lang/fixtures"
import { type common, lexer as lexerTypes } from "@essence-lang/interfaces"
import { STDLIB_DIRECTORY } from "@essence-lang/standard-library"

import { analyseSource } from "../analysis"
import { Lexer } from "../lexer/index"
import { parseWithDiagnostics } from "../parser/index"

// NOTE: The guard that makes running every stage over a broken Program safe.
//
// The Validator used to see only Programs the two stages in front of it had
// nothing to say about, so every Type it read was one the Enricher had
// established. It now reads Programs those stages RECOVERED — an Error where a
// name did not resolve, a body missing the Statement the Parser dropped — and
// what it must never do there is throw, or report a mistake whose whole cause
// is the hole. A spec written by hand can only cover the holes somebody thought
// of; this one breaks real sources at every site there is.
//
// NOTE: Deterministic, and no timing assertion anywhere. Every mutant is a
// function of the corpus text and an index into it: the same files produce the
// same mutants in the same order on every machine, so a failure names a mutant
// anybody can rebuild. It is a SPEC, so it takes a few hundred sites — the
// thousands-of-sites sweep is an offline run over the same mutator.

const TokenType = lexerTypes.TokenType
type Token = lexerTypes.Token

// NOTE: Whole, valid sources — the mutants have to start from a Program with
// nothing wrong with it, or what they measure is the file rather than the
// mutation. A standard library source is left out: it is one shared declaration
// space whose names are already builtins, and analysing it as an ordinary
// Program reports every one of them as a redeclaration of itself.
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
		// NOTE: An unterminated String is the Lexer's one fatal error. The
		// Tokens in front of it are still mutation sites.
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

// NOTE: One mutation per mutant, at a site the Token stream names — a deleted
// Token, a name nothing declares, a Number written as a String, a dropped `<-`,
// a dropped closing bracket. Each is a mistake a reader really makes, and each
// lands in a different stage: a dropped bracket is the Parser's, an undeclared
// name the Enricher's, a retyped literal the Validator's.
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

// NOTE: A fixed number of sites per file, spread across the whole file rather
// than taken off its head — a stride, so that a file's last Statement is
// mutated as often as its first. Adding a file to the corpus changes which
// sites are picked in that file and in no other.
const SITES_PER_FILE = 12

function mutantsOf(file: { name: string; text: string }): Array<Mutation> {
	let mutations = mutationsOf(file.text)
	let stride = Math.max(1, Math.floor(mutations.length / SITES_PER_FILE))

	return mutations.filter((_, index) => index % stride === 0)
}

// NOTE: Every Position the Enricher wrote an Error onto — the holes a Validator
// Diagnostic may not point into. Read off the typed tree by walking every
// field, for the reason `eraseRefinements` walks one: a hole in a Node kind
// this did not name by hand would be a hole nothing checks.
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

// NOTE: Which stage a Diagnostic came from, by its code — the Validator's own
// codes are the ones this spec has anything to say about, since it is the
// Validator that now reads a Program it never used to see. A code both stages
// can report is not in the set: the question asked of it would be about which
// of them said it, and the fingerprint does not carry that.
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

describe("analysing a broken Program", () => {
	let files = corpus()
	let mutants = files.flatMap((file) =>
		mutantsOf(file).map((mutation) => ({ file: file.name, mutation })),
	)

	it("has a corpus to break", () => {
		expect(files.length).toBeGreaterThan(20)
		expect(mutants.length).toBeGreaterThan(200)
	})

	// NOTE: The corpus itself has to be clean, or every verdict below is about
	// a file rather than about a mutation.
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
	})

	it("never throws and never blames itself", () => {
		for (let { file, mutation } of mutants) {
			let name = `${file} ${mutation.kind}@${mutation.index}`
			let codes: Array<string> = []

			expect(() => {
				codes = analyseSource(mutation.source).diagnostics.map(
					(diagnostic) => diagnostic.code,
				)
			}).not.toThrow()

			// NOTE: An `internal-error` out of a Program that has a genuine
			// mistake in it is the Compiler blaming itself for the recovery.
			expect([
				name,
				codes.filter((code) => code === "internal-error"),
			]).toEqual([name, []])
		}
	})

	// NOTE: The no-cascade rule, measured two ways. A Validator Diagnostic
	// standing INSIDE the span of something the Enricher typed Error is a
	// verdict about a hole; and two Diagnostics sharing one Position are two
	// stages answering the same mistake in different words.
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

			// NOTE: And no Validator Diagnostic standing where another stage has
			// already put one. Two verdicts at one Position are two answers to
			// one mistake, and the Validator's is the one that is new here —
			// the Parser's own double reports are its business and are as old
			// as the recovery.
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
	})
})

// NOTE: Two things the same Compiler must say the same way twice, measured over
// the same mutants.
//
// A Diagnostic is TEXT a reader compares against what they remember, a Snapshot
// records, and a bug report quotes. So nothing the Compiler made up for its own
// bookkeeping may reach one — and nothing that depends on how much work the
// process did before this analysis may either, or the same file analysed twice
// in one session says two different things and neither of them is wrong.
describe("the same broken Program, analysed twice", () => {
	let mutants = corpus().flatMap((file) =>
		mutantsOf(file).map((mutation) => ({ file: file.name, mutation })),
	)

	// NOTE: A callee's Type Parameters are alpha-renamed for the span of one
	// invocation — `ItemType` becomes `ItemType`, a ZERO-WIDTH SPACE and a
	// counter — and a Parameter that never binds is still carrying that name
	// where a report picks it up. Only the separator is invisible, so the
	// reader was shown `ItemType57`; and the counter is process-wide, so the
	// number changed every time the same file was analysed again. The separator
	// is the one thing no source Generic can hold, which makes it exactly the
	// thing to search a message for.
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
	})

	// NOTE: And the whole report, three times over, in ONE process. A counter,
	// a cache keyed on something it should not be, a Map iterated in insertion
	// order that another run filled differently — each of them shows up here and
	// nowhere else, because every other spec analyses each source once.
	it("says the same thing three times running", () => {
		for (let { file, mutation } of mutants) {
			let name = `${file} ${mutation.kind}@${mutation.index}`
			let first = fingerprints(mutation.source)

			expect([name, fingerprints(mutation.source)]).toEqual([name, first])
			expect([name, fingerprints(mutation.source)]).toEqual([name, first])
		}
	})
})

// NOTE: Everything a reader sees, in the order they see it — the message, where
// it points, and every line under it. A determinism check written over the codes
// alone passes through a counter that only ever reaches a Note.
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

// NOTE: The keywords a name is DECLARED after. A mutant that renames a
// declaration renames one end of a binding and leaves the other alone, so what
// reports is the READ somewhere else in the file — or nothing at all, where
// nothing reads it. Those are not the sites this measures.
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

// NOTE: Whether the Identifier at `index` stands where the Program READS a
// name, rather than where it binds one. A binder is not a read: renaming
// `constant total` leaves every `total` below it reporting instead, and
// renaming a Parameter or a Record key reports nothing anywhere, because
// nothing was looking the name up.
//
// Three shapes are bindings: a name after one of the declaring keywords above,
// a name a `:` or `=` follows (a Parameter's annotation, a Record member's
// value), and a Function literal's Parameter list — `(count, item) { … }`,
// which is the one parenthesised run whose `)` is followed by a `{`.
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

// NOTE: The check that a genuine mistake is never SILENCED — the one every
// stand-down in the recovery has to survive. Replacing a name a Program reads
// with one nothing declares is a mistake by construction, so the analysis owes
// a report about it: at the mutation site, under whichever "no such name" code
// the position calls for.
//
// The exception is the whole point of the recovery: a site standing in text the
// Parser ABANDONED is a site inside a syntax error, and answering it a second
// time is the cascade all of this exists to remove. A mutation that breaks the
// parse is excused, and only that.
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
		for (let file of corpus()) {
			let tokens = tokensOf(file.text)
			// NOTE: The implementation only. A `tests { … }` block is left
			// parsed and never enriched unless the compile ASKED for the tests,
			// so a name broken in one is a name nothing looked at.
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

				// NOTE: A mutation that broke the parse is excused — and only
				// that. Every other one has to be answered.
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

				// NOTE: At the mutation site where the site READS the name, and
				// somewhere otherwise — a site this could not tell from a
				// binder renames one end of a binding, and what answers is the
				// read at the other end. Either way the mistake is ANSWERED,
				// which is the whole of what a stand-down may not take away.
				expect([name, errors.length > 0 || here.length > 0]).toEqual([
					name,
					true,
				])
			}
		}
	})
})
