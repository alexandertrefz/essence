§ This file does not compile — on purpose.
§
§ It holds exactly one mistake, and the mistake has two readings. A String
§ Literal may span lines, so the Lexer reads the one opened below as running
§ down to the quote in front of the name on the line under it — which leaves
§ that name standing bare, and the quote behind it opening a String that never
§ closes. Exactly one quote is missing under either reading; the report names
§ the String that SPANS LINES, and puts the other reading on the page beside
§ it. Read it in one run:
§
§     bun packages/cli/bin/esc check packages/fixtures/files/diagnostics/SwallowedString.es
§
§ Keep it broken. If a change makes this compile, the Diagnostic it was
§ showcasing no longer has a home.

implementation {
	§ unclosed-string — the quote missing from the end of the line below is
	§ the whole mistake, and the report says so rather than pointing at the
	§ quote that closed the String instead.
	constant greeting = "Hello
	constant name = "Ada"

	Terminal.print(greeting)
	Terminal.print(name)
}
