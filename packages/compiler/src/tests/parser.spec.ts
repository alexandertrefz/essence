import { describe, expect, it } from "bun:test"

import type { parser } from "@essence-lang/interfaces"

import { containsErrors } from "../diagnostics/index"
import { parameterInternalName } from "../helpers/names"
import { parse, parseWithDiagnostics } from "../parser/index"
import { compiles } from "./followedHelps"

describe("Parser", () => {
	describe("Expressions", () => {
		// The Lexer reads `_` as a Symbol wherever it stands, for a wildcard, a
		// labelless Parameter or a Number's group separator. So an underscore in
		// a name is refused, a leading pair included.
		describe("Underscores in names", () => {
			it("should refuse a leading double underscore in Expression position", () => {
				let { diagnostics } = parseWithDiagnostics(
					"implementation { __print(1) }",
				)

				expect(containsErrors(diagnostics)).toBe(true)
			})

			it("should refuse a leading double underscore where a name is declared", () => {
				let { diagnostics } = parseWithDiagnostics(
					"implementation { constant __value = 1 }",
				)

				expect(containsErrors(diagnostics)).toBe(true)
			})

			it("should refuse an underscore in the middle of a name", () => {
				let { diagnostics } = parseWithDiagnostics(
					"implementation { foo_bar(1) }",
				)

				expect(containsErrors(diagnostics)).toBe(true)
			})
		})

		describe("MethodInvocations", () => {
			it("should parse MethodInvocation with 0 external parameters", () => {
				let input: parser.Program = parse(
					"implementation { lookup::member() }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse MethodInvocation", () => {
				let input: parser.Program = parse(
					"implementation { lookup::member(argument) }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse chained MethodInvocations", () => {
				let input: parser.Program = parse(
					"implementation { lookup::member(argument)::member(argument) }",
				)

				expect(input).toMatchSnapshot()
			})
		})

		describe("FunctionInvocations", () => {
			it("should parse Identifier FunctionInvocations with one argument", () => {
				let input: parser.Program = parse(
					"implementation { invocation(argument) }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse Identifier FunctionInvocations with one labelled argument", () => {
				let input: parser.Program = parse(
					"implementation { invocation(label argument) }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse Identifier FunctionInvocations with labelled arguments that is 'with'", () => {
				let input: parser.Program = parse(
					"implementation { invocation(with argument) }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse Identifier FunctionInvocations with labelled arguments that is 'case'", () => {
				let input: parser.Program = parse(
					"implementation { invocation(case argument) }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse Identifier FunctionInvocations with labelled arguments that is 'static'", () => {
				let input: parser.Program = parse(
					"implementation { invocation(static argument) }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse a bare Case value as a labelled argument, the space before `#` keeping the label distinct from a Choice prefix", () => {
				let input: parser.Program = parse(
					"implementation { invocation(at #Start) }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse an adjacent `Choice#Case` as a prefixed Case value passed positionally", () => {
				let input: parser.Program = parse(
					"implementation { invocation(Side#Start) }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse a Case value with its Choice's Type Arguments applied", () => {
				let input: parser.Program = parse(
					"implementation { invocation(Box<Integer>#Full(1)) }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse Identifier FunctionInvocations with one argument and a trailing comma", () => {
				let input: parser.Program = parse(
					"implementation { invocation(argument,) }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse Identifier FunctionInvocations with two arguments", () => {
				let input: parser.Program = parse(
					"implementation { invocation(argument, argument2) }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse Identifier FunctionInvocations with two arguments and a trailing comma", () => {
				let input: parser.Program = parse(
					"implementation { invocation(argument, argument2,) }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse Identifier FunctionInvocations with more than two arguments", () => {
				let input: parser.Program = parse(
					"implementation { invocation(argument, argument2, argument3) }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse Identifier FunctionInvocations with more than two arguments and a trailing comma", () => {
				let input: parser.Program = parse(
					"implementation { invocation(argument, argument2, argument3,) }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse Lookup FunctionInvocations with more than two arguments and a trailing comma", () => {
				let input: parser.Program = parse(
					"implementation { record.invocation(argument, argument2, argument3,) }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse multiple FunctionInvocations in a row", () => {
				let input: parser.Program = parse(
					`implementation {
						invocation(argument)
						invocation(argument)
					}`,
				)

				expect(input).toMatchSnapshot()
			})
		})

		describe("Lookups", () => {
			it("should parse simple Lookup", () => {
				let input: parser.Program = parse(
					"implementation { lookup.member }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse complex Lookup", () => {
				let input: parser.Program = parse(
					"implementation { lookup.member1.member2 }",
				)

				expect(input).toMatchSnapshot()
			})
		})

		describe("Member paths", () => {
			let pathOf = (source: string): parser.ExpressionNode => {
				let node = parse(
					`implementation { constant value = ${source} }`,
				).implementation
					.nodes[0] as parser.ConstantDeclarationStatementNode

				return node.value
			}

			let stepsOf = (node: parser.ExpressionNode): Array<string> =>
				node.nodeType === "MemberPath"
					? node.steps.map((step) => step.content)
					: []

			it("should read a leading dot as a path", () => {
				expect(stepsOf(pathOf(".price"))).toEqual(["price"])
			})

			// Every step belongs to the path, since a Lookup over a path means
			// nothing downstream.
			it("should read every step of a path", () => {
				expect(stepsOf(pathOf(".address.city.name"))).toEqual([
					"address",
					"city",
					"name",
				])
			})

			it("should span the path from its dot to its last step", () => {
				expect(pathOf(".address.city").position).toEqual({
					start: { line: 1, column: 35 },
					end: { line: 1, column: 48 },
				})
			})

			it("should give each step the span it was written at", () => {
				let node = pathOf(".address.city")

				expect(
					node.nodeType === "MemberPath"
						? node.steps.map((step) => step.position)
						: [],
				).toEqual([
					{
						start: { line: 1, column: 36 },
						end: { line: 1, column: 43 },
					},
					{
						start: { line: 1, column: 44 },
						end: { line: 1, column: 48 },
					},
				])
			})

			// A dot flush against a name continues it. A dot with a space in
			// front opens a path, and the name before it is a label.
			it("should read an adjacent dot as a Lookup", () => {
				let node = parse("implementation { call(order.isPaid) }")
					.implementation.nodes[0] as parser.FunctionInvocationNode

				expect(node.arguments[0]?.name).toBeNull()
				expect(node.arguments[0]?.value.nodeType).toBe("Lookup")
			})

			it("should read a spaced dot as a labelled path", () => {
				let node = parse("implementation { call(where .isPaid) }")
					.implementation.nodes[0] as parser.FunctionInvocationNode

				expect(node.arguments[0]?.name?.content).toBe("where")
				expect(stepsOf(node.arguments[0]!.value)).toEqual(["isPaid"])
			})

			it("should read an unlabelled path", () => {
				let node = parse("implementation { call(.isPaid) }")
					.implementation.nodes[0] as parser.FunctionInvocationNode

				expect(node.arguments[0]?.name).toBeNull()
				expect(stepsOf(node.arguments[0]!.value)).toEqual(["isPaid"])
			})

			it("should read a path in a List Literal", () => {
				let node = pathOf("[.price, .name]")

				expect(
					node.nodeType === "ListValue"
						? node.values.map((value) => stepsOf(value))
						: [],
				).toEqual([["price"], ["name"]])
			})
		})

		describe("Identifiers", () => {
			it("should parse Identifiers", () => {
				let input: parser.Program = parse(
					"implementation { identifier }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse 'with' as Identifier", () => {
				let input: parser.Program = parse("implementation { with }")

				expect(input).toMatchSnapshot()
			})

			it("should parse 'static' as Identifier", () => {
				let input: parser.Program = parse("implementation { static }")

				expect(input).toMatchSnapshot()
			})

			it("should parse 'case' as Identifier", () => {
				let input: parser.Program = parse("implementation { case }")

				expect(input).toMatchSnapshot()
			})
		})

		describe("Self", () => {
			it("should parse @", () => {
				let input: parser.Program = parse("implementation { @ }")

				expect(input).toMatchSnapshot()
			})
		})

		describe("Combination", () => {
			it("should parse 2 identifier combinations", () => {
				let input: parser.Program = parse(
					"implementation { { base with override } }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse inline combinations", () => {
				let input: parser.Program = parse(
					"implementation { { base with someKey = someValue } }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse inline combinations with trailing commas", () => {
				let input: parser.Program = parse(
					"implementation { { base with someKey = someValue, } }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse inline combinations with multiple keys", () => {
				let input: parser.Program = parse(
					"implementation { { base with someKey = someValue, someOtherKey = someOtherValue, } }",
				)

				expect(input).toMatchSnapshot()
			})
		})

		// `{ x }` is `{ x = x }` in a Record Literal's member list, never in an
		// update's key list, where a bare name is the value merged in.
		describe("Property shorthand", () => {
			let recordOf = (source: string): parser.RecordValueNode => {
				let node = parse(
					`implementation { constant value = ${source} }`,
				).implementation
					.nodes[0] as parser.ConstantDeclarationStatementNode

				return node.value as parser.RecordValueNode
			}

			let membersOf = (
				record: parser.RecordValueNode,
			): Array<[string, string, boolean]> =>
				Object.entries(record.members).map(([key, member]) => [
					key,
					member.value!.nodeType === "Identifier"
						? member.value!.content
						: member.value!.nodeType,
					member.shorthand === true,
				])

			it("should read a bare name as its own value", () => {
				expect(membersOf(recordOf("{ x, y }"))).toEqual([
					["x", "x", true],
					["y", "y", true],
				])
			})

			it("should mark only the members that were written bare", () => {
				expect(membersOf(recordOf("{ x, y = 2 }"))).toEqual([
					["x", "x", true],
					["y", "IntegerValue", false],
				])
			})

			// A rename of either expands the member from the shared Position.
			it("should give the name and the value one Position", () => {
				let member = recordOf("{ x }").members["x"]!

				expect(member.value!.position).toEqual(member.name.position)
			})

			it("should read a bare name in a typed Record Literal", () => {
				let node = parse(
					"implementation { constant value = Point ~> { x, y } }",
				).implementation
					.nodes[0] as parser.ConstantDeclarationStatementNode
				let record = node.value as parser.RecordValueNode

				expect(membersOf(record)).toEqual([
					["x", "x", true],
					["y", "y", true],
				])
			})

			it("should read a bare name in a Case payload", () => {
				let node = parse(
					"implementation { constant value = #Rectangle({ width, height }) }",
				).implementation
					.nodes[0] as parser.ConstantDeclarationStatementNode
				let payload = (node.value as parser.CaseValueNode)
					.value as parser.RecordValueNode

				expect(membersOf(payload)).toEqual([
					["width", "width", true],
					["height", "height", true],
				])
			})

			it("should read a bare name in a Literal that is a member's value", () => {
				let outer = recordOf("{ server = { port, host } }")
				let inner = outer.members["server"]!
					.value as parser.RecordValueNode

				expect(membersOf(inner)).toEqual([
					["port", "port", true],
					["host", "host", true],
				])
			})

			it("should read a bare name in a Literal merged by an update", () => {
				let node = parse(
					"implementation { constant value = { base with { port, host } } }",
				).implementation
					.nodes[0] as parser.ConstantDeclarationStatementNode
				let combination = node.value as parser.CombinationNode

				expect(
					membersOf(combination.rhs as parser.RecordValueNode),
				).toEqual([
					["port", "port", true],
					["host", "host", true],
				])
			})

			// `{ base with other }` merges a whole value, not a member.
			it("should keep a bare name after 'with' as the value being merged", () => {
				let node = parse(
					"implementation { constant value = { base with other } }",
				).implementation
					.nodes[0] as parser.ConstantDeclarationStatementNode
				let combination = node.value as parser.CombinationNode

				expect(combination.rhs.nodeType).toBe("Identifier")
			})

			// Whether a bare name is a binding is the Scope's to say, so the
			// Enricher reports it. The update is kept as the author meant it.
			it("should keep a bare name in an update's key list for the Enricher", () => {
				let { diagnostics } = parseWithDiagnostics(
					"implementation { constant value = { base with a = 1, host } }",
				)
				let node = parse(
					"implementation { constant value = { base with a = 1, host } }",
				).implementation
					.nodes[0] as parser.ConstantDeclarationStatementNode
				let combination = node.value as parser.CombinationNode

				expect(diagnostics).toEqual([])
				expect(combination.bare).toBe(true)
				expect(
					(combination.rhs as parser.RecordValueNode).members["host"]
						?.shorthand,
				).toBe(true)
			})

			// Only a bare name gets the shorthand explanation.
			it("should leave a list broken for another reason to the Parser", () => {
				let { diagnostics } = parseWithDiagnostics(
					"implementation { constant value = { base with a = , } }",
				)

				expect(
					diagnostics.map((diagnostic) => diagnostic.code),
				).toEqual(["syntax-error"])
			})

			// The Literal reading of `{ base with … }` is tried first and thrown
			// away, and must report nothing.
			it("should leave nothing behind when the Literal reading is thrown away", () => {
				let { diagnostics } = parseWithDiagnostics(
					"implementation { constant value = { base with base = 1 } }",
				)

				expect(diagnostics).toEqual([])
			})

			it("should still report a member written twice", () => {
				let { diagnostics } = parseWithDiagnostics(
					"implementation { constant value = { x, x } }",
				)

				expect(
					diagnostics.map((diagnostic) => diagnostic.code),
				).toEqual(["duplicate-member"])
			})
		})

		// `server.port = 8080` reaches into the value being updated. The Parser
		// reads one in every key position, and the Enricher refuses where it
		// means nothing. See "Path keys" in
		// packages/compiler/src/enricher/DEVELOPMENT.md.
		describe("Path keys", () => {
			let combinationOf = (source: string): parser.CombinationNode => {
				let node = parse(
					`implementation { constant value = ${source} }`,
				).implementation
					.nodes[0] as parser.ConstantDeclarationStatementNode

				return node.value as parser.CombinationNode
			}

			let keysOf = (
				record: parser.RecordValueNode,
			): Array<[string, Array<string> | null]> =>
				Object.entries(record.members).map(([key, member]) => [
					key,
					member.steps?.map((step) => step.content) ?? null,
				])

			it("should key a path member by its dotted spelling", () => {
				let combination = combinationOf(
					"{ config with server.port = 8080 }",
				)

				expect(
					keysOf(combination.rhs as parser.RecordValueNode),
				).toEqual([["server.port", ["server", "port"]]])
			})

			it("should read every step of a longer path", () => {
				let combination = combinationOf(
					"{ config with server.tls.enabled = true }",
				)

				expect(
					keysOf(combination.rhs as parser.RecordValueNode),
				).toEqual([
					["server.tls.enabled", ["server", "tls", "enabled"]],
				])
			})

			// `name` is the first step, so a reader that knows nothing of paths
			// still works.
			it("should point a path member's name at its first step", () => {
				let combination = combinationOf(
					"{ config with server.port = 8080 }",
				)
				let member = (combination.rhs as parser.RecordValueNode)
					.members["server.port"]!

				expect(member.name.content).toBe("server")
				expect(member.name).toBe(member.steps![0]!)
			})

			it("should leave a plain key with no steps at all", () => {
				let combination = combinationOf("{ config with name = 'a' }")

				expect(
					keysOf(combination.rhs as parser.RecordValueNode),
				).toEqual([["name", null]])
			})

			it("should keep two paths that share a prefix apart", () => {
				let combination = combinationOf(
					"{ config with server.port = 1, server.host = 'db' }",
				)

				expect(
					keysOf(combination.rhs as parser.RecordValueNode),
				).toEqual([
					["server.port", ["server", "port"]],
					["server.host", ["server", "host"]],
				])
			})

			it("should read a path key in a plain Record Literal", () => {
				let node = parse(
					"implementation { constant value = { server.port = 1 } }",
				).implementation
					.nodes[0] as parser.ConstantDeclarationStatementNode

				expect(keysOf(node.value as parser.RecordValueNode)).toEqual([
					["server.port", ["server", "port"]],
				])
			})

			// The left side of an update is an Expression, and a Lookup chain is
			// one.
			it("should leave a Lookup chain before 'with' as the value updated", () => {
				let combination = combinationOf(
					"{ config.server with port = 1 }",
				)

				expect(combination.lhs.nodeType).toBe("Lookup")
			})

			// A lone path is an Expression, so it merges the value, as
			// `{ base with other }` does.
			it("should read a lone path after 'with' as the value merged", () => {
				let combination = combinationOf("{ config with server.tls }")

				expect(combination.rhs.nodeType).toBe("Lookup")
			})

			// Whether the last step names a binding is the Scope's to say, so
			// the Enricher reports it. See "Path keys" in
			// packages/compiler/src/enricher/DEVELOPMENT.md.
			it("should keep a path key written with no value for the Enricher", () => {
				let { diagnostics } = parseWithDiagnostics(
					"implementation { constant value = { config with server.port, name = 'a' } }",
				)
				let member = (
					combinationOf("{ config with server.port, name = 'a' }")
						.rhs as parser.RecordValueNode
				).members["server.port"]!

				expect(diagnostics).toEqual([])
				expect(member.shorthand).toBe(true)
				expect(member.steps?.map((step) => step.content)).toEqual([
					"server",
					"port",
				])
			})

			it("should refuse a key that a path already writes", () => {
				let { diagnostics } = parseWithDiagnostics(
					"implementation { constant value = { config with server = s, server.port = 1 } }",
				)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0]!.code).toBe("duplicate-member")
				expect(diagnostics[0]!.message).toBe(
					"Member 'server.port' and 'server' both write 'server'",
				)
			})

			it("should refuse the same path written twice", () => {
				let { diagnostics } = parseWithDiagnostics(
					"implementation { constant value = { config with server.port = 1, server.port = 2 } }",
				)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0]!.message).toBe(
					"Member 'server.port' is already defined",
				)
			})

			// After a step's dot, a `{` opens a descend and an Identifier
			// continues the path.
			it("should read a braced descend as a member list one level down", () => {
				let combination = combinationOf(
					"{ config with server.{ port = 1, host = 'db' } }",
				)
				let member = (combination.rhs as parser.RecordValueNode)
					.members["server"]!

				expect(member.value).toBeNull()
				expect(member.steps?.map((step) => step.content)).toEqual([
					"server",
				])
				expect(Object.keys(member.group!.members)).toEqual([
					"port",
					"host",
				])
			})

			it("should read a descend after a longer path", () => {
				let combination = combinationOf(
					"{ config with server.tls.{ enabled = true } }",
				)
				let member = (combination.rhs as parser.RecordValueNode)
					.members["server.tls"]!

				expect(member.steps?.map((step) => step.content)).toEqual([
					"server",
					"tls",
				])
				expect(Object.keys(member.group!.members)).toEqual(["enabled"])
			})

			it("should read a descend inside a descend", () => {
				let combination = combinationOf(
					"{ config with server.{ tls.{ enabled = true } } }",
				)
				let outer = (combination.rhs as parser.RecordValueNode).members[
					"server"
				]!
				let inner = outer.group!.members["tls"]!

				expect(Object.keys(inner.group!.members)).toEqual(["enabled"])
			})

			// Inside a descend no bare name can be the whole value merged, so
			// shorthand is allowed there.
			it("should read a bare name inside a descend as its own value", () => {
				let combination = combinationOf(
					"{ config with server.{ port } }",
				)
				let member = (combination.rhs as parser.RecordValueNode)
					.members["server"]!
				let inner = member.group!.members["port"]!

				expect(inner.shorthand).toBe(true)
				expect((inner.value as parser.IdentifierNode).content).toBe(
					"port",
				)
			})

			it("should refuse a descend with nothing in it", () => {
				let { diagnostics } = parseWithDiagnostics(
					"implementation { constant value = { config with server.{} } }",
				)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0]!.code).toBe("empty-path-group")
			})

			it("should refuse a key a descend already writes", () => {
				let { diagnostics } = parseWithDiagnostics(
					"implementation { constant value = { config with server.{ port = 1 }, server.host = 'd' } }",
				)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0]!.code).toBe("duplicate-member")
			})

			it("should keep a bare path inside a descend", () => {
				let { diagnostics } = parseWithDiagnostics(
					"implementation { constant value = { config with server.{ tls.enabled } } }",
				)

				expect(diagnostics).toEqual([])
			})

			// The boundary is the dot, so `serverPort` is no part of `server`.
			it("should leave a key that merely starts the same alone", () => {
				let { diagnostics } = parseWithDiagnostics(
					"implementation { constant value = { config with server = s, serverPort = 1 } }",
				)

				expect(diagnostics).toEqual([])
			})

			// A path key is read the same in every key position, so a key
			// list's refusals hold for a Literal merged into a default too.
			describe("in a Literal merged into a default", () => {
				it("should keep a path key written with no value", () => {
					let { diagnostics } = parseWithDiagnostics(
						"implementation { constant value = connect(using { server.port }) }",
					)

					expect(diagnostics).toEqual([])
				})

				it("should refuse a descend with nothing in it", () => {
					let { diagnostics } = parseWithDiagnostics(
						"implementation { constant value = connect(using { server.{} }) }",
					)

					expect(diagnostics).toHaveLength(1)
					expect(diagnostics[0]!.code).toBe("empty-path-group")
				})

				it("should refuse a key that a path already writes", () => {
					let { diagnostics } = parseWithDiagnostics(
						"implementation { constant value = connect(using { server = s, server.port = 1 }) }",
					)

					expect(diagnostics).toHaveLength(1)
					expect(diagnostics[0]!.code).toBe("duplicate-member")
				})

				// A descend holds a member list, where a plain key takes the
				// shorthand.
				it("should take the shorthand inside a descend", () => {
					let { diagnostics } = parseWithDiagnostics(
						"implementation { constant value = connect(using { server.{ port } }) }",
					)

					expect(diagnostics).toEqual([])
				})

				it("should keep a path key with no value in a payload", () => {
					let { diagnostics } = parseWithDiagnostics(
						"implementation { constant value = #Get({ limits.calls }) }",
					)

					expect(diagnostics).toEqual([])
				})
			})
		})

		describe("Literals", () => {
			describe("StringInterpolation", () => {
				let onlyExpression = (
					source: string,
				): parser.ExpressionNode => {
					let node = parse(`implementation { ${source} }`)
						.implementation.nodes[0]

					return node as parser.ExpressionNode
				}

				it("should parse a hole as its own Expression segment", () => {
					let node = onlyExpression('"a {name} b"')

					expect(node.nodeType).toBe("InterpolatedStringValue")

					let interpolated =
						node as parser.InterpolatedStringValueNode

					expect(
						interpolated.segments.map((segment) => segment.kind),
					).toEqual(["text", "expression", "text"])
					expect(
						(interpolated.segments[0] as { value: string }).value,
					).toBe("a ")
					expect(
						(interpolated.segments[2] as { value: string }).value,
					).toBe(" b")

					let hole = interpolated.segments[1] as {
						expression: parser.ExpressionNode
					}
					expect(hole.expression.nodeType).toBe("Identifier")
					expect(
						(hole.expression as parser.IdentifierNode).content,
					).toBe("name")
				})

				it("should parse a full Expression inside a hole", () => {
					let node = onlyExpression(
						'"total {price::add(tax)}"',
					) as parser.InterpolatedStringValueNode

					let hole = node.segments[1] as {
						expression: parser.ExpressionNode
					}
					expect(hole.expression.nodeType).toBe("MethodInvocation")
				})

				it("should keep a String with no hole a plain StringValue", () => {
					expect(onlyExpression('"no holes"').nodeType).toBe(
						"StringValue",
					)
				})

				it("should refuse an interpolated String in a Matcher", () => {
					let { diagnostics } = parseWithDiagnostics(
						`implementation {
							constant x = match "a" -> String {
								case "h{x}i" { <- "y" }
								case _ { <- "n" }
							}
						}`,
					)

					expect(containsErrors(diagnostics)).toBe(true)
				})
			})

			describe("FunctionLiterals", () => {
				it("should parse FunctionLiterals with no parameters", () => {
					let input: parser.Program = parse(
						"implementation { () -> Type {} }",
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse FunctionLiterals with one parameter with explicit external name", () => {
					let input: parser.Program = parse(
						`implementation {
						(external internal: Type) -> Type {
							<- internal
						}
					}`,
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse FunctionLiterals with one parameter with implicit external name", () => {
					let input: parser.Program = parse(
						`implementation {
						(internal: Type) -> Type {
							<- internal
						}
					}`,
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse FunctionLiterals with one parameter without external name", () => {
					let input: parser.Program = parse(
						`implementation {
						(_ internal: Type) -> Type {
							<- internal
						}
					}`,
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse FunctionLiterals with two parameters", () => {
					let input: parser.Program = parse(
						`implementation {
						(external internal: Type, external2 internal2: Type) -> Type {
							<- internal
						}
					}`,
					)

					expect(input).toMatchSnapshot()
				})
			})

			describe("GenericFunctionLiterals", () => {
				it("should parse GenericFunctionLiterals with no parameters", () => {
					let input: parser.Program = parse(
						"implementation { <Generic>() -> Generic {} }",
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse GenericFunctionLiterals with one parameter with explicit external name", () => {
					let input: parser.Program = parse(
						`implementation {
						<Generic>(external internal: Generic) -> Generic {
							<- internal
						}
					}`,
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse GenericFunctionLiterals with one parameter with implicit external name", () => {
					let input: parser.Program = parse(
						`implementation {
						<Generic>(internal: Generic) -> Generic {
							<- internal
						}
					}`,
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse GenericFunctionLiterals with one parameter without external name", () => {
					let input: parser.Program = parse(
						`implementation {
						<Generic>(_ internal: Generic) -> Generic {
							<- internal
						}
					}`,
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse FunctionLiterals with two parameters", () => {
					let input: parser.Program = parse(
						`implementation {
						<Generic>(external internal: Generic, external2 internal2: Generic) -> Generic {
							<- internal
						}
					}`,
					)

					expect(input).toMatchSnapshot()
				})
			})

			describe("AnonymousRecordLiteral", () => {
				// `{}`, the unit value, is an ordinary Record Literal with no
				// members, with no Node or Keyword of its own.
				it("should parse an empty AnonymousRecordLiteral", () => {
					let input: parser.Program = parse("implementation { {} }")

					expect(input).toMatchSnapshot()
				})

				it("should parse AnonymousRecordLiterals with a KeyValuePair", () => {
					let input: parser.Program = parse(
						"implementation { { key = value } }",
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse AnonymousRecordLiterals with a KeyValuePair with a trailing comma", () => {
					let input: parser.Program = parse(
						"implementation { { key = value, } }",
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse AnonymousRecordLiterals with multiple KeyValuePairs", () => {
					let input: parser.Program = parse(
						"implementation { { key = value, key2 = value2 } }",
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse AnonymousRecordLiterals with multiple KeyValuePairs with a trailing comma", () => {
					let input: parser.Program = parse(
						"implementation { { key = value, key2 = value2, } }",
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse AnonymousRecordLiterals with nested KeyValuePairs", () => {
					let input: parser.Program = parse(
						"implementation { { key = { key = value } } }",
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse AnonymousRecordLiterals with nested KeyValuePairs and some Linebreaks", () => {
					let input: parser.Program = parse(
						`implementation {
						{
							key = {
								key = value
							}
						}
					}`,
					)

					expect(input).toMatchSnapshot()
				})
			})

			describe("TypedRecordLiterals", () => {
				it("should parse TypedRecordLiterals with a KeyValuePair", () => {
					let input: parser.Program = parse(
						"implementation { Type ~> { key = value } }",
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse TypedRecordLiterals with a KeyValuePair with a trailing comma", () => {
					let input: parser.Program = parse(
						"implementation { Type ~> { key = value, } }",
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse TypedRecordLiterals with multiple KeyValuePairs", () => {
					let input: parser.Program = parse(
						"implementation { Type ~> { key = value, key2 = value2 } }",
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse TypedRecordLiterals with multiple KeyValuePairs with a trailing comma", () => {
					let input: parser.Program = parse(
						"implementation { Type ~> { key = value, key2 = value2, } }",
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse TypedRecordLiterals with nested KeyValuePairs and some Linebreaks", () => {
					let input: parser.Program = parse(
						`implementation {
						Type ~> {
							key = Type ~> {
								key = value
							}
						}
					}`,
					)

					expect(input).toMatchSnapshot()
				})
			})

			describe("BooleanLiterals", () => {
				it("should parse 'true' BooleanLiterals", () => {
					let input: parser.Program = parse("implementation { true }")

					expect(input).toMatchSnapshot()
				})

				it("should parse 'false' BooleanLiterals", () => {
					let input: parser.Program = parse(
						"implementation { false }",
					)

					expect(input).toMatchSnapshot()
				})
			})

			describe("StringLiterals", () => {
				it("should parse empty StringLiterals", () => {
					let input: parser.Program = parse(`implementation { "" }`)

					expect(input).toMatchSnapshot()
				})

				it("should parse filled StringLiterals", () => {
					let input: parser.Program = parse(
						`implementation { "string" }`,
					)

					expect(input).toMatchSnapshot()
				})
			})

			describe("IntegerLiterals", () => {
				it("should parse IntegerLiterals", () => {
					let input: parser.Program = parse("implementation { 123 }")

					expect(input).toMatchSnapshot()
				})

				it("should parse IntegerLiterals with an underscore", () => {
					let input: parser.Program = parse(
						"implementation { 1_000 }",
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse IntegerLiterals with multiple underscores", () => {
					let input: parser.Program = parse(
						"implementation { 1_000_000 }",
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse negative IntegerLiterals", () => {
					let input: parser.Program = parse("implementation { -123 }")

					expect(input).toMatchSnapshot()
				})

				it("should parse negative IntegerLiterals with an underscore", () => {
					let input: parser.Program = parse(
						"implementation { -1_000 }",
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse negative IntegerLiterals with multiple underscores", () => {
					let input: parser.Program = parse(
						"implementation { -1_000_000 }",
					)

					expect(input).toMatchSnapshot()
				})
			})

			describe("RationalLiterals", () => {
				it("should parse RationalLiterals", () => {
					let input: parser.Program = parse("implementation { 3/2 }")

					expect(input).toMatchSnapshot()
				})

				it("should parse RationalLiterals with underscores", () => {
					let input: parser.Program = parse(
						"implementation { 1_000/9 }",
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse negative numerator RationalLiterals", () => {
					let input: parser.Program = parse("implementation { -3/2 }")

					expect(input).toMatchSnapshot()
				})

				it("should parse negative denominator RationalLiterals", () => {
					let input: parser.Program = parse("implementation { 3/-2 }")

					expect(input).toMatchSnapshot()
				})

				it("should parse fully negative RationalLiterals", () => {
					let input: parser.Program = parse(
						"implementation { -3/-2 }",
					)

					expect(input).toMatchSnapshot()
				})
			})

			// A decimal is a second spelling of a Rational, with no Node or
			// scale of its own. The snapshots pin the fraction it stands for.
			describe("DecimalLiterals", () => {
				it("should parse DecimalLiterals", () => {
					let input: parser.Program = parse("implementation { 0.75 }")

					expect(input).toMatchSnapshot()
				})

				it("should parse DecimalLiterals with underscores", () => {
					let input: parser.Program = parse(
						"implementation { 1_000.000_1 }",
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse negative DecimalLiterals", () => {
					let input: parser.Program = parse("implementation { -0.5 }")

					expect(input).toMatchSnapshot()
				})

				it("should parse whole DecimalLiterals", () => {
					let input: parser.Program = parse("implementation { 2.0 }")

					expect(input).toMatchSnapshot()
				})

				it("should parse DecimalLiterals with a trailing zero", () => {
					let input: parser.Program = parse("implementation { 1.50 }")

					expect(input).toMatchSnapshot()
				})
			})

			describe("ListLiterals", () => {
				it("should parse an empty List", () => {
					let input: parser.Program = parse("implementation { [] }")

					expect(input).toMatchSnapshot()
				})

				it("should parse an List with a single item", () => {
					let input: parser.Program = parse("implementation { [0] }")

					expect(input).toMatchSnapshot()
				})

				it("should parse an List with multiple items", () => {
					let input: parser.Program = parse(
						"implementation { [0, 1, 2,] }",
					)

					expect(input).toMatchSnapshot()
				})
			})
		})

		describe("Match", () => {
			it("should parse match expression with function invocation", () => {
				let input: parser.Program = parse(
					`implementation {
						match expression() -> Integer {
							case Integer {
								<- 1
							}

							case Rational {
								<- 2
							}
						}
					}`,
				)

				expect(input).toMatchSnapshot()
			})
		})

		describe("Define", () => {
			it("should parse a define Expression", () => {
				let input: parser.Program = parse(
					`implementation {
						constant grade = define {
							as "A" if score::isGreaterThanOrEqualTo(90)
							as "B" if score::isGreaterThanOrEqualTo(80)
							as "F" otherwise
						}
					}`,
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse a define Expression with a declared answer Type", () => {
				let input: parser.Program = parse(
					`implementation {
						constant grade = define -> String {
							as "A" if score::isGreaterThanOrEqualTo(90)
							as "F" otherwise
						}
					}`,
				)

				expect(input).toMatchSnapshot()
			})

			// An `otherwise` arm on its own is a whole `define`.
			it("should parse a define Expression that is nothing but its otherwise arm", () => {
				let input: parser.Program = parse(
					`implementation {
						constant grade = define {
							as "F" otherwise
						}
					}`,
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse a define Expression as an Argument", () => {
				let input: parser.Program = parse(
					`implementation {
						report(define {
							as 1 if flag
							as 0 otherwise
						})
					}`,
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse a define Expression as a Record member's value", () => {
				let input: parser.Program = parse(
					`implementation {
						constant row = {
							grade = define {
								as 1 if flag
								as 0 otherwise
							},
						}
					}`,
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse a define Expression inside a Match Handler's body", () => {
				let input: parser.Program = parse(
					`implementation {
						match value -> Integer {
							case Integer {
								<- define {
									as 1 if flag
									as 0 otherwise
								}
							}
						}
					}`,
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse a define Expression inside a define Expression", () => {
				let input: parser.Program = parse(
					`implementation {
						constant grade = define {
							as define {
								as 1 if inner
								as 2 otherwise
							} if flag
							as 0 otherwise
						}
					}`,
				)

				expect(input).toMatchSnapshot()
			})

			// The `as` separates arms, not the layout. An Expression ends at the
			// first Token that can not carry it on.
			it("should parse arms written on one line", () => {
				let input: parser.Program = parse(
					`implementation {
						constant grade = define { as 1 if flag as 0 otherwise }
					}`,
				)

				expect(input).toMatchSnapshot()
			})

			// `otherwise` is a valid Identifier. An arm's value stops at the
			// arm's closing word, and the Token after the value says which arm it
			// was.
			it("should parse an arm whose value is a name spelled otherwise", () => {
				let { program, diagnostics } = parseWithDiagnostics(
					`implementation {
						constant grade = define {
							as otherwise if flag
							as otherwise otherwise
						}
					}`,
				)

				expect(diagnostics).toEqual([])

				let node = program.implementation.nodes[0]

				if (node.nodeType === "ConstantDeclarationStatement") {
					expect(node.value).toMatchObject({
						nodeType: "Define",
						arms: [
							{
								value: {
									nodeType: "Identifier",
									content: "otherwise",
								},
								condition: {
									nodeType: "Identifier",
									content: "flag",
								},
							},
						],
						otherwise: {
							value: {
								nodeType: "Identifier",
								content: "otherwise",
							},
						},
					})
				}
			})

			it("should parse an arm whose value calls a Method named otherwise", () => {
				let { program, diagnostics } = parseWithDiagnostics(
					`implementation {
						constant grade = define {
							as value::otherwise(0) if flag
							as value::otherwise(1) otherwise
						}
					}`,
				)

				expect(diagnostics).toEqual([])

				let node = program.implementation.nodes[0]

				if (node.nodeType === "ConstantDeclarationStatement") {
					expect(node.value).toMatchObject({
						nodeType: "Define",
						arms: [
							{
								value: {
									nodeType: "MethodInvocation",
									member: { content: "otherwise" },
								},
							},
						],
						otherwise: {
							value: {
								nodeType: "MethodInvocation",
								member: { content: "otherwise" },
							},
						},
					})
				}
			})

			it("should parse an arm whose value is a Record with an otherwise member", () => {
				let { program, diagnostics } = parseWithDiagnostics(
					`implementation {
						constant grade = define {
							as { otherwise = 1 } if flag
							as { otherwise = 2 } otherwise
						}
					}`,
				)

				expect(diagnostics).toEqual([])

				let node = program.implementation.nodes[0]

				if (
					node.nodeType === "ConstantDeclarationStatement" &&
					node.value.nodeType === "Define"
				) {
					expect(node.value.arms).toHaveLength(1)
					expect(node.value.arms[0].value.nodeType).toBe(
						"RecordValue",
					)
					expect(node.value.otherwise.value.nodeType).toBe(
						"RecordValue",
					)
				}
			})
		})
	})

	describe("Statements", () => {
		describe("ReturnStatements", () => {
			it("should parse ReturnStatements", () => {
				let input: parser.Program = parse(
					"implementation { <- identifier }",
				)

				expect(input).toMatchSnapshot()
			})
		})

		describe("IfStatements", () => {
			it("should parse IfStatements", () => {
				let input: parser.Program = parse(
					"implementation { if identifier {} }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse IfElseStatements", () => {
				let input: parser.Program = parse(
					"implementation { if identifier {} else {} }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse IfElse-If-Statements", () => {
				let input: parser.Program = parse(
					"implementation { if identifier {} else if identifier2 {} }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse IfElse-IfElse-Statements", () => {
				let input: parser.Program = parse(
					"implementation { if identifier {} else if identifier2 {} else {} }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse IfElse-IfElse-If-Statements", () => {
				let input: parser.Program = parse(
					"implementation { if identifier {} else if identifier2 {} else if identifier3 {} }",
				)

				expect(input).toMatchSnapshot()
			})
		})

		describe("ConstantDeclarationStatements", () => {
			it("should parse ConstantDeclarationStatement without Type", () => {
				let input: parser.Program = parse(
					`implementation { constant identifier = "" }`,
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse ConstantDeclarationStatement with Type", () => {
				let input: parser.Program = parse(
					`implementation { constant identifier: String = "" }`,
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse ConstantDeclarationStatement with empty Record Type", () => {
				let input: parser.Program = parse(
					"implementation { constant identifier: {} = {} }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse ConstantDeclarationStatement with simple Record Type", () => {
				let input: parser.Program = parse(
					`implementation { constant identifier: { key: String } = { key = "" } }`,
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse ConstantDeclarationStatement with complex Record Type", () => {
				let input: parser.Program = parse(
					"implementation { constant identifier: { key: { key: Integer | Rational } } = { key = { key = 1 } } }",
				)

				expect(input).toMatchSnapshot()
			})
		})

		describe("VariableDeclarationStatements", () => {
			it("should parse VariableDeclarationStatement without Type", () => {
				let input: parser.Program = parse(
					`implementation { variable identifier = "" }`,
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse VariableDeclarationStatement with Type", () => {
				let input: parser.Program = parse(
					`implementation { variable identifier: String = "" }`,
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse VariableDeclarationStatement with empty Record Type", () => {
				let input: parser.Program = parse(
					"implementation { variable identifier: {} = {} }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse VariableDeclarationStatement with simple Record Type", () => {
				let input: parser.Program = parse(
					`implementation { variable identifier: { key: String } = { key = "" } }`,
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse VariableDeclarationStatement with complex Record Type", () => {
				let input: parser.Program = parse(
					"implementation { variable identifier: { key: { key: Integer | Rational } } = { key = { key = 1 } } }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse VariableDeclarationStatement with identifier being 'with'", () => {
				let input: parser.Program = parse(
					`implementation { variable with = "" }`,
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse VariableDeclarationStatement with identifier being 'case'", () => {
				let input: parser.Program = parse(
					`implementation { variable case = "" }`,
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse VariableDeclarationStatement with identifier being 'static'", () => {
				let input: parser.Program = parse(
					`implementation { variable static = "" }`,
				)

				expect(input).toMatchSnapshot()
			})
		})

		describe("VariableAssignmentStatements", () => {
			it("should parse VariableAssignmentStatement", () => {
				let input: parser.Program = parse(
					`implementation { identifier = "" }`,
				)

				expect(input).toMatchSnapshot()
			})
		})

		describe("NamespaceDefinitionStatements", () => {
			describe("Untyped Namespaces", () => {
				it("should parse an empty untyped NamespaceDefinitionStatement", () => {
					let input: parser.Program = parse(
						"implementation { namespace Namespace {} }",
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse untyped NamespaceDefinitionStatements with one Constant", () => {
					let input: parser.Program = parse(
						`implementation {
							namespace Namespace {
								static property = Value
							}
						}`,
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse untyped NamespaceDefinitionStatements with multiple Constants", () => {
					let input: parser.Program = parse(
						`implementation {
							namespace Namespace {
								static property = Value
								static property2 = Value2
							}
						}`,
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse untyped NamespaceDefinitionStatements with one static Method", () => {
					let input: parser.Program = parse(
						`implementation {
							namespace Namespace {
								static method(parameter: Type) -> Type {
									<- parameter
								}
							}
						}`,
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse untyped NamespaceDefinitionStatements with multiple static Methods", () => {
					let input: parser.Program = parse(
						`implementation {
							namespace Namespace {
								static method(parameter: Type) -> Type {
									<- parameter
								}

								static method2(parameter: Type) -> Type {
									<- parameter
								}
							}
						}`,
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse untyped NamespaceDefinitionStatements with overloaded static Methods", () => {
					let input: parser.Program = parse(
						`implementation {
							namespace Namespace {
								overload static method {
									(parameter: Type) -> Type {
										<- parameter
									}

									(name parameter: Type) -> Type {
										<- parameter
									}
								}
							}
						}`,
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse untyped NamespaceDefinitionStatements with twice overloaded static Methods", () => {
					let input: parser.Program = parse(
						`implementation {
							namespace Namespace {
								overload static method {
									(parameter: Type) -> Type {
										<- parameter
									}

									(name parameter: Type) -> Type {
										<- parameter
									}

									(item parameter: Type) -> Type {
										<- parameter
									}
								}
							}
						}`,
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse untyped NamespaceDefinitionStatements with static Methods and Constants", () => {
					let input: parser.Program = parse(
						`implementation {
							namespace Namespace {
								static property = PropertyValue

								static method(parameter: Type) -> Type {
									<- parameter
								}
							}
						}`,
					)

					expect(input).toMatchSnapshot()
				})
			})

			describe("Typed Namespaces", () => {
				it("should parse an empty typed NamespaceDefinitionStatement", () => {
					let input: parser.Program = parse(
						"implementation { namespace Namespace for Type {} }",
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse typed NamespaceDefinitionStatements with one Constant", () => {
					let input: parser.Program = parse(
						`implementation {
							namespace Namespace for Type {
								static property = Value
							}
						}`,
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse typed NamespaceDefinitionStatements with multiple Constants", () => {
					let input: parser.Program = parse(
						`implementation {
							namespace Namespace for Type {
								static property = Value
								static property2 = Value2
							}
						}`,
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse typed NamespaceDefinitionStatements with one static Method", () => {
					let input: parser.Program = parse(
						`implementation {
							namespace Namespace for Type {
								static method(parameter: Type) -> Type {
									<- parameter
								}
							}
						}`,
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse typed NamespaceDefinitionStatements with multiple static Methods", () => {
					let input: parser.Program = parse(
						`implementation {
							namespace Namespace for Type {
								static method(parameter: Type) -> Type {
									<- parameter
								}

								static method2(parameter: Type) -> Type {
									<- parameter
								}
							}
						}`,
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse typed NamespaceDefinitionStatements with overloaded static Methods", () => {
					let input: parser.Program = parse(
						`implementation {
							namespace Namespace for Type {
								overload static method {
									(parameter: Type) -> Type {
										<- parameter
									}

									(name parameter: Type) -> Type {
										<- parameter
									}
								}
							}
						}`,
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse typed NamespaceDefinitionStatements with twice overloaded static Methods", () => {
					let input: parser.Program = parse(
						`implementation {
							namespace Namespace for Type {
								overload static method {
									(parameter: Type) -> Type {
										<- parameter
									}

									(name parameter: Type) -> Type {
										<- parameter
									}

									(item parameter: Type) -> Type {
										<- parameter
									}
								}
							}
						}`,
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse typed NamespaceDefinitionStatements with static Methods and Constants", () => {
					let input: parser.Program = parse(
						`implementation {
							namespace Namespace for Type {
								static property = PropertyValue

								static method(parameter: Type) -> Type {
									<- parameter
								}
							}
						}`,
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse typed NamespaceDefinitionStatements with one Method", () => {
					let input: parser.Program = parse(
						`implementation {
							namespace Namespace for Type {
								method(parameter: Type) -> Type {
									<- parameter
								}
							}
						}`,
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse typed NamespaceDefinitionStatements with multiple Methods", () => {
					let input: parser.Program = parse(
						`implementation {
							namespace Namespace for Type {
								method(parameter: Type) -> Type {
									<- parameter
								}

								method2(parameter: Type) -> Type {
									<- parameter
								}
							}
						}`,
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse typed NamespaceDefinitionStatements with overloaded Methods", () => {
					let input: parser.Program = parse(
						`implementation {
							namespace Namespace for Type {
								overload method {
									(parameter: Type) -> Type {
										<- parameter
									}

									(name parameter: Type) -> Type {
										<- parameter
									}
								}
							}
						}`,
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse typed NamespaceDefinitionStatements with twice overloaded Methods", () => {
					let input: parser.Program = parse(
						`implementation {
							namespace Namespace for Type {
								overload method {
									(parameter: Type) -> Type {
										<- parameter
									}

									(name parameter: Type) -> Type {
										<- parameter
									}

									(item parameter: Type) -> Type {
										<- parameter
									}
								}
							}
						}`,
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse typed NamespaceDefinitionStatements with Methods and Constants", () => {
					let input: parser.Program = parse(
						`implementation {
							namespace Namespace for Type {
								static property = PropertyValue

								method(parameter: Type) -> Type {
									<- parameter
								}
							}
						}`,
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse typed NamespaceDefinitionStatements with Methods, static Methods, and Constants", () => {
					let input: parser.Program = parse(
						`implementation {
							namespace Namespace for Type {
								static property = PropertyValue

								static method(parameter: Type) -> Type {
									<- parameter
								}

								method(parameter: Type) -> Type {
									<- parameter
								}
							}
						}`,
					)

					expect(input).toMatchSnapshot()
				})
			})
		})

		describe("ProtocolDeclarationStatements", () => {
			it("should parse an empty ProtocolDeclarationStatement", () => {
				let input: parser.Program = parse(
					"implementation { protocol Printable {} }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse a ProtocolDeclarationStatement with a simple Method Signature", () => {
				let input: parser.Program = parse(
					`implementation {
						protocol Printable {
							toString() -> String
						}
					}`,
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse a ProtocolDeclarationStatement with a Self Parameter", () => {
				let input: parser.Program = parse(
					`implementation {
						protocol Equatable {
							is(_ other: Self) -> Boolean
							isNot(_ other: Self) -> Boolean
						}
					}`,
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse a ProtocolDeclarationStatement with a static Method Signature", () => {
				let input: parser.Program = parse(
					`implementation {
						protocol Creatable {
							static create() -> Self
						}
					}`,
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse a ProtocolDeclarationStatement with an overloaded Method Signature", () => {
				let input: parser.Program = parse(
					`implementation {
						protocol Combinable {
							overload combine {
								(_ other: Self) -> Self
								(_ others: List<Self>) -> Self
							}
						}
					}`,
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse a ProtocolDeclarationStatement with an overloaded static Method Signature", () => {
				let input: parser.Program = parse(
					`implementation {
						protocol Creatable {
							overload static create {
								() -> Self
								(_ description: String) -> Self
							}
						}
					}`,
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse a documented ProtocolDeclarationStatement", () => {
				let input: parser.Program = parse(
					`implementation {
						§§ Anything that can represent itself as a String.
						protocol Printable {
							§§ The String representation.
							toString() -> String
						}
					}`,
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse a Protocol Method with a body", () => {
				let input: parser.Program = parse(
					`implementation {
						protocol Printable {
							toString() -> String { <- "" }
						}
					}`,
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse a Protocol that extends other Protocols", () => {
				let input: parser.Program = parse(
					`implementation {
						protocol Orderable is Comparable, is Equatable {
							isLessThan(_ other: Self) -> Boolean
						}
					}`,
				)

				expect(input).toMatchSnapshot()
			})

			it("should not parse an extension list without its own 'is'", () => {
				let { diagnostics } = parseWithDiagnostics(
					`implementation {
						protocol Orderable is Comparable, Equatable {}
					}`,
				)

				expect(containsErrors(diagnostics)).toBe(true)
			})

			it("should recover from an unclosed Protocol body", () => {
				let { diagnostics } = parseWithDiagnostics(
					"implementation { protocol Printable {",
				)

				expect(containsErrors(diagnostics)).toBe(true)
			})

			// Only a Function literal in Expression position may omit its
			// annotations, since only there is an expected signature to read.
			describe("Contextual Function literals", () => {
				it("should parse a Function literal without annotations", () => {
					let input: parser.Program = parse(
						`implementation {
							constant kept = [1]::removeEvery(where (item) { <- true })
						}`,
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse the underscore spellings", () => {
					let input: parser.Program = parse(
						`implementation {
							constant a = f((_ item) { <- true })
							constant b = f((_) { <- true })
						}`,
					)

					expect(input).toMatchSnapshot()
				})

				it("should reject a label on an unannotated Parameter", () => {
					let { diagnostics } = parseWithDiagnostics(
						`implementation {
							constant kept = [1]::removeEvery(where (label name) { <- true })
						}`,
					)

					expect(
						diagnostics.map((diagnostic) => diagnostic.message),
					).toEqual([
						"A Parameter without a Type can not carry a label",
					])
				})

				it("should still require annotations on a named Function", () => {
					let { diagnostics } = parseWithDiagnostics(
						`implementation {
							function twice(value) { <- value }
						}`,
					)

					expect(containsErrors(diagnostics)).toBe(true)
				})

				it("should still require annotations on a Method", () => {
					let { diagnostics } = parseWithDiagnostics(
						`implementation {
							namespace Doubling for Integer {
								twice(value) { <- value }
							}
						}`,
					)

					expect(containsErrors(diagnostics)).toBe(true)
				})
			})

			describe("Parameters that bind no name", () => {
				function parametersOf(
					source: string,
				): Array<parser.ParameterNode> {
					let { program, diagnostics } = parseWithDiagnostics(
						`implementation { constant f = ${source} }`,
					)

					expect(diagnostics).toEqual([])

					let node = program.implementation.nodes[0]

					if (
						node.nodeType !== "ConstantDeclarationStatement" ||
						node.value.nodeType !== "FunctionValue"
					) {
						throw new Error("Expected a Function literal")
					}

					return node.value.value.parameters
				}

				it("should parse a typed `_` in a Function literal", () => {
					let [parameter] = parametersOf(
						"(_: Integer) -> Integer { <- 1 }",
					)

					expect(parameter.externalName).toBeNull()
					expect(parameter.internalName).toBeNull()
					expect(parameter.type?.nodeType).toBe(
						"IdentifierTypeDeclaration",
					)
				})

				it("should parse a label before a `_`", () => {
					let [parameter] = parametersOf(
						"(on _: Integer) -> Integer { <- 1 }",
					)

					expect(parameter.externalName?.content).toBe("on")
					expect(parameter.internalName).toBeNull()
					expect(parameter.position.start.column).toBe(32)
					expect(parameter.position.end.column).toBe(45)
				})

				it("should parse a label before a `_` in a named Function", () => {
					let { diagnostics } = parseWithDiagnostics(
						"implementation { function f(on _: Integer) -> Integer { <- 1 } }",
					)

					expect(diagnostics).toEqual([])
				})

				it("should reject a label on an unannotated `_`", () => {
					let { diagnostics } = parseWithDiagnostics(
						"implementation { constant kept = [1]::removeEvery(where (on _) { <- true }) }",
					)

					expect(
						diagnostics.map((diagnostic) => [
							diagnostic.code,
							diagnostic.helps,
						]),
					).toEqual([
						["redundant-parameter-label", ["Write only '_'."]],
					])
					expect(
						compiles(
							"implementation { constant kept = [1]::removeEvery(where (_) { <- true }) }",
						),
					).toBe(true)
				})

				// Only a `_` on its own, under a Parameter written `_`, can have
				// meant that Parameter. One glued to a name or a Number is part of
				// another spelling.
				it.each([
					"constant x = _",
					"constant f = (value: Integer) -> Integer { <- _ }",
					"constant f = (_: Integer) -> Integer { <- my_value }",
					"constant f = (_: Integer) -> Integer { <- __print(1) }",
					"constant f = (_: Integer) -> Integer { <- 1_ }",
					"constant f = (_: Integer) -> Integer { <- foo_bar(1) }",
				])(
					"should not name a Parameter when reading %s",
					(statement) => {
						let { diagnostics } = parseWithDiagnostics(
							`implementation { ${statement} }`,
						)

						expect(containsErrors(diagnostics)).toBe(true)
						expect(
							diagnostics.flatMap(
								(diagnostic) => diagnostic.helps,
							),
						).toEqual([])
					},
				)

				// The Help is followed for both spellings it names.
				it("should refuse a read of `_` with a Help that names the Parameter", () => {
					let { diagnostics } = parseWithDiagnostics(
						"implementation { constant f = (_: Integer) -> Integer { <- _ } }",
					)

					expect(
						diagnostics.map((diagnostic) => [
							diagnostic.code,
							diagnostic.message,
							diagnostic.helps,
						]),
					).toEqual([
						[
							"syntax-error",
							"Expected an Expression but found '_'.",
							[
								"To read a Parameter that binds no name, give it one: '_: Integer' becomes '_ value: Integer', and 'on _: Integer' becomes 'on value: Integer'.",
							],
						],
					])
					expect(
						compiles(
							"implementation { constant f = (_ value: Integer) -> Integer { <- value } }",
						),
					).toBe(true)
					expect(
						compiles(
							"implementation { constant f = (on value: Integer) -> Integer { <- value } }",
						),
					).toBe(true)
				})
			})

			describe("Generic Bounds", () => {
				it("should parse a bounded Generic on a Function", () => {
					let input: parser.Program = parse(
						`implementation {
							function smallest <infer Item is Comparable>(_ list: List<Item>) -> Optional<Item> {
								<- #Empty
							}
						}`,
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse a bounded Generic with a default Type", () => {
					let input: parser.Program = parse(
						`implementation {
							function describe <infer Value is Printable = String>(_ value: Value) -> String {
								<- ""
							}
						}`,
					)

					expect(input).toMatchSnapshot()
				})
			})

			describe("Conformance Clauses", () => {
				it("should parse a Namespace with a Conformance Clause", () => {
					let input: parser.Program = parse(
						"implementation { namespace IntegerEquatable for Integer is Equatable {} }",
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse a Namespace with multiple Conformance Clauses", () => {
					let input: parser.Program = parse(
						"implementation { namespace IntegerEquatable for Integer is Equatable, is Printable {} }",
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse an untyped Namespace with a Conformance Clause", () => {
					let input: parser.Program = parse(
						"implementation { namespace Foo is Equatable {} }",
					)

					expect(input).toMatchSnapshot()
				})

				it("should still parse a Method named is", () => {
					let input: parser.Program = parse(
						`implementation {
							namespace IntegerHelpers for Integer {
								is(_ other: Integer) -> Boolean { <- true }
							}
						}`,
					)

					expect(input).toMatchSnapshot()
				})
			})

			describe("Where Clauses", () => {
				it("should parse a single where condition", () => {
					let input: parser.Program = parse(
						"implementation { namespace List<infer Item> for List<Item> is Comparable where Item is Comparable {} }",
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse several where conditions", () => {
					let input: parser.Program = parse(
						"implementation { namespace Pair<infer Key, infer Value> for { key: Key, value: Value } is Comparable where Key is Comparable, Value is Comparable {} }",
					)

					expect(input).toMatchSnapshot()
				})

				it("should end the where list at a comma followed by is", () => {
					let program: parser.Program = parse(
						"implementation { namespace Box<infer Item> for List<Item> is Comparable where Item is Comparable, is Printable {} }",
					)

					let namespace = program.implementation
						.nodes[0] as parser.NamespaceDefinitionStatementNode

					// The comma before `is Printable` ends the `where` list, so
					// Printable is a second clause.
					expect(namespace.conformsTo.length).toBe(2)
					expect(namespace.conformsTo[0].protocol.content).toBe(
						"Comparable",
					)
					expect(namespace.conformsTo[0].conditions.length).toBe(1)
					expect(
						namespace.conformsTo[0].conditions[0].generic.content,
					).toBe("Item")
					expect(namespace.conformsTo[1].protocol.content).toBe(
						"Printable",
					)
					expect(namespace.conformsTo[1].conditions.length).toBe(0)
				})

				it("should parse two conditional clauses", () => {
					let input: parser.Program = parse(
						"implementation { namespace Pair<infer Item> for { first: Item, second: Item } is Equatable where Item is Equatable, is Comparable where Item is Comparable {} }",
					)

					expect(input).toMatchSnapshot()
				})

				it("should end the where conditions at the opening brace", () => {
					let program: parser.Program = parse(
						"implementation { namespace Box<infer Item> for List<Item> is Comparable where Item is Comparable {} }",
					)

					let namespace = program.implementation
						.nodes[0] as parser.NamespaceDefinitionStatementNode

					expect(namespace.conformsTo.length).toBe(1)
					expect(namespace.conformsTo[0].conditions.length).toBe(1)
				})
			})
		})

		describe("TypeAliasStatements", () => {
			it("should parse TypeAlias Statements with SimpleTypes", () => {
				let input: parser.Program = parse(
					"implementation { type Type = Type2 }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse TypeAlias Statements with empty Record Types", () => {
				let input: parser.Program = parse(
					"implementation { type Type = {} }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse TypeAlias Statements with simple Record Types", () => {
				let input: parser.Program = parse(
					"implementation { type Type = { key: Type2 } }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse TypeAlias Statements with complex Record Types", () => {
				let input: parser.Program = parse(
					"implementation { type Type = { key: { key: Integer | Rational } } }",
				)

				expect(input).toMatchSnapshot()
			})
		})

		// `where` is an ordinary Identifier, so the Parser decides only when it
		// opens a refinement's predicate. What the predicate may say is the
		// Enricher's question, so refused shapes still parse.
		describe("Refinement predicates", () => {
			function alias(source: string): parser.TypeAliasStatementNode {
				let node = parse(source).implementation.nodes[0]

				expect(node.nodeType).toBe("TypeAliasStatement")

				if (node.nodeType !== "TypeAliasStatement") {
					throw new Error("First node is not a TypeAliasStatement.")
				}

				return node
			}

			it("should parse a predicate on a SimpleType", () => {
				let input: parser.Program = parse(
					"implementation { type NonZeroInteger = Integer where @::isNot(0) }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should leave an unrefined Alias without a predicate", () => {
				expect(
					alias("implementation { type Small = Integer }").predicate,
				).toBeNull()
			})

			it("should span the Statement out to the predicate's end", () => {
				let node = alias(
					"implementation { type NonZeroInteger = Integer where @::isNot(0) }",
				)

				expect(node.predicate).not.toBeNull()
				expect(node.position.end).toEqual(node.predicate!.position.end)
			})

			it("should flatten a conjunction into the Expression it was written as", () => {
				let node = alias(
					"implementation { type Positive = Integer where @::isPositive()::and(@::isNot(1)) }",
				)

				expect(node.predicate?.nodeType).toBe("MethodInvocation")
			})

			// Line breaks are discarded Tokens, so only line numbers tell the
			// clause from a Statement named `where`. A `where` on the next line is
			// the clause when a predicate follows it. It is a Statement when it
			// stands alone or goes on with `=`, `::`, `.`, `(` or `[`.
			it("should read a where on the next line followed by its predicate", () => {
				let program = parse(
					[
						"implementation {",
						"\ttype NonEmptyDictionary<KeyType, ValueType> = Dictionary<KeyType, ValueType>",
						"\t\twhere @::hasEntries()",
						"}",
					].join("\n"),
				)

				expect(program.implementation.nodes).toHaveLength(1)
				expect(
					(
						program.implementation
							.nodes[0] as parser.TypeAliasStatementNode
					).predicate?.nodeType,
				).toBe("MethodInvocation")
			})

			it("should not consume a where on the next line that is a Statement", () => {
				for (let statement of [
					"where",
					"where = 3",
					"where::check()",
					"where.value",
					"where(1)",
				]) {
					let program = parse(
						[
							"implementation {",
							"\ttype Handler = Integer",
							"\t" + statement,
							"}",
						].join("\n"),
					)

					expect(program.implementation.nodes).toHaveLength(2)
					expect(
						(
							program.implementation
								.nodes[0] as parser.TypeAliasStatementNode
						).predicate,
					).toBeNull()
				}
			})

			// Every base the Enricher refuses still parses, so its showcase
			// file reaches the Enricher.
			it("should parse a predicate on the bases the Enricher refuses", () => {
				for (let base of [
					"Boolean",
					"Integer | String",
					"{ key: Integer }",
					"List",
				]) {
					let node = alias(
						`implementation { type Refined = ${base} where @::isNot(0) }`,
					)

					expect(node.predicate).not.toBeNull()
				}
			})

			it("should parse a predicate on a generic Alias", () => {
				let node = alias(
					"implementation { type NonEmptyList<Item> = List<Item> where @::hasItems() }",
				)

				expect(node.generics).toHaveLength(1)
				expect(node.predicate).not.toBeNull()
			})
		})

		describe("FunctionStatements", () => {
			it("should parse FunctionStatements with no parameters", () => {
				let input: parser.Program = parse(
					"implementation { function name () -> Type {} }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse FunctionLiterals with one parameter with explicit external name", () => {
				let input: parser.Program = parse(
					`implementation {
						function name (external internal: Type) -> Type {
							<- internal
						}
					}`,
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse FunctionLiterals with one parameter with implicit external name", () => {
				let input: parser.Program = parse(
					`implementation {
						function name (internal: Type) -> Type {
							<- internal
						}
					}`,
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse FunctionLiterals with one parameter without external name", () => {
				let input: parser.Program = parse(
					`implementation {
						function name (_ internal: Type) -> Type {
							<- internal
						}
					}`,
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse FunctionLiterals with two parameters", () => {
				let input: parser.Program = parse(
					`implementation {
						function name (external internal: Type, external2 internal2: Type) -> Type | Type1 {
							<- internal
						}
					}`,
				)

				expect(input).toMatchSnapshot()
			})
		})

		describe("Generics", () => {
			function firstNode(source: string): parser.ImplementationNode {
				return parse(source).implementation.nodes[0]
			}

			it("should parse infer Generics on FunctionStatements", () => {
				let node = firstNode(
					`implementation {
						function identity <infer T>(_ value: T) -> T {
							<- value
						}
					}`,
				)

				expect(node.nodeType).toBe("FunctionStatement")

				if (node.nodeType === "FunctionStatement") {
					expect(node.value.generics).toHaveLength(1)
					expect(node.value.generics[0].name.content).toBe("T")
					expect(node.value.generics[0].inferred).toBe(true)
					expect(node.value.generics[0].defaultType).toBeNull()
				}
			})

			it("should parse Generic defaults on FunctionStatements", () => {
				let node = firstNode(
					`implementation {
						function fallback <T = String>() -> T {
							<- "value"
						}
					}`,
				)

				expect(node.nodeType).toBe("FunctionStatement")

				if (node.nodeType === "FunctionStatement") {
					expect(node.value.generics[0].name.content).toBe("T")
					expect(node.value.generics[0].inferred).toBe(false)
					expect(node.value.generics[0].defaultType).not.toBeNull()
				}
			})

			it("should parse Generic NamespaceDefinitionStatements", () => {
				let node = firstNode(
					`implementation {
						namespace Wrapper<infer Item> for List<Item> {
							first() -> Optional<Item> {
								<- @::firstItem()
							}
						}
					}`,
				)

				expect(node.nodeType).toBe("NamespaceDefinitionStatement")

				if (node.nodeType === "NamespaceDefinitionStatement") {
					expect(node.generics).toHaveLength(1)
					expect(node.generics[0].name.content).toBe("Item")
					expect(node.generics[0].inferred).toBe(true)
					expect(node.targetType).not.toBeNull()
				}
			})

			it("should parse infer Generics on Methods", () => {
				let node = firstNode(
					`implementation {
						namespace Wrapper<infer Item> for List<Item> {
							map<infer Target>(_ transform: (_ item: Item) -> Target) -> List<Target> {
								<- [transform(@::firstItem())]
							}
						}
					}`,
				)

				expect(node.nodeType).toBe("NamespaceDefinitionStatement")

				if (node.nodeType === "NamespaceDefinitionStatement") {
					let method = node.methods.map

					expect(method.nodeType).toBe("SimpleMethod")

					if (method.nodeType === "SimpleMethod") {
						expect(method.method.value.generics).toHaveLength(1)
						expect(
							method.method.value.generics[0].name.content,
						).toBe("Target")
						expect(method.method.value.generics[0].inferred).toBe(
							true,
						)
					}
				}
			})

			it("should parse Generic TypeAliasStatements", () => {
				let node = firstNode(
					`implementation {
						type Labelled<Value> = Value | String
					}`,
				)

				expect(node.nodeType).toBe("TypeAliasStatement")

				if (node.nodeType === "TypeAliasStatement") {
					expect(node.generics).toHaveLength(1)
					expect(node.generics[0].name.content).toBe("Value")
					expect(node.generics[0].inferred).toBe(false)
				}
			})

			it("should parse FunctionTypeDeclarations", () => {
				let node = firstNode(
					`implementation {
						type Predicate = (_ value: String, count: Integer) -> Boolean
					}`,
				)

				expect(node.nodeType).toBe("TypeAliasStatement")

				if (node.nodeType === "TypeAliasStatement") {
					expect(node.type.nodeType).toBe("FunctionTypeDeclaration")

					if (node.type.nodeType === "FunctionTypeDeclaration") {
						expect(node.type.parameterTypes).toHaveLength(2)
						expect(
							node.type.parameterTypes[0].externalName,
						).toBeNull()
						expect(
							node.type.parameterTypes[1].externalName?.content,
						).toBe("count")
						expect(node.type.returnType.nodeType).toBe(
							"IdentifierTypeDeclaration",
						)
					}
				}
			})

			it("should keep infer usable as an Identifier", () => {
				let node = firstNode(
					`implementation {
						constant infer = 5
					}`,
				)

				expect(node.nodeType).toBe("ConstantDeclarationStatement")

				if (node.nodeType === "ConstantDeclarationStatement") {
					expect((node.name as parser.IdentifierNode).content).toBe(
						"infer",
					)
				}
			})

			it("should parse a Generic named infer", () => {
				let node = firstNode(
					`implementation {
						function weird <infer>(_ value: infer) -> infer {
							<- value
						}
					}`,
				)

				expect(node.nodeType).toBe("FunctionStatement")

				if (node.nodeType === "FunctionStatement") {
					expect(node.value.generics[0].name.content).toBe("infer")
					expect(node.value.generics[0].inferred).toBe(false)
				}
			})
		})
	})

	// `= expression` at the end of a Parameter.
	describe("Default Parameter Values", () => {
		function parameterOf(source: string): parser.ParameterNode {
			let { program, diagnostics } = parseWithDiagnostics(
				`implementation { function f ${source} -> Integer { <- 1 } }`,
			)

			expect(diagnostics).toEqual([])

			let node = program.implementation.nodes[0]

			if (node.nodeType !== "FunctionStatement") {
				throw new Error("Expected a FunctionStatement")
			}

			return node.value.parameters[0]
		}

		it("should parse a Number literal default", () => {
			let parameter = parameterOf("(_ count: Integer = 1)")

			expect(parameter.defaultValue?.nodeType).toBe("IntegerValue")
		})

		// A Parameter's `position` ends at its Type, where the Inlay Hint that
		// offers an inferred Type sits.
		it("should not widen the Parameter's position over the default", () => {
			let parameter = parameterOf("(_ count: Integer = 1)")

			expect(parameter.position.end.column).toBe(
				parameter.type!.position.end.column,
			)
			expect(
				parameter.defaultValue!.position.start.column,
			).toBeGreaterThan(parameter.position.end.column)
		})

		// Nothing flush before the `#` continues, so `#Start` is a bare Case.
		it("should parse a bare Case default", () => {
			let parameter = parameterOf("(at side: Side = #Start)")

			expect(parameter.defaultValue?.nodeType).toBe("CaseValue")
		})

		it("should parse a default that calls a Method on @", () => {
			let parameter = parameterOf("(to end: Integer = @::length())")

			expect(parameter.defaultValue?.nodeType).toBe("MethodInvocation")
		})

		it("should parse a default on a Pattern Parameter", () => {
			let parameter = parameterOf(
				"(of { width, height }: Rectangle = origin)",
			)

			expect(parameter.internalName?.nodeType).toBe("Pattern")
			expect(parameter.defaultValue?.nodeType).toBe("Identifier")
		})

		// A comma inside a default is always inside brackets the sub-parser
		// balances, so the Parameter list's own comma is never in doubt.
		it("should parse a List literal default", () => {
			let parameter = parameterOf("(_ items: List<Integer> = [1, 2, 3])")

			expect(parameter.defaultValue?.nodeType).toBe("ListValue")
		})

		it("should parse a default that is a call with its own commas", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				`implementation {
					function f (_ a: Integer = g(1, 2), _ b: Integer) -> Integer {
						<- a
					}
				}`,
			)

			expect(diagnostics).toEqual([])

			let node = program.implementation.nodes[0]

			if (node.nodeType !== "FunctionStatement") {
				throw new Error("Expected a FunctionStatement")
			}

			expect(node.value.parameters).toHaveLength(2)
			expect(node.value.parameters[0].defaultValue?.nodeType).toBe(
				"FunctionInvocation",
			)
			expect(node.value.parameters[1].defaultValue).toBeNull()
		})

		it("should parse a default on a native Method signature", () => {
			let { diagnostics } = parseWithDiagnostics(
				`declarations {
					namespace String for String {
						trim(at side: Side = #BothEnds) -> String
					}
				}`,
				{ allowDeclarationsHeader: true },
			)

			expect(diagnostics).toEqual([])
		})

		// Where a default is refused. A Function Type has no Expression slot,
		// so a default there does not parse at all.
		it("should refuse a default on a Function literal", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { constant f = (item = 1) { <- item } }",
			)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
				"default-on-function-literal",
			)
		})

		it("should refuse a default on a Generic Function literal", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { constant f = <T>(_ item: Integer = 1) -> Integer { <- item } }",
			)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
				"default-on-function-literal",
			)
		})

		it("should refuse a default on a Protocol requirement", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				`implementation {
					protocol Trimmable {
						trim(at side: Integer = 1) -> Self
					}
				}`,
			)

			expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain(
				"default-on-protocol-method",
			)

			let node = program.implementation.nodes[0]

			if (node.nodeType !== "ProtocolDeclarationStatement") {
				throw new Error("Expected a ProtocolDeclarationStatement")
			}

			let method = node.methods["trim"]

			if (method.nodeType !== "SimpleProtocolMethod") {
				throw new Error("Expected a SimpleProtocolMethod")
			}

			expect(method.signature.parameters[0].defaultValue).toBeNull()
		})

		it("should word a default on a provided Method for the Method it is on", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					protocol Greeter {
						name() -> String

						greet(times count: Integer = 1) -> String {
							<- "{@::name()} x{count}"
						}
					}
				}`,
			)

			let [refused] = diagnostics.filter(
				(diagnostic) =>
					diagnostic.code === "default-on-protocol-method",
			)

			expect(refused.message).toBe(
				"A provided Method can not carry a default",
			)
			expect(refused.notes).toEqual([
				"A conforming Namespace may replace a provided Method, and a call through a bound then runs the replacement, which a default here would not reach.",
			])
			expect(refused.helps).toEqual([
				"Remove the default, and pass the Argument at each call.",
			])
		})

		it("should refuse a default in a Function Type", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { constant f: (_ n: Integer = 1) -> Integer = g }",
			)

			expect(containsErrors(diagnostics)).toBe(true)
		})

		// A default is checked against a written Type, since `(_ n = 1)` and
		// `(_ n: Number = 1)` would mean different things. A Declaration's `:` is
		// mandatory anyway.
		it("should refuse a default with no Type", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { function f (_ count = 1) -> Integer { <- count } }",
			)

			expect(containsErrors(diagnostics)).toBe(true)
		})

		// `_: Type` binds no name, but a caller may still leave the Argument
		// out, which is all a default means.
		it("should allow a default on a nameless Parameter", () => {
			let parameter = parameterOf("(_: Integer = 1)")

			expect(parameter.internalName).toBeNull()
			expect(parameter.defaultValue?.nodeType).toBe("IntegerValue")
		})
	})

	describe("Declarations Programs", () => {
		// `declarations { … }` is reachable only with `allowDeclarationsHeader`.
		function declarationsNamespace(
			source: string,
		): parser.NamespaceDefinitionStatementNode {
			let program = parse(source, { allowDeclarationsHeader: true })
			let node = program.implementation.nodes[0]

			if (node.nodeType !== "NamespaceDefinitionStatement") {
				throw new Error(
					"expected a NamespaceDefinitionStatement as the first node",
				)
			}

			return node
		}

		it("should parse a declarations header round-trip", () => {
			let program = parse(
				`declarations {
					namespace Number {
						static PI: Transcendental
					}
				}`,
				{ allowDeclarationsHeader: true },
			)

			expect(program.kind).toBe("declarations")
			expect(program.implementation.nodes).toHaveLength(1)
			expect(program.implementation.nodes[0].nodeType).toBe(
				"NamespaceDefinitionStatement",
			)
		})

		it("should parse a body-less simple Method signature with generics and documentation", () => {
			let namespace = declarationsNamespace(
				`declarations {
					namespace Container for List {
						§§ Wraps a value.
						§§ @param value — the value to wrap
						§§ @returns — the wrapped value
						wrap <Item>(value: Item) -> Item
					}
				}`,
			)

			let method = namespace.methods["wrap"]

			expect(method.nodeType).toBe("SimpleMethodSignature")

			if (method.nodeType === "SimpleMethodSignature") {
				expect(method.signature.nodeType).toBe("NativeMethodSignature")
				expect(method.signature.generics).toHaveLength(1)
				expect(method.signature.generics[0].name.content).toBe("Item")
				expect(method.signature.parameters).toHaveLength(1)
				expect(
					parameterInternalName(method.signature.parameters[0])
						?.content,
				).toBe("value")

				let documentation = method.signature.documentation

				expect(documentation?.description).toBe("Wraps a value.")
				expect(documentation?.parameters).toEqual([
					{
						name: "value",
						text: "the value to wrap",
						tag: { position: expect.anything() },
					},
				])
				expect(documentation?.returns).toBe("the wrapped value")
			}
		})

		it("should parse a body-less static Method signature", () => {
			let namespace = declarationsNamespace(
				`declarations {
					namespace Number {
						static parse(_ text: String) -> Number
					}
				}`,
			)

			let method = namespace.methods["parse"]

			expect(method.nodeType).toBe("StaticMethodSignature")

			if (method.nodeType === "StaticMethodSignature") {
				expect(method.signature.nodeType).toBe("NativeMethodSignature")
				expect(method.signature.returnType.nodeType).toBe(
					"IdentifierTypeDeclaration",
				)
			}
		})

		it("should parse a fully body-less overload block", () => {
			let namespace = declarationsNamespace(
				`declarations {
					namespace Number for Number {
						overload add {
							(_ other: Number) -> Number
							(_ other: Integer) -> Number
						}
					}
				}`,
			)

			let method = namespace.methods["add"]

			expect(method.nodeType).toBe("OverloadedMethodSignatures")

			if (method.nodeType === "OverloadedMethodSignatures") {
				expect(method.methods).toHaveLength(2)
				expect(method.methods[0].nodeType).toBe("NativeMethodSignature")
				expect(method.methods[1].nodeType).toBe("NativeMethodSignature")
			}
		})

		it("should parse an overload block that mixes a body-less and a bodied entry", () => {
			let namespace = declarationsNamespace(
				`declarations {
					namespace Number for Number {
						overload combine {
							(_ other: Number) -> Number
							(_ other: Integer) -> Number {
								<- other
							}
						}
					}
				}`,
			)

			let method = namespace.methods["combine"]

			expect(method.nodeType).toBe("OverloadedMethodSignatures")

			if (method.nodeType === "OverloadedMethodSignatures") {
				expect(method.methods).toHaveLength(2)
				expect(method.methods[0].nodeType).toBe("NativeMethodSignature")
				expect(method.methods[1].nodeType).toBe("FunctionValue")
			}
		})

		it("should parse a body-less static overload block", () => {
			let namespace = declarationsNamespace(
				`declarations {
					namespace Number {
						overload static of {
							(_ value: Integer) -> Number
							(_ value: String) -> Number
						}
					}
				}`,
			)

			let method = namespace.methods["of"]

			expect(method.nodeType).toBe("OverloadedStaticMethodSignatures")

			if (method.nodeType === "OverloadedStaticMethodSignatures") {
				expect(method.methods).toHaveLength(2)
				expect(method.methods[0].nodeType).toBe("NativeMethodSignature")
			}
		})

		it("should parse a native static Property without a value", () => {
			let namespace = declarationsNamespace(
				`declarations {
					namespace Number {
						static PI: Transcendental
					}
				}`,
			)

			let property = namespace.properties["PI"]

			expect(property.value).toBeNull()
			expect(property.type?.nodeType).toBe("IdentifierTypeDeclaration")
		})

		it("should still parse a bodied Method in declarations mode", () => {
			let namespace = declarationsNamespace(
				`declarations {
					namespace Math for Number {
						double(value: Number) -> Number {
							<- value
						}
					}
				}`,
			)

			let method = namespace.methods["double"]

			expect(method.nodeType).toBe("SimpleMethod")

			if (method.nodeType === "SimpleMethod") {
				expect(method.method.nodeType).toBe("FunctionValue")
				expect(method.method.value.body).toHaveLength(1)
			}
		})

		// The free-Function forms of a `declarations { … }` Program.
		function declarationsNode(source: string): parser.ImplementationNode {
			let program = parse(source, { allowDeclarationsHeader: true })

			return program.implementation.nodes[0]
		}

		// A native free Function exists only as an `overload function` entry,
		// so a free `function` with no block is a missing-body error.
		it("should refuse a body-less free Function in declarations mode", () => {
			let { diagnostics } = parseWithDiagnostics(
				`declarations {
					§§ Answers with the value it was given.
					function identity <infer Item>(_ value: Item) -> Item
				}`,
				{ allowDeclarationsHeader: true },
			)

			expect(containsErrors(diagnostics)).toBe(true)
		})

		// A declaration name is an ordinary Identifier, so no name a Program
		// could not spell back can be declared. Spelled `native`, this block
		// parses clean.
		it("should refuse a double underscore in a native free Function's name", () => {
			let { diagnostics } = parseWithDiagnostics(
				`declarations {
					§§ Prints a value.
					overload function __native {
						(_ value: Integer) -> Integer
						(_ value: String) -> String
					}
				}`,
				{ allowDeclarationsHeader: true },
			)

			expect(
				diagnostics.map((diagnostic) => [
					diagnostic.code,
					diagnostic.message,
				]),
			).toEqual([
				["syntax-error", "Expected an Identifier but found '_'."],
			])
		})

		it("should still parse a bodied free Function in declarations mode", () => {
			let node = declarationsNode(
				`declarations {
					§§ Answers with the value it was given.
					function identity <Item>(_ value: Item) -> Item {
						<- value
					}
				}`,
			)

			expect(node.nodeType).toBe("FunctionStatement")

			if (node.nodeType === "FunctionStatement") {
				expect(node.value.body).toHaveLength(1)
			}
		})

		it("should parse a fully body-less overload function block", () => {
			let node = declarationsNode(
				`declarations {
					§§ Combines two values.
					overload function combine {
						(first value: Integer) -> Integer
						(second value: String) -> String
					}
				}`,
			)

			expect(node.nodeType).toBe("OverloadedFunctionStatement")

			if (node.nodeType === "OverloadedFunctionStatement") {
				expect(node.name.content).toBe("combine")
				expect(node.methods).toHaveLength(2)
				expect(node.methods[0].nodeType).toBe("NativeMethodSignature")
				expect(node.methods[1].nodeType).toBe("NativeMethodSignature")
				expect(node.documentation?.description).toBe(
					"Combines two values.",
				)
			}
		})

		it("should parse an overload function block that mixes a bodied and a body-less entry", () => {
			let node = declarationsNode(
				`declarations {
					§§ Combines two values.
					overload function combine {
						(first value: Integer) -> Integer
						(second value: String) -> String {
							<- value
						}
					}
				}`,
			)

			expect(node.nodeType).toBe("OverloadedFunctionStatement")

			if (node.nodeType === "OverloadedFunctionStatement") {
				expect(node.methods[0].nodeType).toBe("NativeMethodSignature")
				expect(node.methods[1].nodeType).toBe("FunctionValue")
			}
		})

		it("should reject a declarations block outside the standard library", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				`declarations {
					constant x = 1
				}`,
			)

			let diagnostic = diagnostics.find(
				(candidate) => candidate.code === "declarations-outside-stdlib",
			)

			expect(diagnostic).toBeDefined()
			expect(diagnostic?.labels[0]?.kind).toBe("primary")

			// Recovery reads the block as an implementation section, so its
			// contents still yield an AST.
			expect(program.kind).toBe("implementation")
			expect(program.implementation.nodes).toHaveLength(1)
			expect(program.implementation.nodes[0].nodeType).toBe(
				"ConstantDeclarationStatement",
			)
			expect(diagnostic?.helps).toEqual([
				"Open the Program with 'implementation { … }' instead.",
			])
			expect(
				compiles(`implementation {
					constant x = 1
				}`),
			).toBe(true)
		})

		it("should reject an overload function block outside the standard library", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				`implementation {
					overload function combine {
						(first value: Integer) -> Integer {
							<- value
						}
					}
				}`,
			)

			expect(diagnostics).toHaveLength(1)

			let diagnostic = diagnostics[0]

			expect(diagnostic.code).toBe("overload-function-outside-stdlib")
			expect(diagnostic.labels[0]?.kind).toBe("primary")
			expect(diagnostic.labels[0]?.message).toBe(
				"'overload function' is not allowed here",
			)
			expect(diagnostic.notes).toEqual([
				"Free-Function Overloads are a 'declarations { … }' form — a free Function in a Program carries one signature.",
			])
			expect(diagnostic.helps).toEqual([
				"Write the Overloads as an 'overload' Method block inside a Namespace instead.",
			])

			// Recovery parses the block anyway, so its contents still yield an
			// AST rather than a cascade.
			expect(program.implementation.nodes).toHaveLength(1)
			expect(program.implementation.nodes[0].nodeType).toBe(
				"OverloadedFunctionStatement",
			)
		})

		it("should not reject an overload Method block inside a Namespace", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					namespace Doubling for Integer {
						overload double {
							(value: Integer) -> Integer {
								<- value
							}
						}
					}
				}`,
			)

			expect(diagnostics).toHaveLength(0)
		})

		it("should reject a body-less Method in implementation mode", () => {
			let { diagnostics } = parseWithDiagnostics(
				`implementation {
					namespace Number for Number {
						double(value: Number) -> Number
					}
				}`,
			)

			expect(containsErrors(diagnostics)).toBe(true)
		})
	})

	describe("Module Sections", () => {
		function importEntries(source: string): Array<parser.ImportNode> {
			let { program, diagnostics } = parseWithDiagnostics(source)

			expect(diagnostics).toEqual([])

			return program.imports?.entries ?? []
		}

		function exportEntries(source: string): Array<parser.ExportNode> {
			let { program, diagnostics } = parseWithDiagnostics(source)

			expect(diagnostics).toEqual([])

			return program.exports?.entries ?? []
		}

		it("should leave both sections null when a Program writes neither", () => {
			let program = parse("implementation { constant x = 1 }")

			expect(program.imports).toBeNull()
			expect(program.exports).toBeNull()
			expect(program.position).toEqual(program.implementation.position)
		})

		it("should parse an import section above the implementation", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				`import {
					from "./Geometry.es" { Rectangle }
					from "./Geometry.es" { Circle }
				}

				implementation {
					constant x = 1
				}`,
			)

			expect(diagnostics).toEqual([])
			expect(program.imports?.nodeType).toBe("ImportSection")
			expect(program.imports?.entries).toHaveLength(2)
			expect(program.implementation.nodes).toHaveLength(1)
			expect(program.exports).toBeNull()
		})

		it("should parse an export section below the implementation", () => {
			let { program, diagnostics } = parseWithDiagnostics(
				`implementation {
					constant x = 1
				}

				export {
					x
				}`,
			)

			expect(diagnostics).toEqual([])
			expect(program.exports?.nodeType).toBe("ExportSection")
			expect(program.exports?.entries).toHaveLength(1)
			expect(program.imports).toBeNull()
		})

		// The Formatter reads a Program's Position as the implementation
		// block's span, so the other sections carry spans of their own.
		it("should keep the Program's Position on the implementation block", () => {
			let program = parse(
				`import { from "./Geometry.es" { Rectangle } }
implementation { }
export { from "./Geometry.es" { Rectangle } }`,
			)

			expect(program.position).toEqual(program.implementation.position)
			expect(program.position.start).toEqual({ line: 2, column: 1 })
			expect(program.imports?.position.start).toEqual({
				line: 1,
				column: 1,
			})
			expect(program.exports?.position.end).toEqual({
				line: 3,
				column: 46,
			})
		})

		it("should read an import entry's name, source and Position", () => {
			let entries = importEntries(
				`import { from "./Geometry.es" { Rectangle } }
				implementation { }`,
			)

			expect(entries[0].name.content).toBe("Rectangle")
			expect(entries[0].alias).toBeNull()
			expect(entries[0].source.nodeType).toBe("ModuleSpecifier")
			expect(entries[0].source.path).toBe("./Geometry.es")
			expect(entries[0].position).toEqual({
				start: { line: 1, column: 33 },
				end: { line: 1, column: 42 },
			})
		})

		it("should read an import entry's alias", () => {
			let entries = importEntries(
				`import { from "../math/Math.es" { PI as Pi } }
				implementation { }`,
			)

			expect(entries[0].name.content).toBe("PI")
			expect(entries[0].alias?.content).toBe("Pi")
			expect(entries[0].source.path).toBe("../math/Math.es")
		})

		it("should read an export entry that names a local declaration", () => {
			let entries = exportEntries(
				`implementation { }
				export { describe }`,
			)

			expect(entries[0].name.content).toBe("describe")
			expect(entries[0].alias).toBeNull()
			expect(entries[0].source).toBeNull()
		})

		it("should read an export entry's alias", () => {
			let entries = exportEntries(
				`implementation { }
				export { Described as RectangleDescribed }`,
			)

			expect(entries[0].name.content).toBe("Described")
			expect(entries[0].alias?.content).toBe("RectangleDescribed")
			expect(entries[0].source).toBeNull()
		})

		it("should read a re-export entry's source", () => {
			let entries = exportEntries(
				`implementation { }
				export { from "./Geometry.es" { Rectangle } }`,
			)

			expect(entries[0].name.content).toBe("Rectangle")
			expect(entries[0].alias).toBeNull()
			expect(entries[0].source?.path).toBe("./Geometry.es")
		})

		it("should read a renamed re-export entry", () => {
			let entries = exportEntries(
				`implementation { }
				export { from "./Geometry.es" { Rectangle as Box } }`,
			)

			expect(entries[0].name.content).toBe("Rectangle")
			expect(entries[0].alias?.content).toBe("Box")
			expect(entries[0].source?.path).toBe("./Geometry.es")
		})

		it("should tell a local export from a re-export written below it", () => {
			let entries = exportEntries(
				`implementation { }
				export {
					describe
					from "./Geometry.es" { Rectangle }
				}`,
			)

			expect(entries).toHaveLength(2)
			expect(entries[0].name.content).toBe("describe")
			expect(entries[0].source).toBeNull()
			expect(entries[1].name.content).toBe("Rectangle")
			expect(entries[1].source?.path).toBe("./Geometry.es")
		})

		// `as` is an Identifier everywhere but an entry's alias position, so a
		// Module may export and rename something called `as`.
		it("should read an entry named after a Module Keyword", () => {
			let entries = importEntries(
				`import {
					from "./Names.es" { as as as }
					from "./Names.es" { from }
				}
				implementation { }`,
			)

			expect(entries).toHaveLength(2)
			expect(entries[0].name.content).toBe("as")
			expect(entries[0].alias?.content).toBe("as")
			expect(entries[1].name.content).toBe("from")
			expect(entries[1].alias).toBeNull()
		})

		it("should accept an import section written on one line", () => {
			let entries = importEntries(
				`import { from "./A.es" { A } from "./B.es" { B } }
				implementation { }`,
			)

			expect(entries.map((entry) => entry.name.content)).toEqual([
				"A",
				"B",
			])
		})

		describe("Recovery", () => {
			it("should keep the entries above a broken one and the implementation below it", () => {
				let { program, diagnostics } = parseWithDiagnostics(
					`import {
						from "./Geometry.es" { Rectangle }
						Circle "./Geometry.es"
					}

					implementation {
						constant x = 1
					}`,
				)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("syntax-error")
				expect(program.imports?.entries).toHaveLength(1)
				expect(program.implementation.nodes).toHaveLength(1)
			})

			// In an export block `from` is an Identifier unless a specifier
			// follows it. A group with a specifier but no braces is refused.
			it("should read a bare export entry named 'from'", () => {
				let { program, diagnostics } = parseWithDiagnostics(
					`implementation { }
					export { Rectangle from }`,
				)

				expect(diagnostics).toEqual([])
				expect(
					program.exports?.entries.map((entry) => entry.name.content),
				).toEqual(["Rectangle", "from"])
			})

			it("should report a group whose specifier opens no braces", () => {
				let { program, diagnostics } = parseWithDiagnostics(
					`implementation { }
					export { from "./Geometry.es" }`,
				)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("syntax-error")
				expect(program.exports?.entries).toEqual([])
			})

			it("should report an import entry written outside a group", () => {
				let { program, diagnostics } = parseWithDiagnostics(
					`import { Rectangle from "./Geometry.es" }
					implementation { }`,
				)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("syntax-error")
				expect(diagnostics[0].message).toBe(
					"Expected 'from' but found 'Rectangle'.",
				)
				expect(program.imports?.entries).toEqual([])
			})

			it("should report a section that is never closed", () => {
				let { diagnostics } = parseWithDiagnostics(
					`import {
						from "./Geometry.es" { Rectangle }`,
				)

				expect(diagnostics[0].code).toBe("unclosed-block")
			})

			it("should report a Token after the export section", () => {
				let { diagnostics } = parseWithDiagnostics(
					`implementation { }
					export { x }
					1`,
				)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("unexpected-token")
				expect(diagnostics[0].labels[1]?.kind).toBe("secondary")
			})

			it("should compile once the stray Token is removed", () => {
				let source = `implementation {
					constant answer = 42
				}
				}`
				let { diagnostics } = parseWithDiagnostics(source)

				expect(diagnostics[0]?.helps).toEqual(["Remove the '}'."])
				expect(compiles(source.slice(0, source.lastIndexOf("}")))).toBe(
					true,
				)
			})

			// What follows ends in the `}` written for the implementation. The one
			// that closed it early goes, and the report stands on it. Removing each
			// Token after the end in turn never reaches the Program.
			it("should name the '}' that closed the implementation early", () => {
				let source = `implementation {
	function answer() -> Integer {
		<- 42
	}}

	Terminal.print(answer())
}`
				let { diagnostics } = parseWithDiagnostics(source)

				let brace = {
					start: { line: 4, column: 3 },
					end: { line: 4, column: 4 },
				}

				expect(
					diagnostics.map((diagnostic) => diagnostic.code),
				).toEqual(["unexpected-token"])
				expect(diagnostics[0].message).toBe(
					"This '}' ends the implementation block early",
				)
				expect(diagnostics[0].position).toEqual(brace)
				expect(diagnostics[0].helps).toEqual(["Remove the '}'."])
				expect(diagnostics[0].data).toEqual({
					kind: "essence-spelling",
					position: brace,
					spelling: "",
				})
				expect(compiles(source.replace("}}", "}"))).toBe(true)
			})

			// The `}` written for the implementation may have its sections after
			// it, which balance.
			it("should name the early '}' where an export block follows", () => {
				let source = `implementation {
	function answer() -> Integer {
		<- 42
	}}

	constant value = answer()
}

export { value }`
				let { diagnostics } = parseWithDiagnostics(source)

				expect(diagnostics[0]?.message).toBe(
					"This '}' ends the implementation block early",
				)
				expect(diagnostics[0]?.labels[2]?.position.start).toEqual({
					line: 7,
					column: 1,
				})
				expect(compiles(source.replace("}}", "}"))).toBe(true)
			})

			// A file of tests alone has no implementation block to move into,
			// and its tests block may hold the Statements. Its `}` can close the
			// block early just as the implementation's can.
			it("should answer a file of tests alone with its tests block", () => {
				let written = (body: string, after: string) => `tests {
	test "it" {
		expect true
	}${body}
}
${after}`
				let codes = (source: string) =>
					parseWithDiagnostics(source).diagnostics

				expect(
					codes(written("", "constant other = 1"))[0]?.helps,
				).toEqual([
					"Move what follows into the 'tests { … }' block, or remove it.",
				])
				expect(
					compiles(written("\n\n\tconstant other = 1", ""), {
						tests: true,
					}),
				).toBe(true)

				let early =
					'tests {\n\ttest "it" {\n\t\texpect true\n\t}}\n\n\tconstant other = 1\n}'

				expect(codes(early)[0]?.message).toBe(
					"This '}' ends the tests block early",
				)
				expect(codes(early)[0]?.helps).toEqual(["Remove the '}'."])
				expect(
					compiles(early.replace("\t}}", "\t}"), { tests: true }),
				).toBe(true)
			})

			it("should ask for Statements written after the Program to move in", () => {
				let source = `implementation {
	constant answer = 42
}

constant other = 1`
				let { diagnostics } = parseWithDiagnostics(source)

				expect(diagnostics[0]?.helps).toEqual([
					"Move what follows into the 'implementation { … }' block, or remove it.",
				])
				expect(diagnostics[0]?.data).toBeUndefined()
				expect(
					compiles(`implementation {
	constant answer = 42
	constant other = 1
}`),
				).toBe(true)
			})
		})

		describe("Misplaced sections", () => {
			it("should report an export section above the implementation", () => {
				let { program, diagnostics } = parseWithDiagnostics(
					`export { x }

					implementation {
						constant x = 1
					}`,
				)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("misplaced-module-section")
				expect(diagnostics[0].message).toBe(
					"The 'export { … }' block belongs below the implementation",
				)
				expect(diagnostics[0].position).toEqual({
					start: { line: 1, column: 1 },
					end: { line: 1, column: 7 },
				})
				expect(diagnostics[0].labels[0]?.kind).toBe("primary")
				expect(diagnostics[0].labels[1]?.kind).toBe("secondary")
				expect(diagnostics[0].labels[1]?.position).toEqual(
					program.implementation.position,
				)
				expect(program.exports?.entries[0].name.content).toBe("x")
				expect(diagnostics[0].helps).toEqual([
					"Move the 'export { … }' block below 'implementation { … }'.",
				])
				expect(
					compiles(`implementation {
						constant x = 1
					}

					export { x }`),
				).toBe(true)
			})

			it("should report an import section below the implementation", () => {
				let { program, diagnostics } = parseWithDiagnostics(
					`implementation { }

					import { from "./Geometry.es" { Rectangle } }`,
				)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("misplaced-module-section")
				expect(diagnostics[0].message).toBe(
					"The 'import { … }' block belongs above the implementation",
				)
				expect(program.imports?.entries[0].name.content).toBe(
					"Rectangle",
				)
			})

			// The Diagnostic underlines the Keyword, so the block's own span
			// tells a fix what text to move.
			it("should carry the misplaced block's own span", () => {
				let { diagnostics } = parseWithDiagnostics(
					`implementation { }

import { from "./Geometry.es" { Rectangle } }`,
				)

				expect(diagnostics[0].data).toEqual({
					kind: "section-order",
					section: "import",
					block: {
						start: { line: 3, column: 1 },
						end: { line: 3, column: 46 },
					},
				})
			})

			// A misplaced block is still parsed where it stands, so its contents
			// do not cascade. The Diagnostics come in file order.
			it("should read a misplaced section's entries rather than cascade", () => {
				let { diagnostics } = parseWithDiagnostics(
					`implementation { }

					import { Rectangle "./Geometry.es" }`,
				)

				expect(diagnostics).toHaveLength(2)
				expect(
					diagnostics.map((diagnostic) => diagnostic.code),
				).toEqual(["misplaced-module-section", "syntax-error"])
			})

			// The misplaced block is kept, so the names it imports or exports
			// are not reported again where they are read.
			it("should keep a misplaced section where none stands in its place", () => {
				let { program } = parseWithDiagnostics(
					`export { B }
					implementation { }
					import { from "./A.es" { A } }`,
				)

				expect(program.imports?.entries[0].name.content).toBe("A")
				expect(program.exports?.entries[0].name.content).toBe("B")
			})

			it("should keep a well-placed section beside a misplaced one", () => {
				let { program, diagnostics } = parseWithDiagnostics(
					`import { from "./A.es" { A } }
					implementation { }
					import { from "./B.es" { B } }`,
				)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("misplaced-module-section")
				expect(program.imports?.entries).toHaveLength(1)
				expect(program.imports?.entries[0].name.content).toBe("A")
			})

			it("should keep a well-placed export section beside a misplaced one", () => {
				let { program } = parseWithDiagnostics(
					`export { A }
					implementation { }
					export { B }`,
				)

				expect(program.exports?.entries).toHaveLength(1)
				expect(program.exports?.entries[0].name.content).toBe("B")
			})
		})

		// A `declarations { … }` Program carries its sections as an
		// `implementation { … }` one does, since the standard library's files are
		// Modules too. A block on the wrong side is refused by the same check.
		describe("Declarations Programs", () => {
			it("should keep an import section in a standard library file", () => {
				let { program, diagnostics } = parseWithDiagnostics(
					`import { from "./Geometry.es" { Rectangle } }

					declarations { }`,
					{ allowDeclarationsHeader: true },
				)

				expect(diagnostics).toHaveLength(0)
				expect(program.kind).toBe("declarations")
				expect(program.imports?.entries).toHaveLength(1)
				expect(program.imports?.entries[0].name.content).toBe(
					"Rectangle",
				)
			})

			it("should keep an export section in a standard library file", () => {
				let { program, diagnostics } = parseWithDiagnostics(
					`declarations { }

					export { Number }`,
					{ allowDeclarationsHeader: true },
				)

				expect(diagnostics).toHaveLength(0)
				expect(program.exports?.entries).toHaveLength(1)
				expect(program.exports?.entries[0].name.content).toBe("Number")
			})

			it("should keep both sections of a standard library file at once", () => {
				let { program, diagnostics } = parseWithDiagnostics(
					`import { from "./A.es" { A } }
					declarations { }
					export { B }`,
					{ allowDeclarationsHeader: true },
				)

				expect(diagnostics).toHaveLength(0)
				expect(program.imports?.entries).toHaveLength(1)
				expect(program.exports?.entries).toHaveLength(1)
			})

			it("should still refuse a misplaced section in a standard library file", () => {
				let { diagnostics } = parseWithDiagnostics(
					`declarations { }
					import { from "./A.es" { A } }`,
					{ allowDeclarationsHeader: true },
				)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("misplaced-module-section")
			})
		})

		// The Module Keywords stay valid Identifiers, since `from` and `as` are
		// Argument labels, as in `slice(from 1, to 3)`.
		describe("Contextual Keywords", () => {
			it("should read a Module Keyword as an Argument label", () => {
				let { program, diagnostics } = parseWithDiagnostics(
					"implementation { numbers::slice(from 1, to 3) }",
				)

				expect(diagnostics).toEqual([])

				let node = program.implementation.nodes[0]

				expect(node.nodeType).toBe("MethodInvocation")

				if (node.nodeType === "MethodInvocation") {
					expect(
						node.arguments.map(
							(argument) => argument.name?.content ?? null,
						),
					).toEqual(["from", "to"])
				}
			})

			it("should read a Module Keyword as an Argument label and its value", () => {
				let { program, diagnostics } = parseWithDiagnostics(
					"implementation { text::slice(from from, to as) }",
				)

				expect(diagnostics).toEqual([])

				let node = program.implementation.nodes[0]

				expect(node.nodeType).toBe("MethodInvocation")

				if (node.nodeType === "MethodInvocation") {
					expect(node.arguments[0].name?.content).toBe("from")
					expect(node.arguments[0].value).toMatchObject({
						nodeType: "Identifier",
						content: "from",
					})
					expect(node.arguments[1].value).toMatchObject({
						nodeType: "Identifier",
						content: "as",
					})
				}
			})

			it("should read a Module Keyword as a declared name", () => {
				let { program, diagnostics } = parseWithDiagnostics(
					`implementation {
						constant import = 1
						constant export = 2
						variable from = 3
						variable as = 4
						from = 5
					}`,
				)

				expect(diagnostics).toEqual([])
				expect(
					program.implementation.nodes.map((node) => node.nodeType),
				).toEqual([
					"ConstantDeclarationStatement",
					"ConstantDeclarationStatement",
					"VariableDeclarationStatement",
					"VariableDeclarationStatement",
					"VariableAssignmentStatement",
				])
			})

			it("should read a Module Keyword as a Parameter label and name", () => {
				let { program, diagnostics } = parseWithDiagnostics(
					`implementation {
						function slice(from start: Integer, as end: Integer) -> Integer {
							<- start
						}
					}`,
				)

				expect(diagnostics).toEqual([])

				let node = program.implementation.nodes[0]

				expect(node.nodeType).toBe("FunctionStatement")

				if (node.nodeType === "FunctionStatement") {
					expect(
						node.value.parameters.map(
							(parameter) => parameter.externalName?.content,
						),
					).toEqual(["from", "as"])
					expect(
						node.value.parameters.map(
							(parameter) =>
								parameterInternalName(parameter)?.content,
						),
					).toEqual(["start", "end"])
				}
			})

			it("should read a Module Keyword as a Type and Namespace name", () => {
				let { program, diagnostics } = parseWithDiagnostics(
					`implementation {
						type from = Integer
						namespace as for from {
							double() -> from {
								<- @
							}
						}
					}`,
				)

				expect(diagnostics).toEqual([])
				expect(
					program.implementation.nodes.map((node) => node.nodeType),
				).toEqual([
					"TypeAliasStatement",
					"NamespaceDefinitionStatement",
				])
			})

			// `otherwise` is a name, so a Method may be spelled that way. It ends
			// a `define` arm only after the arm's value has ended.
			it("should read otherwise as a Method name", () => {
				let { program, diagnostics } = parseWithDiagnostics(
					"implementation { value::otherwise(0) }",
				)

				expect(diagnostics).toEqual([])

				let node = program.implementation.nodes[0]

				expect(node.nodeType).toBe("MethodInvocation")

				if (node.nodeType === "MethodInvocation") {
					expect(node.member.content).toBe("otherwise")
				}
			})

			it("should read otherwise as a Record member and as a Lookup", () => {
				let { program, diagnostics } = parseWithDiagnostics(
					`implementation {
						constant r = { otherwise = 1 }
						constant read = r.otherwise
					}`,
				)

				expect(diagnostics).toEqual([])

				let [record, lookup] = program.implementation.nodes

				if (record.nodeType === "ConstantDeclarationStatement") {
					expect(record.value).toMatchObject({
						nodeType: "RecordValue",
						members: {
							otherwise: {
								value: { nodeType: "IntegerValue", value: "1" },
							},
						},
					})
				}

				if (lookup.nodeType === "ConstantDeclarationStatement") {
					expect(lookup.value).toMatchObject({
						nodeType: "Lookup",
						member: { content: "otherwise" },
					})
				}
			})

			it("should read otherwise as a declared name", () => {
				let { program, diagnostics } = parseWithDiagnostics(
					`implementation {
						variable otherwise = 1
						otherwise = 2
					}`,
				)

				expect(diagnostics).toEqual([])
				expect(
					program.implementation.nodes.map((node) => node.nodeType),
				).toEqual([
					"VariableDeclarationStatement",
					"VariableAssignmentStatement",
				])
			})

			it("should read otherwise as a Parameter label and name", () => {
				let { program, diagnostics } = parseWithDiagnostics(
					`implementation {
						function fallback(otherwise value: Integer) -> Integer {
							<- value
						}
					}`,
				)

				expect(diagnostics).toEqual([])

				let node = program.implementation.nodes[0]

				expect(node.nodeType).toBe("FunctionStatement")

				if (node.nodeType === "FunctionStatement") {
					expect(
						node.value.parameters.map(
							(parameter) => parameter.externalName?.content,
						),
					).toEqual(["otherwise"])
					expect(
						node.value.parameters.map(
							(parameter) =>
								parameterInternalName(parameter)?.content,
						),
					).toEqual(["value"])
				}
			})

			// `define` is not a name. An Identifier followed by a `{` already
			// parses as a name and a Record Literal, which a contextual `define`
			// would silently read as one block.
			it("should keep define reserved", () => {
				let { diagnostics } = parseWithDiagnostics(
					"implementation { constant define = 1 }",
				)

				expect(containsErrors(diagnostics)).toBe(true)
				expect(diagnostics[0].message).toBe(
					"Expected an Identifier but found 'define'.",
				)
			})

			// A section is its Keyword and its `{`, so a lone Keyword after the
			// implementation is a stray Token.
			it("should not read a bare Keyword below the implementation as a section", () => {
				let { program, diagnostics } = parseWithDiagnostics(
					`implementation { }
					export`,
				)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("unexpected-token")
				expect(program.exports).toBeNull()
			})
		})
	})
})
