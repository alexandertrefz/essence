import { type AnyType, typeKeySymbol } from "./type"

// The builtin generic Choice a `loop` step answers. An Essence body builds each
// Case through `createCase`, so only the Types the loop drivers read live here.
export type ContinueType<State extends AnyType> = {
	[typeKeySymbol]: "Step#Continue"
	state: State
}

export type DoneType<Answer extends AnyType> = {
	[typeKeySymbol]: "Step#Done"
	value: Answer
}

export type StepType<State extends AnyType, Answer extends AnyType> =
	| ContinueType<State>
	| DoneType<Answer>
