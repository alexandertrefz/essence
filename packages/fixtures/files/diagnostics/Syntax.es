§ This file does not compile — on purpose.
§
§ It ends in the middle of a block, so that the Parser's report can be read
§ end to end in one run:
§
§     bun packages/cli/bin/esc check packages/fixtures/files/diagnostics/Syntax.es
§
§ Keep it broken. If a change makes this compile, the Diagnostic it was
§ showcasing no longer has a home.

implementation {
	§ syntax-error — the arrow says what was expected, the message what was
	§ found instead.
	constant answer 42

	§ redundant-pattern-binder — inside an arm '@' is the scrutinee narrowed to
	§ what the Matcher established, which is what this would name a second
	§ time. Reported and then dropped, so the arm still parses.
	constant point: { x: Integer } | { key: String } = { x = 1 }

	constant read = match point -> Integer {
		case { x, y } as whole { <- x }
		case _                 { <- 0 }
	}

	§ pattern-without-body — a Protocol Method says what a call looks like and
	§ nothing about how it is carried out, so a Pattern there would name parts
	§ for nobody to read.
	protocol Measurable {
		area(of { width, height }: { width: Integer, height: Integer }) -> Integer
	}

	§ unclosed-block — the end of the input is where it is noticed, the '{'
	§ is where the mistake is.
	function greet(_ name: String) -> String {
		<- name
