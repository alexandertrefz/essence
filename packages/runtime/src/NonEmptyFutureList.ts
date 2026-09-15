// NOTE: The runtime module of the `NonEmptyFutureList` Namespace — a List of
// Futures proven to hold something. One Function under two names would be the
// shape here, and there is only the one: the first answer of nothing is no
// answer, so `race` is declared for the proven receiver alone. The
// implementation is in `Future.ts` with the rest.
export { race } from "./Future"
