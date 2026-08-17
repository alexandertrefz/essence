§ Deliberately broken: what the Enricher says about a `= expression` default
§ that does not fit, reads a Parameter it can not see, or makes a call
§ ambiguous.

implementation {

	§ A default stands in for an Argument nobody wrote, so it is held to the
	§ Type every written Argument is held to.
	function scaled(_ factor: Integer = "twice") -> Integer {
		<- factor
	}

	§ A default may read `@`, the Parameters to its left, and anything the
	§ Declaration is written inside — never one to its right.
	function cut(from start: Integer = end, to end: Integer) -> Integer {
		<- end::subtract(start)
	}

	§ Never the Parameter it is written on either: the default IS what that
	§ Parameter is bound to when a call leaves the Argument out.
	function repeated(_ times: Integer = times) -> Integer {
		<- times
	}

	§ And never a name a Pattern binds, which is a Constant at the head of the
	§ body — every default is worked out before the body runs.
	type Point = { x: Integer, y: Integer }

	function shifted(_ { x, y }: Point, by amount: Integer = x) -> Integer {
		<- y::add(amount)
	}

	§ An Argument is matched to a Parameter by its label before its Type is
	§ read, and every unlabelled Parameter carries the same label — none.
	function pick(_ first: Integer = 1, _ second: String) -> String {
		<- second
	}

	§ An Overload is selected by the Arguments a call writes, so two entries
	§ that accept the same ones can not both be reached.
	namespace Texts for String {
		overload trimmed {
			() -> String {
				<- @
			}

			(at side: Integer = 1) -> String {
				<- @
			}
		}
	}
}
