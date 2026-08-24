import { Source } from "@essence-lang/ariadne"
import {
	displayPath,
	renderDiagnostic,
} from "@essence-lang/compiler/diagnostics/render"
import {
	benchmarkHelps,
	benchmarkNotes,
	caseNameOf,
	type CoverageRatio,
	type CoverageSummary,
	type FileCoverage,
	type FocusedTest,
	focusedTestsDiagnostic,
	formatNanoseconds,
	hasCoverage,
	isReported,
	percentageOf,
	type PropertyRecord,
	propertyHelps,
	propertyNotes,
	rowLabel,
	type TestRecord,
	type TestRun,
	testFailureDiagnostic,
} from "@essence-lang/compiler/testing"
import type { common } from "@essence-lang/interfaces"

import type { ReportContext } from "./report"
import { formatDuration, pluralise } from "./report"

// NOTE: Everything a person READS about a test run is produced here, as
// strings, so that the shape of the report can be asserted on without a
// terminal — the same rule `report.ts` follows for a compilation. What a run IS
// — the fold of the event stream, and the Diagnostics a failure produces — is
// the Compiler's, because the Language Server publishes the same ones.

// NOTE: Re-exported so that everything about a test RUN is still reached
// through one name from inside the command line, wherever it is defined.
export {
	type BenchmarkRecord,
	collectBenchmarks,
	collectCorpusChanges,
	collectCoverage,
	collectSnapshots,
	collectTestRun,
	type CoverageSummary,
	emptyCoverage,
	emptyRun,
	type FocusedTest,
	focusedTestsDiagnostic,
	type PropertyRecord,
	readBenchmarks,
	readCorpus,
	readSnapshots,
	type SnapshotRecord,
	type TestCounts,
	type TestRecord,
	type TestRun,
	type TestState,
	testFailureDiagnostic,
	toCoverageJson,
	toLcov,
	writeBenchmarks,
	writeCorpus,
	writeSnapshots,
} from "@essence-lang/compiler/testing"

const INDENT = "  "

// #region The tree

function moduleLabel(module: string | null): string {
	return module === null ? "(no module)" : displayPath(module)
}

function symbolFor(test: TestRecord, context: ReportContext): string {
	let { palette, theme } = context

	switch (test.state) {
		case "passed":
			return palette.success(theme.symbols.pass)
		case "failed":
			return palette.error(theme.symbols.fail)
		default:
			return palette.muted(theme.symbols.skip)
	}
}

function deselectionWord(reason: string | null): string {
	switch (reason) {
		case "not-focused":
			return "not focused"
		case "tag":
			return "left out by tag"
		case "bench":
			return "only with --bench"
		default:
			return "filtered out"
	}
}

function testLine(test: TestRecord, context: ReportContext): string {
	let { palette } = context
	let symbol = symbolFor(test, context)
	// NOTE: A row whose name says nothing about which row it is says so as the
	// row it is — the template it shares with its siblings is the heading right
	// above it, and reading it again N times names nothing.
	let written = rowLabel(test) ?? test.name
	let name =
		test.state === "passed" || test.state === "failed"
			? written
			: palette.muted(written)
	let detail = ""

	if (test.state === "skipped") {
		detail = palette.muted(`  skipped: ${test.reason ?? "no reason given"}`)
	} else if (test.state === "not-focused" || test.state === "deselected") {
		detail = palette.muted(`  ${deselectionWord(test.reason)}`)
	} else if (context.verbose) {
		detail = palette.faint(`  ${formatDuration(test.duration)}`)
	}

	// NOTE: A property test says how many cases it ran, and says it whether it
	// held or not — "a hundred cases held" is as much an answer as a
	// counterexample is, and it is the only thing that tells a property test
	// apart from an ordinary one in the tree.
	let cases =
		test.property === null ||
		(test.state !== "passed" && test.state !== "failed")
			? ""
			: palette.faint(`  (${casesOf(test.property)})`)

	return `${symbol} ${name}${cases}${measurement(test, context)}${detail}`
}

