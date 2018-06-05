import { common } from "../../interfaces"

const type: common.TypeType = {
	type: "Type",
	name: "String",
	definition: { type: "Primitive", primitive: "String" },
	methods: {
		isEmpty: {
			type: "Method",
			parameterTypes: [{ name: null, type: { type: "Primitive", primitive: "String" } }],
			returnType: { type: "Primitive", primitive: "Boolean" },
			isStatic: false,
		},
		hasContent: {
			type: "Method",
			parameterTypes: [{ name: null, type: { type: "Primitive", primitive: "String" } }],
			returnType: { type: "Primitive", primitive: "Boolean" },
			isStatic: false,
		},
		is: {
			type: "Method",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "String" } },
				{ name: null, type: { type: "Primitive", primitive: "String" } },
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
			isStatic: false,
		},
		isnt: {
			type: "Method",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "String" } },
				{ name: null, type: { type: "Primitive", primitive: "String" } },
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
			isStatic: false,
		},
		prepend: {
			type: "Method",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "String" } },
				{ name: null, type: { type: "Primitive", primitive: "String" } },
			],
			returnType: { type: "Primitive", primitive: "String" },
			isStatic: false,
		},
		append: {
			type: "Method",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "String" } },
				{ name: null, type: { type: "Primitive", primitive: "String" } },
			],
			returnType: { type: "Primitive", primitive: "String" },
			isStatic: false,
		},
		split: {
			type: "Method",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "String" } },
				{ name: "on", type: { type: "Primitive", primitive: "String" } },
			],
			returnType: { type: "Array", itemType: { type: "Primitive", primitive: "String" } },
			isStatic: false,
		},
		contains: {
			type: "Method",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "String" } },
				{ name: null, type: { type: "Primitive", primitive: "String" } },
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
			isStatic: false,
		},
	},
}

export default type
