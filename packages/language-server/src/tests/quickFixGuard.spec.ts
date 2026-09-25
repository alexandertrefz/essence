import { afterAll, describe, expect, it } from "bun:test"
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { canonicalPath } from "@essence-lang/compiler/documents"
import { fixturePath } from "@essence-lang/fixtures"
import type { common } from "@essence-lang/interfaces"

import { analyse, analyseDocument } from "../analyse"
import {
	type CodeActionEdit,
	type CodeActionEntry,
	findCodeActions,
} from "../codeActions"
import { createWorkspace } from "../workspace"

let madeFolders: Array<string> = []

afterAll(() => {
	for (let folder of madeFolders) {
		rmSync(folder, { recursive: true, force: true })
	}

	madeFolders = []
})

// NOTE: The standing guard over every Quick Fix this Server offers, asked of
// every deliberately broken file there is. Each fix, applied alone to the
// original text:
//   (i)   raises no report the file did not already carry, except the codes
//         its allowance names, and without an allowance neither count rises
//   (ii)  does not leave the Diagnostic it was offered for with the identical
//         code, message and place, which is the definition of a loop
//   (iii) leaves a result that still parses, unless the original did not
//   (v)   writes only on the lines its Diagnostic stands on or their
//         neighbours, unless a reach allowance names the fix
//
// And each fix starts a chain, followed for up to eight rounds or until the
// result offers no quick fix. A round applies the quick fix offered for a report
// the previous round raised, or else the first one offered.
//   (iv)  no round raises the report or error count, a scaffold's round counted
//         without the codes its allowance names; no round breaks the parse;
//         and no fix is offered again on the Diagnostic it was applied to
//
// Deterministic and with no timing assertion: the corpus is a sorted directory
// listing and every edit is a function of the text it is applied to. The
// questions are asked by `answerFailures` and `chainFailures`, and the mutants
// in "The guard itself" check that each of them can fail.

// NOTE: Codes the Parser and the Lexer raise, which is what "does it still
// parse" is asked with — a fix that leaves a buffer the Parser can not read has
// taken the rest of the file's reports away with it.
const SYNTAX_CODES: ReadonlySet<string> = new Set([
	"syntax-error",
	"unexpected-token",
	"unclosed-string",
	"unclosed-block",
])

type Allowance = {
	// NOTE: Matched on the fix's title by PREFIX, because a title is built from
	// the reader's own names — "Implement 'Printable'" and "Implement 'Shown'"
	// are one fix.
	code: common.DiagnosticCode
	title: string
	reason: string
	// NOTE: What the fix is allowed to leave behind. A scaffold leaves a hole
	// BY DESIGN, and the hole has a code: naming it here is what keeps "the
	// count may rise" from meaning "anything may happen".
	followUp: Array<common.DiagnosticCode>
}

// NOTE: The scaffolding fixes, and nothing else. Each of these writes a hole
// the reader fills in, so the report that stands in the hole is the fix working
// rather than the fix failing — and each entry names the code that hole
// reports, so a fix that starts leaving a DIFFERENT one fails here.
//
// Unused entries fail this spec (see "every allowance is still earned"): an
// allowlist nobody checks is how a guard rots into a list of things that used
// to be true.
//
// The scaffolds the fixers named that the corpus does NOT reach — `Make 'X'
// Generatable` as a Quick Fix rather than as the rewrite below, `Add
// '<generic>'` for an unknown `where` name, the `define` arm and the `else`
// branch — are deliberately absent. An allowance for a fix nothing here offers
// is a claim about the Compiler that nothing checks; the day a fixture reaches
// one, this spec fails and whoever wrote the fixture writes the reason down,
// which is what happened to `Implement 'X'` below when the corpus grew a
// Namespace that declares a conformance it does not keep.
const ALLOWED: Array<Allowance> = [
	{
		code: "ambiguous-case",
		title: "Prefix with '",
		reason: "Naming the Choice answers WHICH Choice and says nothing about its Type Arguments, which the position still has to decide — the second question, asked once the first is answered. On a Matcher it answers which of two Unions the Case came from, and the Match is then short the other Union's Case, which is a question only the answered one lets the reader ask.",
		followUp: ["undecided-type-arguments", "missing-case"],
	},
	{
		code: "incomplete-record-argument",
		title: "Write the missing member '",
		reason: "The member is written with an empty Record as its value, which is the hole the reader fills in — the Argument is refused for the value now rather than for the missing name.",
		followUp: [
			"argument-type-mismatch",
			"payload-type-mismatch",
			"incomplete-record-argument",
		],
	},
	{
		code: "incomplete-record-argument",
		title: "Write the missing members",
		reason: "As above, for the fix that writes every missing member at once.",
		followUp: [
			"argument-type-mismatch",
			"payload-type-mismatch",
			"incomplete-record-argument",
		],
	},
	{
		code: "unknown-where-generic",
		title: "Declare it as '",
		reason: "Declaring the name answers WHERE the condition's subject comes from; whether the Namespace can witness a condition about it is the next question, and one the reader can only be asked once the name is there.",
		followUp: ["unwitnessable-where-condition"],
	},
	{
		code: "undeclared-conformance",
		title: "Declare the conformance: '",
		reason: "Writing the conformance down is what the derived Methods were used without; whether the Namespace actually holds up its end is then checked for the first time, and a Namespace that does not is a second, truthful report rather than this fix failing.",
		followUp: ["nonconforming-namespace"],
	},
	{
		code: "unknown-member",
		title: "Change to '",
		reason: "The member is spelled the way the Record declares it, and what stands behind the corrected name is a new question: in 'ForeignNames.es' it is reached as a Function though it holds a String, and in 'Patterns.es' the corrected binder then declares a name the block above it has already declared.",
		followUp: ["not-a-function", "duplicate-variable"],
	},
	{
		code: "foreign-syntax",
		title: "Write '#Empty' instead of 'null'",
		reason: "'#Empty' is the Case a reader coming from 'null' means, and it carries no payload to decide its Type Argument with — so a bare '#Empty' in a position that decides nothing is asked WHICH Optional it is, which is the question 'null' was hiding.",
		followUp: ["undecided-type-arguments"],
	},
	{
		code: "missing-case",
		title: "Add missing Cases",
		reason: "Each Case is written with an empty body, which is the hole the reader fills in — a Function whose Match now has an armed Case that returns nothing is short a return, and that is the scaffold reporting rather than the fix failing.",
		followUp: ["missing-return"],
	},
	{
		code: "literal-match-shape",
		title: "Add a 'case _'",
		reason: "As above, for the catch-all arm: its body is the hole, so a Function that returns out of its Match is short a return until the reader writes one.",
		followUp: ["missing-return"],
	},
	{
		code: "empty-list-overlap",
		title: "Guard the Cases with 'where @::hasItems()'",
		reason: "The guard is what makes the Cases tell an empty List from a full one, and the Case that answers for the empty one is written with an empty body — the reader decides what an empty List means here, and nothing else can.",
		followUp: ["missing-return"],
	},
	{
		code: "nonconforming-namespace",
		title: "Implement '",
		reason: "The Methods the Protocol asks for are written with their Signatures and empty bodies, which is the scaffold: what each of them answers is the reader's to write, and a body that answers nothing is short its return until they do.",
		followUp: ["missing-return"],
	},
]

