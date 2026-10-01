import { describe, expect, it } from "bun:test"

import { enrich } from "@essence-lang/compiler/enricher"
import { loadStdlib } from "@essence-lang/compiler/enricher/stdlib"
import { parseWithDiagnostics } from "@essence-lang/compiler/parser"
import type { common } from "@essence-lang/interfaces"

import { typedExpressionAt } from "../codeActions/typedLookups"

describe("The typed Expression at a span", () => {
	it("should find an Expression written in a refinement predicate", () => {
		let source = [
			"implementation {",
			"\ttype Small = Integer where @::isLessThan(10)",
			"}",
		].join("\n")
		let { program } = enrich(parseWithDiagnostics(source).program)
		let alias = program.implementation
			.nodes[0] as common.typed.TypeAliasStatementNode
		let predicate = alias.predicate as common.typed.MethodInvocationNode
		let limit = predicate.arguments[0]!.value

		expect(typedExpressionAt(program, limit.position)).toBe(limit)
	})

	// Only the standard library may write a native Method, so its defaults
	// stand in.
	it("should find every Expression written as a native Method's default", () => {
		let defaults = nativeDefaults()

		expect(defaults.length).toBeGreaterThan(0)

		for (let { program, defaultValue } of defaults) {
			expect(typedExpressionAt(program, defaultValue.position)).toBe(
				defaultValue,
			)
		}
	})
})

function nativeDefaults(): Array<{
	program: common.typed.Program
	defaultValue: common.typed.ExpressionNode
}> {
	let defaults = []

	for (let program of loadStdlib().typedPrograms) {
		for (let node of program.implementation.nodes) {
			if (node.nodeType !== "NamespaceDefinitionStatement") {
				continue
			}

			for (let shim of node.nativeShims) {
				for (let parameter of shim.parameters) {
					if (parameter.defaultValue !== null) {
						defaults.push({
							program,
							defaultValue: parameter.defaultValue,
						})
					}
				}
			}
		}
	}

	return defaults
}
