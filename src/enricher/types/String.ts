import type { common } from "../../interfaces/index"
import { type as orderingType } from "./Ordering"

export const type: common.StringType = { type: "String" }

// NOTE: The everyday String Methods below are regular enough — a String
// receiver, at most two String or Integer arguments, one of a handful of
// return Types — that hand-writing each would only invite the drift that keeps
// biting the numeric tables. `stringMethod` states one, prepending the `@`
// receiver; `param` and `docOf` cut the noise further.
const stringType: common.Type = { type: "String" }
const booleanType: common.Type = { type: "Boolean" }
const integerType: common.Type = { type: "Integer" }
const stringOrNothing: common.Type = {
	type: "UnionType",
	types: [stringType, { type: "Nothing" }],
}
const integerOrNothing: common.Type = {
	type: "UnionType",
	types: [integerType, { type: "Nothing" }],
}

function param(
	type: common.Type,
	name: string | null = null,
	documentation?: string,
): common.Parameter {
	return { name, type, ...(documentation ? { documentation } : {}) }
}

function docOf(
	description: string,
	returns: string | null = null,
	parameters: Record<string, string> = {},
): common.Documentation {
	return { description, parameters, returns, position: null }
}

function stringMethod(
	params: Array<common.Parameter>,
	returnType: common.Type,
	documentation?: common.Documentation,
): common.MethodType {
	return {
		type: "SimpleMethod",
		generics: [],
		parameterTypes: [param(stringType), ...params],
		returnType,
		...(documentation ? { documentation } : {}),
	}
}

// NOTE: Indices and character counts are by Unicode code point, not UTF-16
// code unit — so `characterAt` never returns a lone surrogate, and `length`
// counts what a reader would call characters. Substring Methods
// (`startsWith`, `replaceEvery`, …) match on the raw String, which is correct
// regardless of unit.
const additionalMethods: Record<string, common.MethodType> = {
	length: stringMethod(
		[],
		integerType,
		docOf(
			"How many characters the String has.",
			"the number of characters.",
		),
	),
	characters: stringMethod(
		[],
		{ type: "List", itemType: stringType },
		docOf(
			"The String's characters, each as its own single-character String.",
			"the List of characters.",
		),
	),
	characterAt: stringMethod(
		[param(integerType)],
		stringOrNothing,
		docOf(
			"The character at the given position, counting from zero.",
			"the character, or `Nothing` when the position is outside the String.",
		),
	),
	uppercased: stringMethod(
		[],
		stringType,
		docOf("The String with every character in upper case."),
	),
	lowercased: stringMethod(
		[],
		stringType,
		docOf("The String with every character in lower case."),
	),
	trimmed: stringMethod(
		[],
		stringType,
		docOf("The String without surrounding whitespace."),
	),
	trimmedAtStart: stringMethod(
		[],
		stringType,
		docOf("The String without leading whitespace."),
	),
	trimmedAtEnd: stringMethod(
		[],
		stringType,
		docOf("The String without trailing whitespace."),
	),
	startsWith: stringMethod(
		[param(stringType)],
		booleanType,
		docOf("Whether the String begins with the given one."),
	),
	doesNotStartWith: stringMethod(
		[param(stringType)],
		booleanType,
		docOf("Whether the String does not begin with the given one."),
	),
	endsWith: stringMethod(
		[param(stringType)],
		booleanType,
		docOf("Whether the String ends with the given one."),
	),
	doesNotEndWith: stringMethod(
		[param(stringType)],
		booleanType,
		docOf("Whether the String does not end with the given one."),
	),
	replaceEvery: stringMethod(
		[param(stringType), param(stringType, "with")],
		stringType,
		docOf(
			"The String with every occurrence of one part replaced by another.",
			"the String with the replacements made.",
		),
	),
	repeated: stringMethod(
		[param(integerType)],
		stringType,
		docOf(
			"The String joined to itself the given number of times.",
			"the repeated String; the empty String for a count below one.",
		),
	),
	reversed: stringMethod(
		[],
		stringType,
		docOf("The String with its characters in the opposite order."),
	),
	slice: stringMethod(
		[param(integerType, "from"), param(integerType, "to")],
		stringType,
		docOf(
			"The characters from one position up to, but not including, another.",
			"the String of that range of characters.",
			{
				from: "the first position to include, counting from zero.",
				to: "the position to stop before.",
			},
		),
	),
	firstIndexOf: stringMethod(
		[param(stringType)],
		integerOrNothing,
		docOf(
			"The position of the first occurrence of the given String.",
			"the zero-based position, or `Nothing` when it does not occur.",
		),
	),
	paddedAtStart: stringMethod(
		[param(integerType, "to"), param(stringType, "with")],
		stringType,
		docOf(
			"The String padded at the front, with the given String, up to the given length.",
			"the padded String; unchanged when it is already that long.",
			{
				to: "the length to reach.",
				with: "the String to pad with, repeated as needed.",
			},
		),
	),
	paddedAtEnd: stringMethod(
		[param(integerType, "to"), param(stringType, "with")],
		stringType,
		docOf(
			"The String padded at the end, with the given String, up to the given length.",
			"the padded String; unchanged when it is already that long.",
			{
				to: "the length to reach.",
				with: "the String to pad with, repeated as needed.",
			},
		),
	),
	compareTo: stringMethod(
		[param(stringType, null, "the String to order against")],
		orderingType,
		docOf(
			"Orders the String against another, by character code point.",
			"`Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.",
		),
	),
}

export const namespace: common.NamespaceType = {
	type: "Namespace",
	name: "String",
	targetType: type,
	conformsTo: ["Equatable", "Printable", "Comparable"],
	generics: [],
	properties: {},
	methods: {
		isEmpty: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "String" },
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description: "Whether this String has no characters at all.",
				parameters: {},
				returns: "true for the empty String, false otherwise",
				position: null,
			},
		},
		hasAnyContent: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "String" },
				},
			],
			returnType: { type: "Boolean" },
		},
		is: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "String" },
				},
				{
					name: null,
					type: { type: "String" },
				},
			],
			returnType: { type: "Boolean" },
		},
		isNot: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "String" },
				},
				{
					name: null,
					type: { type: "String" },
				},
			],
			returnType: { type: "Boolean" },
		},
		prepend: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "String" },
				},
				{
					name: null,
					type: { type: "String" },
				},
			],
			returnType: { type: "String" },
		},
		append: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "String" },
				},
				{
					name: null,
					type: { type: "String" },
					documentation: "the String to add to the end",
				},
			],
			returnType: { type: "String" },
			documentation: {
				description:
					"Joins another String onto the end of this one.\n\nNeither String is changed — the joined result is returned.",
				parameters: {},
				returns: "the two Strings joined together",
				position: null,
			},
		},
		splitOn: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "String" },
				},
				{
					name: null,
					type: { type: "String" },
				},
			],
			returnType: {
				type: "List",
				itemType: { type: "String" },
			},
		},
		contains: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "String" },
				},
				{
					name: null,
					type: { type: "String" },
				},
			],
			returnType: { type: "Boolean" },
		},
		doesNotContain: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "String" },
				},
				{
					name: null,
					type: { type: "String" },
				},
			],
			returnType: { type: "Boolean" },
		},
		...additionalMethods,
		toString: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "String" },
				},
			],
			returnType: { type: "String" },
			documentation: {
				description:
					"Represents the String as itself — Strings are their own representation.",
				parameters: {},
				returns: "the String itself.",
				position: null,
			},
		} as common.MethodType,
	},
}