// NOTE: What a benchmark cost, beside its own line — the number IS the answer,
// so it is shown whether the measurement held to its baseline or not, and it is
// the only thing that tells a benchmark apart from a test in the tree.
//
// NOTE: An improvement says what to do about it. A run does not move a baseline
// on its own — a fast machine would otherwise ratchet the number down for
// everybody — so the news comes with the command that records it.
function measurement(test: TestRecord, context: ReportContext): string {
	let benchmark = test.benchmark

	if (
		benchmark === null ||
		(test.state !== "passed" && test.state !== "failed")
	) {
		return ""
	}

	let { palette, theme } = context
	let time = palette.faint(
		`  ${theme.symbols.bullet} ${formatNanoseconds(benchmark.nanoseconds)}`,
	)

	if (benchmark.status !== "improved" || benchmark.ratio === null) {
		return time
	}

	return `${time}${palette.muted(
		`  ${theme.symbols.bullet} ${(1 / benchmark.ratio).toFixed(
			1,
		)}× faster — record it with --bench --update`,
	)}`
}

// NOTE: The cases a property drew, and the stored counterexamples it re-ran
// before drawing any. They are counted apart because they are different things:
// a replay spends no randomness and asks a question the search has answered
// once already, so folding the two together would make the number a `--seed`
// replay has to match a number that changes as the corpus grows.
function casesOf(property: PropertyRecord): string {
	let drawn = pluralise(property.cases, "case")

	return property.replayed === 0
		? drawn
		: `${drawn} · ${property.replayed} replayed`
}

// NOTE: What the tree shows without being asked. A deselected test is counted
// in the summary rather than listed: a focused run silences everything else by
// design, and printing forty lines saying so buries the two that ran.
function isListed(test: TestRecord, context: ReportContext): boolean {
	if (test.state === "not-focused" || test.state === "deselected") {
		return context.verbose
	}

	return true
}

function commonPrefix(left: Array<string>, right: Array<string>): number {
	let index = 0

	while (
		index < left.length &&
		index < right.length &&
		left[index] === right[index]
	) {
		index += 1
	}

	return index
}

// NOTE: Suites are printed as they are entered rather than collected into a
// tree first — the tests of one Module arrive in source order, so a suite's
// heading is due exactly where the path stops matching the previous test's.
export function renderTestTree(
	run: TestRun,
	context: ReportContext,
): Array<string> {
	let { palette } = context
	let lines: Array<string> = []
	let modules = new Map<string, Array<TestRecord>>()

	for (let test of run.tests) {
		if (!isListed(test, context)) {
			continue
		}

		let key = moduleLabel(test.module)
		let existing = modules.get(key)

		if (existing === undefined) {
			modules.set(key, [test])
		} else {
			existing.push(test)
		}
	}

	for (let [module, tests] of modules) {
		lines.push(` ${palette.path(module)}`)

		let path: Array<string> = []

		for (let test of tests) {
			let shared = commonPrefix(path, test.suitePath)

			for (
				let depth = shared;
				depth < test.suitePath.length;
				depth += 1
			) {
				lines.push(
					`${" ".repeat(1 + INDENT.length * (depth + 1))}${palette.strong(
						test.suitePath[depth],
					)}`,
				)
			}

			path = test.suitePath
			lines.push(
				`${" ".repeat(
					1 + INDENT.length * (test.suitePath.length + 1),
				)}${testLine(test, context)}`,
			)
		}
	}

	return lines
}

// #endregion

// #region The summary

