import type { common } from "../../interfaces"

const type: common.GenericTypeType = {
	type: "GenericType",
	name: "List",
	definition: { type: "BuiltIn" },
	generics: [{ name: "ItemType", defaultType: { type: "Unknown" } }],
	methods: {
		is: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: {
						type: "List",
						itemType: { type: "Generic", name: "ItemType" },
					},
				},
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
		isNot: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: {
						type: "List",
						itemType: { type: "Generic", name: "ItemType" },
					},
				},
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
		length: {
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
			returnType: { type: "Primitive", primitive: "Integer" },
		},
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
		isEmpty: {
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
		contains: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: {
						type: "List",
						itemType: { type: "Generic", name: "ItemType" },
					},
				},
				{
					name: null,
					type: { type: "Generic", name: "ItemType" },
				},
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
		},
		doesNotContain: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: {
						type: "List",
						itemType: { type: "Generic", name: "ItemType" },
					},
				},
				{
					name: null,
					type: { type: "Generic", name: "ItemType" },
				},
			],
			returnType: { type: "Primitive", primitive: "Boolean" },
		},
		firstItem: {
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
		lastItem: {
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
		removeFirst: {
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
							name: null,
							type: {
								type: "Primitive",
								primitive: "Integer",
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
		removeAt: {
			type: "SimpleMethod",
			parameterTypes: [
				{
					name: null,
					type: {
						type: "List",
						itemType: { type: "Generic", name: "ItemType" },
					},
				},
				{
					name: null,
					type: { type: "Primitive", primitive: "Integer" },
				},
			],
			returnType: {
				type: "List",
				itemType: { type: "Generic", name: "ItemType" },
			},
		},
		removeEvery: {
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
						{
							name: null,
							type: { type: "Generic", name: "ItemType" },
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
							name: "where",
							type: {
								type: "Function",
								parameterTypes: [
									{
										name: null,
										type: {
											type: "Generic",
											name: "ItemType",
										},
									},
								],
								returnType: {
									type: "Primitive",
									primitive: "Boolean",
								},
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
		removeLast: {
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
							name: null,
							type: {
								type: "Primitive",
								primitive: "Integer",
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
		removeDuplicates: {
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
		prepend: {
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
						{
							name: null,
							type: { type: "Generic", name: "ItemType" },
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
						{
							name: null,
							type: { type: "Generic", name: "ItemType" },
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
