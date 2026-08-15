§ Every row of the marshalling table, as a Type the Export Surface names.
§ The Functions are identities so that a round trip through the Module is the
§ same value coming back out, and nothing but the boundary is under test.

implementation {

	choice Shape {
		Circle { radius: Integer },
		Rect { width: Integer, height: Integer },
		Blank,
	}

	type Box = { width: Integer, height: Integer }

	§ A Record with an Optional member, which is the shape an absent key has to
	§ be admitted for — `undefined` is how `Optional<String>` is spelled here,
	§ and a key holding `undefined` does not survive JSON.
	type Card = { title: String, note: Optional<String> }

	type Label = String | Integer

	§ Member names that live on JavaScript's `Object.prototype` — an absent key
	§ has to read as absent, never as JavaScript's own `toString` or `valueOf`.
	type Config = { toString: Optional<String> }

	choice Styled {
		Tagged { valueOf: Optional<String> },
	}

	function integer(_ value: Integer) -> Integer {
		<- value
	}

	function rational(_ value: Rational) -> Rational {
		<- value
	}

	function text(_ value: String) -> String {
		<- value
	}

	function flag(_ value: Boolean) -> Boolean {
		<- value
	}

	function words(_ value: List<String>) -> List<String> {
		<- value
	}

	function box(_ value: Box) -> Box {
		<- value
	}

	function card(_ value: Card) -> Card {
		<- value
	}

	function maybe(_ value: Optional<Integer>) -> Optional<Integer> {
		<- value
	}

	function shape(_ value: Shape) -> Shape {
		<- value
	}

	function labelled(_ value: Label) -> Label {
		<- value
	}

	function config(_ value: Config) -> Config {
		<- value
	}

	function styled(_ value: Styled) -> Styled {
		<- value
	}

	function boxes(_ value: List<Box>) -> List<Box> {
		<- value
	}

	function maybes(
		_ value: List<Optional<Integer>>,
	) -> List<Optional<Integer>> {
		<- value
	}

	§ Not identities, and deliberately so. A List added to at both ends holds its
	§ items in two runs, and a List another List was built from holds fewer items
	§ than the Array under it does — so what crosses the boundary here is a value
	§ whose items are not simply what it is stored as, which is the one thing a
	§ round trip of a freshly built List can never ask about.
	function grown(_ value: List<String>) -> List<String> {
		<- value::prepend("first")::append("last")
	}

	function branched(_ value: List<String>) -> List<List<String>> {
		<- [value::append("z"), value::prepend("a"), value]
	}

	function areaOf(_ value: Shape) -> Integer {
		<- match value -> Integer {
			case #Circle({ radius })      { <- radius::multiply(with radius) }
			case #Rect({ width, height }) { <- width::multiply(with height) }
			case #Blank                   { <- 0 }
		}
	}

	constant answer        = 42
	constant third         = 1/3
	constant greeting      = "hé"
	constant yes           = true
	constant names         = ["a", "b"]
	constant point         = { x = 1, y = 2 }
	constant blank: Shape  = #Blank
	constant circle: Shape = #Circle({ radius = 3 })
	constant present: Optional<Integer> = #Value(7)
	constant absent: Optional<Integer>  = #Empty
}

export {
	Box
	Card
	Config
	Label
	Shape
	Styled
	absent
	answer
	areaOf
	blank
	box
	boxes
	branched
	card
	circle
	config
	flag
	greeting
	grown
	integer
	labelled
	maybe
	maybes
	names
	point
	present
	rational
	shape
	styled
	text
	third
	words
	yes
}