type ReachAllowance = {
	// NOTE: Keyed the way an Allowance is — the code the fix answers and the
	// title it is offered under, by prefix.
	code: common.DiagnosticCode
	title: string
	reason: string
	// NOTE: How far the fix may write — "elsewhere in the file" where the
	// answer lives at a declaration the reader may have put anywhere in it,
	// "another file" for the one kind of fix that reaches a second Module.
	reach: "elsewhere in the file" | "another file"
}

// NOTE: The fixes that legitimately write somewhere OTHER than the lines the
// report stands on, and why each does. Everything else edits what it
// underlines, give or take the line above and the line below — the rule that
// tells a fix from a rewrite of the reader's file, and the one the survey's
// mutants got past: an honest edit carrying a renamed binding, a deleted
// comment or a renamed Case rode along unnoticed because only the count was
// read.
const REACH_ALLOWED: Array<ReachAllowance> = [
	{
		code: "not-exported",
		title: "Export '",
		reason: "The name is missing from the OTHER Module's export block, which is where the fix writes — the report stands on the import that asked for it, and a Module that keeps a name private can only be answered where it keeps it.",
		reach: "another file",
	},
	{
		code: "export-of-variable",
		title: "Declare '",
		reason: "The report stands on the export entry and the answer is the DECLARATION it names: a Variable nothing assigns to becomes a Constant where it is written, which is as far up the file as the reader put it.",
		reach: "elsewhere in the file",
	},
	{
		code: "undocumented-parameter",
		title: "Add a '@param",
		reason: "A Parameter is documented in the comment block ABOVE the Function, and the report stands on the Parameter itself — the two are as far apart as the Signature is long.",
		reach: "elsewhere in the file",
	},
	{
		code: "nonconforming-namespace",
		title: "Implement '",
		reason: "The report stands on the conformance clause in the Namespace's header and the Methods are written into its BODY, which is as far below as the Methods already there are long.",
		reach: "elsewhere in the file",
	},
	{
		code: "misplaced-tests-section",
		title: "Move the 'tests { … }' block to the end",
		reason: "Moving a section is a cut and a paste, and the paste is at the end of the file by definition — that the block does not belong where it stands is the whole report.",
		reach: "elsewhere in the file",
	},
]

let reachEarned = new Set<ReachAllowance>()

function reachAllowanceFor(entry: CodeActionEntry): ReachAllowance | undefined {
	let found = REACH_ALLOWED.find(
		(allowance) =>
			allowance.code === entry.diagnosticCode &&
			entry.title.startsWith(allowance.title),
	)

	if (found !== undefined) {
		reachEarned.add(found)
	}

	return found
}

