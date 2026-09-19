§ This file does not compile — on purpose.
§
§ Every line below names something the Compiler can account for and once could
§ not: the Method is one level inside the value, rather than a misspelling of a
§ name that happens to be two edits away. Each of these reports used to end in a
§ guess by edit distance, and the Quick Fix behind the guess wrote a word the
§ reader had never heard of into their file.
§
§     bun packages/cli/bin/esc check packages/fixtures/files/diagnostics/KnownAnswers.es
§
§ Keep it broken. If a change makes one of these compile, the Diagnostic it was
§ showcasing no longer has a home.

implementation {
	function fetched() -> Future<Integer> {
		complete Async.sleep(milliseconds 1)

		<- 41
	}

	constant primes = [2, 3, 5]

	§ unknown-method — 'add' is a Method of Integer, which is what the List
	§ holds. This is the report that offered 'pad'.
	Terminal.print(primes::add(1)::toString())

	§ unknown-method — the same Method one level inside an Optional, where a
	§ Case's payload is what carries it.
	Terminal.print(primes::firstItem()::add(1)::toString())

	§ unknown-method — a Future DESCRIBES the Integer rather than being one, and
	§ 'complete' takes the whole chain behind it, so the word can not go in
	§ front of this call.
	Terminal.print(fetched()::add(1)::toString())

	§ unknown-case — the Parameter takes a Rounding and nothing else, so the
	§ report is about that Choice and lists what it declares. Every mode in the
	§ library is a bare Case at a Parameter, and this is how a reader finds one.
	Terminal.print(7/2::round(toward #Floor)::toString())

	§ unknown-case — and where no position decides, the Choice that declares the
	§ near miss is named instead, because that is the half nobody can look up.
	constant options = { division = #Truncated }

	Terminal.inspect(options)
}
