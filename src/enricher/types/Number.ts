import type { common } from "../../interfaces/index"
import { type as orderingType } from "./Ordering"

export const type: common.UnionType = {
	type: "UnionType",
	types: [{ type: "Integer" }, { type: "Rational" }],
}

// NOTE: The Union-level behaviour of `Number` — cross-member semantics only
// a covering Namespace can define. `is` is numeric equality (`1 is 1/1` is
// true), while the member Namespaces stay representational; Method target
// specificity routes single-member receivers to those, so these Methods only
// answer for Union-typed receivers and mixed-member Arguments.
export const namespace: common.NamespaceType = {
	type: "Namespace",
	name: "Number",
	targetType: type,
	conformsTo: ["Equatable", "Printable", "Comparable"],
	generics: [],
	properties: {
		PI: { type: "Rational" },
		TAU: { type: "Rational" },
	},
	methods: {
		is: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{ name: null, type },
				{
					name: null,
					type,
					documentation: "the Number to compare against",
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description:
					"Checks whether the Number has the same numeric value as another Number — an Integer and a Rational are the same Number when their values are equal, so `1 is 1/1` holds.",
				parameters: {},
				returns:
					"`true` when both Numbers have the same numeric value.",
				position: null,
			},
		} as common.MethodType,
		isNot: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{ name: null, type },
				{
					name: null,
					type,
					documentation: "the Number to compare against",
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description:
					"Checks whether the Number has a different numeric value than another Number.",
				parameters: {},
				returns:
					"`true` when the Numbers have different numeric values.",
				position: null,
			},
		} as common.MethodType,
		toString: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [{ name: null, type }],
			returnType: { type: "String" },
			documentation: {
				description:
					"Represents the Number as a String, in the notation of the member Type it currently holds.",
				parameters: {},
				returns: null,
				position: null,
			},
		} as common.MethodType,
		compareTo: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{ name: null, type },
				{
					name: null,
					type,
					documentation: "the Number to order against",
				},
			],
			returnType: orderingType,
			documentation: {
				description:
					"Orders the Number against another Number by numeric value, across Integers and Rationals.",
				parameters: {},
				returns:
					"`Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.",
				position: null,
			},
		} as common.MethodType,
		lowestNumber: {
			type: "OverloadedStaticMethod",
			overloads: [
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Integer" },
						},
						{
							name: null,
							type: { type: "Integer" },
						},
					],
					returnType: { type: "Integer" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Rational" },
						},
						{
							name: null,
							type: { type: "Rational" },
						},
					],
					returnType: { type: "Rational" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Integer" },
						},
						{
							name: null,
							type: { type: "Rational" },
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Integer" }, { type: "Rational" }],
					},
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Rational" },
						},
						{
							name: null,
							type: { type: "Integer" },
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Integer" }, { type: "Rational" }],
					},
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: {
								type: "List",
								itemType: {
									type: "Integer",
								},
							},
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Integer" }, { type: "Nothing" }],
					},
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: {
								type: "List",
								itemType: {
									type: "Rational",
								},
							},
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Rational" }, { type: "Nothing" }],
					},
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: {
								type: "List",
								itemType: {
									type: "UnionType",
									types: [
										{
											type: "Integer",
										},
										{
											type: "Rational",
										},
									],
								},
							},
						},
					],
					returnType: {
						type: "UnionType",
						types: [
							{ type: "Integer" },
							{ type: "Rational" },
							{ type: "Nothing" },
						],
					},
				},
			],
		},
		greatestNumber: {
			type: "OverloadedStaticMethod",
			overloads: [
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Integer" },
						},
						{
							name: null,
							type: { type: "Integer" },
						},
					],
					returnType: { type: "Integer" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Rational" },
						},
						{
							name: null,
							type: { type: "Rational" },
						},
					],
					returnType: { type: "Rational" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Integer" },
						},
						{
							name: null,
							type: { type: "Rational" },
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Integer" }, { type: "Rational" }],
					},
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Rational" },
						},
						{
							name: null,
							type: { type: "Integer" },
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Integer" }, { type: "Rational" }],
					},
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: {
								type: "List",
								itemType: {
									type: "Integer",
								},
							},
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Integer" }, { type: "Nothing" }],
					},
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: {
								type: "List",
								itemType: {
									type: "Rational",
								},
							},
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Rational" }, { type: "Nothing" }],
					},
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: {
								type: "List",
								itemType: {
									type: "UnionType",
									types: [
										{
											type: "Integer",
										},
										{
											type: "Rational",
										},
									],
								},
							},
						},
					],
					returnType: {
						type: "UnionType",
						types: [
							{ type: "Integer" },
							{ type: "Rational" },
							{ type: "Nothing" },
						],
					},
				},
			],
		},
	},
}
