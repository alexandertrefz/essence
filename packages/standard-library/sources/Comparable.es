import {
	Ordering from "./Ordering.es"
}

declarations {

	§ `Comparable` sits apart from `Equatable` and `Printable` for one reason:
	§ it is the only Protocol whose signature names a Type rather than only the
	§ bare tags. `Ordering` is a Choice, declared in a file whose Namespace
	§ conforms to the other two — so keeping all three together would put
	§ `Protocols.es` and `Ordering.es` in a cycle, each needing something the
	§ other declares. Split, the three files form a line: Protocols, then
	§ Ordering, then Comparable.

	§§ Anything with a total order among its values.
	protocol Comparable {
		§§ Orders the value against another one of the same Type.
		§§
		§§ @param other — the value to compare with
		§§ @returns — `Ordering#Less`, `Ordering#Equal` or `Ordering#Greater`.
		compare(to other: Self) -> Ordering
	}
}

export {
	Comparable
}
