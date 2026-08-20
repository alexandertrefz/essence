§ This file does not compile — on purpose.
§
§ It writes the tests forms everywhere they do not belong, so that the
§ Parser's report about them can be read end to end in one run:
§
§     bun packages/cli/bin/esc check packages/fixtures/files/diagnostics/Tests.es
§
§ Keep it broken. If a change makes this compile, the Diagnostic it was
§ showcasing no longer has a home.

implementation {
	constant lions = { team = "Lions", points = 0 }

	§ test-outside-tests — a test and a suite are items of the tests section
	§ and of the suites nested in it. The whole item is read before it is
	§ refused, so the Diagnostic is about the item rather than about the first
	§ Token inside a block nobody expected.
	test "records a win as three points" {
		expect lions.points::is(3)
	}

	suite "Standing" {
		test "has no rate before it has played" {
			expect lions.points::is(0)
		}
	}

	§ expect-outside-test — an assertion records its result against the test
	§ that is running, and here there is none.
	expect lions.team::is("Lions")

	require lions is { team } as standing
}

export {
	lions
}

§ misplaced-tests-section — a Program reads top to bottom: what it imports,
§ what it does, what it proves, what it exports. The block is kept where it
§ stands all the same, so one Diagnostic about an order does not become a
§ cascade about everything inside it.
tests {
	test "records a win as three points" {
		expect lions.points::is(3)
	}
}
