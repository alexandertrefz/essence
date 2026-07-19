import type { common } from "../../interfaces"

const functions: Record<string, common.Type> = {
	__print: {
		type: "Function",
		generics: [{ name: "Item", defaultType: null, infer: true }],
		parameterTypes: [
			{
				name: null,
				type: {
					type: "GenericUse",
					name: "Item",
				},
			},
		],
		returnType: {
			type: "GenericUse",
			name: "Item",
		},
	},
}

export default functions
