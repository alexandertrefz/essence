§ Every Diagnostic in this file is a Warning: the Program compiles, and each
§ call answers exactly what the Compiler says it answers. What is wrong is that
§ the reader can not see which of two questions was asked.
§
§ A carrier holds a value, and `Optional::is` takes both — another Optional and
§ a bare item. On an Optional of Optionals a written `#Empty` fits either, so
§ the call has two readings and reaches the one written first. `Result` nests
§ the same way, one Case over.
§
§     bun packages/cli/bin/esc check packages/fixtures/files/diagnostics/NestingLevels.es
§
§ Keep it ambiguous. If a change makes one of these read one way only, the
§ Diagnostic it was showcasing no longer has a home.

implementation {
	constant nested: Optional<Optional<Integer>> = #Value(#Empty)
	constant failed: Result<Result<Integer, String>, String> = #Value(#Failure("gone"))

	§ ambiguous-nesting-level — the receiver holds `#Empty`, and the answer is
	§ `false`: the question reached the entry taking the whole Optional, and
	§ the whole Optional is a `#Value`.
	constant isEmpty = nested::is(#Empty)

	§ The same call negated. `isNot` is the same pair of entries, so the same
	§ Argument reads at the same two levels.
	constant isNotEmpty = nested::isNot(#Empty)

	§ The Result twin. A `Result<Result<Integer, String>, String>` fails with a
	§ String at both levels, so `#Failure("gone")` fits the outer Result and the
	§ inner one, and the outer is what the call asks about.
	constant hasFailed = failed::is(#Failure("gone"))

	§ Writing the Choice in front decides nothing, which is why the Warning's
	§ second Help asks for a Constant instead: a Case carries its Type Arguments
	§ for display, and a Case with no payload has no member to tell one level
	§ from the other.
	constant spelledOut = nested::is(Optional<Optional<Integer>>#Empty)

	§ The two spellings that are not ambiguous, and so say nothing here. The
	§ first asks whether the receiver holds an empty Optional, the second
	§ whether the receiver itself is one.
	constant holdsEmpty = nested::is(#Value(#Empty))

	constant outer: Optional<Optional<Integer>> = #Empty

	constant isOuterEmpty = nested::is(outer)
}
