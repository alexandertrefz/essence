import type { common } from "../../interfaces/index"
import { type as orderingType } from "./Ordering"

export const type: common.AlgebraicType = { type: "Algebraic" }

const rationalOrAlgebraicOrNothing: common.Type = {
	type: "UnionType",
	types: [{ type: "Rational" }, { type: "Algebraic" }, { type: "Nothing" }],
}

// NOTE: A real algebraic irrational — for now the quadratic slice
// `a + b·√d`. Every guarantee is exact: equality and ordering are decided
// symbolically, never by approximation, which is why Algebraic conforms to
// Comparable while Transcendental does not.
export const namespace: common.NamespaceType = {
	type: "Namespace",
	name: "Algebraic",
	generics: [],
	targetType: type,
	conformsTo: ["Equatable", "Printable", "Comparable"],
	properties: {},
	methods: {
		is: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Algebraic" },
				},
				{
					name: null,
					type: { type: "Algebraic" },
					documentation: "the Algebraic to compare with",
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description:
					"Whether both Algebraics are the same number.\n\nNormal forms make this exact — no approximation is consulted.",
				parameters: {},
				returns: "`true` when the numbers are equal.",
				position: null,
			},
		},

		isNot: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Algebraic" },
				},
				{
					name: null,
					type: { type: "Algebraic" },
				},
			],
			returnType: { type: "Boolean" },
		},

		compareTo: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Algebraic" },
				},
				{
					name: null,
					type: { type: "Algebraic" },
					documentation: "the Algebraic to order against",
				},
			],
			returnType: orderingType,
			documentation: {
				description:
					"Orders the Algebraic against another Algebraic — exactly, by symbolic comparison.",
				parameters: {},
				returns:
					"`Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.",
				position: null,
			},
		},

		add: {
			type: "OverloadedMethod",
			overloads: [
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Algebraic" },
						},
						{
							name: null,
							type: { type: "Integer" },
						},
					],
					returnType: { type: "Algebraic" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Algebraic" },
						},
						{
							name: null,
							type: { type: "Rational" },
						},
					],
					returnType: { type: "Algebraic" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Algebraic" },
						},
						{
							name: null,
							type: { type: "Algebraic" },
						},
					],
					returnType: rationalOrAlgebraicOrNothing,
					documentation: {
						description:
							"Adds another Algebraic. Over the same radical the sum stays exact — and may collapse to a Rational. Over different radicals the sum is not representable yet and gives Nothing.",
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
							type: { type: "Algebraic" },
						},
						{
							name: null,
							type: { type: "Integer" },
						},
					],
					returnType: { type: "Algebraic" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Algebraic" },
						},
						{
							name: null,
							type: { type: "Rational" },
						},
					],
					returnType: { type: "Algebraic" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Algebraic" },
						},
						{
							name: null,
							type: { type: "Algebraic" },
						},
					],
					returnType: rationalOrAlgebraicOrNothing,
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
							type: { type: "Algebraic" },
						},
						{
							name: null,
							type: { type: "Integer" },
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Algebraic" }, { type: "Rational" }],
					},
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Algebraic" },
						},
						{
							name: null,
							type: { type: "Rational" },
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Algebraic" }, { type: "Rational" }],
					},
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Algebraic" },
						},
						{
							name: null,
							type: { type: "Algebraic" },
						},
					],
					returnType: rationalOrAlgebraicOrNothing,
					documentation: {
						description:
							"Multiplies with another Algebraic. Over the same radical the product stays exact — √2·√2 is exactly 2. Products of pure radicals combine across radicals (√2·√3 is √6); anything else gives Nothing.",
						parameters: {},
						returns: null,
						position: null,
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
							type: { type: "Algebraic" },
						},
						{
							name: null,
							type: { type: "Integer" },
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Algebraic" }, { type: "Nothing" }],
					},
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Algebraic" },
						},
						{
							name: null,
							type: { type: "Rational" },
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Algebraic" }, { type: "Nothing" }],
					},
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Algebraic" },
						},
						{
							name: null,
							type: { type: "Algebraic" },
						},
					],
					returnType: rationalOrAlgebraicOrNothing,
				},
			],
		},

		toString: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Algebraic" },
				},
			],
			returnType: { type: "String" },
			documentation: {
				description:
					"The exact symbolic form — `√2`, `3·√2` or `1 + √2`.",
				parameters: {},
				returns: null,
				position: null,
			},
		} as common.MethodType,
	},
}
