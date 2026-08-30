implementation {

	§ A `define` is a definition by cases. Every arm is `as VALUE if
	§ CONDITION`, the first arm whose Condition holds is the answer, and the
	§ `otherwise` arm is the one that holds when none of them did — so there
	§ is no fall-through to write and no case left unanswered.
	function grade(_ score: Integer) -> String {
		<- define {
			as "A" if score::isGreaterThanOrEqualTo(90)
			as "B" if score::isGreaterThanOrEqualTo(80)
			as "C" if score::isGreaterThanOrEqualTo(70)
			as "F" otherwise
		}
	}

	Terminal.print(grade(95)) § A
	Terminal.print(grade(85)) § B
	Terminal.print(grade(20)) § F

	§ Nothing inside a `define` declares or binds, and every half of every
	§ arm is an Expression — so it answers where it stands, and an Argument
	§ is somewhere it stands as happily as anywhere else.
	constant windy = true

	Terminal.print(define {
		as "hold on to your hat" if windy
		as "a fine day"          otherwise
	}) § hold on to your hat

	§ `define -> Type` says what the whole thing answers. It is what lets an
	§ arm write a bare `#Empty`: a Choice's Type Arguments are applied by the
	§ position around it and never inferred, so an arm that answers with one
	§ needs the Type handed to it.
	function reading(_ text: String) -> Optional<Integer> {
		<- define -> Optional<Integer> {
			as #Empty if text::isEmpty()
			as Integer.parse(text) otherwise
		}
	}

	Terminal.print(reading("7")::toString()) § Value(7)
	Terminal.print(reading("")::toString()) § Empty

	§ An arm's answer is an Expression, so a `define` written inside one is
	§ an arm's answer like any other. The inner ladder is asked only where
	§ the outer arm it stands in was taken.
	function describe(_ value: Integer) -> String {
		<- define -> String {
			as define {
				as "exactly one" if value::is(1)
				as "several"     otherwise
			} if value::isPositive()
			as "none at all" otherwise
		}
	}

	Terminal.print(describe(1)) § exactly one
	Terminal.print(describe(7)) § several
	Terminal.print(describe(0)) § none at all

	§ Every arm below the first is read behind the COMPLEMENT of every
	§ Condition above it. `separator::isEmpty()` proves nothing about the
	§ separator where it holds, and proves the `NonEmptyString` that `split`
	§ asks for where it does not — so the arm below it may call `split` at
	§ all.
	function pieces(_ text: String, on separator: String) -> List<String> {
		<- define {
			as [text] if separator::isEmpty()
			as text::split(on separator) otherwise
		}
	}

	Terminal.print(pieces("a-b-c", on "-")::toString()) § ["a", "b", "c"]
	Terminal.print(pieces("a-b-c", on "")::toString()) § ["a-b-c"]
}
