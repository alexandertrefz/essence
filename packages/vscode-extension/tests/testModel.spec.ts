import { describe, expect, it } from "bun:test"

import {
	applyBatch,
	commandFor,
	type CoveragePoint,
	coverageLinesOf,
	coverageOf,
	type CoverageSummary,
	createState,
	declarationsOf,
	describeCoverage,
	decorationsOf,
	describeBatch,
	type Failure,
	failedIdsOf,
	fileKey,
	foldEvents,
	forgetFile,
	messagesOf,
	outputOf,
	uncoveredLinesOf,
	type Span,
	suiteKey,
	tagsOf,
	TEST_RUN_VERSION,
	type TestEvent,
	type TestRunNotification,
	type TestSite,
	treeOf,
} from "../testModel.js"

// NOTE: Everything the Test Explorer decides, without an extension host. What
// `testView.js` adds is VS Code objects — a TestItem, a TestRun, a decoration —
// and nothing it adds decides anything, which is why this file can stand in for
// a walkthrough nobody can automate.

const FILE = "/repo/Season.tests.es"

function span(
	line: number,
	column = 3,
	endColumn = 20,
	source = "total::is(5)",
): Span {
	return {
		start: { line, column },
		end: { line, column: endColumn },
		source,
	}
}

function site(overrides: Partial<TestSite> = {}): TestSite {
	let name = overrides.name ?? "adds up"
	let suitePath = overrides.suitePath ?? []
	let file = overrides.file ?? FILE

	return {
		// NOTE: Spelled exactly as the Compiler spells a structural id, because
		// the whole point of a suite's id is that it is the prefix of these.
		id: suiteKey(file, [...suitePath, name]),
		name,
		suitePath,
		file,
		range: {
			start: { line: 2, column: 2 },
			end: { line: 6, column: 3 },
		},
		keywordRange: {
			start: { line: 2, column: 2 },
			end: { line: 2, column: 6 },
		},
		tags: [],
		focused: false,
		skipped: null,
		...overrides,
	}
}

function batch(
	overrides: Partial<TestRunNotification> = {},
): TestRunNotification {
	return {
		version: TEST_RUN_VERSION,
		run: 1,
		kind: "end",
		reason: "change",
		files: [FILE],
		ids: [],
		events: [],
		sites: [],
		counts: { passed: 0, failed: 0, skipped: 0, deselected: 0 },
		duration: 12,
		compiled: true,
		...overrides,
	}
}

function started(
	id: string,
	name: string,
	suitePath: Array<string> = [],
): TestEvent {
	return {
		schema: 1,
		kind: "test-start",
		id,
		name,
		suitePath,
		module: FILE,
	}
}

function passed(id: string, name: string): TestEvent {
	return {
		schema: 1,
		kind: "test-pass",
		id,
		name,
		duration: 4,
		expectations: 1,
	}
}

function failed(id: string, name: string, failures: Array<Failure>): TestEvent {
	return {
		schema: 1,
		kind: "test-fail",
		id,
		name,
		duration: 7,
		expectations: 1,
		failures,
		error: null,
	}
}

function failure(overrides: Partial<Failure> = {}): Failure {
	return {
		form: "expect",
		span: span(4),
		values: [],
		comparison: null,
		...overrides,
	}
}

