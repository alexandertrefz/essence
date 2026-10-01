import { describe, expect, it } from "bun:test"

import type { common } from "@essence-lang/interfaces"
import { lexer } from "@essence-lang/interfaces"
import type {
	DictionaryType,
	ErrorType,
	FunctionType,
	GenericUse,
	ListType,
	MethodType,
	NamespaceType,
	OverloadedMethodType,
	OverloadedStaticMethodType,
	PredicateConjunct,
	PrimitiveType,
	ProtocolType,
	RecordType,
	RefinementType,
	StaticMethodType,
	Type,
	UnionType,
	UnknownType,
} from "@essence-lang/interfaces/common"

import {
	computeConformanceMethodMap,
	conformanceKey,
} from "../helpers/conformance"
import { recordDefaultNesting } from "../helpers/defaults"
import {
	describeRecordShape,
	describeType,
	displayProtocolName,
	protocolIdentity,
} from "../helpers/describe"
import { eraseRefinements } from "../helpers/eraseRefinements"
import { stripPosition, stripPositionFromArray } from "../helpers/nodes"
import { closestMatch } from "../helpers/suggest"
import {
	applyGenericBindings,
	bindNamespaceTarget,
	buildUnion,
	canonicalPredicateConjuncts,
	closePendingRefinementCopies,
	createInferenceContext,
	isPartialOf,
	matchArguments,
	matchesType,
	matchesTypeWithBindings,
	mentionsUnsolvedTypeParameter,
	NotHoistedYet,
	openPendingRefinementCopies,
	pendingRefinementCopiesOf,
	predicateConjunctKey,
	provenConjuncts,
	refinementWithTypeArguments,
	renamedNamespaceTarget,
	resolveOverloadedMethodName,
	resolveUnknownSlots,
	typeContainsError,
	typeContainsRefinement,
	typeContainsUnknown,
	typeMentionsGeneric,
	withoutRecordNames,
} from "../helpers/types"

const TokenType = lexer.TokenType
type Token = lexer.Token
type SimpleToken = lexer.SimpleToken

