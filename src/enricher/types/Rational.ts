import type { common } from "../../interfaces/index"
import { type as orderingType } from "./Ordering"

export const type: common.RationalType = { type: "Rational" }

export const namespace: common.NamespaceType = {
	type: "Namespace",
	name: "Rational",
	generics: [],
	targetType: type,
	conformsTo: ["Equatable", "Printable", "Comparable"],
	properties: {},
	methods: {
		of: {
			type: "StaticMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Integer" },
				},
				{
					name: "over",
					type: { type: "Integer" },
				},
			],
			returnType: {
				type: "UnionType",
				types: [{ type: "Rational" }, { type: "Nothing" }],
			},
		},

		is: {
			type: "SimpleMethod",
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
			returnType: { type: "Boolean" },
		},

		isNot: {
			type: "SimpleMethod",
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
							type: { type: "Rational" },
						},
						{
							name: null,
							type: { type: "Integer" },
						},
					],
					returnType: { type: "Rational" },
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
							type: { type: "Rational" },
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

		subtract: {
			type: "OverloadedMethod",
			overloads: [
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
							type: { type: "Rational" },
						},
						{
							name: null,
							type: { type: "Integer" },
						},
					],
					returnType: { type: "Rational" },
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
							type: { type: "Rational" },
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
							type: { type: "Rational" },
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
							type: { type: "Rational" },
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
							type: { type: "Rational" },
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
							type: { type: "Rational" },
						},
						{
							name: null,
							type: { type: "Integer" },
						},
					],
					returnType: { type: "Rational" },
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
							type: { type: "Rational" },
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
							type: { type: "Rational" },
						},
						{
							name: null,
							type: { type: "Rational" },
						},
					],
					returnType: { type: "Boolean" },
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
							type: { type: "Rational" },
						},
						{
							name: null,
							type: { type: "Rational" },
						},
					],
					returnType: { type: "Boolean" },
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
							type: { type: "Rational" },
						},
						{
							name: null,
							type: { type: "Rational" },
						},
					],
					returnType: { type: "Boolean" },
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
							type: { type: "Rational" },
						},
						{
							name: null,
							type: { type: "Rational" },
						},
					],
					returnType: { type: "Boolean" },
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
					type: { type: "Rational" },
				},
			],
			returnType: {
				type: "UnionType",
				types: [
					{ type: "Rational" },
					{ type: "Algebraic" },
					{ type: "Nothing" },
				],
			},
			documentation: {
				description:
					"The exact square root. A perfect square gives a Rational; any other non-negative value gives an exact Algebraic — and a negative gives Nothing.",
				parameters: {},
				returns: null,
				position: null,
			},
		},

		toString: {
			type: "OverloadedMethod",
			overloads: [
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Rational" },
						},
					],
					returnType: { type: "String" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Rational" },
						},
						{
							name: "formatAs",
							type: { type: "String" },
						},
					],
					returnType: { type: "String" },
				},
			],
		} as common.OverloadedMethodType,
		compareTo: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Rational" },
				},
				{
					name: null,
					type: { type: "Rational" },
					documentation: "the Rational to order against",
				},
			],
			returnType: orderingType,
			documentation: {
				description: "Orders the Rational against another Rational.",
				parameters: {},
				returns:
					"`Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.",
				position: null,
			},
		},
	},
}
