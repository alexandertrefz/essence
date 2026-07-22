import { optionalOf } from "../../helpers/index"
import type { common } from "../../interfaces/index"
import { type as orderingType } from "./Ordering"

export const type: common.IntegerType = { type: "Integer" }

export const namespace: common.NamespaceType = {
	type: "Namespace",
	name: "Integer",
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
					type: { type: "Integer" },
				},
				{
					name: null,
					type: { type: "Integer" },
					documentation: "the Integer to compare against",
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description:
					"Checks whether the Integer has the same value as another.",
				parameters: {},
				returns: "`true` when both are equal.",
				position: null,
			},
		},

		isNot: {
			type: "SimpleMethod",
			generics: [],

			parameterTypes: [
				{
					name: null,
					type: { type: "Integer" },
				},
				{
					name: null,
					type: { type: "Integer" },
					documentation: "the Integer to compare against",
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description:
					"Checks whether the Integer has a different value than another.",
				parameters: {},
				returns: "`true` when the two differ.",
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
							type: { type: "Integer" },
						},
						{
							name: null,
							type: { type: "Integer" },
							documentation: "the Integer to add",
						},
					],
					returnType: { type: "Integer" },
					documentation: {
						description: "Adds two Integers, giving an Integer.",
						parameters: {},
						returns: null,
						position: null,
					},
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
							type: { type: "Rational" },
							documentation: "the Rational to add",
						},
					],
					returnType: { type: "Rational" },
					documentation: {
						description:
							"Adds a Rational to an Integer. The result is a Rational, since the sum need not be whole.",
						parameters: {},
						returns: null,
						position: null,
					},
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
							type: { type: "Algebraic" },
							documentation: "the Algebraic to add",
						},
					],
					returnType: { type: "Algebraic" },
					documentation: {
						description:
							"Adds an Algebraic to an Integer. Shifting the rational part of `a + b·√d` leaves the radical untouched, so the sum is exact.",
						parameters: {},
						returns: null,
						position: null,
					},
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
							type: { type: "Transcendental" },
							documentation: "the Transcendental to add",
						},
					],
					returnType: { type: "Transcendental" },
					documentation: {
						description:
							"Adds a Transcendental to an Integer. Shifting the rational part of `a + b·π` leaves the π term untouched, so the sum is exact.",
						parameters: {},
						returns: null,
						position: null,
					},
				},
			],
			documentation: {
				description: "Adds a number to this Integer.",
				parameters: {},
				returns: null,
				position: null,
			},
		},

		subtract: {
			type: "OverloadedMethod",
			documentation: {
				description:
					"Subtracts a number from this Integer, staying exact for every member of the numeric tower.",
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
							type: { type: "Integer" },
						},
						{
							name: null,
							type: { type: "Rational" },
						},
					],
					returnType: { type: "Rational" },
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
							type: { type: "Algebraic" },
						},
					],
					returnType: { type: "Algebraic" },
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
							type: { type: "Transcendental" },
						},
					],
					returnType: { type: "Transcendental" },
				},
			],
		},

		divideBy: {
			type: "OverloadedMethod",
			documentation: {
				description:
					"Divides this Integer by a number, exactly. Dividing by a possibly-zero Integer or Rational gives `Nothing` for zero; dividing by an Algebraic can never fail — an irrational is never zero.",
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
							type: { type: "Integer" },
						},
						{
							name: null,
							type: { type: "Integer" },
						},
					],
					returnType: optionalOf({ type: "Rational" }),
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
							type: { type: "Rational" },
						},
					],
					returnType: optionalOf({ type: "Rational" }),
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
							type: { type: "Algebraic" },
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Algebraic" }, { type: "Rational" }],
					},
				},
			],
		},

		multiplyWith: {
			type: "OverloadedMethod",
			documentation: {
				description:
					"Multiplies this Integer with a number, staying exact for every member of the numeric tower.",
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
							type: { type: "Integer" },
						},
						{
							name: null,
							type: { type: "Rational" },
						},
					],
					returnType: { type: "Rational" },
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
							type: { type: "Algebraic" },
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
							type: { type: "Integer" },
						},
						{
							name: null,
							type: { type: "Transcendental" },
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

		isLessThan: {
			type: "OverloadedMethod",
			documentation: {
				description:
					"Whether this Integer is strictly below the given number.",
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
							type: { type: "Integer" },
						},
						{
							name: null,
							type: { type: "Integer" },
						},
					],
					returnType: { type: "Boolean" },
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
							type: { type: "Rational" },
						},
					],
					returnType: { type: "Boolean" },
				},
			],
		},

		isLessThanOrEqualTo: {
			type: "OverloadedMethod",
			documentation: {
				description:
					"Whether this Integer is below the given number, or equal to it.",
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
							type: { type: "Integer" },
						},
						{
							name: null,
							type: { type: "Integer" },
						},
					],
					returnType: { type: "Boolean" },
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
							type: { type: "Rational" },
						},
					],
					returnType: { type: "Boolean" },
				},
			],
		},

		isGreaterThan: {
			type: "OverloadedMethod",
			documentation: {
				description:
					"Whether this Integer is strictly above the given number.",
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
							type: { type: "Integer" },
						},
						{
							name: null,
							type: { type: "Integer" },
						},
					],
					returnType: { type: "Boolean" },
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
							type: { type: "Rational" },
						},
					],
					returnType: { type: "Boolean" },
				},
			],
		},

		isGreaterThanOrEqualTo: {
			type: "OverloadedMethod",
			documentation: {
				description:
					"Whether this Integer is above the given number, or equal to it.",
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
							type: { type: "Integer" },
						},
						{
							name: null,
							type: { type: "Integer" },
						},
					],
					returnType: { type: "Boolean" },
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
							type: { type: "Rational" },
						},
					],
					returnType: { type: "Boolean" },
				},
			],
		},

		squareRoot: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Integer" },
				},
			],
			returnType: optionalOf({
				type: "UnionType",
				types: [{ type: "Integer" }, { type: "Algebraic" }],
			}),
			documentation: {
				description:
					"The exact square root. A perfect square gives a Integer; any other non-negative value gives an exact Algebraic — and a negative gives Nothing.",
				parameters: {},
				returns: null,
				position: null,
			},
		},

		absolute: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Integer" },
				},
			],
			returnType: { type: "Integer" },
			documentation: {
				description:
					"The Integer without its sign — its distance from zero.",
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
					type: { type: "Integer" },
				},
			],
			returnType: { type: "Integer" },
			documentation: {
				description: "The Integer with its sign flipped.",
				parameters: {},
				returns: null,
				position: null,
			},
		},

		isEven: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Integer" },
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description:
					"Whether the Integer is divisible by two. Zero is even.",
				parameters: {},
				returns: null,
				position: null,
			},
		},

		isOdd: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Integer" },
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description: "Whether the Integer is not divisible by two.",
				parameters: {},
				returns: null,
				position: null,
			},
		},

		isPositive: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Integer" },
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description:
					"Whether the Integer is above zero. Zero is neither positive nor negative.",
				parameters: {},
				returns: null,
				position: null,
			},
		},

		isNegative: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Integer" },
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description:
					"Whether the Integer is below zero. Zero is neither positive nor negative.",
				parameters: {},
				returns: null,
				position: null,
			},
		},

		isZero: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Integer" },
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description: "Whether the Integer is exactly zero.",
				parameters: {},
				returns: null,
				position: null,
			},
		},

		remainderOf: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Integer" },
				},
				{
					name: "dividingBy",
					type: { type: "Integer" },
					documentation: "the divisor",
				},
			],
			returnType: optionalOf({ type: "Integer" }),
			documentation: {
				description:
					"The remainder of Euclidean division — always at least zero and below the divisor's magnitude, whatever the signs of the operands. `(0 - 7)::remainderOf(dividingBy 3)` is `2`.",
				parameters: {},
				returns: "the remainder, or `Nothing` when dividing by zero.",
				position: null,
			},
		},

		toThePowerOf: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Integer" },
				},
				{
					name: null,
					type: { type: "Integer" },
					documentation: "the exponent",
				},
			],
			returnType: optionalOf({
				type: "UnionType",
				types: [{ type: "Integer" }, { type: "Rational" }],
			}),
			documentation: {
				description:
					"Raises the Integer to the given power. A non-negative exponent gives an Integer, a negative one the exact reciprocal as a Rational. Zero to the power of zero is one.",
				parameters: {},
				returns:
					"the power, or `Nothing` when raising zero to a negative power.",
				position: null,
			},
		},

		clampedBetween: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Integer" },
				},
				{
					name: null,
					type: { type: "Integer" },
					documentation: "the lowest allowed value",
				},
				{
					name: "and",
					type: { type: "Integer" },
					documentation: "the highest allowed value",
				},
			],
			returnType: optionalOf({ type: "Integer" }),
			documentation: {
				description:
					"The Integer, pulled into the given bounds — the lower bound when below it, the upper when above it, itself otherwise.",
				parameters: {},
				returns:
					"the clamped Integer, or `Nothing` when the bounds are in the wrong order.",
				position: null,
			},
		},

		parse: {
			type: "StaticMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "String" },
					documentation: "the text to read",
				},
			],
			returnType: optionalOf({ type: "Integer" }),
			documentation: {
				description:
					"Reads an Integer from its text form — an optional minus sign followed by digits, the same shape `toString` produces.",
				parameters: {},
				returns:
					"the Integer, or `Nothing` when the text has any other shape.",
				position: null,
			},
		},

		toString: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Integer" },
				},
			],
			returnType: { type: "String" },
			documentation: {
				description:
					"Represents the Integer as a String, in decimal digits.",
				parameters: {},
				returns: null,
				position: null,
			},
		} as common.MethodType,
		compareTo: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Integer" },
				},
				{
					name: null,
					type: { type: "Integer" },
					documentation: "the Integer to order against",
				},
			],
			returnType: orderingType,
			documentation: {
				description: "Orders the Integer against another Integer.",
				parameters: {},
				returns:
					"`Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.",
				position: null,
			},
		},
	},
}
