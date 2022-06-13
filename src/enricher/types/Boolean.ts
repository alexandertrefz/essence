import { common } from "../../interfaces"

const type: common.TypeType = {
	type: "Type",
	name: "Boolean",
	definition: { type: "Primitive", primitive: "Boolean" },
	methods: {
		is: {
			type: "SimpleMethod",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "Boolean" } },
				{ name: null, type: { type: "Primitive", primitive: "Boolean" } },
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
		},
		isnt: {
			type: "SimpleMethod",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "Boolean" } },
				{ name: null, type: { type: "Primitive", primitive: "Boolean" } },
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
		},
		negate: {
			type: "SimpleMethod",
			parameterTypes: [{ name: null, type: { type: "Primitive", primitive: "Boolean" } }],
			returnType: { type: "Primitive", primitive: "Boolean" },
		},
	},
}

export default type
