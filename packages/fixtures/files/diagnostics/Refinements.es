§ This file does not compile — on purpose.
§
§ Every Type Alias below writes a `where` clause the Enricher refuses, and the
§ Matches at the end write a refinement where a runtime test would have to be
§ emitted for it, so that the whole of what a checked refinement may and may
§ not say can be read as one run of error output:
§
§     bun packages/cli/bin/esc check packages/fixtures/files/diagnostics/Refinements.es
§
§ Every one of these PARSES — a `where` clause is read wherever it is written,
§ and what it may say is a question about Types. That is why they all reach the
§ Enricher, and why a refusal here never keeps the next one from being reported.
§
§ The calls at the end are the other kind: they compile, and each carries a
§ `defaultingTo` Argument that can never be read, because the proof the call
§ already holds took the empty answer away. That is a Warning rather than an
§ Error, and it is showcased here because the proof is what makes it one.
§
§ Keep it broken. If a change makes one of these compile, the Diagnostic it was
§ showcasing no longer has a home.

implementation {
	§ invalid-refinement-predicate — Boolean is not one of the bases a
	§ refinement may be written on.
	type Yes = Boolean where @::is(true)

	§ invalid-refinement-predicate — nor is a bare List, whose item Type
	§ nothing has decided.
	type Several = List where @::hasItems()

	§ invalid-refinement-predicate — the receiver is not '@'. A refinement is
	§ evidence about the value being refined and about nothing else.
	type Named = Integer where "essence"::hasCharacters()

	§ invalid-refinement-predicate — a chain proves something about the
	§ intermediate value, which nothing proved anything about.
	type Trimmed = String where @::trim()::hasCharacters()

	§ invalid-refinement-predicate — an Argument has to be written out, so that
	§ two refinements proving the same thing are the same Type.
	constant limit = 3

	type Bounded = Integer where @::isLessThan(limit)

	§ predicate-not-boolean — a predicate is a question, and this one answers
	§ with a number.
	type Sized = Integer where @::absolute()

	§ refinement-as-matcher — a Matcher narrows by Type, and a refinement's
	§ predicate erases before the Program runs, so there is nothing left for
	§ the emitted check to ask.
	constant answer: Integer | String = 0

	constant sorted = match answer -> String {
		case NonZeroInteger { <- "nonzero" }
		case _              { <- "other" }
	}

	§ refinement-as-matcher, in a payload Pattern's annotation — the same
	§ refusal, because the annotation is the same runtime test.
	choice Box {
		Full { value: Integer | String },
		Empty,
	}

	constant box: Box = #Full({ value = 0 })

	constant label = match box -> String {
		case #Full({ value: NonZeroInteger }) { <- "nonzero" }
		case _                                { <- "other" }
	}

	§ fallback-never-used — the receiver is proven to hold items, so
	§ `firstItem()` answers an Integer and the fallback is unreachable.
	constant scores: NonEmptyList<Integer> = [3, 1, 2]

	constant best = scores::firstItem(defaultingTo 0)

	§ fallback-never-used — the same rule from the other side: a written '2' is
	§ proof the quotient exists.
	constant half = 10::divide(by 2, defaultingTo 0/1)

	§ Silent on purpose, and the reason the rule re-probes the call rather than
	§ reading a Parameter list: `firstItem(where:)` can find nothing in a List
	§ that holds items, so the fallback here is the one that gets read.
	constant firstBig = scores::firstItem(
		where (score) { <- score::isGreaterThan(2) },
		defaultingTo 0,
	)
}
