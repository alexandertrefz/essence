import {
	Boolean from "./Boolean.es"
	Integer from "./Integer.es"
	Step    from "./Step.es"
}

declarations {

	§ The `loop` family — the condition-driven, counting and general loops a
	§ language without a loop Statement still needs. They belong to no Namespace
	§ — there is no receiver to hang them on, a loop is about the State it
	§ threads, not about a value it is a Method of — so they are free Functions,
	§ resolved by their labels exactly as an overloaded Method's entries are.
	§
	§ TWO of the four are native, because a driver has to loop somehow and, in a
	§ language whose only recursion is not stack-safe, only a native can. They
	§ are the two irreducible ones: `while`, which threads a State for as long as
	§ a predicate holds, and the general `step -> Step` loop, which finishes with
	§ a Result of its OWN Type the moment a step answers `#Done`. The general
	§ loop can NOT be built on `while`: `while` only ever hands back its State,
	§ and there is no way to name the arbitrary Result at the point it stops, so
	§ the two are genuinely separate primitives.
	§
	§ The other two are written in Essence, on `while`. `until` is `while` with
	§ the predicate negated. The counted loop threads `{ index, carried }` and
	§ stops when the index passes its far endpoint. Neither needs a `Step` — the
	§ predicate `while` already checks is the whole of their stopping — which is
	§ why they build on `while` rather than on the general loop.
	§
	§ The convention across the family: a `startingWith` value seeds the State, a
	§ `step` callback advances it, and `while`/`until` introduce a predicate that
	§ is checked BEFORE each step. The general entry's `step` answers with a
	§ `Step` and may stop early; the condition-driven and counting entries thread
	§ State plainly and always finish.

	§§ Threads a State through repeated steps — the way a language without a loop
	§§ Statement still walks one. A `startingWith` value seeds the State and a
	§§ `step` callback advances it; the overloads differ only in what ends the
	§§ walk. `while` and `until` check a predicate before each step; the counted
	§§ entry runs once per Integer from `from` through `through`; and the general
	§§ entry lets a `step` answer with a `Step`, stopping the moment it says
	§§ `#Done` and finishing with a Result of its own Type. Pick the overload by
	§§ the labels it reads, exactly as with an overloaded Method.
	§§
	§§ @param startingWith — the State the first step builds on.
	§§ @param step — the body that advances the running State each turn.
	§§ @returns — the State the walk settles on, or the Result a `#Done` carries.
	overload function loop {
		§§ Steps a State while a condition holds — the `while` loop, one of the
		§§ family's two native primitives. The condition is checked BEFORE each
		§§ step, so a condition false on the seed returns it unchanged, and the
		§§ loop runs zero times.
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

		§§ Steps a State until a condition holds — the `until` loop, the negation
		§§ of the `while` entry it is written on. The condition is checked BEFORE
		§§ each step, so a condition already `true` on the seed returns it
		§§ unchanged, and the loop runs zero times.
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
			§ `until` IS `while` with the predicate flipped — the one native
			§ predicate loop answers both.
			<- loop(
				startingWith state,
				while (current) { <- condition(current)::negate() },
				step advance,
			)
		}

		§§ Runs a body once for each Integer from `from` through `through`, both
		§§ included, threading a State from one turn to the next — the counted
		§§ loop. Counts UP when `from` is the lesser and DOWN when it is the
		§§ greater, mirroring `List.of(integersFrom:through:)`, so `loop(from 3,
		§§ through 1, …)` visits 3, 2, 1. Always finishes: the range is fixed
		§§ before the first step.
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
			§ Record. The direction is fixed once, before the first step: counting
			§ up runs while the index has not passed `end` from below, counting
			§ down while it has not passed it from above. `carried` is the caller's
			§ State; `index` is the tally the body is handed each turn.
			if start::isLessThanOrEqualTo(end) {
				constant counted = loop(startingWith {
					index = start,
					carried = state,
				}, while (current) {
					<- current.index::isLessThanOrEqualTo(end)
				}, step (current) {
					<- {
						index = current.index::add(1),
						carried = advance(current.index, current.carried),
					}
				})

				<- counted.carried
			} else {
				constant counted = loop(startingWith {
					index = start,
					carried = state,
				}, while (current) {
					<- current.index::isGreaterThanOrEqualTo(end)
				}, step (current) {
					<- {
						index = current.index::subtract(1),
						carried = advance(current.index, current.carried),
					}
				})

				<- counted.carried
			}
		}

		§§ Steps a State until the body says to stop — the general loop, the
		§§ family's other native primitive. Each step answers with a `Step`:
		§§ `#Continue` carries the next State and the loop goes again, `#Done`
		§§ carries the Result and the loop finishes with it. This is the entry
		§§ that can end on a decision the State makes rather than on a count or a
		§§ fixed predicate, and the one that finishes with a Result of its own
		§§ Type rather than with the State.
		§§
		§§ @param startingWith — the State the loop begins from.
		§§ @param step — the body, handed the running State and answering with a `Step` — `#Continue` to go again, `#Done` to stop.
		§§ @returns — the Result the first `#Done` carries.
		<infer State, infer Result>(
			startingWith state: State,
			step advance: (_: State) -> Step<State, Result>,
		) -> Result
	}
}

export {
	loop
}
