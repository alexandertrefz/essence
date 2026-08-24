import {
	Boolean from "./Boolean.es"
	Integer from "./Integer.es"
	Step    from "./Step.es"
}

declarations {

	§ `loop` is the family of loops a language without a loop Statement needs.
	§ They are free Functions rather than Methods, because a loop is about the
	§ State it threads, not about a value it hangs off. The entries resolve by
	§ their labels, as an overloaded Method's entries do.
	§
	§ Two of the five are native, because only a native can loop where the one
	§ recursion is not stack-safe. They are `while` and the general
	§ `step -> Step` loop. The general loop can not be written on `while`, which
	§ only ever answers with its State: no Expression names the Result where
	§ the loop stops. The other three entries are written in Essence and need
	§ no `Step`, because the predicate is the whole of their stopping. Two of
	§ them are written on `while`, and the exclusive count on the inclusive
	§ one.

	§§ Answers the State the loop settles on, or the Result a step stops with.
	§§
	§§ A `startingWith` value seeds the State and a `step` callback advances it. The entries differ in what ends the loop. The `while` and `until` entries check a predicate before each step. One counted entry runs once per Integer from `from` through `through`, and the other stops before `upTo`. The general entry lets a `step` answer with a `Step`, and finishes with a Result of its own Type. Pick the entry by the labels it reads, as with an overloaded Method.
	§§
	§§ @returns — the State the loop settles on, or the Result a `#Done` carries.
	overload function loop {
		§§ Answers the first State the condition rejects.
		§§
		§§ The condition is checked before each step. A condition that is false on the seed answers the seed unchanged, and the loop runs zero times. This entry is one of the family's two natives.
		§§
		§§ @param startingWith — the State the loop begins from.
		§§ @param while — the condition, checked against the State before each step; the loop continues while it is `true`.
		§§ @param step — the body, handed the running State and answering with the next.
		§§ @returns — the first State the condition rejects.
		<infer State>(
			startingWith state: State,
			while condition: (_: State) -> Boolean,
			step advance: (_: State) -> State,
		) -> State

		§§ Answers the first State the condition accepts.
		§§
		§§ The condition is checked before each step. A condition already `true` on the seed answers the seed unchanged, and the loop runs zero times.
		§§
		§§ @param startingWith — the State the loop begins from.
		§§ @param until — the condition, checked against the State before each step; the loop continues while it is `false`.
		§§ @param step — the body, handed the running State and answering with the next.
		§§ @returns — the first State the condition accepts.
		<infer State>(
			startingWith state: State,
			until condition: (_: State) -> Boolean,
			step advance: (_: State) -> State,
		) -> State {
			§ `until` is `while` with the predicate negated, so one native
			§ predicate loop answers both.
			<- loop(
				startingWith state,
				while (current) { <- condition(current)::negate() },
				step advance,
			)
		}

		§§ Runs the body once for each Integer from `from` through `through`, and answers the State after the last step.
		§§
		§§ Both endpoints are included. The count runs up when `from` is the lesser and down when it is the greater. That mirrors `List.of(integersFrom:through:)`, so `loop(from 3, through 1, …)` visits 3, 2, and 1. The entry always finishes, because the range is fixed before the first step.
		§§
		§§ @param from — the first Integer the body sees.
		§§ @param through — the last Integer the body sees, included.
		§§ @param startingWith — the State the first step builds on.
		§§ @param step — the body, handed each Integer and the running State, answering with the next State.
		§§ @returns — the State after the last step.
		<infer State>(
			from start: Integer,
			through end: Integer,
			startingWith state: State,
			step advance: (_: Integer, _: State) -> State,
		) -> State {
			§ Written on `while`, threading the counter beside the State in a
			§ Record. The `carried` member is the caller's State, and `index`
			§ is the count the body is handed each turn. The direction is fixed
			§ once, before the first step. Counting up runs while the index has
			§ not passed `end` from below; counting down runs while it has not
			§ passed it from above.
			if start::isLessThanOrEqualTo(end) {
				constant { carried } = loop(
					startingWith { index = start, carried = state },
					while ({ index }) { <- index::isLessThanOrEqualTo(end) },
					step ({ index, carried }) {
						<- {
							index = index::add(1),
							carried = advance(index, carried),
						}
					},
				)

				<- carried
			} else {
				constant { carried } = loop(
					startingWith { index = start, carried = state },
					while ({ index }) { <- index::isGreaterThanOrEqualTo(end) },
					step ({ index, carried }) {
						<- {
							index = index::subtract(1),
							carried = advance(index, carried),
						}
					},
				)

				<- carried
			}
		}

		§§ Answers the Result the first `#Done` carries.
		§§
		§§ Each step answers with a `Step`. A `#Continue` carries the next State, and the loop goes again. A `#Done` carries the Result, and the loop finishes with it. This entry ends on a decision the State makes, rather than on a count or a fixed predicate. It is the family's other native.
		§§
		§§ @param startingWith — the State the loop begins from.
		§§ @param step — the body, handed the running State and answering with a `Step`: `#Continue` to go again, `#Done` to stop.
		§§ @returns — the Result the first `#Done` carries.
		<infer State, infer Result>(
			startingWith state: State,
			step advance: (_: State) -> Step<State, Result>,
		) -> Result

		§§ Runs the body once for each Integer from `from` up to, but not including, `upTo`, and answers the State after the last step.
		§§
		§§ The count only runs up. The body runs zero times when `upTo` is not above `from`, and the seed is answered untouched. That mirrors `List.of(integersFrom:upTo:)`, so a count written from a length is empty rather than inverted.
		§§
		§§ @param from — the first Integer the body sees.
		§§ @param upTo — the Integer the count stops before.
		§§ @param startingWith — the State the first step builds on.
		§§ @param step — the body, handed each Integer and the running State, answering with the next State.
		§§ @returns — the State after the last step, or the seed when the body never runs.
		<infer State>(
			from start: Integer,
			upTo end: Integer,
			startingWith state: State,
			step advance: (_: Integer, _: State) -> State,
		) -> State {
			§ Written on the counted entry above, whose range is inclusive. The
			§ guard is what keeps an end at or below the start from counting
			§ down: `upTo start` would otherwise run twice, over `start` and
			§ `start - 1`.
			if end::isGreaterThan(start) {
				<- loop(
					from start,
					through end::subtract(1),
					startingWith state,
					step advance,
				)
			} else {
				<- state
			}
		}
	}
}

export {
	loop
}
