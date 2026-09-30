// The `NonEmptyDictionary` Namespace: `Dictionary`'s natives under the proven
// receiver's names, and `firstEntry`. See "Refined Namespaces" in
// DEVELOPMENT.md.
//
// `set` answers a `NonEmptyDictionary` on `Dictionary` itself, as
// `List::append(_:)` answers a `NonEmptyList`, so it is not declared here.
import type { DictionaryType, EntryRecord } from "./Dictionary"
import { firstLiveEntry } from "./Dictionary"
import type { AnyType } from "./type"

export {
	entries,
	keys,
	length,
	map,
	sort__overload$1,
	sort__overload$2,
	values,
} from "./Dictionary"

// `Dictionary.firstEntry` answers an Optional and this answers the entry. The
// proven receiver always has a live slot for `firstLiveEntry` to find.
export function firstEntry<Key extends AnyType, Value extends AnyType>(
	dictionary: DictionaryType<Key, Value>,
): EntryRecord<Key, Value> {
	return firstLiveEntry(dictionary) as EntryRecord<Key, Value>
}
