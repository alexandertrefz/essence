import type { BooleanType } from "./Boolean"
import type { StepType } from "./Step"
import { type AnyType, typeKeySymbol } from "./type"

// NOTE: The `loop` family — the native drivers behind the `loop` Overloads
// declared in `packages/stdlib/sources/Loop.es`. Each is a free Function, bound by its
// mangled `loop__overload$N` name to the Overload it implements; the order here
// is the order the entries are written there. Only TWO are native: a loop can
// not be written in Essence — it would need a loop to write — so the two
// irreducible drivers stay here, each a plain JavaScript loop threading the
// State the callback hands back. The `until` and counted entries are written in
// Essence on `while` (see `Loop.es`), so they have no driver here.

// NOTE: `$1` is the `while` loop — steps while the condition holds, checked
// BEFORE each step, so a condition false on the seed returns it unchanged. It is
// the predicate primitive the Essence `until` and counted entries build on.
export function loop__overload$1<State extends AnyType>(
	state: State,
	condition: (state: State) => BooleanType,
	advance: (state: State) => State,
): State {
	while (condition(state).value) {
		state = advance(state)
	}

	return state
}

// NOTE: `$4` is the general loop — each step answers with a `Step`. `#Done` stops the
// loop and its `value` is the Result; `#Continue` carries the next State and the
// loop goes again. The tag is read the same way `List.sort` reads an `Ordering`.
export function loop__overload$4<State extends AnyType, Result extends AnyType>(
	state: State,
	advance: (state: State) => StepType<State, Result>,
): Result {
	while (true) {
		let next = advance(state)

		if (next[typeKeySymbol] === "Step#Done") {
			return next.value
		}

		state = next.state
	}
}
