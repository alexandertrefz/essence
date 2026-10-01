import { describe, expect, test } from "bun:test"

import { createBoolean } from "../Boolean"
import { createDictionary } from "../Dictionary"
import { decode, type Generator } from "../Generators"
import { createInteger } from "../Integer"
import { createList } from "../List"
import { createRecord } from "../Record"
import type { StreamType } from "../Stream"
import { createString } from "../String"
import {
	inspect,
	readLine,
	withInputSource,
	withOutputSink,
	write,
} from "../Terminal"
import {
	beginCoverageRun,
	benchmark,
	benchmarkRows,
	beginCoverageSpan,
	touchedGround,
	type CorpusStore,
	coverage,
	counters,
	createContext,
	entry,
	expected,
	probe,
	properties,
	type PropertyParameter,
	randomSeed,
	type Range,
	registryOf,
	required,
	type RunOptions,
	runTests,
	selectTests,
	type Span,
	structuralDiff,
	type TestContext,
	type TestEvent,
	type TestManifestEntry,
	type TestModule,
	trace,
} from "../Testing"
import { type AnyType, createCase, typeKeySymbol } from "../type"

// The test runtime, driven as emitted JavaScript drives it. A manifest is plain
// data and `run` a Function of the context, so a compiled `tests` section can
// be written by hand.

const integer = (value: number) => createInteger(BigInt(value))
const string = (value: string) => createString(value)

// The keys are distinct Strings, so the key witness never decides anything.
const dictionary = (...pairs: Array<[string, AnyType]>) =>
	createDictionary(
		pairs.map(([key, value]) => [string(key), value] as [AnyType, AnyType]),
		{ is: () => createBoolean(false) },
	) as unknown as AnyType

// `CaseInstanceType` stays out of `AnyType`, so a Case value is cast once here.
const caseValue = (tag: string, payload?: Record<string, AnyType>): AnyType =>
	createCase(tag, payload) as unknown as AnyType

const outputStream = caseValue("Stream#Output") as unknown as StreamType

const nowhere: Range = {
	start: { line: 1, column: 1 },
	end: { line: 1, column: 1 },
}

function span(source: string): Span {
	return { ...nowhere, source }
}

function manifest(
	id: string,
	overrides: Partial<TestManifestEntry> = {},
): TestManifestEntry {
	return {
		id,
		name: id,
		interpolated: false,
		row: null,
		suitePath: [],
		tags: [],
		focused: false,
		skipped: null,
		benchmark: false,
		cases: null,
		// The id doubles as the key here the way it doubles as the name:
		// a spec that cares about the real spelling overrides it.
		key: id,
		position: nowhere,
		keywordPosition: nowhere,
		...overrides,
	}
}

function module(
	tests: Array<TestManifestEntry>,
	run: (context: TestContext) => void,
	spans: Array<Span> = [],
): TestModule {
	return { module: "/Season.es", spans, tests, run }
}

async function collect(registry: ReturnType<typeof registryOf>): Promise<{
	events: Array<TestEvent>
	summary: Awaited<ReturnType<typeof runTests>>
}> {
	let events: Array<TestEvent> = []
	let summary = await runTests(registry, {
		sink: (event) => events.push(event),
		now: () => 0,
	})

	return { events, summary }
}

function kinds(events: Array<TestEvent>): Array<string> {
	return events.map((event) => event.kind)
}

describe("The test registry", () => {
	test("indexes every Module's tests by structural id", () => {
		let first = module([manifest("/a"), manifest("/b")], () => {})
		let second = module([manifest("/c")], () => {})
		let registry = registryOf([first, second])

		expect(registry.tests.map((entry) => entry.entry.id)).toEqual([
			"/a",
			"/b",
			"/c",
		])
		expect(registry.byId.get("/b")?.index).toBe(1)
		expect(registry.byId.get("/c")?.index).toBe(0)
		expect(registry.byId.get("/c")?.module).toBe(second)
	})

	test("answers with no test where nothing registered", () => {
		expect(registryOf([]).tests).toEqual([])
	})
})

describe("The per-test context", () => {
	test("runs only the entry its index names", () => {
		let ran: Array<number> = []
		let context = createContext(1)

		entry(context, 0, null, () => {
			ran.push(0)
		})
		entry(context, 1, null, () => {
			ran.push(1)
		})
		entry(context, 2, null, () => {
			ran.push(2)
		})

		expect(ran).toEqual([1])
	})

	test("records an interpolated name whether or not the test runs", () => {
		let context = createContext(-1)

		entry(context, 0, string("2–0 is a win"), () => {})
		entry(context, 1, null, () => {})

		expect(context.names.get(0)).toBe("2–0 is a win")
		expect(context.names.has(1)).toBe(false)
	})

	test("answers with the very value it traced", () => {
		let context = createContext(0)
		let value = integer(19)

		expect(trace(context, 3, value)).toBe(value)
		expect(context.traces).toEqual([{ point: 3, value }])
	})

	test("drains the trace buffer into the assertion that evaluated it", () => {
		let context = createContext(0)

		trace(context, 1, integer(19))
		trace(context, 2, integer(16))
		expected(context, 0, false, null)
		trace(context, 4, integer(3))
		expected(context, 3, true, null)

		expect(context.traces).toEqual([])
		expect(
			context.expectations.map((expectation) =>
				expectation.traces.map((entry) => entry.point),
			),
		).toEqual([[1, 2], [4]])
	})

	test("resolves a comparison's operands out of the traces", () => {
		let context = createContext(0)
		let left = integer(3)
		let right = integer(2)

		trace(context, 1, left)
		trace(context, 2, right)
		expected(context, 0, false, { kind: "is", left: 1, right: 2 })

		expect(context.expectations[0]?.comparison).toEqual({
			kind: "is",
			left,
			right,
		})
	})

	test("lets the test carry on past a require that held", () => {
		let context = createContext(0)

		required(context, 0, true, null)

		expect(
			context.expectations.map((expectation) => expectation.form),
		).toEqual(["require"])
	})

	test("unwinds the test at a require that did not hold", () => {
		let context = createContext(0)
		let ended = false

		try {
			required(context, 0, false, null)
		} catch {
			ended = true
		}

		expect(ended).toBe(true)
		expect(context.expectations[0]).toMatchObject({
			form: "require",
			passed: false,
		})
	})

	// Measurement batches turn recording off, but a failed `require` still ends
	// the run.
	test("writes nothing down while recording is off, but still unwinds", () => {
		let context = createContext(0)

		context.recording = false
		trace(context, 1, integer(3))
		probe(context, 2, integer(4))
		expected(context, 0, false, null)

		let ended = false

		try {
			required(context, 3, false, null)
		} catch {
			ended = true
		}

		expect(ended).toBe(true)
		expect(context.traces).toEqual([])
		expect(context.probes).toEqual([])
		expect(context.expectations).toEqual([])
	})

	test("keeps a probed value out of the assertion that followed it", () => {
		let context = createContext(0)
		let value = integer(19)

		expect(probe(context, 5, value)).toBe(value)
		expected(context, 0, true, null)

		expect(context.probes).toEqual([{ point: 5, value }])
		expect(context.expectations[0]?.traces).toEqual([])
	})
})

