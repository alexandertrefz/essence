implementation {

	§ A match takes one Union-typed value — the scrutinee — and the first
	§ Case that fits wins. Inside every Case body, `@` is the scrutinee,
	§ narrowed to what that Case established.
	constant amount: Integer | Rational = 1/2

	__print(match amount -> String {
		case Integer where @::isGreaterThan(100) { <- "a large whole number" }
		case Integer  { <- "a whole number" }
		case Rational { <- "a fraction: "::append(@::toString()) }
	})                                     § "a fraction: 1/2"

	§ Literal Cases match one exact value, and read best before the Type Case
	§ that would otherwise swallow them.
	function describe(_ count: Integer | Nothing) -> String {
		<- match count -> String {
			case Nothing { <- "no count at all" }
			case 0 { <- "none" }
			case 1 { <- "exactly one" }
			case Integer where @::isNegative() { <- "less than none?" }
			case Integer { <- "many" }
		}
	}

	__print(describe(0))                   § "none"
	__print(describe(1))                   § "exactly one"
	__print(describe(0::subtract(2)))      § "less than none?"
	__print(describe(7))                   § "many"
	__print(describe(nothing))             § "no count at all"

	§ Record Cases match structurally, by the fields they name — a mix of
	§ required Types (`:`) and exact values (`=`) picks the Union member
	§ apart without naming it.
	type Click = { x: Integer, y: Integer }
	type KeyPress = { key: String }

	constant input: Click | KeyPress = { x = 0, y = 7 }

	__print(match input -> String {
		case { x = 0, y = 0 } { <- "clicked the origin" }
		case { x = 0, y: Integer } { <- "clicked the y axis at "::append(@.y::toString()) }
		case { x: Integer, y: Integer } { <- "clicked somewhere else" }
		case { key: String } { <- "pressed "::append(@.key) }
	})                                     § "clicked the y axis at 7"

}