export function renderTestSummary(
	run: TestRun,
	context: ReportContext,
	// NOTE: What the run RECORDED, which is not what it counted: a snapshot
	// written for the first time is a pass that left something on disk, and a
	// reader has to be told it happened without reading a diff to find out.
	snapshots = 0,
	// NOTE: Whether every entry of the run came out of the bundle cache. The
	// duration beside it is the RUN's, and a reader comparing two runs of the
	// same project deserves to know that one of them also compiled it.
	cacheWarm = false,
	// NOTE: What the run recorded as baselines, which is what the snapshot
	// count beside it is: a measurement written for the first time is a pass
	// that left something on disk.
	baselines = 0,
	// NOTE: How many compiled entries the run held, so that the replayed ones can
	// be reported as a share of them rather than as a bare number a reader has
	// nothing to compare against. Zero for a run that did not ask the result
	// cache anything, which is what leaves the note off.
	entries = 0,
): string {
	let { palette, theme } = context
	let { counts } = run
	let parts: Array<string> = []

	if (counts.passed > 0 || counts.failed === 0) {
		parts.push(palette.success(`${counts.passed} passed`))
	}

	if (counts.failed > 0) {
		parts.push(palette.error(`${counts.failed} failed`))
	}

	if (counts.skipped > 0) {
		parts.push(palette.muted(`${counts.skipped} skipped`))
	}

	if (counts.notFocused > 0) {
		parts.push(palette.muted(`${counts.notFocused} not focused`))
	}

	if (counts.deselected > 0) {
		parts.push(palette.muted(`${counts.deselected} deselected`))
	}

	if (snapshots > 0) {
		parts.push(palette.muted(`${pluralise(snapshots, "snapshot")} written`))
	}

	if (baselines > 0) {
		parts.push(palette.muted(`${pluralise(baselines, "baseline")} written`))
	}

	let notes: Array<string> = []

	if (cacheWarm) {
		notes.push("compile cache warm")
	}

	// NOTE: Beside the warm-compile note and after it, because the two answer the
	// same question in the order a reader asks it: this run did not compile the
	// project, and it did not run all of it either.
	if (run.cached > 0 && entries > 0) {
		notes.push(
			`${run.cached} of ${pluralise(entries, "entry", "entries")} cached`,
		)
	}

	let tail = ` ${parts.join("  ")}  ${palette.faint(
		theme.symbols.bullet,
	)}  ${palette.number(formatDuration(run.duration))}`

	return notes.reduce(
		(line, note) =>
			`${line}  ${palette.faint(theme.symbols.bullet)}  ${palette.muted(
				note,
			)}`,
		tail,
	)
}

// NOTE: The line a run with nothing to do ends on. It is not a failure — a
// directory with no tests in it has answered the question — but it says what
// was searched so that a mistyped path is visible.
export function renderNoTests(
	patterns: Array<string>,
	context: ReportContext,
): string {
	let { palette, theme } = context
	let where =
		patterns.length === 0
			? "under the working directory"
			: patterns.map((pattern) => palette.path(pattern)).join(", ")

	return ` ${palette.muted(theme.symbols.info)} ${palette.muted(
		`no tests ${patterns.length === 0 ? where : `in ${where}`}`,
	)}`
}

// #endregion

// #region Failures

function indented(text: string, prefix: string): Array<string> {
	return text
		.replace(/\n$/, "")
		.split("\n")
		.map((line) => `${prefix}${line}`)
}

// NOTE: What a test wrote while it ran, shown WITH the failure rather than
// interleaved with the reporter's own lines — which is the whole reason the
// runtime captures it.
function renderOutput(test: TestRecord, context: ReportContext): Array<string> {
	if (test.output.length === 0) {
		return []
	}

	let { palette } = context
	let text = test.output.map((chunk) => chunk.text).join("")

	return [
		`${INDENT}${palette.muted("output")}`,
		...indented(text, `${INDENT}${INDENT}`).map((line) =>
			palette.faint(line),
		),
		"",
	]
}

// NOTE: A JavaScript stack under a message that already says what happened.
// The frames name a bundle staged in a temporary directory and the files of the
// runner that staged it — nothing a reader of an Essence report can act on, and
// a path that will not exist by the time they read it. `--verbose` keeps them,
// because a Compiler bug is reported out of exactly those lines.
function withoutFrames(error: string): string {
	let lines = error.split("\n")
	let frames = lines.findIndex((line) => /^\s+at\s/.test(line))

	return frames === -1 ? error : lines.slice(0, frames).join("\n")
}

export type SourceLookup = (module: string | null) => string | null

