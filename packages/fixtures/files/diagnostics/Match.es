§ This file does not compile — on purpose.
§
§ Every statement below triggers a different Diagnostic, so that the
§ Compiler's error output can be read end to end in one run:
§
§     bun bin/esc check testFiles/diagnostics/Match.es
§
§ Keep it broken. If a change makes one of these compile, the Diagnostic it
§ was showcasing no longer has a home.

implementation {
	choice Signal {
		Red,
		Amber,
		Green,
	}

	constant signal: Signal = Signal#Red

	§ missing-case — every unhandled Case is listed once, not once each.
	constant action = match signal -> String {
		case #Red { <- "stop" }
	}

	§ unreachable-case — a Warning, greyed out at the Matcher itself.
	constant other: Integer | Nothing = 1

	constant described = match other -> String {
		case Integer { <- "number" }
		case Nothing { <- "nothing" }
		case String { <- "never" }
	}

	§ match-on-non-union.
	constant only = match "essence" -> String {
		case String { <- @ }
	}
}
