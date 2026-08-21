import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { fixturePath } from "@essence-lang/fixtures"
import type { common } from "@essence-lang/interfaces"
import type { entryPoints, TestEvent } from "@essence-lang/runtime/Testing"
import { registryOf } from "@essence-lang/runtime/Testing"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import {
	defaultOptimiserOptions,
	optimise,
	type OptimiserOptions,
	optimiserOptionsKey,
	optimiserPassNames,
	unoptimisedOptions,
} from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import {
	collectCoverage,
	type CoverageSummary,
	type CoveredPointRecord,
	fileCoverageOf,
	mergeCoverage,
	neverConstructed,
	percentageOf,
	toCoverageJson,
	toLcov,
} from "../testing/index"
import { validate } from "../validator/index"

// NOTE: What `instrument-coverage` writes into a Program, what the emitted
// JavaScript then counts, and what a report makes of the counts. The three are
// here together for the reason the test lowering's spec gives: a table that
// says where a counter stands proves nothing on its own, and a run that
// reports 94% says nothing about which line the 6% is.

const coverageOptions: OptimiserOptions = {
	enabled: true,
	disabledPasses: new Set(),
	coverage: true,
}

function instrumented(
	source: string,
	options: OptimiserOptions = coverageOptions,
): common.typedSimple.Program {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program, { tests: true })

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return optimise(simplify(enriched.program, { source }), options)
}

function pointsOf(
	program: common.typedSimple.Program,
): Array<common.typedSimple.CoveragePoint> {
	return program.coverage?.points ?? []
}

function labelsOf(
	program: common.typedSimple.Program,
	kind: common.typedSimple.CoveragePointKind,
): Array<string> {
	return pointsOf(program)
		.filter((point) => point.kind === kind)
		.map((point) =>
			point.scope === ""
				? point.label
				: `${point.scope} › ${point.label}`,
		)
}

const fixtures = `implementation {
	choice Fixture {
		Played { home: Integer, away: Integer },
		Postponed { reason: String },
		Forfeited,
	}

	function share(_ total: Integer, over played: Integer) -> Integer {
		if played::isNot(0) {
			<- total
		} else {
			<- 0
		}
	}

	namespace Standings {
		static points(of fixture: Fixture) -> Integer {
			<- match fixture -> Integer {
				case #Played { <- 3 }
				case #Postponed { <- 0 }
				case #Forfeited { <- 1 }
			}
		}
	}

	constant sample = Fixture#Played({ home = 2, away = 1 })
}

tests {
	test "counts a played fixture" {
		expect Standings.points(of sample)::is(3)
	}

	test "shares nothing over no games" {
		expect share(10, over 0)::is(0)
	}
}
`

