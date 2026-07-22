import type { common } from "../../interfaces/index"
import { type as orderingType } from "./Ordering"

// NOTE: The four ordering Methods share one shape over the Union — receiver,
// one Number argument, a Boolean out — and read the same numeric order
// `compareTo` does. They live only here, on the covering Namespace: their
// result is always a Boolean, so unlike arithmetic (whose return Type varies
// by pair) there is nothing a per-member overload could say that this does
// not. This is also the one place the Transcendental-against-Transcendental
// cell is offered.
function orderingMethods(
	unionType: common.Type,
): Record<string, common.MethodType> {
	let descriptions: Record<string, string> = {
		isLessThan: "Whether this Number is strictly below the given one.",
		isLessThanOrEqualTo:
			"Whether this Number is below the given one, or equal to it.",
		isGreaterThan: "Whether this Number is strictly above the given one.",
		isGreaterThanOrEqualTo:
			"Whether this Number is above the given one, or equal to it.",
	}

	let methods: Record<string, common.MethodType> = {}

	for (let [name, description] of Object.entries(descriptions)) {
		methods[name] = {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{ name: null, type: unionType },
				{
					name: null,
					type: unionType,
					documentation: "the Number to compare against",
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description,
				parameters: {},
				returns: null,
				position: null,
			},
		}
	}

	return methods
}

export const type: common.UnionType = {
	type: "UnionType",
	types: [
		{ type: "Integer" },
		{ type: "Rational" },
		{ type: "Algebraic" },
		{ type: "Transcendental" },
	],
}

