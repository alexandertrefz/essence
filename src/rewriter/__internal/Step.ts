import { type AnyType, typeKeySymbol } from "./type"

// NOTE: `Step` is the builtin generic Choice — its values carry Case tags
// (`"Step#Continue"`, `"Step#Done"`) exactly like user-declared Cases do, and,
// because it is generic, a payload alongside the tag. Unlike `Ordering` or
// `Side`, nothing here is a singleton: a `Step` is CONSTRUCTED at the call site
// by the `step` callback the loop drivers hand it to (through `createCase`), so
// only the Types live here — the shapes the drivers read a tag off, and the
// shapes the generated native contract renders a `loop` signature against.
export type ContinueType<State extends AnyType> = {
	[typeKeySymbol]: "Step#Continue"
	state: State
}

export type DoneType<Result extends AnyType> = {
	[typeKeySymbol]: "Step#Done"
	value: Result
}

export type StepType<State extends AnyType, Result extends AnyType> =
	| ContinueType<State>
	| DoneType<Result>