type RefactorAllowance = {
	// NOTE: Matched by PREFIX on the title, and pinned to the fixtures it is
	// allowed on: a rewrite that starts raising the count somewhere else is a
	// new fact and fails here rather than riding in on an old reason.
	//
	// NOTE: A prefix wide enough to catch a rewrite nobody wrote it for is an
	// allowance that excuses the wrong thing — "Make '" would cover a "Make it
	// a Constant" nobody has written yet — so `for` narrows it to the shape the
	// reason is about: the title reads "Make 'X' Generatable", and nothing else
	// that starts with those five characters is excused.
	title: string
	for?: RegExp
	fixtures: Array<string>
	reason: string
	// NOTE: How many errors it may ADD. One scaffold body is one hole.
	atMost: number
}

// NOTE: The two rewrites that leave a file more broken than they found it, and
// why each is allowed to. A refactoring is held to the weaker rule — it is
// offered on code the Compiler is happy with and it CHANGES what a Program
// says — but "weaker" is not "anything", so both are written down here with the
// files they are written down for.
const REFACTOR_ALLOWED: Array<RefactorAllowance> = [
	{
		title: "Make '",
		for: /^Make '.+' Generatable$/,
		fixtures: [
			"CaseDefaults.es",
			"MemberPaths.es",
			"PathKeyDefaults.es",
			"PathKeySyntax.es",
			"PathKeys.es",
			"RecordMismatch.es",
			"Refinements.es",
		],
		reason: "The generated 'Generatable' conformance writes a Method whose body is the hole — what a Type generates is a judgement nobody but the reader can make — so the scaffold reports until they fill it in. Raise-by-design, and the survey named it as one.",
		atMost: 1,
	},
	{
		title: "Add explicit Type annotation ': ",
		fixtures: ["Refinements.es"],
		reason: "RESIDUAL. A Function literal that writes neither of its Types gets one hint per half, and each is offered as a rewrite of its own: writing the Parameter's Type alone leaves the literal short its '-> Type', which is 'missing-return-type' and an Overload that no longer matches. The Diagnostic's own Help was fixed to name BOTH halves at once; pairing the two hints means knowing which literal each belongs to, which the hint list does not say, so the rewrite is left as it is and written down here.",
		atMost: 2,
	},
]

let refactorsEarned = new Set<RefactorAllowance>()

function refactorAllowanceFor(
	fixture: string,
	entry: CodeActionEntry,
): RefactorAllowance | undefined {
	let found = REFACTOR_ALLOWED.find(
		(allowance) =>
			entry.title.startsWith(allowance.title) &&
			(allowance.for === undefined || allowance.for.test(entry.title)) &&
			allowance.fixtures.includes(fixture),
	)

	if (found !== undefined) {
		refactorsEarned.add(found)
	}

	return found
}

let earned = new Set<Allowance>()

function allowanceFor(entry: CodeActionEntry): Allowance | undefined {
	let found = ALLOWED.find(
		(allowance) =>
			allowance.code === entry.diagnosticCode &&
			entry.title.startsWith(allowance.title),
	)

	if (found !== undefined) {
		earned.add(found)
	}

	return found
}

function offsetOf(text: string, cursor: common.Cursor): number {
	let lines = text.split("\n")
	let offset = 0

	for (let line = 1; line < cursor.line; line++) {
		offset += (lines[line - 1] as string).length + 1
	}

	return offset + cursor.column - 1
}

// NOTE: Spans are measured against the original text and written in position
// order, since an action's own order means nothing; insertions at one point
// keep the order listed, ahead of a replacement that starts there.
function applyEdits(text: string, edits: Array<CodeActionEdit>): string {
	let spans = edits
		.map((edit) => ({
			start: offsetOf(text, edit.range.start),
			end: offsetOf(text, edit.range.end),
			newText: edit.newText,
		}))
		.sort(
			(left, right) =>
				left.start - right.start ||
				Number(left.end > left.start) - Number(right.end > right.start),
		)
	let result = ""
	let cursor = 0

	for (let span of spans) {
		if (span.start < cursor) {
			throw new Error(`overlapping edits at offset ${span.start}`)
		}

		result += text.slice(cursor, span.start) + span.newText
		cursor = span.end
	}

	return result + text.slice(cursor)
}

// NOTE: A Diagnostic as the identity a loop is measured by: the same code, the
// same message, in the same place. A fix that answers a report by moving it to
// a different code has made progress; one that hands back this is a loop.
function identityOf(diagnostic: common.Diagnostic): string {
	let position = diagnostic.position

	return [
		diagnostic.code,
		position === null
			? "-"
			: `${position.start.line}:${position.start.column}`,
		diagnostic.message,
	].join(" ")
}

// NOTE: A Diagnostic as "the same report", which is what a report the fix
// RAISED is told from one the file was already carrying. The code and the
// message, deliberately without the position: an edit that writes a line moves
// every report below it down one, and a report that moved is not a new one,
// while a second `unknown-name` about a name nothing declares is — which is the
// fix the counting rule below used to let through, answering its own report and
// leaving an unrelated one in its place.
function reportKey(diagnostic: common.Diagnostic): string {
	return `${diagnostic.code} ${diagnostic.message}`
}