describe("The structural diff", () => {
	test("says nothing about two equal values", () => {
		expect(structuralDiff(integer(1), integer(1))).toEqual([])
	})

	test("says nothing where an operand was never recorded", () => {
		expect(structuralDiff(undefined, integer(1))).toEqual([])
	})

	test("renders two scalars as the pair they are", () => {
		expect(structuralDiff(integer(3), integer(2))).toEqual([
			{ kind: "left", text: "3" },
			{ kind: "right", text: "2" },
		])
	})

	test("walks a Record member by member", () => {
		let left = createRecord({ team: string("Lions"), points: integer(19) })
		let right = createRecord({ team: string("Lions"), points: integer(16) })

		expect(structuralDiff(left, right)).toEqual([
			{ kind: "same", text: "{" },
			{ kind: "same", text: '    team = "Lions",' },
			{ kind: "left", text: "    points = 19," },
			{ kind: "right", text: "    points = 16," },
			{ kind: "same", text: "}" },
		])
	})

	test("names a member only one of them has", () => {
		let left = createRecord({ team: string("Lions") })
		let right = createRecord({ points: integer(16) })

		expect(structuralDiff(left, right)).toEqual([
			{ kind: "same", text: "{" },
			{ kind: "left", text: '    team = "Lions",' },
			{ kind: "right", text: "    points = 16," },
			{ kind: "same", text: "}" },
		])
	})

	test("walks a List index by index", () => {
		let left = createList([integer(1), integer(2)])
		let right = createList([integer(1), integer(3)])

		expect(structuralDiff(left, right)).toEqual([
			{ kind: "same", text: "[" },
			{ kind: "same", text: "    1," },
			{ kind: "left", text: "    2," },
			{ kind: "right", text: "    3," },
			{ kind: "same", text: "]" },
		])
	})

	// A Dictionary is diffed by key: a moved value shows under its key, and a key
	// one side lacks gets a line of its own.
	test("walks a Dictionary key by key", () => {
		let left = dictionary(
			["team", string("Lions")],
			["points", integer(19)],
		)
		let right = dictionary(
			["team", string("Lions")],
			["points", integer(16)],
		)

		expect(structuralDiff(left, right)).toEqual([
			{ kind: "same", text: "[" },
			{ kind: "same", text: '    "team" = "Lions",' },
			{ kind: "left", text: '    "points" = 19,' },
			{ kind: "right", text: '    "points" = 16,' },
			{ kind: "same", text: "]" },
		])
	})

	test("names a Dictionary key only one of them holds", () => {
		let left = dictionary(["team", string("Lions")])
		let right = dictionary(["points", integer(16)])

		expect(structuralDiff(left, right)).toEqual([
			{ kind: "same", text: "[" },
			{ kind: "left", text: '    "team" = "Lions",' },
			{ kind: "right", text: '    "points" = 16,' },
			{ kind: "same", text: "]" },
		])
	})

	test("walks the payload of two Cases carrying the same tag", () => {
		let left = caseValue("Optional#Value", { item: integer(1) })
		let right = caseValue("Optional#Value", { item: integer(2) })

		expect(structuralDiff(left, right)).toEqual([
			{ kind: "same", text: "Optional#Value {" },
			{ kind: "left", text: "    item = 1," },
			{ kind: "right", text: "    item = 2," },
			{ kind: "same", text: "}" },
		])
	})

	test("reads two differing tags as the pair they are", () => {
		let left = caseValue("Optional#Value", { item: integer(1) })
		let right = caseValue("Optional#Empty")

		expect(structuralDiff(left, right)).toEqual([
			{ kind: "left", text: "Optional#Value(1)" },
			{ kind: "right", text: "Optional#Empty" },
		])
	})

	// The tag carries its Module, but a report says `Shape#Square`, so a snapshot
	// survives a file rename. The walk's own bracket and its whole-value fallback
	// must agree.
	test("names a Program's own Case without its Module", () => {
		let left = caseValue("./Shapes.es#Shape#Square", { side: integer(1) })
		let right = caseValue("./Shapes.es#Shape#Square", { side: integer(2) })

		expect(structuralDiff(left, right)).toEqual([
			{ kind: "same", text: "Shape#Square {" },
			{ kind: "left", text: "    side = 1," },
			{ kind: "right", text: "    side = 2," },
			{ kind: "same", text: "}" },
		])

		expect(
			structuralDiff(left, caseValue("./Shapes.es#Shape#Blank")),
		).toEqual([
			{ kind: "left", text: "Shape#Square(1)" },
			{ kind: "right", text: "Shape#Blank" },
		])
	})

	test("descends into a nested Record", () => {
		let left = createRecord({
			home: createRecord({ team: string("Lions"), goals: integer(2) }),
		})
		let right = createRecord({
			home: createRecord({ team: string("Lions"), goals: integer(1) }),
		})

		expect(structuralDiff(left, right)).toEqual([
			{ kind: "same", text: "{" },
			{ kind: "same", text: "    home = {" },
			{ kind: "same", text: '        team = "Lions",' },
			{ kind: "left", text: "        goals = 2," },
			{ kind: "right", text: "        goals = 1," },
			{ kind: "same", text: "    }," },
			{ kind: "same", text: "}" },
		])
	})
})

