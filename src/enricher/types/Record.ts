import type { common } from "../../interfaces"

const type: common.TypeType = {
	type: "Type",
	name: "Record",
	definition: { type: "Primitive", primitive: "Record" },
	methods: {
		is: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "Primitive", primitive: "Record" },
				},
				{
					name: null,
					type: { type: "Primitive", primitive: "Record" },
				},
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
		},
		isNot: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "Primitive", primitive: "Record" },
				},
				{
					name: null,
					type: { type: "Primitive", primitive: "Record" },
				},
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
		},
		toString: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "Primitive", primitive: "Record" },
				},
			],
			returnType: { type: "Primitive", primitive: "String" },
		} as common.MethodType,
	},
}

export default type
