§ This file does not compile — on purpose.
§
§ Every `define` below triggers a different Diagnostic, so that the Compiler's
§ error output can be read end to end in one run:
§
§     bun packages/cli/bin/esc check packages/fixtures/files/diagnostics/Define.es
§
§ Keep it broken. If a change makes one of these compile, the Diagnostic it
§ was showcasing no longer has a home.

implementation {
	constant score = 91

	§ define-without-cases — a Warning, and greyed out rather than underlined:
	§ a `define` whose only arm is the `otherwise` one asks nothing, so it is
	§ the value it answers with written the long way round.
	constant unrated = define {
		as "unrated" otherwise
	}

	§ return-type-mismatch — an arm is what a `define` returns, so every one of
	§ them is held to the answer Type. The arrow wrote this one down.
	constant grade = define -> Integer {
		as "A" if score::isGreaterThanOrEqualTo(90)
		as 0 otherwise
	}

	§ return-type-mismatch — and the same check where the POSITION decided the
	§ answer Type rather than an arrow, which is the other half of the same
	§ claim: the Declaration's annotation reaches every arm.
	constant band: String = define {
		as 1 if score::isGreaterThanOrEqualTo(90)
		as "low" otherwise
	}

	§ condition-not-boolean — an arm's Condition picks the path exactly as an
	§ `if` does, and Essence has no truthiness.
	constant counted = define {
		as "some" if score
		as "none" otherwise
	}
}
