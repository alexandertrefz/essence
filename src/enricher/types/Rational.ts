import { optionalOf } from "../../helpers/index"
import type { common } from "../../interfaces/index"
import { type as orderingType } from "./Ordering"

export const type: common.RationalType = { type: "Rational" }

export const namespace: common.NamespaceType = {
	type: "Namespace",
	name: "Rational",
	generics: [],
	targetType: type,
	conformsTo: ["Equatable", "Printable", "Comparable"],
	properties: {},
	methods: {
		of: {
			type: "StaticMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Integer" },
					documentation: "the numerator",
				},
				{
					name: "over",
					type: { type: "Integer" },
					documentation: "the denominator",
				},
			],
			returnType: optionalOf({ type: "Rational" }),
			documentation: {
				description:
					"Builds the Rational one Integer over another — the way to write a ratio of computed values, where the literal form `3/4` is not available.",
				parameters: {},
				returns:
					"the Rational, or `Nothing` when the denominator is zero.",
				position: null,
			},
		},

		is: {
			type: "SimpleMethod",
			generics: [],

			parameterTypes: [
				{
					name: null,
					type: { type: "Rational" },
				},
				{
					name: null,
					type: { type: "Rational" },
					documentation: "the Rational to compare against",
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description:
					"Checks whether the Rational has the same value as another — compared in lowest terms, so `1/2 is 2/4` holds.",
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
					type: { type: "Rational" },
				},
				{
					name: null,
					type: { type: "Rational" },
					documentation: "the Rational to compare against",
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description:
					"Checks whether the Rational has a different value than another.",
				parameters: {},
				returns: "`true` when the two differ.",
				position: null,
			},
		},

		add: {
			type: "OverloadedMethod",
			documentation: {
				description:
					"Adds a number to this Rational, staying exact for every member of the numeric tower.",
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
							type: { type: "Rational" },
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
							type: { type: "Rational" },
						},
						{
							name: null,
							type: { type: "Integer" },
						},
					],
					returnType: { type: "Rational" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Rational" },
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
							type: { type: "Rational" },
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

		subtract: {
			type: "OverloadedMethod",
			documentation: {
				description:
					"Subtracts a number from this Rational, staying exact for every member of the numeric tower.",
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
							type: { type: "Rational" },
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
							type: { type: "Rational" },
						},
						{
							name: null,
							type: { type: "Integer" },
						},
					],
					returnType: { type: "Rational" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Rational" },
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
							type: { type: "Rational" },
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
					"Divides this Rational by a number, exactly. Dividing by a possibly-zero Integer or Rational gives `Nothing` for zero; dividing by an Algebraic can never fail — an irrational is never zero.",
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
							type: { type: "Rational" },
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
							type: { type: "Rational" },
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
							type: { type: "Rational" },
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
					"Multiplies this Rational with a number, staying exact for every member of the numeric tower.",
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
							type: { type: "Rational" },
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
							type: { type: "Rational" },
						},
						{
							name: null,
							type: { type: "Integer" },
						},
					],
					returnType: { type: "Rational" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Rational" },
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
							type: { type: "Rational" },
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
					"Whether this Rational is strictly below the given number.",
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
							type: { type: "Rational" },
						},
						{
							name: null,
							type: { type: "Rational" },
						},
					],
					returnType: { type: "Boolean" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Rational" },
						},
						{
							name: null,
							type: { type: "Integer" },
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
					"Whether this Rational is below the given number, or equal to it.",
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
							type: { type: "Rational" },
						},
						{
							name: null,
							type: { type: "Rational" },
						},
					],
					returnType: { type: "Boolean" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Rational" },
						},
						{
							name: null,
							type: { type: "Integer" },
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
					"Whether this Rational is strictly above the given number.",
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
							type: { type: "Rational" },
						},
						{
							name: null,
							type: { type: "Rational" },
						},
					],
					returnType: { type: "Boolean" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Rational" },
						},
						{
							name: null,
							type: { type: "Integer" },
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
					"Whether this Rational is above the given number, or equal to it.",
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
							type: { type: "Rational" },
						},
						{
							name: null,
							type: { type: "Rational" },
						},
					],
					returnType: { type: "Boolean" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Rational" },
						},
						{
							name: null,
							type: { type: "Integer" },
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
					type: { type: "Rational" },
				},
			],
			returnType: optionalOf({
				type: "UnionType",
				types: [{ type: "Rational" }, { type: "Algebraic" }],
			}),
			documentation: {
				description:
					"The exact square root. A perfect square gives a Rational; any other non-negative value gives an exact Algebraic — and a negative gives Nothing.",
				parameters: {},
				returns: null,
				position: null,
			},
		},

		numerator: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Rational" },
				},
			],
			returnType: { type: "Integer" },
			documentation: {
				description:
					"The numerator of the Rational in lowest terms. The sign of the Rational lives here — the denominator is always positive.",
				parameters: {},
				returns: null,
				position: null,
			},
		},

		denominator: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Rational" },
				},
			],
			returnType: { type: "Integer" },
			documentation: {
				description:
					"The denominator of the Rational in lowest terms — always positive.",
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
					type: { type: "Rational" },
				},
			],
			returnType: { type: "Rational" },
			documentation: {
				description:
					"The Rational without its sign — its distance from zero.",
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
					type: { type: "Rational" },
				},
			],
			returnType: { type: "Rational" },
			documentation: {
				description: "The Rational with its sign flipped.",
				parameters: {},
				returns: null,
				position: null,
			},
		},

		reciprocal: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Rational" },
				},
			],
			returnType: optionalOf({ type: "Rational" }),
			documentation: {
				description:
					"The Rational flipped upside down — the numerator and denominator exchanged.",
				parameters: {},
				returns: "the reciprocal, or `Nothing` for zero.",
				position: null,
			},
		},

		isWholeNumber: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Rational" },
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description:
					"Whether the Rational is a whole number — its denominator in lowest terms is one.",
				parameters: {},
				returns: null,
				position: null,
			},
		},

		rounded: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Rational" },
				},
			],
			returnType: { type: "Integer" },
			documentation: {
				description:
					"The nearest Integer. A value exactly halfway between two rounds away from zero — `1/2` gives `1`, `0 - 1/2` gives `0 - 1`.",
				parameters: {},
				returns: null,
				position: null,
			},
		},

		roundedDown: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Rational" },
				},
			],
			returnType: { type: "Integer" },
			documentation: {
				description:
					"The greatest Integer at or below the Rational — the floor.",
				parameters: {},
				returns: null,
				position: null,
			},
		},

		roundedUp: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Rational" },
				},
			],
			returnType: { type: "Integer" },
			documentation: {
				description:
					"The lowest Integer at or above the Rational — the ceiling.",
				parameters: {},
				returns: null,
				position: null,
			},
		},

		truncated: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Rational" },
				},
			],
			returnType: { type: "Integer" },
			documentation: {
				description:
					"The Integer part of the Rational — the fractional part cut off, rounding towards zero.",
				parameters: {},
				returns: null,
				position: null,
			},
		},

		toThePowerOf: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Rational" },
				},
				{
					name: null,
					type: { type: "Integer" },
					documentation: "the exponent",
				},
			],
			returnType: optionalOf({ type: "Rational" }),
			documentation: {
				description:
					"Raises the Rational to the given power. A negative exponent gives the exact reciprocal power. Zero to the power of zero is one.",
				parameters: {},
				returns:
					"the power, or `Nothing` when raising zero to a negative power.",
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
			returnType: optionalOf({ type: "Rational" }),
			documentation: {
				description:
					"Reads a Rational from its text form — a fraction like `3/4`, a decimal like `0.75`, or a whole number like `3`, each with an optional minus sign.",
				parameters: {},
				returns:
					"the Rational, or `Nothing` when the text has any other shape or divides by zero.",
				position: null,
			},
		},

		toString: {
			type: "OverloadedMethod",
			documentation: {
				description:
					'Represents the Rational as a String — `"3/4"` in lowest terms, or its decimal form with `formatAs "decimal"`.',
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
							type: { type: "Rational" },
						},
					],
					returnType: { type: "String" },
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: { type: "Rational" },
						},
						{
							name: "formatAs",
							type: { type: "String" },
						},
					],
					returnType: { type: "String" },
				},
			],
		} as common.OverloadedMethodType,
		compareTo: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "Rational" },
				},
				{
					name: null,
					type: { type: "Rational" },
					documentation: "the Rational to order against",
				},
			],
			returnType: orderingType,
			documentation: {
				description: "Orders the Rational against another Rational.",
				parameters: {},
				returns:
					"`Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.",
				position: null,
			},
		},
	},
}
