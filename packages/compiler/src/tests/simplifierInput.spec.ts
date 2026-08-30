import { describe, expect, it } from "bun:test"

import type { common } from "@essence-lang/interfaces"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { optimise } from "../optimiser/index"
import { parseWithDiagnostics } from "../parser/index"
import { rewrite } from "../rewriter/index"
import { simplify } from "../simplifier/index"

// NOTE: The Simplifier READS a typed Program and writes a new one. The typed
// Program is read again after it — the Language Server holds it for every hover
// and rename, the prelude simplifies the standard library's once per process,
// and a contract goal shares one typed check between every entry over the same
// refinement — so a Simplifier that wrote into its input would hand the next
// reader something no source said. The Overload suffix is the case that bit:
// it only appends, so a node simplified twice named `raise__overload$1` the
// first time and `raise__overload$1__overload$1` the second.
function typedOf(source: string): common.typed.Program {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)

	return enriched.program
}

const SOURCE = `implementation {
	constant power = 2::raise(to 10)
	constant range = List.of(integersFrom 1, through 3)
	constant counted = loop(
		startingWith 0,
		while (count) { <- count::isLessThan(3) },
		step (count) { <- count::add(1) },
	)
	constant graded = define {
		as "high" if power::isGreaterThanOrEqualTo(100)
		as "low" otherwise
	}
}`

function valueOf(
	program: common.typed.Program,
	index: number,
): common.typed.ExpressionNode {
	let statement = program.implementation.nodes[index]!

	if (statement.nodeType !== "ConstantDeclarationStatement") {
		throw new Error("The declaration did not enrich as expected")
	}

	return statement.value
}

describe("Simplifier input", () => {
	it("leaves an overloaded Method Invocation's typed name alone", () => {
		let typed = typedOf(SOURCE)

		simplify(typed)

		let power = valueOf(typed, 0)

		if (power.nodeType !== "MethodInvocation") {
			throw new Error("The power did not enrich as a Method Invocation")
		}

		expect(power.member.name).toBe("raise")
	})

	it("leaves an overloaded static call's typed name alone", () => {
		let typed = typedOf(SOURCE)

		simplify(typed)

		let range = valueOf(typed, 1)

		if (
			range.nodeType !== "FunctionInvocation" ||
			range.name.nodeType !== "Lookup"
		) {
			throw new Error("The range did not enrich as a Namespace call")
		}

		expect(range.name.member.content).toBe("of")
	})

	it("leaves an overloaded free Function call's typed name alone", () => {
		let typed = typedOf(SOURCE)

		simplify(typed)

		let counted = valueOf(typed, 2)

		if (
			counted.nodeType !== "FunctionInvocation" ||
			counted.name.nodeType !== "Identifier"
		) {
			throw new Error("The count did not enrich as a bare call")
		}

		expect(counted.name.content).toBe("loop")
	})

	it("emits the same JavaScript from one typed Program twice", () => {
		let typed = typedOf(SOURCE)
		let first = rewrite(optimise(simplify(typed)))
		let again = rewrite(optimise(simplify(typed)))

		expect(again).toBe(first)
		expect(first).toContain("raise__overload$")
		expect(first).not.toContain("__overload$1__overload$")
	})
})
