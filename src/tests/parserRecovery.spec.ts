import { describe, expect, it } from "bun:test"

import { parseWithDiagnostics } from "../parser/index"
import { testDiagnostic } from "./diagnosticFactory"

describe("Parser Recovery", () => {
	it("should report zero diagnostics for a valid program", () => {
		let { diagnostics } = parseWithDiagnostics(
			`implementation {
				constant x = 1
				function f (value: Number) -> Number {
					<- value
				}
				f(x)
			}`,
		)

		expect(diagnostics).toEqual([])
	})

	it("should report a positioned diagnostic for an unexpected token", () => {
		let { diagnostics } = parseWithDiagnostics(
			"implementation { constant x 1 }",
		)

		expect(diagnostics).toEqual([
			testDiagnostic({
				severity: "error",
				message: "Expected '=' but found '1'.",
				position: {
					start: { line: 1, column: 29 },
					end: { line: 1, column: 30 },
				},
				code: "syntax-error",
				labels: [
					{
						position: {
							start: { line: 1, column: 29 },
							end: { line: 1, column: 30 },
						},
						message: "expected '='",
						kind: "primary",
					},
				],
			}),
		])
	})

	it("should keep parsing statements after a broken statement", () => {
		let { program, diagnostics } = parseWithDiagnostics(
			`implementation {
				constant x =
				constant y = 5
			}`,
		)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].severity).toBe("error")
		expect(diagnostics[0].message).toBe(
			"Expected an Expression but found 'constant'.",
		)

		let nodes = program.implementation.nodes

		expect(nodes).toHaveLength(1)
		expect(nodes[0].nodeType).toBe("ConstantDeclarationStatement")

		if (nodes[0].nodeType === "ConstantDeclarationStatement") {
			expect(nodes[0].name.content).toBe("y")
			expect(nodes[0].value.nodeType).toBe("IntegerValue")
		}
	})

	it("should keep statements that parsed before the broken statement", () => {
		let { program, diagnostics } = parseWithDiagnostics(
			`implementation {
				constant x = 1
				variable y =
			}`,
		)

		expect(diagnostics).toHaveLength(1)

		let nodes = program.implementation.nodes

		expect(nodes).toHaveLength(1)
		expect(nodes[0].nodeType).toBe("ConstantDeclarationStatement")
	})

	it("should recover inside nested blocks", () => {
		let { program, diagnostics } = parseWithDiagnostics(
			`implementation {
				function f (value: Number) -> Number {
					constant broken 5
					<- value
				}
			}`,
		)

		expect(diagnostics).toHaveLength(1)

		let nodes = program.implementation.nodes

		expect(nodes).toHaveLength(1)
		expect(nodes[0].nodeType).toBe("FunctionStatement")

		if (nodes[0].nodeType === "FunctionStatement") {
			expect(nodes[0].value.body).toHaveLength(1)
			expect(nodes[0].value.body[0].nodeType).toBe("ReturnStatement")
		}
	})

	it("should report exactly one diagnostic per broken statement", () => {
		let { program, diagnostics } = parseWithDiagnostics(
			`implementation {
				constant x =
				constant y = 5
				variable z 10
				variable w = 6
			}`,
		)

		expect(diagnostics).toHaveLength(2)
		expect(diagnostics[0].message).toBe(
			"Expected an Expression but found 'constant'.",
		)
		expect(diagnostics[1].message).toBe("Expected '=' but found '10'.")

		let nodes = program.implementation.nodes

		expect(nodes).toHaveLength(2)
		expect(nodes[0].nodeType).toBe("ConstantDeclarationStatement")
		expect(nodes[1].nodeType).toBe("VariableDeclarationStatement")
	})

	it("should report a torn-open block once and terminate", () => {
		let { program, diagnostics } = parseWithDiagnostics(
			`implementation {
				function f (value: Number) -> Number {
					<- value`,
		)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].code).toBe("unclosed-block")

		let nodes = program.implementation.nodes

		expect(nodes).toHaveLength(1)
		expect(nodes[0].nodeType).toBe("FunctionStatement")
	})

	it("should report an unterminated String Literal once", () => {
		let { diagnostics } = parseWithDiagnostics(
			'implementation { constant x = "abc }',
		)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].severity).toBe("error")
		expect(diagnostics[0].code).toBe("unclosed-string")
		expect(diagnostics[0].position).not.toBeNull()
	})

	it("should report a missing implementation section", () => {
		let { program, diagnostics } = parseWithDiagnostics("constant x = 1")

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].message).toBe(
			"Expected 'implementation' but found 'constant'.",
		)
		expect(program.implementation.nodes).toHaveLength(0)
	})

	it("should recover from a broken match handler", () => {
		let { program, diagnostics } = parseWithDiagnostics(
			`implementation {
				constant x = match 1 -> Number {
					case : {}
					case Number { <- 2 }
				}
				constant y = 3
			}`,
		)

		expect(diagnostics).toHaveLength(1)

		let nodes = program.implementation.nodes

		expect(nodes).toHaveLength(2)
		expect(nodes[0].nodeType).toBe("ConstantDeclarationStatement")
		expect(nodes[1].nodeType).toBe("ConstantDeclarationStatement")

		if (nodes[0].nodeType === "ConstantDeclarationStatement") {
			expect(nodes[0].value.nodeType).toBe("Match")

			if (nodes[0].value.nodeType === "Match") {
				expect(nodes[0].value.handlers).toHaveLength(1)
			}
		}
	})

	it("should recover from a broken Generic list", () => {
		let { program, diagnostics } = parseWithDiagnostics(
			`implementation {
				namespace Broken<infer for List<Item> {
					first() -> Item | Nothing {
						<- @::firstItem()
					}
				}
				constant y = 3
			}`,
		)

		expect(diagnostics).toHaveLength(1)
		expect(diagnostics[0].severity).toBe("error")

		let nodes = program.implementation.nodes

		expect(nodes).toHaveLength(1)
		expect(nodes[0].nodeType).toBe("ConstantDeclarationStatement")

		if (nodes[0].nodeType === "ConstantDeclarationStatement") {
			expect(nodes[0].name.content).toBe("y")
		}
	})
})
