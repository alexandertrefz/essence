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

// A name is no Expression of its own, so a span holding only a name answers
// nothing. A Function Invocation's callee is the one name that is.
describe("The typed Expression at a name's span", () => {
	let source = [
		"implementation {",
		"\ttype Point = { x: Integer, y: Integer }",
		"",
		"\tchoice Shape {",
		"\t\tDot { at: Point },",
		"\t\tBlank,",
		"\t}",
		"",
		"\tnamespace Points for Point {",
		"\t\tsum() -> Integer {",
		"\t\t\t<- @.x::add(@.y)",
		"\t\t}",
		"\t}",
		"",
		"\tfunction shift (by amount: Integer) -> Integer {",
		"\t\t<- amount",
		"\t}",
		"",
		"\tconstant origin: Point = { x = 0, y = 0 }",
		"\tconstant across = origin.x",
		"\tconstant blank = Shape#Blank",
		"\tconstant moved = shift(by 1)",
		"}",
	].join("\n")
	let { program } = enrich(parseWithDiagnostics(source).program)

	function statement<Kind extends common.typed.StatementNode["nodeType"]>(
		nodeType: Kind,
		name: string,
	): Extract<common.typed.StatementNode, { nodeType: Kind }> {
		return program.implementation.nodes.find(
			(node) =>
				node.nodeType === nodeType &&
				"name" in node &&
				node.name.content === name,
		) as Extract<common.typed.StatementNode, { nodeType: Kind }>
	}

	function valueOf(name: string) {
		return statement("ConstantDeclarationStatement", name).value
	}

	it("should answer nothing at a Lookup's member", () => {
		let lookup = valueOf("across") as common.typed.LookupNode

		expect(typedExpressionAt(program, lookup.position)).toBe(lookup)
		expect(typedExpressionAt(program, lookup.member.position)).toBeNull()
	})

	it("should answer nothing at a Case reference's Choice or Case name", () => {
		let caseValue = valueOf("blank") as common.typed.CaseValueNode

		expect(
			typedExpressionAt(program, caseValue.choice!.position),
		).toBeNull()
		expect(
			typedExpressionAt(program, caseValue.caseName.position),
		).toBeNull()
	})

	it("should answer nothing at a Parameter's label or name", () => {
		let parameter = statement("FunctionStatement", "shift").value
			.parameters[0]!

		expect(
			typedExpressionAt(program, parameter.externalName!.position),
		).toBeNull()
		expect(
			typedExpressionAt(program, parameter.internalName!.position),
		).toBeNull()
	})

	it("should answer nothing at a declaration's name", () => {
		let constant = statement("ConstantDeclarationStatement", "origin")
		let declaration = statement("FunctionStatement", "shift")

		expect(typedExpressionAt(program, constant.name.position)).toBeNull()
		expect(typedExpressionAt(program, declaration.name.position)).toBeNull()
	})

	it("should answer nothing at a Method's own Function", () => {
		let namespace = statement("NamespaceDefinitionStatement", "Points")
		let method = namespace.methods["sum"] as common.typed.SimpleMethod

		expect(typedExpressionAt(program, method.method.position)).toBeNull()
	})

	it("should answer a Function Invocation's callee", () => {
		let invocation = valueOf("moved") as common.typed.FunctionInvocationNode

		expect(typedExpressionAt(program, invocation.name.position)).toBe(
			invocation.name,
		)
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
