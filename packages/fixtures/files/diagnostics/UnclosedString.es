§ This file does not compile — on purpose.
§
§ It holds exactly one mistake, because an unterminated String Literal is the
§ Lexer's one fatal error: everything after it is part of the String, so there
§ is nothing left to lex and no second Diagnostic to showcase. Read the report
§ in one run:
§
§     bun packages/cli/bin/esc check packages/fixtures/files/diagnostics/UnclosedString.es
§
§ Keep it broken. If a change makes this compile, the Diagnostic it was
§ showcasing no longer has a home.

implementation {
	§ unclosed-string — the end of the input is where it is noticed, the
	§ opening quote is where the String began, and the report points at both.
	constant greeting = "hello
}
