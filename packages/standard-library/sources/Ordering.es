import {
	Equatable from "./Protocols.es"
	Printable from "./Protocols.es"
}

declarations {

	§ Three unit Cases, written `Ordering#Less`, `Ordering#Equal` and
	§ `Ordering#Greater`, and matched as `case #Less`. A match over them is
	§ checked for exhaustiveness like any other Choice.
	choice Ordering {
		Less,
		Equal,
		Greater,
	}

	§ `Equatable` is derived for a Choice; see DEVELOPMENT.md, Why bodies look
	§ the way they do.
	namespace Ordering for Ordering is Equatable, is Printable {
		§§ Represents the Ordering as `Less`, `Equal` or `Greater`.
		§§
		§§ @returns — the name of the Ordering's Case.
		toString() -> String {
			<- match @ -> String {
				case #Less    { <- "Less" }
				case #Equal   { <- "Equal" }
				case #Greater { <- "Greater" }
			}
		}
	}
}

export {
	Ordering
}
