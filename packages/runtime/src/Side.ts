import { typeKeySymbol } from "./type"

// A builtin Choice. `trim` and `separate` in `String.ts` read its tag.
// See "Builtin Choices" in DEVELOPMENT.md.
export type StartType = { [typeKeySymbol]: "Side#Start" }
export type EndType = { [typeKeySymbol]: "Side#End" }
export type BothEndsType = { [typeKeySymbol]: "Side#BothEnds" }
export type SideType = StartType | EndType | BothEndsType

export const start: StartType = { [typeKeySymbol]: "Side#Start" }
export const end: EndType = { [typeKeySymbol]: "Side#End" }
export const bothEnds: BothEndsType = { [typeKeySymbol]: "Side#BothEnds" }
