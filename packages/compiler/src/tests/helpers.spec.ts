import { describe, expect, it } from "bun:test"

import type { common } from "@essence-lang/interfaces"
import { lexer } from "@essence-lang/interfaces"
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
} from "@essence-lang/interfaces/common"

import { eraseRefinements } from "../helpers/eraseRefinements"
import {
	applyGenericBindings,
	buildUnion,
	canonicalPredicateConjuncts,
	computeConformanceMethodMap,
	createInferenceContext,
	describeType,
	first,
	flatten,
	matchArguments,
	matchesType,
	matchesTypeWithBindings,
	mentionsUnsolvedTypeParameter,
	predicateConjunctKey,
	resolveOverloadedMethodName,
	second,
	stripPosition,
	stripPositionFromArray,
	symbol,
	third,
	typeContainsError,
	typeContainsRefinement,
	typeContainsUnknown,
	typeMentionsGeneric,
} from "../helpers/index"

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

	// NOTE: The three function-ish tags are one kind of value — only the
	// signature tells two of them apart — so all three describe as the
	// signature a Type Annotation would spell, rather than as the bare word
	// "Function" that named both sides of every mismatch alike.
	describe("describeType", () => {
		it("should print a Function under the signature an Annotation spells", () => {
			let doubler: FunctionType = {
				type: "Function",
				parameterTypes: [{ name: null, type: { type: "Integer" } }],
				generics: [],
				returnType: { type: "Integer" },
			}

			expect(describeType(doubler)).toBe("(_: Integer) -> Integer")
		})

		it("should print a labelled Parameter under its label", () => {
			let adder: FunctionType = {
				type: "Function",
				parameterTypes: [{ name: "with", type: { type: "Integer" } }],
				generics: [],
				returnType: { type: "Integer" },
			}

			expect(describeType(adder)).toBe("(with: Integer) -> Integer")
		})

		it("should print a Function that takes nothing with an empty list", () => {
			let now: FunctionType = {
				type: "Function",
				parameterTypes: [],
				generics: [],
				returnType: { type: "String" },
			}

			expect(describeType(now)).toBe("() -> String")
		})

		// NOTE: A Method read as a value carries its receiver as the first
		// Parameter of its Type, and it is printed there — that receiver is
		// exactly what makes it not fit a Function of one Argument fewer.
		it("should print a Method's receiver as its first Parameter", () => {
			let double: MethodType = {
				type: "SimpleMethod",
				parameterTypes: [{ name: null, type: { type: "Integer" } }],
				generics: [],
				returnType: { type: "Integer" },
			}

			expect(describeType(double)).toBe("(_: Integer) -> Integer")
		})

		it("should print a static Method's signature the same way", () => {
			let readsBase: StaticMethodType = {
				type: "StaticMethod",
				parameterTypes: [{ name: null, type: { type: "String" } }],
				generics: [],
				returnType: { type: "Integer" },
			}

			expect(describeType(readsBase)).toBe("(_: String) -> Integer")
		})

		// NOTE: An Overload set has no ONE signature to print, so it keeps the
		// bare word.
		it("should leave an Overload set the bare word", () => {
			let overloaded: OverloadedMethodType = {
				type: "OverloadedMethod",
				overloads: [
					{
						parameterTypes: [
							{ name: null, type: { type: "Integer" } },
						],
						generics: [],
						returnType: { type: "Integer" },
					},
					{
						parameterTypes: [
							{ name: null, type: { type: "String" } },
						],
						generics: [],
						returnType: { type: "String" },
					},
				],
			}

			expect(describeType(overloaded)).toBe("Function")
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
		const rationalPrimitive: PrimitiveType = {
			type: "Rational",
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

		const unionTypeIntegerRational: UnionType = {
			type: "UnionType",
			types: [integerPrimitive, rationalPrimitive],
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
			expect(matchesType(unknown, rationalPrimitive)).toBe(true)
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
			expect(matchesType(rationalPrimitive, rationalPrimitive)).toBe(true)
			expect(matchesType(stringPrimitive, stringPrimitive)).toBe(true)
		})

		it("should not match mismatched PrimitiveTypes", () => {
			expect(matchesType(booleanPrimitive, stringPrimitive)).toBe(false)
			expect(matchesType(booleanPrimitive, integerPrimitive)).toBe(false)
			expect(matchesType(booleanPrimitive, rationalPrimitive)).toBe(false)

			expect(matchesType(stringPrimitive, booleanPrimitive)).toBe(false)
			expect(matchesType(stringPrimitive, integerPrimitive)).toBe(false)
			expect(matchesType(stringPrimitive, rationalPrimitive)).toBe(false)

			expect(matchesType(integerPrimitive, stringPrimitive)).toBe(false)
			expect(matchesType(integerPrimitive, booleanPrimitive)).toBe(false)
			expect(matchesType(integerPrimitive, rationalPrimitive)).toBe(false)

			expect(matchesType(rationalPrimitive, stringPrimitive)).toBe(false)
			expect(matchesType(rationalPrimitive, integerPrimitive)).toBe(false)
			expect(matchesType(rationalPrimitive, booleanPrimitive)).toBe(false)
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
				matchesType(unionTypeStringInteger, unionTypeIntegerRational),
			).toBe(false)
			expect(
				matchesType(unionTypeIntegerRational, unionTypeStringInteger),
			).toBe(false)
			expect(matchesType(unionTypeStringInteger, rationalPrimitive)).toBe(
				false,
			)
		})

		it("should match UnionTypes that are a subset of the expected UnionType", () => {
			const unionTypeStringIntegerRational: UnionType = {
				type: "UnionType",
				types: [stringPrimitive, integerPrimitive, rationalPrimitive],
			}

			expect(
				matchesType(
					unionTypeStringIntegerRational,
					unionTypeStringInteger,
				),
			).toBe(true)
			expect(
				matchesType(
					unionTypeStringIntegerRational,
					unionTypeIntegerRational,
				),
			).toBe(true)
		})

		it("should not match UnionTypes that are a superset of the expected UnionType", () => {
			const unionTypeStringIntegerRational: UnionType = {
				type: "UnionType",
				types: [stringPrimitive, integerPrimitive, rationalPrimitive],
			}

			expect(
				matchesType(
					unionTypeStringInteger,
					unionTypeStringIntegerRational,
				),
			).toBe(false)
			expect(
				matchesType(
					unionTypeIntegerRational,
					unionTypeStringIntegerRational,
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

			const takesIntegerOrRationalFunctionType: FunctionType = {
				type: "Function",
				generics: [],
				parameterTypes: [
					{ name: null, type: unionTypeIntegerRational },
				],
				returnType: { type: "String" },
			}

			const returnsIntegerFunctionType: FunctionType = {
				type: "Function",
				generics: [],
				parameterTypes: [],
				returnType: { type: "Integer" },
			}

			const returnsIntegerOrRationalFunctionType: FunctionType = {
				type: "Function",
				generics: [],
				parameterTypes: [],
				returnType: unionTypeIntegerRational,
			}

			const takesIntegerSimpleMethodType: MethodType = {
				type: "SimpleMethod",
				generics: [],
				parameterTypes: [{ name: null, type: { type: "Integer" } }],
				returnType: { type: "String" },
			}

			const takesIntegerOrRationalSimpleMethodType: MethodType = {
				type: "SimpleMethod",
				generics: [],
				parameterTypes: [
					{ name: null, type: unionTypeIntegerRational },
				],
				returnType: { type: "String" },
			}

			const returnsIntegerSimpleMethodType: MethodType = {
				type: "SimpleMethod",
				generics: [],
				parameterTypes: [],
				returnType: { type: "Integer" },
			}

			const returnsIntegerOrRationalSimpleMethodType: MethodType = {
				type: "SimpleMethod",
				generics: [],
				parameterTypes: [],
				returnType: unionTypeIntegerRational,
			}

			const takesIntegerStaticMethodType: MethodType = {
				type: "StaticMethod",
				generics: [],
				parameterTypes: [{ name: null, type: { type: "Integer" } }],
				returnType: { type: "String" },
			}

			const takesIntegerOrRationalStaticMethodType: MethodType = {
				type: "StaticMethod",
				generics: [],
				parameterTypes: [
					{ name: null, type: unionTypeIntegerRational },
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

			const takesIntegerOrRationalOverloadedMethodType: MethodType = {
				type: "OverloadedMethod",
				overloads: [
					{
						generics: [],
						parameterTypes: [
							{ name: null, type: unionTypeIntegerRational },
						],
						returnType: { type: "String" },
					},
				],
			}

			it("should accept Functions with wider parameter types (contravariance)", () => {
				expect(
					matchesType(
						takesIntegerFunctionType,
						takesIntegerOrRationalFunctionType,
					),
				).toBe(true)
			})

			it("should reject Functions with narrower parameter types", () => {
				expect(
					matchesType(
						takesIntegerOrRationalFunctionType,
						takesIntegerFunctionType,
					),
				).toBe(false)
			})

			it("should accept Functions with narrower return types (covariance)", () => {
				expect(
					matchesType(
						returnsIntegerOrRationalFunctionType,
						returnsIntegerFunctionType,
					),
				).toBe(true)
			})

			it("should reject Functions with wider return types", () => {
				expect(
					matchesType(
						returnsIntegerFunctionType,
						returnsIntegerOrRationalFunctionType,
					),
				).toBe(false)
			})

			it("should accept SimpleMethods with wider parameter types (contravariance)", () => {
				expect(
					matchesType(
						takesIntegerSimpleMethodType,
						takesIntegerOrRationalSimpleMethodType,
					),
				).toBe(true)
			})

			it("should reject SimpleMethods with narrower parameter types", () => {
				expect(
					matchesType(
						takesIntegerOrRationalSimpleMethodType,
						takesIntegerSimpleMethodType,
					),
				).toBe(false)
			})

			it("should accept SimpleMethods with narrower return types (covariance)", () => {
				expect(
					matchesType(
						returnsIntegerOrRationalSimpleMethodType,
						returnsIntegerSimpleMethodType,
					),
				).toBe(true)
			})

			it("should reject SimpleMethods with wider return types", () => {
				expect(
					matchesType(
						returnsIntegerSimpleMethodType,
						returnsIntegerOrRationalSimpleMethodType,
					),
				).toBe(false)
			})

			it("should accept StaticMethods with wider parameter types (contravariance)", () => {
				expect(
					matchesType(
						takesIntegerStaticMethodType,
						takesIntegerOrRationalStaticMethodType,
					),
				).toBe(true)
			})

			it("should reject StaticMethods with narrower parameter types", () => {
				expect(
					matchesType(
						takesIntegerOrRationalStaticMethodType,
						takesIntegerStaticMethodType,
					),
				).toBe(false)
			})

			it("should accept OverloadedMethods with wider parameter types (contravariance)", () => {
				expect(
					matchesType(
						takesIntegerOverloadedMethodType,
						takesIntegerOrRationalOverloadedMethodType,
					),
				).toBe(true)
			})

			it("should reject OverloadedMethods with narrower parameter types", () => {
				expect(
					matchesType(
						takesIntegerOrRationalOverloadedMethodType,
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
					rationalPrimitive,
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

			// NOTE: An opaque Generic accepts nothing but itself, yet a Union
			// that HAS it as a member still accepts it — the member is the same
			// symbol, so the value really does fit. The Union's other member is
			// beside the point here; it is only there to make this a Union at
			// all, and it is accepted on its own terms.
			it("should accept a Generic member of an expected Union", () => {
				const genericOrString: UnionType = {
					type: "UnionType",
					types: [genericT, stringPrimitive],
				}

				expect(matchesType(genericOrString, genericT)).toBe(true)
				expect(matchesType(genericOrString, stringPrimitive)).toBe(true)
				expect(matchesType(genericOrString, genericU)).toBe(false)
			})
		})
	})

	describe("Generic Inference", () => {
		const genericT: GenericUse = { type: "GenericUse", name: "T" }
		const integer: Type = { type: "Integer" }
		const rational: Type = { type: "Rational" }
		const string: Type = { type: "String" }

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
				let integerOrRational: UnionType = {
					type: "UnionType",
					types: [integer, rational],
				}

				expect(
					matchesTypeWithBindings(
						genericT,
						integerOrRational,
						context,
					),
				).toBe(true)
				expect(
					matchesTypeWithBindings(genericT, rational, context),
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

			// NOTE: When a Method forwards to another whose `infer` generic is
			// spelled the same — every `List` Method binds `ItemType`, so
			// `firstItem` calling `item` matches the callee's bindable `ItemType`
			// against the caller's opaque `ItemType` carried by the receiver — the
			// bindable side must RECORD the binding off the actual Type, not be
			// waved through by bare name equality with nothing bound. Generic
			// identity is by name across the compiler, so the bindable-name check
			// is the only thing that keeps the two apart.
			it("should bind a Generic against a same-named opaque Generic", () => {
				let context = inferContextFor(["T"])
				let opaqueT: GenericUse = { type: "GenericUse", name: "T" }
				let listOfBindableT: ListType = {
					type: "List",
					itemType: genericT,
				}
				let listOfOpaqueT: ListType = {
					type: "List",
					itemType: opaqueT,
				}

				expect(
					matchesTypeWithBindings(
						listOfBindableT,
						listOfOpaqueT,
						context,
					),
				).toBe(true)
				expect(context.bindings.get("T")).toEqual(opaqueT)
			})

			// NOTE: A Method that forwards a same-named Generic through both its
			// receiver AND an Argument — `isNot(_ other: List<ItemType>)` binds
			// `ItemType` off the receiver, then matches the SAME Generic again for
			// `other`. The second occurrence verifies the binding, and the bound
			// value is the same opaque Generic use, so the verification must
			// short-circuit rather than re-match it forever. Without the guard
			// this test hangs.
			it("should accept a re-match of a Generic bound to a same-named opaque Generic", () => {
				let context = inferContextFor(["T"])
				let opaqueT: GenericUse = { type: "GenericUse", name: "T" }

				expect(
					matchesTypeWithBindings(genericT, opaqueT, context),
				).toBe(true)
				expect(
					matchesTypeWithBindings(genericT, opaqueT, context),
				).toBe(true)
				expect(context.bindings.get("T")).toEqual(opaqueT)
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

			// NOTE: A bindable Generic beside a concrete member would swallow
			// whatever the concrete member was written to take — bound to
			// `String` here, every later occurrence of `Value` would then be
			// held to it. The concrete members are tried FIRST, so the Generic
			// only ever binds what none of them claimed.
			it("should prefer concrete Union members over binding a Generic", () => {
				let context = inferContextFor(["Value"])
				let genericValue: GenericUse = {
					type: "GenericUse",
					name: "Value",
				}
				let valueOrString: UnionType = {
					type: "UnionType",
					types: [genericValue, string],
				}

				expect(
					matchesTypeWithBindings(valueOrString, string, context),
				).toBe(true)
				expect(context.bindings.has("Value")).toBe(false)

				expect(
					matchesTypeWithBindings(valueOrString, integer, context),
				).toBe(true)
				expect(context.bindings.get("Value")).toEqual(integer)
			})

			it("should bind a Generic from a Union receiver", () => {
				let context = inferContextFor(["Value"])
				let genericValue: GenericUse = {
					type: "GenericUse",
					name: "Value",
				}
				let valueOrString: UnionType = {
					type: "UnionType",
					types: [genericValue, string],
				}
				let integerOrString: UnionType = {
					type: "UnionType",
					types: [integer, string],
				}

				expect(
					matchesTypeWithBindings(
						valueOrString,
						integerOrString,
						context,
					),
				).toBe(true)
				expect(context.bindings.get("Value")).toEqual(integer)
			})

			// NOTE: The first member binds `T := String` off `left` and THEN
			// fails on `right`. That binding is worth no more than the member
			// that made it, but it used to survive the failed attempt, so the
			// second member — which matches on its own with `T := Integer` —
			// was checked against the leftover `T := String` and wrongly
			// rejected. Which spelling of the same Union compiled came down to
			// the order its members were written in.
			it("should roll a failed Union member's bindings back", () => {
				let context = inferContextFor(["T"])
				let leftOrRight: UnionType = {
					type: "UnionType",
					types: [
						{
							type: "Record",
							members: { left: genericT, right: string },
						},
						{
							type: "Record",
							members: { left: string, right: genericT },
						},
					],
				}
				let actual: RecordType = {
					type: "Record",
					members: { left: string, right: integer },
				}

				expect(
					matchesTypeWithBindings(leftOrRight, actual, context),
				).toBe(true)
				expect(context.bindings.get("T")).toEqual(integer)
			})

			it("should leave no bindings behind when no Union member matches", () => {
				let context = inferContextFor(["T"])
				let leftOrRight: UnionType = {
					type: "UnionType",
					types: [
						{
							type: "Record",
							members: { left: genericT, right: string },
						},
						{
							type: "Record",
							members: { left: string, right: genericT },
						},
					],
				}
				let actual: RecordType = {
					type: "Record",
					members: { left: integer, right: integer },
				}

				expect(
					matchesTypeWithBindings(leftOrRight, actual, context),
				).toBe(false)
				expect(context.bindings.has("T")).toBe(false)
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

			// NOTE: A callback Parameter still waiting on an unbound Generic is
			// matched LAST. An unannotated Function literal is typed from the
			// Parameter it is passed to — modelled here by an Argument that
			// echoes the expected Type back — so matched while `T` was open it
			// echoed `T` itself, pinning the Generic to its own name: the
			// Generic went opaque and the `5` that followed, its own inferred
			// Type, was turned away.
			describe("callbacks waiting on a Generic", () => {
				const transform: FunctionType = {
					type: "Function",
					generics: [],
					parameterTypes: [{ name: null, type: genericT }],
					returnType: genericT,
				}
				const callbackFirst = [
					{ name: "transform", type: transform },
					{ name: "to", type: genericT },
				]

				it("should bind from the other Argument and resolve the callback against it", () => {
					let context = inferContextFor(["T"])
					let expectedTypes: Array<Type> = []

					expect(
						matchArguments(
							callbackFirst,
							[
								{
									name: "transform",
									getType: (expectedType) => {
										expectedTypes.push(expectedType)

										return expectedType
									},
								},
								{ name: "to", getType: () => integer },
							],
							{ inference: context },
						),
					).toEqual({ type: "Match" })

					expect(context.bindings.get("T")).toEqual(integer)
					// NOTE: The Type the literal was resolved against — the
					// signature with the binding substituted in, which is what
					// gives the lambda's body real Types to work with.
					expect(expectedTypes).toEqual([
						{
							type: "Function",
							generics: [],
							parameterTypes: [{ name: null, type: integer }],
							returnType: integer,
						},
					])
				})

				it("should report mismatching Arguments in the order they were written", () => {
					expect(
						matchArguments(
							callbackFirst,
							[
								{ name: null, getType: () => transform },
								{ name: null, getType: () => integer },
							],
							{
								inference: inferContextFor(["T"]),
								collectAllMismatches: true,
							},
						),
					).toEqual({
						type: "ArgumentMismatch",
						mismatchedArgumentIndices: [0, 1],
					})
				})
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

	// NOTE: A resolved Type is a DAG — every level of `type Nested = Box<Inner> |
	// Box<List<Inner>>` names the ONE Type below it from four places — so a walk
	// that follows every reference rather than every OBJECT visits what is shared
	// exponentially often. Each level below names the one under it three times,
	// so the sixteen levels here are fifty-odd objects held and forty million
	// references followed, climbing by a factor of three for every level added.
	//
	// Which is why the ceiling is not a wall-clock race between two
	// implementations that both work: it separates a walk over what is there —
	// microseconds, whatever the machine — from one that answers in seconds here
	// and not at all a few levels deeper. It is written as a time only because
	// there is nothing else for a walk of the wrong shape to fail on, and the
	// depth is chosen so that such a walk still FINISHES and reports rather than
	// hanging the suite.
	describe("walking a Type that shares its parts", () => {
		function shared(levels: number, leaf: Type): Type {
			let type = leaf

			for (let level = 0; level < levels; level++) {
				let inner = type

				type = {
					type: "UnionType",
					types: [
						{ type: "List", itemType: inner },
						{
							type: "Record",
							members: { left: inner, right: inner },
						},
					],
				}
			}

			return type
		}

		it("answers about one no larger than it is held", () => {
			let deep = shared(16, { type: "Integer" })
			let asked: Array<(type: Type) => boolean> = [
				mentionsUnsolvedTypeParameter,
				typeContainsError,
				(type) => typeMentionsGeneric(type, "Value"),
			]

			for (let ask of asked) {
				let start = performance.now()

				expect(ask(deep)).toBe(false)
				expect(performance.now() - start).toBeLessThan(500)
			}
		}, 30000)

		it("still finds what is buried in the shared part", () => {
			let error: ErrorType = { type: "Error" }
			let generic: GenericUse = { type: "GenericUse", name: "Value" }

			expect(typeContainsError(shared(8, error))).toBe(true)
			expect(typeMentionsGeneric(shared(8, generic), "Value")).toBe(true)
			expect(typeMentionsGeneric(shared(8, generic), "Other")).toBe(false)
		})
	})

	// NOTE: `buildUnion` used to answer with a canonical, Optional-SHAPED form:
	// `Nothing` was hoisted to a single top-level member and everything else
	// folded into one payload member beside it, so `Integer | Rational |
	// Nothing` came out as `(Integer | Rational) | Nothing` and even an applied
	// `Optional<Rational>` gave up its own spelling to merge that way. All of
	// it existed so that a Union's SHAPE could mean "fallible" — a Generic
	// bound over `T | Nothing` could then take the payload in one piece. A
	// nominal `Optional` says fallible by NAME, so the canonical form went with
	// `Nothing`, and these pin what is promised in its place: dedupe by
	// subsumption, flatten ANONYMOUS nested Unions, keep NAMED and applied
	// Alias ones whole, and hand a lone survivor back unwrapped.
	describe("buildUnion", () => {
		const integer: Type = { type: "Integer" }
		const rational: Type = { type: "Rational" }
		const string: Type = { type: "String" }
		const boolean: Type = { type: "Boolean" }

		const number: UnionType = {
			type: "UnionType",
			name: "Number",
			types: [integer, rational],
		}

		it("should keep distinct members side by side in the order given", () => {
			expect(buildUnion([integer, rational, string])).toEqual({
				type: "UnionType",
				types: [integer, rational, string],
			})
		})

		it("should drop a member the Union already holds", () => {
			expect(buildUnion([integer, string, integer])).toEqual({
				type: "UnionType",
				types: [integer, string],
			})
		})

		it("should hand a lone survivor back unwrapped", () => {
			expect(buildUnion([integer])).toEqual(integer)
			expect(buildUnion([integer, integer])).toEqual(integer)
		})

		it("should collapse a subsumed member into its named superset", () => {
			expect(buildUnion([integer, number, string])).toEqual({
				type: "UnionType",
				types: [number, string],
			})
		})

		it("should flatten an anonymous nested Union", () => {
			expect(
				buildUnion([
					{
						type: "UnionType",
						types: [
							{ type: "UnionType", types: [integer, rational] },
							boolean,
						],
					},
					string,
				]),
			).toEqual({
				type: "UnionType",
				types: [integer, rational, boolean, string],
			})
		})

		// NOTE: A named Union's name IS its spelling — flattening `Number` into
		// `Integer | Rational` here would cost every Hover and Diagnostic
		// downstream the word `Number`. Assignability is unaffected either way,
		// which is exactly why the display side gets to decide.
		it("should keep a named nested Union whole", () => {
			expect(buildUnion([number, string])).toEqual({
				type: "UnionType",
				types: [number, string],
			})
		})

		// NOTE: The shape the Enricher produces for an applied generic Type
		// Alias over a Union — `type Labelled<ItemType> = ItemType | String`
		// written `Labelled<Rational>` — the members with the applied spelling
		// carried alongside, which is what makes Hovers and Diagnostics print
		// `Labelled<Rational>` rather than `Rational | String`.
		const labelledOf = (itemType: Type): UnionType => ({
			type: "UnionType",
			types: [itemType, string],
			alias: { name: "Labelled", typeArguments: [itemType] },
		})

		it("should keep a lone applied Alias as written", () => {
			const labelledRational = labelledOf(rational)

			// NOTE: `String` says nothing the Alias does not already hold, so
			// it collapses into it — and what comes back is that very Union,
			// applied spelling and all, not an equal one rebuilt without it.
			expect(buildUnion([labelledRational, string])).toBe(
				labelledRational,
			)
		})

		it("should keep an applied Alias whole beside other members", () => {
			const labelledRational = labelledOf(rational)

			expect(buildUnion([labelledRational, integer])).toEqual({
				type: "UnionType",
				types: [labelledRational, integer],
			})
		})

		// NOTE: The Unknown item Type an empty List Literal carries is a
		// wildcard in BOTH directions — `List<Unknown>` accepts `List<Integer>`
		// and is accepted by it — so the two subsume one another and whichever
		// was collected FIRST used to survive. That made `[[], [1]]` infer
		// `List<List<Unknown>>`, a Type that fits EVERY List Type: the
		// annotation `List<List<String>>` was accepted for a List of Integers,
		// while the same Literal spelled `[[1], []]` was rejected.
		it("should keep the concrete member beside an empty List's placeholder", () => {
			const listOfUnknown: ListType = {
				type: "List",
				itemType: { type: "Unknown" },
			}
			const listOfInteger: ListType = { type: "List", itemType: integer }

			expect(buildUnion([listOfUnknown, listOfInteger])).toEqual(
				listOfInteger,
			)
			expect(buildUnion([listOfInteger, listOfUnknown])).toEqual(
				listOfInteger,
			)
		})

		// NOTE: Losing the Union costs the placeholder nothing — an empty List
		// Literal is still assignable to every List Type, which is the whole
		// reason Unknown is a wildcard to begin with.
		it("should leave an empty List Literal assignable everywhere", () => {
			const listOfUnknown: ListType = {
				type: "List",
				itemType: { type: "Unknown" },
			}

			expect(
				matchesType(
					{ type: "List", itemType: { type: "String" } },
					listOfUnknown,
				),
			).toBe(true)
			expect(buildUnion([listOfUnknown, listOfUnknown])).toEqual(
				listOfUnknown,
			)
		})
	})

	// NOTE: A Generic member of an expected Union used to have one inference
	// rule beyond the ordinary ones. `matchUnionRemainder` let it bind
	// EVERYTHING the concrete expected members had not claimed, so an actual
	// `MaybeInt | Rational` — `MaybeInt` a named Alias for `Integer | Nothing`
	// — matched an expected `ItemType | Nothing` by handing the buried
	// `Nothing` to the concrete member and binding
	// `ItemType := Integer | Rational` from what was left over. It was written
	// for exactly one call, `otherwise` on such a receiver, and it went with
	// `Nothing` itself. What remains is the plain rule these pin: every actual
	// member has to be taken by ONE expected member, and a Generic takes the
	// whole member it binds to — which still binds a compound payload in one
	// piece, as long as that payload is written as one member.
	describe("matchesTypeWithBindings against a Union actual", () => {
		const integer: Type = { type: "Integer" }
		const rational: Type = { type: "Rational" }
		const string: Type = { type: "String" }

		function itemTypeContext() {
			return createInferenceContext([
				{ name: "ItemType", infer: true, defaultType: null },
			])
		}

		const itemTypeOrString: UnionType = {
			type: "UnionType",
			types: [{ type: "GenericUse", name: "ItemType" }, string],
		}

		it("should bind a Generic to a nested Union member in one piece", () => {
			const context = itemTypeContext()

			expect(
				matchesTypeWithBindings(
					itemTypeOrString,
					{
						type: "UnionType",
						types: [
							{ type: "UnionType", types: [integer, rational] },
							string,
						],
					},
					context,
				),
			).toBe(true)

			expect(context.bindings.get("ItemType")).toEqual({
				type: "UnionType",
				types: [integer, rational],
			})
		})

		// NOTE: The direct counterpart of the deleted remainder rule. `Integer`
		// binds `ItemType`, `Rational` then finds no expected member left that
		// will take it, and the match fails — where the remainder rule would
		// have collected both into `ItemType := Integer | Rational`. Written as
		// ONE nested member, the very same pair still binds; see above.
		it("should not spread a Generic over every member no concrete member took", () => {
			expect(
				matchesTypeWithBindings(
					itemTypeOrString,
					{ type: "UnionType", types: [integer, rational] },
					itemTypeContext(),
				),
			).toBe(false)
		})

		it("should not rebind a Generic that is already bound", () => {
			const context = itemTypeContext()
			context.bindings.set("ItemType", integer)

			expect(
				matchesTypeWithBindings(
					itemTypeOrString,
					{ type: "UnionType", types: [rational, string] },
					context,
				),
			).toBe(false)
			expect(context.bindings.get("ItemType")).toEqual(integer)

			// NOTE: The binding is CHECKED against later occurrences, never
			// replaced by them — an actual the bound `Integer` does cover still
			// matches, and still through that same `Integer`.
			expect(
				matchesTypeWithBindings(
					itemTypeOrString,
					{ type: "UnionType", types: [integer, string] },
					context,
				),
			).toBe(true)
			expect(context.bindings.get("ItemType")).toEqual(integer)
		})
	})

	// NOTE: What a checked refinement IS, away from assignability — the
	// canonical key its conjuncts are compared and stored by, and the four Type
	// walks that have to see through one. Assignability itself is pinned in
	// `typeMatching.spec.ts`, where the direction is the subject.
	describe("Checked refinements", () => {
		const integer: Type = { type: "Integer" }
		const string: Type = { type: "String" }

		function conjunct(
			methodName: string,
			args: Array<string | boolean> = [],
			overloadIndex: number | null = null,
			namespaceName: string = "Integer",
		) {
			return { namespaceName, methodName, overloadIndex, args }
		}

		const isNotZero = conjunct("isNot", ["0"])

		function refinementOf(base: Type, name = "NonZeroInteger"): Type {
			return { type: "Refinement", name, base, conjuncts: [isNotZero] }
		}

		const nonZero = refinementOf(integer)

		describe("predicateConjunctKey", () => {
			it("should give one question one key", () => {
				expect(predicateConjunctKey(isNotZero)).toBe(
					predicateConjunctKey(conjunct("isNot", ["0"])),
				)
			})

			it("should tell the Namespace, the Method and the Overload apart", () => {
				let keys = new Set(
					[
						isNotZero,
						conjunct("is", ["0"]),
						conjunct("isNot", ["1"]),
						conjunct("isNot", ["0"], 2),
						conjunct("isNot", ["0"], null, "Number"),
					].map(predicateConjunctKey),
				)

				expect(keys.size).toBe(5)
			})

			// NOTE: Two predicates that spelled one key between them would
			// silently accept each other's evidence, so nothing a Program can
			// write may reach across a separator: an Argument is JSON rather
			// than joined, and the Overload is told apart by a colon, which is a
			// Symbol and so unspellable inside a name — where `$` is an ordinary
			// Identifier character.
			it("should not let anything spell another conjunct's key", () => {
				expect(predicateConjunctKey(conjunct("is", ["a,b"]))).not.toBe(
					predicateConjunctKey(conjunct("is", ["a", "b"])),
				)
				expect(predicateConjunctKey(conjunct("is", ["true"]))).not.toBe(
					predicateConjunctKey(conjunct("is", [true])),
				)
				expect(predicateConjunctKey(conjunct("isNot$1"))).not.toBe(
					predicateConjunctKey(conjunct("isNot", [], 1)),
				)
			})
		})

		describe("canonicalPredicateConjuncts", () => {
			it("should sort by key and drop what is asked twice", () => {
				let canonical = canonicalPredicateConjuncts([
					conjunct("isPositive"),
					isNotZero,
					conjunct("isNot", ["0"]),
				])

				expect(canonical.map((entry) => entry.methodName)).toEqual([
					"isNot",
					"isPositive",
				])
			})

			it("should give one predicate one canonical form, however it was written", () => {
				let one = canonicalPredicateConjuncts([
					isNotZero,
					conjunct("isPositive"),
				])
				let other = canonicalPredicateConjuncts([
					conjunct("isPositive"),
					isNotZero,
				])

				expect(one).toEqual(other)
			})
		})

		describe("Type walks", () => {
			it("should describe a refinement under its alias name", () => {
				expect(describeType(nonZero)).toBe("NonZeroInteger")
			})

			// NOTE: Only the base can hold a Type Parameter — a conjunct is a
			// key over literals — and the substitution is identity preserving,
			// which is what keeps `matchesType`'s `lhs === rhs` fast path.
			it("should substitute Generics inside the base", () => {
				let refined = refinementOf({
					type: "List",
					itemType: { type: "GenericUse", name: "ItemType" },
				})

				expect(
					applyGenericBindings(
						refined,
						new Map([["ItemType", integer]]),
					),
				).toEqual(refinementOf({ type: "List", itemType: integer }))
				expect(applyGenericBindings(nonZero, new Map())).toBe(nonZero)
			})

			it("should read an undecided slot through the base", () => {
				expect(
					typeContainsUnknown(
						refinementOf({
							type: "List",
							itemType: { type: "Unknown" },
						}),
					),
				).toBe(true)
				expect(typeContainsUnknown(nonZero)).toBe(false)
			})

			it("should find a refinement buried anywhere in a Type", () => {
				expect(typeContainsRefinement(nonZero)).toBe(true)
				expect(
					typeContainsRefinement({
						type: "List",
						itemType: nonZero,
					}),
				).toBe(true)
				expect(
					typeContainsRefinement({
						type: "Record",
						members: { count: nonZero },
					}),
				).toBe(true)
				expect(
					typeContainsRefinement({
						type: "UnionType",
						types: [string, nonZero],
					}),
				).toBe(true)
				expect(
					typeContainsRefinement({
						type: "List",
						itemType: integer,
					}),
				).toBe(false)
			})
		})

		// NOTE: Refinements do not survive into the emitted Program, and this is
		// where they go. What is asserted is completeness — a refinement nested
		// anywhere in a Type, and a Type hanging anywhere off a Node — plus the
		// identity preservation the caches around the standard library's
		// simplified Program rest on.
		describe("eraseRefinements", () => {
			it("should replace a refinement with what it refines", () => {
				expect(eraseRefinements(nonZero)).toEqual(integer)
			})

			it("should erase one nested anywhere in a Type", () => {
				expect(
					eraseRefinements({ type: "List", itemType: nonZero }),
				).toEqual({ type: "List", itemType: integer })
				expect(
					eraseRefinements({
						type: "Record",
						members: { count: nonZero, label: string },
					}),
				).toEqual({
					type: "Record",
					members: { count: integer, label: string },
				})
				expect(
					eraseRefinements({
						type: "Function",
						parameterTypes: [{ name: "by", type: nonZero }],
						generics: [],
						returnType: nonZero,
					}),
				).toEqual({
					type: "Function",
					parameterTypes: [{ name: "by", type: integer }],
					generics: [],
					returnType: integer,
				})
			})

			// NOTE: A refinement over a refinement is not something a Program can
			// write, but the walk answers it anyway — an eraser that erased one
			// layer would be a walk that stops where it happened to be called.
			it("should erase every layer of one", () => {
				expect(
					eraseRefinements({
						type: "Refinement",
						name: "PositiveNonZeroInteger",
						base: nonZero,
						conjuncts: [conjunct("isPositive")],
					}),
				).toEqual(integer)
			})

			it("should hand back a Type carrying none as itself", () => {
				let plain: Type = { type: "List", itemType: integer }

				expect(eraseRefinements(plain)).toBe(plain)
			})

			// NOTE: Every field of every Node, which is what a reflective walk
			// buys and a hand written one has to remember: a Constant's declared
			// Type, the Type its value carries, a Match Handler's Matcher — and
			// the same one field in a Node kind nobody has written yet.
			it("should erase every Type hanging off a Program", () => {
				let value: common.typedSimple.ExpressionNode = {
					nodeType: "IntegerValue",
					value: "3",
					type: { type: "Integer" },
				}

				let program: common.typedSimple.Program = {
					nodeType: "Program",
					imports: null,
					exports: null,
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "VariableDeclarationStatement",
								name: {
									nodeType: "Identifier",
									name: "divisor",
									type: nonZero,
								},
								value,
								type: nonZero,
								isConstant: true,
							},
							{
								nodeType: "Match",
								value,
								handlers: [
									{
										matcher: nonZero,
										typeTest: null,
										literal: null,
										memberLiterals: null,
										guard: null,
										body: [],
									},
								],
								finalHandlerIsElse: false,
								type: { type: "List", itemType: nonZero },
							},
						],
					},
				}

				let erased = eraseRefinements(program)
				let [declaration, match] = erased.implementation.nodes

				if (
					declaration?.nodeType !== "VariableDeclarationStatement" ||
					match?.nodeType !== "Match"
				) {
					throw new Error("The erasure rebuilt the wrong Nodes.")
				}

				expect(declaration.type).toEqual(integer)
				expect(declaration.name.type).toEqual(integer)
				expect(match.handlers[0].matcher).toEqual(integer)
				expect(match.type).toEqual({
					type: "List",
					itemType: integer,
				})
			})

			it("should hand back a Program carrying none as itself", () => {
				let program: common.typedSimple.Program = {
					nodeType: "Program",
					imports: null,
					exports: null,
					implementation: {
						nodeType: "ImplementationSection",
						nodes: [
							{
								nodeType: "IntegerValue",
								value: "1",
								type: { type: "Integer" },
							},
						],
					},
				}

				expect(eraseRefinements(program)).toBe(program)
			})
		})
	})
})
