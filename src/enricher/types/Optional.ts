import type { common } from "../../interfaces/index"

// NOTE: The covering Namespace for `ItemType | Nothing` — the Union every
// fallible Method returns. It carries the one Method whose meaning needs both
// members at once: `otherwise`, which collapses the Union back to a bare
// value. Matching binds `ItemType` to the receiver's non-Nothing member
// (concrete Union members are tried ahead of binding ones), so the fallback
// and the result are typed by that member alone. A receiver whose Union holds
// several members besides `Nothing` does not resolve here — the first member
// binds `ItemType` and the second no longer fits it — which keeps `otherwise`
// on the single-payload shape it is meant for.
export const namespace: common.NamespaceType = {
	type: "Namespace",
	name: "Optional",
	generics: [{ name: "ItemType", defaultType: null, infer: true }],
	targetType: {
		type: "UnionType",
		types: [{ type: "GenericUse", name: "ItemType" }, { type: "Nothing" }],
	},
	properties: {},
	methods: {
		otherwise: {
			type: "SimpleMethod",
			generics: [{ name: "ItemType", defaultType: null, infer: true }],
			parameterTypes: [
				{
					name: null,
					type: {
						type: "UnionType",
						types: [
							{ type: "GenericUse", name: "ItemType" },
							{ type: "Nothing" },
						],
					},
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
