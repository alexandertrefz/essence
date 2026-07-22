import type { common } from "../../interfaces/index"
import { type as orderingType } from "./Ordering"

export const type: common.IntegerType = { type: "Integer" }

export const namespace: common.NamespaceType = {
	type: "Namespace",
	name: "Integer",
	generics: [],
	targetType: type,
	conformsTo: ["Equatable", "Printable", "Comparable"],
	properties: {},
	methods: {
		is: {
			type: "SimpleMethod",
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
			returnType: { type: "Boolean" },
		},

		isNot: {
			type: "SimpleMethod",
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
			returnType: { type: "Boolean" },
		},

		add: {
			type: "OverloadedMethod",
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
							documentation: "the Integer to add",
						},
					],
					returnType: { type: "Integer" },
					documentation: {
						description: "Adds two Integers, giving an Integer.",
						parameters: {},
						returns: null,
						position: null,
					},
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
							documentation: "the Rational to add",
						},
					],
					returnType: { type: "Rational" },
					documentation: {
						description:
							"Adds a Rational to an Integer. The result is a Rational, since the sum need not be whole.",
						parameters: {},
						returns: null,
						position: null,
					},
				},
			],
			documentation: {
				description: "Adds a number to this Integer.",
				parameters: {},
				returns: null,
				position: null,
			},
		},

		subtract: {
			type: "OverloadedMethod",
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
							type: { type: "Integer" },
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
							type: { type: "Algebraic" },
						},
					],
					returnType: { type: "Algebraic" },
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
							type: { type: "Transcendental" },
						},
					],
					returnType: { type: "Transcendental" },
				},
			],
		},

		divideBy: {
			type: "OverloadedMethod",
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
							type: { type: "Integer" },
						},
						{
							name: null,
							type: { type: "Rational" },
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
							type: { type: "Integer" },
						},
						{
							name: null,
							type: { type: "Algebraic" },
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Algebraic" }, { type: "Rational" }],
					},
				},
			],
		},

		multiplyWith: {
			type: "OverloadedMethod",
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
							type: { type: "Integer" },
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
							type: { type: "Algebraic" },
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Algebraic" }, { type: "Rational" }],
					},
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
							type: { type: "Transcendental" },
						},
					],
					returnType: {
						type: "UnionType",
						types: [
							{ type: "Transcendental" },
							{ type: "Rational" },
						],
					},
				},
			],
		},

		isLessThan: {
			type: "OverloadedMethod",
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
					returnType: { type: "Boolean" },
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
					returnType: { type: "Boolean" },
				},
			],
		},

		isLessThanOrEqualTo: {
			type: "OverloadedMethod",
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
					returnType: { type: "Boolean" },
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
					returnType: { type: "Boolean" },
				},
			],
		},

		isGreaterThan: {
			type: "OverloadedMethod",
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
					returnType: { type: "Boolean" },
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
					returnType: { type: "Boolean" },
				},
			],
		},

		isGreaterThanOrEqualTo: {
			type: "OverloadedMethod",
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
					returnType: { type: "Boolean" },
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
					returnType: { type: "Boolean" },
				},
			],
		},

		squareRoot: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Integer" },
				},
			],
			returnType: {
				type: "UnionType",
				types: [
					{ type: "Integer" },
					{ type: "Algebraic" },
					{ type: "Nothing" },
				],
			},
			documentation: {
				description:
					"The exact square root. A perfect square gives a Integer; any other non-negative value gives an exact Algebraic — and a negative gives Nothing.",
				parameters: {},
				returns: null,
				position: null,
			},
		},

		toString: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Integer" },
				},
			],
			returnType: { type: "String" },
		} as common.MethodType,
		compareTo: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Integer" },
				},
				{
					name: null,
					type: { type: "Integer" },
					documentation: "the Integer to order against",
				},
			],
			returnType: orderingType,
			documentation: {
				description: "Orders the Integer against another Integer.",
				parameters: {},
				returns:
					"`Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.",
				position: null,
			},
		},
	},
}
