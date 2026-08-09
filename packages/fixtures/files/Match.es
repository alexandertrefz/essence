implementation {

	§ A match takes one Union-typed value — the scrutinee — and the first
	§ Case that fits wins. Inside every Case body, `@` is the scrutinee,
	§ narrowed to what that Case established.
	constant amount: Integer | Rational = 1/2

	Terminal.print(match amount -> String {
		case Integer where @::isGreaterThan(100) { <- "a large whole number" }
		case Integer  { <- "a whole number" }
		case Rational { <- "a fraction: {@}" }
	}) § a fraction: 1/2

	§ Literal Cases match one exact value, and read best before the Type Case
	§ that would otherwise swallow them.
	function describe(_ count: Integer | String) -> String {
		<- match count -> String {
			case 0 { <- "none" }
			case 1 { <- "exactly one" }
			case Integer where @::isNegative() { <- "less than none?" }
			case Integer { <- "many" }
			case String  { <- "not a count at all: {@}" }
		}
	}

	Terminal.print(describe(0)) § none
	Terminal.print(describe(1)) § exactly one
	Terminal.print(describe(0::subtract(2))) § less than none?
	Terminal.print(describe(7)) § many
	Terminal.print(describe("lots")) § not a count at all: lots

	§ A Case Matcher binds what its Case carries, so a fallible answer reads
	§ by name rather than through `@`.
	function readCount(_ text: String) -> String {
		<- match Integer.parse(text) -> String {
			case #Value(count) { <- describe(count) }
			case #Empty        { <- "no count at all" }
		}
	}

	Terminal.print(readCount("7")) § many
	Terminal.print(readCount("seven")) § no count at all

	§ Record Cases match structurally, by the fields they name — a mix of
	§ required Types (`:`) and exact values (`=`) picks the Union member
	§ apart without naming it. Every field a Matcher names also BINDS, so an
	§ arm reads what it matched on by name; a field constrained by VALUE is
	§ the one exception, because the value it stands for is written right
	§ there.
	type Click = { x: Integer, y: Integer }
	type KeyPress = { key: String }

	constant input: Click | KeyPress = { x = 0, y = 7 }

	Terminal.print(match input -> String {
		case { x = 0, y = 0 }           { <- "clicked the origin" }
		case { x = 0, y: Integer }      { <- "clicked the y axis at {y}" }
		case { x: Integer, y: Integer } { <- "clicked at {x}, {y}" }
		case { key: String }            { <- "pressed {key}" }
	}) § clicked the y axis at 7
}
