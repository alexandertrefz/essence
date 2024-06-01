implementation {

	namespace StringForInteger for Integer {
		string() -> String {
			<- "stringForInteger: "::append(@::toString())
		}
	}

	namespace StringForFraction for Fraction {
		string(_ foo: Boolean) -> String {
			<- "stringForFraction: "::append(@::toString())
		}
	}

	namespace StringForNumber for Number {
		string(_ foo: Boolean) -> String {
			<- "stringForNumber: "::append(
				match @ -> String {
					case Integer  { <- @::toString() }
					case Fraction { <- @::toString() }
				}
			)
		}
	}

	__print(1::add(2)::string())
	__print(1::add(2)::string(false))
	__print(1::add(2/1)::<StringForFraction>string(false))
	__print(1::add(2/1)::<StringForNumber>string(false))

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

	§ namespace ListMap<Item> for List<Item> {
	§ 	map<ReturnType>(_ mappingFunction: (_ item: Item) -> ReturnType) -> List<ReturnType>
	§ }

	§ __print([0, 1, 2]::map((item: Number) -> String { <- item::add(1)::toString() }))

	§ namespace ListSum for List<Number> {
	§ 	sum() -> Item {
	§ 		§ @::reduce(startingWith: 0, (a: Number, b: Number) -> Number { <- a::add(b) })
	§ 		<- 0
	§ 	}
	§ }

	§ __print([1, 2, 3, 4]::sum())
	§ __print([1, 2/1, 3, 4/1, 0, 0/1]::sum())
}