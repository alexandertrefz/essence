§ This file does not compile — on purpose.
§
§ Every declaration below triggers a different Enricher Diagnostic from the
§ generic-Choice slice, so that the Compiler's error output can be read end to
§ end in one run:
§
§     bun bin/esc check testFiles/diagnostics/GenericChoice.es
§
§ The value-level Diagnostics of the same slice live one stage later, in
§ GenericChoiceValues.es — the Validator never runs once the Enricher has
§ reported, so a file can only ever showcase one stage.
§
§ Keep it broken. If a change makes one of these compile, the Diagnostic it was
§ showcasing no longer has a home.

implementation {
	§ wrong-type-argument-count — `Step` takes two Type Arguments, `State` and
	§ `Result`; one is not enough.
	type OneArgument = Step<Integer>

	§ recursive-generic-choice — a generic Choice may not name itself in a
	§ payload, because its payloads are substituted eagerly at each use.
	choice Nested<Item> {
		Wrap { inner: Nested<Item> },
	}

	§ uninferable-type-parameter — the general loop's `Result` is inferred from
	§ the `#Done` its callback answers with, and this callback only ever
	§ answers `#Continue`, so nothing binds `Result`.
	constant never = loop(startingWith 0,
		step (state) { <- #Continue(state::add(1)) })

	§ unsatisfied-bound — a `Step` whose `Result` is a Function has no equality,
	§ because a Function is not Equatable; the because-chain names each level of
	§ the failure.
	constant boxed: Step<Integer, (_ x: Integer) -> Integer> =
		#Done((_ x: Integer) -> Integer { <- x })

	constant same = boxed::is(boxed)
}