describe("Selection", () => {
	test("runs everything where nothing is focused or tagged", async () => {
		let registry = registryOf([
			module([manifest("/a"), manifest("/b")], () => {}),
		])
		let { selections, focused } = await selectTests(registry)

		expect(focused).toBe(false)
		expect(selections.map((selection) => selection.state)).toEqual([
			"run",
			"run",
		])
	})

	test("runs only the focused tests while one exists", async () => {
		let registry = registryOf([
			module(
				[manifest("/a"), manifest("/b", { focused: true })],
				() => {},
			),
		])
		let { selections, focused } = await selectTests(registry)

		expect(focused).toBe(true)
		expect(selections[0]).toEqual({
			test: registry.tests[0]!,
			state: "deselected",
			reason: "not-focused",
		})
		expect(selections[1]?.state).toBe("run")
	})

	test("reports a skipped test with its reason before anything else", async () => {
		let registry = registryOf([
			module(
				[
					manifest("/a", { skipped: "waiting on the redesign" }),
					manifest("/b", { focused: true }),
				],
				() => {},
			),
		])
		let { selections } = await selectTests(registry)

		expect(selections[0]).toEqual({
			test: registry.tests[0]!,
			state: "skip",
			reason: "waiting on the redesign",
		})
	})

	test("does not count a skipped test as a focused one", async () => {
		let registry = registryOf([
			module(
				[
					manifest("/a"),
					manifest("/b", { focused: true, skipped: "later" }),
				],
				() => {},
			),
		])

		expect((await selectTests(registry)).focused).toBe(false)
	})

	test("selects by tag, and lets a skipped tag win over a named one", async () => {
		let registry = registryOf([
			module(
				[
					manifest("/a", { tags: ["slow"] }),
					manifest("/b", { tags: ["slow", "network"] }),
					manifest("/c", { tags: ["fast"] }),
				],
				() => {},
			),
		])
		let { selections } = await selectTests(registry, {
			tags: ["slow"],
			skipTags: ["network"],
		})

		expect(
			selections.map((selection) =>
				selection.state === "deselected"
					? selection.reason
					: selection.state,
			),
		).toEqual(["run", "tag", "tag"])
	})

	// A filter may name what a reader saw, the rendered name, and the source
	// template still matches.
	test("filters on the name a run renders", async () => {
		let registry = registryOf([
			module(
				[
					manifest("/a", {
						name: "{scored}–{conceded} is a win",
						interpolated: true,
					}),
					manifest("/b"),
				],
				(context) => {
					entry(context, 0, string("2–0 is a win"), () => {})
				},
			),
		])
		let rendered = await selectTests(registry, { filter: "2–0" })
		let template = await selectTests(registry, { filter: "{scored}" })
		let neither = await selectTests(registry, { filter: "3–1" })

		expect(rendered.selections[0]?.state).toBe("run")
		expect(rendered.matched).toBe(1)
		expect(template.selections[0]?.state).toBe("run")
		expect(neither.selections[0]?.state).toBe("deselected")
		expect(neither.matched).toBe(0)
	})

	test("filters on the name template", async () => {
		let registry = registryOf([
			module(
				[manifest("/a", { name: "the leader" }), manifest("/b")],
				() => {},
			),
		])
		let { selections } = await selectTests(registry, { filter: "leader" })

		expect(
			selections.map((selection) =>
				selection.state === "deselected"
					? selection.reason
					: selection.state,
			),
		).toEqual(["run", "filter"])
	})

	// Two suites may hold tests of one name, so the suite path joined by `/`
	// names exactly one.
	test("filters on the suite path joined to the name", async () => {
		let registry = registryOf([
			module(
				[
					manifest("/a", {
						name: "builds a thousand",
						suitePath: ["Record keys"],
					}),
					manifest("/b", {
						name: "builds a thousand",
						suitePath: ["Choice keys"],
					}),
					manifest("/c", {
						name: "looks a thousand up",
						suitePath: ["Choice keys"],
					}),
				],
				() => {},
			),
		])
		let states = async (filter: string) =>
			(await selectTests(registry, { filter })).selections.map(
				(selection) => selection.state,
			)

		expect(await states("Choice keys/builds a thousand")).toEqual([
			"deselected",
			"run",
			"deselected",
		])
		expect(await states("Choice keys")).toEqual([
			"deselected",
			"run",
			"run",
		])
		expect(await states("builds a thousand")).toEqual([
			"run",
			"run",
			"deselected",
		])
	})

	test("filters on the suite path joined to the name a run renders", async () => {
		let registry = registryOf([
			module(
				[
					manifest("/a", {
						name: "{scored}–{conceded}",
						interpolated: true,
						suitePath: ["wins"],
					}),
					manifest("/b", { name: "2–0", suitePath: ["draws"] }),
				],
				(context) => {
					entry(context, 0, string("2–0"), () => {})
				},
			),
		])
		let { selections, matched } = await selectTests(registry, {
			filter: "wins/2–0",
		})

		expect(selections.map((selection) => selection.state)).toEqual([
			"run",
			"deselected",
		])
		expect(matched).toBe(1)
	})

	// Rows share their suites and name, so only a row's key tells them apart,
	// and row 1's key does not pick row 10.
	test("filters on the whole key a row is stored under", async () => {
		let registry = registryOf([
			module(
				[0, 1, 10].map((row) =>
					manifest(`/doubles/${row}`, {
						name: "doubles",
						row,
						suitePath: ["sizes"],
						key: `sizes/doubles/${row}`,
					}),
				),
				() => {},
			),
		])
		let states = async (filter: string) =>
			(await selectTests(registry, { filter })).selections.map(
				(selection) => selection.state,
			)

		expect(await states("sizes/doubles/0")).toEqual([
			"run",
			"deselected",
			"deselected",
		])
		expect(await states("sizes/doubles/1")).toEqual([
			"deselected",
			"run",
			"deselected",
		])
		expect(await states("sizes/doubles")).toEqual(["run", "run", "run"])
	})

	// A key escapes a `/` inside a step, and the plain spelling still
	// matches the joined names.
	test("filters on the key of a name holding a slash", async () => {
		let registry = registryOf([
			module(
				[
					manifest("/a", {
						name: "per km/h",
						suitePath: ["speeds"],
						key: "speeds/per km\\/h",
					}),
					manifest("/b"),
				],
				() => {},
			),
		])
		let states = async (filter: string) =>
			(await selectTests(registry, { filter })).selections.map(
				(selection) => selection.state,
			)

		expect(await states("speeds/per km\\/h")).toEqual(["run", "deselected"])
		expect(await states("speeds/per km/h")).toEqual(["run", "deselected"])
	})
})

