import { common } from "../../interfaces"

const functions: {
	[key: string]: common.Type
} = {
	__print: {
		type: "Function",
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
