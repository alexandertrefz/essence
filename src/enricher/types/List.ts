import { optionalOf } from "../../helpers/index"
import type { GenericListType, ListType } from "../../interfaces/common/index"
import type { common } from "../../interfaces/index"
import { type as orderingType } from "./Ordering"
import { conformedMethods, Equatable, Printable } from "./Protocols"

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

const itemOrNothing: common.Type = optionalOf(itemType)

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
	conformsTo: ["Equatable", "Printable", "Comparable"],
	// NOTE: List's Comparable conformance is conditional — a List is orderable
	// exactly when its items are. `compareTo` carries the same bound as its own
	// Method Generic, so a use site solving `List<ItemType> is Comparable`
	// recursively solves `ItemType is Comparable` and hands the item ordering
	// in as the hidden conformance Argument.
	conformanceConditions: {
		Comparable: [{ generic: "ItemType", protocol: "Comparable" }],
	},
	properties: {},
	methods: {
		// NOTE: `is`/`isNot` (Equatable) and `toString` (Printable) are derived
		// from the Protocols themselves, so their signatures can never drift
		// from the requirements the List Namespace conforms to. The List
		// specific tooltips are passed as overrides, keeping the Hover and
		// Completion texts exactly as hand written. `ItemType` is merged into
		// each by the foot loop, so direct calls still infer the item Type.
		...conformedMethods(Equatable, typeResolvedWithGenericUse, {
			is: {
				description:
					"Checks whether the Lists are structurally equal — the same items, in the same order.",
				parameters: {},
				returns: "`true` when the Lists are equal.",
				position: null,
			},
			isNot: {
				description:
					"Checks whether the Lists differ — in any item or in their order.",
				parameters: {},
				returns: "`true` when the Lists are not equal.",
				position: null,
			},
		}),
		...conformedMethods(Printable, typeResolvedWithGenericUse, {
			toString: {
				description: "Represents the List and its items as a String.",
				parameters: {},
				returns: "the String representation of the List.",
				position: null,
			},
		}),
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
			documentation: {
				description: "How many items the List has.",
				parameters: {},
				returns: "the number of items.",
				position: null,
			},
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
			documentation: {
				description:
					"Whether the List has at least one item — the opposite of `isEmpty`.",
				parameters: {},
				returns: "`true` when the List is not empty.",
				position: null,
			},
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
			documentation: {
				description: "Whether the List has no items at all.",
				parameters: {},
				returns: "`true` for the empty List.",
				position: null,
			},
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
					documentation: "the item to look for",
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description:
					"Whether an item equal to the given one is in the List.",
				parameters: {},
				returns: "`true` when the item occurs.",
				position: null,
			},
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
					documentation: "the item to look for",
				},
			],
			returnType: { type: "Boolean" },
			documentation: {
				description:
					"Whether no item equal to the given one is in the List.",
				parameters: {},
				returns: "`true` when the item does not occur.",
				position: null,
			},
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
			returnType: optionalOf({ type: "GenericUse", name: "ItemType" }),
			documentation: {
				description: "The last item of the List.",
				parameters: {},
				returns: "the item, or `Nothing` for the empty List.",
				position: null,
			},
		},
		removeFirst: {
			type: "OverloadedMethod",
			documentation: {
				description:
					"A new List without the first item, or without the given number of leading items.",
				parameters: {},
				returns:
					"the shortened List — empty when more items were removed than it had.",
				position: null,
			},
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
					documentation: "the position of the item to remove",
				},
			],
			returnType: typeResolvedWithGenericUse,
			documentation: {
				description:
					"A new List without the item at the given position, counting from zero.",
				parameters: {},
				returns:
					"the List without that item, or unchanged when the position is outside it.",
				position: null,
			},
		},
		removeEvery: {
			type: "OverloadedMethod",
			documentation: {
				description:
					"A new List without every item equal to the given one, or without every item the given check accepts.",
				parameters: {},
				returns: "the List of remaining items.",
				position: null,
			},
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
			documentation: {
				description:
					"A new List without the last item, or without the given number of trailing items.",
				parameters: {},
				returns:
					"the shortened List — empty when more items were removed than it had.",
				position: null,
			},
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
			documentation: {
				description:
					"A new List keeping only the first occurrence of each item, in the original order.",
				parameters: {},
				returns: "the List without duplicates.",
				position: null,
			},
		},
		prepend: {
			type: "OverloadedMethod",
			documentation: {
				description:
					"A new List with the given item — or the contents of the given List — added at the front.",
				parameters: {},
				returns: "the extended List.",
				position: null,
			},
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
			documentation: {
				description:
					"A new List with the given item — or the contents of the given List — added at the end.",
				parameters: {},
				returns: "the extended List.",
				position: null,
			},
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
			returnType: optionalOf({ type: "Integer" }),
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
		// NOTE: The first builtin with a Protocol-bounded Type Parameter. The
		// bound resolves the conforming Namespace at the call site — `Integer`
		// for a `List<Integer>`, the covering `Number` for a mixed numeric
		// List — and its `compareTo` arrives as a hidden trailing Argument.
		// Self-contained (its own bounded `ItemType`), so the foot loop
		// leaves it alone.
		sorted: {
			type: "SimpleMethod",
			generics: [
				{
					name: "ItemType",
					defaultType: null,
					infer: true,
					constraint: "Comparable",
				},
			],
			parameterTypes: [{ name: null, type: typeResolvedWithGenericUse }],
			returnType: typeResolvedWithGenericUse,
			documentation: {
				description:
					"A new List in ascending order — the items' own ordering, available whenever they conform to `Comparable`. For any other order, use `sortedBy`.",
				parameters: {},
				returns: "the ordered List.",
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
		// NOTE: The witness behind List's conditional Comparable conformance —
		// lexicographic ordering, available whenever the items are `Comparable`.
		// Self-contained (its own bounded `ItemType`), so the foot loop leaves
		// it alone; routing it through `conformedMethods` would drop the bound,
		// so it is hand written like `sorted`.
		compareTo: {
			type: "SimpleMethod",
			generics: [
				{
					name: "ItemType",
					defaultType: null,
					infer: true,
					constraint: "Comparable",
				},
			],
			parameterTypes: [
				{ name: null, type: typeResolvedWithGenericUse },
				{
					name: null,
					type: typeResolvedWithGenericUse,
					documentation: "the List to compare with",
				},
			],
			returnType: orderingType,
			documentation: {
				description:
					"Orders the List against another one lexicographically — the first differing pair of items decides, and on an equal prefix the shorter List comes first. Available whenever the items conform to `Comparable`.",
				parameters: {},
				returns:
					"`Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.",
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
		lastIndexOf: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{ name: null, type: typeResolvedWithGenericUse },
				{ name: null, type: itemType },
			],
			returnType: optionalOf({ type: "Integer" }),
			documentation: {
				description:
					"The position of the last item equal to the given one.",
				parameters: {},
				returns:
					"the zero-based position, or `Nothing` when the item is absent.",
				position: null,
			},
		},

		// NOTE: `joinWith` is the return trip of `String::splitOn` — it only
		// exists on a List of Strings, so its receiver Type is written out
		// rather than generic, and the foot loop below leaves it alone.
		joinWith: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: { type: "List", itemType: { type: "String" } },
				},
				{
					name: null,
					type: { type: "String" },
					documentation: "the separator to place between the items",
				},
			],
			returnType: { type: "String" },
			documentation: {
				description:
					"Joins the Strings into one, with the given separator between them — the return trip of `String::splitOn`.",
				parameters: {},
				returns: "the joined String.",
				position: null,
			},
		},

		flattened: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: {
						type: "List",
						itemType: typeResolvedWithGenericUse,
					},
				},
			],
			returnType: typeResolvedWithGenericUse,
			documentation: {
				description:
					"Flattens a List of Lists by one level — every inner List's items, in order, in a single List.",
				parameters: {},
				returns: "the flattened List.",
				position: null,
			},
		},

		partitioned: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{ name: null, type: typeResolvedWithGenericUse },
				{ name: "where", type: predicate },
			],
			returnType: {
				type: "Record",
				members: {
					matching: typeResolvedWithGenericUse,
					rest: typeResolvedWithGenericUse,
				},
			},
			documentation: {
				description:
					"Splits the List in two by the given check — the accepted items and the rest, each in their original order.",
				parameters: {},
				returns:
					"a Record with the accepted items under `matching` and the others under `rest`.",
				position: null,
			},
		},

		pairedWith: {
			type: "SimpleMethod",
			generics: [{ name: "Other", defaultType: null, infer: true }],
			parameterTypes: [
				{ name: null, type: typeResolvedWithGenericUse },
				{
					name: null,
					type: {
						type: "List",
						itemType: { type: "GenericUse", name: "Other" },
					},
					documentation: "the List to pair the items with",
				},
			],
			returnType: {
				type: "List",
				itemType: {
					type: "Record",
					members: {
						first: itemType,
						second: { type: "GenericUse", name: "Other" },
					},
				},
			},
			documentation: {
				description:
					"Pairs the items of the two Lists position by position. The pairing stops with the shorter List.",
				parameters: {},
				returns:
					"a List of Records, each holding one item of this List under `first` and its counterpart under `second`.",
				position: null,
			},
		},

		splitInto: {
			type: "SimpleMethod",
			generics: [],
			parameterTypes: [
				{ name: null, type: typeResolvedWithGenericUse },
				{
					name: "groupsOf",
					type: { type: "Integer" },
					documentation: "how many items each group holds",
				},
			],
			returnType: optionalOf({
				type: "List",
				itemType: typeResolvedWithGenericUse,
			}),
			documentation: {
				description:
					"Splits the List into groups of the given size, in order. The last group holds whatever remains, so it may be shorter.",
				parameters: {},
				returns:
					"the List of groups, or `Nothing` when the group size is below one.",
				position: null,
			},
		},

		repeating: {
			type: "StaticMethod",
			generics: [],
			parameterTypes: [
				{
					name: null,
					type: itemType,
					documentation: "the item to repeat",
				},
				{
					name: "times",
					type: { type: "Integer" },
					documentation: "how many copies the List holds",
				},
			],
			returnType: typeResolvedWithGenericUse,
			documentation: {
				description:
					"A List holding the given item the given number of times. Zero or fewer times gives the empty List.",
				parameters: {},
				returns: "the List of repeated items.",
				position: null,
			},
		},

		// NOTE: The loop-fuel constructor — Essence has no Range Type by
		// design, so counting loops write `List.of(integersFrom 1, through
		// 10)::map(...)`. Fixed to Integers, so the foot loop leaves it alone.
		of: {
			type: "StaticMethod",
			generics: [],
			parameterTypes: [
				{
					name: "integersFrom",
					type: { type: "Integer" },
					documentation: "the first Integer of the List",
				},
				{
					name: "through",
					type: { type: "Integer" },
					documentation: "the last Integer of the List, included",
				},
			],
			returnType: { type: "List", itemType: { type: "Integer" } },
			documentation: {
				description:
					"The Integers from one value through another, both included — counting down when the first is the greater.",
				parameters: {},
				returns: "the List of Integers.",
				position: null,
			},
		},
	},
}

// NOTE: The Namespace-level `ItemType` Generic is merged into every Method
// signature, so that each signature is self-contained for inference — a
// Method looked up as a value re-infers `ItemType` from its receiver
// argument. `joinWith` and `of` fix their Types outright (a String-only
// receiver, an Integer-only result), so they have no `ItemType` to infer and
// merging it in would only ever leave it unbound. `sorted` declares its own
// `ItemType`, bounded by `Comparable`.
const methodsWithoutItemType = new Set([
	"joinWith",
	"of",
	"sorted",
	"compareTo",
])

for (let [methodName, method] of Object.entries(namespaceDefinition.methods)) {
	if (methodsWithoutItemType.has(methodName)) {
		continue
	}

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