describe("The event stream", () => {
	test("brackets a passing run with run-start and run-end", async () => {
		let registry = registryOf([
			module([manifest("/a")], (context) => {
				entry(context, 0, null, () => {
					expected(context, 0, true, null)
				})
			}),
		])
		let { events, summary } = await collect(registry)

		expect(kinds(events)).toEqual([
			"run-start",
			"test-start",
			"expect",
			"test-pass",
			"run-end",
		])
		expect(events[0]).toEqual({
			schema: 1,
			kind: "run-start",
			tests: 1,
			focused: false,
		})
		expect(summary).toEqual({
			passed: 1,
			failed: 0,
			skipped: 0,
			deselected: 0,
			duration: 0,
			focused: false,
			failedIds: [],
		})
	})

	test("reports one probe per point, with the last value it held", async () => {
		let registry = registryOf([
			module(
				[manifest("/a")],
				(context) => {
					entry(context, 0, null, () => {
						probe(context, 0, integer(1))
						probe(context, 0, integer(2))
						probe(context, 1, string("last"))
						expected(context, 2, true, null)
					})
				},
				[span("count"), span("word"), span("expect")],
			),
		])
		let { events } = await collect(registry)
		let probes = events.filter((event) => event.kind === "probe")

		expect(probes).toEqual([
			{
				schema: 1,
				kind: "probe",
				id: "/a",
				point: 0,
				span: span("count"),
				value: "2",
			},
			{
				schema: 1,
				kind: "probe",
				id: "/a",
				point: 1,
				span: span("word"),
				value: '"last"',
			},
		])
	})

	test("reports a probe of a test that failed as well", async () => {
		let registry = registryOf([
			module(
				[manifest("/a")],
				(context) => {
					entry(context, 0, null, () => {
						probe(context, 0, integer(7))
						expected(context, 1, false, null)
					})
				},
				[span("seven"), span("expect")],
			),
		])
		let { events } = await collect(registry)

		expect(kinds(events)).toEqual([
			"run-start",
			"test-start",
			"probe",
			"expect",
			"test-fail",
			"run-end",
		])
	})

	test("stamps every event with the schema version", async () => {
		let registry = registryOf([
			module([manifest("/a")], (context) => {
				entry(context, 0, null, () => expected(context, 0, true, null))
			}),
		])

		for (let event of (await collect(registry)).events) {
			expect(event.schema).toBe(1)
		}
	})

	test("carries a failure's values and span, resolved against the table", async () => {
		let registry = registryOf([
			module(
				[manifest("/a")],
				(context) => {
					entry(context, 0, null, () => {
						trace(context, 1, integer(19))
						expected(context, 0, false, null)
					})
				},
				[span("leader.points::is(2)"), span("leader.points")],
			),
		])
		let { events, summary } = await collect(registry)
		let failure = events.find((event) => event.kind === "test-fail")

		expect(summary.failed).toBe(1)
		expect(summary.failedIds).toEqual(["/a"])
		expect(failure).toMatchObject({
			id: "/a",
			expectations: 1,
			error: null,
			failures: [
				{
					form: "expect",
					span: { source: "leader.points::is(2)" },
					values: [
						{
							point: 1,
							span: { source: "leader.points" },
							value: "19",
						},
					],
					comparison: null,
				},
			],
		})
	})

	test("renders no value for an assertion that held", async () => {
		let registry = registryOf([
			module(
				[manifest("/a")],
				(context) => {
					entry(context, 0, null, () => {
						trace(context, 1, integer(19))
						expected(context, 0, true, null)
					})
				},
				[span("leader.points::is(19)"), span("leader.points")],
			),
		])
		let recorded = (await collect(registry)).events.find(
			(event) => event.kind === "expect",
		)

		expect(recorded).toMatchObject({ passed: true, values: [] })
	})

	test("diffs the two operands of a failed comparison", async () => {
		let registry = registryOf([
			module(
				[manifest("/a")],
				(context) => {
					entry(context, 0, null, () => {
						trace(context, 1, integer(3))
						trace(context, 2, integer(2))
						expected(context, 0, false, {
							kind: "is",
							left: 1,
							right: 2,
						})
					})
				},
				[span("a::is(b)"), span("a"), span("b")],
			),
		])
		let recorded = (await collect(registry)).events.find(
			(event) => event.kind === "expect",
		)

		expect(recorded).toMatchObject({
			comparison: {
				kind: "is",
				left: "3",
				right: "2",
				diff: [
					{ kind: "left", text: "3" },
					{ kind: "right", text: "2" },
				],
			},
		})
	})

	test("reports a skipped test with its reason and runs nothing", async () => {
		let ran = false
		let registry = registryOf([
			module([manifest("/a", { skipped: "not yet" })], (context) => {
				entry(context, 0, null, () => {
					ran = true
				})
			}),
		])
		let { events, summary } = await collect(registry)

		expect(ran).toBe(false)
		expect(summary.skipped).toBe(1)
		expect(events.find((event) => event.kind === "test-skip")).toEqual({
			schema: 1,
			kind: "test-skip",
			row: null,
			id: "/a",
			name: "/a",
			suitePath: [],
			module: "/Season.es",
			reason: "not yet",
		})
	})

	test("counts a deselected test rather than failing it", async () => {
		let registry = registryOf([
			module([manifest("/a", { tags: ["slow"] })], () => {}),
		])
		let events: Array<TestEvent> = []
		let summary = await runTests(registry, {
			sink: (event) => events.push(event),
			now: () => 0,
			filters: { skipTags: ["slow"] },
		})

		expect(summary).toMatchObject({ passed: 0, failed: 0, deselected: 1 })
		expect(
			events.find((event) => event.kind === "test-deselected"),
		).toEqual({
			schema: 1,
			kind: "test-deselected",
			row: null,
			id: "/a",
			name: "/a",
			suitePath: [],
			module: "/Season.es",
			reason: "tag",
		})
	})

	test("fails a test whose body threw, and says what threw", async () => {
		let registry = registryOf([
			module([manifest("/a")], (context) => {
				entry(context, 0, null, () => {
					throw new Error("no such row")
				})
			}),
		])
		let { events, summary } = await collect(registry)
		let failure = events.find((event) => event.kind === "test-fail")

		expect(summary.failed).toBe(1)
		expect(failure?.kind === "test-fail" ? failure.error : null).toContain(
			"no such row",
		)
	})

	test("ends a test at a failed require without calling it an error", async () => {
		let reached = false
		let registry = registryOf([
			module([manifest("/a")], (context) => {
				entry(context, 0, null, () => {
					// The arrow stands for a `match` used as an Expression, emitted
					// as a Function an early return could not end.
					;(() => {
						required(context, 0, false, null)
					})()

					reached = true
				})
			}),
		])
		let { events, summary } = await collect(registry)
		let failure = events.find((event) => event.kind === "test-fail")

		expect(reached).toBe(false)
		expect(summary.failed).toBe(1)
		expect(failure).toMatchObject({ error: null })
		expect(
			failure?.kind === "test-fail" ? failure.failures : [],
		).toHaveLength(1)
	})

	test("renders an interpolated name from the enumeration pass", async () => {
		let registry = registryOf([
			module(
				[
					manifest("/a", {
						name: "{scored}–{conceded} is a win",
						interpolated: true,
					}),
				],
				(context) => {
					entry(context, 0, string("2–0 is a win"), () => {
						expected(context, 0, true, null)
					})
				},
			),
		])
		let started = (await collect(registry)).events.find(
			(event) => event.kind === "test-start",
		)

		expect(started).toMatchObject({ name: "2–0 is a win" })
	})

	// A brace is an ordinary character in a plain name. Reading it as a hole
	// would evaluate the whole section once for nothing.
	test("does not enumerate a Module whose names only look interpolated", async () => {
		let evaluations = 0
		let registry = registryOf([
			module(
				[manifest("/a", { name: "handles { braces" })],
				(context) => {
					evaluations += 1
					entry(context, 0, null, () => {
						expected(context, 0, true, null)
					})
				},
			),
		])
		let started = (await collect(registry)).events.find(
			(event) => event.kind === "test-start",
		)

		expect(evaluations).toBe(1)
		expect(started).toMatchObject({ name: "handles { braces" })
	})

	test("keeps a test's output to that test", async () => {
		let registry = registryOf([
			module([manifest("/a"), manifest("/b")], (context) => {
				entry(context, 0, null, () => {
					context.output.push({ stream: "output", text: "first\n" })
				})
				entry(context, 1, null, () => {
					context.output.push({ stream: "error", text: "second\n" })
				})
			}),
		])
		let output = (await collect(registry)).events.filter(
			(event) => event.kind === "output",
		)

		expect(output).toEqual([
			{
				schema: 1,
				kind: "output",
				id: "/a",
				stream: "output",
				text: "first\n",
			},
			{
				schema: 1,
				kind: "output",
				id: "/b",
				stream: "error",
				text: "second\n",
			},
		])
	})
})

// A clock that ticks a fixed amount per run of the body and not between runs.
// So a measurement is exact arithmetic, and the assertions are about the runner.
function workClock(milliseconds: number): {
	clock: () => number
	tick: () => void
} {
	let now = 0

	return {
		clock: () => now,
		tick: () => {
			now += milliseconds
		},
	}
}

type BenchmarkEvent = Extract<TestEvent, { kind: "benchmark" }>

async function measure(
	registry: ReturnType<typeof registryOf>,
	options: {
		clock: () => number
		filters?: Parameters<typeof runTests>[1]["filters"]
		benchmarks?: Parameters<typeof runTests>[1]["benchmarks"]
		update?: boolean
		coverage?: boolean
	},
): Promise<{
	events: Array<TestEvent>
	measured: Array<BenchmarkEvent>
	summary: Awaited<ReturnType<typeof runTests>>
}> {
	let events: Array<TestEvent> = []
	let summary = await runTests(registry, {
		sink: (event) => events.push(event),
		now: () => 0,
		clock: options.clock,
		filters: options.filters,
		benchmarks: options.benchmarks,
		update: options.update,
		coverage: options.coverage,
	})

	return {
		events,
		measured: events.filter(
			(event): event is BenchmarkEvent => event.kind === "benchmark",
		),
		summary,
	}
}

// A benchmark whose body costs one tick. Calibration doubles until a batch
// takes five milliseconds, eight runs, so a measurement is one million
// nanoseconds.
function benchmarkModule(
	tick: () => void,
	overrides: Partial<TestManifestEntry> = {},
): TestModule {
	return module(
		[
			manifest("/bench", {
				benchmark: true,
				key: "doubling",
				...overrides,
			}),
		],
		(context) => {
			benchmark(context, 0, null, () => {
				tick()
				expected(context, 0, true, null)
			})
		},
	)
}

