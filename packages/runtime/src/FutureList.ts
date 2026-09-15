// NOTE: The runtime module of the `FutureList` Namespace — a List whose items
// are Futures. The Simplifier emits `<Namespace>.<method>(…)`, so a Namespace
// needs a module of its own name; the implementations stay in `Future.ts` beside
// everything else that starts and waits for a run, and are re-exported here
// exactly as `NestedList` re-exports `List`'s.
export { all__overload$1, all__overload$2, inSequence } from "./Future"