// NOTE: Every failure of a run, rendered. A test whose module's source is not
// in reach — nothing in a CLI run, but a caller driving the reporter with
// events alone — still reports, without the excerpt.
export function renderTestFailures(
	run: TestRun,
	context: ReportContext,
	sourceOf: SourceLookup,
): Array<string> {
	let { palette, theme } = context
	let lines: Array<string> = []

	for (let test of run.tests) {
		if (test.state !== "failed") {
			continue
		}

		let sourceText = sourceOf(test.module)

		for (let failure of test.failures) {
			let diagnostic = testFailureDiagnostic(test, failure)

			if (diagnostic === null || sourceText === null) {
				lines.push(
					`${INDENT}${palette.error(theme.symbols.fail)} ${[
						...test.suitePath,
						test.name,
					].join(" › ")}`,
				)

				continue
			}

			lines.push(
				renderDiagnostic(
					diagnostic,
					new Source(sourceText),
					moduleLabel(test.module),
					{ color: context.theme.color },
				).replace(/\n$/, ""),
			)
		}

		// NOTE: A measurement that ran away from its baseline failed no
		// assertion, so there is no span to underline and no Diagnostic to
		// draw. What a reader needs is the two numbers and the one command that
		// accepts the new one — written through the same pair of Functions the
		// Diagnostic above carries them with, so the sentence exists once.
		if (test.benchmark?.status === "regressed") {
			lines.push(
				`${INDENT}${palette.error(theme.symbols.fail)} ${palette.error(
					[...test.suitePath, test.name].join(" › "),
				)} ${palette.muted("is slower than it was")}`,
			)
			lines.push(
				...benchmarkNotes(test).map(
					(note) => `${INDENT}${INDENT}${palette.muted(note)}`,
				),
				...benchmarkHelps(test).map(
					(help) => `${INDENT}${INDENT}${palette.muted(help)}`,
				),
				"",
			)
		}

		// NOTE: A regression's `error` is the stream's copy of the sentence the
		// block above already wrote — repeating it here would report one failure
		// twice.
		if (test.error !== null && test.benchmark?.status !== "regressed") {
			lines.push(
				`${INDENT}${palette.error(theme.symbols.fail)} ${palette.error(
					[...test.suitePath, test.name].join(" › "),
				)} ${palette.muted("stopped with an error")}`,
			)
			// NOTE: A property test that STOPPED rather than failed an
			// assertion still has to say which values it stopped on — the
			// Diagnostic above is where they are written for a failed `expect`,
			// and there is no Diagnostic here.
			lines.push(
				...propertyNotes(test).map(
					(note) => `${INDENT}${INDENT}${palette.muted(note)}`,
				),
				...propertyHelps(test).map(
					(help) => `${INDENT}${INDENT}${palette.muted(help)}`,
				),
			)
			lines.push(
				...indented(
					context.verbose ? test.error : withoutFrames(test.error),
					`${INDENT}${INDENT}`,
				).map((line) => palette.faint(line)),
			)
			lines.push("")
		}

		lines.push(...renderOutput(test, context))
	}

	return lines
}

// #endregion

// #region Focus

// NOTE: Grouped by the file each test was written in, in the order the runner
// met them, so the report reads in the order the tree above it did.
export function renderFocusedTests(
	tests: Array<FocusedTest>,
	context: ReportContext,
	sourceOf: SourceLookup,
): Array<string> {
	let byModule = new Map<string | null, Array<FocusedTest>>()

	for (let test of tests) {
		let existing = byModule.get(test.module)

		if (existing === undefined) {
			byModule.set(test.module, [test])
		} else {
			existing.push(test)
		}
	}

	let lines: Array<string> = []

	for (let [module, focused] of byModule) {
		let diagnostic = focusedTestsDiagnostic(focused)
		let sourceText = sourceOf(module)

		if (diagnostic === null || sourceText === null) {
			lines.push(
				`${INDENT}${context.palette.error(
					context.theme.symbols.fail,
				)} ${focused
					.map((test) => [...test.suitePath, test.name].join(" › "))
					.join(", ")} ${context.palette.muted("is focused")}`,
			)

			continue
		}

		lines.push(
			renderDiagnostic(
				diagnostic,
				new Source(sourceText),
				moduleLabel(module),
				{ color: context.theme.color },
			).replace(/\n$/, ""),
		)
	}

	return lines
}

