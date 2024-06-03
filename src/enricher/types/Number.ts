import type { common } from "../../interfaces"

export const type: common.Type = {
	type: "UnionType",
	types: [
		{ type: "Primitive", primitive: "Integer" },
		{ type: "Primitive", primitive: "Fraction" },
	],
}

export const namespace: common.NamespaceType = {
	type: "Namespace",
	name: "Number",
	targetType: type,
	definition: {
		type: "Record",
		members: {
			PI: { type: "Primitive", primitive: "Fraction" },
			TAO: { type: "Primitive", primitive: "Fraction" },
		},
	},
	methods: {
		lowestNumber: {
			type: "OverloadedStaticMethod",
			overloads: [
				{
					parameterTypes: [
						{
							name: null,
							type: { type: "Primitive", primitive: "Integer" },
						},
						{
							name: null,
							type: { type: "Primitive", primitive: "Integer" },
						},
					],
					returnType: { type: "Primitive", primitive: "Integer" },
				},
				{
					parameterTypes: [
						{
							name: null,
							type: { type: "Primitive", primitive: "Fraction" },
						},
						{
							name: null,
							type: { type: "Primitive", primitive: "Fraction" },
						},
					],
					returnType: { type: "Primitive", primitive: "Fraction" },
				},
				{
					parameterTypes: [
						{
							name: null,
							type: { type: "Primitive", primitive: "Integer" },
						},
						{
							name: null,
							type: { type: "Primitive", primitive: "Fraction" },
						},
					],
					returnType: {
						type: "UnionType",
						types: [
							{ type: "Primitive", primitive: "Integer" },
							{ type: "Primitive", primitive: "Fraction" },
						],
					},
				},
				{
					parameterTypes: [
						{
							name: null,
							type: { type: "Primitive", primitive: "Fraction" },
						},
						{
							name: null,
							type: { type: "Primitive", primitive: "Integer" },
						},
					],
					returnType: {
						type: "UnionType",
						types: [
							{ type: "Primitive", primitive: "Integer" },
							{ type: "Primitive", primitive: "Fraction" },
						],
					},
				},
				{
					parameterTypes: [
						{
							name: null,
							type: {
								type: "List",
								itemType: {
									type: "Primitive",
									primitive: "Integer",
								},
							},
						},
					],
					returnType: { type: "Primitive", primitive: "Integer" },
				},
				{
					parameterTypes: [
						{
							name: null,
							type: {
								type: "List",
								itemType: {
									type: "Primitive",
									primitive: "Fraction",
								},
							},
						},
					],
					returnType: { type: "Primitive", primitive: "Fraction" },
				},
				{
					parameterTypes: [
						{
							name: null,
							type: {
								type: "List",
								itemType: {
									type: "UnionType",
									types: [
										{
											type: "Primitive",
											primitive: "Integer",
										},
										{
											type: "Primitive",
											primitive: "Fraction",
										},
									],
								},
							},
						},
					],
					returnType: {
						type: "UnionType",
						types: [
							{ type: "Primitive", primitive: "Integer" },
							{ type: "Primitive", primitive: "Fraction" },
						],
					},
				},
			],
		},
		greatestNumber: {
			type: "OverloadedStaticMethod",
			overloads: [
				{
					parameterTypes: [
						{
							name: null,
							type: { type: "Primitive", primitive: "Integer" },
						},
						{
							name: null,
							type: { type: "Primitive", primitive: "Integer" },
						},
					],
					returnType: { type: "Primitive", primitive: "Integer" },
				},
				{
					parameterTypes: [
						{
							name: null,
							type: { type: "Primitive", primitive: "Fraction" },
						},
						{
							name: null,
							type: { type: "Primitive", primitive: "Fraction" },
						},
					],
					returnType: { type: "Primitive", primitive: "Fraction" },
				},
				{
					parameterTypes: [
						{
							name: null,
							type: { type: "Primitive", primitive: "Integer" },
						},
						{
							name: null,
							type: { type: "Primitive", primitive: "Fraction" },
						},
					],
					returnType: {
						type: "UnionType",
						types: [
							{ type: "Primitive", primitive: "Integer" },
							{ type: "Primitive", primitive: "Fraction" },
						],
					},
				},
				{
					parameterTypes: [
						{
							name: null,
							type: { type: "Primitive", primitive: "Fraction" },
						},
						{
							name: null,
							type: { type: "Primitive", primitive: "Integer" },
						},
					],
					returnType: {
						type: "UnionType",
						types: [
							{ type: "Primitive", primitive: "Integer" },
							{ type: "Primitive", primitive: "Fraction" },
						],
					},
				},
				{
					parameterTypes: [
						{
							name: null,
							type: {
								type: "List",
								itemType: {
									type: "Primitive",
									primitive: "Integer",
								},
							},
						},
					],
					returnType: { type: "Primitive", primitive: "Integer" },
				},
				{
					parameterTypes: [
						{
							name: null,
							type: {
								type: "List",
								itemType: {
									type: "Primitive",
									primitive: "Fraction",
								},
							},
						},
					],
					returnType: { type: "Primitive", primitive: "Fraction" },
				},
				{
					parameterTypes: [
						{
							name: null,
							type: {
								type: "List",
								itemType: {
									type: "UnionType",
									types: [
										{
											type: "Primitive",
											primitive: "Integer",
										},
										{
											type: "Primitive",
											primitive: "Fraction",
										},
									],
								},
							},
						},
					],
					returnType: {
						type: "UnionType",
						types: [
							{ type: "Primitive", primitive: "Integer" },
							{ type: "Primitive", primitive: "Fraction" },
						],
					},
				},
			],
		},
	},
}
