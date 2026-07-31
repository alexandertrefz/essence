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
	§ a single Integer. The `loop` family in `Loop.es` consumes it, and `List.reduce`'s
	§ early-stopping entry answers with it too.
	choice Step<State, Result> {
		Continue { state: State },
		Done { value: Result },
	}
}

export {
	Step
}
