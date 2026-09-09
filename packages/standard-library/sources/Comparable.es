import {
	from "./Ordering.es" { Ordering }
}

declarations {

	§ `Comparable` is declared apart from `Equatable` and `Printable` because
	§ its signature names `Ordering`, whose Namespace conforms to those two.
	§ One file for all three would be a cycle, so the three form a line:
	§ Protocols, then Ordering, then Comparable.
	§
	§ The four inequalities are provided here rather than by `Orderable`,
	§ because ordering two names is an ordinary question about a String and
	§ `isBetween` is not. What a range needs is a number line; what a
	§ comparison needs is `compare`. So `String`, `List` and `Boolean` answer
	§ all four without declaring anything, and `Orderable` keeps the two
	§ Methods a line makes meaningful.
	§
	§ The two Cases below are written out rather than left bare. A bare
	§ `#Less` needs the Choice in Scope to resolve, and the loader then
	§ reports the import that put it there as unread.
	§
	§ The two `…OrEqualTo` bodies are an `if` rather than
	§ `@::isGreaterThan(other)::negate()`. Reaching `Boolean::negate` would
	§ need `Boolean` imported here, and `Boolean.es` imports this file for its
	§ own conformance. That is a third cycle in a graph that has two; see
	§ DEVELOPMENT.md, The shape of the graph is frozen. The same reason makes
	§ `Equatable::isNot` an `if`.
	§
	§ All four are read as well as run. Each `…OrEqualTo` is one call on `@`
	§ negated, over the bound it was handed. So a refinement written on either
	§ name is the one written on the comparison it negates. The conformer that
	§ answered gives the leaf its Namespace. Both strict comparisons read a
	§ chain and stay questions of their own. See DEVELOPMENT.md, Why bodies
	§ look the way they do.
	§
	§ A provided Method takes `Self`, which is the target of the Namespace
	§ whose conformance offered it. Both `Integer` and the covering `Number`
	§ conform, so each of the four has two rungs on a numeric receiver. A
	§ same-kind question is answered within the kind, and one across two kinds
	§ falls to `Number`'s rung, with nothing widened at the call.

	§§ Anything with a total order among its values.
	protocol Comparable {
		§§ Orders the value against another one of the same Type.
		§§
		§§ @param to — the value to compare with
		§§ @returns — `Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.
		compare(to other: Self) -> Ordering

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
			if @::isGreaterThan(other) {
				<- false
			} else {
				<- true
			}
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
			if @::isLessThan(other) {
				<- false
			} else {
				<- true
			}
		}
	}
}

export {
	Comparable
}