// NOTE: What the fix left behind that the file did not already say. Shared by
// both paths: a scaffold's holes are read off this list and matched against the
// codes its allowance names, and a fix with no allowance may leave none at all.
function freshReports(
	before: Array<common.Diagnostic>,
	after: Array<common.Diagnostic>,
): Array<common.Diagnostic> {
	let standing = new Set(before.map(reportKey))

	return after.filter((diagnostic) => !standing.has(reportKey(diagnostic)))
}

// NOTE: The Diagnostic an action answers, as the identity a chain is followed
// by — the code and where it was raised. Null where the action answers none,
// which no quickfix does.
function keyOf(entry: CodeActionEntry): string | null {
	let position = entry.diagnosticPosition

	return position === null
		? null
		: `${entry.diagnosticCode} ${position.start.line}:${position.start.column}`
}

function wholeOf(source: string): common.Position {
	let lines = source.split("\n")

	return {
		start: { line: 1, column: 1 },
		end: {
			line: lines.length,
			column: (lines.at(-1) as string).length + 1,
		},
	}
}

function errorsIn(diagnostics: Array<common.Diagnostic>): number {
	return diagnostics.filter((diagnostic) => diagnostic.severity === "error")
		.length
}

function parsesIn(diagnostics: Array<common.Diagnostic>): boolean {
	return !diagnostics.some((diagnostic) => SYNTAX_CODES.has(diagnostic.code))
}

// NOTE: One line of slack on each side, because an edit that writes a line ABOVE
// the report — a Type a declaration was short of, a conformance, the closing
// quote of the String that ran on — stands on the neighbouring line and is as
// local as an edit gets.
const NEARBY_LINES = 1

// NOTE: Where a fix may write. The reader asked about ONE report, and an edit
// somewhere else in their file is a change they did not ask for and will not
// read — the Help audit's mutants walked in exactly here, riding along with an
// honest edit: a binding renamed throughout, every documentation comment
// deleted, a Choice Case renamed. Each of them left the counts alone.
//
// Answered with the lines the report stands on rather than with its columns: a
// fix commonly rewrites the whole line it underlines part of, and no mutant this
// is written against is a matter of columns. INSIDE those lines rather than
// overlapping them, because an edit that rewrites the file from its first line
// to its last overlaps everything — which is the shape three of the mutants
// take.
function reachesTooFar(
	entry: CodeActionEntry,
	edit: CodeActionEdit,
): "another file" | "elsewhere in the file" | null {
	let position = entry.diagnosticPosition

	if (edit.filePath !== undefined || edit.createFile === true) {
		return "another file"
	}

	if (position === null) {
		return null
	}

	let inside =
		edit.range.start.line >= position.start.line - NEARBY_LINES &&
		edit.range.end.line <= position.end.line + NEARBY_LINES

	return inside ? null : "elsewhere in the file"
}

// NOTE: The guard's own questions, as a function rather than as a wall of
// assertions, so that the mutants in "The guard itself" can be asked them too.
// It answers the questions the fix failed, empty where it passed all of them.
function answerFailures(
	source: string,
	entry: CodeActionEntry,
	before: Array<common.Diagnostic>,
): Array<string> {
	let failures: Array<string> = []
	let allowance = allowanceFor(entry)
	let after = analyse(applyEdits(source, entry.edits), undefined, {
		tests: true,
	})

	// (i) It raised no report the file was not already carrying — and, where
	// it is no scaffold, neither count rose either.
	//
	// NOTE: Counts alone said nothing about WHICH reports were counted: a fix
	// that answered the report it was offered for and left an unrelated one in
	// its place went four for four and passed. What a fix may leave is what its
	// allowance names, and nothing is what everything else may leave.
	let permitted = allowance?.followUp ?? []

	for (let diagnostic of freshReports(before, after)) {
		if (!permitted.includes(diagnostic.code)) {
			failures.push(`(i) raised '${reportKey(diagnostic)}'`)
		}
	}

	if (allowance === undefined) {
		if (errorsIn(after) > errorsIn(before)) {
			failures.push(
				`(i) the error count rose from ${errorsIn(before)} to ${errorsIn(after)}`,
			)
		}

		if (after.length > before.length) {
			failures.push(
				`(i) the report count rose from ${before.length} to ${after.length}`,
			)
		}
	}

	// (ii) The report it answered is gone, or has become a different one in
	// that place. Found by code AND POSITION, because a showcase file carries
	// several reports of one code and a fix answers exactly one of them.
	if (entry.diagnosticCode !== null && entry.diagnosticPosition !== null) {
		let answered = before.find(
			(diagnostic) =>
				diagnostic.code === entry.diagnosticCode &&
				diagnostic.position !== null &&
				diagnostic.position.start.line ===
					entry.diagnosticPosition!.start.line &&
				diagnostic.position.start.column ===
					entry.diagnosticPosition!.start.column,
		)

		if (
			answered !== undefined &&
			after.map(identityOf).includes(identityOf(answered))
		) {
			failures.push(`(ii) left '${identityOf(answered)}' where it was`)
		}
	}

	// (iii) It still parses, unless it did not before.
	if (parsesIn(before) && !parsesIn(after)) {
		failures.push("(iii) the result no longer parses")
	}

	// (v) And it wrote where the report stands.
	failures.push(...reachFailures(entry))

	return failures
}

