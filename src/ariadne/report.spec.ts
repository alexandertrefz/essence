// Port of ariadne's snapshot test suite (`src/report/tests.rs`). The
// expected outputs are taken verbatim from upstream, which is what makes the
// renderer port verifiable.

import { describe, expect, test } from "bun:test"

import { ColorGenerator, Config, Label, Report, Source, sources } from "./index"

function noColor(): Config {
	return new Config({ color: false })
}

// Mirrors upstream's `remove_trailing`; we additionally apply it to expected
// values so that significant trailing whitespace never has to survive
// copy/paste or formatters.
function removeTrailing(text: string): string {
	let lines = text.split("\n")

	if (lines[lines.length - 1] === "") {
		lines.pop()
	}

	return `${lines.map((line) => line.trimEnd()).join("\n")}\n`
}

// Strips the common leading tab indentation of a template literal, mirroring
// how insta treats indented snapshot strings.
function dedent(text: string): string {
	let lines = text.split("\n")

	if (lines.length > 0 && lines[0].trim() === "") {
		lines.shift()
	}
	while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
		lines.pop()
	}

	let tabCounts = lines
		.filter((line) => line.trim() !== "")
		.map((line) => (line.match(/^\t*/) as RegExpMatchArray)[0].length)
	let minimumTabs = tabCounts.length > 0 ? Math.min(...tabCounts) : 0

	return `${lines.map((line) => line.slice(minimumTabs).trimEnd()).join("\n")}\n`
}

function expectOutput(actual: string, expected: string): void {
	expect(removeTrailing(actual)).toBe(dedent(expected))
}

