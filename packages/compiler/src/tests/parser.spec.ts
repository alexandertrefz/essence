import { describe, expect, it } from "bun:test"

import type { parser } from "@essence-lang/interfaces"

import { containsErrors } from "../diagnostics/index"
import { parameterInternalName } from "../helpers/index"
import { parse, parseWithDiagnostics } from "../parser/index"

describe("Parser", () => {
	describe("Expressions", () => {
		// NOTE: `_` is a Symbol wherever the Lexer meets it — a wildcard Matcher,
		// a labelless Parameter, a Number's group separator — and never a
		// character inside a name. A leading `__` used to be the ONE exception:
		// the sigil of a native free Function, whose name the Parser reassembled
		// out of `_ _ name` at its declaration and at every call. Printing is the
		// `Terminal` Namespace now, nothing carries the sigil, and the reassembly
		// is gone with it — so an underscore in a name is refused wherever it
		// stands, leading pair included, and there is no rule about `__` left to
		// state.
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

			// NOTE: The same refusal, from the same Lexer rule — which is the
			// point. A `__`-prefixed name is not a special case any more; it is an
			// underscore inside a name, like every other one.
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
				// NOTE: The empty Record is the unit value — the thing a
				// Function that answers nothing useful returns — so `{}` in
				// Expression position has to reach the Parser as an ordinary
				// AnonymousRecordLiteral with no members, not as a Literal of
				// its own. There is no dedicated Node for it and no Keyword
				// behind it: `{}` is only the general Record syntax with
				// nothing between the braces.
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

			it("should not parse a Protocol Method Signature with a body", () => {
				let { diagnostics } = parseWithDiagnostics(
					`implementation {
						protocol Printable {
							toString() -> String { <- "" }
						}
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

			// NOTE: Annotations may only be omitted by a Function literal in
			// expression position, where an expected signature exists to read
			// them off. A Declaration has none, so its annotations stay
			// mandatory.
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

					// NOTE: The comma before `is Printable` ends the `where`
					// list — Printable is a second clause, not a condition.
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

		// NOTE: `where` is an ordinary Identifier — a Namespace's conformance
		// conditions and `removeEvery(where …)` both write it — so what the
		// Parser has to get right is WHEN it opens a refinement's predicate. What
		// the predicate may then SAY is a question about Types, which the
		// Enricher answers: the refused shapes below parse perfectly well and
		// carry their clause into enrichment to be reported there.
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

			// NOTE: Linebreak Tokens are discarded, so nothing but the line
			// numbers can tell a clause continuing this Type from a Statement
			// that happens to begin with the name `where` — which is why the
			// Parser reads the clause only on the Type's own line. Two
			// Statements, and the Alias is not refined.
			it("should not consume a where on the next line", () => {
				let program = parse(
					[
						"implementation {",
						"\ttype Handler = Integer",
						"\twhere",
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
				expect(program.implementation.nodes[1].nodeType).toBe(
					"Identifier",
				)
			})

			// NOTE: Every base the Enricher refuses still PARSES — a refusal that
			// came from the Parser would be a Syntax error about a Type, and the
			// showcase file for these Diagnostics could never reach the Enricher
			// at all.
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

	// NOTE: `= expression` at the end of a Parameter. Every case here is also a
	// Formatter round-trip case in `formatter.spec.ts` — the two halves of "the
	// source says what the AST says" are worth pinning apart.
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

		// NOTE: The `position` of a Parameter still ends at its Type, never
		// past the default — the Inlay Hint that offers to write an inferred
		// Type sits at exactly that spot, and the Quick Fix applies it.
		it("should not widen the Parameter's position over the default", () => {
			let parameter = parameterOf("(_ count: Integer = 1)")

			expect(parameter.position.end.column).toBe(
				parameter.type!.position.end.column,
			)
			expect(
				parameter.defaultValue!.position.start.column,
			).toBeGreaterThan(parameter.position.end.column)
		})

		// NOTE: `#Start` written after `= ` is a bare Case, not the adjacency
		// rule's `Choice#Case` — nothing precedes the `#` to continue.
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

		// NOTE: The two cases that prove §2.1's claim that there is nothing to
		// disambiguate — a comma inside a default is always inside brackets the
		// sub-parser balances, so the Parameter list's own comma is never in
		// doubt.
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

		// NOTE: The three positions a default is refused in. The first two are
		// reported and the default dropped; the third never parses at all,
		// because a Function TYPE has no expression slot to read one into.
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
				"default-on-protocol-requirement",
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

		it("should refuse a default in a Function Type", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { constant f: (_ n: Integer = 1) -> Integer = g }",
			)

			expect(containsErrors(diagnostics)).toBe(true)
		})

		// NOTE: A default needs a written Type to be checked against — the
		// Type can not be read back off the default, because `(_ n = 1)` and
		// `(_ n: Number = 1)` mean different things to every caller. Nothing
		// special enforces this: outside a Function literal, a Parameter's `:`
		// is already mandatory, so the `=` arrives where a `:` was expected.
		it("should refuse a default with no Type", () => {
			let { diagnostics } = parseWithDiagnostics(
				"implementation { function f (_ count = 1) -> Integer { <- count } }",
			)

			expect(containsErrors(diagnostics)).toBe(true)
		})

		// NOTE: `_: Type` binds no name, so its default is unreachable from
		// the body — but a caller may still leave the Argument out, which is
		// the only thing a default has to mean. Allowed.
		it("should allow a default on a nameless Parameter", () => {
			let parameter = parameterOf("(_: Integer = 1)")

			expect(parameter.internalName).toBeNull()
			expect(parameter.defaultValue?.nodeType).toBe("IntegerValue")
		})
	})

	describe("Declarations Programs", () => {
		// NOTE: `declarations { … }` is the standard library's opt-in Program
		// form — only reachable when the caller passes `allowDeclarationsHeader`.
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
				expect(documentation?.parameters).toEqual({
					value: "the value to wrap",
				})
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

		// NOTE: The free-Function forms of a `declarations { … }` Program —
		// only the standard library opens one.
		function declarationsNode(source: string): parser.ImplementationNode {
			let program = parse(source, { allowDeclarationsHeader: true })

			return program.implementation.nodes[0]
		}

		// NOTE: The standalone body-less form left the language with `__print`
		// — a native free Function exists only as an `overload function`
		// entry now, so a free `function` signature with no block is the
		// plain missing-body parse error in every mode.
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

		// NOTE: A declaration name is an ordinary Identifier — the Parser no longer
		// reassembles a `__`-prefixed one out of `_ _ name`, so the standard
		// library can not declare a native free Function whose name a Program
		// could never spell back.
		it("should refuse a double underscore in a native free Function's name", () => {
			let { diagnostics } = parseWithDiagnostics(
				`declarations {
					§§ Prints a value.
					function __native <infer Item>(_ value: Item) -> Item
				}`,
				{ allowDeclarationsHeader: true },
			)

			expect(containsErrors(diagnostics)).toBe(true)
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

			// NOTE: Recovery parses the block as an implementation section so
			// the contents still yield an AST and downstream Diagnostics.
			expect(program.kind).toBe("implementation")
			expect(program.implementation.nodes).toHaveLength(1)
			expect(program.implementation.nodes[0].nodeType).toBe(
				"ConstantDeclarationStatement",
			)
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

			// NOTE: Recovery parses the block anyway, so the block's contents
			// still yield an AST instead of the cascade the Expression reading
			// used to leave behind.
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
					Rectangle from "./Geometry.es"
					Circle from "./Geometry.es"
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

		// NOTE: The Formatter reads a Program's Position as the span of the block
		// it writes `implementation {` and its closing brace for, so the sections
		// framing it may not widen it — each carries its own span instead.
		it("should keep the Program's Position on the implementation block", () => {
			let program = parse(
				`import { Rectangle from "./Geometry.es" }
implementation { }
export { Rectangle from "./Geometry.es" }`,
			)

			expect(program.position).toEqual(program.implementation.position)
			expect(program.position.start).toEqual({ line: 2, column: 1 })
			expect(program.imports?.position.start).toEqual({
				line: 1,
				column: 1,
			})
			expect(program.exports?.position.end).toEqual({
				line: 3,
				column: 42,
			})
		})

		it("should read an import entry's name, source and Position", () => {
			let entries = importEntries(
				`import { Rectangle from "./Geometry.es" }
				implementation { }`,
			)

			expect(entries[0].name.content).toBe("Rectangle")
			expect(entries[0].alias).toBeNull()
			expect(entries[0].source.nodeType).toBe("ModuleSpecifier")
			expect(entries[0].source.path).toBe("./Geometry.es")
			expect(entries[0].position).toEqual({
				start: { line: 1, column: 10 },
				end: { line: 1, column: 40 },
			})
		})

		it("should read an import entry's alias", () => {
			let entries = importEntries(
				`import { PI as Pi from "../math/Math.es" }
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
				export { Rectangle from "./Geometry.es" }`,
			)

			expect(entries[0].name.content).toBe("Rectangle")
			expect(entries[0].alias).toBeNull()
			expect(entries[0].source?.path).toBe("./Geometry.es")
		})

		it("should read a renamed re-export entry", () => {
			let entries = exportEntries(
				`implementation { }
				export { Rectangle as Box from "./Geometry.es" }`,
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
					Rectangle from "./Geometry.es"
				}`,
			)

			expect(entries).toHaveLength(2)
			expect(entries[0].name.content).toBe("describe")
			expect(entries[0].source).toBeNull()
			expect(entries[1].name.content).toBe("Rectangle")
			expect(entries[1].source?.path).toBe("./Geometry.es")
		})

		// NOTE: `as` is an Identifier everywhere but an entry's alias position, so
		// a Module may export something called `as` — and rename it to `as`.
		it("should read an entry named after a Module Keyword", () => {
			let entries = importEntries(
				`import {
					as as as from "./Names.es"
					from from "./Names.es"
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
				`import { A from "./A.es" B from "./B.es" }
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
						Rectangle from "./Geometry.es"
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

			it("should report an export entry whose 'from' carries no specifier", () => {
				let { program, diagnostics } = parseWithDiagnostics(
					`implementation { }
					export { Rectangle from }`,
				)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("syntax-error")
				expect(program.exports?.entries).toEqual([])
			})

			it("should report a section that is never closed", () => {
				let { diagnostics } = parseWithDiagnostics(
					`import {
						Rectangle from "./Geometry.es"`,
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
				expect(program.exports).toBeNull()
			})

			it("should report an import section below the implementation", () => {
				let { program, diagnostics } = parseWithDiagnostics(
					`implementation { }

					import { Rectangle from "./Geometry.es" }`,
				)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("misplaced-module-section")
				expect(diagnostics[0].message).toBe(
					"The 'import { … }' block belongs above the implementation",
				)
				expect(program.imports).toBeNull()
			})

			// NOTE: A block on the wrong side is still parsed where it stands, so
			// what is inside it is read rather than cascading into the Diagnostics
			// about the Program's shape.
			it("should read a misplaced section's entries rather than cascade", () => {
				let { diagnostics } = parseWithDiagnostics(
					`implementation { }

					import { Rectangle "./Geometry.es" }`,
				)

				expect(diagnostics).toHaveLength(2)
				expect(
					diagnostics.map((diagnostic) => diagnostic.code),
				).toEqual(["syntax-error", "misplaced-module-section"])
			})

			it("should keep a well-placed section beside a misplaced one", () => {
				let { program, diagnostics } = parseWithDiagnostics(
					`import { A from "./A.es" }
					implementation { }
					import { B from "./B.es" }`,
				)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("misplaced-module-section")
				expect(program.imports?.entries).toHaveLength(1)
				expect(program.imports?.entries[0].name.content).toBe("A")
			})
		})

		// NOTE: A `declarations { … }` Program carries its sections on exactly
		// the same terms as an `implementation { … }` one — the standard
		// library's files are Modules too, each importing what it uses from its
		// siblings. Only the SIDE a block is written on is still refused, and it
		// is refused by the same check that refuses it anywhere else.
		describe("Declarations Programs", () => {
			it("should keep an import section in a standard library file", () => {
				let { program, diagnostics } = parseWithDiagnostics(
					`import { Rectangle from "./Geometry.es" }

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
					`import { A from "./A.es" }
					declarations { }
					export { B }`,
					{ allowDeclarationsHeader: true },
				)

				expect(diagnostics).toHaveLength(0)
				expect(program.imports?.entries).toHaveLength(1)
				expect(program.exports?.entries).toHaveLength(1)
			})

			// NOTE: The side check is what survives. An `import` written BELOW
			// the header is still misplaced in a declarations Program, exactly
			// as it is in an implementation one.
			it("should still refuse a misplaced section in a standard library file", () => {
				let { program, diagnostics } = parseWithDiagnostics(
					`declarations { }
					import { A from "./A.es" }`,
					{ allowDeclarationsHeader: true },
				)

				expect(diagnostics).toHaveLength(1)
				expect(diagnostics[0].code).toBe("misplaced-module-section")
				expect(program.imports).toBeNull()
			})
		})

		// NOTE: All four Module Keywords stay valid Identifiers — `from` and `as`
		// are Argument labels the standard library already writes, so making them
		// Keywords outright would have broken `slice(from 1, to 3)`.
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

			// NOTE: A section is recognised by its Keyword AND its `{`, so a lone
			// Keyword below the implementation is a Token where the Program had
			// ended rather than a section whose block went missing.
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
