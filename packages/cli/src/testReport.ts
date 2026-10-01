import { Source } from "@essence-lang/ariadne"
import {
	displayPath,
	renderDiagnostic,
} from "@essence-lang/compiler/diagnostics/render"
import { printableText } from "@essence-lang/compiler/helpers"
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
	testDisplayPath,
	testFailureDiagnostic,
} from "@essence-lang/compiler/testing"
import type { common } from "@essence-lang/interfaces"

import type { ReportContext } from "./report"
import { formatDuration, pluralise } from "./report"

// Everything a person reads about a test run, rendered as strings so specs can
// assert on it without a terminal. The fold of the events and the failure
// Diagnostics are the Compiler's, which the Language Server shares.
//
// The Compiler's test-run helpers are re-exported here for the command line.
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
	// A table row whose name does not tell it from its siblings is labelled as
	// a row instead.
	let written = rowLabel(test) ?? printableText(test.name)
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

	// A property test shows its case count whether it held or not.
	let cases =
		test.property === null ||
		(test.state !== "passed" && test.state !== "failed")
			? ""
			: palette.faint(`  (${casesOf(test.property)})`)

	return `${symbol} ${name}${cases}${measurement(test, context)}${detail}`
}

// What a benchmark cost, shown whether or not it held to its baseline. A run
// never moves a baseline itself, so an improvement names the command that does.
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

// The cases a property drew, and apart from them the stored counterexamples it
// replayed first. The drawn count stays the same for a `--seed` replay as the
// corpus grows.
function casesOf(property: PropertyRecord): string {
	let drawn = pluralise(property.cases, "case")

	return property.replayed === 0
		? drawn
		: `${drawn} · ${property.replayed} replayed`
}

// Deselected tests are only counted in the summary, unless `--verbose` asks
// for them.
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

// A Module's tests arrive in source order, so a suite heading is printed where
// a test's suite path stops matching the previous one's.
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
						printableText(test.suitePath[depth] as string),
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
	// How many snapshots the run wrote to disk.
	snapshots = 0,
	// Whether every entry came from the bundle cache, so the duration includes
	// no compile.
	cacheWarm = false,
	// How many benchmark baselines the run wrote to disk.
	baselines = 0,
	// How many entries the run compiled, which the replayed count is shown
	// against. Zero leaves that note off.
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

// The line a run without tests ends on. It names what was searched, so a
// mistyped path shows.
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

// What a test wrote while it ran, which the runtime captures so it shows with
// the failure.
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

// Drops the stack frames, which name a staged bundle that is already gone.
// `--verbose` keeps them for reporting Compiler bugs.
function withoutFrames(error: string): string {
	let lines = error.split("\n")
	let frames = lines.findIndex((line) => /^\s+at\s/.test(line))

	return frames === -1 ? error : lines.slice(0, frames).join("\n")
}

type SourceLookup = (module: string | null) => string | null

// Every failure of a run. Without its Module's source, a failure is reported
// without the excerpt.
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
					`${INDENT}${palette.error(theme.symbols.fail)} ${testDisplayPath(
						[...test.suitePath, test.name],
					)}`,
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

		// A regressed benchmark failed no assertion, so it has no Diagnostic. Its
		// notes and helps come from the Functions the Diagnostic uses.
		if (test.benchmark?.status === "regressed") {
			lines.push(
				`${INDENT}${palette.error(theme.symbols.fail)} ${palette.error(
					testDisplayPath([...test.suitePath, test.name]),
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

		// A regression's `error` repeats what its own block wrote.
		if (test.error !== null && test.benchmark?.status !== "regressed") {
			lines.push(
				`${INDENT}${palette.error(theme.symbols.fail)} ${palette.error(
					testDisplayPath([...test.suitePath, test.name]),
				)} ${palette.muted("stopped with an error")}`,
			)
			// A property test that stopped with an error still names the values
			// it stopped on, which a Diagnostic would otherwise carry.
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

// Grouped by file, in the order the runner met them, as the tree is.
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
					.map((test) =>
						testDisplayPath([...test.suitePath, test.name]),
					)
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

// The whole human-facing report. The failures are returned apart because they
// go to stderr, while the tree and the summary go to stdout.
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

// What became of one mutant: the fields the `mutant` event carries, which the
// report reads too.
export type MutantRecord = {
	module: string | null
	position: common.Position
	operator: string
	description: string
	status: "killed" | "survived" | "uncovered" | "invalid" | "hung"
	killedBy: string | null
	tests: number
}

type MutantCounts = {
	sites: number
	killed: number
	survived: number
	uncovered: number
	invalid: number
	hung: number
}

// The one tally the summary line and `mutation-end` both read. `sites` counts
// every site found, so under `--mutation-limit` it exceeds the records.
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

// A block per survivor, then the summary line. A survivor says nothing about
// whether the source compiles, so it is no Diagnostic. It is rendered like a
// regressed benchmark, with its source line quoted.
export function renderMutation(
	mutants: Array<MutantRecord>,
	context: ReportContext,
	sourceOf: SourceLookup,
	// Where `--mutation-limit` stopped the run: mutants judged before it, and
	// covered sites left unjudged. Null without a limit.
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

	// `--verbose` also lists uncovered, invalid and hung mutants. A hang counts
	// as caught, but only this line says which site hung.
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

	// Before the summary, so a reader learns the score covers a sample.
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

// The `--verbose` line for each status worth one. Killed mutants get none.
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

	// The score is the caught share of judged mutants. Uncovered and invalid
	// ones say nothing about the tests, and a hang counts as caught.
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

// The site's source line, trimmed, or nothing without the source.
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

// The `--coverage` table: per file, lines and branches as percentages, Match
// arms as taken out of total, and every branch and arm nothing reached. Then a
// line per `choice` Case no test built. A dash marks a ratio of nothing.
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

// A missed branch whose condition refines a value is marked as guarded, since
// nothing else in the file reaches its path.
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
