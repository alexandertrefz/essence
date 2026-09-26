§ This file does not compile — on purpose.
§
§ Every Keyword below is written where it says nothing, or where nothing can
§ answer it, so that the Compiler's error output can be read end to end in one
§ run:
§
§     bun packages/cli/bin/esc check packages/fixtures/files/diagnostics/Asynchrony.es
§
§ Keep it broken. If a change makes one of these compile, the Diagnostic it
§ was showcasing no longer has a home.

implementation {
	§ complete-outside-future — a body that writes `complete` SUSPENDS, so it
	§ hands back a future the caller completes in its turn. This one says it
	§ answers an Integer, which is what the caller would have to wait for.
	function headline() -> Integer {
		<- complete Async.deferred(() { <- 1 })
	}

	§ complete-outside-future — and the position that can not suspend at all. A
	§ default is filled in by the emitted Function itself, before any of its own
	§ asynchrony begins.
	function padded(
		_ width: Integer = complete Async.deferred(() { <- 2 }),
	) -> Integer {
		<- width
	}

	§ needless-complete — a Warning, and greyed out rather than underlined:
	§ `complete` waits for what a Future or a Started answers with, and a value
	§ that is neither is already the answer.
	constant waited = complete 3

	§ needless-start — the same the other way round. `start` puts a Future in
	§ flight, and a value that describes no work has nothing to put anywhere.
	constant running = start 4
}

tests {
	§ A plain test may `complete` whatever it likes: the runner drives one test
	§ at a time and waits for each. These two are the forms it can not.

	§ complete-outside-future — a benchmark body is timed over many runs, so a
	§ wait inside it would be measured as the work.
	benchmark "waiting" {
		constant counted = complete Async.deferred(() { <- 5 })

		expect counted::is(5)
	}

	§ complete-outside-future — and a property body runs once per generated
	§ value, under a search that replays what it drew.
	test "every width" for any (width: Integer) {
		constant padded = complete Async.deferred(() { <- width })

		expect padded::is(width)
	}
}
