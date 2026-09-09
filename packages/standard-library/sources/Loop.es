import {
	from "./Boolean.es" { Boolean }
	from "./Integer.es" { Integer }
	from "./Step.es" { Step }
}

declarations {

	§ `loop` is the family of loops a language without a loop Statement needs.
	§ They are free Functions rather than Methods, because a loop is about the
	§ State it threads, not about a value it hangs off. The entries resolve by
	§ their labels, as an overloaded Method's entries do.
	§
	§ Two of the nine are native, because only a native can loop where the one
	§ recursion is not stack-safe. They are `while` and the general
	§ `step -> Step` loop. The general loop can not be written on `while`, which
	§ only ever answers with its State: no Expression names the answer where
	§ the loop stops. Four of the other seven are written on `while`, because a
	§ predicate or a count is the whole of their stopping. The last three are
	§ written on the general loop, because their body can stop them too.
	§
	§ The body is positional where it runs the walk to its end, and labelled
	§ `step` where it answers with a `Step`. That is how `List::reduce`
	§ separates its own two entries. The label is the whole of the difference at
	§ four of the counted entries. An earlier family labelled every body `step`,
	§ so the counted early exit had no spelling at all. A callback's answer Type
	§ is not what an Overload is chosen by.

	§§ Answers the State the loop settles on, or the answer a step stops with.
	§§
	§§ A `startingWith` value seeds the State and a body advances it. The entries differ in what ends the loop. The `while` and `until` entries check a predicate before each step. The counted entries run over a range of Integers. A positional body runs the loop to its end. A `step` body answers with a `Step` and can stop the loop early. Pick the entry by the labels it reads, as with an overloaded Method.
	§§
	§§ @returns — the State the loop settles on, or the value a `#Done` carries.
	overload function loop {
		§§ Answers the first State the condition rejects.
		§§
		§§ The condition is checked before each step. A condition that is false on the seed answers the seed unchanged, and the loop runs zero times. This entry is one of the family's two natives.
		§§
		§§ @param startingWith — the State the loop begins from.
		§§ @param while — the condition, checked against the State before each step; the loop continues while it is `true`.
		§§ @param _ — the body, handed the running State and answering with the next.
		§§ @returns — the first State the condition rejects.
		<infer State>(
			startingWith state: State,
			while condition: (_: State) -> Boolean,
			_ advance: (_: State) -> State,
		) -> State

		§§ Answers the first State the condition accepts.
		§§
		§§ The condition is checked before each step. A condition already `true` on the seed answers the seed unchanged, and the loop runs zero times.
		§§
		§§ @param startingWith — the State the loop begins from.
		§§ @param until — the condition, checked against the State before each step; the loop continues while it is `false`.
		§§ @param _ — the body, handed the running State and answering with the next.
		§§ @returns — the first State the condition accepts.
		<infer State>(
			startingWith state: State,
			until condition: (_: State) -> Boolean,
			_ advance: (_: State) -> State,
		) -> State {
			§ `until` is `while` with the predicate negated, so one native
			§ predicate loop answers both.
			<- loop(
				startingWith state,
				while (current) { <- condition(current)::negate() },
				advance,
			)
		}

		§§ Runs the body once for each Integer from `from` up through `through`, and answers the State after the last step.
		§§
		§§ Both endpoints are included and the count only runs up. An end below the start runs the body zero times and answers the seed untouched. That mirrors `List.of(integersFrom:through:)`. To count down, use the `downTo:` entry. The entry always finishes, because the range is fixed before the first step.
		§§
		§§ @param from — the first Integer the body sees.
		§§ @param through — the last Integer the body sees, included.
		§§ @param startingWith — the State the first step builds on.
		§§ @param _ — the body, handed each Integer and the running State, answering with the next State.
		§§ @returns — the State after the last step, or the seed when the body never runs.
		<infer State>(
			from start: Integer,
			through end: Integer,
			startingWith state: State,
			_ advance: (_: Integer, _: State) -> State,
		) -> State {
			§ Written on `while`, threading the counter beside the State in a
			§ Record. The `carried` member is the caller's State, and `index`
			§ is the count the body is handed each turn.
			constant { carried } = loop(
				startingWith { index = start, carried = state },
				while ({ index }) { <- index::isLessThanOrEqualTo(end) },
				({ index, carried }) {
					<- {
						index = index::add(1),
						carried = advance(index, carried),
					}
				},
			)

			<- carried
		}

		§§ Answers the value the first `#Done` carries.
		§§
		§§ Each step answers with a `Step`. A `#Continue` carries the next State, and the loop goes again. A `#Done` carries the answer, and the loop finishes with it. This entry ends on a decision the State makes, rather than on a count or a fixed predicate. It is the family's other native.
		§§
		§§ @param startingWith — the State the loop begins from.
		§§ @param step — the body, handed the running State and answering with a `Step`: `#Continue` to go again, `#Done` to stop.
		§§ @returns — the value the first `#Done` carries.
		<infer State, infer Answer>(
			startingWith state: State,
			step advance: (_: State) -> Step<State, Answer>,
		) -> Answer

		§§ Runs the body once for each Integer from `from` up to, but not including, `upTo`, and answers the State after the last step.
		§§
		§§ The count only runs up. The body runs zero times when `upTo` is not above `from`, and the seed is answered untouched. That mirrors `List.of(integersFrom:upTo:)`, so a count written from a length is empty rather than inverted.
		§§
		§§ @param from — the first Integer the body sees.
		§§ @param upTo — the Integer the count stops before.
		§§ @param startingWith — the State the first step builds on.
		§§ @param _ — the body, handed each Integer and the running State, answering with the next State.
		§§ @returns — the State after the last step, or the seed when the body never runs.
		<infer State>(
			from start: Integer,
			upTo end: Integer,
			startingWith state: State,
			_ advance: (_: Integer, _: State) -> State,
		) -> State {
			§ Written on the counted entry above, whose end is included. That
			§ entry counts up only, so an end at or below the start reaches a
			§ `through` below it and the body never runs.
			<- loop(
				from start,
				through end::subtract(1),
				startingWith state,
				advance,
			)
		}

		§§ Runs the body once for each Integer from `from` down through `downTo`, and answers the State after the last step.
		§§
		§§ Both endpoints are included and the count only runs down. The first Integer is always seen, so an end above the start runs the body once. That mirrors `List.of(integersFrom:downTo:)`. The entry always finishes, because the range is fixed before the first step.
		§§
		§§ @param from — the first Integer the body sees.
		§§ @param downTo — the last Integer the body sees, included.
		§§ @param startingWith — the State the first step builds on.
		§§ @param _ — the body, handed each Integer and the running State, answering with the next State.
		§§ @returns — the State after the last step.
		<infer State>(
			from start: Integer,
			downTo end: Integer,
			startingWith state: State,
			_ advance: (_: Integer, _: State) -> State,
		) -> State {
			§ Written on `while`, as the up-counting entry is, with the first
			§ turn taken before the count is asked anything. That is what makes
			§ the first Integer always seen, which is the promise
			§ `List.of(integersFrom:downTo:)` carries into its Type.
			constant { carried } = loop(
				startingWith {
					index = start::subtract(1),
					carried = advance(start, state),
				},
				while ({ index }) { <- index::isGreaterThanOrEqualTo(end) },
				({ index, carried }) {
					<- {
						index = index::subtract(1),
						carried = advance(index, carried),
					}
				},
			)

			<- carried
		}

		§§ Runs the body over the Integers from `from` up through `through`, and lets the body stop before the end.
		§§
		§§ Each step answers with a `Step`. A `#Continue` carries the next State, and the count goes on. A `#Done` carries the answer, and the loop finishes with it at once. The count running out answers the State the last step carried. An end below the start runs the body zero times and answers the seed.
		§§
		§§ @param from — the first Integer the body sees.
		§§ @param through — the last Integer the body sees, included.
		§§ @param startingWith — the State the first step builds on.
		§§ @param step — the body, handed each Integer and the running State, answering with a `Step`.
		§§ @returns — the State the count ran out on, or the value the first `#Done` carries.
		<infer State>(
			from start: Integer,
			through end: Integer,
			startingWith state: State,
			step advance: (_: Integer, _: State) -> Step<State, State>,
		) -> State {
			§ Written on the general loop, threading the counter beside the
			§ State as the up-counting entry does. The count ends the walk with
			§ a `#Done` of its own, and a `#Done` the body answers with ends it
			§ earlier. Both Type Parameters of the body's `Step` are the State,
			§ which is what lets one answer stand for either ending.
			<- loop(
				startingWith { index = start, carried = state },
				step ({ index, carried }) {
					if index::isGreaterThan(end) {
						<- #Done(carried)
					}

					<- match advance(index, carried)
						-> Step<{ index: Integer, carried: State }, State>
					{
						case #Continue(next) {
							<- #Continue({
								index = index::add(1),
								carried = next,
							})
						}
						case #Done(answer) { <- #Done(answer) }
					}
				},
			)
		}

		§§ Runs the body over the Integers from `from` up to, but not including, `upTo`, and lets the body stop before the end.
		§§
		§§ Each step answers with a `Step`, as the `through:` entry beside it reads. The body runs zero times when `upTo` is not above `from`, and the seed is answered untouched.
		§§
		§§ @param from — the first Integer the body sees.
		§§ @param upTo — the Integer the count stops before.
		§§ @param startingWith — the State the first step builds on.
		§§ @param step — the body, handed each Integer and the running State, answering with a `Step`.
		§§ @returns — the State the count ran out on, or the value the first `#Done` carries.
		<infer State>(
			from start: Integer,
			upTo end: Integer,
			startingWith state: State,
			step advance: (_: Integer, _: State) -> Step<State, State>,
		) -> State {
			§ Written on the Step-answering counted entry above, over an end
			§ one lower, exactly as the run-to-the-end `upTo:` entry is written
			§ on its own neighbour.
			<- loop(
				from start,
				through end::subtract(1),
				startingWith state,
				step advance,
			)
		}

		§§ Runs the body over the Integers from `from` down through `downTo`, and lets the body stop before the end.
		§§
		§§ Each step answers with a `Step`, as the `through:` entry reads. The first Integer is always seen, so an end above the start runs the body once and answers what that step carried.
		§§
		§§ @param from — the first Integer the body sees.
		§§ @param downTo — the last Integer the body sees, included.
		§§ @param startingWith — the State the first step builds on.
		§§ @param step — the body, handed each Integer and the running State, answering with a `Step`.
		§§ @returns — the State the count ran out on, or the value the first `#Done` carries.
		<infer State>(
			from start: Integer,
			downTo end: Integer,
			startingWith state: State,
			step advance: (_: Integer, _: State) -> Step<State, State>,
		) -> State {
			§ Written on the general loop, with the count asked after the body
			§ rather than before it. That is what makes the first Integer always
			§ seen. It is why this entry is not written on the up-counting one
			§ with the comparisons turned round.
			<- loop(
				startingWith { index = start, carried = state },
				step ({ index, carried }) {
					<- match advance(index, carried)
						-> Step<{ index: Integer, carried: State }, State>
					{
						case #Continue(next) {
							if index::isLessThanOrEqualTo(end) {
								<- #Done(next)
							}

							<- #Continue({
								index = index::subtract(1),
								carried = next,
							})
						}
						case #Done(answer) { <- #Done(answer) }
					}
				},
			)
		}
	}
}

export {
	loop
}