// NOTE: Split out because the Module group asks this one question on its own:
// there the answer is read off the whole graph, and an edit landing in a second
// file is the fix working rather than the fix reaching.
function reachFailures(entry: CodeActionEntry): Array<string> {
	let failures: Array<string> = []

	for (let edit of entry.edits) {
		let reach = reachesTooFar(entry, edit)

		if (reach === null) {
			continue
		}

		let allowance = reachAllowanceFor(entry)

		if (
			allowance === undefined ||
			(reach === "another file" && allowance.reach !== "another file")
		) {
			failures.push(
				`(v) wrote ${reach}: ${
					edit.filePath === undefined
						? `lines ${edit.range.start.line}-${edit.range.end.line}`
						: path.basename(edit.filePath)
				}`,
			)
		}
	}

	return failures
}

const CHAIN_ROUNDS = 8

function sameFix(left: CodeActionEntry, right: CodeActionEntry): boolean {
	return left.title === right.title && keyOf(left) === keyOf(right)
}

function answers(
	entry: CodeActionEntry,
	diagnostic: common.Diagnostic,
): boolean {
	return (
		entry.diagnosticCode === diagnostic.code &&
		entry.diagnosticPosition !== null &&
		diagnostic.position !== null &&
		entry.diagnosticPosition.start.line ===
			diagnostic.position.start.line &&
		entry.diagnosticPosition.start.column ===
			diagnostic.position.start.column
	)
}

// NOTE: One round of a chain. A scaffold's round is counted without the codes
// its allowance names, since those reports are the holes it leaves by design.
function roundFailures(
	fix: CodeActionEntry,
	before: Array<common.Diagnostic>,
	after: Array<common.Diagnostic>,
): Array<string> {
	let failures: Array<string> = []
	let holes = allowanceFor(fix)?.followUp ?? []
	let counted = (diagnostics: Array<common.Diagnostic>) =>
		diagnostics.filter((diagnostic) => !holes.includes(diagnostic.code))
	let aside = holes.length === 0 ? "" : ` not counting ${holes.join(", ")}`

	if (errorsIn(counted(after)) > errorsIn(counted(before))) {
		failures.push(
			`the error count rose from ${errorsIn(counted(before))} to ${errorsIn(counted(after))}${aside}`,
		)
	}

	if (counted(after).length > counted(before).length) {
		failures.push(
			`the report count rose from ${counted(before).length} to ${counted(after).length}${aside}`,
		)
	}

	if (parsesIn(before) && !parsesIn(after)) {
		failures.push("the result no longer parses")
	}

	return failures
}

// NOTE: The fourth question follows a fix the way a reader presses through
// lightbulbs: apply it, read the Diagnostics again, then apply the quick fix
// the result offers for a report that round raised, or else the first it offers.
function chainFailures(source: string, entry: CodeActionEntry): Array<string> {
	let failures: Array<string> = []
	let text = source
	let reports = analyse(text, undefined, { tests: true })
	let applied: Array<CodeActionEntry> = []
	let applying: CodeActionEntry | undefined = entry

	for (
		let round = 0;
		round < CHAIN_ROUNDS && applying !== undefined;
		round++
	) {
		let fix: CodeActionEntry = applying

		applied.push(fix)
		text = applyEdits(text, fix.edits)

		let after = analyse(text, undefined, { tests: true })
		let along = applied.map((step) => step.title).join(" → ")
		let offered = actionsOn(text).filter(
			(candidate) => candidate.kind === "quickfix",
		)
		let again = offered.find((candidate) =>
			applied.some((step) => sameFix(step, candidate)),
		)

		for (let failure of roundFailures(fix, reports, after)) {
			failures.push(`(iv) ${failure} in round ${round}, along ${along}`)
		}

		if (again !== undefined) {
			failures.push(
				`(iv) ${again.title} offered again in round ${round}, along ${along}`,
			)
		}

		if (failures.length > 0) {
			break
		}

		let raised = freshReports(reports, after)

		applying =
			offered.find((candidate) =>
				raised.some((diagnostic) => answers(candidate, diagnostic)),
			) ?? offered[0]
		reports = after
	}

	return failures
}

// NOTE: A path with no import or export block beside it is analysed on its own,
// which is what every single-file fixture here is. The refactorings need one.
const DOCUMENT = "file:///repo/Showcase.es"

const SHOWCASE_DIRECTORY = fixturePath("diagnostics")

let showcases = readdirSync(SHOWCASE_DIRECTORY)
	.filter((name) => name.endsWith(".es"))
	.sort()
	.map((name) => ({
		name,
		source: readFileSync(path.join(SHOWCASE_DIRECTORY, name), "utf8"),
	}))

function actionsOn(source: string): Array<CodeActionEntry> {
	return findCodeActions(source, wholeOf(source), DOCUMENT)
}

