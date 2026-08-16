§ The same leaf met ALONE and met inside a List. `runIn` walks the items of a
§ List through a loop picked by the item's kind, and the leaf kinds are spelled
§ there as well as in the branch of `buildIn` that compiles one on its own — two
§ spellings of one rule, so a value has to be admitted or refused the same way
§ whichever of them meets it. Every Parameter below is an identity, and each has
§ its List beside it, so the pair can be asked the same question.

implementation {

	function integer(_ value: Integer) -> Integer {
		<- value
	}

	function integers(_ value: List<Integer>) -> List<Integer> {
		<- value
	}

	function text(_ value: String) -> String {
		<- value
	}

	function texts(_ value: List<String>) -> List<String> {
		<- value
	}

	function flag(_ value: Boolean) -> Boolean {
		<- value
	}

	function flags(_ value: List<Boolean>) -> List<Boolean> {
		<- value
	}

	function rational(_ value: Rational) -> Rational {
		<- value
	}

	function rationals(_ value: List<Rational>) -> List<Rational> {
		<- value
	}

	function maybe(_ value: Optional<Integer>) -> Optional<Integer> {
		<- value
	}

	function maybes(
		_ value: List<Optional<Integer>>,
	) -> List<Optional<Integer>> {
		<- value
	}
}

export {
	flag
	flags
	integer
	integers
	maybe
	maybes
	rational
	rationals
	text
	texts
}