describe("ariadne report rendering", () => {
	test("one message", () => {
		let message = new Report({
			kind: "error",
			span: { start: 0, end: 0 },
			message: "can't compare apples with oranges",
			config: noColor(),
		}).render(Source.from(""))

		expectOutput(message, "Error: can't compare apples with oranges")
	})

	test("two labels without messages", () => {
		let source = "apple == orange;"
		let message = new Report({
			kind: "error",
			span: { start: 0, end: 0 },
			message: "can't compare apples with oranges",
			labels: [
				new Label({ start: 0, end: 5 }),
				new Label({ start: 9, end: 15 }),
			],
			config: noColor(),
		}).render(source)

		expectOutput(
			message,
			`
			Error: can't compare apples with oranges
			   ╭─┤ <unknown>:1:1 │
			   │
			 1 │ apple == orange;
			   │ ─────    ──────
			───╯
			`,
		)
	})

	test("two labels without messages on different lines", () => {
		let source = "apple\n== orange;"
		let message = new Report({
			kind: "error",
			span: { start: 0, end: 0 },
			message: "can't compare apples with oranges",
			labels: [
				new Label({ start: 0, end: 5 }),
				new Label({ start: 9, end: 15 }),
			],
			config: noColor(),
		}).render(source)

		expectOutput(
			message,
			`
			Error: can't compare apples with oranges
			   ╭─┤ <unknown>:1:1 │
			   │
			 1 │ apple
			   │ ─────
			 2 │ == orange;
			   │    ──────
			───╯
			`,
		)
	})

	test("two labels with messages", () => {
		let source = "apple == orange;"
		let message = new Report({
			kind: "error",
			span: { start: 0, end: 0 },
			message: "can't compare apples with oranges",
			labels: [
				new Label(
					{ start: 0, end: 5 },
					{ message: "This is an apple" },
				),
				new Label(
					{ start: 9, end: 15 },
					{ message: "This is an orange" },
				),
			],
			config: noColor(),
		}).render(source)

		expectOutput(
			message,
			`
			Error: can't compare apples with oranges
			   ╭─┤ <unknown>:1:1 │
			   │
			 1 │ apple == orange;
			   │ ──┬──    ───┬──
			   │   ╰─────────│──── This is an apple
			   │             │
			   │             ╰──── This is an orange
			───╯
			`,
		)
	})

	test("two labels with messages on different lines", () => {
		let source = "apple ==\norange;"
		let message = new Report({
			kind: "error",
			span: { start: 0, end: 0 },
			message: "can't compare apples with oranges",
			labels: [
				new Label(
					{ start: 0, end: 5 },
					{ message: "This is an apple" },
				),
				new Label(
					{ start: 9, end: 15 },
					{ message: "This is an orange" },
				),
			],
			config: noColor(),
		}).render(source)

		expectOutput(
			message,
			`
			Error: can't compare apples with oranges
			   ╭─┤ <unknown>:1:1 │
			   │
			 1 │ apple ==
			   │ ──┬──
			   │   ╰──── This is an apple
			 2 │ orange;
			   │ ───┬──
			   │    ╰──── This is an orange
			───╯
			`,
		)
	})

	test("duplicate label", () => {
		let source = "apple == orange;"
		let message = new Report({
			kind: "error",
			span: { start: 0, end: 0 },
			message: "can't compare apples with oranges",
			labels: [
				new Label(
					{ start: 0, end: 5 },
					{ message: "This is an apple" },
				),
				new Label(
					{ start: 0, end: 5 },
					{ message: "This is an apple" },
				),
			],
			config: noColor(),
		}).render(source)

		expectOutput(
			message,
			`
			Error: can't compare apples with oranges
			   ╭─┤ <unknown>:1:1 │
			   │
			 1 │ apple == orange;
			   │ ──┬──
			   │   ╰──── This is an apple
			   │   │
			   │   ╰──── This is an apple
			───╯
			`,
		)
	})

	test("multi byte chars", () => {
		let source = "äpplë == örängë;"
		let message = new Report({
			kind: "error",
			span: { start: 0, end: 0 },
			message: "can't compare äpplës with örängës",
			labels: [
				new Label(
					{ start: 0, end: 5 },
					{ message: "This is an äpplë" },
				),
				new Label(
					{ start: 9, end: 15 },
					{ message: "This is an örängë" },
				),
			],
			config: new Config({ color: false, indexType: "char" }),
		}).render(source)

		expectOutput(
			message,
			`
			Error: can't compare äpplës with örängës
			   ╭─┤ <unknown>:1:1 │
			   │
			 1 │ äpplë == örängë;
			   │ ──┬──    ───┬──
			   │   ╰─────────│──── This is an äpplë
			   │             │
			   │             ╰──── This is an örängë
			───╯
			`,
		)
	})

	test("utf16 label", () => {
		let source = "äpplë == örängë;"
		let message = new Report({
			kind: "error",
			span: { start: 0, end: 0 },
			message: "can't compare äpplës with örängës",
			labels: [
				new Label(
					{ start: 0, end: 5 },
					{ message: "This is an äpplë" },
				),
				new Label(
					{ start: 9, end: 15 },
					{ message: "This is an örängë" },
				),
			],
			config: new Config({ color: false, indexType: "utf16" }),
		}).render(source)

		expectOutput(
			message,
			`
			Error: can't compare äpplës with örängës
			   ╭─┤ <unknown>:1:1 │
			   │
			 1 │ äpplë == örängë;
			   │ ──┬──    ───┬──
			   │   ╰─────────│──── This is an äpplë
			   │             │
			   │             ╰──── This is an örängë
			───╯
			`,
		)
	})

	test("utf16 column", () => {
		let source = "äpplë == örängë;"
		let message = new Report({
			kind: "error",
			span: { start: 9, end: 9 },
			message: "can't compare äpplës with örängës",
			labels: [
				new Label(
					{ start: 0, end: 5 },
					{ message: "This is an äpplë" },
				),
				new Label(
					{ start: 9, end: 15 },
					{ message: "This is an örängë" },
				),
			],
			config: new Config({ color: false, indexType: "utf16" }),
		}).render(source)

		expectOutput(
			message,
			`
			Error: can't compare äpplës with örängës
			   ╭─┤ <unknown>:1:10 │
			   │
			 1 │ äpplë == örängë;
			   │ ──┬──    ───┬──
			   │   ╰─────────│──── This is an äpplë
			   │             │
			   │             ╰──── This is an örängë
			───╯
			`,
		)
	})

	test("crossing lines", () => {
		let source = "äpplë == örängë;"
		let message = new Report({
			kind: "error",
			span: { start: 11, end: 11 },
			message: "can't compare äpplës with örängës",
			labels: [
				new Label(
					{ start: 0, end: 5 },
					{ message: "This is an äpplë" },
				),
				new Label(
					{ start: 9, end: 15 },
					{ message: "This is an örängë" },
				),
			],
			config: new Config({ color: false, crossGap: false }),
		}).render(source)

		expectOutput(
			message,
			`
			Error: can't compare äpplës with örängës
			   ╭─┤ <unknown>:1:12 │
			   │
			 1 │ äpplë == örängë;
			   │ ──┬──    ───┬──
			   │   ╰─────────┼──── This is an äpplë
			   │             │
			   │             ╰──── This is an örängë
			───╯
			`,
		)
	})

	test("label at end of long line", () => {
		let source = `${"apple == ".repeat(100)}orange`
		let message = new Report({
			kind: "error",
			span: { start: 0, end: 0 },
			message: "can't compare apples with oranges",
			labels: [
				new Label(
					{ start: source.length - 6, end: source.length },
					{ message: "This is an orange" },
				),
			],
			config: noColor(),
		}).render(source)

		expectOutput(
			message,
			`
			Error: can't compare apples with oranges
			   ╭─┤ <unknown>:1:1 │
			   │
			 1 │ ${"apple == ".repeat(100)}orange
			   │ ${" ".repeat(900)}───┬──
			   │ ${" ".repeat(903)}╰──── This is an orange
			───╯
			`,
		)
	})

	test("label of width zero at end of line", () => {
		let source = "apple ==\n"
		let message = new Report({
			kind: "error",
			span: { start: 0, end: 0 },
			message: "unexpected end of file",
			labels: [
				new Label(
					{ start: 9, end: 9 },
					{ message: "Unexpected end of file" },
				),
			],
			config: new Config({ color: false, indexType: "utf16" }),
		}).render(source)

		expectOutput(
			message,
			`
			Error: unexpected end of file
			   ╭─┤ <unknown>:1:1 │
			   │
			 1 │ apple ==
			   │          │
			   │          ╰─ Unexpected end of file
			───╯
			`,
		)
	})

	test("empty input", () => {
		let message = new Report({
			kind: "error",
			span: { start: 0, end: 0 },
			message: "unexpected end of file",
			labels: [
				new Label({ start: 0, end: 0 }, { message: "No more fruit!" }),
			],
			config: noColor(),
		}).render("")

		expectOutput(
			message,
			`
			Error: unexpected end of file
			   ╭─┤ <unknown>:1:1 │
			   │
			 1 │
			   │ │
			   │ ╰─ No more fruit!
			───╯
			`,
		)
	})

	test("empty input help", () => {
		let message = new Report({
			kind: "error",
			span: { start: 0, end: 0 },
			message: "unexpected end of file",
			labels: [
				new Label({ start: 0, end: 0 }, { message: "No more fruit!" }),
			],
			helps: ["have you tried going to the farmer's market?"],
			config: noColor(),
		}).render("")

		expectOutput(
			message,
			`
			Error: unexpected end of file
			   ╭─┤ <unknown>:1:1 │
			   │
			 1 │
			   │ │
			   │ ╰─ No more fruit!
			   │
			   │ Help: have you tried going to the farmer's market?
			───╯
			`,
		)
	})

	test("empty input note", () => {
		let message = new Report({
			kind: "error",
			span: { start: 0, end: 0 },
			message: "unexpected end of file",
			labels: [
				new Label({ start: 0, end: 0 }, { message: "No more fruit!" }),
			],
			notes: ["eat your greens!"],
			config: noColor(),
		}).render("")

		expectOutput(
			message,
			`
			Error: unexpected end of file
			   ╭─┤ <unknown>:1:1 │
			   │
			 1 │
			   │ │
			   │ ╰─ No more fruit!
			   │
			   │ Note: eat your greens!
			───╯
			`,
		)
	})

	test("empty input help note", () => {
		let message = new Report({
			kind: "error",
			span: { start: 0, end: 0 },
			message: "unexpected end of file",
			labels: [
				new Label({ start: 0, end: 0 }, { message: "No more fruit!" }),
			],
			notes: ["eat your greens!"],
			helps: ["have you tried going to the farmer's market?"],
			config: noColor(),
		}).render("")

		expectOutput(
			message,
			`
			Error: unexpected end of file
			   ╭─┤ <unknown>:1:1 │
			   │
			 1 │
			   │ │
			   │ ╰─ No more fruit!
			   │
			   │ Help: have you tried going to the farmer's market?
			   │
			   │ Note: eat your greens!
			───╯
			`,
		)
	})

	test("utf16 spans never crash", () => {
		let source = "🍏pple\np\n\nempty\n"

		for (let i = 0; i <= source.length; i++) {
			for (let j = i; j <= source.length; j++) {
				new Report({
					kind: "error",
					span: { start: 0, end: 0 },
					message: "Label",
					labels: [
						new Label({ start: i, end: j }, { message: "Label" }),
					],
					config: new Config({ color: false, indexType: "utf16" }),
				}).render(source)
			}
		}
	})

	test("char spans never crash", () => {
		let source = "🍏pple\np\n\nempty\n"
		let charLength = [...source].length

		for (let i = 0; i <= charLength; i++) {
			for (let j = i; j <= charLength; j++) {
				new Report({
					kind: "error",
					span: { start: 0, end: 0 },
					message: "Label",
					labels: [
						new Label({ start: i, end: j }, { message: "Label" }),
					],
					config: noColor(),
				}).render(source)
			}
		}
	})

	test("multiline label", () => {
		let source = "apple\n==\norange"
		let message = new Report({
			kind: "error",
			span: { start: 0, end: 0 },
			labels: [
				new Label(
					{ start: 0, end: source.length },
					{ message: "illegal comparison" },
				),
			],
			config: noColor(),
		}).render(source)

		expectOutput(
			message,
			`
			Error:
			   ╭─┤ <unknown>:1:1 │
			   │
			 1 │ ╭─▶ apple
			   ┆ ┆
			 3 │ ├─▶ orange
			   │ │
			   │ ╰─────────── illegal comparison
			───╯
			`,
		)
	})

	test("multiple multilines same span", () => {
		let source = "apple\n==\norange"
		let message = new Report({
			kind: "error",
			span: { start: 0, end: 0 },
			labels: [
				new Label(
					{ start: 0, end: source.length },
					{ message: "illegal comparison" },
				),
				new Label(
					{ start: 0, end: source.length },
					{ message: "do not do this" },
				),
				new Label(
					{ start: 0, end: source.length },
					{ message: "please reconsider" },
				),
			],
			config: noColor(),
		}).render(source)

		expectOutput(
			message,
			`
			Error:
			   ╭─┤ <unknown>:1:1 │
			   │
			 1 │ ╭─────▶ apple
			   │ │       ▲
			   │ │ ╭─────╯
			   │ │ │     │
			   │ │ │ ╭───╯
			   ┆ ┆ ┆ ┆
			 3 │ ├─│─│─▶ orange
			   │ │ │ │        ▲
			   │ ╰─│─│────────│── illegal comparison
			   │   │ │        │
			   │   ╰─│────────┴── do not do this
			   │     │        │
			   │     ╰────────┴── please reconsider
			───╯
			`,
		)
	})

	test("multiline label show 6", () => {
		let source = "pear\napple\na\nb\nc\nd\norange\nbanana"
		let message = new Report({
			kind: "error",
			span: { start: 0, end: 0 },
			labels: [
				new Label(
					{ start: 5, end: 25 },
					{ message: "illegal comparison", showLines: 6 },
				),
			],
			config: noColor(),
		}).render(source)

		expectOutput(
			message,
			`
			Error:
			   ╭─┤ <unknown>:1:1 │
			   │
			 2 │ ╭─▶ apple
			 3 │ │   a
			 4 │ │   b
			 5 │ │   c
			 6 │ │   d
			 7 │ ├─▶ orange
			   │ │
			   │ ╰──────────── illegal comparison
			───╯
			`,
		)
	})

	test("multiline label longer than max span line count", () => {
		let source = "pear\napple\na\nb\nc\nd\norange\nbanana"
		let message = new Report({
			kind: "error",
			span: { start: 0, end: 0 },
			labels: [
				new Label(
					{ start: 5, end: source.length },
					{ message: "illegal comparison", showLines: 6 },
				),
			],
			config: noColor(),
		}).render(source)

		expectOutput(
			message,
			`
			Error:
			   ╭─┤ <unknown>:1:1 │
			   │
			 2 │ ╭─▶ apple
			   ┆ ┆
			 8 │ ├─▶ banana
			   │ │
			   │ ╰─────────── illegal comparison
			───╯
			`,
		)
	})

	test("multiline context label", () => {
		let source = "apple\nbanana\ncarrot\ndragonfruit\negg\nfruit\ngrapes"
		let message = new Report({
			kind: "error",
			span: { start: 0, end: 0 },
			labels: [
				new Label(
					{ start: 13, end: 35 },
					{ message: "illegal comparison" },
				),
			],
			config: new Config({ color: false, contextLines: 1 }),
		}).render(source)

		expectOutput(
			message,
			`
			Error:
			   ╭─┤ <unknown>:1:1 │
			   │
			 2 │     banana
			 3 │ ╭─▶ carrot
			 4 │ │   dragonfruit
			 5 │ ├─▶ egg
			   │ │
			   │ ╰───────── illegal comparison
			 6 │     fruit
			───╯
			`,
		)
	})

	test("partially overlapping labels", () => {
		let source = "https://example.com/"
		let message = new Report({
			kind: "error",
			span: { start: 0, end: 0 },
			labels: [
				new Label({ start: 0, end: source.length }, { message: "URL" }),
				new Label(
					{ start: 0, end: source.indexOf(":") },
					{ message: "scheme" },
				),
			],
			config: noColor(),
		}).render(source)

		expectOutput(
			message,
			`
			Error:
			   ╭─┤ <unknown>:1:1 │
			   │
			 1 │ https://example.com/
			   │ ──┬───────┬─────────
			   │   ╰───────│─────────── scheme
			   │           │
			   │           ╰─────────── URL
			───╯
			`,
		)
	})

	test("multiple labels same span", () => {
		let source = "apple == orange;"
		let message = new Report({
			kind: "error",
			span: { start: 0, end: 0 },
			message: "can't compare apples with oranges",
			labels: [
				new Label(
					{ start: 0, end: 5 },
					{ message: "This is an apple" },
				),
				new Label(
					{ start: 0, end: 5 },
					{ message: "Have I mentioned that this is an apple?" },
				),
				new Label(
					{ start: 0, end: 5 },
					{ message: "No really, have I mentioned that?" },
				),
				new Label(
					{ start: 9, end: 15 },
					{ message: "This is an orange" },
				),
				new Label(
					{ start: 9, end: 15 },
					{ message: "Have I mentioned that this is an orange?" },
				),
				new Label(
					{ start: 9, end: 15 },
					{ message: "No really, have I mentioned that?" },
				),
			],
			config: noColor(),
		}).render(source)

		expectOutput(
			message,
			`
			Error: can't compare apples with oranges
			   ╭─┤ <unknown>:1:1 │
			   │
			 1 │ apple == orange;
			   │ ──┬──    ───┬──
			   │   ╰─────────│──── This is an apple
			   │   │         │
			   │   ╰─────────│──── Have I mentioned that this is an apple?
			   │   │         │
			   │   ╰─────────│──── No really, have I mentioned that?
			   │             │
			   │             ╰──── This is an orange
			   │             │
			   │             ╰──── Have I mentioned that this is an orange?
			   │             │
			   │             ╰──── No really, have I mentioned that?
			───╯
			`,
		)
	})

	test("note", () => {
		let source = "apple == orange;"
		let message = new Report({
			kind: "error",
			span: { start: 0, end: 0 },
			message: "can't compare apples with oranges",
			labels: [
				new Label(
					{ start: 0, end: 5 },
					{ message: "This is an apple" },
				),
				new Label(
					{ start: 9, end: 15 },
					{ message: "This is an orange" },
				),
			],
			notes: ["stop trying ... this is a fruitless endeavor"],
			config: noColor(),
		}).render(source)

		expectOutput(
			message,
			`
			Error: can't compare apples with oranges
			   ╭─┤ <unknown>:1:1 │
			   │
			 1 │ apple == orange;
			   │ ──┬──    ───┬──
			   │   ╰─────────│──── This is an apple
			   │             │
			   │             ╰──── This is an orange
			   │
			   │ Note: stop trying ... this is a fruitless endeavor
			───╯
			`,
		)
	})

	test("help", () => {
		let source = "apple == orange;"
		let message = new Report({
			kind: "error",
			span: { start: 0, end: 0 },
			message: "can't compare apples with oranges",
			labels: [
				new Label(
					{ start: 0, end: 5 },
					{ message: "This is an apple" },
				),
				new Label(
					{ start: 9, end: 15 },
					{ message: "This is an orange" },
				),
			],
			helps: ["have you tried peeling the orange?"],
			config: noColor(),
		}).render(source)

		expectOutput(
			message,
			`
			Error: can't compare apples with oranges
			   ╭─┤ <unknown>:1:1 │
			   │
			 1 │ apple == orange;
			   │ ──┬──    ───┬──
			   │   ╰─────────│──── This is an apple
			   │             │
			   │             ╰──── This is an orange
			   │
			   │ Help: have you tried peeling the orange?
			───╯
			`,
		)
	})

	test("help and note", () => {
		let source = "apple == orange;"
		let message = new Report({
			kind: "error",
			span: { start: 0, end: 0 },
			message: "can't compare apples with oranges",
			labels: [
				new Label(
					{ start: 0, end: 5 },
					{ message: "This is an apple" },
				),
				new Label(
					{ start: 9, end: 15 },
					{ message: "This is an orange" },
				),
			],
			helps: ["have you tried peeling the orange?"],
			notes: ["stop trying ... this is a fruitless endeavor"],
			config: noColor(),
		}).render(source)

		expectOutput(
			message,
			`
			Error: can't compare apples with oranges
			   ╭─┤ <unknown>:1:1 │
			   │
			 1 │ apple == orange;
			   │ ──┬──    ───┬──
			   │   ╰─────────│──── This is an apple
			   │             │
			   │             ╰──── This is an orange
			   │
			   │ Help: have you tried peeling the orange?
			   │
			   │ Note: stop trying ... this is a fruitless endeavor
			───╯
			`,
		)
	})

	test("single note single line", () => {
		let source = "apple == orange;"
		let message = new Report({
			kind: "error",
			span: { start: 0, end: 0 },
			message: "can't compare apples with oranges",
			labels: [
				new Label(
					{ start: 0, end: 15 },
					{ message: "This is a strange comparison" },
				),
			],
			notes: ["No need to try, they can't be compared."],
			config: noColor(),
		}).render(source)

		expectOutput(
			message,
			`
			Error: can't compare apples with oranges
			   ╭─┤ <unknown>:1:1 │
			   │
			 1 │ apple == orange;
			   │ ───────┬───────
			   │        ╰───────── This is a strange comparison
			   │
			   │ Note: No need to try, they can't be compared.
			───╯
			`,
		)
	})

	test("multi notes single lines", () => {
		let source = "apple == orange;"
		let message = new Report({
			kind: "error",
			span: { start: 0, end: 0 },
			message: "can't compare apples with oranges",
			labels: [
				new Label(
					{ start: 0, end: 15 },
					{ message: "This is a strange comparison" },
				),
			],
			notes: [
				"No need to try, they can't be compared.",
				"Yeah, really, please stop.",
			],
			config: noColor(),
		}).render(source)

		expectOutput(
			message,
			`
			Error: can't compare apples with oranges
			   ╭─┤ <unknown>:1:1 │
			   │
			 1 │ apple == orange;
			   │ ───────┬───────
			   │        ╰───────── This is a strange comparison
			   │
			   │ Note 1: No need to try, they can't be compared.
			   │ Note 2: Yeah, really, please stop.
			───╯
			`,
		)
	})

	test("multi notes multi lines", () => {
		let source = "apple == orange;"
		let message = new Report({
			kind: "error",
			span: { start: 0, end: 0 },
			message: "can't compare apples with oranges",
			labels: [
				new Label(
					{ start: 0, end: 15 },
					{ message: "This is a strange comparison" },
				),
			],
			notes: [
				"No need to try, they can't be compared.",
				"Yeah, really, please stop.\nIt has no resemblance.",
			],
			config: noColor(),
		}).render(source)

		expectOutput(
			message,
			`
			Error: can't compare apples with oranges
			   ╭─┤ <unknown>:1:1 │
			   │
			 1 │ apple == orange;
			   │ ───────┬───────
			   │        ╰───────── This is a strange comparison
			   │
			   │ Note 1: No need to try, they can't be compared.
			   │ Note 2: Yeah, really, please stop.
			   │         It has no resemblance.
			───╯
			`,
		)
	})

	test("multi helps multi lines", () => {
		let source = "apple == orange;"
		let message = new Report({
			kind: "error",
			span: { start: 0, end: 0 },
			message: "can't compare apples with oranges",
			labels: [
				new Label(
					{ start: 0, end: 15 },
					{ message: "This is a strange comparison" },
				),
			],
			helps: [
				"No need to try, they can't be compared.",
				"Yeah, really, please stop.\nIt has no resemblance.",
			],
			config: noColor(),
		}).render(source)

		expectOutput(
			message,
			`
			Error: can't compare apples with oranges
			   ╭─┤ <unknown>:1:1 │
			   │
			 1 │ apple == orange;
			   │ ───────┬───────
			   │        ╰───────── This is a strange comparison
			   │
			   │ Help 1: No need to try, they can't be compared.
			   │ Help 2: Yeah, really, please stop.
			   │         It has no resemblance.
			───╯
			`,
		)
	})

	test("ordered labels", () => {
		let message = new Report<string>({
			kind: "error",
			span: { sourceId: "", start: 0, end: 0 },
			labels: [
				new Label(
					{ sourceId: "b", start: 13, end: 18 },
					{ order: 1, message: "1" },
				),
				new Label(
					{ sourceId: "a", start: 0, end: 6 },
					{ order: 2, message: "2" },
				),
				new Label(
					{ sourceId: "a", start: 7, end: 12 },
					{ order: 3, message: "3" },
				),
				new Label(
					{ sourceId: "b", start: 0, end: 6 },
					{ order: 4, message: "4" },
				),
				new Label(
					{ sourceId: "b", start: 7, end: 12 },
					{ order: 5, message: "5" },
				),
			],
			config: noColor(),
		}).render(
			sources([
				["a", "second\nthird"],
				["b", "fourth\nfifth\nfirst"],
			]),
		)

		expectOutput(
			message,
			`
			Error:
			   ╭─┤ b:3:1 │
			   │
			 3 │ first
			   │ ──┬──
			   │   ╰──── 1
			   │
			   ├─┤ a:1:1 │
			   │
			 1 │ second
			   │ ───┬──
			   │    ╰──── 2
			 2 │ third
			   │ ──┬──
			   │   ╰──── 3
			   │
			   ├─┤ b:1:1 │
			   │
			 1 │ fourth
			   │ ───┬──
			   │    ╰──── 4
			 2 │ fifth
			   │ ──┬──
			   │   ╰──── 5
			───╯
			`,
		)
	})

	test("minimise crossings", () => {
		let source = "begin\napple == orange;\nend"
		let message = new Report({
			kind: "error",
			span: { start: 0, end: 0 },
			message: "can't compare apples with oranges",
			labels: [
				new Label(
					{ start: 6, end: 11 },
					{ message: "This is an apple" },
				),
				new Label(
					{ start: 15, end: 21 },
					{ message: "This is an orange" },
				),
				new Label({ start: 3, end: 25 }, { message: "multi 1" }),
				new Label({ start: 25, end: 26 }, { message: "single" }),
			],
			config: new Config({ color: false, minimiseCrossings: true }),
		}).render(source)

		expectOutput(
			message,
			`
			Error: can't compare apples with oranges
			   ╭─┤ <unknown>:1:1 │
			   │
			 1 │ ╭─▶ begin
			 2 │ │   apple == orange;
			   │ │   ──┬──    ───┬──
			   │ │     │         ╰──── This is an orange
			   │ │     │
			   │ │     ╰────────────── This is an apple
			 3 │ ├─▶ end
			   │ │     ▲
			   │ │     ╰── single
			   │ │
			   │ ╰──────── multi 1
			───╯
			`,
		)
	})

	test("only help and note", () => {
		let source = "this should not be printed"
		let message = new Report({
			kind: "error",
			span: { start: 0, end: 0 },
			message: 'Programming language "Rest" not found',
			helps: ["a language with a similar name exists: Rust"],
			notes: ["perhaps you'd like some sleep?"],
			config: noColor(),
		}).render(source)

		expectOutput(
			message,
			`
			Error: Programming language "Rest" not found

			Help: a language with a similar name exists: Rust

			Note: perhaps you'd like some sleep?
			`,
		)
	})

	test("multi source", () => {
		let message = new Report<number>({
			kind: "error",
			span: { sourceId: 0, start: 0, end: 0 },
			message: "can't compare apples with oranges or pears",
			labels: [
				new Label(
					{ sourceId: 0, start: 0, end: 5 },
					{ message: "This is an apple" },
				),
				new Label(
					{ sourceId: 0, start: 9, end: 15 },
					{ message: "This is an orange" },
				),
				new Label(
					{ sourceId: 1, start: 0, end: 5 },
					{ message: "This is an apple" },
				),
				new Label(
					{ sourceId: 1, start: 9, end: 13 },
					{ message: "This is a pear" },
				),
			],
			config: noColor(),
		}).render(
			sources([
				[0, "apple == orange;"],
				[1, "apple == pear;"],
			]),
		)

		expectOutput(
			message,
			`
			Error: can't compare apples with oranges or pears
			   ╭─┤ 0:1:1 │
			   │
			 1 │ apple == orange;
			   │ ──┬──    ───┬──
			   │   ╰─────────│──── This is an apple
			   │             │
			   │             ╰──── This is an orange
			   │
			   ├─┤ 1:1:1 │
			   │
			 1 │ apple == pear;
			   │ ──┬──    ──┬─
			   │   ╰────────│─── This is an apple
			   │            │
			   │            ╰─── This is a pear
			───╯
			`,
		)
	})

	test("help and note multi", () => {
		let message = new Report<number>({
			kind: "error",
			span: { sourceId: 0, start: 0, end: 0 },
			message: "can't compare apples with oranges or pears",
			labels: [
				new Label(
					{ sourceId: 0, start: 0, end: 5 },
					{ message: "This is an apple" },
				),
				new Label(
					{ sourceId: 0, start: 9, end: 15 },
					{ message: "This is an orange" },
				),
				new Label(
					{ sourceId: 1, start: 0, end: 5 },
					{ message: "This is an apple" },
				),
				new Label(
					{ sourceId: 1, start: 9, end: 13 },
					{ message: "This is a pear" },
				),
			],
			helps: ["have you tried peeling the orange?"],
			notes: ["stop trying ... this is a fruitless endeavor"],
			config: noColor(),
		}).render(
			sources([
				[0, "apple == orange;"],
				[1, "apple == pear;"],
			]),
		)

		expectOutput(
			message,
			`
			Error: can't compare apples with oranges or pears
			   ╭─┤ 0:1:1 │
			   │
			 1 │ apple == orange;
			   │ ──┬──    ───┬──
			   │   ╰─────────│──── This is an apple
			   │             │
			   │             ╰──── This is an orange
			   │
			   ├─┤ 1:1:1 │
			   │
			 1 │ apple == pear;
			   │ ──┬──    ──┬─
			   │   ╰────────│─── This is an apple
			   │            │
			   │            ╰─── This is a pear
			   │
			   │ Help: have you tried peeling the orange?
			   │
			   │ Note: stop trying ... this is a fruitless endeavor
			───╯
			`,
		)
	})

	test("no labels", () => {
		let message = new Report<number>({
			kind: "error",
			span: { sourceId: 0, start: 0, end: 0 },
			message: "no code",
			helps: ["have you tried adding code?"],
			notes: ["code needs to exist"],
			config: noColor(),
		}).render(sources<number>([]))

		expectOutput(
			message,
			`
			Error: no code

			Help: have you tried adding code?

			Note: code needs to exist
			`,
		)
	})
})

describe("ariadne colors", () => {
	test("color generator produces distinct colors", () => {
		let generator = new ColorGenerator()
		let a = generator.next()
		let b = generator.next()
		let c = generator.next()

		expect(a).not.toEqual(b)
		expect(b).not.toEqual(c)
		expect(c).not.toEqual(a)
	})

	test("colored output contains ANSI escape codes", () => {
		let message = new Report({
			kind: "error",
			span: { start: 0, end: 0 },
			message: "can't compare apples with oranges",
			labels: [
				new Label(
					{ start: 0, end: 5 },
					{ message: "This is an apple" },
				),
			],
		}).render("apple == orange;")

		// Report kind in red, margin in fixed color 246
		expect(message).toContain("\x1b[31mError\x1b[0m")
		expect(message).toContain("\x1b[38;5;246m")
	})

	test("stripAnsi removes all escape codes", () => {
		let message = new Report({
			kind: "error",
			span: { start: 0, end: 0 },
			message: "can't compare apples with oranges",
			labels: [
				new Label(
					{ start: 0, end: 5 },
					{ message: "This is an apple" },
				),
			],
			config: new Config({ stripAnsi: true }),
		}).render("apple == orange;")

		expect(message).not.toContain("\x1b")
	})
})