describe("The coverage instrumentation pass", () => {
	it("writes nothing at all unless the caller asked for it", () => {
		let program = instrumented(fixtures, defaultOptimiserOptions)

		expect(program.coverage).toBeNull()
		expect(
			rewrite(program, defaultOptimiserOptions).includes("$cover"),
		).toBe(false)
	})

	it("is a named pass, first in the order", () => {
		expect(optimiserPassNames[0]).toBe("instrument-coverage")
	})

	it("counts a Statement where it was written", () => {
		let statements = pointsOf(instrumented(fixtures)).filter(
			(point) => point.kind === "statement",
		)

		expect(statements.length).toBeGreaterThan(0)
		// NOTE: The `constant sample = …` at the Program's own top level.
		expect(
			statements.some(
				(point) =>
					point.scope === "" && point.position.start.line === 26,
			),
		).toBe(true)
	})

	it("counts both sides of a branch, the `else` included", () => {
		expect(labelsOf(instrumented(fixtures), "branch")).toEqual([
			"share › if",
			"share › else",
		])
	})

	it("marks a branch whose condition established something", () => {
		let branches = pointsOf(instrumented(fixtures)).filter(
			(point) => point.kind === "branch",
		)

		expect(branches.every((point) => point.refinement)).toBe(true)
	})

	it("leaves a branch that established nothing unmarked", () => {
		let program = instrumented(`implementation {
	function pick(_ flag: Boolean) -> Integer {
		if flag {
			<- 1
		} else {
			<- 2
		}
	}
}`)
		let branches = pointsOf(program).filter(
			(point) => point.kind === "branch",
		)

		expect(branches).toHaveLength(2)
		expect(branches.every((point) => point.refinement)).toBe(false)
	})

	it("counts every arm of a Match, named as the arm was written", () => {
		expect(labelsOf(instrumented(fixtures), "case")).toEqual([
			"Standings::points › case #Played",
			"Standings::points › case #Postponed",
			"Standings::points › case #Forfeited",
		])
	})

	it("counts a Case construction, and names the tag it builds", () => {
		let constructions = pointsOf(instrumented(fixtures)).filter(
			(point) => point.kind === "construction",
		)

		expect(constructions).toHaveLength(1)
		expect(constructions[0]!.tag).toBe("Fixture#Played")
		expect(constructions[0]!.label).toBe("#Played")
	})

	it("records every Choice the Module declares, with its Cases", () => {
		expect(instrumented(fixtures).coverage?.choices).toEqual([
			{
				name: "Fixture",
				cases: [
					"Fixture#Played",
					"Fixture#Postponed",
					"Fixture#Forfeited",
				],
				position: expect.anything() as unknown as common.Position,
			},
		])
	})

	it("does not read a Type Alias over a Choice as a declaration of one", () => {
		let program = instrumented(`implementation {
	type Answer = Optional<Integer>

	constant found: Answer = #Value(1)
}`)

		expect(program.coverage?.choices).toEqual([])
	})

	it("counts the Cases a test builds, and none of its Statements", () => {
		let program = instrumented(`implementation {
	choice Colour { Red, Blue }
}

tests {
	test "builds one" {
		constant chosen = Colour#Red

		expect chosen::is(Colour#Red)
	}
}`)
		let kinds = new Set(pointsOf(program).map((point) => point.kind))

		expect(kinds).toEqual(new Set(["construction"]))
		expect(pointsOf(program).map((point) => point.tag)).toEqual([
			"Colour#Red",
			"Colour#Red",
		])
	})

	it("skips a declaration, which is there whether anything ran or not", () => {
		let program = instrumented(`implementation {
	type Named = { name: String }

	function greet() -> String {
		<- "hello"
	}
}`)

		// NOTE: The Function's own `<- "hello"` and nothing else — neither the
		// Type Alias nor the Function declaration is a thing that RUNS.
		expect(pointsOf(program)).toHaveLength(1)
	})

	it("instruments with the whole phase off, because the caller asked", () => {
		let program = instrumented(fixtures, {
			...unoptimisedOptions,
			coverage: true,
		})

		expect(pointsOf(program).length).toBeGreaterThan(0)
	})

	it("is turned off by name like every other pass", () => {
		let program = instrumented(fixtures, {
			...coverageOptions,
			disabledPasses: new Set(["instrument-coverage"]),
		})

		expect(program.coverage).toBeNull()
	})

	it("keeps an instrumented compile out of a plain compile's cache entry", () => {
		expect(optimiserOptionsKey(coverageOptions)).not.toBe(
			optimiserOptionsKey(defaultOptimiserOptions),
		)
		expect(
			optimiserOptionsKey({ ...unoptimisedOptions, coverage: true }),
		).not.toBe(optimiserOptionsKey(unoptimisedOptions))
	})

	it("never instruments the standard library", () => {
		// NOTE: An implementation of one Statement whose test reaches into the
		// library, so the emitted file holds the library's own bodies. Exactly
		// as many counter calls as the Module has points: if the prelude were
		// instrumented there would be hundreds.
		let program = instrumented(`implementation {
	constant items = [1, 2]
}

tests {
	test "reaches the library" {
		expect items::hasItems()
	}
}`)
		let javaScript = rewrite(program, coverageOptions)

		expect(javaScript.includes("const $cover = $testing.counters(")).toBe(
			true,
		)
		expect(javaScript.includes("const $es_List_hasItems")).toBe(true)
		expect(javaScript.split("$cover(").length - 1).toBe(
			pointsOf(program).length,
		)
	})

	it("writes no table for a Module with nothing to count", () => {
		// NOTE: Imports and tests, and the tests build no Case — so there is
		// nothing to count and nothing to declare, and a report has no row for
		// it rather than a row of dashes.
		let program = instrumented(`implementation {}

tests {
	test "says nothing about coverage" {
		expect true
	}
}`)

		expect(program.coverage).toBeNull()
		expect(rewrite(program, coverageOptions).includes("$cover")).toBe(false)
	})

	it("writes a table for a Module that only DECLARES a Choice", () => {
		let program = instrumented(`implementation {
	choice Colour { Red, Blue }
}`)

		expect(pointsOf(program)).toEqual([])
		expect(program.coverage?.choices.map((choice) => choice.name)).toEqual([
			"Colour",
		])
	})
})