// #endregion

// NOTE: The whole human-facing report, in the order it is read: what ran, what
// failed, and the tally. Returned as two blocks rather than one string because
// the failures are Diagnostics and go to stderr, exactly as a compilation's do,
// while the tree and the tally are the report and go to stdout.
export function renderTestReport(
	run: TestRun,
	context: ReportContext,
	sourceOf: SourceLookup,
	snapshots = 0,
	cacheWarm = false,
	baselines = 0,
	entries = 0,
): { tree: string; failures: string; summary: string } {
	return {
		tree: renderTestTree(run, context).join("\n"),
		failures: renderTestFailures(run, context, sourceOf).join("\n"),
		summary: renderTestSummary(
			run,
			context,
			snapshots,
			cacheWarm,
			baselines,
			entries,
		),
	}
}

// #region Mutation

// NOTE: What became of ONE deliberate lie, flat — the same fields the `mutant`
// event carries, so the report and the stream can not drift into saying
// different things about one mutant.
export type MutantRecord = {
	module: string | null
	position: common.Position
	operator: string
	description: string
	status: "killed" | "survived" | "uncovered" | "invalid" | "hung"
	killedBy: string | null
	tests: number
}

export type MutantCounts = {
	sites: number
	killed: number
	survived: number
	uncovered: number
	invalid: number
	hung: number
}

// NOTE: ONE tally, read by the summary line and written into `mutation-end`.
// They are two renderings of one fact, and counting twice is two chances to
// disagree about what a run found.
//
// NOTE: `sites` is every site the WALKER kept rather than every record here,
// because a `--mutation-limit` stops the judging without unfinding anything:
// the remainder between the two is what the limit left alone, and a consumer
// that wants it subtracts. It defaults to the records, which is what a run
// nobody narrowed has.
export function tallyMutants(
	mutants: Array<MutantRecord>,
	sites: number = mutants.length,
): MutantCounts {
	let counted = (status: MutantRecord["status"]): number =>
		mutants.filter((each) => each.status === status).length

	return {
		sites,
		killed: counted("killed"),
		survived: counted("survived"),
		uncovered: counted("uncovered"),
		invalid: counted("invalid"),
		hung: counted("hung"),
	}
}

// NOTE: The design's own summary line, and a block per SURVIVOR: a mutant
// nothing noticed is the whole finding, and the count above it is the context
// it is read in.
//
// NOTE: A survivor is rendered the way a regressed benchmark is — a `✗` line
// naming where and what, and muted lines under it — rather than as a
// Diagnostic. A Diagnostic carries a code, every code is a promise the
// documentation keeps, and nothing here is a claim about whether the source
// compiles. The line of source is quoted underneath so that a reader is shown
// the site without opening the file, which is the half of an excerpt that was
// worth keeping.
export function renderMutation(
	mutants: Array<MutantRecord>,
	context: ReportContext,
	sourceOf: SourceLookup,
	// NOTE: What a `--mutation-limit` stopped, where one did: how many mutants
	// were judged before it was reached, and how many covered sites were left
	// alone. Null for a run nobody narrowed. A reader comparing two scores has
	// to be told that one of them was taken over a sample, because the sample is
	// the file order and a project's hardest lines may all be in the last file.
	limit: { after: number; unjudged: number } | null = null,
): Array<string> {
	let { palette, theme } = context
	let counts = tallyMutants(mutants, mutants.length + (limit?.unjudged ?? 0))
	let lines: Array<string> = [""]

	for (let mutant of mutants) {
		if (mutant.status !== "survived") {
			continue
		}

		lines.push(
			`${INDENT}${palette.error(theme.symbols.fail)} ${palette.path(
				siteLabel(mutant),
			)}  ${mutant.description} ${palette.muted(
				"— every test still passes",
			)}`,
		)
		lines.push(
			...excerpt(mutant, sourceOf).map(
				(line) => `${INDENT}${INDENT}${palette.faint(line)}`,
			),
		)
		lines.push(
			`${INDENT}${INDENT}${palette.muted(
				`reached by ${pluralise(mutant.tests, "test")}`,
			)}`,
		)
		lines.push("")
	}

	// NOTE: Under --verbose the sites nothing reaches are named as well. They
	// are the coverage report's finding wearing mutation's hat — a line no test
	// runs is a line no mutant of it could ever be caught on — and they are
	// listed rather than summarised only where a reader asked for everything.
	// A mutant that HUNG is listed beside them for the reason a reader would
	// want: it counted as caught, and which site stopped answering is the one
	// thing the summary line can not say.
	for (let mutant of mutants) {
		let aside = ASIDES[mutant.status]

		if (!context.verbose || aside === undefined) {
			continue
		}

		lines.push(
			`${INDENT}${palette.muted(theme.symbols.info)} ${palette.path(
				siteLabel(mutant),
			)}  ${palette.muted(`${mutant.description} — ${aside}`)}`,
		)
	}

	if (lines.length > 1 && lines[lines.length - 1] !== "") {
		lines.push("")
	}

	// NOTE: Above the summary rather than folded into it, because it is not a
	// count of anything the run found — it is the sentence that says the run
	// stopped looking, and a reader has to meet it before they read a score.
	if (limit !== null) {
		lines.push(
			`${INDENT}${palette.muted(theme.symbols.info)} ${palette.muted(
				`limit reached after ${pluralise(
					limit.after,
					"mutant",
				)} — ${pluralise(limit.unjudged, "site")} left unjudged`,
			)}`,
		)
		lines.push("")
	}

	lines.push(renderMutationSummary(counts, context))
	lines.push("")

	return lines
}

