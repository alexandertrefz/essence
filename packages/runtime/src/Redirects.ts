import { typeKeySymbol } from "./type"

// NOTE: `Redirects` is a builtin Choice, like `HttpMethod` beside it — its
// values carry Case tags (`"Redirects#Follow"`) exactly as user-declared Cases
// do, and `is`, `isNot` and `toString` are all derived from the Choice
// (`packages/standard-library/sources/Http.es` declares the conformances). No
// shared instances, for the reason `HttpMethod` keeps none: a Case only ever
// travels from a call site into `Http.send`.
export type FollowType = { [typeKeySymbol]: "Redirects#Follow" }
export type ManualType = { [typeKeySymbol]: "Redirects#Manual" }
export type RefuseType = { [typeKeySymbol]: "Redirects#Refuse" }
export type RedirectsType = FollowType | ManualType | RefuseType
