import {
	Boolean    from "./Boolean.es"
	Comparable from "./Comparable.es"
	Ordering   from "./Ordering.es"
}

declarations {

	§ `Orderable` extends `Comparable` and adds no requirement: the six
	§ Methods below are all written on `compare`. It sits after
	§ `Comparable.es` in the file chain for that reason, and imports
	§ `Boolean` and `Ordering` because its bodies name both. The two Cases
	§ are written out rather than left bare. A bare `#Less` needs the Choice
	§ in Scope to resolve, and the loader then reports the import that put it
	§ there as unread.
	§
	§ The split is what `sort` needs against what a number line offers. A
	§ String or a List keeps the smaller promise, `Comparable`. Only
	§ `Orderable` makes `isBetween` and `clamp` mean something, so the
	§ numeric kinds declare it and nothing else does.
	§
	§ A provided Method takes `Self`, which is the target of the Namespace
	§ whose conformance offered it. Both `Integer` and the covering `Number`
	§ conform, so each of the six has two rungs on a numeric receiver. A
	§ same-kind question is answered within the kind, and one across two
	§ kinds falls to `Number`'s rung, with nothing widened at the call.
	§
	§ The two `…OrEqualTo` bodies are read as well as run. Each is one call
	§ on `@` negated, over the bound it was handed. So a refinement written
	§ on either name is the one written on the comparison it negates. The
	§ conformer that answered gives the leaf its Namespace. `isLessThan`,
	§ `isGreaterThan` and `isBetween` read a chain and stay questions of
	§ their own. See DEVELOPMENT.md, Why bodies look the way they do.

	§§ Anything on a line, where a value can be below another, between two others or pulled into a range.
	protocol Orderable is Comparable {
		§§ Answers whether the value is strictly below another.
		§§
		§§ @param _ — the value to compare with
		§§ @returns — `true` when the value is below the given one.
		isLessThan(_ other: Self) -> Boolean {
			<- @::compare(to other)::is(Ordering#Less)
		}

		§§ Answers whether the value is below another, or equal to it.
		§§
		§§ @param _ — the value to compare with
		§§ @returns — `true` when the value is below the given one or equal to it.
		isLessThanOrEqualTo(_ other: Self) -> Boolean {
			<- @::isGreaterThan(other)::negate()
		}

		§§ Answers whether the value is strictly above another.
		§§
		§§ @param _ — the value to compare with
		§§ @returns — `true` when the value is above the given one.
		isGreaterThan(_ other: Self) -> Boolean {
			<- @::compare(to other)::is(Ordering#Greater)
		}

		§§ Answers whether the value is above another, or equal to it.
		§§
		§§ @param _ — the value to compare with
		§§ @returns — `true` when the value is above the given one or equal to it.
		isGreaterThanOrEqualTo(_ other: Self) -> Boolean {
			<- @::isLessThan(other)::negate()
		}

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
				if @::isLessThan(highest) {
					<- highest
				} else if @::isGreaterThan(lowest) {
					<- lowest
				} else {
					<- @
				}
			} else if @::isLessThan(lowest) {
				<- lowest
			} else if @::isGreaterThan(highest) {
				<- highest
			} else {
				<- @
			}
		}
	}
}

export {
	Orderable
}
