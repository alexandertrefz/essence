§ Checked refinements — a Type that carries the evidence its values have been
§ proven to satisfy.
§
§ A `where` clause on a Type Alias declares one. `@` stands for the value being
§ refined, the predicate is one Method call on it — or several joined with
§ `::and(…)` — and the Arguments are written out as literals, because the
§ Compiler compares two refinements by WHAT they prove rather than by how the
§ proof was spelled.
§
§ Nothing here builds a refined value yet: a literal is admitted against a
§ predicate, an `if` narrows a Constant, and a Match narrows `@` in the work
§ packages after this one. What this file shows is the half that is settled —
§ what a refinement IS, and that a value of one is its base with more known
§ about it and never with less.

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

	§ Until a doorway exists, the operations these refinements are ABOUT are
	§ the Optionals they have always been: an Integer divided by an Integer
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
}
