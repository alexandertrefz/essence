§ This file does not compile — on purpose.
§
§ It ends in the middle of a block, so that the Parser's report can be read
§ end to end in one run:
§
§     bun bin/esc check testFiles/diagnostics/Syntax.es
§
§ Keep it broken. If a change makes this compile, the Diagnostic it was
§ showcasing no longer has a home.

implementation {
	§ syntax-error — the arrow says what was expected, the message what was
	§ found instead.
	constant answer 42

	§ unclosed-block — the end of the input is where it is noticed, the '{'
	§ is where the mistake is.
	function greet(_ name: String) -> String {
		<- name
