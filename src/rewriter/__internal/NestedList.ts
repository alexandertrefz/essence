// NOTE: The runtime module of the `NestedList` Namespace — a List of Lists.
// The Simplifier emits `<Namespace>.<method>(…)`, so a Namespace needs a module
// of its own name; the implementation stays in `List.ts` beside every other
// operation on a List, and is re-exported here rather than moved, so that
// `flattened` keeps the List internals it is written against within reach.
export { flattened } from "./List"
