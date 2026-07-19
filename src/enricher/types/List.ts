import type { common } from "../../interfaces"
import type { GenericListType, ListType } from "../../interfaces/common"

export const type: GenericListType = {
	type: "GenericList",
	generics: [{ name: "ItemType", defaultType: { type: "Unknown" } }],
}

const typeResolvedWithGenericUse: ListType = {
	type: "List",
	itemType: { type: "GenericUse", name: "ItemType" },
}

// TODO: Add a slice method
// TODO: Add get methods for the generic case and filtered case
// TODO: Add a map method
// TODO: Add a reduce method
const namespaceDefinition: common.NamespaceType = {
	type: "Namespace",
	name: "List",
	generics: [{ name: "ItemType", defaultType: null, infer: true }],
	targetType: typeResolvedWithGenericUse,
	properties: {},
	methods: {
		is: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: typeResolvedWithGenericUse,
				},
				{
					name: null,
					type: typeResolvedWithGenericUse,
				},
			],
			returnType: { type: "Boolean" },
		},
		isNot: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: typeResolvedWithGenericUse,
				},
				{
					name: null,
					type: typeResolvedWithGenericUse,
				},
			],
			returnType: { type: "Boolean" },
		},
		length: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: typeResolvedWithGenericUse,
				},
			],
			returnType: { type: "Integer" },
		},
		hasItems: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: typeResolvedWithGenericUse,
				},
			],
			returnType: { type: "Boolean" },
		},
		isEmpty: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: typeResolvedWithGenericUse,
				},
			],
			returnType: { type: "Boolean" },
		},
		contains: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: typeResolvedWithGenericUse,
				},
				{
					name: null,
					type: { type: "GenericUse", name: "ItemType" },
				},
			],
			returnType: { type: "Boolean" },
		},
		doesNotContain: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: typeResolvedWithGenericUse,
				},
				{
					name: null,
					type: { type: "GenericUse", name: "ItemType" },
				},
			],
			returnType: { type: "Boolean" },
		},
		firstItem: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: typeResolvedWithGenericUse,
				},
			],
			returnType: {
				type: "UnionType",
				types: [
					{ type: "GenericUse", name: "ItemType" },
					{ type: "Nothing" },
				],
			},
		},
		lastItem: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: typeResolvedWithGenericUse,
				},
			],
			returnType: {
				type: "UnionType",
				types: [
					{ type: "GenericUse", name: "ItemType" },
					{ type: "Nothing" },
				],
			},
		},
		removeFirst: {
			type: "OverloadedMethod",
			overloads: [
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: typeResolvedWithGenericUse,
						},
					],
					returnType: typeResolvedWithGenericUse,
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: typeResolvedWithGenericUse,
						},
						{
							name: null,
							type: {
								type: "Integer",
							},
						},
					],
					returnType: typeResolvedWithGenericUse,
				},
			],
		},
		removeAt: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: typeResolvedWithGenericUse,
				},
				{
					name: null,
					type: { type: "Integer" },
				},
			],
			returnType: typeResolvedWithGenericUse,
		},
		removeEvery: {
			type: "OverloadedMethod",
			overloads: [
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: typeResolvedWithGenericUse,
						},
						{
							name: null,
							type: { type: "GenericUse", name: "ItemType" },
						},
					],
					returnType: typeResolvedWithGenericUse,
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: typeResolvedWithGenericUse,
						},
						{
							name: "where",
							type: {
								type: "Function",
								generics: [],
								parameterTypes: [
									{
										name: null,
										type: {
											type: "GenericUse",
											name: "ItemType",
										},
									},
								],
								returnType: {
									type: "Boolean",
								},
							},
						},
					],
					returnType: typeResolvedWithGenericUse,
				},
			],
		},
		removeLast: {
			type: "OverloadedMethod",
			overloads: [
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: typeResolvedWithGenericUse,
						},
					],
					returnType: typeResolvedWithGenericUse,
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: typeResolvedWithGenericUse,
						},
						{
							name: null,
							type: {
								type: "Integer",
							},
						},
					],
					returnType: typeResolvedWithGenericUse,
				},
			],
		},
		removeDuplicates: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: typeResolvedWithGenericUse,
				},
			],
			returnType: typeResolvedWithGenericUse,
		},
		prepend: {
			type: "OverloadedMethod",
			overloads: [
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: typeResolvedWithGenericUse,
						},
						{
							name: null,
							type: { type: "GenericUse", name: "ItemType" },
						},
					],
					returnType: typeResolvedWithGenericUse,
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: typeResolvedWithGenericUse,
						},
						{
							name: "contentsOf",
							type: typeResolvedWithGenericUse,
						},
					],
					returnType: typeResolvedWithGenericUse,
				},
			],
		},
		append: {
			type: "OverloadedMethod",
			overloads: [
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: typeResolvedWithGenericUse,
						},
						{
							name: null,
							type: { type: "GenericUse", name: "ItemType" },
						},
					],
					returnType: typeResolvedWithGenericUse,
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: typeResolvedWithGenericUse,
						},
						{
							name: "contentsOf",
							type: typeResolvedWithGenericUse,
						},
					],
					returnType: typeResolvedWithGenericUse,
				},
			],
		},
	},
}

// NOTE: The Namespace-level `ItemType` Generic is merged into every Method
// signature, so that each signature is self-contained for inference — a
// Method looked up as a value re-infers `ItemType` from its receiver
// argument.
for (let method of Object.values(namespaceDefinition.methods)) {
	if (method.type === "SimpleMethod" || method.type === "StaticMethod") {
		method.generics = [...namespaceDefinition.generics, ...method.generics]
	} else {
		for (let overload of method.overloads) {
			overload.generics = [
				...namespaceDefinition.generics,
				...overload.generics,
			]
		}
	}
}

export const namespace = namespaceDefinition
