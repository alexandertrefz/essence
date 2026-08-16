§ The shapes the boundary REFUSES, together in one Module — an Optional inside
§ an Optional, a Case whose payload is named after the tag, and a value from the
§ numeric tower above Rational. Each of them has to be refused where it is met
§ rather than answered wrongly, and none of them may take the rest of the Module
§ down with it.

implementation {

	choice Tagged {
		One { $case: String },
		Plain,
	}

	function nested(_ value: Optional<Optional<Integer>>) -> Optional<Optional<Integer>> {
		<- value
	}

	§ A Type Alias whose member is one of those. It comes OUT under its name and
	§ can not go back IN under it, so a Parameter of it has to be spelled out.
	type Nest = { level: Optional<Optional<Integer>> }

	function nesting(_ nest: Nest) -> Nest {
		<- nest
	}

	function nameOf(_ value: Tagged) -> String {
		<- match value -> String {
			case #One   { <- @.$case }
			case #Plain { <- "plain" }
		}
	}

	function tagged(_ value: String) -> Tagged {
		<- #One({ $case = value })
	}

	function doubled(_ value: Integer) -> Integer {
		<- value::multiply(with 2)
	}

	constant deep: Optional<Optional<Integer>> = #Value(#Empty)
	constant shallow: Optional<Optional<Integer>> = #Empty
	constant root = 2::squareRoot()
	constant answer = 42
}

export {
	Nest
	Tagged
	nested
	nesting
	nameOf
	tagged
	doubled
	deep
	shallow
	root
	answer
}
