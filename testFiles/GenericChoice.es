implementation {

	§ A generic Choice abstracts over the Types its Cases carry, exactly like
	§ an Alias or a Namespace can. `Step` is the early-exit value: a driver keeps
	§ going while the callback answers `#Continue`, and stops with the `#Done`
	§ payload — so the control flow is an ordinary value the Match sees.
	choice Step<State, Result> {
		Continue { state: State },
		Done { value: Result },
	}

	§ The general loop driver, written in Essence — no native needed. `State`
	§ binds from `startingWith`, then the callback's Parameter and its `#Done`
	§ payload bind `Result`. The recursion is the loop.
	namespace Loop {
		static run<infer State, infer Result>(
			startingWith state: State,
			step advance: (_ state: State) -> Step<State, Result>,
		) -> Result {
			<- match advance(state) -> Result {
				case #Continue { <- Loop.run(startingWith @.state, step advance) }
				case #Done { <- @.value }
			}
		}
	}

	§ Prefixed construction with an explicit payload Record.
	constant startState: Step<{ index: Integer, total: Integer }, Integer> =
		Step#Continue({ state = { index = 1, total = 0 } })

	§ Match narrows an instantiated Case to its concrete member Types —
	§ `@.state` is the Record, `@.total` inside it is an Integer.
	__print(match startState -> Integer {
		case #Continue { <- @.state.total }
		case #Done { <- @.value }
	})                                          § 0

	§ The driver, threading a Record State through `{ state with … }` and
	§ stopping with the one-member `#Done` shorthand — `#Done(state.total)`
	§ instead of `#Done({ value = state.total })`.
	constant summed: Integer = Loop.run(
		startingWith { index = 1, total = 0 },
		step (state) {
			if state.index::isGreaterThan(5) { <- #Done(state.total) }

			<- #Continue({ state with
				index = state.index::add(1),
				total = state.total::add(state.index),
			})
		})

	__print(summed::toString())                 § "15"

	§ A bare `#Done` resolves against the annotation; the shorthand wraps the
	§ lone Integer into the Case's one-member Record.
	constant answer: Step<Integer, Integer> = #Done(42)

	__print(match answer -> Integer {
		case #Continue { <- @.state }
		case #Done { <- @.value }
	})                                          § 42

	§ A generic Choice with a unit Case still constructs and matches.
	choice Box<Value> {
		Full { value: Value },
		Empty,
	}

	constant full: Box<String> = #Full("packed")
	constant empty: Box<String> = Box#Empty

	__print(match full -> String {
		case #Full { <- @.value }
		case #Empty { <- "nothing" }
	})                                          § "packed"

	__print(match empty -> String {
		case #Full { <- @.value }
		case #Empty { <- "nothing" }
	})                                          § "nothing"

}
