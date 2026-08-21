§ This file does not compile — on purpose.
§
§ It writes the tests forms everywhere they do not belong, and the assertion
§ forms that belong nowhere at all, so that the Parser's report about them can
§ be read end to end in one run:
§
§     bun packages/cli/bin/esc check packages/fixtures/files/diagnostics/TestsSyntax.es
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

	require { team } as standing = lions
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

	§ The five assertion forms the language does not have.
	test "writes a Matcher where none belongs" {
		§ matcher-on-expect — an `expect` records its result and the test
		§ carries on, so a name it introduced would stand below a line that may
		§ never have run. Taking a value apart is `require`'s alone.
		expect { team } = lions

		§ matcher-after-value — a Matcher written behind an `is`. A name is
		§ introduced left of `=`, in a Parameter, or in a Handler head, and
		§ `is` is the Equatable Method every value has — so a Matcher written
		§ behind it reads as a comparison that USES the name it is declaring.
		require lions is { team, points }

		§ wildcard-in-require — a Matcher left of `=` both asks what the value
		§ has to be and names its parts, and `_` does neither.
		require _ = lions

		§ literal-in-require — a written value is not a shape: what it asks is
		§ whether the two are equal, which is what `Equatable::is` answers.
		require 3 = lions.points

		§ snapshot-after-matcher — a snapshot records a value, and this line
		§ took one apart. What there is to record is the name it introduced,
		§ on a line of its own.
		require { team } = lions matches snapshot
	}
}
