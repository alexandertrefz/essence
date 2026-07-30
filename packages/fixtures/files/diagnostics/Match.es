§ This file does not compile — on purpose.
§
§ Every statement below triggers a different Diagnostic, so that the
§ Compiler's error output can be read end to end in one run:
§
§     bun packages/cli/bin/esc check packages/fixtures/files/diagnostics/Match.es
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

	§ unreachable-case — a Warning, greyed out at the Matcher itself. The
	§ receiver is a structural Union rather than a Choice, so that this and the
	§ `missing-case` above cover both kinds of Type a `match` takes apart. The
	§ members are ordinary Types: what makes the last Case unreachable is that
	§ `String` is not one of them, not anything about the Union's shape.
	constant other: Integer | Boolean = 1

	constant described = match other -> String {
		case Integer { <- "number" }
		case Boolean { <- "flag" }
		case String  { <- "never" }
	}

	§ match-on-non-union. An Integer and a String are taken apart by VALUE, but
	§ only where a Case names one — this Match asks nothing about the String it was
	§ given, which is the one outcome the Diagnostic is about.
	constant only = match "essence" -> String {
		case String { <- @ }
	}

	§ literal-match-shape — a Match on an Integer DOES name a value, so its Cases
	§ are written values and the last one answers for the rest. This one's first
	§ Case names a value and can still decline it, which would let the value it
	§ named reach a Case whose evidence says it never sees one.
	constant count = 3

	constant counted = match count -> String {
		case 0 where count::isNot(1) { <- "zero" }
		case _ { <- "some" }
	}

	§ literal-match-shape — and a Match that names a value and stops there, with
	§ every other Integer unanswered for.
	constant partial = match count -> String {
		case 0 { <- "zero" }
	}
}
