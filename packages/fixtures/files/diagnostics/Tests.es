§ This file does not compile — on purpose.
§
§ It writes a tests section whose items are all wrong in one way each, so that
§ the report about a test's Modifiers and its name can be read end to end.
§
§ A tests section is only ever enriched by a compile that ASKS for it, so
§ `esc check` of this file reports nothing at all — a build drops the block.
§ What reads it is `diagnosticShowcase.spec.ts`, which compiles every showcase
§ file the way `essence test` does.
§
§ Everything here is the Enricher's. What a tests section may be spelled like
§ is `TestsSyntax.es`, whose Parser errors stop it long before this stage; what
§ an assertion may assert is `Assertions.es`, whose Diagnostic is the
§ Validator's and only runs where enrichment reported nothing.
§
§ Keep it broken. If a change makes this compile, the Diagnostic it was
§ showcasing no longer has a home.

implementation {
	choice Colour {
		Red,
		Blue,
	}

	constant lions = { team = "Lions", points = 0 }
	constant rows  = [1, 2, 3]
}

export {
	Colour
	lions
	rows
}

tests {

	§ skipped-without-reason — a skip with no reason rots silently, and a skip
	§ with one is a note the report repeats on every run.
	test "renders a forfeit as 3–0" skipped {
		expect lions.points::is(0)
	}

	§ contradictory-modifiers — one asks for this test to run and for the rest
	§ not to; the other asks for it never to run.
	test "records a win as three points" focused skipped "the redesign" {
		expect lions.points::is(3)
	}

	§ unknown-modifier — the vocabulary is `focused`, `skipped` and `tagged`,
	§ and a misspelling of one is answered with the one it meant.
	test "reads the team" focussed {
		expect lions.team::is("Lions")
	}

	§ malformed-modifier — a tag is a bare lower-case name, because that is
	§ what `--tag` and `--skip-tag` match exactly.
	test "sorts ten thousand rows" tagged "slow" {
		expect lions.points::is(0)
	}

	§ duplicate-modifier — a Modifier says something about the whole test, so
	§ writing it twice can only repeat it or contradict it.
	test "reads the points" focused focused {
		expect lions.points::is(0)
	}

	§ table-not-written — every row of a table test is a test in its own right
	§ and carries its row number, so the rows have to be countable before
	§ anything runs.
	test "reads a row" across rows (row: Integer) {
		expect row::isGreaterThan(0)
	}

	§ table-without-rows — every row is a test of its own, so a table test with
	§ none is reported by no line and counted in no total.
	test "reads no rows at all" across [] (row: Integer) {
		expect row::isGreaterThan(0)
	}

	§ table-parameters — each item of the List is one row, and one row is one
	§ value; a test wanting several says so by writing a Record.
	test "reads two rows at once" across [1, 2] (a: Integer, b: Integer) {
		expect a::isLessThan(b)
	}

	§ snapshot-not-printable — a snapshot records what a value LOOKS like,
	§ which is what `Printable::toString` answers, so a value with no such
	§ answer has nothing to record.
	test "renders a Case" {
		expect Colour#Red matches snapshot
	}

	§ property-parameters — a generated Parameter writes a name and a Type, and
	§ nothing else: the Type is the whole of what says what to generate, and a
	§ counterexample is reported beside the name it was generated for.
	test "over anything at all" for any (n) {
		expect true
	}

	§ ungeneratable-type — nothing can build a value of a Function, so nothing
	§ can run this test even once.
	test "over a Function" for any (read: (_: String) -> Integer) {
		expect true
	}

	§ contradictory-test-forms — a table test runs its body once per row a
	§ reader wrote; a property test runs it once per value the runner made up.
	§ One body can not do both.
	test "over rows and values" across [1] (row: Integer) for any (n: Integer) {
		expect true
	}

	§ snapshot-in-property — every case would record into the one slot, and
	§ only the last of them could ever match.
	test "records a draw" for any (n: Integer) {
		expect n::toString() matches snapshot from "drawn"
	}

	§ benchmark-for-any — a measurement is comparable only where every run
	§ does the same work, and a generated value changes the work every case.
	benchmark "counting" for any (n: Integer) {
		expect n::is(n)
	}

	suite "Standing" {
		§ duplicate-test-name — what a test is called, together with the suites
		§ around it, is what identifies it to a stored snapshot and to the
		§ Editor.
		test "counts a win" {
			expect lions.points::is(0)
		}

		test "counts a win" {
			expect lions.points::is(0)
		}
	}
}