describe("folding an event batch", () => {
	it("reads a state per test out of the stream", () => {
		let records = foldEvents([
			started("a", "adds up"),
			passed("a", "adds up"),
			started("b", "subtracts"),
			failed("b", "subtracts", [failure()]),
			{
				schema: 1,
				kind: "test-skip",
				id: "c",
				name: "waits",
				suitePath: [],
				module: FILE,
				reason: "the network is not here",
			},
			{
				schema: 1,
				kind: "test-deselected",
				id: "d",
				name: "elsewhere",
				suitePath: [],
				module: FILE,
				reason: "not-focused",
			},
			{
				schema: 1,
				kind: "test-deselected",
				id: "e",
				name: "tagged out",
				suitePath: [],
				module: FILE,
				reason: "tag",
			},
		])

		expect(records.map((record) => [record.id, record.state])).toEqual([
			["a", "passed"],
			["b", "failed"],
			["c", "skipped"],
			["d", "not-focused"],
			["e", "deselected"],
		])
	})

	// NOTE: The event stream is versioned separately from the payload, so a
	// batch may carry a kind this extension has never heard of. Ignoring the
	// event is the rule; ignoring the batch would lose everything beside it.
	it("ignores an event kind it does not know", () => {
		// NOTE: Carrying a field no version of this client has a name for,
		// which is half of what tolerating an unknown kind means.
		let coverage = { schema: 1, kind: "coverage", id: "a", lines: [1, 2] }
		let records = foldEvents([
			started("a", "adds up"),
			coverage,
			passed("a", "adds up"),
		])

		expect(records).toHaveLength(1)
		expect(records[0].state).toBe("passed")
	})

	it("keeps a test's own captured output", () => {
		let [record] = foldEvents([
			started("a", "adds up"),
			{
				schema: 1,
				kind: "output",
				id: "a",
				stream: "output",
				text: "one\n",
			},
			{
				schema: 1,
				kind: "output",
				id: "a",
				stream: "output",
				text: "two\n",
			},
			passed("a", "adds up"),
		])

		expect(outputOf(record)).toBe("one\ntwo\n")
	})
})

describe("applying a batch", () => {
	it("ignores a payload version it does not understand", () => {
		let state = createState()

		expect(applyBatch(state, batch({ version: 99 }))).toBeNull()
		expect([...state.files.keys()]).toEqual([])
	})

	it("changes nothing on a start, and says what is about to run", () => {
		let state = createState()
		let applied = applyBatch(state, batch({ kind: "start" }))

		expect(applied!.kind).toBe("start")
		expect(applied!.changed).toEqual([])
		expect([...state.files.keys()]).toEqual([])
	})

	it("replaces what it holds for every file the batch covered", () => {
		let state = createState()
		let one = site({ name: "adds up" })

		applyBatch(
			state,
			batch({
				sites: [one],
				events: [started(one.id, one.name), passed(one.id, one.name)],
			}),
		)

		let two = site({ name: "subtracts" })

		applyBatch(
			state,
			batch({
				run: 2,
				sites: [two],
				events: [started(two.id, two.name), passed(two.id, two.name)],
			}),
		)

		expect(treeOf(state, FILE).map((node) => node.label)).toEqual([
			"subtracts",
		])
	})

	// NOTE: The case a half-typed line produces, and the reason this rule
	// exists at all: an Explorer that empties itself between keystrokes is an
	// Explorer nobody can read.
	it("keeps a file the batch found nothing for and could not compile", () => {
		let state = createState()
		let one = site()

		applyBatch(
			state,
			batch({
				sites: [one],
				events: [started(one.id, one.name), passed(one.id, one.name)],
			}),
		)
		applyBatch(state, batch({ run: 2, compiled: false }))

		expect(treeOf(state, FILE)).toHaveLength(1)
		expect(state.files.get(FILE)!.stale).toBe(true)
	})

	it("empties a file that compiled and holds no test any more", () => {
		let state = createState()
		let one = site()

		applyBatch(
			state,
			batch({
				sites: [one],
				events: [started(one.id, one.name), passed(one.id, one.name)],
			}),
		)
		applyBatch(state, batch({ run: 2 }))

		expect(treeOf(state, FILE)).toEqual([])
	})

	// NOTE: A Run lens over one test reports a deselection for every other test
	// of that file. Adopting those would turn "run this one" into "forget the
	// rest".
	it("merges a batch that was narrowed to some of a file's tests", () => {
		let state = createState()
		let one = site({ name: "adds up" })
		let two = site({ name: "subtracts" })

		applyBatch(
			state,
			batch({
				sites: [one, two],
				events: [
					started(one.id, one.name),
					failed(one.id, one.name, [failure()]),
					started(two.id, two.name),
					passed(two.id, two.name),
				],
			}),
		)
		applyBatch(
			state,
			batch({
				run: 2,
				ids: [one.id],
				sites: [one, two],
				events: [
					started(one.id, one.name),
					passed(one.id, one.name),
					{
						schema: 1,
						kind: "test-deselected",
						id: two.id,
						name: two.name,
						suitePath: [],
						module: FILE,
						reason: "filter",
					},
				],
			}),
		)

		expect(
			treeOf(state, FILE).map((node) => [node.label, node.state]),
		).toEqual([
			["adds up", "passed"],
			["subtracts", "passed"],
		])
	})

	it("attributes a Module that never named itself to the only file that ran", () => {
		let state = createState()
		let one = site()

		applyBatch(
			state,
			batch({
				sites: [one],
				events: [
					{ ...started(one.id, one.name), module: null },
					passed(one.id, one.name),
				],
			}),
		)

		expect(treeOf(state, FILE)[0].state).toBe("passed")
	})

	it("forgets a file outright when it is asked to", () => {
		let state = createState()

		applyBatch(state, batch({ sites: [site()] }))

		expect(forgetFile(state, FILE)).toBe(true)
		expect([...state.files.keys()]).toEqual([])
	})
})

