§ This file does not compile — on purpose.
§
§ Every statement below triggers a different Diagnostic, so that the
§ Compiler's error output can be read end to end in one run:
§
§     bun bin/esc check testFiles/diagnostics/Showcase.es
§
§ Keep it broken. If a change makes one of these compile, the Diagnostic it
§ was showcasing no longer has a home.

implementation {
	§ assignment-type-mismatch — the declaration is pointed at, not repeated.
	variable count = 0

	count = "ten"

	§ assignment-type-mismatch, against an annotation rather than a
	§ declaration elsewhere.
	constant label: String = 42

	§ argument-count-mismatch and argument-type-mismatch.
	function greet(_ name: String, times: Integer) -> String {
		<- name
	}

	constant greeting = greet("World")
	constant shout = greet(1, times "twice")
}
