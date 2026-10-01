import { typeKeySymbol } from "./type"

// A builtin Choice. `send` in `Http.ts` reads its tag. No native answers one,
// so it keeps no shared instances. See "Builtin Choices" in DEVELOPMENT.md.
export type GetType = { [typeKeySymbol]: "HttpMethod#Get" }
export type PostType = { [typeKeySymbol]: "HttpMethod#Post" }
export type PutType = { [typeKeySymbol]: "HttpMethod#Put" }
export type PatchType = { [typeKeySymbol]: "HttpMethod#Patch" }
export type DeleteType = { [typeKeySymbol]: "HttpMethod#Delete" }
export type HeadType = { [typeKeySymbol]: "HttpMethod#Head" }
export type OptionsType = { [typeKeySymbol]: "HttpMethod#Options" }
export type HttpMethodType =
	| GetType
	| PostType
	| PutType
	| PatchType
	| DeleteType
	| HeadType
	| OptionsType
