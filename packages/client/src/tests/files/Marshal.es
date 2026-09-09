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

	§ A unit Choice — every Case payload-less — which is the shape that crosses
	§ as a bare string rather than as a `$case` object.
	choice Direction {
		Up,
		Down,
	}

	§ A second unit Choice sharing `#Up` with the one above, so that a Union of
	§ the two has a position no string can be read into.
	choice Vertical {
		Up,
		Down,
	}

	§ And a third sharing no Case name with either, so that the refusal above is
	§ visibly per Case name rather than per pair of unit Choices.
	choice Sign {
		Plus,
		Minus,
	}

	§ A bare Case where a Record member is what carries it — the position a
	§ Descriptor is walked to rather than met at.
	type Marker = { direction: Direction }

	§ A Dictionary a Record carries, which is the same position for the same
	§ reason.
	type Ledger = { entries: Dictionary<String, Integer> }

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

	§ A Dictionary, which crosses as a JavaScript `Map` at every key Type — one
	§ shape for every kind of key, holding its entries in the order they were
	§ put in, which is the order a Dictionary holds its own.
	function ages(
		_ value: Dictionary<String, Integer>,
	) -> Dictionary<String, Integer> {
		<- value
	}

	§ And keyed by each of the other kinds a key is written as on the JavaScript
	§ side: a bigint, an `EssenceRational`, a boolean, the bare name of a unit
	§ Choice's Case, a `$case` object and a plain one. The last three are looked
	§ up by IDENTITY in a `Map`, which is what makes such a key one to iterate
	§ rather than one to read back.
	function counts(
		_ value: Dictionary<Integer, String>,
	) -> Dictionary<Integer, String> {
		<- value
	}

	function shares(
		_ value: Dictionary<Rational, String>,
	) -> Dictionary<Rational, String> {
		<- value
	}

	function flags(
		_ value: Dictionary<Boolean, String>,
	) -> Dictionary<Boolean, String> {
		<- value
	}

	function headings(
		_ value: Dictionary<Direction, Integer>,
	) -> Dictionary<Direction, Integer> {
		<- value
	}

	function outlines(
		_ value: Dictionary<Shape, Integer>,
	) -> Dictionary<Shape, Integer> {
		<- value
	}

	function plots(
		_ value: Dictionary<Box, Integer>,
	) -> Dictionary<Box, Integer> {
		<- value
	}

	§ A refinement crosses UNWRAPPED to its base and UNPROVEN, which is the
	§ boundary's rule for every one of them rather than anything about this
	§ Type: the predicate belongs at the crossing and does not run there yet.
	function filled(
		_ value: NonEmptyDictionary<String, Integer>,
	) -> NonEmptyDictionary<String, Integer> {
		<- value
	}

	§ The three positions a Dictionary is reached AT rather than met at — a
	§ value of one, an item of one and a member of one.
	function nesting(
		_ value: Dictionary<String, Dictionary<String, Integer>>,
	) -> Dictionary<String, Dictionary<String, Integer>> {
		<- value
	}

	function ledgers(
		_ value: List<Dictionary<String, Integer>>,
	) -> List<Dictionary<String, Integer>> {
		<- value
	}

	function ledger(_ value: Ledger) -> Ledger {
		<- value
	}

	function maybeAges(
		_ value: Optional<Dictionary<String, Integer>>,
	) -> Optional<Dictionary<String, Integer>> {
		<- value
	}

	§ Not an identity, and deliberately so. A Dictionary is a SHARED store with
	§ a generation stamp: a written key is a version pushed onto it and a removed
	§ one leaves a tombstoned slot standing where it was, so what a box holds is
	§ never simply what its store holds. This is the value a round trip of a
	§ freshly built Dictionary can not ask about.
	function edited(
		_ value: Dictionary<String, Integer>,
	) -> Dictionary<String, Integer> {
		<- value::set("added", to 9)::remove(at "dropped")
	}

	§ A `Result` is an ordinary generic Choice on the JavaScript side — the
	§ Optional beside it is the one Choice spelled by absence, and a reason has
	§ no room in `undefined`.
	function result(
		_ value: Result<Integer, String>,
	) -> Result<Integer, String> {
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

	function direction(_ value: Direction) -> Direction {
		<- value
	}

	function maybeDirection(
		_ value: Optional<Direction>,
	) -> Optional<Direction> {
		<- value
	}

	function directions(_ value: List<Direction>) -> List<Direction> {
		<- value
	}

	function marker(_ value: Marker) -> Marker {
		<- value
	}

	function ordering(_ value: Ordering) -> Ordering {
		<- value
	}

	§ The four Unions a bare Case can stand in. The first two have no
	§ unambiguous JavaScript spelling — `"Up"` is a String too, and one `#Up` is
	§ not the other's — and the last two do, so all four are here to be told
	§ apart rather than to be marshalled alike.
	function directionOrText(
		_ value: Direction | String,
	) -> Direction | String {
		<- value
	}

	function directionOrVertical(
		_ value: Direction | Vertical,
	) -> Direction | Vertical {
		<- value
	}

	function directionOrSign(_ value: Direction | Sign) -> Direction | Sign {
		<- value
	}

	function directionOrShape(_ value: Direction | Shape) -> Direction | Shape {
		<- value
	}

	function areaOf(_ value: Shape) -> Integer {
		<- match value -> Integer {
			case #Circle({ radius })      { <- radius::multiply(with radius) }
			case #Rect({ width, height }) { <- width::multiply(with height) }
			case #Blank                   { <- 0 }
		}
	}

	constant sizes: Dictionary<String, Integer> = ["small" = 1, "large" = 2]
	constant nothing: Dictionary<String, Integer> = [=]

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

	constant answered: Result<Integer, String> = #Value(7)
	constant refused: Result<Integer, String>  = #Failure("gone")

	§ A constant typed by a unit Choice, which is read through a different door
	§ than a Function's answer is — and a Case standing ALONE for a Type, which
	§ is what an unannotated one is inferred as. `#Plus` rather than `#Up`
	§ because the latter is declared by two Choices here and a lone one has
	§ nothing to say which.
	constant heading: Direction = #Up
	constant plus = #Plus
}

export {
	Box
	Card
	Config
	Direction
	Label
	Ledger
	Marker
	Shape
	Sign
	Styled
	Vertical
	absent
	ages
	answer
	answered
	areaOf
	blank
	box
	boxes
	branched
	card
	circle
	config
	counts
	direction
	directionOrShape
	directionOrSign
	directionOrText
	directionOrVertical
	directions
	edited
	filled
	flag
	flags
	greeting
	grown
	heading
	headings
	integer
	labelled
	ledger
	ledgers
	marker
	maybe
	maybeAges
	maybeDirection
	maybes
	names
	nesting
	nothing
	ordering
	outlines
	plots
	plus
	point
	present
	rational
	refused
	result
	shape
	shares
	sizes
	styled
	text
	third
	words
	yes
}
