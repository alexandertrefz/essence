import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"
import { validate } from "../validator/index"

// The ordering vocabulary is written in Essence, so what it answers shows
// only when a Program runs. Every claim here compiles and executes.
function generate(source: string): string {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return rewrite(optimise(simplify(enriched.program)))
}

async function run(source: string): Promise<Array<string>> {
	let javaScript = generate(source)
	let directory = mkdtempSync(join(tmpdir(), "essence-ordering-"))
	let file = join(directory, "program.ts")

	writeFileSync(file, javaScript)

	let output: Array<string> = []
	let originalLog = console.log

	console.log = (...args: Array<unknown>) => {
		output.push(args.map((argument) => String(argument)).join(" "))
	}

	try {
		await import(file)
	} finally {
		console.log = originalLog
		rmSync(directory, { recursive: true, force: true })
	}

	return output
}

// `Comparable` provides the inequalities over `compare`. A String and a List
// write none of them, so every answer here is the Protocol's body.
describe("Comparable's provided inequalities", () => {
	it("orders two Strings", async () => {
		expect(
			await run(
				[
					"implementation {",
					'\tTerminal.inspect("app"::isLessThan("apple"))',
					'\tTerminal.inspect("b"::isLessThan("a"))',
					'\tTerminal.inspect("b"::isGreaterThan("a"))',
					'\tTerminal.inspect("abc"::isLessThanOrEqualTo("abc"))',
					'\tTerminal.inspect("abc"::isGreaterThanOrEqualTo("abc"))',
					'\tTerminal.inspect("abc"::isGreaterThanOrEqualTo("abd"))',
					"}",
				].join("\n"),
			),
		).toEqual(["true", "false", "true", "true", "true", "false"])
	})

	// `List::compare` is lexicographic, with the shorter List first on an
	// equal prefix. The inequalities reach it through the conditional
	// conformance.
	it("orders two Lists lexicographically", async () => {
		expect(
			await run(
				[
					"implementation {",
					"\tTerminal.inspect([1, 2]::isLessThan([1, 3]))",
					"\tTerminal.inspect([1]::isLessThan([1, 2]))",
					"\tTerminal.inspect([1, 3]::isGreaterThan([1, 2]))",
					"\tTerminal.inspect([1, 2]::isLessThanOrEqualTo([1, 2]))",
					'\tTerminal.inspect(["a", "b"]::isLessThan(["a", "c"]))',
					"}",
				].join("\n"),
			),
		).toEqual(["true", "true", "true", "true", "true"])
	})

	// A String is `Comparable` but not `Orderable`, so the Methods a number
	// line makes meaningful are out of reach.
	it("leaves isBetween and clamp on Orderable", () => {
		let parsed = parseWithDiagnostics(
			[
				"implementation {",
				'\tTerminal.inspect("b"::isBetween("a", and "c"))',
				"}",
			].join("\n"),
		)

		expect(
			enrich(parsed.program).diagnostics.map(
				(diagnostic) => diagnostic.code,
			),
		).toEqual(["unknown-method"])
	})

	// A provided Method answers the Namespace spelling too.
	it("answers the Namespace spelling", async () => {
		expect(
			await run(
				[
					"implementation {",
					'\tTerminal.inspect(String.isLessThan("a", "b"))',
					"\tTerminal.inspect(List.isGreaterThan([2], [1]))",
					"}",
				].join("\n"),
			),
		).toEqual(["true", "true"])
	})

	// A Function bounded `is Comparable` reaches the same bodies through the
	// witness it is handed.
	it("answers a call bounded by Comparable", async () => {
		expect(
			await run(
				[
					"implementation {",
					"\tfunction below<infer Item is Comparable>(",
					"\t\t_ value: Item,",
					"\t\t_ other: Item,",
					"\t) -> Boolean {",
					"\t\t<- value::isLessThanOrEqualTo(other)",
					"\t}",
					"",
					'\tTerminal.inspect(below("a", "b"))',
					"\tTerminal.inspect(below(3, 2))",
					"}",
				].join("\n"),
			),
		).toEqual(["true", "false"])
	})
})