describe("Benchmarks", () => {
	test("is left out of a run that did not ask to measure", async () => {
		let { clock } = workClock(1)
		let registry = registryOf([
			module(
				[manifest("/a"), manifest("/bench", { benchmark: true })],
				() => {},
			),
		])
		let { selections } = await selectTests(registry)

		expect(selections[0]?.state).toBe("run")
		expect(selections[1]).toEqual({
			test: registry.tests[1]!,
			state: "deselected",
			reason: "bench",
		})
		expect((await measure(registry, { clock })).measured).toEqual([])
	})

	test("measures it where the run asked, and keeps running the tests", async () => {
		let { clock, tick } = workClock(1)
		let registry = registryOf([
			benchmarkModule(tick),
			module([manifest("/a")], (context) => {
				entry(context, 0, null, () => {
					expected(context, 0, true, null)
				})
			}),
		])
		let { measured, summary } = await measure(registry, {
			clock,
			filters: { bench: true },
		})

		expect(measured).toHaveLength(1)
		expect(summary.passed).toBe(2)
		expect(summary.deselected).toBe(0)
	})

	// An editor runs a test by its id, and naming a benchmark asks for its
	// measurement without a flag.
	test("measures one somebody named, whatever the run asked for", async () => {
		let { clock, tick } = workClock(1)
		let registry = registryOf([benchmarkModule(tick)])
		let { measured } = await measure(registry, {
			clock,
			filters: { ids: ["/bench"] },
		})

		expect(measured.map((event) => event.status)).toEqual(["written"])
	})

	test("calibrates a batch and answers with the time of one run", async () => {
		let { clock, tick } = workClock(1)
		let { measured } = await measure(registryOf([benchmarkModule(tick)]), {
			clock,
			filters: { bench: true },
		})

		expect(measured[0]).toEqual({
			schema: 1,
			kind: "benchmark",
			id: "/bench",
			name: "/bench",
			module: "/Season.es",
			key: "doubling",
			nanoseconds: 1_000_000,
			iterations: 8,
			samples: 7,
			baseline: null,
			ratio: null,
			status: "written",
		})
	})

	test("records a measurement nothing had a baseline for", async () => {
		let { clock, tick } = workClock(1)
		let { measured, summary } = await measure(
			registryOf([benchmarkModule(tick)]),
			{ clock, filters: { bench: true } },
		)

		expect(measured[0]?.status).toBe("written")
		expect(summary.failed).toBe(0)
	})

	test("fails a measurement that ran away from its baseline", async () => {
		let { clock, tick } = workClock(1)
		let { events, measured, summary } = await measure(
			registryOf([benchmarkModule(tick)]),
			{
				clock,
				filters: { bench: true },
				benchmarks: { "/Season.es": { doubling: 500_000 } },
			},
		)

		expect(measured[0]).toMatchObject({
			status: "regressed",
			baseline: 500_000,
			ratio: 2,
		})
		expect(summary.failed).toBe(1)
		expect(summary.failedIds).toEqual(["/bench"])

		// A consumer ignores the `benchmark` kind it may not know, so the
		// failure event carries the reason in `error`.
		let failed = events.find((event) => event.kind === "test-fail")

		expect(failed).toMatchObject({ failures: [] })
		expect(
			(failed as Extract<TestEvent, { kind: "test-fail" }>).error,
		).toContain("slower than its baseline")
	})

	// The baseline stands until somebody moves it, or it would ratchet down to
	// whatever the fastest machine reached.
	test("passes a measurement that got faster, and says so", async () => {
		let { clock, tick } = workClock(1)
		let { measured, summary } = await measure(
			registryOf([benchmarkModule(tick)]),
			{
				clock,
				filters: { bench: true },
				benchmarks: { "/Season.es": { doubling: 2_000_000 } },
			},
		)

		expect(measured[0]).toMatchObject({ status: "improved", ratio: 0.5 })
		expect(summary.passed).toBe(1)
		expect(summary.failed).toBe(0)
	})

	test("says nothing about a measurement inside its band", async () => {
		let { clock, tick } = workClock(1)
		let { measured, summary } = await measure(
			registryOf([benchmarkModule(tick)]),
			{
				clock,
				filters: { bench: true },
				benchmarks: { "/Season.es": { doubling: 900_000 } },
			},
		)

		expect(measured[0]?.status).toBe("matched")
		expect(summary.passed).toBe(1)
	})

	test("records a measurement outside its band where it was told to", async () => {
		let { clock, tick } = workClock(1)
		let { measured, summary } = await measure(
			registryOf([benchmarkModule(tick)]),
			{
				clock,
				filters: { bench: true },
				benchmarks: { "/Season.es": { doubling: 500_000 } },
				update: true,
			},
		)

		expect(measured[0]).toMatchObject({ status: "written", ratio: 2 })
		expect(summary.failed).toBe(0)
	})

	// Timing a failing body would put a meaningless number in the baseline. The
	// body runs twice: once to be judged, and once to leave the recordings.
	test("reports a body that did not hold, and never times it", async () => {
		let { clock } = workClock(1)
		let ran = 0
		let registry = registryOf([
			module([manifest("/bench", { benchmark: true })], (context) => {
				benchmark(context, 0, null, () => {
					ran += 1
					expected(context, 0, false, null)
				})
			}),
		])
		let { events, measured, summary } = await measure(registry, {
			clock,
			filters: { bench: true },
		})

		expect(measured).toEqual([])
		expect(ran).toBe(2)
		expect(summary.failed).toBe(1)
		expect(events.filter((event) => event.kind === "expect")).toHaveLength(
			1,
		)
	})

	// Otherwise a focus would hide a project's tests behind a benchmark that never
	// runs.
	test("does not silence the tests with a focus nobody is running", async () => {
		let registry = registryOf([
			module(
				[
					manifest("/a"),
					manifest("/bench", { benchmark: true, focused: true }),
				],
				() => {},
			),
		])
		let plain = await selectTests(registry)
		let measuring = await selectTests(registry, { bench: true })

		expect(plain.focused).toBe(false)
		expect(plain.selections.map((selection) => selection.state)).toEqual([
			"run",
			"deselected",
		])
		expect(measuring.focused).toBe(true)
		expect(
			measuring.selections.map((selection) => selection.state),
		).toEqual(["deselected", "run"])
	})

	// Full sampling of a body that takes seconds would take a minute, past the
	// editor's session deadline.
	test("takes fewer samples of a body no batching helped", async () => {
		let { clock, tick } = workClock(300)
		let { measured } = await measure(registryOf([benchmarkModule(tick)]), {
			clock,
			filters: { bench: true },
		})

		expect(measured[0]).toMatchObject({
			iterations: 1,
			samples: 3,
			nanoseconds: 300_000_000,
		})
	})

	test("takes one sample of a body whose one run is the measurement", async () => {
		let { clock, tick } = workClock(1_200)
		let { measured } = await measure(registryOf([benchmarkModule(tick)]), {
			clock,
			filters: { bench: true },
		})

		expect(measured[0]).toMatchObject({ iterations: 1, samples: 1 })
	})

	// Under coverage a measurement would time the counters, and its baseline
	// would fail the next uninstrumented run. The body still runs once.
	test("runs a benchmark once, unmeasured, under coverage", async () => {
		let ran = 0
		let { clock } = workClock(1)
		let registry = registryOf([
			module([manifest("/bench", { benchmark: true })], (context) => {
				benchmark(context, 0, null, () => {
					ran += 1
					expected(context, 0, true, null)
				})
			}),
		])
		let { measured, summary } = await measure(registry, {
			clock,
			filters: { bench: true },
			coverage: true,
		})

		expect(measured).toEqual([])
		expect(ran).toBe(1)
		expect(summary.passed).toBe(1)
	})

	// The rows share one body and one key, so each row needs a stored entry of
	// its own.
	test("keeps one stored entry per row of a table benchmark", async () => {
		let { clock, tick } = workClock(1)
		let registry = registryOf([
			module(
				[
					manifest("/rows/0", {
						benchmark: true,
						row: 0,
						key: "sorts {size} rows/0",
					}),
					manifest("/rows/1", {
						benchmark: true,
						row: 1,
						key: "sorts {size} rows/1",
					}),
				],
				(context) => {
					benchmarkRows(
						context,
						0,
						[integer(1), integer(2)],
						null,
						() => {
							tick()
							expected(context, 0, true, null)
						},
					)
				},
			),
		])
		let { measured } = await measure(registry, {
			clock,
			filters: { bench: true },
			benchmarks: {
				"/Season.es": { "sorts {size} rows/1": 500_000 },
			},
		})

		expect(measured.map((event) => [event.key, event.status])).toEqual([
			["sorts {size} rows/0", "written"],
			["sorts {size} rows/1", "regressed"],
		])
	})
})

