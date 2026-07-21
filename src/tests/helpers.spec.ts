import { describe, expect, it } from "bun:test"

import {
	applyGenericBindings,
	computeConformanceMethodMap,
	createInferenceContext,
	first,
	flatten,
	matchArguments,
	matchesType,
	matchesTypeWithBindings,
	resolveOverloadedMethodName,
	second,
	stripPosition,
	stripPositionFromArray,
	symbol,
	third,
} from "../helpers/index"
import type {
	ErrorType,
	FunctionType,
	GenericUse,
	ListType,
	MethodType,
	NamespaceType,
	OverloadedMethodType,
	OverloadedStaticMethodType,
	PrimitiveType,
	ProtocolType,
	RecordType,
	StaticMethodType,
	Type,
	UnionType,
	UnknownType,
} from "../interfaces/common/index"
import { lexer } from "../interfaces/index"

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

	describe("resolveOverloadedMethodName", () => {
		it("should resolve the overloaded method name", () => {
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
			type: "Boolean",
		}
		const integerPrimitive: PrimitiveType = {
			type: "Integer",
		}
		const fractionPrimitive: PrimitiveType = {
			type: "Fraction",
		}
		const stringPrimitive: PrimitiveType = {
			type: "String",
		}

		// const unknownList: ListType = {
		// 	type: "List",
		// 	itemType: { type: "Unknown" },
		// }

		// const stringList: ListType = {
		// 	type: "List",
		// 	itemType: { type: "String" },
		// }

		// const integerList: ListType = {
		// 	type: "List",
		// 	itemType: { type: "Integer" },
		// }

		const smallStringRecordType: RecordType = {
			type: "Record",
			members: {
				key: stringPrimitive,
			},
		}

		const smallIntegerRecordType: RecordType = {
			type: "Record",
			members: {
				key: integerPrimitive,
			},
		}

		const bigRecordType: RecordType = {
			type: "Record",
			members: {
				key: stringPrimitive,
				key2: stringPrimitive,
				key3: integerPrimitive,
			},
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
			generics: [],
			parameterTypes: [],
			returnType: { type: "String" },
		}

		const noArgumentWithDifferentReturnTypeFunctionType: FunctionType = {
			type: "Function",
			generics: [],
			parameterTypes: [],
			returnType: { type: "Integer" },
		}

		const singleArgumentFunctionType: FunctionType = {
			type: "Function",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "String" },
				},
			],
			returnType: { type: "String" },
		}

		const singleArgumentWithNameFunctionType: FunctionType = {
			type: "Function",
			generics: [],
			parameterTypes: [
				{
					name: "test",
					type: { type: "String" },
				},
			],
			returnType: { type: "String" },
		}

		// #endregion

		// #region Simple Methods

		const noArgumentSimpleMethodType: MethodType = {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [],
			returnType: { type: "String" },
		}

		const noArgumentWithDifferentReturnTypeSimpleMethodType: MethodType = {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [],
			returnType: { type: "Integer" },
		}

		const singleArgumentSimpleMethodType: MethodType = {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "String" },
				},
			],
			returnType: { type: "String" },
		}

		const singleArgumentWithNameSimpleMethodType: MethodType = {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: "test",
					type: { type: "String" },
				},
			],
			returnType: { type: "String" },
		}

		// #endregion

		// #region Static Methods

		const noArgumentStaticMethodType: StaticMethodType = {
			type: "StaticMethod",
			generics: [],
			parameterTypes: [],
			returnType: { type: "String" },
		}

		const noArgumentWithDifferentReturnTypeStaticMethodType: StaticMethodType =
			{
				type: "StaticMethod",
				generics: [],
				parameterTypes: [],
				returnType: { type: "Integer" },
			}

		const singleArgumentStaticMethodType: StaticMethodType = {
			type: "StaticMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "String" },
				},
			],
			returnType: { type: "String" },
		}

		const singleArgumentWithNameStaticMethodType: StaticMethodType = {
			type: "StaticMethod",
			generics: [],
			parameterTypes: [
				{
					name: "test",
					type: { type: "String" },
				},
			],
			returnType: { type: "String" },
		}

		// #endregion

		// #region Overloaded Methods

		const noArgumentOverloadedMethodType: OverloadedMethodType = {
			type: "OverloadedMethod",
			overloads: [
				{
					generics: [],
					parameterTypes: [],
					returnType: { type: "String" },
				},
			],
		}

		const noArgumentWithDifferentReturnTypeOverloadedMethodType: OverloadedMethodType =
			{
				type: "OverloadedMethod",
				overloads: [
					{
						generics: [],
						parameterTypes: [],
						returnType: { type: "Integer" },
					},
				],
			}

		const singleArgumentOverloadedMethodType: OverloadedMethodType = {
			type: "OverloadedMethod",
			overloads: [
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "String" },
						},
					],
					returnType: { type: "String" },
				},
			],
		}

		const singleArgumentWithNameOverloadedMethodType: OverloadedMethodType =
			{
				type: "OverloadedMethod",
				overloads: [
					{
						generics: [],
						parameterTypes: [
							{
								name: "test",
								type: {
									type: "String",
								},
							},
						],
						returnType: { type: "String" },
					},
					{
						generics: [],
						parameterTypes: [
							{
								name: "test2",
								type: {
									type: "String",
								},
							},
						],
						returnType: { type: "String" },
					},
				],
			}

		const alternativeSingleArgumentWithNameOverloadedMethodType: OverloadedMethodType =
			{
				type: "OverloadedMethod",
				overloads: [
					{
						generics: [],
						parameterTypes: [
							{
								name: "test2",
								type: {
									type: "String",
								},
							},
						],
						returnType: { type: "String" },
					},
					{
						generics: [],
						parameterTypes: [
							{
								name: "test3",
								type: {
									type: "String",
								},
							},
						],
						returnType: { type: "String" },
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
						generics: [],
						parameterTypes: [],
						returnType: { type: "String" },
					},
				],
			}

		const noArgumentWithDifferentReturnTypeOverloadedStaticMethodType: OverloadedStaticMethodType =
			{
				type: "OverloadedStaticMethod",
				overloads: [
					{
						generics: [],
						parameterTypes: [],
						returnType: { type: "Integer" },
					},
				],
			}

		const singleArgumentOverloadedStaticMethodType: OverloadedStaticMethodType =
			{
				type: "OverloadedStaticMethod",
				overloads: [
					{
						generics: [],
						parameterTypes: [
							{
								name: null,
								type: {
									type: "String",
								},
							},
						],
						returnType: { type: "String" },
					},
				],
			}

		const singleArgumentWithNameOverloadedStaticMethodType: OverloadedStaticMethodType =
			{
				type: "OverloadedStaticMethod",
				overloads: [
					{
						generics: [],
						parameterTypes: [
							{
								name: "test",
								type: {
									type: "String",
								},
							},
						],
						returnType: { type: "String" },
					},
					{
						generics: [],
						parameterTypes: [
							{
								name: "test2",
								type: {
									type: "String",
								},
							},
						],
						returnType: { type: "String" },
					},
				],
			}

		const alternativeSingleArgumentWithNameOverloadedStaticMethodType: OverloadedStaticMethodType =
			{
				type: "OverloadedStaticMethod",
				overloads: [
					{
						generics: [],
						parameterTypes: [
							{
								name: "test2",
								type: {
									type: "String",
								},
							},
						],
						returnType: { type: "String" },
					},
					{
						generics: [],
						parameterTypes: [
							{
								name: "test3",
								type: {
									type: "String",
								},
							},
						],
						returnType: { type: "String" },
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

			// expect(matchesType(unknown, unknownList)).toBe(true)
			// expect(matchesType(unknown, stringList)).toBe(true)
			// expect(matchesType(unknown, integerList)).toBe(true)

			expect(matchesType(unknown, noArgumentFunctionType)).toBe(true)
			expect(matchesType(unknown, singleArgumentFunctionType)).toBe(true)
		})

		it("should match anything to ErrorType, in both directions", () => {
			const errorType: ErrorType = { type: "Error" }

			expect(matchesType(errorType, booleanPrimitive)).toBe(true)
			expect(matchesType(errorType, stringPrimitive)).toBe(true)
			expect(matchesType(errorType, unionTypeStringInteger)).toBe(true)
			expect(matchesType(errorType, noArgumentFunctionType)).toBe(true)

			expect(matchesType(booleanPrimitive, errorType)).toBe(true)
			expect(matchesType(stringPrimitive, errorType)).toBe(true)
			expect(matchesType(unionTypeStringInteger, errorType)).toBe(true)
			expect(matchesType(noArgumentFunctionType, errorType)).toBe(true)

			expect(matchesType(errorType, errorType)).toBe(true)
		})

		it("should match matching PrimitiveTypes", () => {
			expect(matchesType(booleanPrimitive, booleanPrimitive)).toBe(true)
			expect(matchesType(integerPrimitive, integerPrimitive)).toBe(true)
			expect(matchesType(fractionPrimitive, fractionPrimitive)).toBe(true)
			expect(matchesType(stringPrimitive, stringPrimitive)).toBe(true)
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

		it("should match matching record types", () => {
			expect(
				matchesType(smallStringRecordType, smallStringRecordType),
			).toBe(true)
			expect(matchesType(bigRecordType, bigRecordType)).toBe(true)
			expect(matchesType(smallStringRecordType, bigRecordType)).toBe(true)
		})

		it("should not match mismatched record types", () => {
			expect(
				matchesType(smallIntegerRecordType, smallStringRecordType),
			).toBe(false)
			expect(
				matchesType(smallStringRecordType, smallIntegerRecordType),
			).toBe(false)
			expect(matchesType(bigRecordType, smallStringRecordType)).toBe(
				false,
			)
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
		})

		it("should match UnionTypes that are a subset of the expected UnionType", () => {
			const unionTypeStringIntegerFraction: UnionType = {
				type: "UnionType",
				types: [stringPrimitive, integerPrimitive, fractionPrimitive],
			}

			expect(
				matchesType(
					unionTypeStringIntegerFraction,
					unionTypeStringInteger,
				),
			).toBe(true)
			expect(
				matchesType(
					unionTypeStringIntegerFraction,
					unionTypeIntegerFraction,
				),
			).toBe(true)
		})

		it("should not match UnionTypes that are a superset of the expected UnionType", () => {
			const unionTypeStringIntegerFraction: UnionType = {
				type: "UnionType",
				types: [stringPrimitive, integerPrimitive, fractionPrimitive],
			}

			expect(
				matchesType(
					unionTypeStringInteger,
					unionTypeStringIntegerFraction,
				),
			).toBe(false)
			expect(
				matchesType(
					unionTypeIntegerFraction,
					unionTypeStringIntegerFraction,
				),
			).toBe(false)
		})

		// it("should match matching ListTypes", () => {
		// 	expect(matchesType(unknownList, stringList)).toBe(true)
		// 	expect(matchesType(unknownList, integerList)).toBe(true)
		// 	expect(matchesType(stringList, unknownList)).toBe(true)
		// 	expect(matchesType(integerList, unknownList)).toBe(true)

		// 	expect(matchesType(stringList, stringList)).toBe(true)
		// 	expect(matchesType(integerList, integerList)).toBe(true)
		// })

		// it("should not match mismatched ListTypes", () => {
		// 	expect(matchesType(stringList, integerList)).toBe(false)
		// 	expect(matchesType(integerList, stringList)).toBe(false)
		// })

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

		describe("Signature Variance", () => {
			const takesIntegerFunctionType: FunctionType = {
				type: "Function",
				generics: [],
				parameterTypes: [{ name: null, type: { type: "Integer" } }],
				returnType: { type: "String" },
			}

			const takesIntegerOrFractionFunctionType: FunctionType = {
				type: "Function",
				generics: [],
				parameterTypes: [
					{ name: null, type: unionTypeIntegerFraction },
				],
				returnType: { type: "String" },
			}

			const returnsIntegerFunctionType: FunctionType = {
				type: "Function",
				generics: [],
				parameterTypes: [],
				returnType: { type: "Integer" },
			}

			const returnsIntegerOrFractionFunctionType: FunctionType = {
				type: "Function",
				generics: [],
				parameterTypes: [],
				returnType: unionTypeIntegerFraction,
			}

			const takesIntegerSimpleMethodType: MethodType = {
				type: "SimpleMethod",
				generics: [],
				parameterTypes: [{ name: null, type: { type: "Integer" } }],
				returnType: { type: "String" },
			}

			const takesIntegerOrFractionSimpleMethodType: MethodType = {
				type: "SimpleMethod",
				generics: [],
				parameterTypes: [
					{ name: null, type: unionTypeIntegerFraction },
				],
				returnType: { type: "String" },
			}

			const returnsIntegerSimpleMethodType: MethodType = {
				type: "SimpleMethod",
				generics: [],
				parameterTypes: [],
				returnType: { type: "Integer" },
			}

			const returnsIntegerOrFractionSimpleMethodType: MethodType = {
				type: "SimpleMethod",
				generics: [],
				parameterTypes: [],
				returnType: unionTypeIntegerFraction,
			}

			const takesIntegerStaticMethodType: MethodType = {
				type: "StaticMethod",
				generics: [],
				parameterTypes: [{ name: null, type: { type: "Integer" } }],
				returnType: { type: "String" },
			}

			const takesIntegerOrFractionStaticMethodType: MethodType = {
				type: "StaticMethod",
				generics: [],
				parameterTypes: [
					{ name: null, type: unionTypeIntegerFraction },
				],
				returnType: { type: "String" },
			}

			const takesIntegerOverloadedMethodType: MethodType = {
				type: "OverloadedMethod",
				overloads: [
					{
						generics: [],
						parameterTypes: [
							{ name: null, type: { type: "Integer" } },
						],
						returnType: { type: "String" },
					},
				],
			}

			const takesIntegerOrFractionOverloadedMethodType: MethodType = {
				type: "OverloadedMethod",
				overloads: [
					{
						generics: [],
						parameterTypes: [
							{ name: null, type: unionTypeIntegerFraction },
						],
						returnType: { type: "String" },
					},
				],
			}

			it("should accept Functions with wider parameter types (contravariance)", () => {
				expect(
					matchesType(
						takesIntegerFunctionType,
						takesIntegerOrFractionFunctionType,
					),
				).toBe(true)
			})

			it("should reject Functions with narrower parameter types", () => {
				expect(
					matchesType(
						takesIntegerOrFractionFunctionType,
						takesIntegerFunctionType,
					),
				).toBe(false)
			})

			it("should accept Functions with narrower return types (covariance)", () => {
				expect(
					matchesType(
						returnsIntegerOrFractionFunctionType,
						returnsIntegerFunctionType,
					),
				).toBe(true)
			})

			it("should reject Functions with wider return types", () => {
				expect(
					matchesType(
						returnsIntegerFunctionType,
						returnsIntegerOrFractionFunctionType,
					),
				).toBe(false)
			})

			it("should accept SimpleMethods with wider parameter types (contravariance)", () => {
				expect(
					matchesType(
						takesIntegerSimpleMethodType,
						takesIntegerOrFractionSimpleMethodType,
					),
				).toBe(true)
			})

			it("should reject SimpleMethods with narrower parameter types", () => {
				expect(
					matchesType(
						takesIntegerOrFractionSimpleMethodType,
						takesIntegerSimpleMethodType,
					),
				).toBe(false)
			})

			it("should accept SimpleMethods with narrower return types (covariance)", () => {
				expect(
					matchesType(
						returnsIntegerOrFractionSimpleMethodType,
						returnsIntegerSimpleMethodType,
					),
				).toBe(true)
			})

			it("should reject SimpleMethods with wider return types", () => {
				expect(
					matchesType(
						returnsIntegerSimpleMethodType,
						returnsIntegerOrFractionSimpleMethodType,
					),
				).toBe(false)
			})

			it("should accept StaticMethods with wider parameter types (contravariance)", () => {
				expect(
					matchesType(
						takesIntegerStaticMethodType,
						takesIntegerOrFractionStaticMethodType,
					),
				).toBe(true)
			})

			it("should reject StaticMethods with narrower parameter types", () => {
				expect(
					matchesType(
						takesIntegerOrFractionStaticMethodType,
						takesIntegerStaticMethodType,
					),
				).toBe(false)
			})

			it("should accept OverloadedMethods with wider parameter types (contravariance)", () => {
				expect(
					matchesType(
						takesIntegerOverloadedMethodType,
						takesIntegerOrFractionOverloadedMethodType,
					),
				).toBe(true)
			})

			it("should reject OverloadedMethods with narrower parameter types", () => {
				expect(
					matchesType(
						takesIntegerOrFractionOverloadedMethodType,
						takesIntegerOverloadedMethodType,
					),
				).toBe(false)
			})
		})

		it("should not match mismatched Types", () => {
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
			// expect(
			// 	matchesType(integerList, noArgumentOverloadedStaticMethodType),
			// ).toBe(false)
		})

		describe("Opaque Generics", () => {
			const genericT: GenericUse = { type: "GenericUse", name: "T" }
			const genericU: GenericUse = { type: "GenericUse", name: "U" }

			it("should match a Generic to itself", () => {
				expect(matchesType(genericT, genericT)).toBe(true)
			})

			it("should not match different Generics", () => {
				expect(matchesType(genericT, genericU)).toBe(false)
			})

			it("should not match a Generic against a concrete Type", () => {
				expect(matchesType(genericT, integerPrimitive)).toBe(false)
				expect(matchesType(integerPrimitive, genericT)).toBe(false)
			})

			it("should accept a Generic member of an expected Union", () => {
				const maybeT: UnionType = {
					type: "UnionType",
					types: [genericT, { type: "Nothing" }],
				}

				expect(matchesType(maybeT, genericT)).toBe(true)
				expect(matchesType(maybeT, { type: "Nothing" })).toBe(true)
				expect(matchesType(maybeT, genericU)).toBe(false)
			})
		})
	})

	describe("Generic Inference", () => {
		const genericT: GenericUse = { type: "GenericUse", name: "T" }
		const integer: Type = { type: "Integer" }
		const fraction: Type = { type: "Fraction" }
		const string: Type = { type: "String" }
		const nothing: Type = { type: "Nothing" }

		function inferContextFor(names: Array<string>) {
			return createInferenceContext(
				names.map((name) => ({ name, infer: true, defaultType: null })),
			)
		}

		describe("createInferenceContext", () => {
			it("should leave infer Generics unbound", () => {
				let context = createInferenceContext([
					{ name: "T", infer: true, defaultType: null },
				])

				expect(context.bindableNames.has("T")).toBe(true)
				expect(context.bindings.has("T")).toBe(false)
			})

			it("should seed plain Generics with their default Type", () => {
				let context = createInferenceContext([
					{ name: "T", infer: false, defaultType: string },
				])

				expect(context.bindableNames.has("T")).toBe(true)
				expect(context.bindings.get("T")).toEqual(string)
			})

			it("should keep plain Generics without a default opaque", () => {
				let context = createInferenceContext([
					{ name: "T", infer: false, defaultType: null },
				])

				expect(context.bindableNames.has("T")).toBe(false)
			})
		})

		describe("matchesTypeWithBindings", () => {
			it("should bind a Generic on its first occurrence", () => {
				let context = inferContextFor(["T"])

				expect(
					matchesTypeWithBindings(genericT, integer, context),
				).toBe(true)
				expect(context.bindings.get("T")).toEqual(integer)
			})

			it("should check later occurrences against the binding", () => {
				let context = inferContextFor(["T"])
				let integerOrFraction: UnionType = {
					type: "UnionType",
					types: [integer, fraction],
				}

				expect(
					matchesTypeWithBindings(
						genericT,
						integerOrFraction,
						context,
					),
				).toBe(true)
				expect(
					matchesTypeWithBindings(genericT, fraction, context),
				).toBe(true)
				expect(matchesTypeWithBindings(genericT, string, context)).toBe(
					false,
				)
			})

			it("should reject conflicting later occurrences", () => {
				let context = inferContextFor(["T"])

				expect(
					matchesTypeWithBindings(genericT, integer, context),
				).toBe(true)
				expect(matchesTypeWithBindings(genericT, string, context)).toBe(
					false,
				)
			})

			it("should bind Generics nested in Lists", () => {
				let context = inferContextFor(["T"])
				let listOfT: ListType = { type: "List", itemType: genericT }
				let listOfString: ListType = { type: "List", itemType: string }

				expect(
					matchesTypeWithBindings(listOfT, listOfString, context),
				).toBe(true)
				expect(context.bindings.get("T")).toEqual(string)
			})

			it("should not bind from empty List Literals", () => {
				let context = inferContextFor(["T"])
				let listOfT: ListType = { type: "List", itemType: genericT }
				let listOfUnknown: ListType = {
					type: "List",
					itemType: { type: "Unknown" },
				}

				expect(
					matchesTypeWithBindings(listOfT, listOfUnknown, context),
				).toBe(true)
				expect(context.bindings.has("T")).toBe(false)
			})

			it("should bind Generics nested in Records", () => {
				let context = inferContextFor(["T"])
				let recordOfT: RecordType = {
					type: "Record",
					members: { key: genericT },
				}
				let recordOfInteger: RecordType = {
					type: "Record",
					members: { key: integer },
				}

				expect(
					matchesTypeWithBindings(
						recordOfT,
						recordOfInteger,
						context,
					),
				).toBe(true)
				expect(context.bindings.get("T")).toEqual(integer)
			})

			it("should bind a Generic from a Function's return Type", () => {
				let context = inferContextFor(["Target"])
				let expected: FunctionType = {
					type: "Function",
					generics: [],
					parameterTypes: [{ name: null, type: integer }],
					returnType: { type: "GenericUse", name: "Target" },
				}
				let actual: FunctionType = {
					type: "Function",
					generics: [],
					parameterTypes: [{ name: null, type: integer }],
					returnType: string,
				}

				expect(matchesTypeWithBindings(expected, actual, context)).toBe(
					true,
				)
				expect(context.bindings.get("Target")).toEqual(string)
			})

			it("should check a Function's parameters against bound Generics", () => {
				let context = inferContextFor(["Item"])
				let genericItem: GenericUse = {
					type: "GenericUse",
					name: "Item",
				}

				expect(
					matchesTypeWithBindings(genericItem, integer, context),
				).toBe(true)

				let expected: FunctionType = {
					type: "Function",
					generics: [],
					parameterTypes: [{ name: null, type: genericItem }],
					returnType: string,
				}
				let matching: FunctionType = {
					type: "Function",
					generics: [],
					parameterTypes: [{ name: null, type: integer }],
					returnType: string,
				}
				let mismatching: FunctionType = {
					type: "Function",
					generics: [],
					parameterTypes: [{ name: null, type: string }],
					returnType: string,
				}

				expect(
					matchesTypeWithBindings(expected, matching, context),
				).toBe(true)
				expect(
					matchesTypeWithBindings(expected, mismatching, context),
				).toBe(false)
			})

			it("should prefer concrete Union members over binding a Generic", () => {
				let context = inferContextFor(["Value"])
				let genericValue: GenericUse = {
					type: "GenericUse",
					name: "Value",
				}
				let maybeValue: UnionType = {
					type: "UnionType",
					types: [genericValue, nothing],
				}

				expect(
					matchesTypeWithBindings(maybeValue, nothing, context),
				).toBe(true)
				expect(context.bindings.has("Value")).toBe(false)

				expect(
					matchesTypeWithBindings(maybeValue, integer, context),
				).toBe(true)
				expect(context.bindings.get("Value")).toEqual(integer)
			})

			it("should bind a Generic from a Union receiver", () => {
				let context = inferContextFor(["Value"])
				let genericValue: GenericUse = {
					type: "GenericUse",
					name: "Value",
				}
				let maybeValue: UnionType = {
					type: "UnionType",
					types: [genericValue, nothing],
				}
				let integerOrNothing: UnionType = {
					type: "UnionType",
					types: [integer, nothing],
				}

				expect(
					matchesTypeWithBindings(
						maybeValue,
						integerOrNothing,
						context,
					),
				).toBe(true)
				expect(context.bindings.get("Value")).toEqual(integer)
			})
		})

		describe("applyGenericBindings", () => {
			it("should substitute bindings into nested Types", () => {
				let bindings = new Map<string, Type>([["T", string]])
				let listOfT: Type = { type: "List", itemType: genericT }
				let functionOfT: Type = {
					type: "Function",
					generics: [],
					parameterTypes: [{ name: null, type: genericT }],
					returnType: { type: "List", itemType: genericT },
				}

				expect(applyGenericBindings(listOfT, bindings)).toEqual({
					type: "List",
					itemType: string,
				})
				expect(applyGenericBindings(functionOfT, bindings)).toEqual({
					type: "Function",
					generics: [],
					parameterTypes: [{ name: null, type: string }],
					returnType: { type: "List", itemType: string },
				})
			})

			it("should leave unbound Generics untouched", () => {
				let bindings = new Map<string, Type>()

				expect(applyGenericBindings(genericT, bindings)).toEqual(
					genericT,
				)
			})
		})

		describe("matchArguments with inference", () => {
			const parameters = [
				{ name: null, type: genericT },
				{ name: null, type: genericT },
			]

			it("should infer Arguments left to right", () => {
				let context = inferContextFor(["T"])

				expect(
					matchArguments(
						parameters,
						[
							{ name: null, getType: () => integer },
							{ name: null, getType: () => integer },
						],
						{ inference: context },
					),
				).toEqual({ type: "Match" })
				expect(context.bindings.get("T")).toEqual(integer)
			})

			it("should reject Arguments conflicting with a binding", () => {
				expect(
					matchArguments(
						parameters,
						[
							{ name: null, getType: () => integer },
							{ name: null, getType: () => string },
						],
						{ inference: inferContextFor(["T"]) },
					),
				).toEqual({
					type: "ArgumentMismatch",
					mismatchedArgumentIndices: [1],
				})
			})

			it("should not leak bindings between candidates", () => {
				expect(
					matchArguments(
						parameters,
						[
							{ name: null, getType: () => string },
							{ name: null, getType: () => integer },
						],
						{ inference: inferContextFor(["T"]) },
					).type,
				).toBe("ArgumentMismatch")

				// NOTE: A fresh context is a fresh candidate — the previous
				// String binding must not survive.
				expect(
					matchArguments(
						parameters,
						[
							{ name: null, getType: () => integer },
							{ name: null, getType: () => integer },
						],
						{ inference: inferContextFor(["T"]) },
					),
				).toEqual({ type: "Match" })
			})
		})
	})

	describe("computeConformanceMethodMap", () => {
		const self: GenericUse = { type: "GenericUse", name: "Self" }
		const integer: Type = { type: "Integer" }
		const string: Type = { type: "String" }

		const toStringRequirement: MethodType = {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [{ name: null, type: self }],
			returnType: string,
		}

		const printable: ProtocolType = {
			type: "Protocol",
			name: "Printable",
			methods: { toString: toStringRequirement },
		}

		function integerNamespace(
			methods: NamespaceType["methods"],
		): NamespaceType {
			return {
				type: "Namespace",
				name: "IntegerPrintable",
				targetType: integer,
				generics: [],
				properties: {},
				methods,
				conformsTo: ["Printable"],
			}
		}

		it("maps a simple requirement onto a simple Method", () => {
			let toStringMethod: MethodType = {
				type: "SimpleMethod",
				generics: [],
				parameterTypes: [{ name: null, type: integer }],
				returnType: string,
			}

			let result = computeConformanceMethodMap(
				printable,
				integerNamespace({ toString: toStringMethod }),
				integer,
			)

			expect(result).toEqual({
				kind: "conforms",
				methodMap: { toString: "toString" },
			})
		})

		it("maps a simple requirement onto the first matching overload", () => {
			let toStringMethod: MethodType = {
				type: "OverloadedMethod",
				overloads: [
					{
						generics: [],
						parameterTypes: [
							{ name: null, type: integer },
							{ name: null, type: string },
						],
						returnType: string,
					},
					{
						generics: [],
						parameterTypes: [{ name: null, type: integer }],
						returnType: string,
					},
				],
			}

			let result = computeConformanceMethodMap(
				printable,
				integerNamespace({ toString: toStringMethod }),
				integer,
			)

			expect(result).toEqual({
				kind: "conforms",
				methodMap: { toString: "toString__overload$2" },
			})
		})

		it("reports a missing Method", () => {
			let result = computeConformanceMethodMap(
				printable,
				integerNamespace({}),
				integer,
			)

			expect(result).toEqual({ kind: "missing", methodName: "toString" })
		})

		it("reports a mismatched return Type", () => {
			let toStringMethod: MethodType = {
				type: "SimpleMethod",
				generics: [],
				parameterTypes: [{ name: null, type: integer }],
				returnType: { type: "Boolean" },
			}

			let result = computeConformanceMethodMap(
				printable,
				integerNamespace({ toString: toStringMethod }),
				integer,
			)

			expect(result).toEqual({
				kind: "mismatched",
				methodName: "toString",
			})
		})

		it("rejects mismatched staticness", () => {
			let toStringMethod: MethodType = {
				type: "StaticMethod",
				generics: [],
				parameterTypes: [{ name: null, type: integer }],
				returnType: string,
			}

			let result = computeConformanceMethodMap(
				printable,
				integerNamespace({ toString: toStringMethod }),
				integer,
			)

			expect(result).toEqual({
				kind: "mismatched",
				methodName: "toString",
			})
		})

		it("maps overloaded requirements by Protocol overload order", () => {
			const combinable: ProtocolType = {
				type: "Protocol",
				name: "Combinable",
				methods: {
					combine: {
						type: "OverloadedMethod",
						overloads: [
							{
								generics: [],
								parameterTypes: [
									{ name: null, type: self },
									{ name: null, type: self },
								],
								returnType: self,
							},
							{
								generics: [],
								parameterTypes: [
									{ name: null, type: self },
									{ name: null, type: string },
								],
								returnType: self,
							},
						],
					},
				},
			}

			let result = computeConformanceMethodMap(
				combinable,
				integerNamespace({
					combine: {
						type: "OverloadedMethod",
						overloads: [
							{
								generics: [],
								parameterTypes: [
									{ name: null, type: integer },
									{ name: null, type: string },
								],
								returnType: integer,
							},
							{
								generics: [],
								parameterTypes: [
									{ name: null, type: integer },
									{ name: null, type: integer },
								],
								returnType: integer,
							},
						],
					},
				}),
				integer,
			)

			expect(result).toEqual({
				kind: "conforms",
				methodMap: {
					combine__overload$1: "combine__overload$2",
					combine__overload$2: "combine__overload$1",
				},
			})
		})
	})
})
