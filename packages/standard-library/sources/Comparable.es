import {
	Ordering from "./Ordering.es"
}

declarations {

	§ `Comparable` is declared apart from `Equatable` and `Printable` because
	§ its signature names `Ordering`, whose Namespace conforms to those two.
	§ One file for all three would be a cycle, so the three form a line:
	§ Protocols, then Ordering, then Comparable.

	§§ Anything with a total order among its values.
	protocol Comparable {
		§§ Orders the value against another one of the same Type.
		§§
		§§ @param to — the value to compare with
		§§ @returns — `Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.
		compare(to other: Self) -> Ordering
	}
}

export {
	Comparable
}