// The counters as emitted JavaScript uses them: one call per Module answers a
// Function, called wherever control arrives.
describe("The coverage counters", () => {
	// `counters` keeps every Module it registers until the process ends, so a
	// test run again finds its own registration last.
	const point = (line: number, overrides = {}) => ({
		kind: "statement" as const,
		label: "",
		scope: "",
		position: {
			start: { line, column: 1 },
			end: { line, column: 9 },
		},
		refinement: false,
		tag: null,
		...overrides,
	})

	test("counts a point every time control arrives at it", () => {
		let count = counters({
			module: "/Counted.es",
			points: [point(1), point(2)],
			choices: [],
		})

		count(0)
		count(0)
		count(1)

		let report = coverage().findLast(
			(each) => each.module === "/Counted.es",
		)

		expect(report?.points.map((each) => each.count)).toEqual([2, 1])
	})

	// A point touched at load belongs to no test's span. `beginCoverageRun`
	// freezes those as the baseline, and the report names them, since an edit
	// there could move a test that read the load-time result.
	test("names the points a Module ran at load", () => {
		let count = counters({
			module: "/Loaded.es",
			points: [point(1), point(2), point(3)],
			choices: [],
		})

		count(0)
		count(2)
		beginCoverageRun()

		let report = coverage().findLast((each) => each.module === "/Loaded.es")

		expect(report?.loaded).toEqual([0, 2])
	})

	// A span resets, so what a case reaches counts from the start of its own
	// test.
	test("counts a span's new ground once, however often it is walked", () => {
		let count = counters({
			module: "/Stamped.es",
			points: [point(1), point(2)],
			choices: [],
		})

		beginCoverageSpan()
		count(0)

		expect(touchedGround()).toBe(1)

		count(0)
		count(0)

		expect(touchedGround()).toBe(1)

		count(1)

		expect(touchedGround()).toBe(2)

		// A new span starts from nothing, so the same points are new ground again.
		beginCoverageSpan()

		expect(touchedGround()).toBe(0)

		count(0)

		expect(touchedGround()).toBe(1)
	})

	// The run copies the counts around each test and reports the points that
	// moved, only where asked, since the copy is every counter.
	test("says which points each test touched, where the run asked", async () => {
		let count = counters({
			module: "/Attributed.es",
			points: [point(1), point(2), point(3)],
			choices: [],
		})
		let one = module(
			[manifest("/first"), manifest("/second")],
			(context) => {
				entry(context, 0, null, () => {
					count(0)
					expected(context, 0, true, null)
				})
				entry(context, 1, null, () => {
					count(1)
					count(2)
					expected(context, 0, true, null)
				})
			},
		)
		let events: Array<TestEvent> = []

		await runTests(registryOf([one]), {
			sink: (event) => events.push(event),
			now: () => 0,
			coverageByTest: true,
		})

		let attributed = events.filter(
			(event) =>
				event.kind === "test-coverage" &&
				event.module === "/Attributed.es",
		) as Array<Extract<TestEvent, { kind: "test-coverage" }>>

		expect(attributed.map((event) => [event.id, event.points])).toEqual([
			["/first", [0]],
			["/second", [1, 2]],
		])
	})

	test("attributes nothing where nobody asked", async () => {
		let count = counters({
			module: "/Unasked.es",
			points: [point(1)],
			choices: [],
		})
		let one = module([manifest("/only")], (context) => {
			entry(context, 0, null, () => {
				count(0)
				expected(context, 0, true, null)
			})
		})
		let { events } = await collect(registryOf([one]))

		expect(
			events.filter((event) => event.kind === "test-coverage"),
		).toEqual([])
	})

	test("answers with the very value it was handed", () => {
		let count = counters({
			module: "/Answering.es",
			points: [point(1, { kind: "construction", tag: "Colour#Red" })],
			choices: [],
		})
		let value = integer(7)

		expect(count(0, value)).toBe(value)
	})

	test("is queryable from a running test's context", async () => {
		let count = counters({
			module: "/Asked.es",
			points: [point(1)],
			choices: [],
		})
		// A holder, since TypeScript would narrow a bare binding and does not
		// follow the write inside the closure.
		let seen: { count: number | undefined } = { count: undefined }
		let one = module([manifest("/asks")], (context) => {
			entry(context, 0, null, () => {
				count(0)
				seen.count = context
					.coverage()
					.findLast(
						(each) => each.module === "/Asked.es",
					)?.points[0]?.count
			})
		})

		await runTests(registryOf([one]), { sink: () => {}, now: () => 0 })

		// Asked from inside the running test.
		expect(seen.count).toBe(1)
	})

	test("writes a coverage event per Module, only where it was asked", async () => {
		counters({
			module: "/Reported.es",
			points: [point(1)],
			choices: [
				{ name: "Colour", cases: ["Colour#Red"], position: nowhere },
			],
		})

		let one = module([manifest("/a")], (context) => {
			entry(context, 0, null, () => {})
		})
		let silent: Array<TestEvent> = []
		let loud: Array<TestEvent> = []

		await runTests(registryOf([one]), {
			sink: (event) => silent.push(event),
			now: () => 0,
		})
		await runTests(registryOf([one]), {
			sink: (event) => loud.push(event),
			now: () => 0,
			coverage: true,
		})

		expect(kinds(silent)).not.toContain("coverage")

		let reported = loud.filter((event) => event.kind === "coverage")

		expect(reported.length).toBeGreaterThan(0)
		expect(reported.some((event) => event.module === "/Reported.es")).toBe(
			true,
		)
		// Before `run-end`, so a consumer folding the stream has every count.
		expect(kinds(loud).indexOf("coverage")).toBeLessThan(
			kinds(loud).indexOf("run-end"),
		)
	})

	test("starts a second run where loading the Module left it", () => {
		let count = counters({
			module: "/Twice.es",
			points: [point(1), point(2)],
			choices: [],
		})
		let countsOf = () =>
			coverage()
				.findLast((each) => each.module === "/Twice.es")
				?.points.map((each) => each.count)

		// What a Module's top-level Statements did as it was evaluated.
		count(0)

		beginCoverageRun()
		count(1)

		expect(countsOf()).toEqual([1, 1])

		beginCoverageRun()

		// The load's count survives and the run's does not, since a Module is
		// evaluated once however often its tests run.
		expect(countsOf()).toEqual([1, 0])
	})
})

