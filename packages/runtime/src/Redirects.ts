import { typeKeySymbol } from "./type"

// A builtin Choice. `send` in `Http.ts` reads its tag. No native answers one,
// so it keeps no shared instances. See "Builtin Choices" in DEVELOPMENT.md.
export type FollowType = { [typeKeySymbol]: "Redirects#Follow" }
export type ManualType = { [typeKeySymbol]: "Redirects#Manual" }
export type RefuseType = { [typeKeySymbol]: "Redirects#Refuse" }
export type RedirectsType = FollowType | ManualType | RefuseType
