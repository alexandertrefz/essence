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

	§ `NonZeroInteger` is the standard library's own — the refinement the whole
	§ design was written for, and the one `Rational::denominator` answers with —
	§ so it is USED here rather than declared, as `NonEmptyString` and
	§ `NonEmptyList<Item>` are further down. Everything else below is a
	§ Program's own, declared exactly the way those three are.

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

	§ `NonEmptyList<Item>` is the standard library's other one, and the GENERIC one:
	§ the Lists that have something in them, whatever they hold. Its predicate is
	§ the `hasItems` asked just above, so the Type Argument is the one thing left
	§ to work out and the receiver is what decides it — nothing here writes
	§ `NonEmptyList<String>` anywhere, and that is what the branch establishes.
	§
	§ What it is FOR is the answer that stops being an Optional. There is no first
	§ item of an empty List, and no value of this Type is empty, so `firstItem`
	§ here answers with the item — the fallback below stands in front of the
	§ branch rather than after the call.
	function firstWordOr(_ words: List<String>, _ fallback: String) -> String {
		if words::hasItems() {
			<- words::firstItem()
		}

		<- fallback
	}

	§ Two refinements proving the same thing of the same base are ONE Type,
	§ however each was spelled — the Compiler compares what a proof says, not who
	§ wrote it down. So a value of the standard library's `NonEmptyList<String>` is
	§ accepted by `lengthOf`, which asked for this Program's own.
	constant colours: NonEmptyList<String> = ["red", "green", "blue"]

	§ A proof CARRIES through a transform that can not spend it. Sorting a List
	§ moves its items about and drops none, so what comes back has something in
	§ it exactly because what went in did — and `NonEmptyList` says so in the
	§ return Type. That is what lets these two read as they do: `sort` hands its
	§ answer straight to the total `firstItem`, with no `if` between them, and
	§ `reverse` hands its own to a Function asking for the refinement, with no
	§ doorway and nothing written down.

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

	§ Every predicate above is one the standard library wrote. A Program's own
	§ read exactly alike, because the rule is about the BODY and not about the
	§ name: a Method answering a Boolean whose whole body is one call on `@`
	§ asks whatever that call asks. Nothing is declared, and nothing is named
	§ in a table — so it holds of a predicate that TAKES Arguments too, with
	§ whatever the caller wrote standing in for the Arguments the body handed
	§ on.
	namespace Stock for Integer {
		§ One call on `@`, forwarding the count it was given. `isAtLeast(5)`
		§ therefore asks what `isGreaterThanOrEqualTo(5)` asks — and
		§ `isAtLeast(4)` asks something else, because the bound belongs to the
		§ CALL rather than to the body.
		isAtLeast(_ count: Integer) -> Boolean {
			<- @::isGreaterThanOrEqualTo(count)
		}

		§ The same call, negated. So these two Methods are one question with
		§ two answers, which is the whole of what the doorway below needs.
		isBelow(_ count: Integer) -> Boolean {
			<- @::isGreaterThanOrEqualTo(count)::negate()
		}

		§ A forwarded Parameter beside a value written down — both reach the
		§ question underneath, so `isUpTo(9)` asks `isBetween(1, and 9)`.
		isUpTo(_ ceiling: Integer) -> Boolean {
			<- @::isBetween(1, and ceiling)
		}
	}

	§ A refinement on a Program's own predicate is a refinement on the question
	§ that predicate asks, so the first two below prove contrary things and
	§ nothing had to declare it: each is the comparison its body named, and one
	§ of them is the other with the answer turned round.
	type Healthy = Integer where @::isAtLeast(5)

	type Depleted = Integer where @::isBelow(5)

	type Small = Integer where @::isUpTo(9)

	§ Which is what makes BOTH branches of one `if` carry evidence. The
	§ condition asks `isBelow`, so the branch where it held has a `Depleted`
	§ and the ELSE branch has a `Healthy` — and that second half is the one
	§ nothing could write before, because a predicate taking an Argument had
	§ no contrary to be read as.
	function restocked(_ units: Integer) -> Integer {
		if units::isBelow(5) {
			<- refilled(units)
		} else {
			<- shipped(units)
		}
	}

	function refilled(_ units: Depleted) -> Integer {
		<- units::add(5)
	}

	function shipped(_ units: Healthy) -> Integer {
		<- units::subtract(1)
	}

	§ And the plain direction, where the branch that PROVED the predicate is
	§ the one that reaches the Function asking for it.
	function scaledOrZero(_ n: Integer) -> Integer {
		if n::isUpTo(9) {
			<- scaled(n)
		}

		<- 0
	}

	function scaled(_ n: Small) -> Integer {
		<- n::multiply(with 10)
	}

	§ A value written down decides a Program's own predicate exactly as it
	§ decides the standard library's, since what it is asked is one comparison
	§ either way.
	constant stocked: Healthy = 20

	§ A Protocol writes a body once for everything that conforms to it, and it
	§ is read there. `isAtMost` is `isAbove` negated, whoever answers `isAbove`
	§ — so the question is the CONFORMER's, and `Rank` answers it with a
	§ comparison. That is what the `else` below has proven.
	protocol Ranked {
		isAbove(_ mark: Integer) -> Boolean

		isAtMost(_ mark: Integer) -> Boolean {
			<- @::isAbove(mark)::negate()
		}
	}

	namespace Rank for Integer is Ranked {
		isAbove(_ mark: Integer) -> Boolean {
			<- @::isGreaterThan(mark)
		}
	}

	type Above = Integer where @::isGreaterThan(3)

	function ranked(_ n: Integer) -> String {
		if n::isAtMost(3) {
			<- "low"
		} else {
			<- placement(n)
		}
	}

	function placement(_ n: Above) -> String {
		<- n::toString()
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

	§ The operation these refinements are ABOUT: dividing by a proven divisor
	§ can not fail, so the answer is the Rational itself — and a written 3 is
	§ its own proof. A written 0 proves nothing, so that division still answers
	§ the Optional it always has.
	Terminal.inspect(6::divide(by 3))
	Terminal.inspect(6::divide(by 0))

	§ The predicates themselves are ordinary Methods, answering here about
	§ ordinary values.
	Terminal.inspect(6::isNot(0))
	Terminal.inspect("essence"::hasCharacters())
	Terminal.inspect(["a", "b"]::hasItems())
	Terminal.inspect(7::isBetween(0, and 9))
	Terminal.inspect(7::isOdd()::and(7::isLessThan(10)))

	§ The values written down, which need no doorway at all.
	Terminal.inspect(doubled(twentyOne))
	Terminal.inspect(doubled(three()))
	Terminal.inspect(doubled(21))
	Terminal.inspect(placed(7))
	Terminal.inspect(exclaimed("essence"))
	Terminal.inspect(lengthOf(["a", "b"]))
	Terminal.inspect(colours::firstItem())
	Terminal.inspect(colours::lastItem())
	Terminal.inspect(lengthOf(colours))
	Terminal.inspect(colours::sort()::firstItem())
	Terminal.inspect(lengthOf(colours::reverse()))

	§ And the doorways, answering about values nothing had proven anything about
	§ before they were asked.
	Terminal.inspect(doubledOrZero(21))
	Terminal.inspect(doubledOrZero(0))
	Terminal.inspect(scaledOdd(7))
	Terminal.inspect(scaledOdd(8))
	Terminal.inspect(shout("essence"))
	Terminal.inspect(shout(""))
	Terminal.inspect(countOf(["a", "b"]))
	Terminal.inspect(countOf([]))
	Terminal.inspect(firstWordOr(["essence", "language"], "none"))
	Terminal.inspect(firstWordOr([], "none"))
	Terminal.inspect(digitOrZero(7))
	Terminal.inspect(digitOrZero("seven"))
	Terminal.inspect(doubledOrNamed(21))
	Terminal.inspect(doubledOrNamed(0))

	§ A Program's own predicates, asked of ordinary values, and the doorways
	§ their contraries open.
	Terminal.inspect(12::isAtLeast(5))
	Terminal.inspect(3::isBelow(5))
	Terminal.inspect(7::isUpTo(9))
	Terminal.inspect(shipped(stocked))
	Terminal.inspect(restocked(12))
	Terminal.inspect(restocked(3))
	Terminal.inspect(scaledOrZero(7))
	Terminal.inspect(scaledOrZero(12))
	Terminal.inspect(ranked(12))
	Terminal.inspect(ranked(3))
}
