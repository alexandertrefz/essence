import { common } from "../../interfaces"

const type: common.TypeType = {
	type: "Type",
	name: "String",
	definition: { type: "BuiltIn" },
	methods: {
		isEmpty: {
			type: "Method",
			parameterTypes: [{ type: "Self" }],
			returnType: { type: "Primitive", primitive: "Boolean" },
			isStatic: false,
		},
		hasContent: {
			type: "Method",
			parameterTypes: [{ type: "Self" }],
			returnType: { type: "Primitive", primitive: "Boolean" },
			isStatic: false,
		},
		is: {
			type: "Method",
			parameterTypes: [{ type: "Self" }, { type: "Self" }],
			returnType: { type: "Primitive", primitive: "Boolean" },
			isStatic: false,
		},
		isnt: {
			type: "Method",
			parameterTypes: [{ type: "Self" }, { type: "Self" }],
			returnType: { type: "Primitive", primitive: "Boolean" },
			isStatic: false,
		},
		prepend: {
			type: "Method",
			parameterTypes: [{ type: "Self" }, { type: "Self" }],
			returnType: { type: "Self" },
			isStatic: false,
		},
		append: {
			type: "Method",
			parameterTypes: [{ type: "Self" }, { type: "Self" }],
			returnType: { type: "Self" },
			isStatic: false,
		},
		split: {
			type: "Method",
			parameterTypes: [{ type: "Self" }, { type: "Array", itemType: { type: "Self" } }],
			returnType: { type: "Array", itemType: { type: "Self" } },
			isStatic: false,
		},
		contains: {
			type: "Method",
			parameterTypes: [{ type: "Self" }, { type: "Self" }],
			returnType: { type: "Primitive", primitive: "Boolean" },
			isStatic: false,
		},
	},
}

export default type
