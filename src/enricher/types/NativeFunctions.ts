import { common } from "../../interfaces"

const functions: {
	[key: string]: common.Type
} = {
	__print: {
		type: "Function",
		// TODO: Turn into a generic function once generics are implemented.
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