describe("the tree", () => {
	it("nests suites and keeps the order they were written in", () => {
		let state = createState()
		let inner = site({ name: "waits", suitePath: ["slow", "network"] })
		let middle = site({ name: "retries", suitePath: ["slow"] })
		let outer = site({ name: "is quick" })

		applyBatch(state, batch({ sites: [inner, middle, outer] }))

		let [suite, quick] = treeOf(state, FILE)

		expect(suite.kind).toBe("suite")
		expect(suite.label).toBe("slow")
		expect(quick.label).toBe("is quick")
		expect(suite.children.map((node) => node.label)).toEqual([
			"network",
			"retries",
		])
		expect(suite.children[0].children.map((node) => node.label)).toEqual([
			"waits",
		])
	})

	// NOTE: A suite has no identity of its own — the runner never selects one —
	// so the client spells it the way the Compiler would have, which makes it
	// the prefix every id under it starts with.
	it("gives a suite the id every test under it starts with", () => {
		let state = createState()
		let inner = site({ name: "waits", suitePath: ["slow"] })

		applyBatch(state, batch({ sites: [inner] }))

		let [suite] = treeOf(state, FILE)

		expect(suite.id).toBe(suiteKey(FILE, ["slow"]))
		expect(inner.id.startsWith(`${suite.id}/`)).toBe(true)
		expect(fileKey(FILE)).toBe(suiteKey(FILE, []))
	})

	it("escapes a step that holds the separator", () => {
		expect(suiteKey("/repo/A.es", ["a/b"])).toBe("\\/repo\\/A.es/a\\/b")
	})

	// NOTE: An interpolated name is worked out where the test stands, so the
	// only name a test that never ran has is its template.
	it("shows the rendered name where a run reported one", () => {
		let state = createState()
		let one = site({ name: "row {index}" })

		applyBatch(
			state,
			batch({
				sites: [one],
				events: [started(one.id, "row 1"), passed(one.id, "row 1")],
			}),
		)

		expect(treeOf(state, FILE)[0].label).toBe("row 1")

		let bare = createState()

		applyBatch(bare, batch({ sites: [one] }))

		expect(treeOf(bare, FILE)[0].label).toBe("row {index}")
		expect(treeOf(bare, FILE)[0].state).toBe("unknown")
	})

	it("answers with every tag the workspace carries, and what failed", () => {
		let state = createState()
		let slow = site({ name: "waits", tags: ["slow", "network"] })
		let quick = site({ name: "is quick" })

		applyBatch(
			state,
			batch({
				sites: [slow, quick],
				events: [
					started(slow.id, slow.name),
					failed(slow.id, slow.name, [failure()]),
					started(quick.id, quick.name),
					passed(quick.id, quick.name),
				],
			}),
		)

		expect(tagsOf(state)).toEqual(["network", "slow"])
		expect(failedIdsOf(state)).toEqual([slow.id])
	})
})