// NOTE: What a status that is not a SURVIVOR is worth saying about a site, in
// the one line --verbose gives it. A killed mutant has none: it is the answer a
// reader hoped for, and naming every one of them would bury the three that
// matter.
const ASIDES: Partial<Record<MutantRecord["status"], string>> = {
	uncovered: "no test reaches this line",
	invalid: "the mutant did not compile",
	hung: "the run never came back, and was stopped",
}

function renderMutationSummary(
	counts: MutantCounts,
	context: ReportContext,
): string {
	let { palette, theme } = context
	let parts = [
		palette.number(`${pluralise(counts.sites, "mutant")}`),
		palette.success(`${counts.killed} killed`),
	]

	if (counts.survived > 0) {
		parts.push(palette.error(`${counts.survived} survived`))
	}

	// NOTE: Only where there were any, because a hang is rare enough that a
	// standing "0 hung" would be noise on every run that never met one.
	if (counts.hung > 0) {
		parts.push(palette.success(`${counts.hung} hung`))
	}

	if (counts.uncovered > 0) {
		parts.push(
			palette.muted(
				`${counts.uncovered} on ${
					counts.uncovered === 1 ? "a line" : "lines"
				} no test reaches`,
			),
		)
	}

	if (counts.invalid > 0) {
		parts.push(palette.muted(`${counts.invalid} did not compile`))
	}

	// NOTE: The SCORE is what a reader compares between runs, and it is the
	// share of the mutants that could be judged at all: a site no test reaches
	// and a mutant that would not compile say nothing about the tests, so
	// counting them in would move the number for reasons nobody could act on.
	//
	// NOTE: A mutant that HUNG counts, and it counts as CAUGHT. A run that does
	// not end is a failure a reader would notice as surely as a red test, and
	// leaving it out would let a suite improve its number by writing the one
	// kind of bug this tool can not wait for.
	let judged = counts.killed + counts.survived + counts.hung
	let score =
		judged === 0
			? null
			: `${Math.round(((counts.killed + counts.hung) / judged) * 100)}% caught`

	return score === null
		? ` ${parts.join(`  ${palette.faint(theme.symbols.bullet)}  `)}`
		: ` ${parts.join(
				`  ${palette.faint(theme.symbols.bullet)}  `,
			)}  ${palette.faint(theme.symbols.bullet)}  ${palette.number(score)}`
}

function siteLabel(mutant: MutantRecord): string {
	return `${moduleLabel(mutant.module)}:${mutant.position.start.line}`
}

