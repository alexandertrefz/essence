import { common } from "../../interfaces"

const functions: {
	[key: string]: common.Type
} = {
	__print: {
		type: "Function",
		// TODO: We accept all types here, once we can represent this, fix this function.
		parameterTypes: [
			{
				type: "Primitive",
				primitive: "String",
			},
		],
		returnType: {
			type: "Primitive",
			primitive: "String",
		},
	},
}

export default functions
