declarations {

	§ The global spelling of fallibility — `Optional<Integer>` is a Generic
	§ Type Alias for `Integer | Nothing`, usable in any Type position. Applying
	§ it stamps the applied spelling onto the resulting Union as its display
	§ name, so annotations read back exactly as written.
	type Optional<ItemType> = ItemType | Nothing

	§ The covering Namespace for `Optional<ItemType>` — the Union every
	§ fallible Method returns. It carries the one Method whose meaning needs
	§ both members at once: `otherwise`, which collapses the Union back to a
	§ bare value. Matching binds `ItemType` to the receiver's non-Nothing
	§ payload: an Optional-shaped receiver binds it in one piece (Unions are
	§ built that way — see `buildUnion`), and a receiver whose `Nothing` hides
	§ inside a named member (`MaybeInt | Rational`) resolves through the Union
	§ matcher's remainder fallback, which lets `Nothing` claim its own and
	§ binds `ItemType` to whatever is left. Either way the fallback Argument
	§ and the result are typed by the payload alone.
	namespace Optional<infer ItemType> for Optional<ItemType> {
		§§ The value itself — or, when it is `Nothing`, the given fallback. Collapses a `… | Nothing` Union back to a bare value: `list::firstItem()::otherwise(0)`.
		§§
		§§ @param fallback the value to fall back to
		§§ @returns the value, or the fallback in its place.
		otherwise(_ fallback: ItemType) -> ItemType
	}
}
