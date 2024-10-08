import { describe, expect, it } from "bun:test"

import type { parser } from "../interfaces"
import { parse } from "../parser"

describe("Parser", () => {
	describe("Expressions", () => {
		describe("NativeInvocations", () => {
			it("should not parse NativePrefix without Identifier", () => {
				expect(() => parse("implementation { __ }")).toThrow()
			})

			it("should not parse NativeLookups without second Identifier", () => {
				expect(() => parse("implementation { __lookup. }")).toThrow()
			})

			it("should parse NativeFunctionInvocation with one argument", () => {
				let input: parser.Program = parse(
					"implementation { __lookup(arguments) }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse NativeFunctionInvocation with one argument with trailing comma", () => {
				let input: parser.Program = parse(
					"implementation { __lookup(argument,) }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse NativeFunctionInvocation with multiple arguments", () => {
				let input: parser.Program = parse(
					"implementation { __lookup(argument, argument2) }",
				)

				expect(input).toMatchSnapshot()
			})

			it("should parse NativeFunctionInvocation with multiple arguments with trailing comma", () => {
				let input: parser.Program = parse(
					"implementation { __lookup(argument, argument2,) }",
				)

				expect(input).toMatchSnapshot()
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

			describe("NothingLiteral", () => {
				it("should parse NothingLiteral", () => {
					let input: parser.Program = parse(
						"implementation { nothing }",
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

			describe("FractionLiterals", () => {
				it("should parse FractionLiterals", () => {
					let input: parser.Program = parse(
						"implementation { 3 / 2 }",
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse FractionLiterals with underscores", () => {
					let input: parser.Program = parse(
						"implementation { 1_000 / 9 }",
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse negative numerator FractionLiterals", () => {
					let input: parser.Program = parse(
						"implementation { -3 / 2 }",
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse negative denominator FractionLiterals", () => {
					let input: parser.Program = parse(
						"implementation { 3 / -2 }",
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse fully negative FractionLiterals", () => {
					let input: parser.Program = parse(
						"implementation { -3 / -2 }",
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

							case Fraction {
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
					"implementation { constant identifier: { key: { key: Integer | Fraction } } = { key = { key = 1 } } }",
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
					"implementation { variable identifier: { key: { key: Integer | Fraction } } = { key = { key = 1 } } }",
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
					"implementation { type Type = { key: { key: Integer | Fraction } } }",
				)

				expect(input).toMatchSnapshot()
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
	})
})
