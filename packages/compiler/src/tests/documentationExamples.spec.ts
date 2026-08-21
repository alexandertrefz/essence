import { describe, expect, it } from "bun:test"

import type { common } from "@essence-lang/interfaces"

import { containsErrors } from "../diagnostics/index"
import { hasDocumentationExamples } from "../enricher/examples"
import { enrich } from "../enricher/index"
import { parseWithDiagnostics } from "../parser/index"
import { validate } from "../validator/index"

// NOTE: `@example` blocks, and the tests they become. What is written under the
// tag is Essence compiled in the file's own scope, at the very lines it was
// written on — so an example that stops being true fails a run rather than
// sitting in hover text saying something that is not so.

function parse(source: string) {
	let parsed = parseWithDiagnostics(source)

	expect(parsed.diagnostics).toEqual([])

	return parsed.program
}

function sectionOf(
	source: string,
	options: { tests?: boolean } = {},
): common.typed.TestsSectionNode | null {
	let enriched = enrich(parse(source), {
		tests: options.tests ?? true,
		source,
	})

	expect(enriched.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
		[],
	)
	expect(containsErrors(validate(enriched.program))).toBe(false)

	return enriched.program.tests
}

function namesOf(section: common.typed.TestsSectionNode | null): Array<string> {
	let names: Array<string> = []

	let walk = (nodes: Array<common.typed.TestsNode>): void => {
		for (let node of nodes) {
			if (node.nodeType === "Test") {
				names.push(node.identity.name)
			} else if (node.nodeType === "Suite") {
				walk(node.nodes)
			}
		}
	}

	walk(section?.nodes ?? [])

	return names
}

const documented = `implementation {
	§§ Doubles a number.
	§§
	§§ @example
	§§   constant doubled = double(21)
	§§
	§§   expect doubled::is(42)
	§§
	§§ @returns — twice what it was given.
	function double(_ value: Integer) -> Integer {
		<- value::multiply(with 2)
	}

	namespace Greeting for String {
		§§ Greets by name.
		§§
		§§ @example
		§§   expect "Lions"::greet()::is("Hello, Lions")
		greet() -> String {
			<- "Hello, {@}"
		}
	}
}`

describe("The @example grammar", () => {
	it("lifts the lines under the tag out of the prose", () => {
		let node = parse(documented).implementation.nodes[0]

		expect(node?.nodeType).toBe("FunctionStatement")

		let documentation = (
			node as { value: { documentation: common.Documentation | null } }
		).value.documentation

		expect(documentation?.description).toBe("Doubles a number.")
		expect(documentation?.returns).toBe("twice what it was given.")
		expect(documentation?.examples).toHaveLength(1)
		expect(documentation?.examples[0]?.lines).toHaveLength(4)
	})

	it("answers whether a Program documents anything runnable", () => {
		expect(hasDocumentationExamples(parse(documented))).toBe(true)
		expect(
			hasDocumentationExamples(
				parse(`implementation {
					§§ Doubles a number.
					function double(_ value: Integer) -> Integer {
						<- value::multiply(with 2)
					}
				}`),
			),
		).toBe(false)
	})

	// NOTE: A tag with nothing under it promises nothing, and a test that runs
	// no Statement is a test that can never fail.
	it("drops an example with no code under it", () => {
		expect(
			hasDocumentationExamples(
				parse(`implementation {
					§§ Doubles a number.
					§§
					§§ @example
					§§
					§§ @returns — twice what it was given.
					function double(_ value: Integer) -> Integer {
						<- value::multiply(with 2)
					}
				}`),
			),
		).toBe(false)
	})
})

describe("What an @example becomes", () => {
	it("names a test after the Method or the Function", () => {
		expect(namesOf(sectionOf(documented))).toEqual([
			"double example",
			"Greeting::greet example",
		])
	})

	it("reports them under a suite of their own", () => {
		let section = sectionOf(documented)
		let suite = section?.nodes[0]

		expect(suite?.nodeType).toBe("Suite")
		expect((suite as common.typed.SuiteNode).identity.name).toBe("examples")
	})

	it("numbers a second example of one Method", () => {
		expect(
			namesOf(
				sectionOf(`implementation {
					§§ Doubles a number.
					§§
					§§ @example
					§§   expect double(1)::is(2)
					§§
					§§ @example
					§§   expect double(2)::is(4)
					function double(_ value: Integer) -> Integer {
						<- value::multiply(with 2)
					}
				}`),
			),
		).toEqual(["double example", "double example 2"])
	})

	// NOTE: The whole reason an example is compiled out of the file's own lines
	// rather than out of a text of its own: everything a run says about one
	// points at the `§§` line it was written on.
	it("stands where it was written", () => {
		let section = sectionOf(documented)
		let suite = section?.nodes[0] as common.typed.SuiteNode
		let test = suite.nodes[0] as common.typed.TestNode
		let assertion = test.body[1]

		expect(assertion?.position.start.line).toBe(7)
		expect(assertion?.position.start.column).toBeGreaterThan(4)
	})

	it("sees what the file declares", () => {
		expect(namesOf(sectionOf(documented))).toContain("double example")
	})

	it("stands beside a written tests section", () => {
		expect(
			namesOf(
				sectionOf(`implementation {
					§§ Doubles a number.
					§§
					§§ @example
					§§   expect double(1)::is(2)
					function double(_ value: Integer) -> Integer {
						<- value::multiply(with 2)
					}
				}

				tests {
					test "doubles" {
						expect double(2)::is(4)
					}
				}`),
			),
		).toEqual(["doubles", "double example"])
	})

	it("is nothing at all to a compile that did not ask for the tests", () => {
		expect(sectionOf(documented, { tests: false })).toBeNull()
	})

	it("reports what an example says that does not hold up", () => {
		let source = `implementation {
			§§ Doubles a number.
			§§
			§§ @example
			§§   expect double(2)
			function double(_ value: Integer) -> Integer {
				<- value::multiply(with 2)
			}
		}`
		let enriched = enrich(parse(source), { tests: true, source })
		let diagnostics = [
			...enriched.diagnostics,
			...validate(enriched.program),
		]

		expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
			"expect-not-boolean",
		])
		expect(diagnostics[0]?.position?.start.line).toBe(5)
	})
})
