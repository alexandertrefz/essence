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
import { applyEdits } from "./textEdits"

let madeFolders: Array<string> = []

afterAll(() => {
	for (let folder of madeFolders) {
		rmSync(folder, { recursive: true, force: true })
	}

	madeFolders = []
})

// The guard over every Quick Fix, asked of every deliberately broken file.
// `answerFailures` asks questions (i), (ii), (iii) and (v) of each fix applied
// alone, and `chainFailures` asks (iv) of the chain it starts. The mutants in
// "The guard itself" check that each question can fail. The corpus is a sorted
// listing and every edit is a function of its text, so the guard is
// deterministic.

const SYNTAX_CODES: ReadonlySet<string> = new Set([
	"syntax-error",
	"unexpected-token",
	"unclosed-string",
	"unclosed-block",
])

type Allowance = {
	// Matched on the fix's title by prefix, since a title holds the reader's
	// names: "Implement 'Printable'" and "Implement 'Shown'" are one fix.
	code: common.DiagnosticCode
	title: string
	reason: string
	// The codes the fix may leave behind. A scaffold leaves a hole by design,
	// and naming the hole's code keeps anything else from rising.
	followUp: Array<common.DiagnosticCode>
}

// The scaffolding fixes, and nothing else. Each writes a hole the reader fills
// in, and names the code that hole reports. An unused entry fails "has every
// allowance still earned".
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
	// Keyed as an Allowance is, by the code the fix answers and its title's
	// prefix.
	code: common.DiagnosticCode
	title: string
	reason: string
	// How far the fix may write. "elsewhere in the file" covers an answer at a
	// declaration anywhere in it, and "another file" a second Module.
	reach: "elsewhere in the file" | "another file"
}

// The fixes that write away from the lines their report stands on, and why.
// Every other fix edits what it underlines, give or take a neighbouring line.
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
	// Matched by prefix on the title and pinned to its fixtures, so a rewrite
	// raising the count elsewhere fails. `for` narrows a wide prefix to the
	// titles its reason is about.
	title: string
	for?: RegExp
	fixtures: Array<string>
	reason: string
	// How many errors it may add. One scaffold body is one hole.
	atMost: number
}

// The rewrites allowed to leave a file more broken than they found it, and
// why. A refactoring changes what a Program says, so it is held to a weaker
// rule, but each exception is written down with its files.
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

// A Diagnostic as the identity a loop is measured by: the same code, the
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

// A Diagnostic as "the same report", which tells a raised report from one the
// file already carried. It leaves out the position, since an edit that writes a
// line moves every later report.
function reportKey(diagnostic: common.Diagnostic): string {
	return `${diagnostic.code} ${diagnostic.message}`
}

// What the fix left behind that the file did not already say. A scaffold's
// holes must match its allowance's codes, and a fix with no allowance may leave
// none.
function freshReports(
	before: Array<common.Diagnostic>,
	after: Array<common.Diagnostic>,
): Array<common.Diagnostic> {
	let standing = new Set(before.map(reportKey))

	return after.filter((diagnostic) => !standing.has(reportKey(diagnostic)))
}

// The Diagnostic an action answers, by code and place, which a chain follows.
// Null where the action answers none, which no quickfix does.
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

// One line of slack on each side. An edit that writes the line before the
// report, such as a missing Type or a closing quote, is as local as an edit gets.
const NEARBY_LINES = 1

// Where a fix may write. An edit elsewhere in the file is a change the reader
// did not ask for, even when the counts stay put. An edit must lie inside the
// report's lines, since a fix often rewrites a whole line it underlines part of.
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

// The guard's questions as a function, so the mutants in "The guard itself"
// can be asked them too. It answers the questions the fix failed.
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

	// (i) It raised no report the file was not already carrying, apart from the
	// codes its allowance names. Without an allowance neither count rose either.
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

	// (ii) The report it answered is gone, or became a different one in that
	// place. Found by code and position, since a file may carry several reports
	// of one code.
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

	// (iii) It still parses, unless it did not before. A buffer the Parser
	// cannot read hides the rest of the file's reports.
	if (parsesIn(before) && !parsesIn(after)) {
		failures.push("(iii) the result no longer parses")
	}

	// (v) And it wrote where the report stands.
	failures.push(...reachFailures(entry))

	return failures
}

// Split out because the Module group asks this question on its own. There an
// edit in a second file is allowed where a reach allowance says so.
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

// One round of a chain. A scaffold's round is counted without the codes
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

// (iv) follows a fix for up to `CHAIN_ROUNDS` rounds, as a reader presses
// through lightbulbs. Each round applies the fix offered for a report the last
// round raised, else the first fix offered.
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

// A path with no import or export block beside it is analysed on its own,
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

	// A single-file fixture that started offering a fix reaching a second file
	// would otherwise be skipped in silence.
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

// The weaker rule for a refactoring, which rewrites rather than answers. It
// may say something new, but never turn a file with N errors into one with more.
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

// The Module showcase, where a fix writes a name into the export block of the
// Module that kept it private. It runs against a real directory, since which
// path a specifier resolves to is a fact about a filesystem.
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

	// The whole workspace's Diagnostics, since an export written into one file
	// answers a report raised in another.
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

	// One fix applied to the files as written, with the edits grouped per file.
	// A Workspace Edit reaching two files is one action.
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

	// A group that stopped finding fixes would pass every assertion by never
	// reaching one.
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

				// The same rule as everywhere else, read over the whole
				// graph: a fix may answer a report and may not add one.
				expect([where, after.length <= before.length]).toEqual([
					where,
					true,
				])
				expect([
					where,
					after.filter((code) => code.endsWith("syntax-error")),
				]).toEqual([where, []])

				// It wrote where the report stands, or where its allowance says it
				// may. A fix that reaches a second file is still held to that.
				expect([where, reachFailures(entry)]).toEqual([where, []])
			}
		})
	}
})

// The allowlist's own guard. An entry that stops being needed fails here, and
// is deleted.
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

// The guard's own guard: each mutant is a deliberately wrong fix, and each must
// be caught. Several ride along with an honest edit, which only question (v)
// catches, and one only the chain catches.
describe("The guard itself", () => {
	// Written here rather than read from the corpus, since a mutant must know
	// the comment, binding and Case it corrupts. The misspelled name sits mid-file,
	// so an edit at either end is plainly elsewhere.
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

	// The control. A guard that failed everything would catch every mutant
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

	// Each leaves a file the Compiler is as happy with and the reader no longer
	// recognises. They are caught by where they write, so the verdict is read
	// for question (v) by name.
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

	// Caught only by the chain: the fix moves the misspelled name into a
	// declaration whose uses it masks, and the next fix unmasks them.
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
