// NOTE: The runtime module of the `NonEmptyNestedList` Namespace — a List of
// Lists where both proofs are in hand. The Simplifier emits
// `<Namespace>.<method>(…)`, so a Namespace needs a module of its own name;
// the implementation stays in `List.ts` beside every other operation on a List,
// and is re-exported here exactly as `NestedList` re-exports it.
//
// NOTE: One Function under three names, and that is the point. A refinement
// erases before anything runs, so what the two proofs buy is said entirely in
// the Types — the walk that flattens the groups is the same walk whether
// anything was proven or not.
export { flatten } from "./List"
