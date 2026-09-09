§ This file does not compile — on purpose.
§
§ Both `define`s below answer with a bare Case, which decides no Type of its
§ own, and neither has anything to hand one down:
§
§     bun packages/cli/bin/esc check packages/fixtures/files/diagnostics/DefineAnswers.es
§
§ Keep it broken. If a change makes one of these compile, the Diagnostic it
§ was showcasing no longer has a home.

implementation {
	function count (_ found: Optional<Integer>) -> Integer {
		<- found::value(defaultingTo 0)
	}

	constant skipped = true

	§ define-without-answer-type — a Choice's Type Parameters are applied and
	§ never inferred, so `#Empty` says nothing about what it is empty OF. The
	§ Declaration writes no annotation, and the `define` writes no arrow.
	constant fetched = define {
		as #Empty if skipped
		as Optional<Integer>#Value(1) otherwise
	}

	§ define-without-answer-type — and the position that can not be annotated at
	§ all. A call picks its Overload BY the Arguments, so the Parameter's Type is
	§ not decided before they are read, and an Argument hands nothing down.
	constant total = count(define {
		as #Empty if skipped
		as Optional<Integer>#Value(2) otherwise
	})
}