describe("what a failure says", () => {
	it("writes the assertion and every sub-expression that explains it", () => {
		let [message] = messagesOf({
			property: null,
			failures: [
				failure({
					span: span(4, 3, 24, "total::is(5)"),
					values: [
						{ point: 0, span: span(4, 3, 8, "total"), value: "4" },
						{ point: 1, span: span(4, 14, 15, "5"), value: "5" },
						{
							point: 2,
							span: span(4, 3, 24, "total::is(5)"),
							value: "false",
						},
					],
				}),
			],
			error: null,
		})

		// NOTE: A literal traced as an operand renders to its own source, and
		// the assertion's own answer is what "this failed" already said. Both
		// would be a line the reader has to look past.
		expect(message.text).toBe(
			["expect total::is(5)", "  total = 4"].join("\n"),
		)
		expect(message.expected).toBeNull()
		expect(message.range!.start.line).toBe(4)
	})

	it("hands VS Code the two sides of an `is` to diff", () => {
		let [message] = messagesOf({
			property: null,
			failures: [
				failure({
					comparison: {
						kind: "is",
						left: "4",
						right: "5",
						diff: [
							{ kind: "left", text: "4" },
							{ kind: "right", text: "5" },
						],
					},
				}),
			],
			error: null,
		})

		expect(message.expected).toBe("5")
		expect(message.actual).toBe("4")
		expect(message.text).toContain("`is` compared 4 with 5")
		// NOTE: A difference over two scalars is the two of them, which the
		// line above has already said in full.
		expect(message.text).not.toContain("the difference")
	})

	// NOTE: "Expected" is a claim `isNot` never makes, and VS Code draws those
	// two fields as "expected this, got that".
	it("does not claim an expectation for an isNot", () => {
		let [message] = messagesOf({
			property: null,
			failures: [
				failure({
					comparison: {
						kind: "isNot",
						left: "4",
						right: "4",
						diff: [],
					},
				}),
			],
			error: null,
		})

		expect(message.expected).toBeNull()
		expect(message.text).toContain("`isNot` compared 4 with 4")
	})

	// NOTE: A snapshot is the one failure that IS a text difference, and the
	// pair VS Code draws as a diff is what was recorded against what this run
	// held. Saying `is` of them would claim the very thing that failed.
	it("explains a snapshot as a recording and a run", () => {
		let [message] = messagesOf({
			property: null,
			failures: [
				failure({
					comparison: {
						kind: "snapshot",
						left: "plain",
						right: "plainer",
						diff: [
							{ kind: "left", text: "plain" },
							{ kind: "right", text: "plainer" },
						],
					},
				}),
			],
			error: null,
		})

		expect(message.expected).toBe("plain")
		expect(message.actual).toBe("plainer")
		expect(message.text).toContain(
			"the recorded snapshot and this run differ",
		)
		expect(message.text).toContain("- plain")
		expect(message.text).toContain("+ plainer")
		expect(message.text).not.toContain("`snapshot` compared")
	})

	it("writes out a difference that walked into a Record", () => {
		let [message] = messagesOf({
			property: null,
			failures: [
				failure({
					comparison: {
						kind: "is",
						left: "{ width = 3 }",
						right: "{ width = 4 }",
						diff: [
							{ kind: "same", text: "{" },
							{ kind: "left", text: "  width = 3" },
							{ kind: "right", text: "  width = 4" },
							{ kind: "same", text: "}" },
						],
					},
				}),
			],
			error: null,
		})

		expect(message.text).toContain("- {   width = 3".slice(0, 1))
		expect(message.text).toContain("-   width = 3")
		expect(message.text).toContain("+   width = 4")
	})

	// NOTE: A test body that THREW is a Compiler or a runtime bug rather than a
	// failed assertion, and it has no span of its own.
	it("reports a thrown body against the test itself", () => {
		let messages = messagesOf({
			property: null,
			failures: [],
			error: "RangeError: out of range",
		})

		expect(messages).toHaveLength(1)
		expect(messages[0].range).toBeNull()
		expect(messages[0].text).toBe("RangeError: out of range")
	})

	it("drops a failure the lowering could not place", () => {
		expect(
			messagesOf({
				property: null,
				failures: [failure({ span: null })],
				error: null,
			}),
		).toEqual([])
	})
})

