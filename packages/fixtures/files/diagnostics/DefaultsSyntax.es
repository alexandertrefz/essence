§ Deliberately broken: the two places a `= expression` default is refused by
§ the Parser, because a call could never reach it there.

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
}
