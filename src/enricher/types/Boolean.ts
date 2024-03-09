import type { common } from "../../interfaces"

const type: common.TypeType = {
	type: "Type",
	name: "Boolean",
	definition: { type: "Primitive", primitive: "Boolean" },
	methods: {
		negate: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "Primitive", primitive: "Boolean" },
				},
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
		},
		is: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "Primitive", primitive: "Boolean" },
				},
				{
					name: null,
					type: { type: "Primitive", primitive: "Boolean" },
				},
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
		},
		isNot: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "Primitive", primitive: "Boolean" },
				},
				{
					name: null,
					type: { type: "Primitive", primitive: "Boolean" },
				},
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
		},
		and: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "Primitive", primitive: "Boolean" },
				},
				{
					name: null,
					type: { type: "Primitive", primitive: "Boolean" },
				},
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
		},
		or: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "Primitive", primitive: "Boolean" },
				},
				{
					name: null,
					type: { type: "Primitive", primitive: "Boolean" },
				},
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
		},
		toString: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: { type: "Primitive", primitive: "Boolean" },
				},
			],
			returnType: { type: "Primitive", primitive: "String" },
		} as common.MethodType,
	},
}

export default type
