import {
	from "./List.es" { NonEmptyList }
}

declarations {

	§ `Enumerable` is declared in a file of its own because its one requirement
	§ names `NonEmptyList`. The file `Protocols.es` imports nothing, and that
	§ is what keeps the graph frozen at two cycles. So the Protocol that names a
	§ container can not stand beside `Equatable`; see DEVELOPMENT.md, The shape
	§ of the graph is frozen.
	§
	§ Nothing here declares this conformance, and every Choice of Cases that
	§ carry no payload has it. That is the rule `Equatable` follows, rather than
	§ the one `Printable` follows. How a value reads is a decision, so printing
	§ waits to be declared. What the Cases of a Choice are is a fact about the
	§ declaration, as equality by tag is. So the answer is derived wherever a
	§ Choice carries no payload.
	§
	§ The alternative was a clause beside `is Equatable, is Printable` on all
	§ ten mode Choices. It can not be written. `Ordering.es` and `Terminal.es`
	§ would each import this file, this file imports `List.es`, and `List.es`
	§ imports `Ordering.es`. That is two new cycles for a clause saying what the
	§ Choice already said.
	§
	§ A Namespace over a Choice can write `cases` of its own, and that replaces
	§ the derived answer. A Choice with a payload anywhere derives nothing, and
	§ conforms by writing the Method.

	§§ Anything whose values can be listed, from a Choice whose Cases carry no payload.
	protocol Enumerable {
		§§ Answers every value of the Type.
		§§
		§§ The values stand in the order the Cases are declared in. A Choice has at least one Case, so the answer certainly holds one.
		§§
		§§ @returns — every Case of the Choice, in declaration order.
		static cases() -> NonEmptyList<Self>
	}
}

export {
	Enumerable
}
