import { common } from "../../interfaces";

const functions: {
	[key: string]: common.Type;
} = {
	__print: {
		type: "GenericFunction",
		generics: [{ name: "Item", defaultType: null }],
		parameterTypes: [
			{
				name: null,
				type: {
					type: "Generic",
					name: "Item",
				},
			},
		],
		returnType: {
			type: "Generic",
			name: "Item",
		},
	},
};

export default functions;