describe("Every Quick Fix on every broken file", () => {
	it("has a corpus to fix", () => {
		expect(showcases.length).toBeGreaterThan(20)
	})

	// NOTE: Nothing may escape into the other group by accident — a single-file
	// fixture that started offering a fix reaching a second file would be
	// skipped in silence, and this is what stops that.
	it("offers only single-file edits on a single-file fixture", () => {
		for (let showcase of showcases) {
			let foreign = actionsOn(showcase.source).filter((entry) =>
				entry.edits.some((edit) => edit.filePath !== undefined),
			)

			expect([
				showcase.name,
				foreign.map((entry) => entry.title),
			]).toEqual([showcase.name, []])
		}
	})

	for (let showcase of showcases) {
		describe(showcase.name, () => {
			let before = analyse(showcase.source, undefined, { tests: true })
			let entries = actionsOn(showcase.source).filter(
				(entry) => entry.kind === "quickfix",
			)

			it("answers every fix it offers without making things worse", () => {
				for (let entry of entries) {
					let where = `${showcase.name} · ${entry.title}`

					expect([
						where,
						answerFailures(showcase.source, entry, before),
					]).toEqual([where, []])
				}
			})

			it("follows every fix's chain without a loop or a rising count", () => {
				for (let entry of entries) {
					let where = `${showcase.name} · ${entry.title}`

					expect([
						where,
						chainFailures(showcase.source, entry),
					]).toEqual([where, []])
				}
			})
		})
	}
})

// NOTE: The weaker rule for a REFACTORING, which is offered on code the
// Compiler is happy with and is a rewrite rather than an answer: it may say
// something new, and what it may never do is turn a file with N errors into one
// with more.
describe("Every refactoring on every broken file", () => {
	for (let showcase of showcases) {
		it(`leaves ${showcase.name} no more broken than it was`, () => {
			let before = analyse(showcase.source, undefined, { tests: true })
			let refactors = actionsOn(showcase.source).filter((entry) =>
				entry.kind.startsWith("refactor"),
			)

			for (let entry of refactors) {
				let where = `${showcase.name} · ${entry.title}`
				let after = analyse(
					applyEdits(showcase.source, entry.edits),
					undefined,
					{ tests: true },
				)
				let allowance = refactorAllowanceFor(showcase.name, entry)
				let room = allowance?.atMost ?? 0

				expect([
					where,
					errorsIn(after) <= errorsIn(before) + room,
				]).toEqual([where, true])
			}
		})
	}
})

// NOTE: The Module showcase, which is the only place a fix reaches a SECOND
// file — a name written into the export block of the Module that kept it
// private. It runs against a real directory for the reason `workspace.spec.ts`
// does: which path a specifier resolves to is most of what there is to get
// wrong about a Module, and an in-memory host would answer that question by
// assumption.
describe("Every Quick Fix on the Module showcase", () => {
	let moduleDirectory = fixturePath("diagnostics", "modules")
	let moduleFiles = Object.fromEntries(
		readdirSync(moduleDirectory)
			.filter((name) => name.endsWith(".es"))
			.sort()
			.map((name) => [
				name,
				readFileSync(path.join(moduleDirectory, name), "utf8"),
			]),
	)

	function freshFolder(files: Record<string, string>): string {
		let root = canonicalPath(
			mkdtempSync(path.join(tmpdir(), "essence-qf-")),
		)

		madeFolders.push(root)

		for (let [name, contents] of Object.entries(files)) {
			let filePath = path.join(root, name)

			mkdirSync(path.dirname(filePath), { recursive: true })
			writeFileSync(filePath, contents)
		}

		return root
	}

	// NOTE: The whole workspace's Diagnostics, because a Module fix is judged
	// by what the GRAPH says afterwards — an export written into one file
	// answers a report raised in another, and reading back only the file the
	// fix was offered on would call that a success either way.
	function graphCodes(root: string): Array<string> {
		let workspace = createWorkspace({ tests: true })

		workspace.setFolders([root])

		return readdirSync(root)
			.filter((name) => name.endsWith(".es"))
			.sort()
			.flatMap((name) => {
				let filePath = canonicalPath(path.join(root, name))

				return analyseDocument(
					readFileSync(filePath, "utf8"),
					filePath,
					{ host: workspace.host, tests: true },
				).diagnostics.map((diagnostic) => `${name} ${diagnostic.code}`)
			})
	}

	// NOTE: One fix, applied to the files as they were written, with the edits
	// grouped per file — a Workspace Edit reaching two files is one action, and
	// applying half of it is not what a reader does.
	function withFix(entry: CodeActionEntry, onto: string): Array<string> {
		let files = { ...moduleFiles }

		for (let name of Object.keys(files)) {
			let edits = entry.edits.filter((edit) =>
				edit.filePath === undefined
					? name === onto
					: path.basename(edit.filePath) === name,
			)

			if (edits.length > 0) {
				files[name] = applyEdits(files[name] as string, edits)
			}
		}

		return graphCodes(freshFolder(files))
	}

	// NOTE: And it has fixes to apply — a group that quietly stopped finding any
	// would pass every assertion below it by never reaching one.
	it("has a showcase to fix", () => {
		let root = freshFolder(moduleFiles)
		let workspace = createWorkspace({ tests: true })

		workspace.setFolders([root])

		let offered = Object.keys(moduleFiles).flatMap((name) => {
			let filePath = canonicalPath(path.join(root, name))
			let source = moduleFiles[name] as string

			return findCodeActions(
				source,
				wholeOf(source),
				filePath,
				workspace,
			).filter((entry) => entry.kind === "quickfix")
		})

		expect(Object.keys(moduleFiles).length).toBeGreaterThan(0)
		expect(offered.length).toBeGreaterThan(0)
	})

	for (let name of Object.keys(moduleFiles)) {
		it(`answers every fix it offers on ${name}`, () => {
			let root = freshFolder(moduleFiles)
			let before = graphCodes(root)
			let workspace = createWorkspace({ tests: true })

			workspace.setFolders([root])

			let filePath = canonicalPath(path.join(root, name))
			let source = moduleFiles[name] as string
			let entries = findCodeActions(
				source,
				wholeOf(source),
				filePath,
				workspace,
			).filter((entry) => entry.kind === "quickfix")

			for (let entry of entries) {
				let where = `${name} · ${entry.title}`
				let after = withFix(entry, name)

				// NOTE: The same rule as everywhere else, read over the whole
				// graph: a fix may answer a report and may not add one.
				expect([where, after.length <= before.length]).toEqual([
					where,
					true,
				])
				expect([
					where,
					after.filter((code) => code.endsWith("syntax-error")),
				]).toEqual([where, []])

				// NOTE: And it wrote where the report stands, or where its
				// allowance says it may. This is the one group where a fix
				// reaches a SECOND file, which is exactly why the rule is
				// asked here as well: "it is a Module fix" is not a reason to
				// stop reading where the edits land.
				expect([where, reachFailures(entry)]).toEqual([where, []])
			}
		})
	}
})