// NOTE: A property test's values are made up by the runner, so nothing in the
// source says what a failure failed FOR — which is why the batch carries them
// and the message says them.
describe("what a property test says", () => {
	function property(id: string, name: string): TestEvent {
		return {
			schema: 1,
			kind: "property",
			id,
			name,
			cases: 37,
			requested: 100,
			seed: "deadbeef",
			shrinks: 12,
			counterexample: [
				{ name: "scored", value: "0" },
				{ name: "conceded", value: "1" },
			],
		}
	}

	it("folds the run of cases onto the test it belongs to", () => {
		let [record] = foldEvents([
			started("a", "never lowers points"),
			property("a", "never lowers points"),
			failed("a", "never lowers points", [failure()]),
		])

		expect(record.property).toEqual({
			cases: 37,
			requested: 100,
			seed: "deadbeef",
			shrinks: 12,
			counterexample: [
				{ name: "scored", value: "0" },
				{ name: "conceded", value: "1" },
			],
		})
	})

	it("leaves an ordinary test with nothing", () => {
		let [record] = foldEvents([
			started("a", "adds up"),
			passed("a", "adds up"),
		])

		expect(record.property).toBeNull()
	})

	it("says the values a failure failed for, above the assertion", () => {
		let [message] = messagesOf({
			property: {
				cases: 37,
				requested: 100,
				seed: "deadbeef",
				shrinks: 12,
				counterexample: [{ name: "n", value: "500" }],
			},
			failures: [failure({ span: span(4, 3, 20, "double(n)") })],
			error: null,
		})

		expect(message.text.split("\n")).toEqual([
			"after 37 cases, shrunk to:",
			"  n = 500",
			"replay: essence test --seed deadbeef",
			"",
			"expect double(n)",
		])
	})

	it("says the values a thrown body threw on", () => {
		let [message] = messagesOf({
			property: {
				cases: 0,
				requested: 100,
				seed: "deadbeef",
				shrinks: 0,
				counterexample: [{ name: "n", value: "0" }],
			},
			failures: [],
			error: "RangeError: out of range",
		})

		expect(message.text).toContain("after 0 cases:")
		expect(message.text).toContain("RangeError: out of range")
	})
})

