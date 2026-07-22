import type { GenericListType, ListType } from "../../interfaces/common/index"
import type { common } from "../../interfaces/index"
import { type as orderingType } from "./Ordering"

export const type: GenericListType = {
	type: "GenericList",
	generics: [{ name: "ItemType", defaultType: { type: "Unknown" } }],
}

const typeResolvedWithGenericUse: ListType = {
	type: "List",
	itemType: { type: "GenericUse", name: "ItemType" },
}

// NOTE: The item Type on its own, and the two shapes that recur across the
// higher-order Methods: a value that may be absent, and a check over one item.
// `ItemType` is the Namespace Generic, merged into every signature by the loop
// at the foot of this file.
const itemType: common.Type = { type: "GenericUse", name: "ItemType" }

const itemOrNothing: common.Type = {
	type: "UnionType",
	types: [itemType, { type: "Nothing" }],
}

const predicate: common.Type = {
	type: "Function",
	generics: [],
	parameterTypes: [{ name: null, type: itemType }],
	returnType: { type: "Boolean" },
}

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
		// NOTE: The List Namespace is generic, and generic Namespaces can not
		// declare Protocol conformance (yet) — `toString` still exists for
		// direct calls; List conformance ships with conditional conformance.
		toString: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: typeResolvedWithGenericUse,
				},
			],
			returnType: { type: "String" },
			documentation: {
				description: "Represents the List and its items as a String.",
				parameters: {},
				returns: "the String representation of the List.",
				position: null,
			},
		} as common.MethodType,
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
					returnType: itemOrNothing,
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
							type: predicate,
						},
					],
					returnType: itemOrNothing,
				},
			],
			documentation: {
				description:
					"The first item, or the first item the given check accepts.",
				parameters: {},
				returns: "the matching item, or `Nothing` when there is none.",
				position: null,
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

		// NOTE: `map` and `reduce` are the first builtins to carry a
		// Method-level Generic. `Result` must be `infer: true`, or it never
		// enters `bindableNames` and inference silently leaves it unbound. It
		// is bound from the callback: for `map` from the callback's return
		// Type, for `reduce` from the `startingWith` value before the callback
		// is even checked. The merge loop below prepends `ItemType`, so each
		// ends up generic in `[ItemType, Result]`.
		map: {
			type: "SimpleMethod",
			generics: [{ name: "Result", defaultType: null, infer: true }],
			parameterTypes: [
				{ name: null, type: typeResolvedWithGenericUse },
				{
					name: null,
					type: {
						type: "Function",
						generics: [],
						parameterTypes: [{ name: null, type: itemType }],
						returnType: { type: "GenericUse", name: "Result" },
					},
				},
			],
			returnType: {
				type: "List",
				itemType: { type: "GenericUse", name: "Result" },
			},
			documentation: {
				description:
					"A new List with the given transform applied to every item.",
				parameters: {},
				returns: "the List of transformed items.",
				position: null,
			},
		},
		reduce: {
			type: "SimpleMethod",
			generics: [{ name: "Result", defaultType: null, infer: true }],
			parameterTypes: [
				{ name: null, type: typeResolvedWithGenericUse },
				{
					name: "startingWith",
					type: { type: "GenericUse", name: "Result" },
				},
				{
					name: null,
					type: {
						type: "Function",
						generics: [],
						parameterTypes: [
							{
								name: null,
								type: { type: "GenericUse", name: "Result" },
							},
							{ name: null, type: itemType },
						],
						returnType: { type: "GenericUse", name: "Result" },
					},
				},
			],
			returnType: { type: "GenericUse", name: "Result" },
			documentation: {
				description:
					"Combines every item into a single value, starting from the given one.",
				parameters: {
					startingWith: "the value the first combination builds on.",
				},
				returns: "the combined value.",
				position: null,
			},
		},

		// NOTE: The complement of `removeEvery(where:)` — the filter. Only the
		// `where` form, since keeping just the items equal to a given value is
		// what `contains` already answers.
		keepEvery: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{ name: null, type: typeResolvedWithGenericUse },
				{ name: "where", type: predicate },
			],
			returnType: typeResolvedWithGenericUse,
			documentation: {
				description:
					"A new List of just the items the given check accepts.",
				parameters: {},
				returns: "the List of accepted items.",
				position: null,
			},
		},

		itemAt: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{ name: null, type: typeResolvedWithGenericUse },
				{ name: null, type: { type: "Integer" } },
			],
			returnType: itemOrNothing,
			documentation: {
				description:
					"The item at the given position, counting from zero.",
				parameters: {},
				returns:
					"the item, or `Nothing` when the position is outside the List.",
				position: null,
			},
		},
		firstIndexOf: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{ name: null, type: typeResolvedWithGenericUse },
				{ name: null, type: itemType },
			],
			returnType: {
				type: "UnionType",
				types: [{ type: "Integer" }, { type: "Nothing" }],
			},
			documentation: {
				description:
					"The position of the first item equal to the given one.",
				parameters: {},
				returns:
					"the zero-based position, or `Nothing` when the item is absent.",
				position: null,
			},
		},
		slice: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{ name: null, type: typeResolvedWithGenericUse },
				{ name: "from", type: { type: "Integer" } },
				{ name: "to", type: { type: "Integer" } },
			],
			returnType: typeResolvedWithGenericUse,
			documentation: {
				description:
					"A new List of the items from one position up to, but not including, another.",
				parameters: {
					from: "the first position to include, counting from zero.",
					to: "the position to stop before.",
				},
				returns: "the List of items in that range.",
				position: null,
			},
		},
		reversed: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [{ name: null, type: typeResolvedWithGenericUse }],
			returnType: typeResolvedWithGenericUse,
			documentation: {
				description: "A new List with the items in the opposite order.",
				parameters: {},
				returns: "the reversed List.",
				position: null,
			},
		},
		sortedBy: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{ name: null, type: typeResolvedWithGenericUse },
				{
					name: null,
					type: {
						type: "Function",
						generics: [],
						parameterTypes: [
							{ name: null, type: itemType },
							{ name: null, type: itemType },
						],
						returnType: orderingType,
					},
				},
			],
			returnType: typeResolvedWithGenericUse,
			documentation: {
				description:
					"A new List ordered by the given comparison, applied to each pair of items.",
				parameters: {},
				returns: "the ordered List.",
				position: null,
			},
		},

		// NOTE: `anyItem`/`everyItem` read as sentences — "any item matches …",
		// "every item matches …" — the existential and universal checks over a
		// predicate. The no-argument existential is `hasItems`.
		anyItem: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{ name: null, type: typeResolvedWithGenericUse },
				{ name: "matches", type: predicate },
			],
			returnType: { type: "Boolean" },
			documentation: {
				description:
					"Whether the given check accepts at least one item.",
				parameters: {},
				returns: "`true` when some item is accepted.",
				position: null,
			},
		},
		everyItem: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{ name: null, type: typeResolvedWithGenericUse },
				{ name: "matches", type: predicate },
			],
			returnType: { type: "Boolean" },
			documentation: {
				description: "Whether the given check accepts every item.",
				parameters: {},
				returns:
					"`true` when all items are accepted, including the empty List.",
				position: null,
			},
		},
		countOf: {
			type: "OverloadedMethod",
			overloads: [
				{
					generics: [],
					parameterTypes: [
						{ name: null, type: typeResolvedWithGenericUse },
						{ name: null, type: itemType },
					],
					returnType: { type: "Integer" },
				},
				{
					generics: [],
					parameterTypes: [
						{ name: null, type: typeResolvedWithGenericUse },
						{ name: "where", type: predicate },
					],
					returnType: { type: "Integer" },
				},
			],
			documentation: {
				description:
					"How many items equal the given one, or are accepted by the given check.",
				parameters: {},
				returns: "the count.",
				position: null,
			},
		},
		insertAt: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{ name: null, type: typeResolvedWithGenericUse },
				{ name: null, type: { type: "Integer" } },
				{ name: "with", type: itemType },
			],
			returnType: typeResolvedWithGenericUse,
			documentation: {
				description:
					"A new List with the given item inserted before the given position.",
				parameters: {},
				returns: "the List with the item inserted.",
				position: null,
			},
		},
		replaceAt: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{ name: null, type: typeResolvedWithGenericUse },
				{ name: null, type: { type: "Integer" } },
				{ name: "with", type: itemType },
			],
			returnType: typeResolvedWithGenericUse,
			documentation: {
				description:
					"A new List with the item at the given position replaced.",
				parameters: {},
				returns:
					"the List with the item replaced, or unchanged when the position is outside it.",
				position: null,
			},
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
