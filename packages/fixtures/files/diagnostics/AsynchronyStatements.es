§ This file does not compile — on purpose.
§
§ Both Statements below drop the work they wrote down, which is what the two
§ Diagnostics about a Statement position are for:
§
§     bun packages/cli/bin/esc check packages/fixtures/files/diagnostics/AsynchronyStatements.es
§
§ Keep it broken. If a change makes one of these compile, the Diagnostic it
§ was showcasing no longer has a home.
§
§ They sit in a file of their own because both are the Validator's, and a file
§ whose Enricher reported an error never reaches it.

implementation {
	function headline() -> Future<Integer> {
		<- complete Async.deferred(() { <- 1 })
	}

	§ unused-future — a Future describes work, and building one runs none of it.
	§ A description nobody starts and nobody waits for is a Statement that does
	§ nothing at all.
	headline()

	§ unobserved-started — an Information rather than a complaint. This DOES
	§ run; what nobody does is read what it answers with, which is a real thing
	§ to write and a thing to be told about.
	start headline()

	§ unused-future again, for a call that HANDS the work on rather than one
	§ that built it: `inspect` printed what it was asked to print and answered
	§ with its Argument, so the description is what goes nowhere. Neither
	§ Keyword is the edit here — a name is, which is what the second help says.
	Terminal.inspect(headline())

	§ unobserved-started again, with the label the other way round: nothing here
	§ started anything, and what goes nowhere is the run `inspect` was handed
	§ and handed back.
	Terminal.inspect(start headline())
}
