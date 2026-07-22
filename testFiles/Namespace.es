implementation {

	namespace StringForInteger for Integer {
		string() -> String {
			<- "stringForInteger: "::append(@::toString())
		}
	}

	namespace StringForRational for Rational {
		string(_ foo: Boolean) -> String {
			<- "stringForRational: "::append(@::toString())
		}
	}

	namespace StringForNumber for Number {
		string(_ foo: Boolean) -> String {
			<- "stringForNumber: "::append(
				match @ -> String {
					case Integer  { <- @::toString() }
					case Rational { <- @::toString() }
					case Algebraic { <- @::toString() }
					case Transcendental { <- @::toString() }
				}
			)
		}
	}

	§ The receiver's Type and the Arguments pick the Namespace — and where
	§ several would fit, `::<Namespace>` names the one that is meant.
	__print(1::add(2)::string())                          § "stringForInteger: 3"
	__print(1::add(2)::string(false))                     § "stringForNumber: 3"
	__print(1::add(2/1)::<StringForRational>string(false)) § "stringForRational: 3/1"
	__print(1::add(2/1)::<StringForNumber>string(false))  § "stringForNumber: 3/1"

	§ § Namespace for Record Type

	§ namespace FullName for { firstName: String, lastName: String } {
	§ 	fullName() -> String {
	§ 		<- "{@.firstName} {@.lastName}"
	§ 	}
	§ }

	§ type Person = { firstName: string, lastName: string, age: Integer, adress: Adress }

	§ variable person = { firstName = "Alexander", lastName = "Trefz", occupation = "Software Engineer" }

	§ __print(person()::fullName()::splitOn(" "))
	§ __print(FullName.fullName(person)::splitOn(" "))

	§ namespace VectorMove<Vector extends { x: Number, y: Number}> for Vector {
	§ 	translateHorizontally(_ x: Number) -> Vector {
	§ 		<- { @ with x = @.x::add(x) }
	§ 	}
	§ }

	§ § Namespaces for Lists & Generics

	§ `map` and `reduce` are builtins now — see List.es and Inference.es. A
	§ List-of-Number `sum` still wants a Namespace targeting `List<Number>`,
	§ which conditional conformance will make expressible.
}