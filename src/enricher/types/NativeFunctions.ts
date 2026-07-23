import type { common } from "../../interfaces/index"

// NOTE: The only builtin left in TypeScript, and the last file in this
// directory — the rest were the hand written Namespace and Type tables, deleted
// once `src/stdlib/*.es` declared all of them. `__print` stays because there is
// no way to WRITE it: a `declarations { … }` file can declare native Methods on
// a Namespace and native static Properties, but not a free native Function, and
// `__print` belongs to no Namespace. Give the language that form and this file
// becomes `src/stdlib/Print.es` and the directory goes.

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