describe("Terminal capture", () => {
	test("hands what a Program writes to the sink installed around it", () => {
		let captured: Array<[string, string]> = []

		withOutputSink(
			(text, stream) => captured.push([stream, text]),
			() => {
				write(string("hello"), outputStream)
				inspect(createBoolean(true))
			},
		)

		expect(captured).toEqual([
			["output", "hello"],
			["output", "true\n"],
		])
	})

	test("puts the binding back when the call it wrapped is over", () => {
		let captured: Array<string> = []

		withOutputSink(
			(text) => captured.push(text),
			() => {
				withOutputSink(null, () => {})
				write(string("inner"), outputStream)
			},
		)

		expect(captured).toEqual(["inner"])
	})
})

// Stages a host input holding `text`, as Deno's, while the run waits. A read
// the runner left unstaged reaches it rather than this process's descriptor.
async function withHostInput<Value>(
	text: string,
	run: () => Promise<Value>,
): Promise<Value> {
	let host = globalThis as { Deno?: unknown }
	let previous = Object.getOwnPropertyDescriptor(host, "Deno")
	let unread: Uint8Array | null = new TextEncoder().encode(text)

	host.Deno = {
		stdin: {
			readSync: (into: Uint8Array) => {
				if (unread === null) {
					return null
				}

				let count = unread.length

				into.set(unread)
				unread = null

				return count
			},
		},
	}

	try {
		return await withInputSource(null, run)
	} finally {
		if (previous === undefined) {
			delete host.Deno
		} else {
			Object.defineProperty(host, "Deno", previous)
		}
	}
}

function lineOf(answer: ReturnType<typeof readLine>): string | null {
	return answer[typeKeySymbol] === "Optional#Empty" ? null : answer.item.value
}

describe("Terminal input", () => {
	test("hands every test an empty input, whatever the host holds", async () => {
		let seen: Array<string | null> = []
		let registry = registryOf([
			module(
				[
					manifest("/a", { name: "read {line}", interpolated: true }),
					manifest("/b"),
				],
				async (context) => {
					let line = lineOf(readLine()) ?? "nothing"

					entry(context, 0, string(`read ${line}`), () => {
						seen.push(lineOf(readLine()))
					})

					// A read after the test's own wait, where a source
					// put back when the call returned would no longer apply.
					await entry(context, 1, null, async () => {
						await Promise.resolve()

						seen.push(lineOf(readLine()))
					})
				},
			),
		])
		let { events } = await withHostInput("alpha\nbeta\ngamma\n", () =>
			collect(registry),
		)

		expect(
			events.find((event) => event.kind === "test-start"),
		).toMatchObject({ name: "read nothing" })
		expect(seen).toEqual([null, null])
	})
})

describe("The made-up seed", () => {
	// `--seed` reads back eight hexadecimal characters, so the format is pinned.
	test("answers eight hexadecimal characters", () => {
		expect(randomSeed()).toMatch(/^[0-9a-f]{8}$/)
	})
})

// The failing-example corpus, driven as emitted JavaScript drives it: a
// property test calls `properties`, and stored failures are a member of
// `RunOptions`.
describe("The failing-example corpus", () => {
	const integers: Generator = { kind: "integer" }
	const whole = (digits: string) =>
		({ kind: "integer", value: digits }) as const

	function wholeOf(value: AnyType): bigint {
		return BigInt((value as unknown as { value: number | bigint }).value)
	}

	// One property test whose body decides whether the case held, so that no
	// assertion depends on which value was drawn.
	function property(
		holds: (value: AnyType) => boolean,
		options: {
			overrides?: Partial<TestManifestEntry>
			parameter?: PropertyParameter
			seen?: Array<AnyType>
		} = {},
	): TestModule {
		let parameter = options.parameter ?? {
			name: "n",
			generator: integers,
		}

		return module(
			[
				manifest("/a", {
					name: "stays small",
					key: "stays small",
					...options.overrides,
				}),
			],
			(context) => {
				properties(context, 0, null, [parameter], (value) => {
					options.seen?.push(value!)
					expected(context, 0, holds(value!), null)
				})
			},
		)
	}

	async function runWith(
		one: TestModule,
		options: Partial<RunOptions> = {},
	): Promise<Array<TestEvent>> {
		let events: Array<TestEvent> = []

		await runTests(registryOf([one]), {
			sink: (event) => events.push(event),
			now: () => 0,
			seed: "deadbeef",
			cases: 5,
			...options,
		})

		return events
	}

	function reported(
		events: Array<TestEvent>,
	): Extract<TestEvent, { kind: "property" }> {
		let event = events.find((each) => each.kind === "property")

		expect(event).toBeDefined()

		return event as Extract<TestEvent, { kind: "property" }>
	}

	function corpus(entries: CorpusStore): Record<string, CorpusStore> {
		return { "/Season.es": entries }
	}

	// A stored counterexample is asked first, so a regression is caught before
	// any randomness is spent.
	test("re-runs a stored counterexample before it draws anything", async () => {
		let seen: Array<AnyType> = []
		let events = await runWith(
			property(() => false, { seen }),
			{
				counterexamples: corpus({
					"stays small": [
						{ values: [{ name: "n", data: whole("500") }] },
					],
				}),
			},
		)

		expect(reported(events)).toMatchObject({
			cases: 0,
			replayed: 1,
			stale: [],
			fromCorpus: true,
		})
		expect(wholeOf(seen[0]!)).toBe(500n)
		expect(kinds(events)).toContain("test-fail")
	})

	// Still shrunk, since the code may now fail on something smaller than what
	// was stored.
	test("shrinks a replayed failure the way it shrinks a drawn one", async () => {
		let events = await runWith(
			property(() => false),
			{
				counterexamples: corpus({
					"stays small": [
						{ values: [{ name: "n", data: whole("500") }] },
					],
				}),
			},
		)

		expect(reported(events).counterexample).toEqual([
			{ name: "n", value: "0" },
		])
	})

	test("draws its cases where every stored counterexample holds", async () => {
		let events = await runWith(
			property(() => true),
			{
				counterexamples: corpus({
					"stays small": [
						{ values: [{ name: "n", data: whole("500") }] },
					],
				}),
			},
		)

		expect(reported(events)).toMatchObject({
			cases: 5,
			replayed: 1,
			stale: [],
			fromCorpus: false,
			counterexample: null,
			encoded: null,
		})
		expect(kinds(events)).toContain("test-pass")
	})

	test("runs the stored cases in the order they were stored", async () => {
		let seen: Array<AnyType> = []

		await runWith(
			property(() => true, { seen }),
			{
				cases: 0,
				counterexamples: corpus({
					"stays small": [
						{ values: [{ name: "n", data: whole("7") }] },
						{ values: [{ name: "n", data: whole("9") }] },
					],
				}),
			},
		)

		expect(seen.map(wholeOf)).toEqual([7n, 9n])
	})

	// A Parameter that is a String now held an Integer when the entry was stored,
	// so the runner drops the entry rather than failing.
	test("says which stored entries no longer read back", async () => {
		let events = await runWith(
			property(() => true, {
				parameter: { name: "n", generator: { kind: "string" } },
			}),
			{
				counterexamples: corpus({
					"stays small": [
						{ values: [{ name: "n", data: whole("500") }] },
						{
							values: [
								{
									name: "n",
									data: { kind: "string", value: "held" },
								},
							],
						},
					],
				}),
			},
		)

		expect(reported(events)).toMatchObject({
			cases: 5,
			replayed: 1,
			stale: [0],
			fromCorpus: false,
		})
	})

	test("refuses a stored entry whose Parameters are no longer these", async () => {
		let events = await runWith(
			property(() => true),
			{
				counterexamples: corpus({
					"stays small": [
						{ values: [{ name: "count", data: whole("1") }] },
						{ values: [] },
						{
							values: [
								{ name: "n", data: whole("1") },
								{ name: "m", data: whole("2") },
							],
						},
					],
				}),
			},
		)

		expect(reported(events)).toMatchObject({
			replayed: 0,
			stale: [0, 1, 2],
		})
	})

	test("writes the shrunk counterexample down on a fresh failure", async () => {
		let event = reported(await runWith(property(() => false)))

		expect(event).toMatchObject({ fromCorpus: false, replayed: 0 })
		expect(event.encoded).toEqual([{ name: "n", data: whole("0") }])
		expect(decode(integers, event.encoded![0]!.data)).toEqual(
			createInteger(0n),
		)
	})

	// A Namespace's generator says how to build a value, not what it is made of.
	// So one such Parameter leaves the whole test without a corpus.
	test("writes nothing down for a Parameter a Namespace generates", async () => {
		let event = reported(
			await runWith(
				property(() => false, {
					parameter: {
						name: "team",
						generator: {
							kind: "generated",
							name: "Team",
							generate: () => string("Lions"),
							shrink: () => createList([]),
						},
					},
				}),
			),
		)

		expect(event.counterexample).toEqual([
			{ name: "team", value: '"Lions"' },
		])
		expect(event.encoded).toBeNull()
	})

	// The key is read off the Compiler's manifest, so the escaping lives in one
	// place.
	test("names an entry by the key the Compiler spelled for it", async () => {
		let event = reported(
			await runWith(
				property(() => true, {
					overrides: { key: "table/a\\/b/2" },
				}),
			),
		)

		expect(event.module).toBe("/Season.es")
		expect(event.key).toBe("table/a\\/b/2")
	})

	// An entry's own budget loses to an explicit `--cases` and beats the default.
	test("runs an entry's own case budget unless the run named one", async () => {
		let budgeted = property(() => true, { overrides: { cases: 7 } })

		expect(
			reported(await runWith(budgeted, { cases: undefined })),
		).toMatchObject({ cases: 7, requested: 7 })
		expect(reported(await runWith(budgeted, { cases: 3 }))).toMatchObject({
			cases: 3,
			requested: 3,
		})
	})

	test("replays nothing where the run was told about nothing", async () => {
		expect(reported(await runWith(property(() => true)))).toMatchObject({
			cases: 5,
			replayed: 0,
			stale: [],
			fromCorpus: false,
		})
	})
})

