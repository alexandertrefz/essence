import { common } from "../../interfaces"

const type: common.TypeType = {
	type: "Type",
	name: "Boolean",
	definition: { type: "Primitive", primitive: "Boolean" },
	methods: {
		is: {
			type: "Method",
			parameterTypes: [{ type: "Primitive", primitive: "Boolean" }, { type: "Primitive", primitive: "Boolean" }],
			returnType: { type: "Primitive", primitive: "Boolean" },
			isStatic: false,
		},
		negate: {
			type: "Method",
			parameterTypes: [{ type: "Primitive", primitive: "Boolean" }],
			returnType: { type: "Primitive", primitive: "Boolean" },
			isStatic: false,
		},
	},
}

export default type
