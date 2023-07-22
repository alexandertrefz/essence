import { common } from "../../interfaces"

const type: common.TypeType = {
	type: "Type",
	name: "String",
	definition: { type: "Primitive", primitive: "String" },
	methods: {
		isEmpty: {
			type: "SimpleMethod",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "String" } },
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
		},
		hasContent: {
			type: "SimpleMethod",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "String" } },
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
		},
		is: {
			type: "SimpleMethod",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "String" } },
				{ name: null, type: { type: "Primitive", primitive: "String" } },
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
		},
		isnt: {
			type: "SimpleMethod",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "String" } },
				{ name: null, type: { type: "Primitive", primitive: "String" } },
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
		},
		prepend: {
			type: "SimpleMethod",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "String" } },
				{ name: null, type: { type: "Primitive", primitive: "String" } },
			],
			returnType: { type: "Primitive", primitive: "String" },
		},
		append: {
			type: "SimpleMethod",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "String" } },
				{ name: null, type: { type: "Primitive", primitive: "String" } },
			],
			returnType: { type: "Primitive", primitive: "String" },
		},
		split: {
			type: "SimpleMethod",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "String" } },
				{ name: "on", type: { type: "Primitive", primitive: "String" } },
			],
			returnType: {
				type: "List",
				itemType: { type: "Primitive", primitive: "String" },
			},
		},
		contains: {
			type: "SimpleMethod",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "String" } },
				{ name: null, type: { type: "Primitive", primitive: "String" } },
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
		},
	},
}

export default type
