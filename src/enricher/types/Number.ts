import { common } from "../../interfaces"

const type: common.TypeType = {
	type: "Type",
	name: "Number",
	definition: { type: "Primitive", primitive: "Number" },
	methods: {
		add: {
			type: "SimpleMethod",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "Number" } },
				{ name: null, type: { type: "Primitive", primitive: "Number" } },
			],
			returnType: { type: "Primitive", primitive: "Number" },
		},
		subtract: {
			type: "SimpleMethod",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "Number" } },
				{ name: null, type: { type: "Primitive", primitive: "Number" } },
			],
			returnType: { type: "Primitive", primitive: "Number" },
		},
		divide: {
			type: "SimpleMethod",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "Number" } },
				{ name: null, type: { type: "Primitive", primitive: "Number" } },
			],
			returnType: { type: "Primitive", primitive: "Number" },
		},
		multiply: {
			type: "SimpleMethod",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "Number" } },
				{ name: null, type: { type: "Primitive", primitive: "Number" } },
			],
			returnType: { type: "Primitive", primitive: "Number" },
		},
	},
}

export default type
