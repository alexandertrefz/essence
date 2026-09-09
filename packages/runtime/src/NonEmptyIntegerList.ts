// NOTE: The runtime module of the `NonEmptyIntegerList` Namespace — the
// aggregates a proven List of Integers answers bare. Every Method of it is
// written in Essence (`packages/standard-library/sources/NumberList.es`),
// delegating to the `Number` static's own proven entry, apart from the one
// below. The module would stay whatever it held, because the Rewriter imports
// one per builtin Namespace by name, exactly as `NestedOptional.ts` does.
//
// NOTE: `mode` is `List`'s own walk over the canonical key encoding, under
// this Namespace's name, and the three Namespaces that count are that one
// Function. It was `@::tally()::entries()::highestItem(on .value).key` here,
// which reached the whole Dictionary for a count a plain Map holds.
export { mode } from "./List"
