declarations {

	§ `Step` is how a loop decides whether to go round again. Essence has no
	§ loop Statement, and nothing written IN Essence can leave a traversal
	§ partway — `<-` returns from the callback, never from the walk around it.
	§ So the decision is made a VALUE instead: a `step` callback answers with a
	§ `Step`, and the driver reads it. `Step#Continue` carries the next State and
	§ the loop goes again; `Step#Done` carries the Result and the loop stops with
	§ it. Because the choice is an ordinary Case value, the type system sees the
	§ control flow, a Match checks it for exhaustiveness like any other Choice,
	§ and `<-` keeps its one meaning.
	§
	§ It is the first generic builtin Choice — `State` is whatever the loop
	§ threads from one turn to the next, `Result` is what it finishes with. The
	§ two are independent: a loop may thread a Record of counters and finish with
	§ a single Integer. The `loop` family below consumes it, and `List.reduce`'s
	§ early-stopping entry answers with it too.
	choice Step<State, Result> {
		Continue { state: State },
		Done { value: Result },
	}

	§ The `loop` family — the counting, condition-driven and general loops a
	§ language without a loop Statement still needs. Every entry is a native: a
	§ driver written in Essence would itself need a loop to write, and only
	§ non-stack-safe recursion could stand in. They belong to no Namespace —
	§ there is no receiver to hang them on, a loop is about the State it threads,
	§ not about a value it is a Method of — so they are free Functions, resolved
	§ by their labels exactly as an overloaded Method's entries are.
	§
	§ The convention across the family: a `startingWith` value seeds the State, a
	§ `step` callback advances it, and `while`/`until` introduce a predicate that
	§ is checked BEFORE each step. The `step` callback of the general entry ($4)
	§ answers with a `Step` and may stop early; the counting and condition-driven
	§ entries thread State plainly and always finish.

	§§ Runs a body once for each Integer from `from` through `through`, both
	§§ included, threading a State from one turn to the next — the counted loop.
	§§ Counts UP when `from` is the lesser and DOWN when it is the greater,
	§§ mirroring `List.of(integersFrom:through:)`, so `loop(from 3, through 1, …)`
	§§ visits 3, 2, 1. Always finishes: the range is fixed before the first step.
	§§
	§§ @param from the first Integer the body sees.
	§§ @param through the last Integer the body sees, included.
	§§ @param startingWith the State the first step builds on.
	§§ @param step the body, handed each Integer and the running State, answering with the next State.
	§§ @returns the State after the last step.
	overload function loop {
		§§ Runs a body once for each Integer from `from` through `through`, both
		§§ included, threading a State — counting down when `from` is the greater.
		§§
		§§ @param from the first Integer the body sees.
		§§ @param through the last Integer the body sees, included.
		§§ @param startingWith the State the first step builds on.
		§§ @param step the body, handed each Integer and the running State, answering with the next State.
		§§ @returns the State after the last step.
		<infer State>(
			from start: Integer,
			through end: Integer,
			startingWith state: State,
			step advance: (_: Integer, _: State) -> State,
		) -> State

		§§ Steps a State while a condition holds — the `while` loop. The condition
		§§ is checked BEFORE each step, so a condition false on the seed returns it
		§§ unchanged, and the loop runs zero times.
		§§
		§§ @param startingWith the State the loop begins from.
		§§ @param while the condition, checked against the State before each step; the loop continues while it is `true`.
		§§ @param step the body, handed the running State and answering with the next.
		§§ @returns the first State the condition rejects.
		<infer State>(
			startingWith state: State,
			while condition: (_: State) -> Boolean,
			step advance: (_: State) -> State,
		) -> State

		§§ Steps a State until a condition holds — the `until` loop, the negation
		§§ of the `while` entry. The condition is checked BEFORE each step, so a
		§§ condition already `true` on the seed returns it unchanged, and the loop
		§§ runs zero times.
		§§
		§§ @param startingWith the State the loop begins from.
		§§ @param until the condition, checked against the State before each step; the loop continues while it is `false`.
		§§ @param step the body, handed the running State and answering with the next.
		§§ @returns the first State the condition accepts.
		<infer State>(
			startingWith state: State,
			until condition: (_: State) -> Boolean,
			step advance: (_: State) -> State,
		) -> State

		§§ Steps a State until the body says to stop — the general loop. Each step
		§§ answers with a `Step`: `#Continue` carries the next State and the loop
		§§ goes again, `#Done` carries the Result and the loop finishes with it.
		§§ This is the entry that can end on a decision the State makes rather than
		§§ on a count or a fixed predicate, and the one that finishes with a
		§§ Result of its own Type rather than with the State.
		§§
		§§ @param startingWith the State the loop begins from.
		§§ @param step the body, handed the running State and answering with a `Step` — `#Continue` to go again, `#Done` to stop.
		§§ @returns the Result the first `#Done` carries.
		<infer State, infer Result>(
			startingWith state: State,
			step advance: (_: State) -> Step<State, Result>,
		) -> Result
	}
}
