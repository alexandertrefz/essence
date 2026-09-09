§ This file does not compile — on purpose.
§
§ Every bare `#Case` below is declared by more than one Choice, which is what
§ `ambiguous-case` reports. The Compiler asks the question from three places —
§ the scope, the expected Type and the matched Union — and each says where it
§ looked:
§
§     bun packages/cli/bin/esc check packages/fixtures/files/diagnostics/AmbiguousCase.es
§
§ Keep it broken. If a change makes one of these compile, the Diagnostic it was
§ showcasing no longer has a home.

implementation {
	choice Colour {
		Red,
		Blue,
	}

	choice Shade {
		Red,
		Dark,
	}

	§ ambiguous-case, in scope — two Choices of the Program's own, neither
	§ generic, so the Choice's name is the whole of what a Help asks for.
	constant red = #Red

	§ ambiguous-case, in scope — the same question about two GENERIC Choices,
	§ both of them builtin: `Optional` and `Result` each declare a `#Value`.
	§ Nothing here decides the Type Arguments either, so each Help asks for
	§ them beside the name; the bare `Optional#Value` would only reach
	§ `undecided-type-arguments` next.
	constant carried = #Value(3)

	§ ambiguous-case, in the expected Type — the annotation names both Choices
	§ applied, so the Type Arguments are already decided and the Help asks for
	§ the Choice alone.
	constant expected: Optional<Integer> | Result<Integer, String> = #Value(1)

	§ ambiguous-case, in the matched Union — a Matcher names a Case rather than
	§ a value, and the Union it is matched against declares that name twice.
	function describe(_ value: Colour | Shade) -> String {
		<- match value -> String {
			case #Red  { <- "red" }
			case #Blue { <- "blue" }
			case #Dark { <- "dark" }
		}
	}

	Terminal.print(describe(Colour#Blue))
}