// NOTE: The Union-level behaviour of `Number` — cross-member semantics only
// a covering Namespace can define. `is` is numeric equality (`1 is 1/1` is
// true), while the member Namespaces stay representational; Method target
// specificity routes single-member receivers to those, so these Methods only
// answer for Union-typed receivers and mixed-member Arguments.
//
// `compareTo` hand-writes all sixteen member cells and keeps the Comparable
// conformance even though Transcendental alone does not conform: every
// cross-kind cell is total because equality across kinds is impossible by
// definition, and the only cell that could ever need a documented cutoff —
// Transcendental against Transcendental — is exact within the current
// linear-in-π grammar. The `isLessThan` family (added by `orderingMethods`)
// reads that same order, so it lives here for the same reason and is the one
// place two Transcendentals can be compared with a `<`.
export const namespace: common.NamespaceType = {
	type: "Namespace",
	name: "Number",
	targetType: type,
	conformsTo: ["Equatable", "Printable", "Comparable"],
	generics: [],
	properties: {
		PI: { type: "Transcendental" },
		TAU: { type: "Transcendental" },
	},
	methods: {
		is: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{ name: null, type },
				{
					name: null,
					type,
					documentation: "the Number to compare against",
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description:
					"Checks whether the Number has the same numeric value as another Number — an Integer and a Rational are the same Number when their values are equal, so `1 is 1/1` holds.",
				parameters: {},
				returns:
					"`true` when both Numbers have the same numeric value.",
				position: null,
			},
		} as common.MethodType,
		isNot: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{ name: null, type },
				{
					name: null,
					type,
					documentation: "the Number to compare against",
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description:
					"Checks whether the Number has a different numeric value than another Number.",
				parameters: {},
				returns:
					"`true` when the Numbers have different numeric values.",
				position: null,
			},
		} as common.MethodType,
		toString: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [{ name: null, type }],
			returnType: { type: "String" },
			documentation: {
				description:
					"Represents the Number as a String, in the notation of the member Type it currently holds.",
				parameters: {},
				returns: null,
				position: null,
			},
		} as common.MethodType,
		compareTo: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{ name: null, type },
				{
					name: null,
					type,
					documentation: "the Number to order against",
				},
			],
			returnType: orderingType,
			documentation: {
				description:
					"Orders the Number against another Number by numeric value, across Integers and Rationals.",
				parameters: {},
				returns:
					"`Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.",
				position: null,
			},
		} as common.MethodType,
		...orderingMethods(type),

		isBetween: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{ name: null, type },
				{
					name: null,
					type,
					documentation: "the lower bound, included",
				},
				{
					name: "and",
					type,
					documentation: "the upper bound, included",
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description:
					"Whether this Number lies between the two given ones, both included — across every member of the numeric tower, so `Number.PI::isBetween(3, and 22/7)` holds. Bounds in the wrong order enclose no Number, so the answer is `false`.",
				parameters: {},
				returns: "`true` when the Number is within the bounds.",
				position: null,
			},
		},

		sum: {
			type: "OverloadedStaticMethod",
			overloads: [
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: {
								type: "List",
								itemType: { type: "Integer" },
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
								itemType: { type: "Rational" },
							},
						},
					],
					returnType: { type: "Rational" },
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
										{ type: "Integer" },
										{ type: "Rational" },
									],
								},
							},
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Integer" }, { type: "Rational" }],
					},
				},
			],
			documentation: {
				description:
					"Adds up every Number in the List. The empty List sums to zero.",
				parameters: {},
				returns: "the exact total.",
				position: null,
			},
		},

		product: {
			type: "OverloadedStaticMethod",
			overloads: [
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: {
								type: "List",
								itemType: { type: "Integer" },
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
								itemType: { type: "Rational" },
							},
						},
					],
					returnType: { type: "Rational" },
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
										{ type: "Integer" },
										{ type: "Rational" },
									],
								},
							},
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Integer" }, { type: "Rational" }],
					},
				},
			],
			documentation: {
				description:
					"Multiplies every Number in the List together. The empty List multiplies to one.",
				parameters: {},
				returns: "the exact product.",
				position: null,
			},
		},

		average: {
			type: "OverloadedStaticMethod",
			overloads: [
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: {
								type: "List",
								itemType: { type: "Integer" },
							},
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Rational" }, { type: "Nothing" }],
					},
				},
				{
					generics: [],
					parameterTypes: [
						{
							name: null,
							type: {
								type: "List",
								itemType: { type: "Rational" },
							},
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Rational" }, { type: "Nothing" }],
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
									type: "UnionType",
									types: [
										{ type: "Integer" },
										{ type: "Rational" },
									],
								},
							},
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Rational" }, { type: "Nothing" }],
					},
				},
			],
			documentation: {
				description:
					"The arithmetic mean of the Numbers in the List — their sum divided by their count, as an exact Rational.",
				parameters: {},
				returns:
					"the mean, or `Nothing` for the empty List — no Numbers have no mean.",
				position: null,
			},
		},

		lowestNumber: {
			type: "OverloadedStaticMethod",
			documentation: {
				description:
					"The lower of two Numbers, or the lowest in a List of them.",
				parameters: {},
				returns:
					"the lowest Number — `Nothing` for the empty List, which has none.",
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
							type: { type: "Integer" },
						},
						{
							name: null,
							type: { type: "Rational" },
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Integer" }, { type: "Rational" }],
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
							type: { type: "Integer" },
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Integer" }, { type: "Rational" }],
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
					returnType: {
						type: "UnionType",
						types: [{ type: "Integer" }, { type: "Nothing" }],
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
									type: "Rational",
								},
							},
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Rational" }, { type: "Nothing" }],
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
									type: "UnionType",
									types: [
										{
											type: "Integer",
										},
										{
											type: "Rational",
										},
									],
								},
							},
						},
					],
					returnType: {
						type: "UnionType",
						types: [
							{ type: "Integer" },
							{ type: "Rational" },
							{ type: "Nothing" },
						],
					},
				},
			],
		},
		greatestNumber: {
			type: "OverloadedStaticMethod",
			documentation: {
				description:
					"The greater of two Numbers, or the greatest in a List of them.",
				parameters: {},
				returns:
					"the greatest Number — `Nothing` for the empty List, which has none.",
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
							type: { type: "Integer" },
						},
						{
							name: null,
							type: { type: "Rational" },
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Integer" }, { type: "Rational" }],
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
							type: { type: "Integer" },
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Integer" }, { type: "Rational" }],
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
					returnType: {
						type: "UnionType",
						types: [{ type: "Integer" }, { type: "Nothing" }],
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
									type: "Rational",
								},
							},
						},
					],
					returnType: {
						type: "UnionType",
						types: [{ type: "Rational" }, { type: "Nothing" }],
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
									type: "UnionType",
									types: [
										{
											type: "Integer",
										},
										{
											type: "Rational",
										},
									],
								},
							},
						},
					],
					returnType: {
						type: "UnionType",
						types: [
							{ type: "Integer" },
							{ type: "Rational" },
							{ type: "Nothing" },
						],
					},
				},
			],
		},
	},
}
