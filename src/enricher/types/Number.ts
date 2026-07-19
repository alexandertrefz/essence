import type { common } from "../../interfaces"

export const type: common.UnionType = {
	type: "UnionType",
	types: [{ type: "Integer" }, { type: "Fraction" }],
}

export const namespace: common.NamespaceType = {
	type: "Namespace",
	name: "Number",
	targetType: type,
	generics: [],
	properties: {
		PI: { type: "Fraction" },
		TAO: { type: "Fraction" },
	},
	methods: {
		lowestNumber: {
			type: "OverloadedStaticMethod",
			overloads: [
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Integer" },
						},
						{
							name: null,
							type: { type: "Integer" },
						},
					],
					returnType: { type: "Integer" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Fraction" },
						},
						{
							name: null,
							type: { type: "Fraction" },
						},
					],
					returnType: { type: "Fraction" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Integer" },
						},
						{
							name: null,
							type: { type: "Fraction" },
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Integer" }, { type: "Fraction" }],
					},
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Fraction" },
						},
						{
							name: null,
							type: { type: "Integer" },
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Integer" }, { type: "Fraction" }],
					},
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: {
								type: "List",
								itemType: {
									type: "Integer",
								},
							},
						},
					],
					returnType: { type: "Integer" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: {
								type: "List",
								itemType: {
									type: "Fraction",
								},
							},
						},
					],
					returnType: { type: "Fraction" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: {
								type: "List",
								itemType: {
									type: "UnionType",
									types: [
										{
											type: "Integer",
										},
										{
											type: "Fraction",
										},
									],
								},
							},
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Integer" }, { type: "Fraction" }],
					},
				},
			],
		},
		greatestNumber: {
			type: "OverloadedStaticMethod",
			overloads: [
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Integer" },
						},
						{
							name: null,
							type: { type: "Integer" },
						},
					],
					returnType: { type: "Integer" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Fraction" },
						},
						{
							name: null,
							type: { type: "Fraction" },
						},
					],
					returnType: { type: "Fraction" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Integer" },
						},
						{
							name: null,
							type: { type: "Fraction" },
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Integer" }, { type: "Fraction" }],
					},
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Fraction" },
						},
						{
							name: null,
							type: { type: "Integer" },
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Integer" }, { type: "Fraction" }],
					},
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: {
								type: "List",
								itemType: {
									type: "Integer",
								},
							},
						},
					],
					returnType: { type: "Integer" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: {
								type: "List",
								itemType: {
									type: "Fraction",
								},
							},
						},
					],
					returnType: { type: "Fraction" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: {
								type: "List",
								itemType: {
									type: "UnionType",
									types: [
										{
											type: "Integer",
										},
										{
											type: "Fraction",
										},
									],
								},
							},
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Integer" }, { type: "Fraction" }],
					},
				},
			],
		},
	},
}
