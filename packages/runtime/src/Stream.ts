import { typeKeySymbol } from "./type"

// NOTE: `Stream` is a builtin Choice, like `Side` and `Ordering` — its values
// carry Case tags (`"Stream#Output"`) exactly as user-declared Cases do. The
// Methods that READ a Stream belong to the Namespace that declares them, so
// `Terminal.write`'s native is in `Terminal.ts` and nothing but the tags lives
// here.
//
// NOTE: No shared instances, unlike `Side` and `Ordering`. Nothing native
// ANSWERS with a Stream — a Stream only ever travels from a call site into
// `write` — so the singletons those Choices keep for their `compare` Methods
// would have no caller here. The Compiler builds the value at the site that
// writes `#Output`, the way it builds any other payload-less Case.
export type OutputType = { [typeKeySymbol]: "Stream#Output" }
export type ErrorType = { [typeKeySymbol]: "Stream#Error" }
export type StreamType = OutputType | ErrorType