// The coverage-guided search. A bundle that counts nothing never fills the
// pool, so the Modules here compare with and without guidance and no flag.
describe("The coverage-guided search", () => {
	const integers: Generator = { kind: "integer" }

	function wholeOf(value: AnyType): bigint {
		return BigInt((value as unknown as { value: number | bigint }).value)
	}

	// Guards are residues, so how often one holds does not depend on the size a
	// case was drawn at.
	const MODULUS = 60n

	function residue(value: AnyType, wanted: bigint): boolean {
		return ((wholeOf(value) % MODULUS) + MODULUS) % MODULUS === wanted
	}

	function coveragePoint(kind: "statement" | "branch") {
		return {
			kind,
			label: "",
			scope: "",
			position: nowhere,
			refinement: false,
			tag: null,
		} as const
	}

	// Fails only where both Parameters are inside narrow guards. `instrumented`
	// registers counters, and `gated` makes the counted point depend on a value,
	// which is what tells the search a case reached somewhere new.
	function pairing(options: {
		instrumented: boolean
		gated: boolean
		guardsA?: (value: AnyType) => boolean
	}): TestModule {
		let guardsA = options.guardsA ?? ((value) => residue(value, 13n))
		let count = options.instrumented
			? counters({
					module: "/Guided.es",
					points: [
						coveragePoint("statement"),
						coveragePoint("branch"),
					],
					choices: [],
				})
			: null

		return module([manifest("/pair", { key: "pair" })], (context) => {
			properties(
				context,
				0,
				null,
				[
					{ name: "a", generator: integers },
					{ name: "b", generator: integers },
				],
				(a, b) => {
					count?.(0)

					if (count !== null && options.gated && guardsA(a!)) {
						count(1)
					}

					required(
						context,
						0,
						!(guardsA(a!) && residue(b!, 41n)),
						null,
					)
				},
			)
		})
	}

	// At this seed and budget the guided search finds the conjunction and neither
	// control does. Any change to what the search draws, or its order, moves the
	// pinned counts.
	const SEED = "4e93e921"
	const BUDGET = 1200

	async function search(
		one: TestModule,
		options: Partial<RunOptions> = {},
	): Promise<{ found: boolean; cases: number; events: Array<TestEvent> }> {
		let events: Array<TestEvent> = []

		await runTests(registryOf([one]), {
			sink: (event) => events.push(event),
			now: () => 0,
			seed: SEED,
			cases: BUDGET,
			...options,
		})

		let event = events.find((each) => each.kind === "property") as
			| Extract<TestEvent, { kind: "property" }>
			| undefined

		return {
			found: event !== undefined && event.counterexample !== null,
			cases: event?.cases ?? -1,
			events,
		}
	}

	// Counting alone is not guidance: only a counter that depends on a value
	// fills the pool. Asserted through the outcome, since nothing exports the
	// pool.
	test("fills its pool only where a case reached new ground", async () => {
		let guided = await search(pairing({ instrumented: true, gated: true }))
		let ungated = await search(
			pairing({ instrumented: true, gated: false }),
		)

		expect(guided.found).toBe(true)
		expect(guided.cases).toBe(476)
		expect(ungated.found).toBe(false)
		expect(ungated.cases).toBe(BUDGET)
	})

	// The same property in a Module that counts and in one that does not, with
	// the same seed, budget and generators.
	test("finds a conjunction the blind search does not, at one seed", async () => {
		let guided = await search(pairing({ instrumented: true, gated: true }))
		let blind = await search(pairing({ instrumented: false, gated: false }))

		expect(guided.found).toBe(true)
		expect(guided.cases).toBe(476)
		expect(blind.found).toBe(false)
		expect(blind.cases).toBe(BUDGET)
	})

	// A replayed value that reaches new ground seeds the pool. The guard on `a`
	// is a value no draw answers, so only the replay can seed it.
	test("searches around a stored value that broke new ground", async () => {
		let narrow = () =>
			pairing({
				instrumented: true,
				gated: true,
				guardsA: (value) => wholeOf(value) === 12345n,
			})
		let corpus = {
			"/Season.es": {
				pair: [
					{
						values: [
							{
								name: "a",
								data: { kind: "integer", value: "12345" },
							} as const,
							{
								name: "b",
								data: { kind: "integer", value: "0" },
							} as const,
						],
					},
				],
			},
		}
		let seeded = await search(narrow(), {
			seed: "2fedcba2",
			counterexamples: corpus,
		})
		let control = await search(narrow(), { seed: "2fedcba2" })

		expect(seeded.found).toBe(true)
		expect(seeded.cases).toBe(510)
		// Without the corpus nothing draws the guarded value, so the conjunction
		// is never met.
		expect(control.found).toBe(false)
		expect(control.cases).toBe(BUDGET)
	})

	// The coin, the pick and the neighbour draw from the test's seeded source, so
	// `--seed` replays a guided run exactly.
	test("draws the same guided run twice for one seed", async () => {
		let first = await search(pairing({ instrumented: true, gated: true }))
		let again = await search(pairing({ instrumented: true, gated: true }))

		expect(first.events).toEqual(again.events)
	})
})
