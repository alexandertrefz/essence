import type { common } from "../../interfaces"

export const type: common.Type = { type: "Fraction" }

export const namespace: common.NamespaceType = {
	type: "Namespace",
	name: "Fraction",
	targetType: type,
	properties: {},
	methods: {
		of: {
			type: "StaticMethod",
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
					parameterTypes: [
						{
							name: null,
							type: { type: "Fraction" },
						},
					],
					returnType: { type: "String" },
				},
				{
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