describe("what to draw in the gutter", () => {
	it("marks the lines of a test by what it last did", () => {
		let state = createState()
		let one = site({ name: "adds up" })
		let two = site({
			name: "waits",
			range: {
				start: { line: 8, column: 2 },
				end: { line: 9, column: 3 },
			},
		})

		applyBatch(
			state,
			batch({
				sites: [one, two],
				events: [
					started(one.id, one.name),
					failed(one.id, one.name, [failure({ span: span(4) })]),
					{
						schema: 1,
						kind: "test-skip",
						id: two.id,
						name: two.name,
						suitePath: [],
						module: FILE,
						reason: "no network here",
					},
				],
			}),
		)

		let marks = decorationsOf(state, FILE)

		expect(marks.failed).toEqual([{ start: 2, end: 6 }])
		expect(marks.skipped).toEqual([{ start: 8, end: 9 }])
		expect(marks.passed).toEqual([])
		// NOTE: The one line INSIDE the test that failed, which the test's own
		// mark could not point at.
		expect(marks.expects).toHaveLength(1)
		expect(marks.expects[0].range.start.line).toBe(4)
		expect(marks.expects[0].text).toContain("expect total::is(5)")
	})

	// NOTE: A test a tag or a filter left out did not fail and was not skipped
	// by anything the source says. Colouring its lines would be colour that
	// answers no question.
	it("leaves a test nobody selected unmarked", () => {
		let state = createState()
		let one = site()

		applyBatch(
			state,
			batch({
				sites: [one],
				events: [
					{
						schema: 1,
						kind: "test-deselected",
						id: one.id,
						name: one.name,
						suitePath: [],
						module: FILE,
						reason: "tag",
					},
				],
			}),
		)

		let marks = decorationsOf(state, FILE)

		expect(marks.passed).toEqual([])
		expect(marks.failed).toEqual([])
		expect(marks.skipped).toEqual([])
		expect(marks.notFocused).toEqual([])
	})

	it("marks a test the run silenced apart from one it skipped", () => {
		let state = createState()
		let one = site()

		applyBatch(
			state,
			batch({
				sites: [one],
				events: [
					{
						schema: 1,
						kind: "test-deselected",
						id: one.id,
						name: one.name,
						suitePath: [],
						module: FILE,
						reason: "not-focused",
					},
				],
			}),
		)

		expect(decorationsOf(state, FILE).notFocused).toEqual([
			{ start: 2, end: 6 },
		])
	})

	it("draws nothing for a file it has never heard of", () => {
		expect(decorationsOf(createState(), "/repo/Nothing.es")).toEqual({
			passed: [],
			failed: [],
			skipped: [],
			notFocused: [],
			expects: [],
		})
	})
})

describe("what to run instead of debugging", () => {
	it("names one test by a filter on its rendered name", () => {
		expect(
			commandFor([{ label: "adds up", file: "/repo/Season.tests.es" }]),
		).toBe('essence test Season.tests.es --filter "adds up"')
	})

	// NOTE: A filter that would match several tests is not what was asked for,
	// and neither is a suite's own name.
	it("runs everything for a selection that is not one test", () => {
		expect(commandFor([])).toBe("essence test")
		expect(
			commandFor([
				{ label: "adds up", file: FILE },
				{ label: "subtracts", file: FILE },
			]),
		).toBe("essence test")
	})
})

describe("the line the output channel writes", () => {
	it("says what the cycle covered and what it found", () => {
		expect(
			describeBatch(
				batch({
					run: 7,
					reason: "change",
					counts: {
						passed: 3,
						failed: 1,
						skipped: 0,
						deselected: 2,
					},
					duration: 84,
				}),
			),
		).toBe(
			"run 7 (change) · 1 file · 3 passed, 1 failed, 0 skipped, 2 not run · 84 ms",
		)
	})

	it("says when something would not compile", () => {
		expect(describeBatch(batch({ compiled: false }))).toContain(
			"something would not compile",
		)
	})
})

// #region Coverage

const SOURCE = "/repo/Season.es"

function point(overrides: Partial<CoveragePoint>): CoveragePoint {
	return {
		kind: "statement",
		label: "",
		scope: "",
		position: {
			start: { line: 1, column: 1 },
			end: { line: 1, column: 9 },
		},
		refinement: false,
		tag: null,
		count: 0,
		...overrides,
	}
}

function atLine(line: number, overrides: Partial<CoveragePoint>) {
	return point({
		...overrides,
		position: { start: { line, column: 1 }, end: { line, column: 9 } },
	})
}

function coverage(): CoverageSummary {
	return {
		files: [
			{
				module: SOURCE,
				lines: { covered: 2, total: 5 },
				branches: { covered: 1, total: 2 },
				cases: { covered: 0, total: 1 },
				missed: [],
				points: [
					atLine(3, { count: 2 }),
					atLine(4, { count: 0 }),
					atLine(5, { count: 0 }),
					atLine(7, { kind: "branch", label: "if", count: 2 }),
					atLine(7, { kind: "branch", label: "else", count: 0 }),
					atLine(9, {
						kind: "case",
						label: "case #Postponed",
						scope: "Standings::points",
						count: 0,
					}),
					atLine(11, {
						kind: "construction",
						label: "#Played",
						tag: "Fixture#Played",
						count: 3,
					}),
				],
			},
		],
		choices: [
			{
				name: "Fixture",
				module: SOURCE,
				position: {
					start: { line: 2, column: 1 },
					end: { line: 6, column: 2 },
				},
				cases: [
					{ tag: "Fixture#Played", constructed: true },
					{ tag: "Fixture#Forfeited", constructed: false },
				],
			},
		],
	}
}

