import { common } from "../../interfaces"
import NumberType from "./Number"

function generateType(genericType: common.Type): common.TypeType {
	return {
		type: "Type",
		name: "Array",
		definition: { type: "BuiltIn" },
		methods: {
			hasItems: {
				type: "Method",
				parameterTypes: [{ name: null, type: { type: "Array", itemType: genericType } }],
				returnType: { type: "Primitive", primitive: "Boolean" },
				isStatic: false,
				isOverloaded: false,
			},
			first: {
				type: "Method",
				parameterTypes: [{ name: null, type: { type: "Array", itemType: genericType } }],
				returnType: genericType,
				isStatic: false,
				isOverloaded: false,
			},
			last: {
				type: "Method",
				parameterTypes: [{ name: null, type: { type: "Array", itemType: genericType } }],
				returnType: genericType,
				isStatic: false,
				isOverloaded: false,
			},
			unique: {
				type: "Method",
				parameterTypes: [{ name: null, type: { type: "Array", itemType: genericType } }],
				returnType: { type: "Array", itemType: genericType },
				isStatic: false,
				isOverloaded: false,
			},
			dropFirst: {
				type: "Method",
				parameterTypes: [{ name: null, type: { type: "Array", itemType: genericType } }],
				returnType: { type: "Array", itemType: genericType },
				isStatic: false,
				isOverloaded: false,
			},
			dropLast: {
				type: "Method",
				parameterTypes: [{ name: null, type: { type: "Array", itemType: genericType } }],
				returnType: { type: "Array", itemType: genericType },
				isStatic: false,
				isOverloaded: false,
			},
			insert: {
				type: "Method",
				parameterTypes: [
					[
						{ name: null, type: { type: "Array", itemType: genericType } },
						{ name: "item", type: genericType },
						{ name: "atIndex", type: { type: "Primitive", primitive: "Number" } },
					],
					[
						{ name: null, type: { type: "Array", itemType: genericType } },
						{ name: "contentsOf", type: { type: "Array", itemType: genericType } },
						{ name: "atIndex", type: { type: "Primitive", primitive: "Number" } },
					],
				],
				returnType: { type: "Array", itemType: genericType },
				isStatic: false,
				isOverloaded: true,
			},
			append: {
				type: "Method",
				parameterTypes: [
					[
						{ name: null, type: { type: "Array", itemType: genericType } },
						{ name: "item", type: genericType },
					],
					[
						{ name: null, type: { type: "Array", itemType: genericType } },
						{ name: "contentsOf", type: { type: "Array", itemType: genericType } },
					],
				],
				returnType: { type: "Array", itemType: genericType },
				isStatic: false,
				isOverloaded: true,
			},
		},
	}
}

export default generateType
