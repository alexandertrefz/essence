import { common } from "../../interfaces"

function generateType(genericType: common.Type): common.TypeType {
	return {
		type: "Type",
		name: "List",
		definition: { type: "BuiltIn" },
		methods: {
			hasItems: {
				type: "SimpleMethod",
				parameterTypes: [{ name: null, type: { type: "List", itemType: genericType } }],
				returnType: { type: "Primitive", primitive: "Boolean" },
			},
			first: {
				type: "SimpleMethod",
				parameterTypes: [{ name: null, type: { type: "List", itemType: genericType } }],
				returnType: genericType,
			},
			last: {
				type: "SimpleMethod",
				parameterTypes: [{ name: null, type: { type: "List", itemType: genericType } }],
				returnType: genericType,
			},
			unique: {
				type: "SimpleMethod",
				parameterTypes: [{ name: null, type: { type: "List", itemType: genericType } }],
				returnType: { type: "List", itemType: genericType },
			},
			dropFirst: {
				type: "SimpleMethod",
				parameterTypes: [{ name: null, type: { type: "List", itemType: genericType } }],
				returnType: { type: "List", itemType: genericType },
			},
			dropLast: {
				type: "SimpleMethod",
				parameterTypes: [{ name: null, type: { type: "List", itemType: genericType } }],
				returnType: { type: "List", itemType: genericType },
			},
			insert: {
				type: "OverloadedMethod",
				parameterTypes: [
					[
						{ name: null, type: { type: "List", itemType: genericType } },
						{ name: null, type: genericType },
						{ name: "atIndex", type: { type: "Primitive", primitive: "Number" } },
					],
					[
						{ name: null, type: { type: "List", itemType: genericType } },
						{ name: "contentsOf", type: { type: "List", itemType: genericType } },
						{ name: "atIndex", type: { type: "Primitive", primitive: "Number" } },
					],
				],
				returnType: { type: "List", itemType: genericType },
			},
			append: {
				type: "OverloadedMethod",
				parameterTypes: [
					[{ name: null, type: { type: "List", itemType: genericType } }, { name: null, type: genericType }],
					[
						{ name: null, type: { type: "List", itemType: genericType } },
						{ name: "contentsOf", type: { type: "List", itemType: genericType } },
					],
				],
				returnType: { type: "List", itemType: genericType },
			},
		},
	}
}

export default generateType
