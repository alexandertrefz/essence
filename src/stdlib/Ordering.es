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
	§ those of any other Choice. The `Equatable` conformance is DECLARED and
	§ not written: a Choice derives equality from its tags, and `compareTo`
	§ across the whole language leans on `Ordering::is`, so the one written
	§ here would have been the most-called nested match in the standard library.
	namespace Ordering for Ordering is Equatable, is Printable {
		§§ Represents the Ordering as `Less`, `Equal` or `Greater`.
		§§
		§§ @returns the name of the Ordering variant.
		toString() -> String {
			<- match @ -> String {
				case #Less { <- "Less" }
				case #Equal { <- "Equal" }
				case #Greater { <- "Greater" }
			}
		}
	}
}
