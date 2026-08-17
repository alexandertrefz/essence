§ Parameters a call may leave out — what the `.d.ts` says about them, and what
§ the marshaller accepts.

implementation {

	§ A trailing default, which the positional declaration may mark `?`.
	function scaled(_ value: Integer, by factor: Integer = 2) -> Integer {
		<- value::multiply(with factor)
	}

	§ A default with a REQUIRED Parameter after it — legal in Essence, because
	§ the labels tell the two apart, and not legal as `a?: T, b: U` in
	§ TypeScript. The positional declaration keeps it required and widens it;
	§ only the labelled form marks it optional.
	function cut(from start: Integer = 0, to end: Integer) -> Integer {
		<- end::subtract(start)
	}

	§ Every Parameter defaulted, so a call may write nothing at all.
	function greeting(
		with prefix: String = "hello",
		and name: String = "world",
	) -> String {
		<- "{prefix} {name}"
	}
}

export {
	cut
	greeting
	scaled
}
