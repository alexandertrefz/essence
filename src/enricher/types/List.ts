import { common } from "../../interfaces"

const type: common.GenericTypeType = {
	type: "GenericType",
	name: "List",
	definition: { type: "BuiltIn" },
	generics: [{ name: "ItemType", defaultType: { type: "Unknown" } }],
	methods: {
		hasItems: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: {
						type: "List",
						itemType: { type: "Generic", name: "ItemType" },
					},
				},
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
		},
		first: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: {
						type: "List",
						itemType: { type: "Generic", name: "ItemType" },
					},
				},
			],
			returnType: {
				type: "UnionType",
				types: [
					{ type: "Generic", name: "ItemType" },
					{ type: "Primitive", primitive: "Nothing" },
				],
			},
		},
		last: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: {
						type: "List",
						itemType: { type: "Generic", name: "ItemType" },
					},
				},
			],
			returnType: {
				type: "UnionType",
				types: [
					{ type: "Generic", name: "ItemType" },
					{ type: "Primitive", primitive: "Nothing" },
				],
			},
		},
		unique: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: {
						type: "List",
						itemType: { type: "Generic", name: "ItemType" },
					},
				},
			],
			returnType: {
				type: "List",
				itemType: { type: "Generic", name: "ItemType" },
			},
		},
		dropFirst: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: {
						type: "List",
						itemType: { type: "Generic", name: "ItemType" },
					},
				},
			],
			returnType: {
				type: "List",
				itemType: { type: "Generic", name: "ItemType" },
			},
		},
		dropLast: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: {
						type: "List",
						itemType: { type: "Generic", name: "ItemType" },
					},
				},
			],
			returnType: {
				type: "List",
				itemType: { type: "Generic", name: "ItemType" },
			},
		},
		insert: {
			type: "OverloadedMethod",
			overloads: [
				{
					parameterTypes: [
						{
							name: null,
							type: {
								type: "List",
								itemType: { type: "Generic", name: "ItemType" },
							},
						},
						{ name: null, type: { type: "Generic", name: "ItemType" } },
						{
							name: "atIndex",
							type: { type: "Primitive", primitive: "Integer" },
						},
					],
					returnType: {
						type: "List",
						itemType: { type: "Generic", name: "ItemType" },
					},
				},
				{
					parameterTypes: [
						{
							name: null,
							type: {
								type: "List",
								itemType: { type: "Generic", name: "ItemType" },
							},
						},
						{
							name: "contentsOf",
							type: {
								type: "List",
								itemType: { type: "Generic", name: "ItemType" },
							},
						},
						{
							name: "atIndex",
							type: { type: "Primitive", primitive: "Integer" },
						},
					],

					returnType: {
						type: "List",
						itemType: { type: "Generic", name: "ItemType" },
					},
				},
			],
		},
		append: {
			type: "OverloadedMethod",
			overloads: [
				{
					parameterTypes: [
						{
							name: null,
							type: {
								type: "List",
								itemType: { type: "Generic", name: "ItemType" },
							},
						},
						{ name: null, type: { type: "Generic", name: "ItemType" } },
					],
					returnType: {
						type: "List",
						itemType: { type: "Generic", name: "ItemType" },
					},
				},
				{
					parameterTypes: [
						{
							name: null,
							type: {
								type: "List",
								itemType: { type: "Generic", name: "ItemType" },
							},
						},
						{
							name: "contentsOf",
							type: {
								type: "List",
								itemType: { type: "Generic", name: "ItemType" },
							},
						},
					],
					returnType: {
						type: "List",
						itemType: { type: "Generic", name: "ItemType" },
					},
				},
			],
		},
	},
}

export default type
