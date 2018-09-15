import { parse } from "../parser"

// Infinitely deep console.logs for convenience
const util = require("util")
util.inspect.defaultOptions.depth = null

type ParserNode = any

describe("Parser", () => {
	describe("Expressions", () => {
		describe("NativeInvocations", () => {
			it("should not parse NativePrefix without Identifier", () => {
				let input = `implementation { __ }`

				expect(() => parse(input)).toThrow()
			})

			it("should not parse NativeLookups without second Identifier", () => {
				let input = `implementation { __lookup. }`

				expect(() => parse(input)).toThrow()
			})

			it("should parse NativeFunctionInvocation with one argument", () => {
				let input = `implementation { __lookup(argument) }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "NativeFunctionInvocation",
								name: {
									nodeType: "Identifier",
									content: "__lookup",
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 26,
										},
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
												start: {
													line: 1,
													column: 27,
												},
												end: {
													line: 1,
													column: 35,
												},
											},
										},
									},
								],
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 36,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 38 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 38 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse NativeFunctionInvocation with one argument with trailing comma", () => {
				let input = `implementation { __lookup(argument,) }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "NativeFunctionInvocation",
								name: {
									nodeType: "Identifier",
									content: "__lookup",
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 26,
										},
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
												start: {
													line: 1,
													column: 27,
												},
												end: {
													line: 1,
													column: 35,
												},
											},
										},
									},
								],
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 37,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 39 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 39 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse NativeFunctionInvocation with multiple arguments", () => {
				let input = `implementation { __lookup(argument, argument2) }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "NativeFunctionInvocation",
								name: {
									nodeType: "Identifier",
									content: "__lookup",
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 26,
										},
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
												start: {
													line: 1,
													column: 27,
												},
												end: {
													line: 1,
													column: 35,
												},
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
												start: {
													line: 1,
													column: 37,
												},
												end: {
													line: 1,
													column: 46,
												},
											},
										},
									},
								],
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 47,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 49 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 49 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse NativeFunctionInvocation with multiple arguments with trailing comma", () => {
				let input = `implementation { __lookup(argument, argument2,) }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "NativeFunctionInvocation",
								name: {
									nodeType: "Identifier",
									content: "__lookup",
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 26,
										},
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
												start: {
													line: 1,
													column: 27,
												},
												end: {
													line: 1,
													column: 35,
												},
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
												start: {
													line: 1,
													column: 37,
												},
												end: {
													line: 1,
													column: 46,
												},
											},
										},
									},
								],
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 48,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 50 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 50 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})
		})

		describe("MethodInvocations", () => {
			it("should parse MethodInvocation with 0 external parameters", () => {
				let input = `implementation { lookup::member() }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "MethodInvocation",
								name: {
									nodeType: "MethodLookup",
									base: {
										nodeType: "Identifier",
										content: "lookup",
										position: {
											start: {
												line: 1,
												column: 18,
											},
											end: {
												line: 1,
												column: 24,
											},
										},
									},
									member: {
										nodeType: "Identifier",
										content: "member",
										position: {
											start: {
												line: 1,
												column: 26,
											},
											end: {
												line: 1,
												column: 32,
											},
										},
									},
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 32,
										},
									},
								},
								arguments: [],
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 34,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 36 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 36 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse MethodInvocation", () => {
				let input = `implementation { lookup::member(argument) }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "MethodInvocation",
								name: {
									nodeType: "MethodLookup",
									base: {
										nodeType: "Identifier",
										content: "lookup",
										position: {
											start: {
												line: 1,
												column: 18,
											},
											end: {
												line: 1,
												column: 24,
											},
										},
									},
									member: {
										nodeType: "Identifier",
										content: "member",
										position: {
											start: {
												line: 1,
												column: 26,
											},
											end: {
												line: 1,
												column: 32,
											},
										},
									},
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 32,
										},
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
												start: {
													line: 1,
													column: 33,
												},
												end: {
													line: 1,
													column: 41,
												},
											},
										},
									},
								],
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 42,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 44 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 44 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse chained MethodInvocations", () => {
				let input = `implementation { lookup::member(argument)::member(argument) }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
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
													start: {
														line: 1,
														column: 18,
													},
													end: {
														line: 1,
														column: 24,
													},
												},
											},
											member: {
												nodeType: "Identifier",
												content: "member",
												position: {
													start: {
														line: 1,
														column: 26,
													},
													end: {
														line: 1,
														column: 32,
													},
												},
											},
											position: {
												start: {
													line: 1,
													column: 18,
												},
												end: {
													line: 1,
													column: 32,
												},
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
														start: {
															line: 1,
															column: 33,
														},
														end: {
															line: 1,
															column: 41,
														},
													},
												},
											},
										],
										position: {
											start: {
												line: 1,
												column: 18,
											},
											end: {
												line: 1,
												column: 42,
											},
										},
									},
									member: {
										nodeType: "Identifier",
										content: "member",
										position: {
											start: {
												line: 1,
												column: 44,
											},
											end: {
												line: 1,
												column: 50,
											},
										},
									},
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 50,
										},
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
												start: {
													line: 1,
													column: 51,
												},
												end: {
													line: 1,
													column: 59,
												},
											},
										},
									},
								],
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 60,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 62 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 62 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})
		})

		describe("MethodLookups", () => {
			it("should parse Identifier MethodLookups", () => {
				let input = `implementation { identifier::member }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "MethodLookup",
								base: {
									nodeType: "Identifier",
									content: "identifier",
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 28,
										},
									},
								},
								member: {
									nodeType: "Identifier",
									content: "member",
									position: {
										start: {
											line: 1,
											column: 30,
										},
										end: {
											line: 1,
											column: 36,
										},
									},
								},
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 36,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 38 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 38 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse Lookup MethodLookups", () => {
				let input = `implementation { identifier.lookup::member }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "MethodLookup",
								base: {
									nodeType: "Lookup",
									base: {
										nodeType: "Identifier",
										content: "identifier",
										position: {
											start: {
												line: 1,
												column: 18,
											},
											end: {
												line: 1,
												column: 28,
											},
										},
									},
									member: {
										nodeType: "Identifier",
										content: "lookup",
										position: {
											start: {
												line: 1,
												column: 29,
											},
											end: {
												line: 1,
												column: 35,
											},
										},
									},
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 35,
										},
									},
								},
								member: {
									nodeType: "Identifier",
									content: "member",
									position: {
										start: {
											line: 1,
											column: 37,
										},
										end: {
											line: 1,
											column: 43,
										},
									},
								},
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 43,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 45 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 45 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should not parse chained MethodLookups", () => {
				let input = `implementation { lookup::member1::member2 }`

				expect(() => parse(input)).toThrow()
			})
		})

		describe("FunctionInvocations", () => {
			it("should parse Identifier FunctionInvocations with one argument", () => {
				let input = `implementation { invocation(argument) }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "FunctionInvocation",
								name: {
									nodeType: "Identifier",
									content: "invocation",
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 28,
										},
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
												start: {
													line: 1,
													column: 29,
												},
												end: {
													line: 1,
													column: 37,
												},
											},
										},
									},
								],
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 38,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 40 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 40 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse Identifier FunctionInvocations with one labelled argument", () => {
				let input = `implementation { invocation(with argument) }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "FunctionInvocation",
								name: {
									nodeType: "Identifier",
									content: "invocation",
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 28,
										},
									},
								},
								arguments: [
									{
										nodeType: "Argument",
										name: {
											nodeType: "Identifier",
											content: "with",
											position: {
												start: {
													line: 1,
													column: 29,
												},
												end: {
													line: 1,
													column: 33,
												},
											},
										},
										value: {
											nodeType: "Identifier",
											content: "argument",
											position: {
												start: {
													line: 1,
													column: 34,
												},
												end: {
													line: 1,
													column: 42,
												},
											},
										},
									},
								],
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 43,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 45 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 45 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse Identifier FunctionInvocations with one argument and a trailing comma", () => {
				let input = `implementation { invocation(argument,) }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "FunctionInvocation",
								name: {
									nodeType: "Identifier",
									content: "invocation",
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 28,
										},
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
												start: {
													line: 1,
													column: 29,
												},
												end: {
													line: 1,
													column: 37,
												},
											},
										},
									},
								],
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 39,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 41 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 41 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse Identifier FunctionInvocations with two arguments", () => {
				let input = `implementation { invocation(argument, argument2) }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "FunctionInvocation",
								name: {
									nodeType: "Identifier",
									content: "invocation",
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 28,
										},
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
												start: {
													line: 1,
													column: 29,
												},
												end: {
													line: 1,
													column: 37,
												},
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
												start: {
													line: 1,
													column: 39,
												},
												end: {
													line: 1,
													column: 48,
												},
											},
										},
									},
								],
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 49,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 51 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 51 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse Identifier FunctionInvocations with two arguments and a trailing comma", () => {
				let input = `implementation { invocation(argument, argument2,) }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "FunctionInvocation",
								name: {
									nodeType: "Identifier",
									content: "invocation",
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 28,
										},
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
												start: {
													line: 1,
													column: 29,
												},
												end: {
													line: 1,
													column: 37,
												},
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
												start: {
													line: 1,
													column: 39,
												},
												end: {
													line: 1,
													column: 48,
												},
											},
										},
									},
								],
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 50,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 52 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 52 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse Identifier FunctionInvocations with more than two arguments", () => {
				let input = `implementation { invocation(argument, argument2, argument3) }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "FunctionInvocation",
								name: {
									nodeType: "Identifier",
									content: "invocation",
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 28,
										},
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
												start: {
													line: 1,
													column: 29,
												},
												end: {
													line: 1,
													column: 37,
												},
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
												start: {
													line: 1,
													column: 39,
												},
												end: {
													line: 1,
													column: 48,
												},
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
												start: {
													line: 1,
													column: 50,
												},
												end: {
													line: 1,
													column: 59,
												},
											},
										},
									},
								],
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 60,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 62 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 62 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse Identifier FunctionInvocations with more than two arguments and a trailing comma", () => {
				let input = `implementation { invocation(argument, argument2, argument3,) }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "FunctionInvocation",
								name: {
									nodeType: "Identifier",
									content: "invocation",
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 28,
										},
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
												start: {
													line: 1,
													column: 29,
												},
												end: {
													line: 1,
													column: 37,
												},
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
												start: {
													line: 1,
													column: 39,
												},
												end: {
													line: 1,
													column: 48,
												},
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
												start: {
													line: 1,
													column: 50,
												},
												end: {
													line: 1,
													column: 59,
												},
											},
										},
									},
								],
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 61,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 63 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 63 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse Lookup FunctionInvocations with more than two arguments and a trailing comma", () => {
				let input = `implementation { namespace.invocation(argument, argument2, argument3,) }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "FunctionInvocation",
								name: {
									nodeType: "Lookup",
									base: {
										nodeType: "Identifier",
										content: "namespace",
										position: {
											start: {
												line: 1,
												column: 18,
											},
											end: {
												line: 1,
												column: 27,
											},
										},
									},
									member: {
										nodeType: "Identifier",
										content: "invocation",
										position: {
											start: {
												line: 1,
												column: 28,
											},
											end: {
												line: 1,
												column: 38,
											},
										},
									},
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 38,
										},
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
												start: {
													line: 1,
													column: 39,
												},
												end: {
													line: 1,
													column: 47,
												},
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
												start: {
													line: 1,
													column: 49,
												},
												end: {
													line: 1,
													column: 58,
												},
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
												start: {
													line: 1,
													column: 60,
												},
												end: {
													line: 1,
													column: 69,
												},
											},
										},
									},
								],
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 71,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 73 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 73 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse multiple FunctionInvocations in a row", () => {
				let input = `implementation {
					invocation(argument)
					invocation(argument)
				}`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "FunctionInvocation",
								name: {
									nodeType: "Identifier",
									content: "invocation",
									position: {
										start: {
											line: 2,
											column: 6,
										},
										end: {
											line: 2,
											column: 16,
										},
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
												start: {
													line: 2,
													column: 17,
												},
												end: {
													line: 2,
													column: 25,
												},
											},
										},
									},
								],
								position: {
									start: {
										line: 2,
										column: 6,
									},
									end: {
										line: 2,
										column: 26,
									},
								},
							},
							{
								nodeType: "FunctionInvocation",
								name: {
									nodeType: "Identifier",
									content: "invocation",
									position: {
										start: {
											line: 3,
											column: 6,
										},
										end: {
											line: 3,
											column: 16,
										},
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
												start: {
													line: 3,
													column: 17,
												},
												end: {
													line: 3,
													column: 25,
												},
											},
										},
									},
								],
								position: {
									start: {
										line: 3,
										column: 6,
									},
									end: {
										line: 3,
										column: 26,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 4, column: 6 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 4, column: 6 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})
		})

		describe("Lookups", () => {
			it("should parse simple Lookup", () => {
				let input = `implementation { lookup.member }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "Lookup",
								base: {
									nodeType: "Identifier",
									content: "lookup",
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 24,
										},
									},
								},
								member: {
									nodeType: "Identifier",
									content: "member",
									position: {
										start: {
											line: 1,
											column: 25,
										},
										end: {
											line: 1,
											column: 31,
										},
									},
								},
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 31,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 33 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 33 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse complex Lookup", () => {
				let input = `implementation { lookup.member1.member2 }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "Lookup",
								base: {
									nodeType: "Lookup",
									base: {
										nodeType: "Identifier",
										content: "lookup",
										position: {
											start: {
												line: 1,
												column: 18,
											},
											end: {
												line: 1,
												column: 24,
											},
										},
									},
									member: {
										nodeType: "Identifier",
										content: "member1",
										position: {
											start: {
												line: 1,
												column: 25,
											},
											end: {
												line: 1,
												column: 32,
											},
										},
									},
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 32,
										},
									},
								},
								member: {
									nodeType: "Identifier",
									content: "member2",
									position: {
										start: {
											line: 1,
											column: 33,
										},
										end: {
											line: 1,
											column: 40,
										},
									},
								},
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 40,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 42 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 42 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})
		})

		describe("Identifiers", () => {
			it("should parse Identifiers", () => {
				let input = `implementation { identifier }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "Identifier",
								content: "identifier",
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 28,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 30 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 30 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})
		})

		describe("Self", () => {
			it("should parse @", () => {
				let input = `implementation { @ }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "Self",
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 19,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 21 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 21 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})
		})

		describe("Combination", () => {
			it("should parse 2 identifier combinations", () => {
				let input = `implementation { base <| override }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "Combination",
								lhs: {
									nodeType: "Identifier",
									content: "base",
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 22,
										},
									},
								},
								rhs: {
									nodeType: "Identifier",
									content: "override",
									position: {
										start: {
											line: 1,
											column: 26,
										},
										end: {
											line: 1,
											column: 34,
										},
									},
								},
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 34,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 36 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 36 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})
		})

		describe("Literals", () => {
			describe("FunctionLiterals", () => {
				it("should parse FunctionLiterals with no parameters", () => {
					let input = `implementation { () -> Type {} }`
					let output = {
						nodeType: "Program",
						implementation: {
							nodeType: "ImplementationSection",
							nodes: [
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
													start: {
														line: 1,
														column: 24,
													},
													end: {
														line: 1,
														column: 28,
													},
												},
											},
											position: {
												start: {
													line: 1,
													column: 24,
												},
												end: {
													line: 1,
													column: 28,
												},
											},
										},
										body: [],
									},
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 31,
										},
									},
								},
							],
							position: {
								start: { line: 1, column: 1 },
								end: { line: 1, column: 33 },
							},
						},
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 33 },
						},
					}

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse FunctionLiterals with one parameter with explicit external name", () => {
					let input = `implementation {
						(external internal: Type) -> Type {
							<- internal
						}
					}`
					let output = {
						nodeType: "Program",
						implementation: {
							nodeType: "ImplementationSection",
							nodes: [
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
														start: {
															line: 2,
															column: 17,
														},
														end: {
															line: 2,
															column: 25,
														},
													},
												},
												externalName: {
													nodeType: "Identifier",
													content: "external",
													position: {
														start: {
															line: 2,
															column: 8,
														},
														end: {
															line: 2,
															column: 16,
														},
													},
												},
												type: {
													nodeType: "IdentifierTypeDeclaration",
													type: {
														nodeType: "Identifier",
														content: "Type",
														position: {
															start: {
																line: 2,
																column: 27,
															},
															end: {
																line: 2,
																column: 31,
															},
														},
													},
													position: {
														start: {
															line: 2,
															column: 27,
														},
														end: {
															line: 2,
															column: 31,
														},
													},
												},
												position: {
													start: {
														line: 2,
														column: 8,
													},
													end: {
														line: 2,
														column: 31,
													},
												},
											},
										],
										returnType: {
											nodeType: "IdentifierTypeDeclaration",
											type: {
												nodeType: "Identifier",
												content: "Type",
												position: {
													start: {
														line: 2,
														column: 36,
													},
													end: {
														line: 2,
														column: 40,
													},
												},
											},
											position: {
												start: {
													line: 2,
													column: 36,
												},
												end: {
													line: 2,
													column: 40,
												},
											},
										},
										body: [
											{
												nodeType: "ReturnStatement",
												expression: {
													nodeType: "Identifier",
													content: "internal",
													position: {
														start: {
															line: 3,
															column: 11,
														},
														end: {
															line: 3,
															column: 19,
														},
													},
												},
												position: {
													start: {
														line: 3,
														column: 8,
													},
													end: {
														line: 3,
														column: 19,
													},
												},
											},
										],
									},
									position: {
										start: {
											line: 2,
											column: 7,
										},
										end: {
											line: 4,
											column: 8,
										},
									},
								},
							],
							position: {
								start: { line: 1, column: 1 },
								end: { line: 5, column: 7 },
							},
						},
						position: {
							start: { line: 1, column: 1 },
							end: { line: 5, column: 7 },
						},
					}

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse FunctionLiterals with one parameter with implicit external name", () => {
					let input = `implementation {
						(internal: Type) -> Type {
							<- internal
						}
					}`
					let output = {
						nodeType: "Program",
						implementation: {
							nodeType: "ImplementationSection",
							nodes: [
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
														start: {
															line: 2,
															column: 8,
														},
														end: {
															line: 2,
															column: 16,
														},
													},
												},
												externalName: {
													nodeType: "Identifier",
													content: "internal",
													position: {
														start: {
															line: 2,
															column: 8,
														},
														end: {
															line: 2,
															column: 16,
														},
													},
												},
												type: {
													nodeType: "IdentifierTypeDeclaration",
													type: {
														nodeType: "Identifier",
														content: "Type",
														position: {
															start: {
																line: 2,
																column: 18,
															},
															end: {
																line: 2,
																column: 22,
															},
														},
													},
													position: {
														start: {
															line: 2,
															column: 18,
														},
														end: {
															line: 2,
															column: 22,
														},
													},
												},
												position: {
													start: {
														line: 2,
														column: 8,
													},
													end: {
														line: 2,
														column: 22,
													},
												},
											},
										],
										returnType: {
											nodeType: "IdentifierTypeDeclaration",
											type: {
												nodeType: "Identifier",
												content: "Type",
												position: {
													start: {
														line: 2,
														column: 27,
													},
													end: {
														line: 2,
														column: 31,
													},
												},
											},
											position: {
												start: {
													line: 2,
													column: 27,
												},
												end: {
													line: 2,
													column: 31,
												},
											},
										},
										body: [
											{
												nodeType: "ReturnStatement",
												expression: {
													nodeType: "Identifier",
													content: "internal",
													position: {
														start: {
															line: 3,
															column: 11,
														},
														end: {
															line: 3,
															column: 19,
														},
													},
												},
												position: {
													start: {
														line: 3,
														column: 8,
													},
													end: {
														line: 3,
														column: 19,
													},
												},
											},
										],
									},
									position: {
										start: {
											line: 2,
											column: 7,
										},
										end: {
											line: 4,
											column: 8,
										},
									},
								},
							],
							position: {
								start: { line: 1, column: 1 },
								end: { line: 5, column: 7 },
							},
						},
						position: {
							start: { line: 1, column: 1 },
							end: { line: 5, column: 7 },
						},
					}

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse FunctionLiterals with one parameter without external name", () => {
					let input = `implementation {
						(_ internal: Type) -> Type {
							<- internal
						}
					}`
					let output = {
						nodeType: "Program",
						implementation: {
							nodeType: "ImplementationSection",
							nodes: [
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
														start: {
															line: 2,
															column: 10,
														},
														end: {
															line: 2,
															column: 18,
														},
													},
												},
												externalName: null,
												type: {
													nodeType: "IdentifierTypeDeclaration",
													type: {
														nodeType: "Identifier",
														content: "Type",
														position: {
															start: {
																line: 2,
																column: 20,
															},
															end: {
																line: 2,
																column: 24,
															},
														},
													},
													position: {
														start: {
															line: 2,
															column: 20,
														},
														end: {
															line: 2,
															column: 24,
														},
													},
												},
												position: {
													start: {
														line: 2,
														column: 8,
													},
													end: {
														line: 2,
														column: 24,
													},
												},
											},
										],
										returnType: {
											nodeType: "IdentifierTypeDeclaration",
											type: {
												nodeType: "Identifier",
												content: "Type",
												position: {
													start: {
														line: 2,
														column: 29,
													},
													end: {
														line: 2,
														column: 33,
													},
												},
											},
											position: {
												start: {
													line: 2,
													column: 29,
												},
												end: {
													line: 2,
													column: 33,
												},
											},
										},
										body: [
											{
												nodeType: "ReturnStatement",
												expression: {
													nodeType: "Identifier",
													content: "internal",
													position: {
														start: {
															line: 3,
															column: 11,
														},
														end: {
															line: 3,
															column: 19,
														},
													},
												},
												position: {
													start: {
														line: 3,
														column: 8,
													},
													end: {
														line: 3,
														column: 19,
													},
												},
											},
										],
									},
									position: {
										start: {
											line: 2,
											column: 7,
										},
										end: {
											line: 4,
											column: 8,
										},
									},
								},
							],
							position: {
								start: { line: 1, column: 1 },
								end: { line: 5, column: 7 },
							},
						},
						position: {
							start: { line: 1, column: 1 },
							end: { line: 5, column: 7 },
						},
					}

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse FunctionLiterals with two parameters", () => {
					let input = `implementation {
						(external internal: Type, external2 internal2: Type) -> Type {
							<- internal
						}
					}`
					let output = {
						nodeType: "Program",
						implementation: {
							nodeType: "ImplementationSection",
							nodes: [
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
														start: {
															line: 2,
															column: 17,
														},
														end: {
															line: 2,
															column: 25,
														},
													},
												},
												externalName: {
													nodeType: "Identifier",
													content: "external",
													position: {
														start: {
															line: 2,
															column: 8,
														},
														end: {
															line: 2,
															column: 16,
														},
													},
												},
												type: {
													nodeType: "IdentifierTypeDeclaration",
													type: {
														nodeType: "Identifier",
														content: "Type",
														position: {
															start: {
																line: 2,
																column: 27,
															},
															end: {
																line: 2,
																column: 31,
															},
														},
													},
													position: {
														start: {
															line: 2,
															column: 27,
														},
														end: {
															line: 2,
															column: 31,
														},
													},
												},
												position: {
													start: {
														line: 2,
														column: 8,
													},
													end: {
														line: 2,
														column: 31,
													},
												},
											},
											{
												nodeType: "Parameter",
												internalName: {
													nodeType: "Identifier",
													content: "internal2",
													position: {
														start: {
															line: 2,
															column: 43,
														},
														end: {
															line: 2,
															column: 52,
														},
													},
												},
												externalName: {
													nodeType: "Identifier",
													content: "external2",
													position: {
														start: {
															line: 2,
															column: 33,
														},
														end: {
															line: 2,
															column: 42,
														},
													},
												},
												type: {
													nodeType: "IdentifierTypeDeclaration",
													type: {
														nodeType: "Identifier",
														content: "Type",
														position: {
															start: {
																line: 2,
																column: 54,
															},
															end: {
																line: 2,
																column: 58,
															},
														},
													},
													position: {
														start: {
															line: 2,
															column: 54,
														},
														end: {
															line: 2,
															column: 58,
														},
													},
												},
												position: {
													start: {
														line: 2,
														column: 33,
													},
													end: {
														line: 2,
														column: 58,
													},
												},
											},
										],
										returnType: {
											nodeType: "IdentifierTypeDeclaration",
											type: {
												nodeType: "Identifier",
												content: "Type",
												position: {
													start: {
														line: 2,
														column: 63,
													},
													end: {
														line: 2,
														column: 67,
													},
												},
											},
											position: {
												start: {
													line: 2,
													column: 63,
												},
												end: {
													line: 2,
													column: 67,
												},
											},
										},
										body: [
											{
												nodeType: "ReturnStatement",
												expression: {
													nodeType: "Identifier",
													content: "internal",
													position: {
														start: {
															line: 3,
															column: 11,
														},
														end: {
															line: 3,
															column: 19,
														},
													},
												},
												position: {
													start: {
														line: 3,
														column: 8,
													},
													end: {
														line: 3,
														column: 19,
													},
												},
											},
										],
									},
									position: {
										start: {
											line: 2,
											column: 7,
										},
										end: {
											line: 4,
											column: 8,
										},
									},
								},
							],
							position: {
								start: { line: 1, column: 1 },
								end: { line: 5, column: 7 },
							},
						},
						position: {
							start: { line: 1, column: 1 },
							end: { line: 5, column: 7 },
						},
					}

					expect<ParserNode>(parse(input)).toEqual(output)
				})
			})

			describe("AnonymousRecordLiteral", () => {
				it("should parse AnonymousRecordLiterals with a KeyValuePair", () => {
					let input = `implementation { { key = value } }`
					let output = {
						nodeType: "Program",
						implementation: {
							nodeType: "ImplementationSection",
							nodes: [
								{
									nodeType: "RecordValue",
									type: null,
									members: {
										key: {
											nodeType: "Identifier",
											content: "value",
											position: {
												start: {
													line: 1,
													column: 26,
												},
												end: {
													line: 1,
													column: 31,
												},
											},
										},
									},
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 33,
										},
									},
								},
							],
							position: {
								start: { line: 1, column: 1 },
								end: { line: 1, column: 35 },
							},
						},
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 35 },
						},
					}

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse AnonymousRecordLiterals with a KeyValuePair with a trailing comma", () => {
					let input = `implementation { { key = value, } }`
					let output = {
						nodeType: "Program",
						implementation: {
							nodeType: "ImplementationSection",
							nodes: [
								{
									nodeType: "RecordValue",
									type: null,
									members: {
										key: {
											nodeType: "Identifier",
											content: "value",
											position: {
												start: {
													line: 1,
													column: 26,
												},
												end: {
													line: 1,
													column: 31,
												},
											},
										},
									},
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 34,
										},
									},
								},
							],
							position: {
								start: { line: 1, column: 1 },
								end: { line: 1, column: 36 },
							},
						},
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 36 },
						},
					}

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse AnonymousRecordLiterals with multiple KeyValuePairs", () => {
					let input = `implementation { { key = value, key2 = value2 } }`
					let output = {
						nodeType: "Program",
						implementation: {
							nodeType: "ImplementationSection",
							nodes: [
								{
									nodeType: "RecordValue",
									type: null,
									members: {
										key: {
											nodeType: "Identifier",
											content: "value",
											position: {
												start: {
													line: 1,
													column: 26,
												},
												end: {
													line: 1,
													column: 31,
												},
											},
										},
										key2: {
											nodeType: "Identifier",
											content: "value2",
											position: {
												start: {
													line: 1,
													column: 40,
												},
												end: {
													line: 1,
													column: 46,
												},
											},
										},
									},
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 48,
										},
									},
								},
							],
							position: {
								start: { line: 1, column: 1 },
								end: { line: 1, column: 50 },
							},
						},
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 50 },
						},
					}

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse AnonymousRecordLiterals with multiple KeyValuePairs with a trailing comma", () => {
					let input = `implementation { { key = value, key2 = value2, } }`
					let output = {
						nodeType: "Program",
						implementation: {
							nodeType: "ImplementationSection",
							nodes: [
								{
									nodeType: "RecordValue",
									type: null,
									members: {
										key: {
											nodeType: "Identifier",
											content: "value",
											position: {
												start: {
													line: 1,
													column: 26,
												},
												end: {
													line: 1,
													column: 31,
												},
											},
										},
										key2: {
											nodeType: "Identifier",
											content: "value2",
											position: {
												start: {
													line: 1,
													column: 40,
												},
												end: {
													line: 1,
													column: 46,
												},
											},
										},
									},
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 49,
										},
									},
								},
							],
							position: {
								start: { line: 1, column: 1 },
								end: { line: 1, column: 51 },
							},
						},
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 51 },
						},
					}

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse AnonymousRecordLiterals with nested KeyValuePairs", () => {
					let input = `implementation { { key = { key = value } } }`
					let output = {
						nodeType: "Program",
						implementation: {
							nodeType: "ImplementationSection",
							nodes: [
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
														start: {
															line: 1,
															column: 34,
														},
														end: {
															line: 1,
															column: 39,
														},
													},
												},
											},
											position: {
												start: {
													line: 1,
													column: 26,
												},
												end: {
													line: 1,
													column: 41,
												},
											},
										},
									},
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 43,
										},
									},
								},
							],
							position: {
								start: { line: 1, column: 1 },
								end: { line: 1, column: 45 },
							},
						},
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 45 },
						},
					}

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse AnonymousRecordLiterals with nested KeyValuePairs and some Linebreaks", () => {
					let input = `implementation {
						{
							key = {
								key = value
							}
						}
					}`
					let output = {
						nodeType: "Program",
						implementation: {
							nodeType: "ImplementationSection",
							nodes: [
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
														start: {
															line: 4,
															column: 15,
														},
														end: {
															line: 4,
															column: 20,
														},
													},
												},
											},
											position: {
												start: {
													line: 3,
													column: 14,
												},
												end: {
													line: 5,
													column: 9,
												},
											},
										},
									},
									position: {
										start: {
											line: 2,
											column: 7,
										},
										end: {
											line: 6,
											column: 8,
										},
									},
								},
							],
							position: {
								start: { line: 1, column: 1 },
								end: { line: 7, column: 7 },
							},
						},
						position: {
							start: { line: 1, column: 1 },
							end: { line: 7, column: 7 },
						},
					}

					expect<ParserNode>(parse(input)).toEqual(output)
				})
			})

			describe("TypedRecordLiterals", () => {
				it("should parse TypedRecordLiterals with a KeyValuePair", () => {
					let input = `implementation { Type ~> { key = value } }`
					let output = {
						nodeType: "Program",
						implementation: {
							nodeType: "ImplementationSection",
							nodes: [
								{
									nodeType: "RecordValue",
									type: {
										nodeType: "IdentifierTypeDeclaration",
										type: {
											nodeType: "Identifier",
											content: "Type",
											position: {
												start: {
													line: 1,
													column: 18,
												},
												end: {
													line: 1,
													column: 22,
												},
											},
										},
										position: {
											start: {
												line: 1,
												column: 18,
											},
											end: {
												line: 1,
												column: 22,
											},
										},
									},
									members: {
										key: {
											nodeType: "Identifier",
											content: "value",
											position: {
												start: {
													line: 1,
													column: 34,
												},
												end: {
													line: 1,
													column: 39,
												},
											},
										},
									},
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 41,
										},
									},
								},
							],
							position: {
								start: { line: 1, column: 1 },
								end: { line: 1, column: 43 },
							},
						},
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 43 },
						},
					}

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse TypedRecordLiterals with a KeyValuePair with a trailing comma", () => {
					let input = `implementation { Type ~> { key = value, } }`
					let output = {
						nodeType: "Program",
						implementation: {
							nodeType: "ImplementationSection",
							nodes: [
								{
									nodeType: "RecordValue",
									type: {
										nodeType: "IdentifierTypeDeclaration",
										type: {
											nodeType: "Identifier",
											content: "Type",
											position: {
												start: {
													line: 1,
													column: 18,
												},
												end: {
													line: 1,
													column: 22,
												},
											},
										},
										position: {
											start: {
												line: 1,
												column: 18,
											},
											end: {
												line: 1,
												column: 22,
											},
										},
									},
									members: {
										key: {
											nodeType: "Identifier",
											content: "value",
											position: {
												start: {
													line: 1,
													column: 34,
												},
												end: {
													line: 1,
													column: 39,
												},
											},
										},
									},
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 42,
										},
									},
								},
							],
							position: {
								start: { line: 1, column: 1 },
								end: { line: 1, column: 44 },
							},
						},
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 44 },
						},
					}

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse TypedRecordLiterals with multiple KeyValuePairs", () => {
					let input = `implementation { Type ~> { key = value, key2 = value2 } }`
					let output = {
						nodeType: "Program",
						implementation: {
							nodeType: "ImplementationSection",
							nodes: [
								{
									nodeType: "RecordValue",
									type: {
										nodeType: "IdentifierTypeDeclaration",
										type: {
											nodeType: "Identifier",
											content: "Type",
											position: {
												start: {
													line: 1,
													column: 18,
												},
												end: {
													line: 1,
													column: 22,
												},
											},
										},
										position: {
											start: {
												line: 1,
												column: 18,
											},
											end: {
												line: 1,
												column: 22,
											},
										},
									},
									members: {
										key: {
											nodeType: "Identifier",
											content: "value",
											position: {
												start: {
													line: 1,
													column: 34,
												},
												end: {
													line: 1,
													column: 39,
												},
											},
										},
										key2: {
											nodeType: "Identifier",
											content: "value2",
											position: {
												start: {
													line: 1,
													column: 48,
												},
												end: {
													line: 1,
													column: 54,
												},
											},
										},
									},
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 56,
										},
									},
								},
							],
							position: {
								start: { line: 1, column: 1 },
								end: { line: 1, column: 58 },
							},
						},
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 58 },
						},
					}

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse TypedRecordLiterals with multiple KeyValuePairs with a trailing comma", () => {
					let input = `implementation { Type ~> { key = value, key2 = value2, } }`
					let output = {
						nodeType: "Program",
						implementation: {
							nodeType: "ImplementationSection",
							nodes: [
								{
									nodeType: "RecordValue",
									type: {
										nodeType: "IdentifierTypeDeclaration",
										type: {
											nodeType: "Identifier",
											content: "Type",
											position: {
												start: {
													line: 1,
													column: 18,
												},
												end: {
													line: 1,
													column: 22,
												},
											},
										},
										position: {
											start: {
												line: 1,
												column: 18,
											},
											end: {
												line: 1,
												column: 22,
											},
										},
									},
									members: {
										key: {
											nodeType: "Identifier",
											content: "value",
											position: {
												start: {
													line: 1,
													column: 34,
												},
												end: {
													line: 1,
													column: 39,
												},
											},
										},
										key2: {
											nodeType: "Identifier",
											content: "value2",
											position: {
												start: {
													line: 1,
													column: 48,
												},
												end: {
													line: 1,
													column: 54,
												},
											},
										},
									},
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 57,
										},
									},
								},
							],
							position: {
								start: { line: 1, column: 1 },
								end: { line: 1, column: 59 },
							},
						},
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 59 },
						},
					}

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse TypedRecordLiterals with nested KeyValuePairs and some Linebreaks", () => {
					let input = `implementation {
						Type ~> {
							key = Type ~> {
								key = value
							}
						}
					}`
					let output = {
						nodeType: "Program",
						implementation: {
							nodeType: "ImplementationSection",
							nodes: [
								{
									nodeType: "RecordValue",
									type: {
										nodeType: "IdentifierTypeDeclaration",
										type: {
											nodeType: "Identifier",
											content: "Type",
											position: {
												start: {
													line: 2,
													column: 7,
												},
												end: {
													line: 2,
													column: 11,
												},
											},
										},
										position: {
											start: {
												line: 2,
												column: 7,
											},
											end: {
												line: 2,
												column: 11,
											},
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
														start: {
															line: 3,
															column: 14,
														},
														end: {
															line: 3,
															column: 18,
														},
													},
												},
												position: {
													start: {
														line: 3,
														column: 14,
													},
													end: {
														line: 3,
														column: 18,
													},
												},
											},
											members: {
												key: {
													nodeType: "Identifier",
													content: "value",
													position: {
														start: {
															line: 4,
															column: 15,
														},
														end: {
															line: 4,
															column: 20,
														},
													},
												},
											},
											position: {
												start: {
													line: 3,
													column: 14,
												},
												end: {
													line: 5,
													column: 9,
												},
											},
										},
									},
									position: {
										start: {
											line: 2,
											column: 7,
										},
										end: {
											line: 6,
											column: 8,
										},
									},
								},
							],
							position: {
								start: { line: 1, column: 1 },
								end: { line: 7, column: 7 },
							},
						},
						position: {
							start: { line: 1, column: 1 },
							end: { line: 7, column: 7 },
						},
					}

					expect<ParserNode>(parse(input)).toEqual(output)
				})
			})

			describe("BooleanLiterals", () => {
				it("should parse `true` BooleanLiterals", () => {
					let input = `implementation { true }`
					let output = {
						nodeType: "Program",
						implementation: {
							nodeType: "ImplementationSection",
							nodes: [
								{
									nodeType: "BooleanValue",
									value: true,
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 22,
										},
									},
								},
							],
							position: {
								start: { line: 1, column: 1 },
								end: { line: 1, column: 24 },
							},
						},
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 24 },
						},
					}

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse `false` BooleanLiterals", () => {
					let input = `implementation { false }`
					let output = {
						nodeType: "Program",
						implementation: {
							nodeType: "ImplementationSection",
							nodes: [
								{
									nodeType: "BooleanValue",
									value: false,
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 23,
										},
									},
								},
							],
							position: {
								start: { line: 1, column: 1 },
								end: { line: 1, column: 25 },
							},
						},
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 25 },
						},
					}

					expect<ParserNode>(parse(input)).toEqual(output)
				})
			})

			describe("StringLiterals", () => {
				it("should parse empty StringLiterals", () => {
					let input = `implementation { "" }`
					let output = {
						nodeType: "Program",
						implementation: {
							nodeType: "ImplementationSection",
							nodes: [
								{
									nodeType: "StringValue",
									value: "",
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 20,
										},
									},
								},
							],
							position: {
								start: { line: 1, column: 1 },
								end: { line: 1, column: 22 },
							},
						},
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 22 },
						},
					}

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse filled StringLiterals", () => {
					let input = `implementation { "string" }`
					let output = {
						nodeType: "Program",
						implementation: {
							nodeType: "ImplementationSection",
							nodes: [
								{
									nodeType: "StringValue",
									value: "string",
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 26,
										},
									},
								},
							],
							position: {
								start: { line: 1, column: 1 },
								end: { line: 1, column: 28 },
							},
						},
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 28 },
						},
					}

					expect<ParserNode>(parse(input)).toEqual(output)
				})
			})

			describe("NumberLiterals", () => {
				it("should parse simple NumberLiterals", () => {
					let input = `implementation { 123 }`
					let output = {
						nodeType: "Program",
						implementation: {
							nodeType: "ImplementationSection",
							nodes: [
								{
									nodeType: "NumberValue",
									value: "123",
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 21,
										},
									},
								},
							],
							position: {
								start: { line: 1, column: 1 },
								end: { line: 1, column: 23 },
							},
						},
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 23 },
						},
					}

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse simple NumberLiterals with underscores", () => {
					let input = `implementation { 1_000 }`
					let output = {
						nodeType: "Program",
						implementation: {
							nodeType: "ImplementationSection",
							nodes: [
								{
									nodeType: "NumberValue",
									value: "1000",
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 23,
										},
									},
								},
							],
							position: {
								start: { line: 1, column: 1 },
								end: { line: 1, column: 25 },
							},
						},
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 25 },
						},
					}

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse float NumberLiterals", () => {
					let input = `implementation { 1.5 }`
					let output = {
						nodeType: "Program",
						implementation: {
							nodeType: "ImplementationSection",
							nodes: [
								{
									nodeType: "NumberValue",
									value: "1.5",
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 21,
										},
									},
								},
							],
							position: {
								start: { line: 1, column: 1 },
								end: { line: 1, column: 23 },
							},
						},
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 23 },
						},
					}

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse float NumberLiterals with underscores", () => {
					let input = `implementation { 1_000.5 }`
					let output = {
						nodeType: "Program",
						implementation: {
							nodeType: "ImplementationSection",
							nodes: [
								{
									nodeType: "NumberValue",
									value: "1000.5",
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 25,
										},
									},
								},
							],
							position: {
								start: { line: 1, column: 1 },
								end: { line: 1, column: 27 },
							},
						},
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 27 },
						},
					}

					expect<ParserNode>(parse(input)).toEqual(output)
				})
			})

			describe("ArrayLiterals", () => {
				it("should parse an empty Array", () => {
					let input = `implementation { [] }`
					let output = {
						nodeType: "Program",
						implementation: {
							nodeType: "ImplementationSection",
							nodes: [
								{
									nodeType: "ArrayValue",
									values: [],
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 20,
										},
									},
								},
							],
							position: {
								start: { line: 1, column: 1 },
								end: { line: 1, column: 22 },
							},
						},
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 22 },
						},
					}

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse an Array with a single item", () => {
					let input = `implementation { [0] }`
					let output = {
						nodeType: "Program",
						implementation: {
							nodeType: "ImplementationSection",
							nodes: [
								{
									nodeType: "ArrayValue",
									values: [
										{
											nodeType: "NumberValue",
											value: "0",
											position: {
												start: {
													line: 1,
													column: 19,
												},
												end: {
													line: 1,
													column: 20,
												},
											},
										},
									],
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 21,
										},
									},
								},
							],
							position: {
								start: { line: 1, column: 1 },
								end: { line: 1, column: 23 },
							},
						},
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 23 },
						},
					}

					expect<ParserNode>(parse(input)).toEqual(output)
				})

				it("should parse an Array with multiple items", () => {
					let input = `implementation { [0, 1, 2,] }`
					let output = {
						nodeType: "Program",
						implementation: {
							nodeType: "ImplementationSection",
							nodes: [
								{
									nodeType: "ArrayValue",
									values: [
										{
											nodeType: "NumberValue",
											value: "0",
											position: {
												start: {
													line: 1,
													column: 19,
												},
												end: {
													line: 1,
													column: 20,
												},
											},
										},
										{
											nodeType: "NumberValue",
											value: "1",
											position: {
												start: {
													line: 1,
													column: 22,
												},
												end: {
													line: 1,
													column: 23,
												},
											},
										},
										{
											nodeType: "NumberValue",
											value: "2",
											position: {
												start: {
													line: 1,
													column: 25,
												},
												end: {
													line: 1,
													column: 26,
												},
											},
										},
									],
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 28,
										},
									},
								},
							],
							position: {
								start: { line: 1, column: 1 },
								end: { line: 1, column: 30 },
							},
						},
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 30 },
						},
					}

					expect<ParserNode>(parse(input)).toEqual(output)
				})
			})
		})
	})

	describe("Statements", () => {
		describe("ReturnStatements", () => {
			it("should parse ReturnStatements", () => {
				let input = `implementation { <- identifier }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "ReturnStatement",
								expression: {
									nodeType: "Identifier",
									content: "identifier",
									position: {
										start: {
											line: 1,
											column: 21,
										},
										end: {
											line: 1,
											column: 31,
										},
									},
								},
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 31,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 33 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 33 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})
		})

		describe("IfStatements", () => {
			it("should parse IfStatements", () => {
				let input = `implementation { if identifier {} }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "IfStatement",
								condition: {
									nodeType: "Identifier",
									content: "identifier",
									position: {
										start: {
											line: 1,
											column: 21,
										},
										end: {
											line: 1,
											column: 31,
										},
									},
								},
								body: [],
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 34,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 36 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 36 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse IfElseStatements", () => {
				let input = `implementation { if identifier {} else {} }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "IfElseStatement",
								condition: {
									nodeType: "Identifier",
									content: "identifier",
									position: {
										start: {
											line: 1,
											column: 21,
										},
										end: {
											line: 1,
											column: 31,
										},
									},
								},
								trueBody: [],
								falseBody: [],
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 42,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 44 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 44 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse IfElse-If-Statements", () => {
				let input = `implementation { if identifier {} else if identifier2 {} }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "IfElseStatement",
								condition: {
									nodeType: "Identifier",
									content: "identifier",
									position: {
										start: {
											line: 1,
											column: 21,
										},
										end: {
											line: 1,
											column: 31,
										},
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
												start: {
													line: 1,
													column: 43,
												},
												end: {
													line: 1,
													column: 54,
												},
											},
										},
										body: [],
										position: {
											start: {
												line: 1,
												column: 40,
											},
											end: {
												line: 1,
												column: 57,
											},
										},
									},
								],
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 57,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 59 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 59 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse IfElse-IfElse-Statements", () => {
				let input = `implementation { if identifier {} else if identifier2 {} else {} }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "IfElseStatement",
								condition: {
									nodeType: "Identifier",
									content: "identifier",
									position: {
										start: {
											line: 1,
											column: 21,
										},
										end: {
											line: 1,
											column: 31,
										},
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
												start: {
													line: 1,
													column: 43,
												},
												end: {
													line: 1,
													column: 54,
												},
											},
										},
										trueBody: [],
										falseBody: [],
										position: {
											start: {
												line: 1,
												column: 40,
											},
											end: {
												line: 1,
												column: 65,
											},
										},
									},
								],
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 65,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 67 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 67 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse IfElse-IfElse-If-Statements", () => {
				let input = `implementation { if identifier {} else if identifier2 {} else if identifier3 {} }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "IfElseStatement",
								condition: {
									nodeType: "Identifier",
									content: "identifier",
									position: {
										start: {
											line: 1,
											column: 21,
										},
										end: {
											line: 1,
											column: 31,
										},
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
												start: {
													line: 1,
													column: 43,
												},
												end: {
													line: 1,
													column: 54,
												},
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
														start: {
															line: 1,
															column: 66,
														},
														end: {
															line: 1,
															column: 77,
														},
													},
												},
												body: [],
												position: {
													start: {
														line: 1,
														column: 63,
													},
													end: {
														line: 1,
														column: 80,
													},
												},
											},
										],
										position: {
											start: {
												line: 1,
												column: 40,
											},
											end: {
												line: 1,
												column: 80,
											},
										},
									},
								],
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 80,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 82 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 82 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})
		})

		describe("ConstantDeclarationStatements", () => {
			it("should parse ConstantDeclarationStatement", () => {
				let input = `implementation { constant identifier = "" }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "ConstantDeclarationStatement",
								type: null,
								name: {
									nodeType: "Identifier",
									content: "identifier",
									position: {
										start: {
											line: 1,
											column: 27,
										},
										end: {
											line: 1,
											column: 37,
										},
									},
								},
								value: {
									nodeType: "StringValue",
									value: "",
									position: {
										start: {
											line: 1,
											column: 40,
										},
										end: {
											line: 1,
											column: 42,
										},
									},
								},
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 42,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 44 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 44 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})
		})

		describe("VariableDeclarationStatements", () => {
			it("should parse VariableDeclarationStatement without type", () => {
				let input = `implementation { variable identifier = "" }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "VariableDeclarationStatement",
								type: null,
								name: {
									nodeType: "Identifier",
									content: "identifier",
									position: {
										start: {
											line: 1,
											column: 27,
										},
										end: {
											line: 1,
											column: 37,
										},
									},
								},
								value: {
									nodeType: "StringValue",
									value: "",
									position: {
										start: {
											line: 1,
											column: 40,
										},
										end: {
											line: 1,
											column: 42,
										},
									},
								},
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 42,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 44 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 44 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse VariableDeclarationStatement with Array Type", () => {
				let input = `implementation { variable [String] strings = [] }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
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
												start: {
													line: 1,
													column: 28,
												},
												end: {
													line: 1,
													column: 34,
												},
											},
										},
										position: {
											start: {
												line: 1,
												column: 28,
											},
											end: {
												line: 1,
												column: 34,
											},
										},
									},
									position: {
										start: {
											line: 1,
											column: 27,
										},
										end: {
											line: 1,
											column: 35,
										},
									},
								},
								name: {
									nodeType: "Identifier",
									content: "strings",
									position: {
										start: {
											line: 1,
											column: 36,
										},
										end: {
											line: 1,
											column: 43,
										},
									},
								},
								value: {
									nodeType: "ArrayValue",
									values: [],
									position: {
										start: {
											line: 1,
											column: 46,
										},
										end: {
											line: 1,
											column: 48,
										},
									},
								},
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 48,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 50 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 50 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})
		})

		describe("VariableAssignmentStatements", () => {
			it("should parse VariableAssignmentStatement", () => {
				let input = `implementation { identifier = "" }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "VariableAssignmentStatement",
								name: {
									nodeType: "Identifier",
									content: "identifier",
									position: {
										start: {
											line: 1,
											column: 18,
										},
										end: {
											line: 1,
											column: 28,
										},
									},
								},
								value: {
									nodeType: "StringValue",
									value: "",
									position: {
										start: {
											line: 1,
											column: 31,
										},
										end: {
											line: 1,
											column: 33,
										},
									},
								},
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 33,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 35 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 35 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})
		})

		describe("TypeDefinitionStatements", () => {
			it("should parse an empty TypeDefinitionStatement", () => {
				let input = `implementation { type Type {} }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "TypeDefinitionStatement",
								name: {
									nodeType: "Identifier",
									content: "Type",
									position: {
										start: {
											line: 1,
											column: 23,
										},
										end: {
											line: 1,
											column: 27,
										},
									},
								},
								properties: {},
								methods: {},
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 30,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 32 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 32 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse TypeDefinitionStatements with one Property", () => {
				let input = `implementation {
					type Type {
						property: Type
					}
				}`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "TypeDefinitionStatement",
								name: {
									nodeType: "Identifier",
									content: "Type",
									position: {
										start: {
											line: 2,
											column: 11,
										},
										end: {
											line: 2,
											column: 15,
										},
									},
								},
								properties: {
									property: {
										nodeType: "IdentifierTypeDeclaration",
										type: {
											nodeType: "Identifier",
											content: "Type",
											position: {
												start: {
													line: 3,
													column: 17,
												},
												end: {
													line: 3,
													column: 21,
												},
											},
										},
										position: {
											start: {
												line: 3,
												column: 17,
											},
											end: {
												line: 3,
												column: 21,
											},
										},
									},
								},
								methods: {},
								position: {
									start: {
										line: 2,
										column: 6,
									},
									end: {
										line: 4,
										column: 7,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 5, column: 6 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 5, column: 6 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse TypeDefinitionStatements with multiple Properties", () => {
				let input = `implementation {
					type Type {
						property: Type
						property2: Type2
					}
				}`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "TypeDefinitionStatement",
								name: {
									nodeType: "Identifier",
									content: "Type",
									position: {
										start: {
											line: 2,
											column: 11,
										},
										end: {
											line: 2,
											column: 15,
										},
									},
								},
								properties: {
									property: {
										nodeType: "IdentifierTypeDeclaration",
										type: {
											nodeType: "Identifier",
											content: "Type",
											position: {
												start: {
													line: 3,
													column: 17,
												},
												end: {
													line: 3,
													column: 21,
												},
											},
										},
										position: {
											start: {
												line: 3,
												column: 17,
											},
											end: {
												line: 3,
												column: 21,
											},
										},
									},
									property2: {
										nodeType: "IdentifierTypeDeclaration",
										type: {
											nodeType: "Identifier",
											content: "Type2",
											position: {
												start: {
													line: 4,
													column: 18,
												},
												end: {
													line: 4,
													column: 23,
												},
											},
										},
										position: {
											start: {
												line: 4,
												column: 18,
											},
											end: {
												line: 4,
												column: 23,
											},
										},
									},
								},
								methods: {},
								position: {
									start: {
										line: 2,
										column: 6,
									},
									end: {
										line: 5,
										column: 7,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 6, column: 6 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 6, column: 6 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse TypeDefinitionStatements with one Method", () => {
				let input = `implementation {
					type Type {
						method(parameter: Type) -> Type {
							<- parameter
						}
					}
				}`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "TypeDefinitionStatement",
								name: {
									nodeType: "Identifier",
									content: "Type",
									position: {
										start: {
											line: 2,
											column: 11,
										},
										end: {
											line: 2,
											column: 15,
										},
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
																start: {
																	line: 3,
																	column: 14,
																},
																end: {
																	line: 3,
																	column: 23,
																},
															},
														},
														internalName: {
															nodeType: "Identifier",
															content: "parameter",
															position: {
																start: {
																	line: 3,
																	column: 14,
																},
																end: {
																	line: 3,
																	column: 23,
																},
															},
														},
														type: {
															nodeType: "IdentifierTypeDeclaration",
															type: {
																nodeType: "Identifier",
																content: "Type",
																position: {
																	start: {
																		line: 3,
																		column: 25,
																	},
																	end: {
																		line: 3,
																		column: 29,
																	},
																},
															},
															position: {
																start: {
																	line: 3,
																	column: 25,
																},
																end: {
																	line: 3,
																	column: 29,
																},
															},
														},
														position: {
															start: {
																line: 3,
																column: 14,
															},
															end: {
																line: 3,
																column: 29,
															},
														},
													},
												],
												returnType: {
													nodeType: "IdentifierTypeDeclaration",
													type: {
														nodeType: "Identifier",
														content: "Type",
														position: {
															start: {
																line: 3,
																column: 34,
															},
															end: {
																line: 3,
																column: 38,
															},
														},
													},
													position: {
														start: {
															line: 3,
															column: 34,
														},
														end: {
															line: 3,
															column: 38,
														},
													},
												},
												body: [
													{
														nodeType: "ReturnStatement",
														expression: {
															nodeType: "Identifier",
															content: "parameter",
															position: {
																start: {
																	line: 4,
																	column: 11,
																},
																end: {
																	line: 4,
																	column: 20,
																},
															},
														},
														position: {
															start: {
																line: 4,
																column: 8,
															},
															end: {
																line: 4,
																column: 20,
															},
														},
													},
												],
											},
											position: {
												start: {
													line: 3,
													column: 13,
												},
												end: {
													line: 5,
													column: 8,
												},
											},
										},
										isStatic: false,
										isOverloaded: false,
									},
								},
								position: {
									start: {
										line: 2,
										column: 6,
									},
									end: {
										line: 6,
										column: 7,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 7, column: 6 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 7, column: 6 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse TypeDefinitionStatements with one static Method", () => {
				let input = `implementation {
					type Type {
						static method(parameter: Type) -> Type {
							<- parameter
						}
					}
				}`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "TypeDefinitionStatement",
								name: {
									nodeType: "Identifier",
									content: "Type",
									position: {
										start: {
											line: 2,
											column: 11,
										},
										end: {
											line: 2,
											column: 15,
										},
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
																start: {
																	line: 3,
																	column: 21,
																},
																end: {
																	line: 3,
																	column: 30,
																},
															},
														},
														internalName: {
															nodeType: "Identifier",
															content: "parameter",
															position: {
																start: {
																	line: 3,
																	column: 21,
																},
																end: {
																	line: 3,
																	column: 30,
																},
															},
														},
														type: {
															nodeType: "IdentifierTypeDeclaration",
															type: {
																nodeType: "Identifier",
																content: "Type",
																position: {
																	start: {
																		line: 3,
																		column: 32,
																	},
																	end: {
																		line: 3,
																		column: 36,
																	},
																},
															},
															position: {
																start: {
																	line: 3,
																	column: 32,
																},
																end: {
																	line: 3,
																	column: 36,
																},
															},
														},
														position: {
															start: {
																line: 3,
																column: 21,
															},
															end: {
																line: 3,
																column: 36,
															},
														},
													},
												],
												returnType: {
													nodeType: "IdentifierTypeDeclaration",
													type: {
														nodeType: "Identifier",
														content: "Type",
														position: {
															start: {
																line: 3,
																column: 41,
															},
															end: {
																line: 3,
																column: 45,
															},
														},
													},
													position: {
														start: {
															line: 3,
															column: 41,
														},
														end: {
															line: 3,
															column: 45,
														},
													},
												},
												body: [
													{
														nodeType: "ReturnStatement",
														expression: {
															nodeType: "Identifier",
															content: "parameter",
															position: {
																start: {
																	line: 4,
																	column: 11,
																},
																end: {
																	line: 4,
																	column: 20,
																},
															},
														},
														position: {
															start: {
																line: 4,
																column: 8,
															},
															end: {
																line: 4,
																column: 20,
															},
														},
													},
												],
											},
											position: {
												start: {
													line: 3,
													column: 20,
												},
												end: {
													line: 5,
													column: 8,
												},
											},
										},
										isStatic: true,
										isOverloaded: false,
									},
								},
								position: {
									start: {
										line: 2,
										column: 6,
									},
									end: {
										line: 6,
										column: 7,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 7, column: 6 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 7, column: 6 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse TypeDefinitionStatements with multiple Methods", () => {
				let input = `implementation {
					type Type {
						method(parameter: Type) -> Type {
							<- parameter
						}

						method2(parameter: Type) -> Type {
							<- parameter
						}
					}
				}`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "TypeDefinitionStatement",
								name: {
									nodeType: "Identifier",
									content: "Type",
									position: {
										start: {
											line: 2,
											column: 11,
										},
										end: {
											line: 2,
											column: 15,
										},
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
																start: {
																	line: 3,
																	column: 14,
																},
																end: {
																	line: 3,
																	column: 23,
																},
															},
														},
														internalName: {
															nodeType: "Identifier",
															content: "parameter",
															position: {
																start: {
																	line: 3,
																	column: 14,
																},
																end: {
																	line: 3,
																	column: 23,
																},
															},
														},
														type: {
															nodeType: "IdentifierTypeDeclaration",
															type: {
																nodeType: "Identifier",
																content: "Type",
																position: {
																	start: {
																		line: 3,
																		column: 25,
																	},
																	end: {
																		line: 3,
																		column: 29,
																	},
																},
															},
															position: {
																start: {
																	line: 3,
																	column: 25,
																},
																end: {
																	line: 3,
																	column: 29,
																},
															},
														},
														position: {
															start: {
																line: 3,
																column: 14,
															},
															end: {
																line: 3,
																column: 29,
															},
														},
													},
												],
												returnType: {
													nodeType: "IdentifierTypeDeclaration",
													type: {
														nodeType: "Identifier",
														content: "Type",
														position: {
															start: {
																line: 3,
																column: 34,
															},
															end: {
																line: 3,
																column: 38,
															},
														},
													},
													position: {
														start: {
															line: 3,
															column: 34,
														},
														end: {
															line: 3,
															column: 38,
														},
													},
												},
												body: [
													{
														nodeType: "ReturnStatement",
														expression: {
															nodeType: "Identifier",
															content: "parameter",
															position: {
																start: {
																	line: 4,
																	column: 11,
																},
																end: {
																	line: 4,
																	column: 20,
																},
															},
														},
														position: {
															start: {
																line: 4,
																column: 8,
															},
															end: {
																line: 4,
																column: 20,
															},
														},
													},
												],
											},
											position: {
												start: {
													line: 3,
													column: 13,
												},
												end: {
													line: 5,
													column: 8,
												},
											},
										},
										isStatic: false,
										isOverloaded: false,
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
																start: {
																	line: 7,
																	column: 15,
																},
																end: {
																	line: 7,
																	column: 24,
																},
															},
														},
														internalName: {
															nodeType: "Identifier",
															content: "parameter",
															position: {
																start: {
																	line: 7,
																	column: 15,
																},
																end: {
																	line: 7,
																	column: 24,
																},
															},
														},
														type: {
															nodeType: "IdentifierTypeDeclaration",
															type: {
																nodeType: "Identifier",
																content: "Type",
																position: {
																	start: {
																		line: 7,
																		column: 26,
																	},
																	end: {
																		line: 7,
																		column: 30,
																	},
																},
															},
															position: {
																start: {
																	line: 7,
																	column: 26,
																},
																end: {
																	line: 7,
																	column: 30,
																},
															},
														},
														position: {
															start: {
																line: 7,
																column: 15,
															},
															end: {
																line: 7,
																column: 30,
															},
														},
													},
												],
												returnType: {
													nodeType: "IdentifierTypeDeclaration",
													type: {
														nodeType: "Identifier",
														content: "Type",
														position: {
															start: {
																line: 7,
																column: 35,
															},
															end: {
																line: 7,
																column: 39,
															},
														},
													},
													position: {
														start: {
															line: 7,
															column: 35,
														},
														end: {
															line: 7,
															column: 39,
														},
													},
												},
												body: [
													{
														nodeType: "ReturnStatement",
														expression: {
															nodeType: "Identifier",
															content: "parameter",
															position: {
																start: {
																	line: 8,
																	column: 11,
																},
																end: {
																	line: 8,
																	column: 20,
																},
															},
														},
														position: {
															start: {
																line: 8,
																column: 8,
															},
															end: {
																line: 8,
																column: 20,
															},
														},
													},
												],
											},
											position: {
												start: {
													line: 7,
													column: 14,
												},
												end: {
													line: 9,
													column: 8,
												},
											},
										},
										isStatic: false,
										isOverloaded: false,
									},
								},
								position: {
									start: {
										line: 2,
										column: 6,
									},
									end: {
										line: 10,
										column: 7,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 11, column: 6 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 11, column: 6 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse TypeDefinitionStatements with overloaded Methods", () => {
				let input = `implementation {
					type Type {
						overload method(parameter: Type) -> Type {
							<- parameter
						}

						overload method(name parameter: Type) -> Type {
							<- parameter
						}
					}
				}`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "TypeDefinitionStatement",
								name: {
									nodeType: "Identifier",
									content: "Type",
									position: {
										start: {
											line: 2,
											column: 11,
										},
										end: {
											line: 2,
											column: 15,
										},
									},
								},
								properties: {},
								methods: {
									method: {
										methods: [
											{
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
																	start: {
																		line: 3,
																		column: 23,
																	},
																	end: {
																		line: 3,
																		column: 32,
																	},
																},
															},
															internalName: {
																nodeType: "Identifier",
																content: "parameter",
																position: {
																	start: {
																		line: 3,
																		column: 23,
																	},
																	end: {
																		line: 3,
																		column: 32,
																	},
																},
															},
															type: {
																nodeType: "IdentifierTypeDeclaration",
																type: {
																	nodeType: "Identifier",
																	content: "Type",
																	position: {
																		start: {
																			line: 3,
																			column: 34,
																		},
																		end: {
																			line: 3,
																			column: 38,
																		},
																	},
																},
																position: {
																	start: {
																		line: 3,
																		column: 34,
																	},
																	end: {
																		line: 3,
																		column: 38,
																	},
																},
															},
															position: {
																start: {
																	line: 3,
																	column: 23,
																},
																end: {
																	line: 3,
																	column: 38,
																},
															},
														},
													],
													returnType: {
														nodeType: "IdentifierTypeDeclaration",
														type: {
															nodeType: "Identifier",
															content: "Type",
															position: {
																start: {
																	line: 3,
																	column: 43,
																},
																end: {
																	line: 3,
																	column: 47,
																},
															},
														},
														position: {
															start: {
																line: 3,
																column: 43,
															},
															end: {
																line: 3,
																column: 47,
															},
														},
													},
													body: [
														{
															nodeType: "ReturnStatement",
															expression: {
																nodeType: "Identifier",
																content: "parameter",
																position: {
																	start: {
																		line: 4,
																		column: 11,
																	},
																	end: {
																		line: 4,
																		column: 20,
																	},
																},
															},
															position: {
																start: {
																	line: 4,
																	column: 8,
																},
																end: {
																	line: 4,
																	column: 20,
																},
															},
														},
													],
												},
												position: {
													start: {
														line: 3,
														column: 22,
													},
													end: {
														line: 5,
														column: 8,
													},
												},
											},{
												nodeType: "FunctionValue",
												value: {
													nodeType: "FunctionDefinition",
													parameters: [
														{
															nodeType: "Parameter",
															externalName: {
																nodeType: "Identifier",
																content: "name",
																position: {
																	start: {
																		line: 7,
																		column: 23,
																	},
																	end: {
																		line: 7,
																		column: 27,
																	},
																},
															},
															internalName: {
																nodeType: "Identifier",
																content: "parameter",
																position: {
																	start: {
																		line: 7,
																		column: 28,
																	},
																	end: {
																		line: 7,
																		column: 37,
																	},
																},
															},
															type: {
																nodeType: "IdentifierTypeDeclaration",
																type: {
																	nodeType: "Identifier",
																	content: "Type",
																	position: {
																		start: {
																			line: 7,
																			column: 39,
																		},
																		end: {
																			line: 7,
																			column: 43,
																		},
																	},
																},
																position: {
																	start: {
																		line: 7,
																		column: 39,
																	},
																	end: {
																		line: 7,
																		column: 43,
																	},
																},
															},
															position: {
																start: {
																	line: 7,
																	column: 23,
																},
																end: {
																	line: 7,
																	column: 43,
																},
															},
														},
													],
													returnType: {
														nodeType: "IdentifierTypeDeclaration",
														type: {
															nodeType: "Identifier",
															content: "Type",
															position: {
																start: {
																	line: 7,
																	column: 48,
																},
																end: {
																	line: 7,
																	column: 52,
																},
															},
														},
														position: {
															start: {
																line: 7,
																column: 48,
															},
															end: {
																line: 7,
																column: 52,
															},
														},
													},
													body: [
														{
															nodeType: "ReturnStatement",
															expression: {
																nodeType: "Identifier",
																content: "parameter",
																position: {
																	start: {
																		line: 8,
																		column: 11,
																	},
																	end: {
																		line: 8,
																		column: 20,
																	},
																},
															},
															position: {
																start: {
																	line: 8,
																	column: 8,
																},
																end: {
																	line: 8,
																	column: 20,
																},
															},
														},
													],
												},
												position: {
													start: {
														line: 7,
														column: 22,
													},
													end: {
														line: 9,
														column: 8,
													},
												},
											}
										],
										isStatic: false,
										isOverloaded: true,
									},
								},
								position: {
									start: {
										line: 2,
										column: 6,
									},
									end: {
										line: 10,
										column: 7,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 11, column: 6 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 11, column: 6 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse TypeDefinitionStatements with twice overloaded Methods", () => {
				let input = `implementation {
					type Type {
						overload method(parameter: Type) -> Type {
							<- parameter
						}

						overload method(name parameter: Type) -> Type {
							<- parameter
						}

						overload method(item parameter: Type) -> Type {
							<- parameter
						}
					}
				}`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "TypeDefinitionStatement",
								name: {
									nodeType: "Identifier",
									content: "Type",
									position: {
										start: {
											line: 2,
											column: 11,
										},
										end: {
											line: 2,
											column: 15,
										},
									},
								},
								properties: {},
								methods: {
									method: {
										methods: [
											{
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
																	start: {
																		line: 3,
																		column: 23,
																	},
																	end: {
																		line: 3,
																		column: 32,
																	},
																},
															},
															internalName: {
																nodeType: "Identifier",
																content: "parameter",
																position: {
																	start: {
																		line: 3,
																		column: 23,
																	},
																	end: {
																		line: 3,
																		column: 32,
																	},
																},
															},
															type: {
																nodeType: "IdentifierTypeDeclaration",
																type: {
																	nodeType: "Identifier",
																	content: "Type",
																	position: {
																		start: {
																			line: 3,
																			column: 34,
																		},
																		end: {
																			line: 3,
																			column: 38,
																		},
																	},
																},
																position: {
																	start: {
																		line: 3,
																		column: 34,
																	},
																	end: {
																		line: 3,
																		column: 38,
																	},
																},
															},
															position: {
																start: {
																	line: 3,
																	column: 23,
																},
																end: {
																	line: 3,
																	column: 38,
																},
															},
														},
													],
													returnType: {
														nodeType: "IdentifierTypeDeclaration",
														type: {
															nodeType: "Identifier",
															content: "Type",
															position: {
																start: {
																	line: 3,
																	column: 43,
																},
																end: {
																	line: 3,
																	column: 47,
																},
															},
														},
														position: {
															start: {
																line: 3,
																column: 43,
															},
															end: {
																line: 3,
																column: 47,
															},
														},
													},
													body: [
														{
															nodeType: "ReturnStatement",
															expression: {
																nodeType: "Identifier",
																content: "parameter",
																position: {
																	start: {
																		line: 4,
																		column: 11,
																	},
																	end: {
																		line: 4,
																		column: 20,
																	},
																},
															},
															position: {
																start: {
																	line: 4,
																	column: 8,
																},
																end: {
																	line: 4,
																	column: 20,
																},
															},
														},
													],
												},
												position: {
													start: {
														line: 3,
														column: 22,
													},
													end: {
														line: 5,
														column: 8,
													},
												},
											}, {
												nodeType: "FunctionValue",
												value: {
													nodeType: "FunctionDefinition",
													parameters: [
														{
															nodeType: "Parameter",
															externalName: {
																nodeType: "Identifier",
																content: "name",
																position: {
																	start: {
																		line: 7,
																		column: 23,
																	},
																	end: {
																		line: 7,
																		column: 27,
																	},
																},
															},
															internalName: {
																nodeType: "Identifier",
																content: "parameter",
																position: {
																	start: {
																		line: 7,
																		column: 28,
																	},
																	end: {
																		line: 7,
																		column: 37,
																	},
																},
															},
															type: {
																nodeType: "IdentifierTypeDeclaration",
																type: {
																	nodeType: "Identifier",
																	content: "Type",
																	position: {
																		start: {
																			line: 7,
																			column: 39,
																		},
																		end: {
																			line: 7,
																			column: 43,
																		},
																	},
																},
																position: {
																	start: {
																		line: 7,
																		column: 39,
																	},
																	end: {
																		line: 7,
																		column: 43,
																	},
																},
															},
															position: {
																start: {
																	line: 7,
																	column: 23,
																},
																end: {
																	line: 7,
																	column: 43,
																},
															},
														},
													],
													returnType: {
														nodeType: "IdentifierTypeDeclaration",
														type: {
															nodeType: "Identifier",
															content: "Type",
															position: {
																start: {
																	line: 7,
																	column: 48,
																},
																end: {
																	line: 7,
																	column: 52,
																},
															},
														},
														position: {
															start: {
																line: 7,
																column: 48,
															},
															end: {
																line: 7,
																column: 52,
															},
														},
													},
													body: [
														{
															nodeType: "ReturnStatement",
															expression: {
																nodeType: "Identifier",
																content: "parameter",
																position: {
																	start: {
																		line: 8,
																		column: 11,
																	},
																	end: {
																		line: 8,
																		column: 20,
																	},
																},
															},
															position: {
																start: {
																	line: 8,
																	column: 8,
																},
																end: {
																	line: 8,
																	column: 20,
																},
															},
														},
													],
												},
												position: {
													start: {
														line: 7,
														column: 22,
													},
													end: {
														line: 9,
														column: 8,
													},
												},
											}, {
												nodeType: "FunctionValue",
												value: {
													nodeType: "FunctionDefinition",
													parameters: [
														{
															nodeType: "Parameter",
															externalName: {
																nodeType: "Identifier",
																content: "item",
																position: {
																	start: {
																		line: 11,
																		column: 23,
																	},
																	end: {
																		line: 11,
																		column: 27,
																	},
																},
															},
															internalName: {
																nodeType: "Identifier",
																content: "parameter",
																position: {
																	start: {
																		line: 11,
																		column: 28,
																	},
																	end: {
																		line: 11,
																		column: 37,
																	},
																},
															},
															type: {
																nodeType: "IdentifierTypeDeclaration",
																type: {
																	nodeType: "Identifier",
																	content: "Type",
																	position: {
																		start: {
																			line: 11,
																			column: 39,
																		},
																		end: {
																			line: 11,
																			column: 43,
																		},
																	},
																},
																position: {
																	start: {
																		line: 11,
																		column: 39,
																	},
																	end: {
																		line: 11,
																		column: 43,
																	},
																},
															},
															position: {
																start: {
																	line: 11,
																	column: 23,
																},
																end: {
																	line: 11,
																	column: 43,
																},
															},
														},
													],
													returnType: {
														nodeType: "IdentifierTypeDeclaration",
														type: {
															nodeType: "Identifier",
															content: "Type",
															position: {
																start: {
																	line: 11,
																	column: 48,
																},
																end: {
																	line: 11,
																	column: 52,
																},
															},
														},
														position: {
															start: {
																line: 11,
																column: 48,
															},
															end: {
																line: 11,
																column: 52,
															},
														},
													},
													body: [
														{
															nodeType: "ReturnStatement",
															expression: {
																nodeType: "Identifier",
																content: "parameter",
																position: {
																	start: {
																		line: 12,
																		column: 11,
																	},
																	end: {
																		line: 12,
																		column: 20,
																	},
																},
															},
															position: {
																start: {
																	line: 12,
																	column: 8,
																},
																end: {
																	line: 12,
																	column: 20,
																},
															},
														},
													],
												},
												position: {
													start: {
														line: 11,
														column: 22,
													},
													end: {
														line: 13,
														column: 8,
													},
												},
											}
										],
										isStatic: false,
										isOverloaded: true,
									},
								},
								position: {
									start: {
										line: 2,
										column: 6,
									},
									end: {
										line: 14,
										column: 7,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 15, column: 6 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 15, column: 6 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse TypeDefinitionStatements with Methods and Properties", () => {
				let input = `implementation {
					type Type {
						property: PropertyType
						method(parameter: Type) -> Type {
							<- parameter
						}
					}
				}`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "TypeDefinitionStatement",
								name: {
									nodeType: "Identifier",
									content: "Type",
									position: {
										start: {
											line: 2,
											column: 11,
										},
										end: {
											line: 2,
											column: 15,
										},
									},
								},
								properties: {
									property: {
										nodeType: "IdentifierTypeDeclaration",
										type: {
											nodeType: "Identifier",
											content: "PropertyType",
											position: {
												start: {
													line: 3,
													column: 17,
												},
												end: {
													line: 3,
													column: 29,
												},
											},
										},
										position: {
											start: {
												line: 3,
												column: 17,
											},
											end: {
												line: 3,
												column: 29,
											},
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
																start: {
																	line: 4,
																	column: 14,
																},
																end: {
																	line: 4,
																	column: 23,
																},
															},
														},
														internalName: {
															nodeType: "Identifier",
															content: "parameter",
															position: {
																start: {
																	line: 4,
																	column: 14,
																},
																end: {
																	line: 4,
																	column: 23,
																},
															},
														},
														type: {
															nodeType: "IdentifierTypeDeclaration",
															type: {
																nodeType: "Identifier",
																content: "Type",
																position: {
																	start: {
																		line: 4,
																		column: 25,
																	},
																	end: {
																		line: 4,
																		column: 29,
																	},
																},
															},
															position: {
																start: {
																	line: 4,
																	column: 25,
																},
																end: {
																	line: 4,
																	column: 29,
																},
															},
														},
														position: {
															start: {
																line: 4,
																column: 14,
															},
															end: {
																line: 4,
																column: 29,
															},
														},
													},
												],
												returnType: {
													nodeType: "IdentifierTypeDeclaration",
													type: {
														nodeType: "Identifier",
														content: "Type",
														position: {
															start: {
																line: 4,
																column: 34,
															},
															end: {
																line: 4,
																column: 38,
															},
														},
													},
													position: {
														start: {
															line: 4,
															column: 34,
														},
														end: {
															line: 4,
															column: 38,
														},
													},
												},
												body: [
													{
														nodeType: "ReturnStatement",
														expression: {
															nodeType: "Identifier",
															content: "parameter",
															position: {
																start: {
																	line: 5,
																	column: 11,
																},
																end: {
																	line: 5,
																	column: 20,
																},
															},
														},
														position: {
															start: {
																line: 5,
																column: 8,
															},
															end: {
																line: 5,
																column: 20,
															},
														},
													},
												],
											},
											position: {
												start: {
													line: 4,
													column: 13,
												},
												end: {
													line: 6,
													column: 8,
												},
											},
										},
										isStatic: false,
										isOverloaded: false,
									},
								},
								position: {
									start: {
										line: 2,
										column: 6,
									},
									end: {
										line: 7,
										column: 7,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 8, column: 6 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 8, column: 6 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})
		})

		describe("FunctionStatements", () => {
			it("should parse FunctionStatements with no parameters", () => {
				let input = `implementation { function name () -> Type {} }`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "FunctionStatement",
								name: {
									nodeType: "Identifier",
									content: "name",
									position: {
										start: {
											line: 1,
											column: 27,
										},
										end: {
											line: 1,
											column: 31,
										},
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
												start: {
													line: 1,
													column: 38,
												},
												end: {
													line: 1,
													column: 42,
												},
											},
										},
										position: {
											start: {
												line: 1,
												column: 38,
											},
											end: {
												line: 1,
												column: 42,
											},
										},
									},
									body: [],
								},
								position: {
									start: {
										line: 1,
										column: 18,
									},
									end: {
										line: 1,
										column: 45,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 1, column: 47 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 1, column: 47 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse FunctionLiterals with one parameter with explicit external name", () => {
				let input = `implementation {
					function name (external internal: Type) -> Type {
						<- internal
					}
				}`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "FunctionStatement",
								name: {
									nodeType: "Identifier",
									content: "name",
									position: {
										start: {
											line: 2,
											column: 15,
										},
										end: {
											line: 2,
											column: 19,
										},
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
													start: {
														line: 2,
														column: 21,
													},
													end: {
														line: 2,
														column: 29,
													},
												},
											},
											internalName: {
												nodeType: "Identifier",
												content: "internal",
												position: {
													start: {
														line: 2,
														column: 30,
													},
													end: {
														line: 2,
														column: 38,
													},
												},
											},
											type: {
												nodeType: "IdentifierTypeDeclaration",
												type: {
													nodeType: "Identifier",
													content: "Type",
													position: {
														start: {
															line: 2,
															column: 40,
														},
														end: {
															line: 2,
															column: 44,
														},
													},
												},
												position: {
													start: {
														line: 2,
														column: 40,
													},
													end: {
														line: 2,
														column: 44,
													},
												},
											},
											position: {
												start: {
													line: 2,
													column: 21,
												},
												end: {
													line: 2,
													column: 44,
												},
											},
										},
									],
									returnType: {
										nodeType: "IdentifierTypeDeclaration",
										type: {
											nodeType: "Identifier",
											content: "Type",
											position: {
												start: {
													line: 2,
													column: 49,
												},
												end: {
													line: 2,
													column: 53,
												},
											},
										},
										position: {
											start: {
												line: 2,
												column: 49,
											},
											end: {
												line: 2,
												column: 53,
											},
										},
									},
									body: [
										{
											nodeType: "ReturnStatement",
											expression: {
												nodeType: "Identifier",
												content: "internal",
												position: {
													start: {
														line: 3,
														column: 10,
													},
													end: {
														line: 3,
														column: 18,
													},
												},
											},
											position: {
												start: {
													line: 3,
													column: 7,
												},
												end: {
													line: 3,
													column: 18,
												},
											},
										},
									],
								},
								position: {
									start: {
										line: 2,
										column: 6,
									},
									end: {
										line: 4,
										column: 7,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 5, column: 6 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 5, column: 6 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse FunctionLiterals with one parameter with implicit external name", () => {
				let input = `implementation {
					function name (internal: Type) -> Type {
						<- internal
					}
				}`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "FunctionStatement",
								name: {
									nodeType: "Identifier",
									content: "name",
									position: {
										start: {
											line: 2,
											column: 15,
										},
										end: {
											line: 2,
											column: 19,
										},
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
													start: {
														line: 2,
														column: 21,
													},
													end: {
														line: 2,
														column: 29,
													},
												},
											},
											internalName: {
												nodeType: "Identifier",
												content: "internal",
												position: {
													start: {
														line: 2,
														column: 21,
													},
													end: {
														line: 2,
														column: 29,
													},
												},
											},
											type: {
												nodeType: "IdentifierTypeDeclaration",
												type: {
													nodeType: "Identifier",
													content: "Type",
													position: {
														start: {
															line: 2,
															column: 31,
														},
														end: {
															line: 2,
															column: 35,
														},
													},
												},
												position: {
													start: {
														line: 2,
														column: 31,
													},
													end: {
														line: 2,
														column: 35,
													},
												},
											},
											position: {
												start: {
													line: 2,
													column: 21,
												},
												end: {
													line: 2,
													column: 35,
												},
											},
										},
									],
									returnType: {
										nodeType: "IdentifierTypeDeclaration",
										type: {
											nodeType: "Identifier",
											content: "Type",
											position: {
												start: {
													line: 2,
													column: 40,
												},
												end: {
													line: 2,
													column: 44,
												},
											},
										},
										position: {
											start: {
												line: 2,
												column: 40,
											},
											end: {
												line: 2,
												column: 44,
											},
										},
									},
									body: [
										{
											nodeType: "ReturnStatement",
											expression: {
												nodeType: "Identifier",
												content: "internal",
												position: {
													start: {
														line: 3,
														column: 10,
													},
													end: {
														line: 3,
														column: 18,
													},
												},
											},
											position: {
												start: {
													line: 3,
													column: 7,
												},
												end: {
													line: 3,
													column: 18,
												},
											},
										},
									],
								},
								position: {
									start: {
										line: 2,
										column: 6,
									},
									end: {
										line: 4,
										column: 7,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 5, column: 6 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 5, column: 6 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse FunctionLiterals with one parameter without external name", () => {
				let input = `implementation {
					function name (_ internal: Type) -> Type {
						<- internal
					}
				}`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "FunctionStatement",
								name: {
									nodeType: "Identifier",
									content: "name",
									position: {
										start: {
											line: 2,
											column: 15,
										},
										end: {
											line: 2,
											column: 19,
										},
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
													start: {
														line: 2,
														column: 23,
													},
													end: {
														line: 2,
														column: 31,
													},
												},
											},
											type: {
												nodeType: "IdentifierTypeDeclaration",
												type: {
													nodeType: "Identifier",
													content: "Type",
													position: {
														start: {
															line: 2,
															column: 33,
														},
														end: {
															line: 2,
															column: 37,
														},
													},
												},
												position: {
													start: {
														line: 2,
														column: 33,
													},
													end: {
														line: 2,
														column: 37,
													},
												},
											},
											position: {
												start: {
													line: 2,
													column: 21,
												},
												end: {
													line: 2,
													column: 37,
												},
											},
										},
									],
									returnType: {
										nodeType: "IdentifierTypeDeclaration",
										type: {
											nodeType: "Identifier",
											content: "Type",
											position: {
												start: {
													line: 2,
													column: 42,
												},
												end: {
													line: 2,
													column: 46,
												},
											},
										},
										position: {
											start: {
												line: 2,
												column: 42,
											},
											end: {
												line: 2,
												column: 46,
											},
										},
									},
									body: [
										{
											nodeType: "ReturnStatement",
											expression: {
												nodeType: "Identifier",
												content: "internal",
												position: {
													start: {
														line: 3,
														column: 10,
													},
													end: {
														line: 3,
														column: 18,
													},
												},
											},
											position: {
												start: {
													line: 3,
													column: 7,
												},
												end: {
													line: 3,
													column: 18,
												},
											},
										},
									],
								},
								position: {
									start: {
										line: 2,
										column: 6,
									},
									end: {
										line: 4,
										column: 7,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 5, column: 6 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 5, column: 6 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})

			it("should parse FunctionLiterals with two parameters", () => {
				let input = `implementation {
					function name (external internal: Type, external2 internal2: Type) -> Type {
						<- internal
					}
				}`
				let output = {
					nodeType: "Program",
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "FunctionStatement",
								name: {
									nodeType: "Identifier",
									content: "name",
									position: {
										start: {
											line: 2,
											column: 15,
										},
										end: {
											line: 2,
											column: 19,
										},
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
													start: {
														line: 2,
														column: 21,
													},
													end: {
														line: 2,
														column: 29,
													},
												},
											},
											internalName: {
												nodeType: "Identifier",
												content: "internal",
												position: {
													start: {
														line: 2,
														column: 30,
													},
													end: {
														line: 2,
														column: 38,
													},
												},
											},
											type: {
												nodeType: "IdentifierTypeDeclaration",
												type: {
													nodeType: "Identifier",
													content: "Type",
													position: {
														start: {
															line: 2,
															column: 40,
														},
														end: {
															line: 2,
															column: 44,
														},
													},
												},
												position: {
													start: {
														line: 2,
														column: 40,
													},
													end: {
														line: 2,
														column: 44,
													},
												},
											},
											position: {
												start: {
													line: 2,
													column: 21,
												},
												end: {
													line: 2,
													column: 44,
												},
											},
										},
										{
											nodeType: "Parameter",
											internalName: {
												nodeType: "Identifier",
												content: "internal2",
												position: {
													start: {
														line: 2,
														column: 56,
													},
													end: {
														line: 2,
														column: 65,
													},
												},
											},
											externalName: {
												nodeType: "Identifier",
												content: "external2",
												position: {
													start: {
														line: 2,
														column: 46,
													},
													end: {
														line: 2,
														column: 55,
													},
												},
											},
											type: {
												nodeType: "IdentifierTypeDeclaration",
												type: {
													nodeType: "Identifier",
													content: "Type",
													position: {
														start: {
															line: 2,
															column: 67,
														},
														end: {
															line: 2,
															column: 71,
														},
													},
												},
												position: {
													start: {
														line: 2,
														column: 67,
													},
													end: {
														line: 2,
														column: 71,
													},
												},
											},
											position: {
												start: {
													line: 2,
													column: 46,
												},
												end: {
													line: 2,
													column: 71,
												},
											},
										},
									],
									returnType: {
										nodeType: "IdentifierTypeDeclaration",
										type: {
											nodeType: "Identifier",
											content: "Type",
											position: {
												start: {
													line: 2,
													column: 76,
												},
												end: {
													line: 2,
													column: 80,
												},
											},
										},
										position: {
											start: {
												line: 2,
												column: 76,
											},
											end: {
												line: 2,
												column: 80,
											},
										},
									},
									body: [
										{
											nodeType: "ReturnStatement",
											expression: {
												nodeType: "Identifier",
												content: "internal",
												position: {
													start: {
														line: 3,
														column: 10,
													},
													end: {
														line: 3,
														column: 18,
													},
												},
											},
											position: {
												start: {
													line: 3,
													column: 7,
												},
												end: {
													line: 3,
													column: 18,
												},
											},
										},
									],
								},
								position: {
									start: {
										line: 2,
										column: 6,
									},
									end: {
										line: 4,
										column: 7,
									},
								},
							},
						],
						position: {
							start: { line: 1, column: 1 },
							end: { line: 5, column: 6 },
						},
					},
					position: {
						start: { line: 1, column: 1 },
						end: { line: 5, column: 6 },
					},
				}

				expect<ParserNode>(parse(input)).toEqual(output)
			})
		})
	})
})
