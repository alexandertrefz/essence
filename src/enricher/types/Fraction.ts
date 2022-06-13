import { common } from "../../interfaces"

const type: common.TypeType = {
	type: "Type",
	name: "Fraction",
	definition: { type: "Primitive", primitive: "Fraction" },
	methods: {
		add: {
			type: "OverloadedMethod",
			overloads: [
				{
					parameterTypes: [
						{ name: null, type: { type: "Primitive", primitive: "Fraction" } },
						{ name: null, type: { type: "Primitive", primitive: "Fraction" } },
					],
					returnType: { type: "Primitive", primitive: "Fraction" },
				},
				{
					parameterTypes: [
						{ name: null, type: { type: "Primitive", primitive: "Fraction" } },
						{ name: null, type: { type: "Primitive", primitive: "Integer" } },
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
						{ name: null, type: { type: "Primitive", primitive: "Fraction" } },
						{ name: null, type: { type: "Primitive", primitive: "Fraction" } },
					],
					returnType: { type: "Primitive", primitive: "Fraction" },
				},
				{
					parameterTypes: [
						{ name: null, type: { type: "Primitive", primitive: "Fraction" } },
						{ name: null, type: { type: "Primitive", primitive: "Integer" } },
					],
					returnType: { type: "Primitive", primitive: "Fraction" },
				},
			],
		},

		divide: {
			type: "OverloadedMethod",
			overloads: [
				{
					parameterTypes: [
						{ name: null, type: { type: "Primitive", primitive: "Fraction" } },
						{ name: null, type: { type: "Primitive", primitive: "Fraction" } },
					],
					returnType: { type: "Primitive", primitive: "Fraction" },
				},
				{
					parameterTypes: [
						{ name: null, type: { type: "Primitive", primitive: "Fraction" } },
						{ name: null, type: { type: "Primitive", primitive: "Integer" } },
					],
					returnType: { type: "Primitive", primitive: "Fraction" },
				},
			],
		},

		multiply: {
			type: "OverloadedMethod",
			overloads: [
				{
					parameterTypes: [
						{ name: null, type: { type: "Primitive", primitive: "Fraction" } },
						{ name: null, type: { type: "Primitive", primitive: "Fraction" } },
					],
					returnType: { type: "Primitive", primitive: "Fraction" },
				},
				{
					parameterTypes: [
						{ name: null, type: { type: "Primitive", primitive: "Fraction" } },
						{ name: null, type: { type: "Primitive", primitive: "Integer" } },
					],
					returnType: { type: "Primitive", primitive: "Fraction" },
				},
			],
		},
	},
}

export default type
