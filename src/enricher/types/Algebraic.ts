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
					documentation: "the Algebraic to compare with",
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description:
					"Whether the Algebraics are different numbers — exactly, no approximation is consulted.",
				parameters: {},
				returns: "`true` when the numbers differ.",
				position: null,
			},
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
			documentation: {
				description:
					"Adds a number to this Algebraic, exactly. Two Algebraics over the same radical stay in the slice; the radical parts may also cancel, leaving a Rational.",
				parameters: {},
				returns: null,
				position: null,
			},
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
			documentation: {
				description:
					"Subtracts a number from this Algebraic, exactly. Subtracting an equal radical part leaves a Rational.",
				parameters: {},
				returns: null,
				position: null,
			},
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
			documentation: {
				description:
					"Multiplies this Algebraic with a number, exactly. A radical times itself turns rational — `√2 · √2` is `2` — and multiplying by zero collapses to zero.",
				parameters: {},
				returns: null,
				position: null,
			},
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
			documentation: {
				description:
					"Divides this Algebraic by a number, exactly — via the conjugate, so dividing by an Algebraic itself can never fail. Dividing by an Integer or Rational gives `Nothing` only for zero.",
				parameters: {},
				returns: null,
				position: null,
			},
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

		absolute: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Algebraic" },
				},
			],
			returnType: { type: "Algebraic" },
			documentation: {
				description:
					"The Algebraic without its sign — its distance from zero. The sign of `a + b·√d` is exactly decidable, so no approximation is consulted.",
				parameters: {},
				returns: null,
				position: null,
			},
		},

		negated: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Algebraic" },
				},
			],
			returnType: { type: "Algebraic" },
			documentation: {
				description:
					"The Algebraic with its sign flipped. Negating an irrational leaves it irrational, so the result is again an Algebraic.",
				parameters: {},
				returns: null,
				position: null,
			},
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
