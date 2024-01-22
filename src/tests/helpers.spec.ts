import { describe, expect, it } from "bun:test"

import {
	first,
	flatten,
	matchesType,
	resolveOverloadedMethodName,
	second,
	stripPosition,
	stripPositionFromArray,
	symbol,
	third,
} from "../helpers"

import { lexer } from "../interfaces"

import {
	FunctionType,
	ListType,
	OverloadedMethodType,
	OverloadedStaticMethodType,
	PrimitiveType,
	SimpleMethodType,
	StaticMethodType,
	Type,
	UnionType,
	UnknownType,
} from "../interfaces/common"

const TokenType = lexer.TokenType
type Token = lexer.Token
type SimpleToken = lexer.SimpleToken

describe("Helpers", () => {
	describe("first", () => {
		it("should return the first item of an array", () => {
			expect(first([0, 1, 2, 3])).toEqual(0)
		})
	})

	describe("second", () => {
		it("should return the second item of an array", () => {
			expect(second([0, 1, 2, 3])).toEqual(1)
		})
	})

	describe("third", () => {
		it("should return the third item of an array", () => {
			expect(third([0, 1, 2, 3])).toEqual(2)
		})
	})

	describe("symbol", () => {
		it("should return a position object", () => {
			expect(
				symbol([
					{
						position: {
							start: { line: 0, column: 0 },
							end: { line: 0, column: 0 },
						},
					},
				]),
			).toEqual({
				position: {
					start: { line: 0, column: 0 },
					end: { line: 0, column: 0 },
				},
			})
		})
	})

	describe("flatten", () => {
		it("should flatten array of arrays", () => {
			expect(
				flatten([
					[0, 1],
					[2, 3],
				]),
			).toEqual([0, 1, 2, 3])
		})

		it("should flatten mixed array of arrays and items", () => {
			expect(flatten([[0, 1], 2, [3, 4], 5])).toEqual([0, 1, 2, 3, 4, 5])
		})
	})

	describe("stripPosition", () => {
		it("should strip position", () => {
			let input: Token = {
				value: "",
				type: TokenType.LiteralString,
				position: {
					start: { line: 0, column: 0 },
					end: { line: 0, column: 0 },
				},
			}

			let output: SimpleToken = {
				value: "",
				type: TokenType.LiteralString,
			}

			expect(stripPosition(input)).toEqual(output)
		})
	})

	describe("stripPositionFromArray", () => {
		it("should strip position from all values", () => {
			let input: Array<Token> = [
				{
					value: "",
					type: TokenType.LiteralString,
					position: {
						start: { line: 0, column: 0 },
						end: { line: 0, column: 0 },
					},
				},
			]

			let output: Array<SimpleToken> = [
				{
					value: "",
					type: TokenType.LiteralString,
				},
			]

			expect(stripPositionFromArray(input)).toEqual(output)
		})
	})

	describe("stripPositionFromArray", () => {
		it("should strip position from all values", () => {
			let input: Array<Token> = [
				{
					value: "",
					type: TokenType.LiteralString,
					position: {
						start: { line: 0, column: 0 },
						end: { line: 0, column: 0 },
					},
				},
			]

			let output: Array<SimpleToken> = [
				{
					value: "",
					type: TokenType.LiteralString,
				},
			]

			expect(stripPositionFromArray(input)).toEqual(output)
		})
	})

	describe("stripPositionFromArray", () => {
		it("should strip position from all values", () => {
			const name = "Test"
			const index = 1

			let input = resolveOverloadedMethodName(name, index)
			let output = `${name}__overload$${index + 1}`

			expect(input).toEqual(output)
		})
	})

	describe("matchesType", () => {
		// #region Types

		const unknown: UnknownType = { type: "Unknown" }

		const booleanPrimitive: PrimitiveType = {
			type: "Primitive",
			primitive: "Boolean",
		}
		const integerPrimitive: PrimitiveType = {
			type: "Primitive",
			primitive: "Integer",
		}
		const fractionPrimitive: PrimitiveType = {
			type: "Primitive",
			primitive: "Fraction",
		}
		const stringPrimitive: PrimitiveType = {
			type: "Primitive",
			primitive: "String",
		}

		const builtInType: Type = {
			type: "Type",
			name: "TestType",
			definition: { type: "BuiltIn" },
			methods: {},
		}

		const unresolvedIntegerType: Type = {
			type: "Type",
			name: "Integer",
			definition: { type: "Primitive", primitive: "Integer" },
			methods: {},
		}

		const recordType: Type = {
			type: "Type",
			name: "TestType",
			definition: {
				type: "Record",
				members: { test: { type: "Primitive", primitive: "String" } },
			},
			methods: {},
		}

		const alternativeRecordType: Type = {
			type: "Type",
			name: "TestType",
			definition: {
				type: "Record",
				members: { test: { type: "Primitive", primitive: "Integer" } },
			},
			methods: {},
		}

		const biggerRecordType: Type = {
			type: "Type",
			name: "TestType",
			definition: {
				type: "Record",
				members: {
					test: { type: "Primitive", primitive: "String" },
					test2: { type: "Primitive", primitive: "String" },
				},
			},
			methods: {},
		}

		const unknownList: ListType = {
			type: "List",
			itemType: { type: "Unknown" },
		}

		const stringList: ListType = {
			type: "List",
			itemType: { type: "Primitive", primitive: "String" },
		}

		const integerList: ListType = {
			type: "List",
			itemType: { type: "Primitive", primitive: "Integer" },
		}

		// #region Unions

		const unionTypeStringInteger: UnionType = {
			type: "UnionType",
			types: [stringPrimitive, integerPrimitive],
		}

		const unionTypeIntegerString: UnionType = {
			type: "UnionType",
			types: [integerPrimitive, stringPrimitive],
		}

		const unionTypeIntegerFraction: UnionType = {
			type: "UnionType",
			types: [integerPrimitive, fractionPrimitive],
		}

		// #endregion

		// #region Functions

		const noArgumentFunctionType: FunctionType = {
			type: "Function",
			parameterTypes: [],
			returnType: { type: "Primitive", primitive: "String" },
		}

		const noArgumentWithDifferentReturnTypeFunctionType: FunctionType = {
			type: "Function",
			parameterTypes: [],
			returnType: { type: "Primitive", primitive: "Integer" },
		}

		const singleArgumentFunctionType: FunctionType = {
			type: "Function",
			parameterTypes: [
				{
					name: null,
					type: { type: "Primitive", primitive: "String" },
				},
			],
			returnType: { type: "Primitive", primitive: "String" },
		}

		const singleArgumentWithNameFunctionType: FunctionType = {
			type: "Function",
			parameterTypes: [
				{
					name: "test",
					type: { type: "Primitive", primitive: "String" },
				},
			],
			returnType: { type: "Primitive", primitive: "String" },
		}

		// #endregion

		// #region Simple Methods

		const noArgumentSimpleMethodType: SimpleMethodType = {
			type: "SimpleMethod",
			parameterTypes: [],
			returnType: { type: "Primitive", primitive: "String" },
		}

		const noArgumentWithDifferentReturnTypeSimpleMethodType: SimpleMethodType =
			{
				type: "SimpleMethod",
				parameterTypes: [],
				returnType: { type: "Primitive", primitive: "Integer" },
			}

		const singleArgumentSimpleMethodType: SimpleMethodType = {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "Primitive", primitive: "String" },
				},
			],
			returnType: { type: "Primitive", primitive: "String" },
		}

		const singleArgumentWithNameSimpleMethodType: SimpleMethodType = {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: "test",
					type: { type: "Primitive", primitive: "String" },
				},
			],
			returnType: { type: "Primitive", primitive: "String" },
		}

		// #endregion

		// #region Static Methods

		const noArgumentStaticMethodType: StaticMethodType = {
			type: "StaticMethod",
			parameterTypes: [],
			returnType: { type: "Primitive", primitive: "String" },
		}

		const noArgumentWithDifferentReturnTypeStaticMethodType: StaticMethodType =
			{
				type: "StaticMethod",
				parameterTypes: [],
				returnType: { type: "Primitive", primitive: "Integer" },
			}

		const singleArgumentStaticMethodType: StaticMethodType = {
			type: "StaticMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "Primitive", primitive: "String" },
				},
			],
			returnType: { type: "Primitive", primitive: "String" },
		}

		const singleArgumentWithNameStaticMethodType: StaticMethodType = {
			type: "StaticMethod",
			parameterTypes: [
				{
					name: "test",
					type: { type: "Primitive", primitive: "String" },
				},
			],
			returnType: { type: "Primitive", primitive: "String" },
		}

		// #endregion

		// #region Overloaded Methods

		const noArgumentOverloadedMethodType: OverloadedMethodType = {
			type: "OverloadedMethod",
			overloads: [
				{
					parameterTypes: [],
					returnType: { type: "Primitive", primitive: "String" },
				},
			],
		}

		const noArgumentWithDifferentReturnTypeOverloadedMethodType: OverloadedMethodType =
			{
				type: "OverloadedMethod",
				overloads: [
					{
						parameterTypes: [],
						returnType: { type: "Primitive", primitive: "Integer" },
					},
				],
			}

		const singleArgumentOverloadedMethodType: OverloadedMethodType = {
			type: "OverloadedMethod",
			overloads: [
				{
					parameterTypes: [
						{
							name: null,
							type: { type: "Primitive", primitive: "String" },
						},
					],
					returnType: { type: "Primitive", primitive: "String" },
				},
			],
		}

		const singleArgumentWithNameOverloadedMethodType: OverloadedMethodType =
			{
				type: "OverloadedMethod",
				overloads: [
					{
						parameterTypes: [
							{
								name: "test",
								type: {
									type: "Primitive",
									primitive: "String",
								},
							},
						],
						returnType: { type: "Primitive", primitive: "String" },
					},
					{
						parameterTypes: [
							{
								name: "test2",
								type: {
									type: "Primitive",
									primitive: "String",
								},
							},
						],
						returnType: { type: "Primitive", primitive: "String" },
					},
				],
			}

		const alternativeSingleArgumentWithNameOverloadedMethodType: OverloadedMethodType =
			{
				type: "OverloadedMethod",
				overloads: [
					{
						parameterTypes: [
							{
								name: "test2",
								type: {
									type: "Primitive",
									primitive: "String",
								},
							},
						],
						returnType: { type: "Primitive", primitive: "String" },
					},
					{
						parameterTypes: [
							{
								name: "test3",
								type: {
									type: "Primitive",
									primitive: "String",
								},
							},
						],
						returnType: { type: "Primitive", primitive: "String" },
					},
				],
			}

		// #endregion

		// #region Overloaded Static Methods

		const noArgumentOverloadedStaticMethodType: OverloadedStaticMethodType =
			{
				type: "OverloadedStaticMethod",
				overloads: [
					{
						parameterTypes: [],
						returnType: { type: "Primitive", primitive: "String" },
					},
				],
			}

		const noArgumentWithDifferentReturnTypeOverloadedStaticMethodType: OverloadedStaticMethodType =
			{
				type: "OverloadedStaticMethod",
				overloads: [
					{
						parameterTypes: [],
						returnType: { type: "Primitive", primitive: "Integer" },
					},
				],
			}

		const singleArgumentOverloadedStaticMethodType: OverloadedStaticMethodType =
			{
				type: "OverloadedStaticMethod",
				overloads: [
					{
						parameterTypes: [
							{
								name: null,
								type: {
									type: "Primitive",
									primitive: "String",
								},
							},
						],
						returnType: { type: "Primitive", primitive: "String" },
					},
				],
			}

		const singleArgumentWithNameOverloadedStaticMethodType: OverloadedStaticMethodType =
			{
				type: "OverloadedStaticMethod",
				overloads: [
					{
						parameterTypes: [
							{
								name: "test",
								type: {
									type: "Primitive",
									primitive: "String",
								},
							},
						],
						returnType: { type: "Primitive", primitive: "String" },
					},
					{
						parameterTypes: [
							{
								name: "test2",
								type: {
									type: "Primitive",
									primitive: "String",
								},
							},
						],
						returnType: { type: "Primitive", primitive: "String" },
					},
				],
			}

		const alternativeSingleArgumentWithNameOverloadedStaticMethodType: OverloadedStaticMethodType =
			{
				type: "OverloadedStaticMethod",
				overloads: [
					{
						parameterTypes: [
							{
								name: "test2",
								type: {
									type: "Primitive",
									primitive: "String",
								},
							},
						],
						returnType: { type: "Primitive", primitive: "String" },
					},
					{
						parameterTypes: [
							{
								name: "test3",
								type: {
									type: "Primitive",
									primitive: "String",
								},
							},
						],
						returnType: { type: "Primitive", primitive: "String" },
					},
				],
			}

		// #endregion

		// #endregion

		it("should match anything to UnknownType", () => {
			expect(matchesType(unknown, booleanPrimitive)).toBe(true)
			expect(matchesType(unknown, integerPrimitive)).toBe(true)
			expect(matchesType(unknown, fractionPrimitive)).toBe(true)
			expect(matchesType(unknown, stringPrimitive)).toBe(true)

			expect(matchesType(unknown, unionTypeStringInteger)).toBe(true)

			expect(matchesType(unknown, builtInType)).toBe(true)

			expect(matchesType(unknown, recordType)).toBe(true)
			expect(matchesType(unknown, alternativeRecordType)).toBe(true)
			expect(matchesType(unknown, biggerRecordType)).toBe(true)

			expect(matchesType(unknown, unknownList)).toBe(true)
			expect(matchesType(unknown, stringList)).toBe(true)
			expect(matchesType(unknown, integerList)).toBe(true)

			expect(matchesType(unknown, noArgumentFunctionType)).toBe(true)
			expect(matchesType(unknown, singleArgumentFunctionType)).toBe(true)
		})

		it("should match matching PrimitiveTypes", () => {
			expect(matchesType(booleanPrimitive, booleanPrimitive)).toBe(true)
			expect(matchesType(integerPrimitive, integerPrimitive)).toBe(true)
			expect(matchesType(fractionPrimitive, fractionPrimitive)).toBe(true)
			expect(matchesType(stringPrimitive, stringPrimitive)).toBe(true)
		})

		it("should match TypeTypes that match PrimitiveTypes", () => {
			expect(matchesType(unresolvedIntegerType, integerPrimitive)).toBe(
				true,
			)
			expect(matchesType(integerPrimitive, unresolvedIntegerType)).toBe(
				true,
			)
		})

		it("should not match mismatched PrimitiveTypes", () => {
			expect(matchesType(booleanPrimitive, stringPrimitive)).toBe(false)
			expect(matchesType(booleanPrimitive, integerPrimitive)).toBe(false)
			expect(matchesType(booleanPrimitive, fractionPrimitive)).toBe(false)

			expect(matchesType(stringPrimitive, booleanPrimitive)).toBe(false)
			expect(matchesType(stringPrimitive, integerPrimitive)).toBe(false)
			expect(matchesType(stringPrimitive, fractionPrimitive)).toBe(false)

			expect(matchesType(integerPrimitive, stringPrimitive)).toBe(false)
			expect(matchesType(integerPrimitive, booleanPrimitive)).toBe(false)
			expect(matchesType(integerPrimitive, fractionPrimitive)).toBe(false)

			expect(matchesType(fractionPrimitive, stringPrimitive)).toBe(false)
			expect(matchesType(fractionPrimitive, integerPrimitive)).toBe(false)
			expect(matchesType(fractionPrimitive, booleanPrimitive)).toBe(false)
		})

		it("should match UnionTypes", () => {
			expect(
				matchesType(unionTypeStringInteger, unionTypeStringInteger),
			).toBe(true)
			expect(
				matchesType(unionTypeStringInteger, unionTypeIntegerString),
			).toBe(true)
			expect(
				matchesType(unionTypeIntegerString, unionTypeStringInteger),
			).toBe(true)

			expect(matchesType(unionTypeStringInteger, stringPrimitive)).toBe(
				true,
			)
			expect(matchesType(unionTypeStringInteger, integerPrimitive)).toBe(
				true,
			)

			expect(matchesType(unionTypeIntegerString, stringPrimitive)).toBe(
				true,
			)
			expect(matchesType(unionTypeIntegerString, integerPrimitive)).toBe(
				true,
			)
		})

		it("should not match mismatched UnionTypes", () => {
			expect(
				matchesType(unionTypeStringInteger, unionTypeIntegerFraction),
			).toBe(false)
			expect(
				matchesType(unionTypeIntegerFraction, unionTypeStringInteger),
			).toBe(false)
			expect(matchesType(unionTypeStringInteger, fractionPrimitive)).toBe(
				false,
			)
			expect(matchesType(unionTypeStringInteger, builtInType)).toBe(false)
			expect(matchesType(unionTypeStringInteger, recordType)).toBe(false)
		})

		it("should match matching TypeTypes", () => {
			expect(matchesType(builtInType, builtInType)).toBe(true)
			expect(matchesType(recordType, recordType)).toBe(true)
		})

		it("should not match mismatched TypeTypes", () => {
			expect(matchesType(recordType, alternativeRecordType)).toBe(false)
			expect(matchesType(biggerRecordType, recordType)).toBe(false)
			expect(matchesType(builtInType, recordType)).toBe(false)
			expect(matchesType(recordType, builtInType)).toBe(false)
		})

		it("should match matching ListTypes", () => {
			expect(matchesType(unknownList, stringList)).toBe(true)
			expect(matchesType(unknownList, integerList)).toBe(true)
			expect(matchesType(stringList, unknownList)).toBe(true)
			expect(matchesType(integerList, unknownList)).toBe(true)

			expect(matchesType(stringList, stringList)).toBe(true)
			expect(matchesType(integerList, integerList)).toBe(true)
		})

		it("should not match mismatched ListTypes", () => {
			expect(matchesType(stringList, integerList)).toBe(false)
			expect(matchesType(integerList, stringList)).toBe(false)
		})

		it("should match matching FunctionTypes", () => {
			expect(
				matchesType(noArgumentFunctionType, noArgumentFunctionType),
			).toBe(true)
			expect(
				matchesType(
					singleArgumentFunctionType,
					singleArgumentFunctionType,
				),
			).toBe(true)
			expect(
				matchesType(
					singleArgumentWithNameFunctionType,
					singleArgumentWithNameFunctionType,
				),
			).toBe(true)
			expect(
				matchesType(
					noArgumentWithDifferentReturnTypeFunctionType,
					noArgumentWithDifferentReturnTypeFunctionType,
				),
			).toBe(true)
		})

		it("should not match mismatched FunctionTypes", () => {
			expect(
				matchesType(singleArgumentFunctionType, noArgumentFunctionType),
			).toBe(false)
			expect(
				matchesType(
					singleArgumentFunctionType,
					singleArgumentWithNameFunctionType,
				),
			).toBe(false)
			expect(
				matchesType(
					noArgumentFunctionType,
					noArgumentWithDifferentReturnTypeFunctionType,
				),
			).toBe(false)
			expect(
				matchesType(noArgumentFunctionType, singleArgumentFunctionType),
			).toBe(false)
			expect(
				matchesType(
					noArgumentFunctionType,
					singleArgumentWithNameFunctionType,
				),
			).toBe(false)
			expect(
				matchesType(
					noArgumentWithDifferentReturnTypeFunctionType,
					noArgumentFunctionType,
				),
			).toBe(false)
		})

		it("should match matching SimpleMethodTypes", () => {
			expect(
				matchesType(
					noArgumentSimpleMethodType,
					noArgumentSimpleMethodType,
				),
			).toBe(true)
			expect(
				matchesType(
					singleArgumentSimpleMethodType,
					singleArgumentSimpleMethodType,
				),
			).toBe(true)
			expect(
				matchesType(
					singleArgumentWithNameSimpleMethodType,
					singleArgumentWithNameSimpleMethodType,
				),
			).toBe(true)
			expect(
				matchesType(
					noArgumentWithDifferentReturnTypeSimpleMethodType,
					noArgumentWithDifferentReturnTypeSimpleMethodType,
				),
			).toBe(true)
		})

		it("should not match mismatched SimpleMethodTypes", () => {
			expect(
				matchesType(
					singleArgumentSimpleMethodType,
					noArgumentSimpleMethodType,
				),
			).toBe(false)
			expect(
				matchesType(
					singleArgumentSimpleMethodType,
					singleArgumentWithNameSimpleMethodType,
				),
			).toBe(false)
			expect(
				matchesType(
					noArgumentSimpleMethodType,
					noArgumentWithDifferentReturnTypeSimpleMethodType,
				),
			).toBe(false)
			expect(
				matchesType(
					noArgumentSimpleMethodType,
					singleArgumentSimpleMethodType,
				),
			).toBe(false)
			expect(
				matchesType(
					noArgumentSimpleMethodType,
					singleArgumentWithNameSimpleMethodType,
				),
			).toBe(false)
			expect(
				matchesType(
					noArgumentWithDifferentReturnTypeSimpleMethodType,
					noArgumentSimpleMethodType,
				),
			).toBe(false)
		})

		it("should match matching StaticMethodTypes", () => {
			expect(
				matchesType(
					noArgumentStaticMethodType,
					noArgumentStaticMethodType,
				),
			).toBe(true)
			expect(
				matchesType(
					singleArgumentStaticMethodType,
					singleArgumentStaticMethodType,
				),
			).toBe(true)
			expect(
				matchesType(
					singleArgumentWithNameStaticMethodType,
					singleArgumentWithNameStaticMethodType,
				),
			).toBe(true)
			expect(
				matchesType(
					noArgumentWithDifferentReturnTypeStaticMethodType,
					noArgumentWithDifferentReturnTypeStaticMethodType,
				),
			).toBe(true)
		})

		it("should not match mismatched StaticMethodTypes", () => {
			expect(
				matchesType(
					singleArgumentStaticMethodType,
					noArgumentStaticMethodType,
				),
			).toBe(false)
			expect(
				matchesType(
					singleArgumentStaticMethodType,
					singleArgumentWithNameStaticMethodType,
				),
			).toBe(false)
			expect(
				matchesType(
					noArgumentStaticMethodType,
					noArgumentWithDifferentReturnTypeStaticMethodType,
				),
			).toBe(false)
			expect(
				matchesType(
					noArgumentStaticMethodType,
					singleArgumentStaticMethodType,
				),
			).toBe(false)
			expect(
				matchesType(
					noArgumentStaticMethodType,
					singleArgumentWithNameStaticMethodType,
				),
			).toBe(false)
			expect(
				matchesType(
					noArgumentWithDifferentReturnTypeStaticMethodType,
					noArgumentStaticMethodType,
				),
			).toBe(false)
		})

		it("should match matching OverloadedMethodTypes", () => {
			expect(
				matchesType(
					noArgumentOverloadedMethodType,
					noArgumentOverloadedMethodType,
				),
			).toBe(true)
			expect(
				matchesType(
					singleArgumentOverloadedMethodType,
					singleArgumentOverloadedMethodType,
				),
			).toBe(true)
			expect(
				matchesType(
					singleArgumentWithNameOverloadedMethodType,
					singleArgumentWithNameOverloadedMethodType,
				),
			).toBe(true)
			expect(
				matchesType(
					noArgumentWithDifferentReturnTypeOverloadedMethodType,
					noArgumentWithDifferentReturnTypeOverloadedMethodType,
				),
			).toBe(true)
		})

		it("should not match mismatched OverloadedMethodTypes", () => {
			expect(
				matchesType(
					singleArgumentOverloadedMethodType,
					noArgumentOverloadedMethodType,
				),
			).toBe(false)
			expect(
				matchesType(
					singleArgumentOverloadedMethodType,
					singleArgumentWithNameOverloadedMethodType,
				),
			).toBe(false)
			expect(
				matchesType(
					noArgumentOverloadedMethodType,
					noArgumentWithDifferentReturnTypeOverloadedMethodType,
				),
			).toBe(false)
			expect(
				matchesType(
					noArgumentOverloadedMethodType,
					singleArgumentOverloadedMethodType,
				),
			).toBe(false)
			expect(
				matchesType(
					noArgumentOverloadedMethodType,
					singleArgumentWithNameOverloadedMethodType,
				),
			).toBe(false)
			expect(
				matchesType(
					noArgumentWithDifferentReturnTypeOverloadedMethodType,
					noArgumentOverloadedMethodType,
				),
			).toBe(false)
			expect(
				matchesType(
					singleArgumentWithNameOverloadedMethodType,
					alternativeSingleArgumentWithNameOverloadedMethodType,
				),
			).toBe(false)
		})

		it("should match matching OverloadedStaticMethodTypes", () => {
			expect(
				matchesType(
					noArgumentOverloadedStaticMethodType,
					noArgumentOverloadedStaticMethodType,
				),
			).toBe(true)
			expect(
				matchesType(
					singleArgumentOverloadedStaticMethodType,
					singleArgumentOverloadedStaticMethodType,
				),
			).toBe(true)
			expect(
				matchesType(
					singleArgumentWithNameOverloadedStaticMethodType,
					singleArgumentWithNameOverloadedStaticMethodType,
				),
			).toBe(true)
			expect(
				matchesType(
					noArgumentWithDifferentReturnTypeOverloadedStaticMethodType,
					noArgumentWithDifferentReturnTypeOverloadedStaticMethodType,
				),
			).toBe(true)
		})

		it("should not match mismatched OverloadedStaticMethodTypes", () => {
			expect(
				matchesType(
					singleArgumentOverloadedStaticMethodType,
					noArgumentOverloadedStaticMethodType,
				),
			).toBe(false)
			expect(
				matchesType(
					singleArgumentOverloadedStaticMethodType,
					singleArgumentWithNameOverloadedStaticMethodType,
				),
			).toBe(false)
			expect(
				matchesType(
					noArgumentOverloadedStaticMethodType,
					noArgumentWithDifferentReturnTypeOverloadedStaticMethodType,
				),
			).toBe(false)
			expect(
				matchesType(
					noArgumentOverloadedStaticMethodType,
					singleArgumentOverloadedStaticMethodType,
				),
			).toBe(false)
			expect(
				matchesType(
					noArgumentOverloadedStaticMethodType,
					singleArgumentWithNameOverloadedStaticMethodType,
				),
			).toBe(false)
			expect(
				matchesType(
					noArgumentWithDifferentReturnTypeOverloadedStaticMethodType,
					noArgumentOverloadedStaticMethodType,
				),
			).toBe(false)
			expect(
				matchesType(
					singleArgumentWithNameOverloadedStaticMethodType,
					alternativeSingleArgumentWithNameOverloadedStaticMethodType,
				),
			).toBe(false)
		})

		it("should not match mismatched Types", () => {
			expect(
				matchesType(recordType, noArgumentOverloadedStaticMethodType),
			).toBe(false)
			expect(
				matchesType(
					builtInType,
					singleArgumentWithNameOverloadedStaticMethodType,
				),
			).toBe(false)
			expect(matchesType(builtInType, fractionPrimitive)).toBe(false)
			expect(matchesType(fractionPrimitive, builtInType)).toBe(false)
			expect(
				matchesType(
					noArgumentOverloadedStaticMethodType,
					singleArgumentFunctionType,
				),
			).toBe(false)
			expect(
				matchesType(
					noArgumentOverloadedMethodType,
					singleArgumentOverloadedStaticMethodType,
				),
			).toBe(false)
			expect(
				matchesType(
					noArgumentOverloadedStaticMethodType,
					fractionPrimitive,
				),
			).toBe(false)
			expect(
				matchesType(integerList, noArgumentOverloadedStaticMethodType),
			).toBe(false)
		})
	})
})
