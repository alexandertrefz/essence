import type { common } from "../../interfaces"

export const type: common.Type = { type: "Primitive", primitive: "Fraction" }

export const namespace: common.NamespaceType = {
	type: "Namespace",
	name: "Fraction",
	targetType: type,
	definition: { type: "Record", members: {} },
	methods: {
		of: {
			type: "StaticMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "Primitive", primitive: "Integer" },
				},
				{
					name: "over",
					type: { type: "Primitive", primitive: "Integer" },
				},
			],
			returnType: { type: "Primitive", primitive: "Fraction" },
		},

		is: {
			type: "SimpleMethod",

			parameterTypes: [
				{
					name: null,
					type: { type: "Primitive", primitive: "Fraction" },
				},
				{
					name: null,
					type: { type: "Primitive", primitive: "Fraction" },
				},
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
		},

		isNot: {
			type: "SimpleMethod",

			parameterTypes: [
				{
					name: null,
					type: { type: "Primitive", primitive: "Fraction" },
				},
				{
					name: null,
					type: { type: "Primitive", primitive: "Fraction" },
				},
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
		},

		add: {
			type: "OverloadedMethod",
			overloads: [
				{
					parameterTypes: [
						{
							name: null,
							type: { type: "Primitive", primitive: "Fraction" },
						},
						{
							name: null,
							type: { type: "Primitive", primitive: "Fraction" },
						},
					],
					returnType: { type: "Primitive", primitive: "Fraction" },
				},
				{
					parameterTypes: [
						{
							name: null,
							type: { type: "Primitive", primitive: "Fraction" },
						},
						{
							name: null,
							type: { type: "Primitive", primitive: "Integer" },
						},
					],
					returnType: { type: "Primitive", primitive: "Fraction" },
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
							type: { type: "Primitive", primitive: "Fraction" },
						},
						{
							name: null,
							type: { type: "Primitive", primitive: "Fraction" },
						},
					],
					returnType: { type: "Primitive", primitive: "Fraction" },
				},
				{
					parameterTypes: [
						{
							name: null,
							type: { type: "Primitive", primitive: "Fraction" },
						},
						{
							name: null,
							type: { type: "Primitive", primitive: "Integer" },
						},
					],
					returnType: { type: "Primitive", primitive: "Fraction" },
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
							type: { type: "Primitive", primitive: "Fraction" },
						},
						{
							name: null,
							type: { type: "Primitive", primitive: "Fraction" },
						},
					],
					returnType: { type: "Primitive", primitive: "Fraction" },
				},
				{
					parameterTypes: [
						{
							name: null,
							type: { type: "Primitive", primitive: "Fraction" },
						},
						{
							name: null,
							type: { type: "Primitive", primitive: "Integer" },
						},
					],
					returnType: { type: "Primitive", primitive: "Fraction" },
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
							type: { type: "Primitive", primitive: "Fraction" },
						},
						{
							name: null,
							type: { type: "Primitive", primitive: "Fraction" },
						},
					],
					returnType: { type: "Primitive", primitive: "Fraction" },
				},
				{
					parameterTypes: [
						{
							name: null,
							type: { type: "Primitive", primitive: "Fraction" },
						},
						{
							name: null,
							type: { type: "Primitive", primitive: "Integer" },
						},
					],
					returnType: { type: "Primitive", primitive: "Fraction" },
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
							type: { type: "Primitive", primitive: "Fraction" },
						},
						{
							name: null,
							type: { type: "Primitive", primitive: "Fraction" },
						},
					],
					returnType: { type: "Primitive", primitive: "Boolean" },
				},
				{
					parameterTypes: [
						{
							name: null,
							type: { type: "Primitive", primitive: "Fraction" },
						},
						{
							name: null,
							type: { type: "Primitive", primitive: "Integer" },
						},
					],
					returnType: { type: "Primitive", primitive: "Boolean" },
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
							type: { type: "Primitive", primitive: "Fraction" },
						},
						{
							name: null,
							type: { type: "Primitive", primitive: "Fraction" },
						},
					],
					returnType: { type: "Primitive", primitive: "Boolean" },
				},
				{
					parameterTypes: [
						{
							name: null,
							type: { type: "Primitive", primitive: "Fraction" },
						},
						{
							name: null,
							type: { type: "Primitive", primitive: "Integer" },
						},
					],
					returnType: { type: "Primitive", primitive: "Boolean" },
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
							type: { type: "Primitive", primitive: "Fraction" },
						},
						{
							name: null,
							type: { type: "Primitive", primitive: "Fraction" },
						},
					],
					returnType: { type: "Primitive", primitive: "Boolean" },
				},
				{
					parameterTypes: [
						{
							name: null,
							type: { type: "Primitive", primitive: "Fraction" },
						},
						{
							name: null,
							type: { type: "Primitive", primitive: "Integer" },
						},
					],
					returnType: { type: "Primitive", primitive: "Boolean" },
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
							type: { type: "Primitive", primitive: "Fraction" },
						},
						{
							name: null,
							type: { type: "Primitive", primitive: "Fraction" },
						},
					],
					returnType: { type: "Primitive", primitive: "Boolean" },
				},
				{
					parameterTypes: [
						{
							name: null,
							type: { type: "Primitive", primitive: "Fraction" },
						},
						{
							name: null,
							type: { type: "Primitive", primitive: "Integer" },
						},
					],
					returnType: { type: "Primitive", primitive: "Boolean" },
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
							type: { type: "Primitive", primitive: "Fraction" },
						},
					],
					returnType: { type: "Primitive", primitive: "String" },
				},
				{
					parameterTypes: [
						{
							name: null,
							type: { type: "Primitive", primitive: "Fraction" },
						},
						{
							name: "formatAs",
							type: { type: "Primitive", primitive: "String" },
						},
					],
					returnType: { type: "Primitive", primitive: "String" },
				},
			],
		} as common.OverloadedMethodType,
	},
}
