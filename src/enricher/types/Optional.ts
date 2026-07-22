import { optionalOf } from "../../helpers/index"
import type { common } from "../../interfaces/index"

// NOTE: The global spelling of fallibility — `Optional<Integer>` is a Generic
// Type Alias for `Integer | Nothing`, usable in any Type position. Applying
// it stamps the applied spelling onto the resulting Union as its display
// name, so annotations read back exactly as written.
export const type: common.GenericAliasType = {
	type: "GenericAlias",
	name: "Optional",
	generics: [{ name: "ItemType", defaultType: null, infer: false }],
	aliasedType: optionalOf({ type: "GenericUse", name: "ItemType" }),
}

// NOTE: The covering Namespace for `Optional<ItemType>` — the Union every
// fallible Method returns. It carries the one Method whose meaning needs both
// members at once: `otherwise`, which collapses the Union back to a bare
// value. Matching binds `ItemType` to the receiver's non-Nothing payload: an
// Optional-shaped receiver binds it in one piece (Unions are built that way
// — see `buildUnion`), and a receiver whose `Nothing` hides inside a named
// member (`MaybeInt | Rational`) resolves through the Union matcher's
// remainder fallback, which lets `Nothing` claim its own and binds
// `ItemType` to whatever is left. Either way the fallback Argument and the
// result are typed by the payload alone.
export const namespace: common.NamespaceType = {
	type: "Namespace",
	name: "Optional",
	generics: [{ name: "ItemType", defaultType: null, infer: true }],
	targetType: optionalOf({ type: "GenericUse", name: "ItemType" }),
	properties: {},
	methods: {
		otherwise: {
			type: "SimpleMethod",
			generics: [{ name: "ItemType", defaultType: null, infer: true }],
			parameterTypes: [
				{
					name: null,
					type: optionalOf({ type: "GenericUse", name: "ItemType" }),
				},
				{
					name: null,
					type: { type: "GenericUse", name: "ItemType" },
					documentation: "the value to fall back to",
				},
			],
			returnType: { type: "GenericUse", name: "ItemType" },
			documentation: {
				description:
					"The value itself — or, when it is `Nothing`, the given fallback. Collapses a `… | Nothing` Union back to a bare value: `list::firstItem()::otherwise(0)`.",
				parameters: {},
				returns: "the value, or the fallback in its place.",
				position: null,
			},
		},
	},
}
