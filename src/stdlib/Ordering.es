declarations {

	§ `Ordering` is the builtin Choice — three unit Cases, written
	§ `Ordering#Less`, `Ordering#Equal` and `Ordering#Greater` and matched as
	§ `case #Less` etc., with full exhaustiveness checking like any other
	§ Choice.
	choice Ordering {
		Less,
		Equal,
		Greater,
	}

	§ No properties — the Cases are reached as `Ordering#Less` etc., like
	§ those of any other Choice.
	namespace Ordering for Ordering is Equatable, is Printable {
		§§ Answers whether both Orderings are the same variant.
		§§
		§§ @param other the Ordering to compare with
		§§ @returns `true` when both Orderings are the same variant.
		is(_ other: Ordering) -> Boolean

		§§ Answers whether the Orderings are different variants.
		§§
		§§ @param other the Ordering to compare with
		§§ @returns `true` when the Orderings are different variants.
		isNot(_ other: Ordering) -> Boolean

		§§ Represents the Ordering as `Less`, `Equal` or `Greater`.
		§§
		§§ @returns the name of the Ordering variant.
		toString() -> String
	}
}
