import { common } from "../../interfaces"

const type: common.TypeType = {
	type: "Type",
	name: "Boolean",
	definition: { type: "BuiltIn" },
	methods: {
		is: {
			type: "Method",
			parameterTypes: [{ type: "Self" }],
			returnType: { type: "Self" },
			isStatic: false,
		},
		negate: {
			type: "Method",
			parameterTypes: [{ type: "Self" }],
			returnType: { type: "Self" },
			isStatic: false,
		},
	},
}

export default type
