§ This file does not compile — on purpose.
§
§ Every statement below triggers a different Validator Diagnostic from the
§ generic-Choice slice — the value-level ones, raised once a value has a Type
§ but does not fit where it is put:
§
§     bun bin/esc check testFiles/diagnostics/GenericChoiceValues.es
§
§ Its Enricher-stage companion is GenericChoice.es. Nothing here may trip the
§ Enricher, or the Validator would never run and none of these would show.
§
§ Keep it broken. If a change makes one of these compile, the Diagnostic it was
§ showcasing no longer has a home.

implementation {
	§ assignment-type-mismatch — two instantiations of the same Choice are not
	§ interchangeable; a `Step<Integer, String>` is not a `Step<String, Integer>`.
	constant done: Step<Integer, String> = #Done("stop")
	constant swapped: Step<String, Integer> = done

	§ unexpected-payload — the one-member shorthand does not reach a zero-member
	§ Case; `#Empty` carries nothing. The annotation is load-bearing: a Choice's
	§ Type Parameters are applied, never inferred, so an unannotated
	§ `Box#Empty(…)` would be `undecided-type-arguments` in the Enricher and this
	§ file would never reach the Validator at all.
	choice Box<Value> {
		Full { value: Value },
		Empty,
	}

	constant boxed: Box<Integer> = Box#Empty({ value = 1 })

	§ payload-type-mismatch — the one-member shorthand only reaches single-member
	§ Cases, so a bare value can not stand in for a two-member Record. The help
	§ line says exactly that.
	choice Pair {
		Both { left: Integer, right: Integer },
	}

	constant pair = #Both(5)

	§ overloaded-function-value — `loop` is a set of four signatures, not one
	§ Function value, so a bare reference names them all at once.
	constant everyLoop = loop
}
