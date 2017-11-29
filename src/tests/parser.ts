import { parse } from "../parser"

// Infinitely deep console.logs for convenience
const util = require("util")
util.inspect.defaultOptions.depth = null

// prettier-ignore
type ParserNode = any;

describe("Parser", () => {
	describe("Expressions", () => {
		describe("NativeInvocations", () => {
			it("should not parse NativePrefix without Identifier", () => {
				let input = `__`

				expect(() => parse(input)).toThrow()
			})

			it("should not parse NativeLookups without second Identifier", () => {
				let input = `__lookup.`

				expect(() => parse(input)).toThrow()
			})

			it("should parse NativeFunctionInvocation with one argument", () => {
				let input = `__lookup(argument)`
				let output = [
					{
						nodeType: "NativeFunctionInvocation",
						name: {
							nodeType: "Identifier",
							content: "__lookup",
							position: {
								line: 1,
								column: 1,
							},
						},
						arguments: [
							{
								nodeType: "Argument",
								name: null,
								value: {
									nodeType: "Identifier",
									content: "argument",
									position: {
										line: 1,
										column: 10,
									},
								},
							},
						],
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse NativeFunctionInvocation with one argument with trailing comma", () => {
				let input = `__lookup(argument,)`
				let output = [
					{
						nodeType: "NativeFunctionInvocation",
						name: {
							nodeType: "Identifier",
							content: "__lookup",
							position: {
								line: 1,
								column: 1,
							},
						},
						arguments: [
							{
								nodeType: "Argument",
								name: null,
								value: {
									nodeType: "Identifier",
									content: "argument",
									position: {
										line: 1,
										column: 10,
									},
								},
							},
						],
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse NativeFunctionInvocation with multiple arguments", () => {
				let input = `__lookup(argument, argument2)`
				let output = [
					{
						nodeType: "NativeFunctionInvocation",
						name: {
							nodeType: "Identifier",
							content: "__lookup",
							position: {
								line: 1,
								column: 1,
							},
						},
						arguments: [
							{
								nodeType: "Argument",
								name: null,
								value: {
									nodeType: "Identifier",
									content: "argument",
									position: {
										line: 1,
										column: 10,
									},
								},
							},
							{
								nodeType: "Argument",
								name: null,
								value: {
									nodeType: "Identifier",
									content: "argument2",
									position: {
										line: 1,
										column: 20,
									},
								},
							},
						],
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse NativeFunctionInvocation with multiple arguments with trailing comma", () => {
				let input = `__lookup(argument, argument2,)`
				let output = [
					{
						nodeType: "NativeFunctionInvocation",
						name: {
							nodeType: "Identifier",
							content: "__lookup",
							position: {
								line: 1,
								column: 1,
							},
						},
						arguments: [
							{
								nodeType: "Argument",
								name: null,
								value: {
									nodeType: "Identifier",
									content: "argument",
									position: {
										line: 1,
										column: 10,
									},
								},
							},
							{
								nodeType: "Argument",
								name: null,
								value: {
									nodeType: "Identifier",
									content: "argument2",
									position: {
										line: 1,
										column: 20,
									},
								},
							},
						],
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})
		})

		describe("MethodInvocations", () => {
			it("should parse MethodInvocation with 0 external parameters", () => {
				let input = `lookup::member()`
				let output = [
					{
						nodeType: "MethodInvocation",
						name: {
							nodeType: "MethodLookup",
							base: {
								nodeType: "Identifier",
								content: "lookup",
								position: {
									line: 1,
									column: 1,
								},
							},
							member: {
								nodeType: "Identifier",
								content: "member",
								position: {
									line: 1,
									column: 9,
								},
							},
							position: {
								line: 1,
								column: 1,
							},
						},
						arguments: [],
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse MethodInvocation", () => {
				let input = `lookup::member(argument)`
				let output = [
					{
						nodeType: "MethodInvocation",
						name: {
							nodeType: "MethodLookup",
							base: {
								nodeType: "Identifier",
								content: "lookup",
								position: {
									line: 1,
									column: 1,
								},
							},
							member: {
								nodeType: "Identifier",
								content: "member",
								position: {
									line: 1,
									column: 9,
								},
							},
							position: {
								line: 1,
								column: 1,
							},
						},
						arguments: [
							{
								nodeType: "Argument",
								name: null,
								value: {
									nodeType: "Identifier",
									content: "argument",
									position: {
										line: 1,
										column: 16,
									},
								},
							},
						],
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse chained MethodInvocations", () => {
				let input = `lookup::member(argument)::member(argument)`
				let output = [
					{
						nodeType: "MethodInvocation",
						name: {
							nodeType: "MethodLookup",
							base: {
								nodeType: "MethodInvocation",
								name: {
									nodeType: "MethodLookup",
									base: {
										nodeType: "Identifier",
										content: "lookup",
										position: {
											line: 1,
											column: 1,
										},
									},
									member: {
										nodeType: "Identifier",
										content: "member",
										position: {
											line: 1,
											column: 9,
										},
									},
									position: {
										line: 1,
										column: 1,
									},
								},
								arguments: [
									{
										nodeType: "Argument",
										name: null,
										value: {
											nodeType: "Identifier",
											content: "argument",
											position: {
												line: 1,
												column: 16,
											},
										},
									},
								],
								position: {
									line: 1,
									column: 1,
								},
							},
							member: {
								nodeType: "Identifier",
								content: "member",
								position: {
									line: 1,
									column: 27,
								},
							},
							position: {
								line: 1,
								column: 1,
							},
						},
						arguments: [
							{
								nodeType: "Argument",
								name: null,
								value: {
									nodeType: "Identifier",
									content: "argument",
									position: {
										line: 1,
										column: 34,
									},
								},
							},
						],
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})
		})

		describe("MethodLookups", () => {
			it("should parse Identifier MethodLookups", () => {
				let input = `identifier::member`
				let output = [
					{
						nodeType: "MethodLookup",
						base: {
							nodeType: "Identifier",
							content: "identifier",
							position: {
								line: 1,
								column: 1,
							},
						},
						member: {
							nodeType: "Identifier",
							content: "member",
							position: {
								line: 1,
								column: 13,
							},
						},
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse Lookup MethodLookups", () => {
				let input = `identifier.lookup::member`
				let output = [
					{
						nodeType: "MethodLookup",
						base: {
							nodeType: "Lookup",
							base: {
								nodeType: "Identifier",
								content: "identifier",
								position: {
									line: 1,
									column: 1,
								},
							},
							member: {
								nodeType: "Identifier",
								content: "lookup",
								position: {
									line: 1,
									column: 12,
								},
							},
							position: {
								line: 1,
								column: 1,
							},
						},
						member: {
							nodeType: "Identifier",
							content: "member",
							position: {
								line: 1,
								column: 20,
							},
						},
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should not parse chained MethodLookups", () => {
				let input = `lookup::member1::member2`

				expect(() => parse(input)).toThrow()
			})
		})

		describe("FunctionInvocations", () => {
			it("should parse Identifier FunctionInvocations with one argument", () => {
				let input = `invocation(argument)`
				let output = [
					{
						nodeType: "FunctionInvocation",
						name: {
							nodeType: "Identifier",
							content: "invocation",
							position: {
								line: 1,
								column: 1,
							},
						},
						arguments: [
							{
								nodeType: "Argument",
								name: null,
								value: {
									nodeType: "Identifier",
									content: "argument",
									position: {
										line: 1,
										column: 12,
									},
								},
							},
						],
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse Identifier FunctionInvocations with one labelled argument", () => {
				let input = `invocation(with argument)`
				let output = [
					{
						nodeType: "FunctionInvocation",
						name: {
							nodeType: "Identifier",
							content: "invocation",
							position: {
								line: 1,
								column: 1,
							},
						},
						arguments: [
							{
								nodeType: "Argument",
								name: {
									nodeType: "Identifier",
									content: "with",
									position: {
										line: 1,
										column: 12,
									},
								},
								value: {
									nodeType: "Identifier",
									content: "argument",
									position: {
										line: 1,
										column: 17,
									},
								},
							},
						],
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse Identifier FunctionInvocations with one argument and a trailing comma", () => {
				let input = `invocation(argument,)`
				let output = [
					{
						nodeType: "FunctionInvocation",
						name: {
							nodeType: "Identifier",
							content: "invocation",
							position: {
								line: 1,
								column: 1,
							},
						},
						arguments: [
							{
								nodeType: "Argument",
								name: null,
								value: {
									nodeType: "Identifier",
									content: "argument",
									position: {
										line: 1,
										column: 12,
									},
								},
							},
						],
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse Identifier FunctionInvocations with two arguments", () => {
				let input = `invocation(argument, argument2)`
				let output = [
					{
						nodeType: "FunctionInvocation",
						name: {
							nodeType: "Identifier",
							content: "invocation",
							position: {
								line: 1,
								column: 1,
							},
						},
						arguments: [
							{
								nodeType: "Argument",
								name: null,
								value: {
									nodeType: "Identifier",
									content: "argument",
									position: {
										line: 1,
										column: 12,
									},
								},
							},
							{
								nodeType: "Argument",
								name: null,
								value: {
									nodeType: "Identifier",
									content: "argument2",
									position: {
										line: 1,
										column: 22,
									},
								},
							},
						],
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse Identifier FunctionInvocations with two arguments and a trailing comma", () => {
				let input = `invocation(argument, argument2,)`
				let output = [
					{
						nodeType: "FunctionInvocation",
						name: {
							nodeType: "Identifier",
							content: "invocation",
							position: {
								line: 1,
								column: 1,
							},
						},
						arguments: [
							{
								nodeType: "Argument",
								name: null,
								value: {
									nodeType: "Identifier",
									content: "argument",
									position: {
										line: 1,
										column: 12,
									},
								},
							},
							{
								nodeType: "Argument",
								name: null,
								value: {
									nodeType: "Identifier",
									content: "argument2",
									position: {
										line: 1,
										column: 22,
									},
								},
							},
						],
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse Identifier FunctionInvocations with more than two arguments", () => {
				let input = `invocation(argument, argument2, argument3)`
				let output = [
					{
						nodeType: "FunctionInvocation",
						name: {
							nodeType: "Identifier",
							content: "invocation",
							position: {
								line: 1,
								column: 1,
							},
						},
						arguments: [
							{
								nodeType: "Argument",
								name: null,
								value: {
									nodeType: "Identifier",
									content: "argument",
									position: {
										line: 1,
										column: 12,
									},
								},
							},
							{
								nodeType: "Argument",
								name: null,
								value: {
									nodeType: "Identifier",
									content: "argument2",
									position: {
										line: 1,
										column: 22,
									},
								},
							},
							{
								nodeType: "Argument",
								name: null,
								value: {
									nodeType: "Identifier",
									content: "argument3",
									position: {
										line: 1,
										column: 33,
									},
								},
							},
						],
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse Identifier FunctionInvocations with more than two arguments and a trailing comma", () => {
				let input = `invocation(argument, argument2, argument3,)`
				let output = [
					{
						nodeType: "FunctionInvocation",
						name: {
							nodeType: "Identifier",
							content: "invocation",
							position: {
								line: 1,
								column: 1,
							},
						},
						arguments: [
							{
								nodeType: "Argument",
								name: null,
								value: {
									nodeType: "Identifier",
									content: "argument",
									position: {
										line: 1,
										column: 12,
									},
								},
							},
							{
								nodeType: "Argument",
								name: null,
								value: {
									nodeType: "Identifier",
									content: "argument2",
									position: {
										line: 1,
										column: 22,
									},
								},
							},
							{
								nodeType: "Argument",
								name: null,
								value: {
									nodeType: "Identifier",
									content: "argument3",
									position: {
										line: 1,
										column: 33,
									},
								},
							},
						],
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse Lookup FunctionInvocations with more than two arguments and a trailing comma", () => {
				let input = `namespace.invocation(argument, argument2, argument3,)`
				let output = [
					{
						nodeType: "FunctionInvocation",
						name: {
							nodeType: "Lookup",
							base: {
								nodeType: "Identifier",
								content: "namespace",
								position: {
									line: 1,
									column: 1,
								},
							},
							member: {
								nodeType: "Identifier",
								content: "invocation",
								position: {
									line: 1,
									column: 11,
								},
							},
							position: {
								line: 1,
								column: 1,
							},
						},
						arguments: [
							{
								nodeType: "Argument",
								name: null,
								value: {
									nodeType: "Identifier",
									content: "argument",
									position: {
										line: 1,
										column: 22,
									},
								},
							},
							{
								nodeType: "Argument",
								name: null,
								value: {
									nodeType: "Identifier",
									content: "argument2",
									position: {
										line: 1,
										column: 32,
									},
								},
							},
							{
								nodeType: "Argument",
								name: null,
								value: {
									nodeType: "Identifier",
									content: "argument3",
									position: {
										line: 1,
										column: 43,
									},
								},
							},
						],
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse multiple FunctionInvocations in a row", () => {
				let input = `invocation(argument)
							 invocation(argument)`
				let output = [
					{
						nodeType: "FunctionInvocation",
						name: {
							nodeType: "Identifier",
							content: "invocation",
							position: {
								line: 1,
								column: 1,
							},
						},
						arguments: [
							{
								nodeType: "Argument",
								name: null,
								value: {
									nodeType: "Identifier",
									content: "argument",
									position: {
										line: 1,
										column: 12,
									},
								},
							},
						],
						position: {
							line: 1,
							column: 1,
						},
					},
					{
						nodeType: "FunctionInvocation",
						name: {
							nodeType: "Identifier",
							content: "invocation",
							position: {
								line: 2,
								column: 9,
							},
						},
						arguments: [
							{
								nodeType: "Argument",
								name: null,
								value: {
									nodeType: "Identifier",
									content: "argument",
									position: {
										line: 2,
										column: 20,
									},
								},
							},
						],
						position: {
							line: 2,
							column: 9,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})
		})

		describe("Lookups", () => {
			it("should parse simple Lookup", () => {
				let input = `lookup.member`
				let output = [
					{
						nodeType: "Lookup",
						base: {
							nodeType: "Identifier",
							content: "lookup",
							position: {
								line: 1,
								column: 1,
							},
						},
						member: {
							nodeType: "Identifier",
							content: "member",
							position: {
								line: 1,
								column: 8,
							},
						},
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse complex Lookup", () => {
				let input = `lookup.member1.member2`
				let output = [
					{
						nodeType: "Lookup",
						base: {
							nodeType: "Lookup",
							base: {
								nodeType: "Identifier",
								content: "lookup",
								position: {
									line: 1,
									column: 1,
								},
							},
							member: {
								nodeType: "Identifier",
								content: "member1",
								position: {
									line: 1,
									column: 8,
								},
							},
							position: {
								line: 1,
								column: 1,
							},
						},
						member: {
							nodeType: "Identifier",
							content: "member2",
							position: {
								line: 1,
								column: 16,
							},
						},
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})
		})

		describe("Identifiers", () => {
			it("should parse Identifiers", () => {
				let input = `identifier`
				let output = [
					{
						nodeType: "Identifier",
						content: "identifier",
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})
		})

		describe("Self", () => {
			it("should parse @", () => {
				let input = `@`
				let output = [
					{
						nodeType: "Self",
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})
		})

		describe("Combination", () => {
			it("should parse 2 identifier combinations", () => {
				let input = `base <| override`
				let output = [
					{
						nodeType: "Combination",
						lhs: {
							nodeType: "Identifier",
							content: "base",
							position: {
								line: 1,
								column: 1,
							},
						},
						rhs: {
							nodeType: "Identifier",
							content: "override",
							position: {
								line: 1,
								column: 9,
							},
						},
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})
		})

		describe("Literals", () => {
			describe("FunctionLiterals", () => {
				it("should parse FunctionLiterals with no parameters", () => {
					let input = `() -> Type {}`
					let output = [
						{
							nodeType: "FunctionValue",
							value: {
								nodeType: "FunctionDefinition",
								parameters: [],
								returnType: {
									nodeType: "IdentifierTypeDeclaration",
									type: {
										nodeType: "Identifier",
										content: "Type",
										position: {
											line: 1,
											column: 7,
										},
									},
									position: {
										line: 1,
										column: 7,
									},
								},
								body: [],
							},
							position: {
								line: 1,
								column: 1,
							},
						},
					]

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse FunctionLiterals with one parameter with explicit external name", () => {
					let input = `(external internal: Type) -> Type {
						<- internal
					}`
					let output = [
						{
							nodeType: "FunctionValue",
							value: {
								nodeType: "FunctionDefinition",
								parameters: [
									{
										nodeType: "Parameter",
										internalName: {
											nodeType: "Identifier",
											content: "internal",
											position: {
												line: 1,
												column: 11,
											},
										},
										externalName: {
											nodeType: "Identifier",
											content: "external",
											position: {
												line: 1,
												column: 2,
											},
										},
										type: {
											nodeType: "IdentifierTypeDeclaration",
											type: {
												nodeType: "Identifier",
												content: "Type",
												position: {
													line: 1,
													column: 21,
												},
											},
											position: {
												line: 1,
												column: 21,
											},
										},
										position: {
											line: 1,
											column: 2,
										},
									},
								],
								returnType: {
									nodeType: "IdentifierTypeDeclaration",
									type: {
										nodeType: "Identifier",
										content: "Type",
										position: {
											line: 1,
											column: 30,
										},
									},
									position: {
										line: 1,
										column: 30,
									},
								},
								body: [
									{
										nodeType: "ReturnStatement",
										expression: {
											nodeType: "Identifier",
											content: "internal",
											position: {
												line: 2,
												column: 10,
											},
										},
										position: {
											line: 2,
											column: 7,
										},
									},
								],
							},
							position: {
								line: 1,
								column: 1,
							},
						},
					]

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse FunctionLiterals with one parameter with implicit external name", () => {
					let input = `(internal: Type) -> Type {
						<- internal
					}`
					let output = [
						{
							nodeType: "FunctionValue",
							value: {
								nodeType: "FunctionDefinition",
								parameters: [
									{
										nodeType: "Parameter",
										internalName: {
											nodeType: "Identifier",
											content: "internal",
											position: {
												line: 1,
												column: 2,
											},
										},
										externalName: {
											nodeType: "Identifier",
											content: "internal",
											position: {
												line: 1,
												column: 2,
											},
										},
										type: {
											nodeType: "IdentifierTypeDeclaration",
											type: {
												nodeType: "Identifier",
												content: "Type",
												position: {
													line: 1,
													column: 12,
												},
											},
											position: {
												line: 1,
												column: 12,
											},
										},
										position: {
											line: 1,
											column: 2,
										},
									},
								],
								returnType: {
									nodeType: "IdentifierTypeDeclaration",
									type: {
										nodeType: "Identifier",
										content: "Type",
										position: {
											line: 1,
											column: 21,
										},
									},
									position: {
										line: 1,
										column: 21,
									},
								},
								body: [
									{
										nodeType: "ReturnStatement",
										expression: {
											nodeType: "Identifier",
											content: "internal",
											position: {
												line: 2,
												column: 10,
											},
										},
										position: {
											line: 2,
											column: 7,
										},
									},
								],
							},
							position: {
								line: 1,
								column: 1,
							},
						},
					]

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse FunctionLiterals with one parameter without external name", () => {
					let input = `(_ internal: Type) -> Type {
						<- internal
					}`
					let output = [
						{
							nodeType: "FunctionValue",
							value: {
								nodeType: "FunctionDefinition",
								parameters: [
									{
										nodeType: "Parameter",
										internalName: {
											nodeType: "Identifier",
											content: "internal",
											position: {
												line: 1,
												column: 4,
											},
										},
										externalName: null,
										type: {
											nodeType: "IdentifierTypeDeclaration",
											type: {
												nodeType: "Identifier",
												content: "Type",
												position: {
													line: 1,
													column: 14,
												},
											},
											position: {
												line: 1,
												column: 14,
											},
										},
										position: {
											line: 1,
											column: 2,
										},
									},
								],
								returnType: {
									nodeType: "IdentifierTypeDeclaration",
									type: {
										nodeType: "Identifier",
										content: "Type",
										position: {
											line: 1,
											column: 23,
										},
									},
									position: {
										line: 1,
										column: 23,
									},
								},
								body: [
									{
										nodeType: "ReturnStatement",
										expression: {
											nodeType: "Identifier",
											content: "internal",
											position: {
												line: 2,
												column: 10,
											},
										},
										position: {
											line: 2,
											column: 7,
										},
									},
								],
							},
							position: {
								line: 1,
								column: 1,
							},
						},
					]

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse FunctionLiterals with two parameters", () => {
					let input = `(external internal: Type, external2 internal2: Type) -> Type {
						<- internal
					}`
					let output = [
						{
							nodeType: "FunctionValue",
							value: {
								nodeType: "FunctionDefinition",
								parameters: [
									{
										nodeType: "Parameter",
										internalName: {
											nodeType: "Identifier",
											content: "internal",
											position: {
												line: 1,
												column: 11,
											},
										},
										externalName: {
											nodeType: "Identifier",
											content: "external",
											position: {
												line: 1,
												column: 2,
											},
										},
										type: {
											nodeType: "IdentifierTypeDeclaration",
											type: {
												nodeType: "Identifier",
												content: "Type",
												position: {
													line: 1,
													column: 21,
												},
											},
											position: {
												line: 1,
												column: 21,
											},
										},
										position: {
											line: 1,
											column: 2,
										},
									},
									{
										nodeType: "Parameter",
										internalName: {
											nodeType: "Identifier",
											content: "internal2",
											position: {
												line: 1,
												column: 37,
											},
										},
										externalName: {
											nodeType: "Identifier",
											content: "external2",
											position: {
												line: 1,
												column: 27,
											},
										},
										type: {
											nodeType: "IdentifierTypeDeclaration",
											type: {
												nodeType: "Identifier",
												content: "Type",
												position: {
													line: 1,
													column: 48,
												},
											},
											position: {
												line: 1,
												column: 48,
											},
										},
										position: {
											line: 1,
											column: 27,
										},
									},
								],
								returnType: {
									nodeType: "IdentifierTypeDeclaration",
									type: {
										nodeType: "Identifier",
										content: "Type",
										position: {
											line: 1,
											column: 57,
										},
									},
									position: {
										line: 1,
										column: 57,
									},
								},
								body: [
									{
										nodeType: "ReturnStatement",
										expression: {
											nodeType: "Identifier",
											content: "internal",
											position: {
												line: 2,
												column: 10,
											},
										},
										position: {
											line: 2,
											column: 7,
										},
									},
								],
							},
							position: {
								line: 1,
								column: 1,
							},
						},
					]

					expect<ParserNode>(parse(input)).toEqual(output)
				})
			})

			describe("AnonymousRecordLiteral", () => {
				it("should parse AnonymousRecordLiterals with a KeyValuePair", () => {
					let input = `{ key = value }`
					let output = [
						{
							nodeType: "RecordValue",
							type: null,
							members: {
								key: {
									nodeType: "Identifier",
									content: "value",
									position: {
										line: 1,
										column: 9,
									},
								},
							},
							position: {
								line: 1,
								column: 1,
							},
						},
					]

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse AnonymousRecordLiterals with a KeyValuePair with a trailing comma", () => {
					let input = `{ key = value, }`
					let output = [
						{
							nodeType: "RecordValue",
							type: null,
							members: {
								key: {
									nodeType: "Identifier",
									content: "value",
									position: {
										line: 1,
										column: 9,
									},
								},
							},
							position: {
								line: 1,
								column: 1,
							},
						},
					]

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse AnonymousRecordLiterals with multiple KeyValuePairs", () => {
					let input = `{ key = value, key2 = value2 }`
					let output = [
						{
							nodeType: "RecordValue",
							type: null,
							members: {
								key: {
									nodeType: "Identifier",
									content: "value",
									position: {
										line: 1,
										column: 9,
									},
								},
								key2: {
									nodeType: "Identifier",
									content: "value2",
									position: {
										line: 1,
										column: 23,
									},
								},
							},
							position: {
								line: 1,
								column: 1,
							},
						},
					]

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse AnonymousRecordLiterals with multiple KeyValuePairs with a trailing comma", () => {
					let input = `{ key = value, key2 = value2, }`
					let output = [
						{
							nodeType: "RecordValue",
							type: null,
							members: {
								key: {
									nodeType: "Identifier",
									content: "value",
									position: {
										line: 1,
										column: 9,
									},
								},
								key2: {
									nodeType: "Identifier",
									content: "value2",
									position: {
										line: 1,
										column: 23,
									},
								},
							},
							position: {
								line: 1,
								column: 1,
							},
						},
					]

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse AnonymousRecordLiterals with nested KeyValuePairs", () => {
					let input = `{ key = { key = value } }`
					let output = [
						{
							nodeType: "RecordValue",
							type: null,
							members: {
								key: {
									nodeType: "RecordValue",
									type: null,
									members: {
										key: {
											nodeType: "Identifier",
											content: "value",
											position: {
												line: 1,
												column: 17,
											},
										},
									},
									position: {
										line: 1,
										column: 9,
									},
								},
							},
							position: {
								line: 1,
								column: 1,
							},
						},
					]

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse AnonymousRecordLiterals with nested KeyValuePairs and some Linebreaks", () => {
					let input = `{
						key = {
							key = value
						}
					}`
					let output = [
						{
							nodeType: "RecordValue",
							type: null,
							members: {
								key: {
									nodeType: "RecordValue",
									type: null,
									members: {
										key: {
											nodeType: "Identifier",
											content: "value",
											position: {
												line: 3,
												column: 14,
											},
										},
									},
									position: {
										line: 2,
										column: 13,
									},
								},
							},
							position: {
								line: 1,
								column: 1,
							},
						},
					]

					expect<ParserNode>(parse(input)).toEqual(output)
				})
			})

			describe("TypedRecordLiterals", () => {
				it("should parse TypedRecordLiterals with a KeyValuePair", () => {
					let input = `Type ~> { key = value }`
					let output = [
						{
							nodeType: "RecordValue",
							type: {
								nodeType: "IdentifierTypeDeclaration",
								type: {
									nodeType: "Identifier",
									content: "Type",
									position: {
										line: 1,
										column: 1,
									},
								},
								position: {
									line: 1,
									column: 1,
								},
							},
							members: {
								key: {
									nodeType: "Identifier",
									content: "value",
									position: {
										line: 1,
										column: 17,
									},
								},
							},
							position: {
								line: 1,
								column: 1,
							},
						},
					]

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse TypedRecordLiterals with a KeyValuePair with a trailing comma", () => {
					let input = `Type ~> { key = value, }`
					let output = [
						{
							nodeType: "RecordValue",
							type: {
								nodeType: "IdentifierTypeDeclaration",
								type: {
									nodeType: "Identifier",
									content: "Type",
									position: {
										line: 1,
										column: 1,
									},
								},
								position: {
									line: 1,
									column: 1,
								},
							},
							members: {
								key: {
									nodeType: "Identifier",
									content: "value",
									position: {
										line: 1,
										column: 17,
									},
								},
							},
							position: {
								line: 1,
								column: 1,
							},
						},
					]

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse TypedRecordLiterals with multiple KeyValuePairs", () => {
					let input = `Type ~> { key = value, key2 = value2 }`
					let output = [
						{
							nodeType: "RecordValue",
							type: {
								nodeType: "IdentifierTypeDeclaration",
								type: {
									nodeType: "Identifier",
									content: "Type",
									position: {
										line: 1,
										column: 1,
									},
								},
								position: {
									line: 1,
									column: 1,
								},
							},
							members: {
								key: {
									nodeType: "Identifier",
									content: "value",
									position: {
										line: 1,
										column: 17,
									},
								},
								key2: {
									nodeType: "Identifier",
									content: "value2",
									position: {
										line: 1,
										column: 31,
									},
								},
							},
							position: {
								line: 1,
								column: 1,
							},
						},
					]

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse TypedRecordLiterals with multiple KeyValuePairs with a trailing comma", () => {
					let input = `Type ~> { key = value, key2 = value2, }`
					let output = [
						{
							nodeType: "RecordValue",
							type: {
								nodeType: "IdentifierTypeDeclaration",
								type: {
									nodeType: "Identifier",
									content: "Type",
									position: {
										line: 1,
										column: 1,
									},
								},
								position: {
									line: 1,
									column: 1,
								},
							},
							members: {
								key: {
									nodeType: "Identifier",
									content: "value",
									position: {
										line: 1,
										column: 17,
									},
								},
								key2: {
									nodeType: "Identifier",
									content: "value2",
									position: {
										line: 1,
										column: 31,
									},
								},
							},
							position: {
								line: 1,
								column: 1,
							},
						},
					]

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse TypedRecordLiterals with nested KeyValuePairs and some Linebreaks", () => {
					let input = `Type ~> {
						key = Type ~> {
							key = value
						}
					}`
					let output = [
						{
							nodeType: "RecordValue",
							type: {
								nodeType: "IdentifierTypeDeclaration",
								type: {
									nodeType: "Identifier",
									content: "Type",
									position: {
										line: 1,
										column: 1,
									},
								},
								position: {
									line: 1,
									column: 1,
								},
							},
							members: {
								key: {
									nodeType: "RecordValue",
									type: {
										nodeType: "IdentifierTypeDeclaration",
										type: {
											nodeType: "Identifier",
											content: "Type",
											position: {
												line: 2,
												column: 13,
											},
										},
										position: {
											line: 2,
											column: 13,
										},
									},
									members: {
										key: {
											nodeType: "Identifier",
											content: "value",
											position: {
												line: 3,
												column: 14,
											},
										},
									},
									position: {
										line: 2,
										column: 13,
									},
								},
							},
							position: {
								line: 1,
								column: 1,
							},
						},
					]

					expect<ParserNode>(parse(input)).toEqual(output)
				})
			})

			describe("BooleanLiterals", () => {
				it("should parse `true` BooleanLiterals", () => {
					let input = `true`
					let output = [
						{
							nodeType: "BooleanValue",
							value: true,
							position: {
								line: 1,
								column: 1,
							},
						},
					]

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse `false` BooleanLiterals", () => {
					let input = `false`
					let output = [
						{
							nodeType: "BooleanValue",
							value: false,
							position: {
								line: 1,
								column: 1,
							},
						},
					]

					expect<ParserNode>(parse(input)).toEqual(output)
				})
			})

			describe("StringLiterals", () => {
				it("should parse empty StringLiterals", () => {
					let input = `""`
					let output = [
						{
							nodeType: "StringValue",
							value: "",
							position: {
								line: 1,
								column: 1,
							},
						},
					]

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse filled StringLiterals", () => {
					let input = `"string"`
					let output = [
						{
							nodeType: "StringValue",
							value: "string",
							position: {
								line: 1,
								column: 1,
							},
						},
					]

					expect<ParserNode>(parse(input)).toEqual(output)
				})
			})

			describe("NumberLiterals", () => {
				it("should parse simple NumberLiterals", () => {
					let input = `123`
					let output = [
						{
							nodeType: "NumberValue",
							value: "123",
							position: {
								line: 1,
								column: 1,
							},
						},
					]

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse simple NumberLiterals with underscores", () => {
					let input = `1_000`
					let output = [
						{
							nodeType: "NumberValue",
							value: "1000",
							position: {
								line: 1,
								column: 1,
							},
						},
					]

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse float NumberLiterals", () => {
					let input = `1.5`
					let output = [
						{
							nodeType: "NumberValue",
							value: "1.5",
							position: {
								line: 1,
								column: 1,
							},
						},
					]

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse float NumberLiterals with underscores", () => {
					let input = `1_000.5`
					let output = [
						{
							nodeType: "NumberValue",
							value: "1000.5",
							position: {
								line: 1,
								column: 1,
							},
						},
					]

					expect<ParserNode>(parse(input)).toEqual(output)
				})
			})

			describe("ArrayLiterals", () => {
				it("should parse an empty Array", () => {
					let input = `[]`
					let output = [
						{
							nodeType: "ArrayValue",
							values: [],
							position: {
								line: 1,
								column: 1,
							},
						},
					]

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse an Array with a single item", () => {
					let input = `[0]`
					let output = [
						{
							nodeType: "ArrayValue",
							values: [
								{
									nodeType: "NumberValue",
									value: "0",
									position: {
										line: 1,
										column: 2,
									},
								},
							],
							position: {
								line: 1,
								column: 1,
							},
						},
					]

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse an Array with multiple items", () => {
					let input = `[0, 1, 2,]`
					let output = [
						{
							nodeType: "ArrayValue",
							values: [
								{
									nodeType: "NumberValue",
									value: "0",
									position: {
										line: 1,
										column: 2,
									},
								},
								{
									nodeType: "NumberValue",
									value: "1",
									position: {
										line: 1,
										column: 5,
									},
								},
								{
									nodeType: "NumberValue",
									value: "2",
									position: {
										line: 1,
										column: 8,
									},
								},
							],
							position: {
								line: 1,
								column: 1,
							},
						},
					]

					expect<ParserNode>(parse(input)).toEqual(output)
				})
			})
		})
	})

	describe("Statements", () => {
		describe("ReturnStatements", () => {
			it("should parse ReturnStatements", () => {
				let input = `<- identifier
				`
				let output = [
					{
						nodeType: "ReturnStatement",
						expression: {
							nodeType: "Identifier",
							content: "identifier",
							position: {
								line: 1,
								column: 4,
							},
						},
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})
		})

		describe("IfStatements", () => {
			it("should parse IfStatements", () => {
				let input = `if identifier {}
				`
				let output = [
					{
						nodeType: "IfStatement",
						condition: {
							nodeType: "Identifier",
							content: "identifier",
							position: {
								line: 1,
								column: 4,
							},
						},
						body: [],
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse IfElseStatements", () => {
				let input = `if identifier {} else {}
				`
				let output = [
					{
						nodeType: "IfElseStatement",
						condition: {
							nodeType: "Identifier",
							content: "identifier",
							position: {
								line: 1,
								column: 4,
							},
						},
						trueBody: [],
						falseBody: [],
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse IfElse-If-Statements", () => {
				let input = `if identifier {} else if identifier2 {}
				`
				let output = [
					{
						nodeType: "IfElseStatement",
						condition: {
							nodeType: "Identifier",
							content: "identifier",
							position: {
								line: 1,
								column: 4,
							},
						},
						trueBody: [],
						falseBody: [
							{
								nodeType: "IfStatement",
								condition: {
									nodeType: "Identifier",
									content: "identifier2",
									position: {
										line: 1,
										column: 26,
									},
								},
								body: [],
								position: {
									line: 1,
									column: 23,
								},
							},
						],
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse IfElse-IfElse-Statements", () => {
				let input = `if identifier {} else if identifier2 {} else {}
				`
				let output = [
					{
						nodeType: "IfElseStatement",
						condition: {
							nodeType: "Identifier",
							content: "identifier",
							position: {
								line: 1,
								column: 4,
							},
						},
						trueBody: [],
						falseBody: [
							{
								nodeType: "IfElseStatement",
								condition: {
									nodeType: "Identifier",
									content: "identifier2",
									position: {
										line: 1,
										column: 26,
									},
								},
								trueBody: [],
								falseBody: [],
								position: {
									line: 1,
									column: 23,
								},
							},
						],
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse IfElse-IfElse-If-Statements", () => {
				let input = `if identifier {} else if identifier2 {} else if identifier3 {}
				`
				let output = [
					{
						nodeType: "IfElseStatement",
						condition: {
							nodeType: "Identifier",
							content: "identifier",
							position: {
								line: 1,
								column: 4,
							},
						},
						trueBody: [],
						falseBody: [
							{
								nodeType: "IfElseStatement",
								condition: {
									nodeType: "Identifier",
									content: "identifier2",
									position: {
										line: 1,
										column: 26,
									},
								},
								trueBody: [],
								falseBody: [
									{
										nodeType: "IfStatement",
										condition: {
											nodeType: "Identifier",
											content: "identifier3",
											position: {
												line: 1,
												column: 49,
											},
										},
										body: [],
										position: {
											line: 1,
											column: 46,
										},
									},
								],
								position: {
									line: 1,
									column: 23,
								},
							},
						],
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})
		})

		describe("ConstantDeclarationStatements", () => {
			it("should parse ConstantDeclarationStatement", () => {
				let input = `constant identifier = ""`
				let output = [
					{
						nodeType: "ConstantDeclarationStatement",
						type: null,
						name: {
							nodeType: "Identifier",
							content: "identifier",
							position: {
								line: 1,
								column: 10,
							},
						},
						value: {
							nodeType: "StringValue",
							value: "",
							position: {
								line: 1,
								column: 23,
							},
						},
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})
		})

		describe("VariableDeclarationStatements", () => {
			it("should parse VariableDeclarationStatement without type", () => {
				let input = `variable identifier = ""`
				let output = [
					{
						nodeType: "VariableDeclarationStatement",
						type: null,
						name: {
							nodeType: "Identifier",
							content: "identifier",
							position: {
								line: 1,
								column: 10,
							},
						},
						value: {
							nodeType: "StringValue",
							value: "",
							position: {
								line: 1,
								column: 23,
							},
						},
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse VariableDeclarationStatement with Array Type", () => {
				let input = `variable [String] strings = []`
				let output = [
					{
						nodeType: "VariableDeclarationStatement",
						type: {
							nodeType: "ArrayTypeDeclaration",
							type: {
								nodeType: "IdentifierTypeDeclaration",
								type: {
									nodeType: "Identifier",
									content: "String",
									position: {
										line: 1,
										column: 11,
									},
								},
								position: {
									line: 1,
									column: 11,
								},
							},
							position: {
								line: 1,
								column: 10,
							},
						},
						name: {
							nodeType: "Identifier",
							content: "strings",
							position: {
								line: 1,
								column: 19,
							},
						},
						value: {
							nodeType: "ArrayValue",
							values: [],
							position: {
								line: 1,
								column: 29,
							},
						},
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})
		})

		describe("VariableAssignmentStatements", () => {
			it("should parse VariableAssignmentStatement", () => {
				let input = `identifier = ""`
				let output = [
					{
						nodeType: "VariableAssignmentStatement",
						name: {
							nodeType: "Identifier",
							content: "identifier",
							position: {
								line: 1,
								column: 1,
							},
						},
						value: {
							nodeType: "StringValue",
							value: "",
							position: {
								line: 1,
								column: 14,
							},
						},
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})
		})

		describe("TypeDefinitionStatements", () => {
			it("should parse an empty TypeDefinitionStatement", () => {
				let input = `type Type {}`
				let output = [
					{
						nodeType: "TypeDefinitionStatement",
						name: {
							nodeType: "Identifier",
							content: "Type",
							position: {
								line: 1,
								column: 6,
							},
						},
						properties: {},
						methods: {},
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse TypeDefinitionStatements with one Property", () => {
				let input = `type Type {
					property: Type
				}`
				let output = [
					{
						nodeType: "TypeDefinitionStatement",
						name: {
							nodeType: "Identifier",
							content: "Type",
							position: {
								line: 1,
								column: 6,
							},
						},
						properties: {
							property: {
								nodeType: "IdentifierTypeDeclaration",
								type: {
									nodeType: "Identifier",
									content: "Type",
									position: {
										line: 2,
										column: 16,
									},
								},
								position: {
									line: 2,
									column: 16,
								},
							},
						},
						methods: {},
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse TypeDefinitionStatements with multiple Properties", () => {
				let input = `type Type {
					property: Type
					property2: Type2
				}`
				let output = [
					{
						nodeType: "TypeDefinitionStatement",
						name: {
							nodeType: "Identifier",
							content: "Type",
							position: {
								line: 1,
								column: 6,
							},
						},
						properties: {
							property: {
								nodeType: "IdentifierTypeDeclaration",
								type: {
									nodeType: "Identifier",
									content: "Type",
									position: {
										line: 2,
										column: 16,
									},
								},
								position: {
									line: 2,
									column: 16,
								},
							},
							property2: {
								nodeType: "IdentifierTypeDeclaration",
								type: {
									nodeType: "Identifier",
									content: "Type2",
									position: {
										line: 3,
										column: 17,
									},
								},
								position: {
									line: 3,
									column: 17,
								},
							},
						},
						methods: {},
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse TypeDefinitionStatements with one Method", () => {
				let input = `type Type {
					method(parameter: Type) -> Type {
						<- parameter
					}
				}`
				let output = [
					{
						nodeType: "TypeDefinitionStatement",
						name: {
							nodeType: "Identifier",
							content: "Type",
							position: {
								line: 1,
								column: 6,
							},
						},
						properties: {},
						methods: {
							method: {
								method: {
									nodeType: "FunctionValue",
									value: {
										nodeType: "FunctionDefinition",
										parameters: [
											{
												nodeType: "Parameter",
												externalName: {
													nodeType: "Identifier",
													content: "parameter",
													position: {
														line: 2,
														column: 13,
													},
												},
												internalName: {
													nodeType: "Identifier",
													content: "parameter",
													position: {
														line: 2,
														column: 13,
													},
												},
												type: {
													nodeType: "IdentifierTypeDeclaration",
													type: {
														nodeType: "Identifier",
														content: "Type",
														position: {
															line: 2,
															column: 24,
														},
													},
													position: {
														line: 2,
														column: 24,
													},
												},
												position: {
													line: 2,
													column: 13,
												},
											},
										],
										returnType: {
											nodeType: "IdentifierTypeDeclaration",
											type: {
												nodeType: "Identifier",
												content: "Type",
												position: {
													line: 2,
													column: 33,
												},
											},
											position: {
												line: 2,
												column: 33,
											},
										},
										body: [
											{
												nodeType: "ReturnStatement",
												expression: {
													nodeType: "Identifier",
													content: "parameter",
													position: {
														line: 3,
														column: 10,
													},
												},
												position: {
													line: 3,
													column: 7,
												},
											},
										],
									},
									position: {
										line: 2,
										column: 12,
									},
								},
								isStatic: false,
							},
						},
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse TypeDefinitionStatements with one static Method", () => {
				let input = `type Type {
					static method(parameter: Type) -> Type {
						<- parameter
					}
				}`
				let output = [
					{
						nodeType: "TypeDefinitionStatement",
						name: {
							nodeType: "Identifier",
							content: "Type",
							position: {
								line: 1,
								column: 6,
							},
						},
						properties: {},
						methods: {
							method: {
								method: {
									nodeType: "FunctionValue",
									value: {
										nodeType: "FunctionDefinition",
										parameters: [
											{
												nodeType: "Parameter",
												externalName: {
													nodeType: "Identifier",
													content: "parameter",
													position: {
														line: 2,
														column: 20,
													},
												},
												internalName: {
													nodeType: "Identifier",
													content: "parameter",
													position: {
														line: 2,
														column: 20,
													},
												},
												type: {
													nodeType: "IdentifierTypeDeclaration",
													type: {
														nodeType: "Identifier",
														content: "Type",
														position: {
															line: 2,
															column: 31,
														},
													},
													position: {
														line: 2,
														column: 31,
													},
												},
												position: {
													line: 2,
													column: 20,
												},
											},
										],
										returnType: {
											nodeType: "IdentifierTypeDeclaration",
											type: {
												nodeType: "Identifier",
												content: "Type",
												position: {
													line: 2,
													column: 40,
												},
											},
											position: {
												line: 2,
												column: 40,
											},
										},
										body: [
											{
												nodeType: "ReturnStatement",
												expression: {
													nodeType: "Identifier",
													content: "parameter",
													position: {
														line: 3,
														column: 10,
													},
												},
												position: {
													line: 3,
													column: 7,
												},
											},
										],
									},
									position: {
										line: 2,
										column: 19,
									},
								},
								isStatic: true,
							},
						},
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse TypeDefinitionStatements with multiple Methods", () => {
				let input = `type Type {
					method(parameter: Type) -> Type {
						<- parameter
					}
					method2(parameter: Type) -> Type {
						<- parameter
					}
				}`
				let output = [
					{
						nodeType: "TypeDefinitionStatement",
						name: {
							nodeType: "Identifier",
							content: "Type",
							position: {
								line: 1,
								column: 6,
							},
						},
						properties: {},
						methods: {
							method: {
								method: {
									nodeType: "FunctionValue",
									value: {
										nodeType: "FunctionDefinition",
										parameters: [
											{
												nodeType: "Parameter",
												externalName: {
													nodeType: "Identifier",
													content: "parameter",
													position: {
														line: 2,
														column: 13,
													},
												},
												internalName: {
													nodeType: "Identifier",
													content: "parameter",
													position: {
														line: 2,
														column: 13,
													},
												},
												type: {
													nodeType: "IdentifierTypeDeclaration",
													type: {
														nodeType: "Identifier",
														content: "Type",
														position: {
															line: 2,
															column: 24,
														},
													},
													position: {
														line: 2,
														column: 24,
													},
												},
												position: {
													line: 2,
													column: 13,
												},
											},
										],
										returnType: {
											nodeType: "IdentifierTypeDeclaration",
											type: {
												nodeType: "Identifier",
												content: "Type",
												position: {
													line: 2,
													column: 33,
												},
											},
											position: {
												line: 2,
												column: 33,
											},
										},
										body: [
											{
												nodeType: "ReturnStatement",
												expression: {
													nodeType: "Identifier",
													content: "parameter",
													position: {
														line: 3,
														column: 10,
													},
												},
												position: {
													line: 3,
													column: 7,
												},
											},
										],
									},
									position: {
										line: 2,
										column: 12,
									},
								},
								isStatic: false,
							},
							method2: {
								method: {
									nodeType: "FunctionValue",
									value: {
										nodeType: "FunctionDefinition",
										parameters: [
											{
												nodeType: "Parameter",
												externalName: {
													nodeType: "Identifier",
													content: "parameter",
													position: {
														line: 5,
														column: 14,
													},
												},
												internalName: {
													nodeType: "Identifier",
													content: "parameter",
													position: {
														line: 5,
														column: 14,
													},
												},
												type: {
													nodeType: "IdentifierTypeDeclaration",
													type: {
														nodeType: "Identifier",
														content: "Type",
														position: {
															line: 5,
															column: 25,
														},
													},
													position: {
														line: 5,
														column: 25,
													},
												},
												position: {
													line: 5,
													column: 14,
												},
											},
										],
										returnType: {
											nodeType: "IdentifierTypeDeclaration",
											type: {
												nodeType: "Identifier",
												content: "Type",
												position: {
													line: 5,
													column: 34,
												},
											},
											position: {
												line: 5,
												column: 34,
											},
										},
										body: [
											{
												nodeType: "ReturnStatement",
												expression: {
													nodeType: "Identifier",
													content: "parameter",
													position: {
														line: 6,
														column: 10,
													},
												},
												position: {
													line: 6,
													column: 7,
												},
											},
										],
									},
									position: {
										line: 5,
										column: 13,
									},
								},
								isStatic: false,
							},
						},
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse TypeDefinitionStatements with Methods and Properties", () => {
				let input = `type Type {
					property: PropertyType
					method(parameter: Type) -> Type {
						<- parameter
					}
				}`
				let output = [
					{
						nodeType: "TypeDefinitionStatement",
						name: {
							nodeType: "Identifier",
							content: "Type",
							position: {
								line: 1,
								column: 6,
							},
						},
						properties: {
							property: {
								nodeType: "IdentifierTypeDeclaration",
								type: {
									nodeType: "Identifier",
									content: "PropertyType",
									position: {
										line: 2,
										column: 16,
									},
								},
								position: {
									line: 2,
									column: 16,
								},
							},
						},
						methods: {
							method: {
								method: {
									nodeType: "FunctionValue",
									value: {
										nodeType: "FunctionDefinition",
										parameters: [
											{
												nodeType: "Parameter",
												externalName: {
													nodeType: "Identifier",
													content: "parameter",
													position: {
														line: 3,
														column: 13,
													},
												},
												internalName: {
													nodeType: "Identifier",
													content: "parameter",
													position: {
														line: 3,
														column: 13,
													},
												},
												type: {
													nodeType: "IdentifierTypeDeclaration",
													type: {
														nodeType: "Identifier",
														content: "Type",
														position: {
															line: 3,
															column: 24,
														},
													},
													position: {
														line: 3,
														column: 24,
													},
												},
												position: {
													line: 3,
													column: 13,
												},
											},
										],
										returnType: {
											nodeType: "IdentifierTypeDeclaration",
											type: {
												nodeType: "Identifier",
												content: "Type",
												position: {
													line: 3,
													column: 33,
												},
											},
											position: {
												line: 3,
												column: 33,
											},
										},
										body: [
											{
												nodeType: "ReturnStatement",
												expression: {
													nodeType: "Identifier",
													content: "parameter",
													position: {
														line: 4,
														column: 10,
													},
												},
												position: {
													line: 4,
													column: 7,
												},
											},
										],
									},
									position: {
										line: 3,
										column: 12,
									},
								},
								isStatic: false,
							},
						},
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})
		})

		describe("FunctionStatements", () => {
			it("should parse FunctionStatements with no parameters", () => {
				let input = `function name () -> Type {}`
				let output = [
					{
						nodeType: "FunctionStatement",
						name: {
							nodeType: "Identifier",
							content: "name",
							position: {
								line: 1,
								column: 10,
							},
						},
						value: {
							nodeType: "FunctionDefinition",
							parameters: [],
							returnType: {
								nodeType: "IdentifierTypeDeclaration",
								type: {
									nodeType: "Identifier",
									content: "Type",
									position: {
										line: 1,
										column: 21,
									},
								},
								position: {
									line: 1,
									column: 21,
								},
							},
							body: [],
						},
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse FunctionLiterals with one parameter with explicit external name", () => {
				let input = `function name (external internal: Type) -> Type {
					<- internal
				}`
				let output = [
					{
						nodeType: "FunctionStatement",
						name: {
							nodeType: "Identifier",
							content: "name",
							position: {
								line: 1,
								column: 10,
							},
						},
						value: {
							nodeType: "FunctionDefinition",
							parameters: [
								{
									nodeType: "Parameter",
									externalName: {
										nodeType: "Identifier",
										content: "external",
										position: {
											line: 1,
											column: 16,
										},
									},
									internalName: {
										nodeType: "Identifier",
										content: "internal",
										position: {
											line: 1,
											column: 25,
										},
									},
									type: {
										nodeType: "IdentifierTypeDeclaration",
										type: {
											nodeType: "Identifier",
											content: "Type",
											position: {
												line: 1,
												column: 35,
											},
										},
										position: {
											line: 1,
											column: 35,
										},
									},
									position: {
										line: 1,
										column: 16,
									},
								},
							],
							returnType: {
								nodeType: "IdentifierTypeDeclaration",
								type: {
									nodeType: "Identifier",
									content: "Type",
									position: {
										line: 1,
										column: 44,
									},
								},
								position: {
									line: 1,
									column: 44,
								},
							},
							body: [
								{
									nodeType: "ReturnStatement",
									expression: {
										nodeType: "Identifier",
										content: "internal",
										position: {
											line: 2,
											column: 9,
										},
									},
									position: {
										line: 2,
										column: 6,
									},
								},
							],
						},
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse FunctionLiterals with one parameter with implicit external name", () => {
				let input = `function name (internal: Type) -> Type {
					<- internal
				}`
				let output = [
					{
						nodeType: "FunctionStatement",
						name: {
							nodeType: "Identifier",
							content: "name",
							position: {
								line: 1,
								column: 10,
							},
						},
						value: {
							nodeType: "FunctionDefinition",
							parameters: [
								{
									nodeType: "Parameter",
									externalName: {
										nodeType: "Identifier",
										content: "internal",
										position: {
											line: 1,
											column: 16,
										},
									},
									internalName: {
										nodeType: "Identifier",
										content: "internal",
										position: {
											line: 1,
											column: 16,
										},
									},
									type: {
										nodeType: "IdentifierTypeDeclaration",
										type: {
											nodeType: "Identifier",
											content: "Type",
											position: {
												line: 1,
												column: 26,
											},
										},
										position: {
											line: 1,
											column: 26,
										},
									},
									position: {
										line: 1,
										column: 16,
									},
								},
							],
							returnType: {
								nodeType: "IdentifierTypeDeclaration",
								type: {
									nodeType: "Identifier",
									content: "Type",
									position: {
										line: 1,
										column: 35,
									},
								},
								position: {
									line: 1,
									column: 35,
								},
							},
							body: [
								{
									nodeType: "ReturnStatement",
									expression: {
										nodeType: "Identifier",
										content: "internal",
										position: {
											line: 2,
											column: 9,
										},
									},
									position: {
										line: 2,
										column: 6,
									},
								},
							],
						},
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse FunctionLiterals with one parameter without external name", () => {
				let input = `function name (_ internal: Type) -> Type {
					<- internal
				}`
				let output = [
					{
						nodeType: "FunctionStatement",
						name: {
							nodeType: "Identifier",
							content: "name",
							position: {
								line: 1,
								column: 10,
							},
						},
						value: {
							nodeType: "FunctionDefinition",
							parameters: [
								{
									nodeType: "Parameter",
									externalName: null,
									internalName: {
										nodeType: "Identifier",
										content: "internal",
										position: {
											line: 1,
											column: 18,
										},
									},
									type: {
										nodeType: "IdentifierTypeDeclaration",
										type: {
											nodeType: "Identifier",
											content: "Type",
											position: {
												line: 1,
												column: 28,
											},
										},
										position: {
											line: 1,
											column: 28,
										},
									},
									position: {
										line: 1,
										column: 16,
									},
								},
							],
							returnType: {
								nodeType: "IdentifierTypeDeclaration",
								type: {
									nodeType: "Identifier",
									content: "Type",
									position: {
										line: 1,
										column: 37,
									},
								},
								position: {
									line: 1,
									column: 37,
								},
							},
							body: [
								{
									nodeType: "ReturnStatement",
									expression: {
										nodeType: "Identifier",
										content: "internal",
										position: {
											line: 2,
											column: 9,
										},
									},
									position: {
										line: 2,
										column: 6,
									},
								},
							],
						},
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse FunctionLiterals with two parameters", () => {
				let input = `function name (external internal: Type, external2 internal2: Type) -> Type {
					<- internal
				}`
				let output = [
					{
						nodeType: "FunctionStatement",
						name: {
							nodeType: "Identifier",
							content: "name",
							position: {
								line: 1,
								column: 10,
							},
						},
						value: {
							nodeType: "FunctionDefinition",
							parameters: [
								{
									nodeType: "Parameter",
									externalName: {
										nodeType: "Identifier",
										content: "external",
										position: {
											line: 1,
											column: 16,
										},
									},
									internalName: {
										nodeType: "Identifier",
										content: "internal",
										position: {
											line: 1,
											column: 25,
										},
									},
									type: {
										nodeType: "IdentifierTypeDeclaration",
										type: {
											nodeType: "Identifier",
											content: "Type",
											position: {
												line: 1,
												column: 35,
											},
										},
										position: {
											line: 1,
											column: 35,
										},
									},
									position: {
										line: 1,
										column: 16,
									},
								},
								{
									nodeType: "Parameter",
									internalName: {
										nodeType: "Identifier",
										content: "internal2",
										position: {
											line: 1,
											column: 51,
										},
									},
									externalName: {
										nodeType: "Identifier",
										content: "external2",
										position: {
											line: 1,
											column: 41,
										},
									},
									type: {
										nodeType: "IdentifierTypeDeclaration",
										type: {
											nodeType: "Identifier",
											content: "Type",
											position: {
												line: 1,
												column: 62,
											},
										},
										position: {
											line: 1,
											column: 62,
										},
									},
									position: {
										line: 1,
										column: 41,
									},
								},
							],
							returnType: {
								nodeType: "IdentifierTypeDeclaration",
								type: {
									nodeType: "Identifier",
									content: "Type",
									position: {
										line: 1,
										column: 71,
									},
								},
								position: {
									line: 1,
									column: 71,
								},
							},
							body: [
								{
									nodeType: "ReturnStatement",
									expression: {
										nodeType: "Identifier",
										content: "internal",
										position: {
											line: 2,
											column: 9,
										},
									},
									position: {
										line: 2,
										column: 6,
									},
								},
							],
						},
						position: {
							line: 1,
							column: 1,
						},
					},
				]

				expect<ParserNode>(parse(input)).toEqual(output)
			})
		})
	})
})
