§ This file does not compile — on purpose.
§
§ It asserts things that are not Booleans, so that the report about an
§ assertion's value can be read end to end.
§
§ A tests section is only ever enriched by a compile that ASKS for it, so
§ `esc check` of this file reports nothing at all — a build drops the block.
§ What reads it is `diagnosticShowcase.spec.ts`, which compiles every showcase
§ file the way `essence test` does.
§
§ It enriches cleanly and fails the Validator, which is why it is a file of its
§ own: `Tests.es` fails the Enricher, and nothing below the earliest failing
§ stage ever runs.
§
§ Keep it broken. If a change makes this compile, the Diagnostic it was
§ showcasing no longer has a home.

implementation {
	constant lions = { team = "Lions", points = 0 }
}

export {
	lions
}

tests {

	§ expect-not-boolean — Essence has no truthiness. An assertion is a Boolean
	§ Expression, and the standard library's own Methods are the vocabulary it
	§ is written in: there is no `toEqual`, no `toBeGreaterThan`, no
	§ `toContain`.
	test "asserts a Standing" {
		expect lions
	}

	§ The same rule, and the same Diagnostic, for the assertion that ENDS a
	§ test rather than recording and carrying on.
	test "requires a name" {
		require lions.team
	}

	§ A Matcher is the other question an assertion can ask, and it is not this
	§ one — `require MATCHER = EXPR` takes the value apart instead of judging
	§ it, so nothing here has to be a Boolean.
	test "takes it apart instead" {
		require { team, points } = lions

		expect team::is("Lions")
		expect points::is(0)
	}
}
