§ Deliberately broken: the three places a `= expression` default is refused by
§ the Parser — twice because a call could never reach it, once because there is
§ nothing there to fill in.

implementation {

	§ A Function literal is called through the Function Type it was written
	§ for, which fixes how many Arguments every call passes.
	constant shorten = (_ count: Integer = 1) -> Integer {
		<- count
	}

	§ A requirement says which calls a conforming Type must answer; a default
	§ is part of how one of them answers.
	protocol Trimmable {
		trim(at side: Integer = 1) -> Self
	}

	§ A Case default fills in the members a construction left out, and a Case
	§ with no payload shape carries none to fill.
	choice Direction {
		Up = { degrees = 0 },
		Down,
	}
}
