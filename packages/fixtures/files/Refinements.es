§ Checked refinements — a Type that carries the evidence its values have been
§ proven to satisfy.
§
§ A `where` clause on a Type Alias declares one. `@` stands for the value being
§ refined, the predicate is one Method call on it — or several joined with
§ `::and(…)` — and the Arguments are written out as literals, because the
§ Compiler compares two refinements by WHAT they prove rather than by how the
§ proof was spelled.
§
§ An `if` whose condition asks a refinement's question narrows the Constant it
§ asked it of, which is what makes a doorway writable: a bare value goes in, and
§ the branch that proved the predicate is the only one that reaches the operation
§ demanding the proof. A value written DOWN needs no branch at all — its
§ predicate is decided while compiling. And a Match on a bare Integer or String
§ takes the VALUE apart, which is a doorway nobody has to write: the Case
§ answering for the rest is reached only by a value none of the Cases above it
§ named.

implementation {

	§ The refinement the whole design was written for: the denominator of a
	§ Rational, the divisor of a division that can not fail.
	type NonZeroInteger = Integer where @::isNot(0)

	§ A String with something in it.
	type NonEmptyString = String where @::hasAnyContent()

	§ A List with something in it. The base is an APPLIED List — `List<String>`,
	§ never a bare `List`, whose item Type nothing has decided.
	type NonEmptyStrings = List<String> where @::hasItems()

	§ `isBetween` is not Integer's own — it is declared once over the whole
	§ numeric tower, and the conjunct records the Namespace that ANSWERED it,
	§ which is `Number`.
	type Digit = Integer where @::isBetween(0, and 9)

	§ A conjunction. `::and(…)` chains flatten, so this proves two things and so
	§ does the mirror image of it — the two are one Type.
	type SmallOdd = Integer where @::isOdd()::and(@::isLessThan(10))

	§ Evidence ADDS to a Type and never takes anything away, so a
	§ NonZeroInteger answers every Method an Integer answers.
	function doubled(_ n: NonZeroInteger) -> Integer {
		<- n::multiply(with 2)
	}

	§ And it flows into its base for free — forgetting a proof loses nothing.
	§ The other direction is the one that needs evidence, which is the point of
	§ the Type.
	function forgotten(_ n: NonZeroInteger) -> Integer {
		<- n
	}

	§ The doorway. A bare Integer comes in and the branch that proved the
	§ predicate is the only one that reaches `doubled`, which is why `doubled`
	§ needs no fallback and no Optional.
	function doubledOrZero(_ n: Integer) -> Integer {
		if n::isNot(0) {
			<- doubled(n)
		}

		<- 0
	}

	§ A conjunction establishes any refinement asking for SOME of what it
	§ proves — set inclusion — and where several qualify the one proving the
	§ most wins.
	function scaledOdd(_ n: Integer) -> Integer {
		if n::isOdd()::and(n::isLessThan(10)) {
			<- tripled(n)
		}

		<- 0
	}

	function tripled(_ n: SmallOdd) -> Integer {
		<- n::multiply(with 3)
	}

	§ The `else` branch narrows too, through the opposite Method: a String that
	§ is not empty has content, and a List that is not empty has items.
	function shout(_ text: String) -> String {
		if text::isEmpty() {
			<- ""
		} else {
			<- exclaimed(text)
		}
	}

	function exclaimed(_ text: NonEmptyString) -> String {
		<- text::append("!")
	}

	function countOf(_ items: List<String>) -> Integer {
		if items::isEmpty() {
			<- 0
		} else {
			<- lengthOf(items)
		}
	}

	function lengthOf(_ items: NonEmptyStrings) -> Integer {
		<- items::length()
	}

	§ A Match Handler's Guard proves things about `@` the same way, and it runs
	§ before any Statement of the body.
	function digitOrZero(_ value: Integer | String) -> Integer {
		<- match value -> Integer {
			case Integer where @::isBetween(0, and 9) { <- placed(@) }

			case _ { <- 0 }
		}
	}

	function placed(_ digit: Digit) -> Integer {
		<- digit::add(1)
	}

	§ A Match on a bare Integer or String is the other doorway nobody writes, and
	§ its Cases are evidence in both directions: reaching `case _` proves the value
	§ is none of the values the Cases above named — the very `isNot` a
	§ NonZeroInteger is declared by — while a Case that NAMES a value proves that.
	type Zero = Integer where @::is(0)

	function doubledOrNamed(_ n: Integer) -> String {
		<- match n -> String {
			case 0 { <- named(@) }

			case _ { <- doubled(@)::toString() }
		}
	}

	function named(_ zero: Zero) -> String {
		<- zero::toString()
	}

	§ A value written DOWN is its own evidence: the predicate is decided while
	§ compiling, so no branch stands in front of this and nothing has asked
	§ anything. The doorways above are for the values a Program is HANDED.
	constant twentyOne: NonZeroInteger = 21

	§ Which holds wherever a refinement is expected — a declared Constant, a
	§ returned value, an Argument — and holds of a String and a List as much as
	§ of an Integer.
	function three() -> NonZeroInteger {
		<- 3
	}

	§ Until a total division exists, the operations these refinements are ABOUT
	§ are the Optionals they have always been: an Integer divided by an Integer
	§ might have been divided by zero, and nothing in the signature says
	§ otherwise.
	__print(6::divide(by 3))
	__print(6::divide(by 0))

	§ The predicates themselves are ordinary Methods, answering here about
	§ ordinary values.
	__print(6::isNot(0))
	__print("essence"::hasAnyContent())
	__print(["a", "b"]::hasItems())
	__print(7::isBetween(0, and 9))
	__print(7::isOdd()::and(7::isLessThan(10)))

	§ The values written down, which need no doorway at all.
	__print(doubled(twentyOne))
	__print(doubled(three()))
	__print(doubled(21))
	__print(placed(7))
	__print(exclaimed("essence"))
	__print(lengthOf(["a", "b"]))

	§ And the doorways, answering about values nothing had proven anything about
	§ before they were asked.
	__print(doubledOrZero(21))
	__print(doubledOrZero(0))
	__print(scaledOdd(7))
	__print(scaledOdd(8))
	__print(shout("essence"))
	__print(shout(""))
	__print(countOf(["a", "b"]))
	__print(countOf([]))
	__print(digitOrZero(7))
	__print(digitOrZero("seven"))
	__print(doubledOrNamed(21))
	__print(doubledOrNamed(0))
}
