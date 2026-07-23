import { typeKeySymbol } from "./type"

// NOTE: `Side` is a builtin Choice, like `Ordering` — its values carry Case
// tags (`"Side#Start"`) exactly as user-declared Cases do. `is`, `isNot` and
// `toString` are implemented in Essence (`src/stdlib/String.es`, beside the
// Methods that take a Side), so nothing but the tags lives here. The Methods
// that READ a Side belong to the Namespace that declares them — `trim` and
// `pad` are Methods of `String`, so their natives are in `String.ts`.
export type StartType = { [typeKeySymbol]: "Side#Start" }
export type EndType = { [typeKeySymbol]: "Side#End" }
export type BothEndsType = { [typeKeySymbol]: "Side#BothEnds" }
export type SideType = StartType | EndType | BothEndsType

// NOTE: Shared unit instances, for the same reason `Ordering`'s are shared —
// Case equality goes by tag, so these being singletons is an optimisation.
export const start: StartType = { [typeKeySymbol]: "Side#Start" }
export const end: EndType = { [typeKeySymbol]: "Side#End" }
export const bothEnds: BothEndsType = { [typeKeySymbol]: "Side#BothEnds" }