// `Ordering::then` answers the first ordering where it decides, and the second
// where the first is `#Equal`. Its `computedBy` twin runs its Function only
// there.
describe("Ordering::then", () => {
	it("answers the first ordering where it decides", async () => {
		expect(
			await run(
				[
					"implementation {",
					"\tTerminal.inspect(Ordering#Less::then(#Greater))",
					"\tTerminal.inspect(Ordering#Greater::then(#Less))",
					"\tTerminal.inspect(Ordering#Equal::then(#Greater))",
					"\tTerminal.inspect(Ordering#Equal::then(#Equal))",
					"}",
				].join("\n"),
			),
		).toEqual([
			"Ordering#Less",
			"Ordering#Greater",
			"Ordering#Greater",
			"Ordering#Equal",
		])
	})

	it("answers the same way through the lazy entry", async () => {
		expect(
			await run(
				[
					"implementation {",
					"\tTerminal.inspect(",
					"\t\tOrdering#Less::then(computedBy () -> Ordering { <- #Greater }),",
					"\t)",
					"\tTerminal.inspect(",
					"\t\tOrdering#Equal::then(computedBy () -> Ordering { <- #Greater }),",
					"\t)",
					"}",
				].join("\n"),
			),
		).toEqual(["Ordering#Less", "Ordering#Greater"])
	})

	// The Function prints, so a run that never reaches it leaves nothing on
	// the stream.
	it("leaves the lazy tie-breaker unrun where the first decides", async () => {
		expect(
			await run(
				[
					"implementation {",
					"\tTerminal.inspect(",
					"\t\tOrdering#Less::then(computedBy () -> Ordering {",
					'\t\t\tTerminal.inspect("computed")',
					"",
					"\t\t\t<- #Greater",
					"\t\t}),",
					"\t)",
					"}",
				].join("\n"),
			),
		).toEqual(["Ordering#Less"])
	})

	it("runs the lazy tie-breaker where the first is equal", async () => {
		expect(
			await run(
				[
					"implementation {",
					"\tTerminal.inspect(",
					"\t\tOrdering#Equal::then(computedBy () -> Ordering {",
					'\t\t\tTerminal.inspect("computed")',
					"",
					"\t\t\t<- #Greater",
					"\t\t}),",
					"\t)",
					"}",
				].join("\n"),
			),
		).toEqual(['"computed"', "Ordering#Greater"])
	})

	// The shape the Method exists for: a ranking rule over several keys.
	it("orders a sort on a second key", async () => {
		expect(
			await run(
				[
					"implementation {",
					"\ttype Person = { surname: String, name: String }",
					"",
					"\tconstant people: List<Person> = [",
					'\t\t{ surname = "Ott", name = "Zoe" },',
					'\t\t{ surname = "Ali", name = "Bo" },',
					'\t\t{ surname = "Ott", name = "Al" },',
					"\t]",
					"",
					"\tconstant ranked = people::sort(by (a, b) {",
					"\t\t<- a.surname::compare(to b.surname)",
					"\t\t\t::then(a.name::compare(to b.name))",
					"\t})",
					"",
					"\tTerminal.inspect(",
					'\t\tranked::map((p) { <- "{p.surname} {p.name}" })::join(with ", "),',
					"\t)",
					"}",
				].join("\n"),
			),
		).toEqual(['"Ali Bo, Ott Al, Ott Zoe"'])
	})

	// The third ordering is reached only where the first two are equal.
	it("chains a third ordering", async () => {
		expect(
			await run(
				[
					"implementation {",
					"\tTerminal.inspect(",
					"\t\tOrdering#Equal::then(#Equal)::then(#Less),",
					"\t)",
					"\tTerminal.inspect(",
					"\t\tOrdering#Equal::then(#Greater)::then(#Less),",
					"\t)",
					"}",
				].join("\n"),
			),
		).toEqual(["Ordering#Less", "Ordering#Greater"])
	})
})

// `false` sorts before `true`, as in Swift, Rust, Haskell and SQL. `Boolean`
// writes `compare`, and the inequalities arrive with `Comparable`.
describe("Boolean's ordering", () => {
	it("orders false before true", async () => {
		expect(
			await run(
				[
					"implementation {",
					"\tTerminal.inspect(false::compare(to true))",
					"\tTerminal.inspect(true::compare(to false))",
					"\tTerminal.inspect(true::compare(to true))",
					"\tTerminal.inspect(false::compare(to false))",
					"}",
				].join("\n"),
			),
		).toEqual([
			"Ordering#Less",
			"Ordering#Greater",
			"Ordering#Equal",
			"Ordering#Equal",
		])
	})

	it("answers the four inequalities", async () => {
		expect(
			await run(
				[
					"implementation {",
					"\tTerminal.inspect(false::isLessThan(true))",
					"\tTerminal.inspect(true::isLessThan(false))",
					"\tTerminal.inspect(true::isGreaterThan(false))",
					"\tTerminal.inspect(true::isLessThanOrEqualTo(true))",
					"\tTerminal.inspect(false::isGreaterThanOrEqualTo(true))",
					"}",
				].join("\n"),
			),
		).toEqual(["true", "false", "true", "true", "false"])
	})

	it("sorts a List of Booleans", async () => {
		expect(
			await run(
				[
					"implementation {",
					"\tTerminal.inspect([true, false, true]::sort())",
					"\tTerminal.inspect([true, false]::sort(in #Descending))",
					"}",
				].join("\n"),
			),
		).toEqual(["[ false, true, true ]", "[ true, false ]"])
	})

	// A Boolean member as a sort key: `false` first puts the unfinished work
	// at the top.
	it("sorts on a Boolean key", async () => {
		expect(
			await run(
				[
					"implementation {",
					"\ttype Invoice = { id: Integer, isPaid: Boolean }",
					"",
					"\tconstant invoices: List<Invoice> = [",
					"\t\t{ id = 1, isPaid = true },",
					"\t\t{ id = 2, isPaid = false },",
					"\t\t{ id = 3, isPaid = true },",
					"\t]",
					"",
					"\tTerminal.inspect(",
					"\t\tinvoices::sort(on .isPaid)::map((invoice) { <- invoice.id }),",
					"\t)",
					"}",
				].join("\n"),
			),
		).toEqual(["[ 2, 1, 3 ]"])
	})

	// `Boolean` is `Comparable` but not `Orderable`: two truth values make no
	// range.
	it("reaches no isBetween", () => {
		let parsed = parseWithDiagnostics(
			[
				"implementation {",
				"\tTerminal.inspect(true::isBetween(false, and true))",
				"}",
			].join("\n"),
		)

		expect(
			enrich(parsed.program).diagnostics.map(
				(diagnostic) => diagnostic.code,
			),
		).toEqual(["unknown-method"])
	})
})
