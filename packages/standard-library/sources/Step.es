declarations {

	§ Essence has no loop Statement, and nothing written in Essence can leave
	§ a traversal partway. Returning with `<-` leaves the callback, not the
	§ loop around it. The decision is a value instead, so `<-` keeps its one
	§ meaning.

	§§ What a callback answers to say whether a loop goes round again.
	§§
	§§ `#Continue` carries the next State, and `#Done` carries the answer the loop finishes with. A `match` checks the two Cases like any other Choice.
	§§
	§§ `State` is what a loop threads from turn to turn, and `Answer` is what it finishes with. The two are independent. The `loop` family in `Loop.es` and `List::reduce`'s early-stopping entry both read one.
	choice Step<State, Answer> {
		Continue { state: State },
		Done { value: Answer },
	}
}

export {
	Step
}
