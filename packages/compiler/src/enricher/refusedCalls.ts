import type { common } from "@essence-lang/interfaces"

// Whether the Arguments being enriched are those of a call that resolved to
// nothing. A Function literal or a member path passed to one has no Parameter
// Types to take. The call's own refusal is the one to report.
let callRefused = false

// Every call sets it for its own Arguments, and a Function literal's body
// clears it. What a nested call or a body holds then reports as anywhere else.
export function underRefusedCall<T>(refused: boolean, work: () => T): T {
	let outer = callRefused

	callRefused = refused

	try {
		return work()
	} finally {
		callRefused = outer
	}
}

export function insideRefusedCall(): boolean {
	return callRefused
}

// The position a refused call's Argument stands in, which no Case construction
// is decided by.
export function refusedPosition(): common.ErrorType | null {
	return callRefused ? { type: "Error" } : null
}