// NOTE: The one line the site stands on, quoted as the file has it. A site
// whose source is out of reach — a caller driving this with events alone —
// simply has none, which is what keeps the block readable either way.
function excerpt(mutant: MutantRecord, sourceOf: SourceLookup): Array<string> {
	let sourceText = sourceOf(mutant.module)

	if (sourceText === null) {
		return []
	}

	let line = sourceText.split("\n")[mutant.position.start.line - 1]

	return line === undefined ? [] : [line.trim()]
}

// #endregion

// #region Coverage

// NOTE: What a `--coverage` run says, as the design's table: a row per file
// with lines and branches as percentages, Match arms as taken out of total,
// and — spilling down the last column — every branch and arm nothing reached,
// named by the Method or Function it stands in. Under it, one line per Case of
// a `choice` that no test ever built, which is a claim an exhaustive language
// can make and a line-counting one can not.
//
// NOTE: A dash rather than a number where there was nothing to be a percentage
// of. A file with no branches in it is not 0% branch-covered and it is not 100%
// either.
export function renderCoverage(
	summary: CoverageSummary,
	context: ReportContext,
): Array<string> {
	if (!hasCoverage(summary)) {
		return []
	}

	let { palette } = context
	let rows = summary.files.filter(isReported).map((file) => ({
		file: moduleLabel(file.module),
		lines: ratioLabel(file.lines),
		branches: ratioLabel(file.branches),
		cases:
			file.cases.total === 0
				? "–"
				: `${file.cases.covered}/${file.cases.total}`,
		missed: missedLabels(file),
	}))
	let widths = {
		file: widest(["File", ...rows.map((row) => row.file)]),
		lines: widest(["Lines", ...rows.map((row) => row.lines)]),
		branches: widest(["Branches", ...rows.map((row) => row.branches)]),
		cases: widest(["Cases", ...rows.map((row) => row.cases)]),
	}

	let lines = [
		palette.muted(
			` ${pad("File", widths.file)}  ${pad("Lines", widths.lines)}  ${pad(
				"Branches",
				widths.branches,
			)}  ${pad("Cases", widths.cases)}  Not taken`,
		),
	]

	for (let row of rows) {
		let head =
			` ${pad(row.file, widths.file)}  ` +
			`${palette.number(pad(row.lines, widths.lines))}  ` +
			`${palette.number(pad(row.branches, widths.branches))}  ` +
			`${palette.number(pad(row.cases, widths.cases))}  `
		let indent = " ".repeat(
			1 +
				widths.file +
				2 +
				widths.lines +
				2 +
				widths.branches +
				2 +
				widths.cases +
				2,
		)

		lines.push(`${head}${palette.muted(row.missed[0] ?? "")}`.trimEnd())

		for (let missed of row.missed.slice(1)) {
			lines.push(`${indent}${palette.muted(missed)}`)
		}
	}

	for (let choice of summary.choices) {
		for (let entry of choice.cases) {
			if (entry.constructed) {
				continue
			}

			lines.push(
				palette.muted(
					` Choice ${choice.name}: ${caseNameOf(
						entry.tag,
					)} never constructed by a test`,
				),
			)
		}
	}

	return lines
}

// NOTE: A doorway that was never entered is marked, because it is the one a
// reader should look at first: a branch whose condition established something
// guards a path the rest of the file can not reach any other way.
function missedLabels(file: FileCoverage): Array<string> {
	return file.missed.map((missed) => {
		let where = missed.scope === "" ? "" : `${missed.scope} › `
		let mark =
			missed.refinement && missed.kind === "branch" ? " (guarded)" : ""

		return `${where}${missed.label}${mark}`
	})
}

function ratioLabel(ratio: CoverageRatio): string {
	let percentage = percentageOf(ratio)

	return percentage === null ? "–" : `${percentage}%`
}

function widest(values: Array<string>): number {
	return values.reduce((width, value) => Math.max(width, value.length), 0)
}

function pad(value: string, width: number): string {
	return value.padEnd(width)
}

// #endregion
