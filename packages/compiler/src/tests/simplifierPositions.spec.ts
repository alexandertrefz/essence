import { describe, expect, it } from "bun:test"

import type { common } from "@essence-lang/interfaces"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { parseWithDiagnostics } from "../parser/index"
import { simplify } from "../simplifier/index"

// NOTE: Positions must survive simplification for the Rewriter to map what it
// emits back onto the source — while a node the Simplifier synthesizes, which
// no source was written for, must stay position-less, so it emits no mapping.
function simplifyWithTyped(source: string): {
	typed: common.typed.Program
	simplified: common.typedSimple.Program
} {
	let parsed = parseWithDiagnostics(source)

	expect(containsErrors(parsed.diagnostics)).toBe(false)

	let enriched = enrich(parsed.program)

	expect(containsErrors(enriched.diagnostics)).toBe(false)

	return { typed: enriched.program, simplified: simplify(enriched.program) }
}

describe("Simplifier Positions", () => {
	it("keeps a Statement's position", () => {
		let { typed, simplified } = simplifyWithTyped(`implementation {
			constant greeting = "hello"
		}`)

		let typedStatement = typed.implementation.nodes[0]!
		let simplifiedStatement = simplified.implementation.nodes[0]!

		expect(simplifiedStatement.nodeType).toBe(
			"VariableDeclarationStatement",
		)
		expect(simplifiedStatement.position).toEqual(typedStatement.position)
	})

	it("keeps a nested Expression's position", () => {
		let { typed, simplified } = simplifyWithTyped(`implementation {
			constant doubled = 2::multiply(with 2)
		}`)

		let typedStatement = typed.implementation.nodes[0]!
		let simplifiedStatement = simplified.implementation.nodes[0]!

		if (
			typedStatement.nodeType !== "ConstantDeclarationStatement" ||
			simplifiedStatement.nodeType !== "VariableDeclarationStatement"
		) {
			throw new Error("The declaration did not simplify as expected")
		}

		expect(simplifiedStatement.value.nodeType).toBe("MethodInvocation")
		expect(simplifiedStatement.value.position).toEqual(
			typedStatement.value.position,
		)
	})

	// NOTE: A body promising unit — the empty Record, `{}` — may fall off its
	// end, and the Simplifier appends the `<- {}` the Signature promised. That
	// Return is the one node here no source was written for, so it is the one
	// node that must carry no position.
	// NOTE: A default is an Expression written where it stands, and it keeps the
	// Position it was written at — so stepping into a call that took one stops
	// on the `= …` in the source, which is where the work is happening. The
	// filler an interior omission emits is the other half: no source wrote it,
	// so it carries no Position and emits no mapping.
	it("keeps a default's own position", () => {
		let { typed, simplified } = simplifyWithTyped(`implementation {
			function f(_ count: Integer = 1) -> Integer {
				<- count
			}
		}`)

		let typedStatement = typed.implementation.nodes[0]!
		let simplifiedStatement = simplified.implementation.nodes[0]!

		if (
			typedStatement.nodeType !== "FunctionStatement" ||
			simplifiedStatement.nodeType !== "FunctionStatement"
		) {
			throw new Error("Expected a FunctionStatement")
		}

		let typedDefault = typedStatement.value.parameters[0]!.defaultValue!
		let simplifiedDefault =
			simplifiedStatement.value.parameters[0]!.defaultValue!

		expect(simplifiedDefault.position).toEqual(typedDefault.position)
	})

	it("leaves the filler an omission emits position-less", () => {
		let { simplified } = simplifyWithTyped(`implementation {
			function g(from a: Integer = 0, to b: Integer) -> Integer {
				<- b
			}

			constant value = g(to 7)
		}`)

		let statement = simplified.implementation.nodes[1]!

		if (statement.nodeType !== "VariableDeclarationStatement") {
			throw new Error("Expected a VariableDeclarationStatement")
		}

		let call = statement.value

		if (call.nodeType !== "FunctionInvocation") {
			throw new Error("Expected a FunctionInvocation")
		}

		let filler = call.arguments[0]!.value

		expect(filler.nodeType).toBe("Intrinsic")
		expect(filler.position).toBeUndefined()
	})

	it("leaves the synthesised trailing Return position-less", () => {
		let { simplified } = simplifyWithTyped(`implementation {
			function noop () -> {} {
			}
		}`)

		let statement = simplified.implementation.nodes[0]!

		if (statement.nodeType !== "FunctionStatement") {
			throw new Error("The Function did not simplify as expected")
		}

		let lastBodyNode = statement.value.body.at(-1)!

		expect(lastBodyNode.nodeType).toBe("ReturnStatement")
		expect(lastBodyNode.position).toBeUndefined()
	})
})
