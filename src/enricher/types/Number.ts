import { common } from "../../interfaces"

const type: common.TypeType = {
	type: "Type",
	name: "Number",
	definition: { type: "Primitive", primitive: "Number" },
	methods: {
		add: {
			type: "Method",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "Number" } },
				{ name: null, type: { type: "Primitive", primitive: "Number" } },
			],
			returnType: { type: "Primitive", primitive: "Number" },
			isStatic: false,
			isOverloaded: false,
		},
		subtract: {
			type: "Method",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "Number" } },
				{ name: null, type: { type: "Primitive", primitive: "Number" } },
			],
			returnType: { type: "Primitive", primitive: "Number" },
			isStatic: false,
			isOverloaded: false,
		},
		divide: {
			type: "Method",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "Number" } },
				{ name: null, type: { type: "Primitive", primitive: "Number" } },
			],
			returnType: { type: "Primitive", primitive: "Number" },
			isStatic: false,
			isOverloaded: false,
		},
		multiply: {
			type: "Method",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "Number" } },
				{ name: null, type: { type: "Primitive", primitive: "Number" } },
			],
			returnType: { type: "Primitive", primitive: "Number" },
			isStatic: false,
			isOverloaded: false,
		},
	},
}

export default type
