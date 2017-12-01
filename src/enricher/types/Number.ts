import { common } from "../../interfaces"

const type: common.TypeType = {
	type: "Type",
	name: "Number",
	definition: { type: "BuiltIn" },
	methods: {
		add: {
			type: "Method",
			parameterTypes: [{ type: "Self" }, { type: "Self" }],
			returnType: { type: "Self" },
			isStatic: false,
		},
		subtract: {
			type: "Method",
			parameterTypes: [{ type: "Self" }, { type: "Self" }],
			returnType: { type: "Self" },
			isStatic: false,
		},
		divide: {
			type: "Method",
			parameterTypes: [{ type: "Self" }, { type: "Self" }],
			returnType: { type: "Self" },
			isStatic: false,
		},
		multiply: {
			type: "Method",
			parameterTypes: [{ type: "Self" }, { type: "Self" }],
			returnType: { type: "Self" },
			isStatic: false,
		},
	},
}

export default type
