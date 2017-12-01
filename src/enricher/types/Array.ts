import { common } from "../../interfaces"

function generateType(genericType: common.Type): common.TypeType {
	return {
		type: "Type",
		name: "Array",
		definition: { type: "BuiltIn" },
		methods: {
			hasItems: {
				type: "Method",
				parameterTypes: [{ type: "Self" }],
				returnType: { type: "Primitive", primitive: "Boolean" },
				isStatic: false,
			},
			first: {
				type: "Method",
				parameterTypes: [{ type: "Self" }],
				returnType: genericType,
				isStatic: false,
			},
			last: {
				type: "Method",
				parameterTypes: [{ type: "Self" }],
				returnType: genericType,
				isStatic: false,
			},
			unique: {
				type: "Method",
				parameterTypes: [{ type: "Self" }],
				returnType: { type: "Self" },
				isStatic: false,
			},
			dropFirst: {
				type: "Method",
				parameterTypes: [{ type: "Self" }],
				returnType: { type: "Self" },
				isStatic: false,
			},
			dropLast: {
				type: "Method",
				parameterTypes: [{ type: "Self" }],
				returnType: { type: "Self" },
				isStatic: false,
			},
		},
	}
}

export default generateType
