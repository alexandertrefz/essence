import { typeKeySymbol } from "./type"

// A builtin Choice. `write` in `Terminal.ts` reads its tag. No native answers
// one, so it keeps no shared instances. See "Builtin Choices" in
// DEVELOPMENT.md.
export type OutputType = { [typeKeySymbol]: "Stream#Output" }
export type ErrorType = { [typeKeySymbol]: "Stream#Error" }
export type StreamType = OutputType | ErrorType