describe("Helpers", () => {
	describe("stripPosition", () => {
		it("should strip position", () => {
			let input: Token = {
				value: "",
				type: TokenType.LiteralString,
				position: {
					start: { line: 0, column: 0 },
					end: { line: 0, column: 0 },
				},
				start: 0,
				end: 0,
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
					start: 0,
					end: 0,
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

	// A Function, a Method and a static Method are one kind of value, so each
	// describes as the signature a Type Annotation would spell.
	describe("describeType", () => {
		// A Record Alias prints under its name, as a Union Alias does.
		// `describeRecordShape` spells the members where a report needs them.
		it("should print a Record under its Alias's name", () => {
			expect(
				describeType({
					type: "Record",
					name: "Standing",
					members: { points: { type: "Integer" } },
				}),
			).toBe("Standing")
			expect(
				describeType({
					type: "Record",
					alias: {
						name: "Pair",
						typeArguments: [{ type: "Integer" }],
					},
					members: { first: { type: "Integer" } },
				}),
			).toBe("Pair<Integer>")
		})

		it("should spell a Record nobody named", () => {
			expect(
				describeType({
					type: "Record",
					members: { points: { type: "Integer" } },
				}),
			).toBe("{ points: Integer }")
			expect(describeType({ type: "Record", members: {} })).toBe("{}")
		})

		it("should spell the members of a named one where asked", () => {
			expect(
				describeRecordShape({
					type: "Record",
					name: "Standing",
					members: { points: { type: "Integer" } },
				}),
			).toBe("{ points: Integer }")
		})

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

		// A Method read as a value takes its receiver as its first Parameter.
		// So it does not fit a Function of one Argument fewer.
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

		// An Overload set has no single signature, so it keeps the bare word.
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

		const unknownList: ListType = {
			type: "List",
			itemType: { type: "Unknown" },
		}

		const stringList: ListType = {
			type: "List",
			itemType: { type: "String" },
		}

		const integerList: ListType = {
			type: "List",
			itemType: { type: "Integer" },
		}

		const listOfUnknownLists: ListType = {
			type: "List",
			itemType: unknownList,
		}

		const listOfStringLists: ListType = {
			type: "List",
			itemType: stringList,
		}

		const errorList: ListType = {
			type: "List",
			itemType: { type: "Error" },
		}

		const listOfErrorLists: ListType = {
			type: "List",
			itemType: errorList,
		}

		const errorValueDictionary: DictionaryType = {
			type: "Dictionary",
			keyType: { type: "String" },
			valueType: { type: "Error" },
		}

		const undecidedDictionary: DictionaryType = {
			type: "Dictionary",
			keyType: { type: "Unknown" },
			valueType: { type: "Unknown" },
		}

		const undecidedKeyDictionary: DictionaryType = {
			type: "Dictionary",
			keyType: { type: "Unknown" },
			valueType: { type: "Integer" },
		}

		const undecidedValueDictionary: DictionaryType = {
			type: "Dictionary",
			keyType: { type: "String" },
			valueType: { type: "Unknown" },
		}

		const stringToIntegerDictionary: DictionaryType = {
			type: "Dictionary",
			keyType: { type: "String" },
			valueType: { type: "Integer" },
		}

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

			// An `Unknown` as the whole expected Type accepts everything, a
			// decided container included. An undecided slot follows its own rule.
			expect(matchesType(unknown, unknownList)).toBe(true)
			expect(matchesType(unknown, stringList)).toBe(true)
			expect(matchesType(unknown, integerList)).toBe(true)
			expect(matchesType(unknown, stringToIntegerDictionary)).toBe(true)

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

		it("should match matching ListTypes", () => {
			expect(matchesType(stringList, stringList)).toBe(true)
			expect(matchesType(integerList, integerList)).toBe(true)
		})

		it("should not match mismatched ListTypes", () => {
			expect(matchesType(stringList, integerList)).toBe(false)
			expect(matchesType(integerList, stringList)).toBe(false)
		})

		// An undecided item Type reads as bottom, so an empty List Literal fits
		// every List. A write into it must decide it, or the slot would keep
		// fitting every List. See "Undecided slots" in
		// packages/compiler/src/enricher/DEVELOPMENT.md.
		it("should read an undecided item Type as bottom", () => {
			expect(matchesType(stringList, unknownList)).toBe(true)
			expect(matchesType(integerList, unknownList)).toBe(true)
			expect(matchesType(unknownList, unknownList)).toBe(true)
		})

		it("should refuse a write into an undecided item Type", () => {
			expect(matchesType(unknownList, stringList)).toBe(false)
			expect(matchesType(unknownList, integerList)).toBe(false)
		})

		// A slot can hide at any depth: `[[]]` decides its outer item Type but
		// leaves the inner one open.
		it("should refuse a write into an undecided item Type nested in one", () => {
			expect(matchesType(listOfStringLists, listOfUnknownLists)).toBe(
				true,
			)
			expect(matchesType(listOfUnknownLists, listOfStringLists)).toBe(
				false,
			)
		})

		// An Error was reported where it came from, so writing one into a slot
		// is not refused again. `resolveUnknownSlots` likewise pins no slot to one.
		it("should not refuse a write of an Error into an undecided slot", () => {
			expect(matchesType(unknownList, errorList)).toBe(true)
			expect(matchesType(listOfUnknownLists, listOfErrorLists)).toBe(true)
			expect(
				matchesType(undecidedValueDictionary, errorValueDictionary),
			).toBe(true)
		})

		// An Error excuses only its own slot, so the String keys of
		// `Dictionary<String, Error>` are still a write the undecided ones refuse.
		it("should refuse a decided slot beside one holding an Error", () => {
			expect(matchesType(undecidedDictionary, errorValueDictionary)).toBe(
				false,
			)
		})

		// The same rule per slot. `[=]` decides neither slot, and a Dictionary
		// half-decided is still refused over the open slot.
		it("should read an undecided Dictionary slot as bottom", () => {
			expect(
				matchesType(stringToIntegerDictionary, undecidedDictionary),
			).toBe(true)
			expect(
				matchesType(stringToIntegerDictionary, undecidedKeyDictionary),
			).toBe(true)
			expect(
				matchesType(
					stringToIntegerDictionary,
					undecidedValueDictionary,
				),
			).toBe(true)
			expect(matchesType(undecidedDictionary, undecidedDictionary)).toBe(
				true,
			)
		})

		it("should refuse a write into an undecided Dictionary slot", () => {
			expect(
				matchesType(undecidedDictionary, stringToIntegerDictionary),
			).toBe(false)
			expect(
				matchesType(undecidedKeyDictionary, stringToIntegerDictionary),
			).toBe(false)
			expect(
				matchesType(
					undecidedValueDictionary,
					stringToIntegerDictionary,
				),
			).toBe(false)
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
			expect(
				matchesType(integerList, noArgumentOverloadedStaticMethodType),
			).toBe(false)
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

			// An opaque Generic accepts only itself, but a Union holding it as a
			// member accepts it, since the member is the same symbol.
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

		// The `hasDefault` rule one level down. A call against the expected Type
		// may leave those members out, so the actual's default must fill them in.
		describe("Omittable Record members", () => {
			const options: RecordType = {
				type: "Record",
				members: { host: stringPrimitive, retries: integerPrimitive },
			}

			function taking(defaultMembers?: Array<string>): FunctionType {
				return {
					type: "Function",
					generics: [],
					parameterTypes: [
						{
							name: "using",
							type: options,
							...(defaultMembers === undefined
								? {}
								: { defaultMembers }),
						},
					],
					returnType: { type: "String" },
				}
			}

			it("should refuse an actual that fills in fewer members", () => {
				expect(
					matchesType(taking(["host", "retries"]), taking(["host"])),
				).toBe(false)
				expect(matchesType(taking(["host"]), taking())).toBe(false)
			})

			it("should accept an actual that fills in more", () => {
				expect(
					matchesType(taking(["host"]), taking(["host", "retries"])),
				).toBe(true)
				expect(matchesType(taking(), taking(["host"]))).toBe(true)
			})

			it("should accept two signatures that agree", () => {
				expect(matchesType(taking(["host"]), taking(["host"]))).toBe(
					true,
				)
				expect(matchesType(taking(), taking())).toBe(true)
			})
		})
	})

	// What a `with` right-hand side or a partial Argument must be. Neither
	// direction of `matchesType` asks it: one wants every member, and the
	// other compares the member Types the wrong way round.
	describe("isPartialOf", () => {
		const integer: Type = { type: "Integer" }
		const string: Type = { type: "String" }

		const point: RecordType = {
			type: "Record",
			members: { x: integer, y: integer },
		}

		it("accepts a subset of the members", () => {
			expect(
				isPartialOf(point, { type: "Record", members: { x: integer } }),
			).toBe(true)
		})

		it("accepts the whole itself, and the empty Record", () => {
			expect(isPartialOf(point, point)).toBe(true)
			expect(isPartialOf(point, { type: "Record", members: {} })).toBe(
				true,
			)
		})

		it("refuses a member the whole does not declare", () => {
			expect(
				isPartialOf(point, { type: "Record", members: { z: integer } }),
			).toBe(false)
		})

		it("refuses a member the whole declares at another Type", () => {
			expect(
				isPartialOf(point, { type: "Record", members: { x: string } }),
			).toBe(false)
		})

		// Members compare by assignability, so one arm of a Union-typed member
		// is admitted.
		it("admits one arm of a Union-typed member", () => {
			const held: RecordType = {
				type: "Record",
				members: {
					value: { type: "UnionType", types: [integer, string] },
				},
			}

			expect(
				isPartialOf(held, {
					type: "Record",
					members: { value: integer },
				}),
			).toBe(true)
		})

		// A member named after one of `Object.prototype`'s must not read a
		// JavaScript function instead.
		it("refuses a member named after one of Object.prototype's", () => {
			expect(
				isPartialOf(point, {
					type: "Record",
					members: { toString: string },
				}),
			).toBe(false)
		})

		// A caller still inferring may ask, so a bindable Generic binds off the
		// member it is compared with.
		it("binds a Generic through a member comparison", () => {
			let context = createInferenceContext([
				{ name: "T", infer: true, defaultType: null },
			])

			expect(
				isPartialOf(
					{
						type: "Record",
						members: { value: { type: "GenericUse", name: "T" } },
					},
					{ type: "Record", members: { value: integer } },
					context,
				),
			).toBe(true)

			expect(context.bindings.get("T")).toEqual(integer)
		})
	})

	describe("recordDefaultNesting", () => {
		const integer: Type = { type: "Integer" }
		const string: Type = { type: "String" }

		const tls: RecordType = {
			type: "Record",
			members: { enabled: { type: "Boolean" } },
		}

		const server: RecordType = {
			type: "Record",
			members: { host: string, port: integer, tls },
		}

		const options: RecordType = {
			type: "Record",
			members: { retries: integer, server },
		}

		// The Parser's shape, with each member's value under `value`, which the
		// Resolver asks about.
		function written(members: Record<string, unknown>) {
			return {
				nodeType: "RecordValue",
				members: Object.fromEntries(
					Object.entries(members).map(([name, value]) => [
						name,
						{ value },
					]),
				),
			}
		}

		function literal(members: Record<string, unknown>) {
			return { nodeType: "RecordValue", members }
		}

		const wholeServer = written({
			host: literal({}),
			port: literal({}),
			tls: written({ enabled: literal({}) }),
		})

		it("answers nothing for a default that is not a Record Literal", () => {
			expect(
				recordDefaultNesting(options, { nodeType: "Identifier" }),
			).toBe(null)
			expect(recordDefaultNesting(options, null)).toBe(null)
			expect(recordDefaultNesting(integer, written({}))).toBe(null)
		})

		it("names a member written as a whole Record Literal", () => {
			expect(
				recordDefaultNesting(
					options,
					written({ retries: literal({}), server: wholeServer }),
				),
			).toEqual({ server: { tls: {} } })
		})

		it("leaves out a member the default does not write", () => {
			expect(
				recordDefaultNesting(
					options,
					written({ retries: literal({}) }),
				),
			).toEqual({})
		})

		it("leaves out a member written as anything but a Literal", () => {
			expect(
				recordDefaultNesting(
					options,
					written({ server: { nodeType: "Identifier" } }),
				),
			).toEqual({})
		})

		// Only a default's top level may be partial. A nested Literal that
		// writes less would leave members missing from what the callee rebuilds.
		it("leaves out a nested Literal that writes less than its Type", () => {
			expect(
				recordDefaultNesting(
					options,
					written({ server: written({ host: literal({}) }) }),
				),
			).toEqual({})
		})

		// The typed Literal, whose members are their values, as the Simplifier
		// hands it.
		it("reads the typed Literal the Simplifier hands it", () => {
			expect(
				recordDefaultNesting(
					options,
					literal({
						retries: literal({}),
						server: literal({
							host: literal({}),
							port: literal({}),
							tls: literal({ enabled: literal({}) }),
						}),
					}),
				),
			).toEqual({ server: { tls: {} } })
		})

		it("refuses a member named after one of Object.prototype's", () => {
			expect(
				recordDefaultNesting(
					{ type: "Record", members: { toString: server } },
					literal({}),
				),
			).toEqual({})
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

			// A Method forwarding to one whose Generic shares its name matches a
			// bindable `T` against an opaque `T`. Generic identity is by name, so
			// the bindable side must record the binding rather than pass by name.
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

			// `isNot(_ other: List<ItemType>)` matches the same Generic again for
			// `other`, verifying a binding to the same opaque use. The check must
			// stop there, or this spec hangs.
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

			// Concrete members are tried first, so the Generic binds only what
			// none of them claimed, and `Value` is not bound to `String`.
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

			// The first member binds `T := String` off `left` and then fails on
			// `right`. That binding is rolled back, so the second member binds
			// `T := Integer`.
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

		// `bindNamespaceTarget` renames a Namespace's Generics before matching.
		// The rename depends on the pattern alone, so it is done once per pattern
		// rather than per call. No answer shows that, so the spec checks the
		// remembered pattern's identity.
		describe("bindNamespaceTarget", () => {
			const item: GenericUse = { type: "GenericUse", name: "Item" }

			function pairing(): {
				targetType: Type
				generics: Array<common.GenericDeclaration>
			} {
				return {
					targetType: {
						type: "Record",
						members: { left: item, right: item },
					},
					generics: [
						{ name: "Item", infer: true, defaultType: null },
					],
				}
			}

			function pairOf(left: Type, right: Type): Type {
				return { type: "Record", members: { left, right } }
			}

			it("should rename a Namespace's Generics once, however many receivers ask", () => {
				let pattern = pairing()
				let first = renamedNamespaceTarget(
					pattern.targetType,
					pattern.generics,
				)

				expect(
					renamedNamespaceTarget(
						pattern.targetType,
						pattern.generics,
					),
				).toBe(first)

				// Asked through `bindNamespaceTarget` once per receiver, as the
				// Enricher asks.
				bindNamespaceTarget(pattern, pairOf(integer, integer))
				bindNamespaceTarget(pattern, pairOf(string, string))

				expect(
					renamedNamespaceTarget(
						pattern.targetType,
						pattern.generics,
					),
				).toBe(first)
			})

			it("should rename again for other Generics over the same target", () => {
				let pattern = pairing()
				let first = renamedNamespaceTarget(
					pattern.targetType,
					pattern.generics,
				)
				let second = renamedNamespaceTarget(pattern.targetType, [
					{ name: "Item", infer: true, defaultType: string },
				])

				expect(second).not.toBe(first)
				expect(second.generics[0]!.defaultType).toEqual(string)
			})

			it("should answer in the Namespace's own names for every receiver", () => {
				let pattern = pairing()

				expect(
					bindNamespaceTarget(pattern, pairOf(integer, integer)),
				).toEqual(new Map([["Item", integer]]))
				expect(
					bindNamespaceTarget(pattern, pairOf(string, string)),
				).toEqual(new Map([["Item", string]]))
				expect(
					bindNamespaceTarget(pattern, pairOf(integer, string)),
				).toBe(null)
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
				).toEqual({ type: "Match", omittedParameterIndices: [] })
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
					parameterForArgument: [0, 1],
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

				// A fresh context is a fresh candidate, with no String binding.
				expect(
					matchArguments(
						parameters,
						[
							{ name: null, getType: () => integer },
							{ name: null, getType: () => integer },
						],
						{ inference: inferContextFor(["T"]) },
					),
				).toEqual({ type: "Match", omittedParameterIndices: [] })
			})

			// A callback Parameter waiting on an unbound Generic is matched last.
			// The Argument here echoes the expected Type back, as an unannotated
			// literal does, so matched early it would pin `T` to itself.
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
					).toEqual({ type: "Match", omittedParameterIndices: [] })

					expect(context.bindings.get("T")).toEqual(integer)
					// The literal is resolved against the signature with the
					// binding substituted in.
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
						parameterForArgument: [0, 1],
					})
				})
			})
		})
	})

	// An Argument may write some members and leave the rest to the Record
	// default. It is still paired by label and still required, and it must
	// write every member the default does not fill in.
	describe("matchArguments against a partial default", () => {
		const options: RecordType = {
			type: "Record",
			members: {
				host: { type: "String" },
				retries: { type: "Integer" },
			},
		}

		const parameters: Array<common.Parameter> = [
			{ name: "using", type: options, defaultMembers: ["retries"] },
		]

		function record(members: RecordType["members"]): RecordType {
			return { type: "Record", members }
		}

		function matching(argumentType: Type, spellsItsMembers = true) {
			return matchArguments(parameters, [
				{
					name: "using",
					getType: () => argumentType,
					spellsItsMembers,
				},
			])
		}

		it("should admit an Argument writing what the default leaves out", () => {
			expect(matching(record({ host: { type: "String" } }))).toEqual({
				type: "Match",
				omittedParameterIndices: [],
			})
		})

		it("should admit a whole Argument, exactly as before", () => {
			expect(matching(options)).toEqual({
				type: "Match",
				omittedParameterIndices: [],
			})
		})

		it("should refuse an Argument missing a member the default has not", () => {
			expect(
				matching(record({ retries: { type: "Integer" } })).type,
			).toBe("ArgumentMismatch")
		})

		it("should refuse a member of the wrong Type", () => {
			expect(matching(record({ host: { type: "Integer" } })).type).toBe(
				"ArgumentMismatch",
			)
		})

		it("should refuse a member the Parameter does not declare", () => {
			expect(
				matching(
					record({
						host: { type: "String" },
						timeout: { type: "Integer" },
					}),
				).type,
			).toBe("ArgumentMismatch")
		})

		// A partial default leaves `hasDefault` unset, so `pairArguments` still
		// requires the Argument. That is why the Type layer carries two keys.
		it("should still require the Argument", () => {
			expect(matchArguments(parameters, []).type).toBe("ArityMismatch")
		})

		// Without a default, a partial is the wrong Type.
		it("should refuse a partial where the Parameter has no default", () => {
			expect(
				matchArguments(
					[{ name: "using", type: options }],
					[
						{
							name: "using",
							getType: () => record({ host: { type: "String" } }),
							spellsItsMembers: true,
						},
					],
				).type,
			).toBe("ArgumentMismatch")
		})

		// A value typed `{ host: String }` may carry a `retries` of any Type,
		// which the callee's default would not replace. So only a literal may be
		// a partial, while a whole Record may come from any Expression.
		it("should refuse a partial that is not written as a literal", () => {
			expect(
				matching(record({ host: { type: "String" } }), false).type,
			).toBe("ArgumentMismatch")
		})

		it("should admit a whole Argument that is not a literal", () => {
			expect(matching(options, false)).toEqual({
				type: "Match",
				omittedParameterIndices: [],
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
			identity: "Printable",
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
				providedMethods: {},
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
				providedMethods: {},
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
				identity: "Combinable",
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
				providedMethods: {},
			})
		})
	})

	// A resolved Type is a DAG, so a walk following every reference rather than
	// every object is exponential. Each level here names the next level three
	// times. The time limit separates a linear walk from an exponential one, and
	// the depth lets an exponential walk still finish and report.
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

	// The Enricher refuses a Type that names itself, so these cycles are built
	// by hand. Keying one still returns and tells two cycles apart.
	describe("conformanceKey", () => {
		function tree(): UnionType {
			let union: UnionType = {
				type: "UnionType",
				name: "Tree",
				types: [],
			}

			union.types.push({
				type: "Case",
				choice: "Tree",
				name: "Node",
				members: {
					weight: { type: "Integer" },
					children: { type: "List", itemType: union },
				},
			})

			return union
		}

		it("answers for a Type that leads back to itself", () => {
			expect(conformanceKey("Equatable", tree())).toContain("<cycle:")
		})

		it("keys two structurally identical cyclic Types alike", () => {
			expect(conformanceKey("Equatable", tree())).toBe(
				conformanceKey("Equatable", tree()),
			)
		})

		it("keys two cycles that unfold differently apart", () => {
			// Both read alike to a bare marker. The marker's distance says
			// where the back-edge returns, which tells them apart.
			let straight: RecordType = {
				type: "Record",
				members: { tag: { type: "Integer" } },
			}
			let looped: RecordType = {
				type: "Record",
				members: { tag: { type: "String" } },
			}

			straight.members["next"] = looped
			looped.members["next"] = looped

			let alternating: RecordType = {
				type: "Record",
				members: { tag: { type: "Integer" } },
			}
			let back: RecordType = {
				type: "Record",
				members: { tag: { type: "String" } },
			}

			alternating.members["next"] = back
			back.members["next"] = alternating

			expect(conformanceKey("Equatable", straight)).not.toBe(
				conformanceKey("Equatable", alternating),
			)
		})

		it("serialises a shared part fully at every reach", () => {
			// Only an object the walk is still inside is a back-edge, so a shared
			// part gets no marker.
			let leaf: Type = { type: "Integer" }
			let sharing: RecordType = {
				type: "Record",
				members: { left: leaf, right: leaf },
			}
			let separate: RecordType = {
				type: "Record",
				members: {
					left: { type: "Integer" },
					right: { type: "Integer" },
				},
			}

			let key = conformanceKey("Equatable", sharing)

			expect(key).not.toContain("<cycle:")
			expect(conformanceKey("Equatable", separate)).toBe(key)
		})
	})

	// `buildUnion` dedupes by subsumption, flattens anonymous nested Unions,
	// keeps named and applied Alias ones whole, and hands a lone survivor back
	// unwrapped.
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

		// Flattening `Number` would cost every Hover and Diagnostic the word
		// `Number`, and assignability is the same either way.
		it("should keep a named nested Union whole", () => {
			expect(buildUnion([number, string])).toEqual({
				type: "UnionType",
				types: [number, string],
			})
		})

		// An applied generic Union Alias, as the Enricher builds
		// `Labelled<Rational>`, carrying its applied spelling for display.
		const labelledOf = (itemType: Type): UnionType => ({
			type: "UnionType",
			types: [itemType, string],
			alias: { name: "Labelled", typeArguments: [itemType] },
		})

		it("should keep a lone applied Alias as written", () => {
			const labelledRational = labelledOf(rational)

			// `String` collapses into the Alias, and the very same Union comes
			// back with its spelling.
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

		// `List<Unknown>` and `List<Integer>` subsume each other, so the
		// concrete one must survive whatever the order.
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

		// An empty List Literal still fits every List Type.
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

	// Each actual member must be taken by one expected member. A Generic takes
	// the whole member it binds to, so a payload written as one member binds
	// whole.
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

		// A Generic does not collect the members no concrete member took.
		// `Integer` binds `ItemType`, `Rational` then finds no expected member
		// left that will take it, and the match fails rather than binding
		// `ItemType := Integer | Rational`. Written as one nested member, the
		// same pair binds in one piece.
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

			// Later occurrences check the binding and never replace it.
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

	// A checked refinement apart from assignability: the key its conjuncts are
	// compared by, and the Type walks that see through it. `typeMatching.spec.ts`
	// holds assignability.
	describe("Checked refinements", () => {
		const integer: Type = { type: "Integer" }
		const string: Type = { type: "String" }

		function conjunct(
			methodName: string,
			args: Array<string | boolean> = [],
			negated: boolean = false,
			namespaceName: string = "Integer",
		): PredicateConjunct {
			return { namespaceName, methodName, args, negated }
		}

		// `NonZeroInteger`'s `@::isNot(0)` is stored as `Integer::is(0)` negated.
		const isNotZero = conjunct("is", ["0"], true)

		function refinementOf(base: Type, name = "NonZeroInteger"): Type {
			return { type: "Refinement", name, base, conjuncts: [isNotZero] }
		}

		const nonZero = refinementOf(integer)

		// A fresh one per use, since a fill or a registration writes into a
		// pending refinement.
		function pendingFilled(): RefinementType {
			return {
				type: "Refinement",
				name: "Pending",
				base: {
					type: "List",
					itemType: { type: "GenericUse", name: "Item" },
				},
				conjuncts: null,
			}
		}

		// Every copy the registry holds is a refinement, so the cast is made once.
		function copyOf(
			source: RefinementType,
			bindings: Map<string, Type>,
		): RefinementType {
			return applyGenericBindings(source, bindings) as RefinementType
		}

		describe("predicateConjunctKey", () => {
			it("should give one question one key", () => {
				expect(predicateConjunctKey(isNotZero)).toBe(
					predicateConjunctKey(conjunct("is", ["0"], true)),
				)
			})

			// The written spelling is for a reader and decides nothing.
			it("should ignore how the leaf was written", () => {
				expect(
					predicateConjunctKey({
						...isNotZero,
						spelling: { methodName: "isNot", args: ["0"] },
					}),
				).toBe(
					predicateConjunctKey({
						...isNotZero,
						spelling: { methodName: "isZero", args: [] },
					}),
				)
			})

			it("should tell the Namespace, the Method, the polarity and the Arguments apart", () => {
				let keys = new Set(
					[
						isNotZero,
						conjunct("is", ["0"]),
						conjunct("is", ["1"], true),
						conjunct("isLessThan", ["0"], true),
						conjunct("is", ["0"], true, "Number"),
					].map(predicateConjunctKey),
				)

				expect(keys.size).toBe(5)
			})

			// Two predicates sharing a key would accept each other's evidence.
			// So an Argument is JSON rather than joined, and a String keeps its
			// quotes, which also tell two entries of one name apart.
			it("should not let anything spell another conjunct's key", () => {
				expect(predicateConjunctKey(conjunct("is", ["a,b"]))).not.toBe(
					predicateConjunctKey(conjunct("is", ["a", "b"])),
				)
				expect(predicateConjunctKey(conjunct("is", ["true"]))).not.toBe(
					predicateConjunctKey(conjunct("is", [true])),
				)
				expect(predicateConjunctKey(conjunct("is", ['"1"']))).not.toBe(
					predicateConjunctKey(conjunct("is", ["1"])),
				)
			})
		})

		describe("canonicalPredicateConjuncts", () => {
			it("should sort by key and drop what is asked twice", () => {
				let canonical = canonicalPredicateConjuncts([
					conjunct("isEven"),
					isNotZero,
					conjunct("is", ["0"], true),
				])

				expect(canonical.map((entry) => entry.methodName)).toEqual([
					"is",
					"isEven",
				])
			})

			it("should give one predicate one canonical form, however it was written", () => {
				let one = canonicalPredicateConjuncts([
					isNotZero,
					conjunct("isEven"),
				])
				let other = canonicalPredicateConjuncts([
					conjunct("isEven"),
					isNotZero,
				])

				expect(one).toEqual(other)
			})
		})

		describe("Type walks", () => {
			it("should describe a refinement under its alias name", () => {
				expect(describeType(nonZero)).toBe("NonZeroInteger")
			})

			// Only the base can hold a Type Parameter, since conjuncts are over
			// literals. Substitution preserves identity for `matchesType`'s fast path.
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

			// The applied spelling is substituted with the base, so a Hover shows
			// `NonEmptyList<String>`.
			it("should substitute the applied spelling alongside the base", () => {
				let refined: Type = {
					type: "Refinement",
					name: "NonEmptyList",
					base: {
						type: "List",
						itemType: { type: "GenericUse", name: "Item" },
					},
					conjuncts: [isNotZero],
					typeArguments: [{ type: "GenericUse", name: "Item" }],
				}

				expect(
					applyGenericBindings(refined, new Map([["Item", string]])),
				).toEqual({
					type: "Refinement",
					name: "NonEmptyList",
					base: { type: "List", itemType: string },
					conjuncts: [isNotZero],
					typeArguments: [string],
				})
			})

			// The fill writes conjuncts into the object the Alias registered, so an
			// unregistered copy of a pending refinement would stay pending. Outside a
			// hoist nothing could fill it, so copying throws. A pending refinement
			// holding no Type Parameter comes back as itself.
			it("should refuse to copy a pending refinement outside a hoist", () => {
				expect(() =>
					applyGenericBindings(
						pendingFilled(),
						new Map([["Item", string]]),
					),
				).toThrow("read before it resolved")

				let pending = pendingFilled()

				expect(
					applyGenericBindings(pending, new Map([["Other", string]])),
				).toBe(pending)

				let pendingScalar: Type = {
					type: "Refinement",
					name: "Pending",
					base: integer,
					conjuncts: null,
				}

				expect(
					applyGenericBindings(
						pendingScalar,
						new Map([["Item", string]]),
					),
				).toBe(pendingScalar)
			})

			// Stamping the applied spelling also copies a refinement, so it follows
			// the same rule.
			it("should hold the applied spelling to the same rule", () => {
				expect(() =>
					refinementWithTypeArguments(pendingFilled(), [string]),
				).toThrow("read before it resolved")

				let pending = pendingFilled()

				openPendingRefinementCopies()

				try {
					let stamped = refinementWithTypeArguments(pending, [string])

					expect(stamped.typeArguments).toEqual([string])
					expect(stamped.conjuncts).toBeNull()
					expect(pendingRefinementCopiesOf(pending)).toEqual([
						stamped,
					])
				} finally {
					closePendingRefinementCopies()
				}

				// A resolved refinement is stamped freely, since its conjuncts
				// travel by reference.
				let resolved = nonZero as RefinementType

				expect(
					refinementWithTypeArguments(resolved, [integer]).conjuncts,
				).toBe(resolved.conjuncts)
			})

			// Inside a hoist the copy is made and registered against its source,
			// so the fill can finish it. Refusing would deadlock the Namespace that
			// answers the predicate against the fill waiting for it.
			it("should register a pending copy while a hoist is open", () => {
				let pending = pendingFilled()

				openPendingRefinementCopies()

				try {
					let copy = copyOf(pending, new Map([["Item", string]]))

					expect(copy).not.toBe(pending)
					expect(copy).toEqual({
						type: "Refinement",
						name: "Pending",
						base: { type: "List", itemType: string },
						conjuncts: null,
					})
					expect(pendingRefinementCopiesOf(pending)).toEqual([copy])
				} finally {
					closePendingRefinementCopies()
				}
			})

			// A pending copy may be copied again where its signature is called.
			// Copies are keyed by their source, so the fill reaches every
			// generation from the Alias' own object.
			it("should reach a copy of a pending copy", () => {
				let pending = pendingFilled()

				openPendingRefinementCopies()

				try {
					let copy = copyOf(
						pending,
						new Map([
							["Item", { type: "GenericUse", name: "Other" }],
						]),
					)
					let copyOfCopy = copyOf(copy, new Map([["Other", string]]))

					expect(pendingRefinementCopiesOf(pending)).toEqual([
						copy,
						copyOfCopy,
					])
					expect(pendingRefinementCopiesOf(copy)).toEqual([
						copyOfCopy,
					])
				} finally {
					closePendingRefinementCopies()
				}
			})

			// The registry belongs to the hoist that opened it, so nothing survives
			// into the next. Hoists nest, so only the outermost close clears it.
			it("should forget its copies when the outermost hoist closes", () => {
				let pending = pendingFilled()

				openPendingRefinementCopies()
				openPendingRefinementCopies()

				let copy = copyOf(pending, new Map([["Item", string]]))

				closePendingRefinementCopies()

				expect(pendingRefinementCopiesOf(pending)).toEqual([copy])

				closePendingRefinementCopies()

				expect(pendingRefinementCopiesOf(pending)).toEqual([])
			})

			// Inside a hoist a pending predicate is a declaration read too
			// early, which the rounds retry. Outside one it is a Compiler bug.
			it("should ask the rounds to retry a pending predicate read during a hoist", () => {
				let thrownBy = (read: () => unknown): unknown => {
					try {
						read()
					} catch (error) {
						return error
					}

					return null
				}
				let reads = [
					() => provenConjuncts(pendingFilled()),
					() => conformanceKey("Equatable", pendingFilled()),
				]

				openPendingRefinementCopies()

				try {
					for (let read of reads) {
						expect(thrownBy(read)).toBeInstanceOf(NotHoistedYet)
					}
				} finally {
					closePendingRefinementCopies()
				}

				for (let read of reads) {
					expect(thrownBy(read)).toBeInstanceOf(Error)
				}
			})

			// A crash reporter prints what it caught with `String` unless it
			// is an `Error`, and a retry that escapes the rounds is not one.
			it("should read as its message when a retry escapes the rounds", () => {
				let message = "Protocol 'Named' has not been hoisted yet"

				expect(String(new NotHoistedYet(message))).toBe(message)
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

			// A refinement is evidence about the one value written, while a slot
			// holds every value its name will hold. So a write into a slot drops the
			// evidence at every depth.
			describe("resolveUnknownSlots", () => {
				const unknownList: Type = {
					type: "List",
					itemType: { type: "Unknown" },
				}

				function nonEmpty(itemType: Type): Type {
					return refinementOf(
						{ type: "List", itemType },
						"NonEmptyList",
					)
				}

				it("should pin a container to the base of a refinement", () => {
					expect(
						resolveUnknownSlots(unknownList, nonEmpty(string)),
					).toEqual({ type: "List", itemType: string })
				})

				it("should look through a refinement of a refinement", () => {
					expect(
						resolveUnknownSlots(
							unknownList,
							refinementOf(nonEmpty(string), "SortedList"),
						),
					).toEqual({ type: "List", itemType: string })
				})

				// A slot inside the container drops its evidence too, so a later
				// `rows::append([])` can add an empty List.
				it("should look through a refinement standing in a slot", () => {
					expect(
						resolveUnknownSlots(unknownList, {
							type: "List",
							itemType: nonEmpty(string),
						}),
					).toEqual({
						type: "List",
						itemType: { type: "List", itemType: string },
					})
				})

				it("should look through one standing over a Record member", () => {
					expect(
						resolveUnknownSlots(
							{ type: "Record", members: { items: unknownList } },
							{
								type: "Record",
								members: { items: nonEmpty(string) },
							},
						),
					).toEqual({
						type: "Record",
						members: { items: { type: "List", itemType: string } },
					})
				})

				// Nothing was decided, so the same Type comes back, which callers
				// read as "pinned nothing".
				it("should answer with the stored Type where the base decides nothing", () => {
					expect(
						resolveUnknownSlots(
							unknownList,
							nonEmpty({ type: "Unknown" }),
						),
					).toBe(unknownList)
				})
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

		// Refinements are erased before emission, wherever they stand in a Type
		// and wherever a Type hangs off a Node. Identity is preserved for the
		// caches around the standard library's simplified Program.
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

			// No Program writes a refinement over a refinement, but every layer is
			// erased anyway.
			it("should erase every layer of one", () => {
				expect(
					eraseRefinements({
						type: "Refinement",
						name: "PositiveNonZeroInteger",
						base: nonZero,
						conjuncts: [conjunct("isEven")],
					}),
				).toEqual(integer)
			})

			// An instantiated generic refinement erases to its instantiated base,
			// and the applied spelling goes with it. A refinement among the base's
			// items is erased too, so `NonEmptyList<NonZeroInteger>` is a List of
			// Integers.
			it("should erase an instantiated generic refinement to its base", () => {
				let nonEmpty = (itemType: Type): Type => ({
					type: "Refinement",
					name: "NonEmptyList",
					base: { type: "List", itemType },
					conjuncts: [conjunct("isEmpty", [], true, "List")],
					typeArguments: [itemType],
				})

				expect(eraseRefinements(nonEmpty(string))).toEqual({
					type: "List",
					itemType: string,
				})
				expect(eraseRefinements(nonEmpty(nonZero))).toEqual({
					type: "List",
					itemType: integer,
				})
			})

			it("should hand back a Type carrying none as itself", () => {
				let plain: Type = { type: "List", itemType: integer }

				expect(eraseRefinements(plain)).toBe(plain)
			})

			// An erased `Bag` holds a plain Integer, so it is no longer the Alias
			// and loses its spelling. A Matcher refusal reads it to say what the
			// emitted check can ask about.
			it("should drop a rebuilt Record's display spelling", () => {
				expect(
					eraseRefinements({
						type: "Record",
						name: "Bag",
						members: { count: nonZero },
					}),
				).toEqual({
					type: "Record",
					members: { count: integer },
				})
			})

			// A Record holding no refinement is not rebuilt and keeps its true
			// spelling.
			it("should keep the spelling of a Record it does not rebuild", () => {
				let named: Type = {
					type: "Record",
					name: "Bag",
					members: { count: integer },
				}

				expect(eraseRefinements(named)).toBe(named)
			})

			// A Union keeps its spelling, since a Type descriptor emits it field by
			// field. A Record's spelling is taken off by `withoutRecordNames`.
			it("should keep a rebuilt Union's spelling, which is emitted", () => {
				let erased = eraseRefinements({
					type: "UnionType",
					name: "Reading",
					types: [nonZero, string],
				}) as common.UnionType

				expect(erased.name).toBe("Reading")
				expect(erased.types).toEqual([integer, string])
			})

			// The walk reads every field of every Node, so a declared Type, a
			// value's Type and a Matcher are all erased.
			it("should erase every Type hanging off a Program", () => {
				let value: common.typedSimple.ExpressionNode = {
					nodeType: "IntegerValue",
					value: "3",
					type: { type: "Integer" },
				}

				let program: common.typedSimple.Program = {
					nodeType: "Program",
					imports: null,
					tests: null,
					coverage: null,
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
										memberTypes: null,
										memberTests: null,
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
					tests: null,
					coverage: null,
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

			// The Enricher refuses a recursive Choice, so the cycle is built by
			// hand. The rebuilt graph holds no refinement and the same cycle, its
			// back-edge wired to the replacement.
			it("should erase a refinement standing on a cycle", () => {
				let union: common.UnionType = {
					type: "UnionType",
					name: "Tree",
					types: [],
				}
				let node: common.CaseType = {
					type: "Case",
					choice: "Tree",
					name: "Node",
					members: {
						weight: nonZero,
						children: { type: "List", itemType: union },
					},
				}

				union.types.push(node)

				let erased = eraseRefinements(union) as common.UnionType
				let erasedNode = erased.types[0] as common.CaseType
				let children = erasedNode.members["children"] as common.ListType

				expect(erasedNode.members["weight"]).toEqual(integer)
				expect(children.itemType).toBe(erased)
				expect(typeContainsRefinement(erased)).toBe(false)
			})

			it("should hand back a cyclic Type carrying none as itself", () => {
				let union: common.UnionType = {
					type: "UnionType",
					name: "Tree",
					types: [],
				}
				let node: common.CaseType = {
					type: "Case",
					choice: "Tree",
					name: "Node",
					members: {
						weight: integer,
						children: { type: "List", itemType: union },
					},
				}

				union.types.push(node)

				expect(eraseRefinements(union)).toBe(union)
			})
		})

		// A Record's name never reaches the emitted Program, which would pool
		// two spellings of one shape as two constants. The Rewriter takes it off
		// wherever a Record stands.
		describe("withoutRecordNames", () => {
			const named: Type = {
				type: "Record",
				name: "Standing",
				members: { points: integer },
			}
			const shape: Type = {
				type: "Record",
				members: { points: integer },
			}

			it("should take a Record's spelling off, however deep it sits", () => {
				expect(withoutRecordNames(named)).toEqual(shape)
				expect(
					withoutRecordNames({ type: "List", itemType: named }),
				).toEqual({ type: "List", itemType: shape })
			})

			// A Record can stand in any signature of an Overload set, though
			// nothing emits one yet.
			it("should strip one standing in an Overload's signature", () => {
				expect(
					withoutRecordNames({
						type: "OverloadedMethod",
						overloads: [
							{
								parameterTypes: [{ name: "of", type: named }],
								generics: [],
								returnType: integer,
							},
						],
					}),
				).toEqual({
					type: "OverloadedMethod",
					overloads: [
						{
							parameterTypes: [{ name: "of", type: shape }],
							generics: [],
							returnType: integer,
						},
					],
				})
			})

			it("should hand back a Type naming no Record as itself", () => {
				let plain: Type = { type: "List", itemType: integer }

				expect(withoutRecordNames(plain)).toBe(plain)
			})
		})
	})
})

// A call against the expected Type may leave out a Parameter it promises a
// default for, so the actual must carry its own default. No Program can build
// such an expected Type, so the rule is asked of `matchesType` directly.
describe("Matching a signature that promises a default", () => {
	let promising: common.FunctionType = {
		type: "Function",
		generics: [],
		parameterTypes: [
			{ name: null, type: { type: "Integer" }, hasDefault: true },
		],
		returnType: { type: "Integer" },
	}
	let plain: common.FunctionType = {
		type: "Function",
		generics: [],
		parameterTypes: [{ name: null, type: { type: "Integer" } }],
		returnType: { type: "Integer" },
	}

	it("should refuse an actual signature that carries no default", () => {
		expect(matchesType(promising, plain)).toBe(false)
	})

	// The other direction is safe: a call through a Type promising no default
	// writes every Argument.
	it("should accept a defaulted signature where none was promised", () => {
		expect(matchesType(plain, promising)).toBe(true)
	})
})

// A Dictionary's two slots are decided, substituted and compared apart.
describe("Dictionary Types", () => {
	let bare: common.GenericDictionaryType = {
		type: "GenericDictionary",
		generics: [
			{ name: "KeyType", defaultType: { type: "Unknown" } },
			{ name: "ValueType", defaultType: { type: "Unknown" } },
		],
	}

	function dictionary(
		keyType: common.Type,
		valueType: common.Type,
	): common.DictionaryType {
		return { type: "Dictionary", keyType, valueType }
	}

	let unknown: common.Type = { type: "Unknown" }
	let string: common.Type = { type: "String" }
	let integer: common.Type = { type: "Integer" }

	describe("describeType", () => {
		it("should spell both slots of an applied Dictionary", () => {
			expect(describeType(dictionary(string, integer))).toBe(
				"Dictionary<String, Integer>",
			)
		})

		it("should spell a bare Dictionary as its name alone", () => {
			expect(describeType(bare)).toBe("Dictionary")
		})
	})

	describe("matchesType", () => {
		it("should accept a Dictionary of the same two slots", () => {
			expect(
				matchesType(
					dictionary(string, integer),
					dictionary(string, integer),
				),
			).toBe(true)
		})

		it("should refuse a Dictionary whose values differ", () => {
			expect(
				matchesType(
					dictionary(string, integer),
					dictionary(string, string),
				),
			).toBe(false)
		})

		it("should refuse a Dictionary whose keys differ", () => {
			expect(
				matchesType(
					dictionary(string, integer),
					dictionary(integer, integer),
				),
			).toBe(false)
		})

		// An undecided slot fits whatever the expected Type decided, slot by
		// slot, as an empty List Literal's item Type does.
		it("should accept a Dictionary with both slots undecided", () => {
			expect(
				matchesType(
					dictionary(string, integer),
					dictionary(unknown, unknown),
				),
			).toBe(true)
		})

		it("should accept a Dictionary with only its values undecided", () => {
			expect(
				matchesType(
					dictionary(string, integer),
					dictionary(string, unknown),
				),
			).toBe(true)
		})

		// The decided slot is still checked.
		it("should still check the slot the value decided", () => {
			expect(
				matchesType(
					dictionary(string, integer),
					dictionary(unknown, string),
				),
			).toBe(false)
		})

		it("should let a bare Dictionary accept every applied one", () => {
			expect(matchesType(bare, dictionary(string, integer))).toBe(true)
			expect(matchesType(bare, bare)).toBe(true)
		})

		// A bare Dictionary promises nothing about either slot, as a bare `List`
		// promises nothing about its items.
		it("should refuse a bare Dictionary where an applied one is asked for", () => {
			expect(matchesType(dictionary(string, integer), bare)).toBe(false)
		})

		it("should not match a Dictionary against a List of anything", () => {
			expect(
				matchesType(dictionary(string, integer), {
					type: "List",
					itemType: string,
				}),
			).toBe(false)
		})
	})

	describe("applyGenericBindings", () => {
		it("should substitute both slots", () => {
			let bindings = new Map<string, common.Type>([
				["Key", string],
				["Value", integer],
			])

			expect(
				applyGenericBindings(
					dictionary(
						{ type: "GenericUse", name: "Key" },
						{ type: "GenericUse", name: "Value" },
					),
					bindings,
				),
			).toEqual(dictionary(string, integer))
		})

		// A Type nothing changed comes back as itself, which identity checks
		// downstream rely on.
		it("should answer the very same Type when neither slot is bound", () => {
			let written = dictionary(
				{ type: "GenericUse", name: "Key" },
				{ type: "GenericUse", name: "Value" },
			)

			expect(applyGenericBindings(written, new Map())).toBe(written)
		})

		it("should substitute one slot and leave the other open", () => {
			let bindings = new Map<string, common.Type>([["Value", integer]])

			expect(
				applyGenericBindings(
					dictionary(
						{ type: "GenericUse", name: "Key" },
						{ type: "GenericUse", name: "Value" },
					),
					bindings,
				),
			).toEqual(dictionary({ type: "GenericUse", name: "Key" }, integer))
		})
	})

	describe("typeContainsUnknown", () => {
		it("should answer for either slot on its own", () => {
			expect(typeContainsUnknown(dictionary(unknown, integer))).toBe(true)
			expect(typeContainsUnknown(dictionary(string, unknown))).toBe(true)
			expect(typeContainsUnknown(dictionary(string, integer))).toBe(false)
		})

		// A bare Dictionary's Unknowns are declared defaults, not open slots.
		it("should not call a bare Dictionary undecided", () => {
			expect(typeContainsUnknown(bare)).toBe(false)
		})
	})

	describe("resolveUnknownSlots", () => {
		it("should pin both slots from a Type that decided them", () => {
			expect(
				resolveUnknownSlots(
					dictionary(unknown, unknown),
					dictionary(string, integer),
				),
			).toEqual(dictionary(string, integer))
		})

		// Each slot is pinned on its own.
		it("should pin one slot without touching the other", () => {
			expect(
				resolveUnknownSlots(
					dictionary(unknown, unknown),
					dictionary(string, unknown),
				),
			).toEqual(dictionary(string, unknown))
		})

		it("should leave a slot that already decided something alone", () => {
			let stored = dictionary(string, integer)

			expect(
				resolveUnknownSlots(stored, dictionary(integer, string)),
			).toBe(stored)
		})
	})
})

describe("Protocol identities", () => {
	let at = (line: number, column: number): common.Position => ({
		start: { line, column },
		end: { line, column: column + 5 },
	})

	it("should read the declared name back out of every identity", () => {
		for (let [modulePath, nestedAt] of [
			[null, null],
			[null, at(3, 11)],
			["/project/Sized.es", null],
			["/project/Sized.es", at(11, 11)],
			["/work#1/@scope/Sized.es", null],
			["/work#1/@scope/Sized.es", at(2, 4)],
		] as const) {
			expect(
				displayProtocolName(
					protocolIdentity(modulePath, "Sized", nestedAt),
				),
			).toBe("Sized")
		}
	})

	it("should tell a nested Protocol from the one it shadows", () => {
		expect(protocolIdentity("/project/Main.es", "Sized", null)).toBe(
			"/project/Main.es#Sized",
		)
		expect(protocolIdentity("/project/Main.es", "Sized", at(11, 11))).toBe(
			"/project/Main.es#Sized@11:11",
		)
		expect(protocolIdentity(null, "Tagged", at(3, 11))).toBe("Tagged@3:11")
		expect(protocolIdentity(null, "Equatable", null)).toBe("Equatable")
	})
})

// A "Did you mean" carries a Quick Fix that writes the name into the file.
// So the pairs that must not be offered are tested too.
describe("closestMatch", () => {
	it("should offer a name one edit away", () => {
		expect(closestMatch("lenth", ["length", "prepend"])).toBe("length")
		expect(closestMatch("totla", ["total", "count"])).toBe("total")
		expect(closestMatch("hasValu", ["hasValue", "isEmpty"])).toBe(
			"hasValue",
		)
	})

	// Two edits are too many on a short name.
	it("should refuse two edits on a short name", () => {
		expect(closestMatch("add", ["pad", "join"])).toBeNull()
		expect(closestMatch("noon", ["loop", "count"])).toBeNull()
	})

	it("should admit two edits on a name long enough to carry them", () => {
		expect(closestMatch("firstIdx", ["firstIndex"])).toBe("firstIndex")
		expect(closestMatch("sbtrct", ["subtract"])).toBe("subtract")
	})

	// `uppercase` and `lowercase` are three edits apart and mean opposite
	// things. Their length admits that many, so the opening letter decides.
	it("should refuse a far name that opens on another letter", () => {
		expect(closestMatch("uppercase", ["lowercase"])).toBeNull()
		expect(closestMatch("prepend", ["append"])).toBeNull()
	})

	it("should still offer a one-edit name that opens on another letter", () => {
		expect(closestMatch("bength", ["length"])).toBe("length")
	})

	// Both candidates are one edit away, so the one opening as the input does
	// wins over the order given.
	it("should prefer the candidate opening as the input does", () => {
		expect(closestMatch("sart", ["part", "start"])).toBe("start")
	})

	it("should offer nothing when there is nothing to offer", () => {
		expect(closestMatch("undeclaredMethod", [])).toBeNull()
		expect(closestMatch("", ["length"])).toBeNull()
	})
})
