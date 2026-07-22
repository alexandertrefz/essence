import { describe, expect, it } from "bun:test"

import { containsErrors } from "../diagnostics/index"
import type { parser } from "../interfaces/index"
import { parse, parseWithDiagnostics } from "../parser/index"

describe("Parser", () => {
	describe("Expressions", () => {
		describe("NativeInvocations", () => {
			it("should not parse NativePrefix without Identifier", () => {
				let { diagnostics } = parseWithDiagnostics(
					"implementation { __ }",
				)

				expect(containsErrors(diagnostics)).toBe(true)
			})

			it("should not parse NativeLookups without second Identifier", () => {
				let { diagnostics } = parseWithDiagnostics(
					"implementation { __lookup. }",
				)

				expect(containsErrors(diagnostics)).toBe(true)
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

			describe("RationalLiterals", () => {
				it("should parse RationalLiterals", () => {
					let input: parser.Program = parse(
						"implementation { 3 / 2 }",
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse RationalLiterals with underscores", () => {
					let input: parser.Program = parse(
						"implementation { 1_000 / 9 }",
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse negative numerator RationalLiterals", () => {
					let input: parser.Program = parse(
						"implementation { -3 / 2 }",
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse negative denominator RationalLiterals", () => {
					let input: parser.Program = parse(
						"implementation { 3 / -2 }",
					)

					expect(input).toMatchSnapshot()
				})

				it("should parse fully negative RationalLiterals", () => {
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
							function smallest <infer Item is Comparable>(_ list: List<Item>) -> Item | Nothing {
								<- nothing
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
						"implementation { namespace IntegerEquatable for Integer is Equatable, Printable {} }",
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
							first() -> Item | Nothing {
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
						type Maybe<Value> = Value | Nothing
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
					expect(node.name.content).toBe("infer")
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
})
