import {
	from "./Boolean.es" { Boolean }
	from "./Comparable.es" { Comparable }
}

declarations {

	§ `Orderable` extends `Comparable` and adds no requirement: both Methods
	§ below are written on the four inequalities `Comparable` provides. It
	§ sits after `Comparable.es` in the file chain for that reason, and
	§ imports `Boolean` because `isBetween`'s body names it.
	§
	§ The split is what a range needs against what an ordering offers. A
	§ String, a List and a Boolean can each be ordered and keep the smaller
	§ promise, `Comparable`. Only a number line makes `isBetween` and `clamp`
	§ mean something, so the numeric kinds declare this Protocol and nothing
	§ else does.
	§
	§ A provided Method takes `Self`, which is the target of the Namespace
	§ whose conformance offered it. Both `Integer` and the covering `Number`
	§ conform, so each of the two has two rungs on a numeric receiver. A
	§ same-kind question is answered within the kind, and one across two
	§ kinds falls to `Number`'s rung, with nothing widened at the call.
	§
	§ `isBetween` reads a chain and stays a question of its own. See
	§ DEVELOPMENT.md, Why bodies look the way they do.

	§§ Anything on a line, where a value can be between two others or pulled into a range.
	protocol Orderable is Comparable {
		§§ Answers whether the value lies between the two given ones, both included.
		§§
		§§ The two bounds name the same range in either order: `7::isBetween(10, and 1)` is `true`, and `15::isBetween(10, and 1)` is `false`.
		§§
		§§ @param _ — one bound of the range, included
		§§ @param and — the other bound of the range, included
		§§ @returns — `true` when the value is within the bounds.
		isBetween(_ lower: Self, and upper: Self) -> Boolean {
			§ The two chains below are one chain with the bounds exchanged, the
			§ shape `clamp` is written in. A `clamp` answer compared with `@`
			§ says the same thing. But `Orderable` does not imply `Equatable`,
			§ so nothing here can ask whether two values are equal.
			if lower::isGreaterThan(upper) {
				<- @::isGreaterThanOrEqualTo(upper)
					::and(@::isLessThanOrEqualTo(lower))
			} else {
				<- @::isGreaterThanOrEqualTo(lower)
					::and(@::isLessThanOrEqualTo(upper))
			}
		}

		§§ Answers the value, pulled into the given bounds.
		§§
		§§ The answer is the lower bound when the value is below it. It is the upper bound when the value is above it, and the value itself otherwise. The two bounds name the same range in either order: `7::clamp(between 10, and 1)` is `7`, and `15::clamp(between 10, and 1)` is `10`.
		§§
		§§ @param between — one bound of the range
		§§ @param and — the other bound of the range
		§§ @returns — the clamped value.
		clamp(between lowest: Self, and highest: Self) -> Self {
			§ The two ladders below are one ladder with the bounds exchanged.
			§ Swapping the bounds and calling `clamp` again answers the same
			§ value, one call deeper. The ladder is written out instead, so
			§ the Method answers without calling itself.
			if lowest::isGreaterThan(highest) {
				<- define {
					as highest if @::isLessThan(highest)
					as lowest  if @::isGreaterThan(lowest)
					as @       otherwise
				}
			} else {
				<- define {
					as lowest  if @::isLessThan(lowest)
					as highest if @::isGreaterThan(highest)
					as @       otherwise
				}
			}
		}
	}
}

export {
	Orderable
}
