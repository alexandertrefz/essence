§ Deliberately broken: the two `define` shapes the Parser itself turns away —
§ a definition by cases with nothing to answer when every case declines, and an
§ arm written where nothing can ever reach it.
§
§ Keep it broken. If a change makes one of these compile, the Diagnostic it was
§ showcasing no longer has a home.

implementation {
	constant score = 91

	§ Every value here carries a Condition, so a score below 90 leaves the
	§ `define` with nothing to answer. There is no falling off the end of one.
	constant grade = define {
		as "A" if score::isGreaterThanOrEqualTo(90)
	}

	§ The `otherwise` arm always holds, so the `define` answers there whenever it
	§ gets that far and the arm below it never runs.
	constant band = define {
		as "high" if score::isGreaterThanOrEqualTo(90)
		as "some" otherwise
		as "low" if score::isLessThan(10)
	}
}
