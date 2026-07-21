import type { common } from "../../interfaces/index"

export const type: common.TranscendentalType = { type: "Transcendental" }

// NOTE: A number that is provably not algebraic — for now the linear-in-π
// slice `a + b·π`, which is how PI and TAU stay exact. `is` means equality of
// canonical forms: reflexive and sound, and within this grammar it coincides
// with numeric equality. Transcendental deliberately does NOT conform to
// Comparable — deciding `Ordering#Equal` is undecidable for transcendentals
// in general — but every cross-kind comparison is total through the `Number`
// Namespace, whose covering `compareTo` hand-writes those cells.
export const namespace: common.NamespaceType = {
	type: "Namespace",
	name: "Transcendental",
	generics: [],
	targetType: type,
	conformsTo: ["Equatable", "Printable"],
	properties: {},
	methods: {
		is: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Transcendental" },
				},
				{
					name: null,
					type: { type: "Transcendental" },
					documentation: "the Transcendental to compare with",
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description:
					"Whether both Transcendentals have the same canonical form.\n\nWithin the current grammar this is exactly numeric equality.",
				parameters: {},
				returns: "`true` when the canonical forms agree.",
				position: null,
			},
		},

		isNot: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Transcendental" },
				},
				{
					name: null,
					type: { type: "Transcendental" },
				},
			],
			returnType: { type: "Boolean" },
		},

		add: {
			type: "OverloadedMethod",
			overloads: [
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Transcendental" },
						},
						{
							name: null,
							type: { type: "Integer" },
						},
					],
					returnType: { type: "Transcendental" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Transcendental" },
						},
						{
							name: null,
							type: { type: "Rational" },
						},
					],
					returnType: { type: "Transcendental" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Transcendental" },
						},
						{
							name: null,
							type: { type: "Transcendental" },
						},
					],
					returnType: {
						type: "UnionType",
						types: [
							{ type: "Rational" },
							{ type: "Transcendental" },
						],
					},
					documentation: {
						description:
							"Adds another Transcendental — the π-parts may cancel, collapsing the sum to a Rational.",
						parameters: {},
						returns: null,
						position: null,
					},
				},
			],
		},

		subtract: {
			type: "OverloadedMethod",
			overloads: [
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Transcendental" },
						},
						{
							name: null,
							type: { type: "Integer" },
						},
					],
					returnType: { type: "Transcendental" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Transcendental" },
						},
						{
							name: null,
							type: { type: "Rational" },
						},
					],
					returnType: { type: "Transcendental" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Transcendental" },
						},
						{
							name: null,
							type: { type: "Transcendental" },
						},
					],
					returnType: {
						type: "UnionType",
						types: [
							{ type: "Rational" },
							{ type: "Transcendental" },
						],
					},
				},
			],
		},

		multiplyWith: {
			type: "OverloadedMethod",
			overloads: [
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Transcendental" },
						},
						{
							name: null,
							type: { type: "Integer" },
						},
					],
					returnType: {
						type: "UnionType",
						types: [
							{ type: "Transcendental" },
							{ type: "Rational" },
						],
					},
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Transcendental" },
						},
						{
							name: null,
							type: { type: "Rational" },
						},
					],
					returnType: {
						type: "UnionType",
						types: [
							{ type: "Transcendental" },
							{ type: "Rational" },
						],
					},
				},
			],
		},

		divideBy: {
			type: "OverloadedMethod",
			overloads: [
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Transcendental" },
						},
						{
							name: null,
							type: { type: "Integer" },
						},
					],
					returnType: {
						type: "UnionType",
						types: [
							{ type: "Transcendental" },
							{ type: "Nothing" },
						],
					},
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Transcendental" },
						},
						{
							name: null,
							type: { type: "Rational" },
						},
					],
					returnType: {
						type: "UnionType",
						types: [
							{ type: "Transcendental" },
							{ type: "Nothing" },
						],
					},
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Transcendental" },
						},
						{
							name: null,
							type: { type: "Transcendental" },
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Rational" }, { type: "Nothing" }],
					},
					documentation: {
						description:
							"Divides by another Transcendental. Proportional values give an exact Rational — TAU divided by PI is exactly 2. Anything else is not representable yet and gives Nothing.",
						parameters: {},
						returns: null,
						position: null,
					},
				},
			],
		},

		toString: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Transcendental" },
				},
			],
			returnType: { type: "String" },
			documentation: {
				description: "The exact symbolic form — `π`, `2·π` or `1 + π`.",
				parameters: {},
				returns: null,
				position: null,
			},
		} as common.MethodType,
	},
}
