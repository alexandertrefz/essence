import { describe, expect, it } from "bun:test"

import type { common } from "@essence-lang/interfaces"

import { containsErrors } from "../diagnostics/index"
import { enrich } from "../enricher/index"
import { parseWithDiagnostics } from "../parser/index"
import { simplify } from "../simplifier/index"

// Positions survive simplification so the Rewriter can map its output onto
// the source. A node the Simplifier synthesizes stays position-less, so it
// emits no mapping.
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

	// Stepping into a call that took a default stops on the `= …` in the
	// source.
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

	// A step into the Function stops on the defaulted Parameter rather than on
	// glue the Debug Adapter would step out of. The merge runs to the end of the
	// default, so a coverage point there holds what the default writes. See
	// "Record defaults" in packages/compiler/src/simplifier/DEVELOPMENT.md.
	it("spans a Record default's merge over the Parameter and its default", () => {
		let { typed, simplified } = simplifyWithTyped(`implementation {
			type Options = { host: String, retries: Integer }

			function connect(using settings: Options = { retries = 3 }) -> String {
				<- settings.host
			}
		}`)

		let typedStatement = typed.implementation.nodes[1]!
		let simplifiedStatement = simplified.implementation.nodes[1]!

		if (
			typedStatement.nodeType !== "FunctionStatement" ||
			simplifiedStatement.nodeType !== "FunctionStatement"
		) {
			throw new Error("Expected a FunctionStatement")
		}

		let parameter = typedStatement.value.parameters[0]!
		let merge = simplifiedStatement.value.body[0]!

		expect(simplifiedStatement.value.parameters[0]!.defaultValue).toBeNull()
		expect(merge.nodeType).toBe("VariableAssignmentStatement")
		expect(merge.position).toEqual({
			start: parameter.position.start,
			end: parameter.defaultValue!.position.end,
		})
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

	// A member path's Function is synthesized from written spans: the step's
	// own for its Lookup, the path's for the Parameter and the Return. Stepping
	// and renaming rely on them.
	it("keeps the span each step of a member path was written at", () => {
		let { simplified } = simplifyWithTyped(`implementation {
			type Maker = { town: String }
			type Product = { maker: Maker }
			constant products: List<Product> = []
			constant towns = products::map(.maker.town)
		}`)

		let statement = simplified.implementation.nodes[3]!

		if (statement.nodeType !== "VariableDeclarationStatement") {
			throw new Error("The declaration did not simplify as expected")
		}

		let call = statement.value

		if (call.nodeType !== "MethodInvocation") {
			throw new Error("Expected a MethodInvocation")
		}

		let path = call.arguments[1]!.value

		if (path.nodeType !== "FunctionValue") {
			throw new Error("The path did not desugar to a Function literal")
		}

		let returned = path.value.body[0]!

		if (returned.nodeType !== "ReturnStatement") {
			throw new Error("Expected a ReturnStatement")
		}

		let town = returned.expression

		if (town.nodeType !== "Lookup" || town.base.nodeType !== "Lookup") {
			throw new Error("Expected a Lookup over a Lookup")
		}

		expect(path.position).toEqual({
			start: { line: 5, column: 35 },
			end: { line: 5, column: 46 },
		})
		expect(town.base.member.position).toEqual({
			start: { line: 5, column: 36 },
			end: { line: 5, column: 41 },
		})
		expect(town.member.position).toEqual({
			start: { line: 5, column: 42 },
			end: { line: 5, column: 46 },
		})
	})

	// A body promising the empty Record `{}` may fall off its end, and the
	// Simplifier appends the `<- {}` with no position.
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
