import {
	from "./Protocols.es" {
		Equatable
		Printable
	}
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

	§ `Equatable` and `Printable` are both derived for a Choice of Cases that
	§ carry no payload. This Namespace declares the two and writes neither; see
	§ DEVELOPMENT.md, Why bodies look the way they do.
	namespace Ordering for Ordering is Equatable, is Printable {}
}

export {
	Ordering
}
