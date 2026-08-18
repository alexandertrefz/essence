declarations {

	§ `Step` is how a loop decides whether to go round again. Essence has no
	§ loop Statement, and nothing written in Essence can leave a traversal
	§ partway. Returning with `<-` leaves the callback, not the loop around it.
	§ So the decision is a value instead: a `step` callback answers `#Continue`
	§ with the next State, or `#Done` with the Result. A `match` checks the two
	§ Cases like any other Choice, and `<-` keeps its one meaning.
	§
	§ `State` is what a loop threads from turn to turn, and `Result` is what it
	§ finishes with. The two are independent. The `loop` family in `Loop.es`
	§ and `List::reduce`'s early-stopping entry both consume the Choice.
	choice Step<State, Result> {
		Continue { state: State },
		Done { value: Result },
	}
}

export {
	Step
}
