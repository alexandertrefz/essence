import type { BooleanType } from "./Boolean"
import type { StepType } from "./Step"
import { type AnyType, typeKeySymbol } from "./type"

// The native drivers of the `loop` Overloads in `Loop.es`, each bound by its
// mangled name. A loop can not be written in Essence without a loop, so the
// other entries are written on these.

// The `while` loop. The condition is checked before each step, so a condition
// false on the seed answers the seed.
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

// The general loop. Each step answers a `Step`: `#Done` carries the answer and
// `#Continue` the next State.
export function loop__overload$4<State extends AnyType, Answer extends AnyType>(
	state: State,
	advance: (state: State) => StepType<State, Answer>,
): Answer {
	while (true) {
		let next = advance(state)

		if (next[typeKeySymbol] === "Step#Done") {
			return next.value
		}

		state = next.state
	}
}
