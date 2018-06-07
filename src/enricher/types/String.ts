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
			isOverloaded: false,
		},
		hasContent: {
			type: "Method",
			parameterTypes: [{ name: null, type: { type: "Primitive", primitive: "String" } }],
			returnType: { type: "Primitive", primitive: "Boolean" },
			isStatic: false,
			isOverloaded: false,
		},
		is: {
			type: "Method",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "String" } },
				{ name: null, type: { type: "Primitive", primitive: "String" } },
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
			isStatic: false,
			isOverloaded: false,
		},
		isnt: {
			type: "Method",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "String" } },
				{ name: null, type: { type: "Primitive", primitive: "String" } },
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
			isStatic: false,
			isOverloaded: false,
		},
		prepend: {
			type: "Method",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "String" } },
				{ name: null, type: { type: "Primitive", primitive: "String" } },
			],
			returnType: { type: "Primitive", primitive: "String" },
			isStatic: false,
			isOverloaded: false,
		},
		append: {
			type: "Method",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "String" } },
				{ name: null, type: { type: "Primitive", primitive: "String" } },
			],
			returnType: { type: "Primitive", primitive: "String" },
			isStatic: false,
			isOverloaded: false,
		},
		split: {
			type: "Method",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "String" } },
				{ name: "on", type: { type: "Primitive", primitive: "String" } },
			],
			returnType: { type: "Array", itemType: { type: "Primitive", primitive: "String" } },
			isStatic: false,
			isOverloaded: false,
		},
		contains: {
			type: "Method",
			parameterTypes: [
				{ name: null, type: { type: "Primitive", primitive: "String" } },
				{ name: null, type: { type: "Primitive", primitive: "String" } },
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
			isStatic: false,
			isOverloaded: false,
		},
	},
}

export default type
