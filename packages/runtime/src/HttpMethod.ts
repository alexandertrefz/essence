import { typeKeySymbol } from "./type"

// NOTE: `HttpMethod` is a builtin Choice, like `Stream` and `Side` — its values
// carry Case tags (`"HttpMethod#Get"`) exactly as user-declared Cases do. `is`,
// `isNot` and `toString` are all derived from the Choice
// (`packages/standard-library/sources/Http.es` declares the conformances beside
// it), so nothing but the tags lives here.
//
// NOTE: No shared instances, for the reason `Stream` keeps none. Nothing native
// ANSWERS with a method — one only ever travels from a call site into
// `Http.send` — so singletons like the ones `Ordering` keeps for the natives
// that answer it would have no caller here. The Compiler builds the value at
// the site that writes `#Get`, the way it builds any other payload-less Case.
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
