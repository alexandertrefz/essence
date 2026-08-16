§ The shapes the boundary REFUSES, together in one Module — an Optional inside
§ an Optional, a Case whose payload is named after the tag, a value from the
§ numeric tower above Rational, and a bare Case an Optional stands between a
§ String and. Each of them has to be refused where it is met rather than
§ answered wrongly, and none of them may take the rest of the Module down with
§ it.

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

	choice Direction {
		Up,
		Down,
	}

	§ The two places an Optional can stand between a bare Case and a String,
	§ and neither hides the collision: `Optional` is spelled by absence, so what
	§ it holds stands in the position beside everything else.
	function noted(_ value: Optional<String> | Direction) -> Optional<String> | Direction {
		<- value
	}

	function wrapped(_ value: Optional<Direction | String>) -> Optional<Direction | String> {
		<- value
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
	Direction
	noted
	wrapped
	doubled
	deep
	shallow
	root
	answer
}
