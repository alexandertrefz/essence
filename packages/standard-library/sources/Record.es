import {
	from "./Boolean.es" { Boolean }
	from "./Protocols.es" {
		Equatable
		Printable
	}
}

declarations {

	namespace Record for Record is Equatable, is Printable {
		§ A composite asks its members. This Namespace conforms `for Record`,
		§ and it conforms conditionally on the members a Record has. That is
		§ how `List` conforms on its items. A Record's members are no Type
		§ Parameters, though, so no `where` clause can be written for them.
		§ The Compiler works the condition out from the static Type and
		§ synthesises the witness. A member whose own Namespace writes an `is`,
		§ or a `toString`, is compared and printed through that Namespace. The
		§ member witnesses arrive here as the hidden trailing conformance
		§ Arguments every conditional conformance takes.

		§ The width rule is the one surprise in this. Only the members the
		§ static Type declares are asked. A Record value can carry more than
		§ its Type sees. Those extra members are compared and printed by the
		§ runtime's universal structural comparison, `anyIs`, as they always
		§ were. So the top `Record` Type and `{}` declare nothing, route
		§ nothing, and answer what they always answered. The consequence is
		§ that two values can compare one way at a narrow static Type and
		§ another at a wider one. That is the price of asking a Type rather
		§ than a value. A Namespace attaches to a structural Type: a
		§ `{ text = "x" }` literal is a `Tag`. So a value carries no
		§ conformance of its own for the question to be asked of instead.

		§ The Dictionary's key encoding agrees with the comparison, because it
		§ is the same claim. A Record whose members are all structural keeps
		§ the plain witness, which is branded `structural`. Its keys encode
		§ into one Map lookup through `compositeText` in the runtime's
		§ `Dictionary.ts`. A Record that routes a member carries a condition
		§ whose witness is not branded, which is why it routes. So the
		§ Record's witness is not branded either, and its keys scan through
		§ the witness's own `is`. A change here changes that encoding too.

		§ Equality and printing ask different lists. That reads like a typo
		§ and is not. An `Algebraic` prints as the structural walk writes it,
		§ so printing leaves it alone. Its `is` is a symbolic comparison no
		§ encoding stands in for, so equality does not. A `Transcendental`
		§ reads the same way. A String is the other way round in spirit.
		§ Inside a composite the quoted form is what every reader already
		§ gets, so printing leaves a String alone as well. Both lists live in
		§ `helpers/conformance.ts`.

		§§ Answers whether the Record has the same members and values as another.
		§§
		§§ The order the members stand in does not matter. Each member the Record's Type declares is compared by that member's own `Equatable` conformance. So a value whose Namespace writes its own `is` compares the same way on its own and as a member. A member the static Type can not see is compared by the structural equality the language defines. The member sets have to match either way. A Dictionary keyed by Records finds a key by this same comparison.
		§§
		§§ A Record Type whose declared members are not all `Equatable` is not `Equatable` either, exactly as a `List` of such a Type is not.
		§§
		§§ @param _ — the Record to compare against
		§§ @returns — `true` when the Records are equal.
		is(_ other: Record) -> Boolean

		§§ Answers the Record and its members as a String.
		§§
		§§ Each member is written as `name = value`. Each member the Record's Type declares is written the way its own `Printable` conformance writes it. A `Money` member whose Namespace answers `EUR 1999` is written that way. A Case member is written as its Case name. A member the static Type can not see is written structurally. A whole Rational member prints its numerator alone. A String member keeps its quotation marks. A Record too long for one line is written over several lines.
		§§
		§§ A Record Type whose declared members are not all `Printable` is not `Printable` either. `Terminal.inspect` renders any value and asks for no conformance. That is what to reach for then.
		§§
		§§ @returns — the String representation of the Record.
		toString() -> String

		§ `entries` and `values` stay undeclared until there is an `Anything`
		§ Type to answer with; see README.md.

		§§ Answers the names of the Record's members.
		§§
		§§ The names are one third of a reflective trio. The other two, `entries` and `values`, answer a value of any Type, and there is no Type to write that with. So a Program can read the names and not what they name.
		§§
		§§ @returns — the member names, as a List of Strings.
		keys() -> List<String>
	}
}

export {
	Record
}