describe("coverage on a batch", () => {
	it("lays a cycle's files over what it holds, keyed by module", () => {
		let state = createState()
		let applied = applyBatch(state, batch({ coverage: coverage() }))

		expect(applied?.covered).toEqual([SOURCE])
		expect(coverageOf(state, SOURCE)?.lines).toEqual({
			covered: 2,
			total: 5,
		})

		// NOTE: A cycle that counted a DIFFERENT file leaves this one standing
		// — which is the whole of why the files are laid over rather than
		// replaced: a cycle covers what a change reached and says nothing about
		// the rest.
		applyBatch(
			state,
			batch({
				run: 2,
				coverage: {
					files: [
						{
							module: "/repo/Other.es",
							lines: { covered: 1, total: 1 },
							branches: { covered: 0, total: 0 },
							cases: { covered: 0, total: 0 },
							missed: [],
							points: [],
						},
					],
					choices: [],
				},
			}),
		)

		expect(coverageOf(state, SOURCE)?.lines).toEqual({
			covered: 2,
			total: 5,
		})
		expect(coverageOf(state, "/repo/Other.es")).not.toBeNull()
		// NOTE: And the Choices ARE replaced, because the Server works out
		// which Cases anything built across the whole run and a client that
		// merged them would be working that answer out twice.
		expect(state.coverage.choices).toEqual([])
	})

	it("is left alone by a batch that carries none", () => {
		let state = createState()

		applyBatch(state, batch({ coverage: coverage() }))
		applyBatch(state, batch({ run: 2 }))

		expect(coverageOf(state, SOURCE)).not.toBeNull()
	})

	it("goes with a file that is forgotten", () => {
		let state = createState()

		applyBatch(state, batch({ coverage: coverage() }))
		forgetFile(state, SOURCE)

		expect(coverageOf(state, SOURCE)).toBeNull()
		expect(state.coverage.choices).toEqual([])
	})
})

describe("what a coverage view draws", () => {
	it("counts a line by the greatest of the points on it", () => {
		let file = coverage().files[0]!

		expect(
			coverageLinesOf(file).map((line) => [line.line, line.count]),
		).toEqual([
			[3, 2],
			[4, 0],
			[5, 0],
			[7, 2],
			[9, 0],
		])
	})

	it("hangs the branches of a line off the line they stand on", () => {
		let file = coverage().files[0]!
		let line = coverageLinesOf(file).find((each) => each.line === 7)

		expect(
			line?.branches.map((branch) => [branch.label, branch.count]),
		).toEqual([
			["if", 2],
			["else", 0],
		])
	})

	it("merges the lines nothing reached into runs", () => {
		let file = coverage().files[0]!

		expect(uncoveredLinesOf(file)).toEqual([
			{ start: 4, end: 5 },
			{ start: 9, end: 9 },
		])
	})

	it("answers every arm and every Case as a declaration", () => {
		let state = createState()

		applyBatch(state, batch({ coverage: coverage() }))

		expect(
			declarationsOf(state, SOURCE).map((each) => [
				each.name,
				each.count,
			]),
		).toEqual([
			["Standings::points › case #Postponed", 0],
			["Fixture#Played", 1],
			["Fixture#Forfeited", 0],
		])
	})

	it("says what it counted in one line", () => {
		expect(describeCoverage(coverage())).toBe(
			"coverage: 40% lines · 50% branches · 0/1 cases · 1 never constructed",
		)
	})

	it("says nothing about a run that counted nothing", () => {
		expect(describeCoverage({ files: [], choices: [] })).toBe("")
	})
})

// #endregion