// NOTE: The allowlist's own guard. An entry that stops being needed is a claim
// about the Compiler that nobody is checking any more — so it fails here, and
// whoever fixed the fix deletes the line that excused it.
describe("The allowlist", () => {
	it("has every allowance still earned", () => {
		expect(
			ALLOWED.filter((allowance) => !earned.has(allowance)).map(
				(allowance) => `${allowance.code} · ${allowance.title}`,
			),
		).toEqual([])
	})

	it("has every refactoring allowance still earned", () => {
		expect(
			REFACTOR_ALLOWED.filter(
				(allowance) => !refactorsEarned.has(allowance),
			).map((allowance) => allowance.title),
		).toEqual([])
	})

	it("has every reach allowance still earned", () => {
		expect(
			REACH_ALLOWED.filter(
				(allowance) => !reachEarned.has(allowance),
			).map((allowance) => `${allowance.code} · ${allowance.title}`),
		).toEqual([])
	})
})

// NOTE: The guard's own guard. Everything above asks questions of the fixes the
// Server really offers, and every one of them passes — which says as much about
// the questions as about the fixes, and is exactly what an audit is entitled to
// disbelieve. So the questions are asked of fixes that are deliberately, and
// differently, WRONG: each mutant below is an honest fix carrying something no
// reader asked for, and each has to be caught.
//
// Three of them ride along with an honest edit and change something else in the
// file, which only question (v) catches, and one is caught only by following the
// chain past its first round.
describe("The guard itself", () => {
	// NOTE: Written here rather than read out of the corpus: a mutant has to
	// know what it is corrupting — a comment, a binding, a Case — and a fixture
	// is free to stop carrying any of the three. One misspelled name, in the
	// middle of the file so that an edit at either end of it is plainly
	// somewhere else.
	const SUBJECT = [
		"implementation {",
		"\t§ A note the reader wrote, which no fix has any business deleting.",
		"\tchoice Light {",
		"\t\tRed,",
		"\t\tGreen,",
		"\t}",
		"",
		"\tconstant lit: Light = #Red",
		'\tconstant greeting = "hello"',
		"",
		"\tTerminal.print(greetingg)",
		"",
		"\tTerminal.inspect(lit)",
		"}",
		"",
	].join("\n")

	let lines = SUBJECT.split("\n")
	let whole = wholeOf(SUBJECT)
	let end = whole.end
	let before = analyse(SUBJECT, undefined, { tests: true })
	let honest = actionsOn(SUBJECT).find(
		(entry) => entry.kind === "quickfix",
	) as CodeActionEntry

	function verdict(entry: CodeActionEntry): Array<string> {
		return [
			...answerFailures(SUBJECT, entry, before),
			...chainFailures(SUBJECT, entry),
		]
	}

	function mutant(edits: Array<CodeActionEdit>): CodeActionEntry {
		return { ...honest, edits }
	}

	function rewritten(replace: (text: string) => string): CodeActionEntry {
		return mutant([
			{
				range: whole,
				newText: replace(applyEdits(SUBJECT, honest.edits)),
			},
		])
	}

	it("has an honest fix to mutate", () => {
		expect(honest).toBeDefined()
		expect(honest.title).toBe("Change to 'greeting'")
		expect(allowanceFor(honest)).toBeUndefined()
		expect(reachAllowanceFor(honest)).toBeUndefined()
	})

	// NOTE: The control. A guard that failed everything would catch every mutant
	// and be worth nothing.
	it("passes the honest fix", () => {
		expect(verdict(honest)).toEqual([])
	})

	it("catches a fix that declares nothing for a name it writes", () => {
		expect(
			verdict(
				mutant([
					...honest.edits,
					{
						range: {
							start: { line: 14, column: 1 },
							end: { line: 14, column: 1 },
						},
						newText: "\tconstant boom = undeclaredNameHere\n",
					},
				]),
			),
		).toEqual([
			"(i) raised 'unknown-name 'undeclaredNameHere' is not declared'",
			"(v) wrote elsewhere in the file: lines 14-14",
		])
	})

	it("catches a fix that changes nothing at all", () => {
		expect(verdict(mutant([{ range: whole, newText: SUBJECT }]))).toEqual([
			"(ii) left 'unknown-name 11:17 'greetingg' is not declared' where it was",
			"(v) wrote elsewhere in the file: lines 1-15",
			"(iv) Change to 'greeting' offered again in round 0, along Change to 'greeting'",
		])
	})

	it("catches a fix that leaves the file unparseable", () => {
		expect(
			verdict(
				mutant([
					...honest.edits,
					{
						range: { start: end, end },
						newText: "\nimplementation {\n",
					},
				]),
			),
		).toEqual([
			"(i) raised 'unexpected-token Unexpected 'implementation' after the end of the Program'",
			"(iii) the result no longer parses",
			"(v) wrote elsewhere in the file: lines 15-15",
			"(iv) the result no longer parses in round 0, along Change to 'greeting'",
		])
	})

	it("catches a fix that deletes the file", () => {
		expect(verdict(mutant([{ range: whole, newText: "" }]))).toEqual([
			"(i) raised 'syntax-error Expected 'implementation' but found end of input.'",
			"(iii) the result no longer parses",
			"(v) wrote elsewhere in the file: lines 1-15",
			"(iv) the result no longer parses in round 0, along Change to 'greeting'",
		])
	})

	// NOTE: The three that got past the counting guard, each of which leaves a
	// file the Compiler is just as happy with and the reader no longer
	// recognises. They are caught by where they WRITE, so the verdict is read
	// for that question by name rather than for any failure at all.
	it("catches a fix that deletes the reader's comments", () => {
		let deletions = lines.flatMap((line, index) =>
			line.trimStart().startsWith("§")
				? [
						{
							range: {
								start: { line: index + 1, column: 1 },
								end: {
									line: index + 1,
									column: line.length + 1,
								},
							},
							newText: "",
						},
					]
				: [],
		)

		expect(deletions.length).toBeGreaterThan(0)
		expect(verdict(mutant([...deletions, ...honest.edits]))).toEqual([
			"(v) wrote elsewhere in the file: lines 2-2",
		])
	})

	it("catches a fix that renames an unrelated binding", () => {
		expect(
			verdict(rewritten((text) => text.replaceAll("lit", "chosen"))),
		).toEqual(["(v) wrote elsewhere in the file: lines 1-15"])
	})

	it("catches a fix that renames a Case", () => {
		expect(
			verdict(rewritten((text) => text.replaceAll("Red", "Crimson"))),
		).toEqual(["(v) wrote elsewhere in the file: lines 1-15"])
	})

	// NOTE: Caught by no question but the chain: the fix moves the misspelled
	// name into a declaration whose uses it masks, and the next fix unmasks them.
	it("catches a count that rises further down the chain", () => {
		let trap = mutant([
			{
				range: {
					start: { line: 11, column: 1 },
					end: { line: 11, column: (lines[10] as string).length + 1 },
				},
				newText:
					"\tconstant copy = greetingg\n\tcopy::a()\n\tcopy::b()",
			},
		])

		expect(verdict(trap)).toEqual([
			"(iv) the error count rose from 1 to 2 in round 1, along Change to 'greeting' → Change to 'greeting'",
			"(iv) the report count rose from 1 to 2 in round 1, along Change to 'greeting' → Change to 'greeting'",
		])
	})
})

describe("The edit applier", () => {
	let text = "one two three"
	let first: CodeActionEdit = {
		range: { start: { line: 1, column: 1 }, end: { line: 1, column: 4 } },
		newText: "1",
	}
	let last: CodeActionEdit = {
		range: {
			start: { line: 1, column: 9 },
			end: { line: 1, column: 14 },
		},
		newText: "3",
	}

	it("applies an action's edits the same in whatever order it lists them", () => {
		expect(applyEdits(text, [first, last])).toBe("1 two 3")
		expect(applyEdits(text, [last, first])).toBe("1 two 3")
	})

	it("writes insertions at one point in the order the action lists them", () => {
		let at = last.range.start

		expect(
			applyEdits(text, [
				last,
				{ range: { start: at, end: at }, newText: "a " },
				{ range: { start: at, end: at }, newText: "b " },
			]),
		).toBe("one two a b 3")
	})

	it("refuses edits that overlap", () => {
		let across: CodeActionEdit = {
			range: {
				start: { line: 1, column: 3 },
				end: { line: 1, column: 6 },
			},
			newText: "",
		}

		expect(() => applyEdits(text, [first, across])).toThrow(
			"overlapping edits",
		)
	})
})
