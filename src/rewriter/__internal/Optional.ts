import type { NothingType } from "./Nothing"
import { type AnyType, typeKeySymbol } from "./type"

// NOTE: The runtime of the `Optional` covering Namespace — `otherwise` is the
// whole surface. The Type system has already pinned the receiver to
// `ItemType | Nothing` and the fallback to `ItemType`, so the tag check is
// all that is left of the Union.
export function otherwise<ItemType extends AnyType>(
	value: ItemType | NothingType,
	fallback: ItemType,
): ItemType {
	if (value[typeKeySymbol] === "Nothing") {
		return fallback
	}

	return value as ItemType
}
