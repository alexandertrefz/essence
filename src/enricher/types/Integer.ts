import { common } from "../../interfaces"

const type: common.TypeType = {
	type: "Type",
	name: "Integer",
	definition: { type: "Primitive", primitive: "Integer" },
	methods: {
		add: {
			type: "SimpleMethod",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "Integer" } },
				{ name: null, type: { type: "Primitive", primitive: "Integer" } },
			],
			returnType: { type: "Primitive", primitive: "Integer" },
		},
		subtract: {
			type: "SimpleMethod",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "Integer" } },
				{ name: null, type: { type: "Primitive", primitive: "Integer" } },
			],
			returnType: { type: "Primitive", primitive: "Integer" },
		},
		divide: {
			type: "OverloadedMethod",
			parameterTypes: [
				[
					{ name: null, type: { type: "Primitive", primitive: "Integer" } },
					{ name: null, type: { type: "Primitive", primitive: "Integer" } },
				],
				[
					{ name: null, type: { type: "Primitive", primitive: "Integer" } },
					{ name: null, type: { type: "Primitive", primitive: "Fraction" } },
				],
			],
			returnType: { type: "Primitive", primitive: "Fraction" },
		},
		multiply: {
			type: "SimpleMethod",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "Integer" } },
				{ name: null, type: { type: "Primitive", primitive: "Integer" } },
			],
			returnType: { type: "Primitive", primitive: "Integer" },
		},
	},
}

export default type
