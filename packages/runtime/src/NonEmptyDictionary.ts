// NOTE: The runtime module of the `NonEmptyDictionary` Namespace — the
// Dictionaries a Program has proven hold something. The Simplifier emits
// `<Namespace>.<method>(…)`, so a Namespace needs a module of its own name, and
// this is it.
//
// NOTE: Every export here is `Dictionary`'s own native, re-exported straight
// through, so the two entries are one Function under two names and can not come
// apart. A refinement erases before anything runs: what arrives is an ordinary
// `DictionaryType` and the evidence the Type carried was spent while compiling,
// so there is nothing left for a body here to do differently. What the proof
// buys is said in the Types alone — a count that is never zero, and three
// halves that are never the empty List.
//
// NOTE: The module exists at all because an Essence body could not write these.
// `<- @::length()` on a proven receiver is this very Method rather than
// `Dictionary`'s, and the Validator refuses it as `infinite-recursion`; see
// `packages/standard-library/DEVELOPMENT.md`, A receiver narrowed by EVIDENCE.
//
// NOTE: `set` is not here. It answers a `NonEmptyDictionary` on `Dictionary`
// itself, whatever it was handed, exactly as `List::append(_:)` answers a
// `NonEmptyList` — so a proven receiver reaches that entry and there is nothing
// for this Namespace to declare.
export { entries, keys, length, map, values } from "./Dictionary"