// NOTE: An emitted `.ts` program imports the runtime by its absolute path,
// which is the very module this file imports — so every program loaded here
// counts into ONE table, and the coverage of the program just loaded is the
// LAST record in it. A bundle has no such trouble: esbuild inlines a runtime of
// its own.
async function runWithCoverage(source: string): Promise<{
	events: Array<TestEvent>
	coverage: Extract<TestEvent, { kind: "coverage" }>
	summary: CoverageSummary
}> {
	let javaScript = rewrite(instrumented(source), coverageOptions)
	let directory = mkdtempSync(join(tmpdir(), "essence-coverage-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, javaScript)

	let loaded = (await import(file)) as { $tests: typeof entryPoints }
	let modules = loaded.$tests.registry().modules
	let events: Array<TestEvent> = []

	try {
		loaded.$tests.run(registryOf(modules.slice(modules.length - 1)), {
			sink: (event) => events.push(event),
			now: () => 0,
			coverage: true,
		})

		let reports = events.filter((event) => event.kind === "coverage")
		let coverage = reports[reports.length - 1] as Extract<
			TestEvent,
			{ kind: "coverage" }
		>

		// NOTE: Folded over THIS program's report alone, for the reason above:
		// the events carry one for every program this spec file has ever
		// loaded, because they all count into one table.
		return { events, coverage, summary: collectCoverage([coverage]) }
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}

describe("A run that asked for coverage", () => {
	it("writes what every point counted, before the run ends", async () => {
		let { events, coverage } = await runWithCoverage(fixtures)
		let kinds = events.map((event) => event.kind)

		expect(kinds.indexOf("coverage")).toBeLessThan(kinds.indexOf("run-end"))
		expect(coverage.points.length).toBeGreaterThan(0)
	})

	it("counts the arm a test took and not the ones it did not", async () => {
		let { coverage } = await runWithCoverage(fixtures)
		let arms = coverage.points.filter((point) => point.kind === "case")

		expect(arms.map((point) => [point.label, point.count > 0])).toEqual([
			["case #Played", true],
			["case #Postponed", false],
			["case #Forfeited", false],
		])
	})

	it("counts the side of a branch a test entered", async () => {
		let { coverage } = await runWithCoverage(fixtures)
		let branches = coverage.points.filter(
			(point) => point.kind === "branch",
		)

		expect(branches.map((point) => [point.label, point.count > 0])).toEqual(
			[
				["if", false],
				["else", true],
			],
		)
	})

	it("says which Cases of a Choice nothing built", async () => {
		let { summary } = await runWithCoverage(fixtures)

		expect(neverConstructed(summary)).toEqual([
			{ choice: "Fixture", tag: "#Postponed" },
			{ choice: "Fixture", tag: "#Forfeited" },
		])
	})

	it("counts a Case a test builds as constructed", async () => {
		let { summary } = await runWithCoverage(`implementation {
	choice Colour { Red, Blue }
}

tests {
	test "builds one" {
		expect Colour#Red::is(Colour#Red)
	}
}`)

		expect(neverConstructed(summary)).toEqual([
			{ choice: "Colour", tag: "#Blue" },
		])
	})

	it("starts a second run where loading the Module left it", async () => {
		let javaScript = rewrite(instrumented(fixtures), coverageOptions)
		let directory = mkdtempSync(join(tmpdir(), "essence-coverage-"))
		let file = join(directory, "program.ts")

		writeFileSync(file, javaScript)

		let loaded = (await import(file)) as { $tests: typeof entryPoints }
		let modules = loaded.$tests.registry().modules
		let registry = registryOf(modules.slice(modules.length - 1))

		let counts = (): Array<number> => {
			let events: Array<TestEvent> = []

			loaded.$tests.run(registry, {
				sink: (event) => events.push(event),
				now: () => 0,
				coverage: true,
			})

			let reports = events.filter((event) => event.kind === "coverage")
			let last = reports[reports.length - 1] as Extract<
				TestEvent,
				{ kind: "coverage" }
			>

			return last.points.map((point) => point.count)
		}

		try {
			expect(counts()).toEqual(counts())
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	})
})

// NOTE: The repository's own tests fixture, counted. It is the one file in the
// repository that writes every shape a coverage run has to say something about
// — a Choice, a Match over all of it, an `else if` chain, a Namespace, a
// private free Function — so what it counts is a fixed point worth pinning.
describe("The Tests.es fixture, counted", () => {
	const fixture = readFileSync(fixturePath("Tests.es"), "utf8")

	it("counts the whole of what loading it and running it reached", async () => {
		let { summary } = await runWithCoverage(fixture)
		let [file] = summary.files

		expect(file).toBeDefined()
		expect(file!.lines).toEqual({ covered: 15, total: 16 })
		expect(file!.branches).toEqual({ covered: 4, total: 4 })
		expect(file!.cases).toEqual({ covered: 2, total: 3 })
	})

	it("names the one arm nothing took", async () => {
		let { summary } = await runWithCoverage(fixture)
		let [file] = summary.files

		expect(
			file!.missed.map((missed) => `${missed.scope} › ${missed.label}`),
		).toEqual(["pointsFor › case #Loss"])
	})

	it("finds every Case of its Choice built by something", async () => {
		let { summary } = await runWithCoverage(fixture)

		expect(neverConstructed(summary)).toEqual([])
	})

	// NOTE: And this is the fixture's most useful claim. It FOCUSES one test,
	// so focusing changes which tests run — and changes the coverage not at
	// all, because what its counters counted is mostly its own Program body,
	// which runs when the Module is loaded. That is deliberate: a Module is
	// evaluated once however many times its tests are run, and a run resets the
	// counts to what LOADING left rather than to zero, so a top-level Statement
	// is never reported as never executed.
	it("counts what loading the Module did, whatever the run selects", async () => {
		let focused = await runWithCoverage(fixture)
		let all = await runWithCoverage(fixture.replace(" focused {", " {"))

		expect(all.summary.files[0]!.lines).toEqual(
			focused.summary.files[0]!.lines,
		)
		expect(all.summary.files[0]!.cases).toEqual(
			focused.summary.files[0]!.cases,
		)
	})
})

function point(
	overrides: Partial<CoveredPointRecord> & {
		kind: CoveredPointRecord["kind"]
		line: number
		count: number
	},
): CoveredPointRecord {
	return {
		kind: overrides.kind,
		label: overrides.label ?? "",
		scope: overrides.scope ?? "",
		position: {
			start: { line: overrides.line, column: 1 },
			end: { line: overrides.line, column: 9 },
		},
		refinement: overrides.refinement ?? false,
		tag: overrides.tag ?? null,
		count: overrides.count,
	}
}

const sampleFile = fileCoverageOf("/project/Standings.es", [
	point({ kind: "statement", line: 1, count: 3 }),
	point({ kind: "statement", line: 1, count: 0 }),
	point({ kind: "statement", line: 2, count: 0 }),
	point({
		kind: "branch",
		line: 4,
		count: 0,
		label: "else",
		scope: "Standings::compute",
		refinement: true,
	}),
	point({ kind: "branch", line: 4, count: 2, label: "if" }),
	point({
		kind: "case",
		line: 7,
		count: 0,
		label: "case #Postponed",
		scope: "Standings::compute",
	}),
	point({
		kind: "construction",
		line: 9,
		count: 1,
		label: "#Played",
		tag: "Fixture#Played",
	}),
])

describe("Folding a coverage run", () => {
	it("counts a line once, however many points stand on it", () => {
		// NOTE: Lines 1 and 2 hold Statements, line 4 a branch and line 7 an
		// arm — four lines, of which the one that ran and the one the branch
		// was taken on are covered. The construction on line 9 is no line of
		// its own: the Statement it stands in is counted already.
		expect(sampleFile.lines).toEqual({ covered: 2, total: 4 })
	})

	it("counts branches and Cases apart", () => {
		expect(sampleFile.branches).toEqual({ covered: 1, total: 2 })
		expect(sampleFile.cases).toEqual({ covered: 0, total: 1 })
	})

	it("names what was not taken, in the order it was written", () => {
		expect(
			sampleFile.missed.map(
				(missed) => `${missed.scope} › ${missed.label}`,
			),
		).toEqual([
			"Standings::compute › else",
			"Standings::compute › case #Postponed",
		])
	})

	it("keeps a doorway's mark on what was missed", () => {
		expect(sampleFile.missed[0]!.refinement).toBe(true)
	})

	it("answers a ratio with nothing in it with no percentage", () => {
		expect(percentageOf({ covered: 0, total: 0 })).toBeNull()
		expect(percentageOf({ covered: 1, total: 2 })).toBe(50)
	})

	it("adds the counts of a Module two bundles both reported", () => {
		let points = [point({ kind: "statement", line: 1, count: 2 })]
		let summary = collectCoverage([
			{
				schema: 1,
				kind: "coverage",
				module: "/project/A.es",
				points,
				choices: [],
			},
			{
				schema: 1,
				kind: "coverage",
				module: "/project/A.es",
				points,
				choices: [],
			},
		])

		expect(summary.files[0]!.points[0]!.count).toBe(4)
	})

	it("replaces a report whose table no longer agrees", () => {
		let summary = collectCoverage([
			{
				schema: 1,
				kind: "coverage",
				module: "/project/A.es",
				points: [
					point({ kind: "statement", line: 1, count: 2 }),
					point({ kind: "statement", line: 2, count: 2 }),
				],
				choices: [],
			},
			{
				schema: 1,
				kind: "coverage",
				module: "/project/A.es",
				points: [point({ kind: "statement", line: 1, count: 1 })],
				choices: [],
			},
		])

		expect(summary.files[0]!.points).toHaveLength(1)
		expect(summary.files[0]!.points[0]!.count).toBe(1)
	})

	it("lays one cycle's answer over the last one, file by file", () => {
		let previous = collectCoverage([
			{
				schema: 1,
				kind: "coverage",
				module: "/project/A.es",
				points: [point({ kind: "statement", line: 1, count: 1 })],
				choices: [
					{
						name: "Colour",
						cases: ["Colour#Red", "Colour#Blue"],
						position: sampleFile.points[0]!.position,
					},
				],
			},
			{
				schema: 1,
				kind: "coverage",
				module: "/project/B.es",
				points: [
					point({
						kind: "construction",
						line: 1,
						count: 1,
						tag: "Colour#Red",
					}),
				],
				choices: [],
			},
		])
		let next = collectCoverage([
			{
				schema: 1,
				kind: "coverage",
				module: "/project/B.es",
				points: [
					point({
						kind: "construction",
						line: 1,
						count: 0,
						tag: "Colour#Red",
					}),
				],
				choices: [],
			},
		])
		let merged = mergeCoverage(previous, next)

		expect(merged.files.map((file) => file.module)).toEqual([
			"/project/A.es",
			"/project/B.es",
		])
		// NOTE: The re-run says nothing built a `#Red` this time, and the file
		// that was not re-run never built one — so the answer changed.
		expect(neverConstructed(merged)).toEqual([
			{ choice: "Colour", tag: "#Red" },
			{ choice: "Colour", tag: "#Blue" },
		])
	})
})

const writtenSummary: CoverageSummary = {
	files: [
		sampleFile,
		// NOTE: A `Foo.tests.es` — all tests, no implementation. It counts the
		// Cases its tests build and has no coverage of its own, and neither
		// written form says a word about it.
		fileCoverageOf("/project/Season.tests.es", []),
	],
	choices: [
		{
			name: "Fixture",
			module: "/project/Standings.es",
			position: sampleFile.points[0]!.position,
			cases: [
				{ tag: "Fixture#Played", constructed: true },
				{ tag: "Fixture#Forfeited", constructed: false },
			],
		},
	],
}

describe("Writing a coverage run out", () => {
	it("writes lcov", () => {
		expect(toLcov(writtenSummary)).toMatchSnapshot()
	})

	it("writes json", () => {
		expect(toCoverageJson(writtenSummary)).toMatchSnapshot()
	})

	it("writes nothing for a run that counted nothing", () => {
		expect(toLcov({ files: [], choices: [] })).toBe("")
	})
})
