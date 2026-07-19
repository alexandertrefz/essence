import type { common } from "../../interfaces"

export const type: common.FractionType = { type: "Fraction" }

export const namespace: common.NamespaceType = {
	type: "Namespace",
	name: "Fraction",
	generics: [],
	targetType: type,
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
			returnType: { type: "Fraction" },
		},

		is: {
			type: "SimpleMethod",
			generics: [],

			parameterTypes: [
				{
					name: null,
					type: { type: "Fraction" },
				},
				{
					name: null,
					type: { type: "Fraction" },
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
					type: { type: "Fraction" },
				},
				{
					name: null,
					type: { type: "Fraction" },
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
							type: { type: "Fraction" },
						},
						{
							name: null,
							type: { type: "Fraction" },
						},
					],
					returnType: { type: "Fraction" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Fraction" },
						},
						{
							name: null,
							type: { type: "Integer" },
						},
					],
					returnType: { type: "Fraction" },
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
							type: { type: "Fraction" },
						},
						{
							name: null,
							type: { type: "Fraction" },
						},
					],
					returnType: { type: "Fraction" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Fraction" },
						},
						{
							name: null,
							type: { type: "Integer" },
						},
					],
					returnType: { type: "Fraction" },
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
							type: { type: "Fraction" },
						},
						{
							name: null,
							type: { type: "Fraction" },
						},
					],
					returnType: { type: "Fraction" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Fraction" },
						},
						{
							name: null,
							type: { type: "Integer" },
						},
					],
					returnType: { type: "Fraction" },
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
							type: { type: "Fraction" },
						},
						{
							name: null,
							type: { type: "Fraction" },
						},
					],
					returnType: { type: "Fraction" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Fraction" },
						},
						{
							name: null,
							type: { type: "Integer" },
						},
					],
					returnType: { type: "Fraction" },
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
							type: { type: "Fraction" },
						},
						{
							name: null,
							type: { type: "Fraction" },
						},
					],
					returnType: { type: "Boolean" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Fraction" },
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
							type: { type: "Fraction" },
						},
						{
							name: null,
							type: { type: "Fraction" },
						},
					],
					returnType: { type: "Boolean" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Fraction" },
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
							type: { type: "Fraction" },
						},
						{
							name: null,
							type: { type: "Fraction" },
						},
					],
					returnType: { type: "Boolean" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Fraction" },
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
							type: { type: "Fraction" },
						},
						{
							name: null,
							type: { type: "Fraction" },
						},
					],
					returnType: { type: "Boolean" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Fraction" },
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

		toString: {
			type: "OverloadedMethod",
			overloads: [
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Fraction" },
						},
					],
					returnType: { type: "String" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Fraction" },
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
	},
}
