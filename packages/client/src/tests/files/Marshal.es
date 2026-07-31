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

	type Label = String | Integer

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

	function maybe(_ value: Optional<Integer>) -> Optional<Integer> {
		<- value
	}

	function shape(_ value: Shape) -> Shape {
		<- value
	}

	function labelled(_ value: Label) -> Label {
		<- value
	}

	function boxes(_ value: List<Box>) -> List<Box> {
		<- value
	}

	function maybes(_ value: List<Optional<Integer>>) -> List<Optional<Integer>> {
		<- value
	}

	function areaOf(_ value: Shape) -> Integer {
		<- match value -> Integer {
			case #Circle { <- @.radius::multiply(with @.radius) }
			case #Rect   { <- @.width::multiply(with @.height) }
			case #Blank  { <- 0 }
		}
	}

	constant answer = 42
	constant third = 1/3
	constant greeting = "hé"
	constant yes = true
	constant names = ["a", "b"]
	constant point = { x = 1, y = 2 }
	constant blank: Shape = #Blank
	constant circle: Shape = #Circle({ radius = 3 })
	constant present: Optional<Integer> = #Value(7)
	constant absent: Optional<Integer> = #Empty
}

export {
	Shape
	Box
	Label
	integer
	rational
	text
	flag
	words
	box
	maybe
	shape
	labelled
	boxes
	maybes
	areaOf
	answer
	third
	greeting
	yes
	names
	point
	blank
	circle
	present
	absent
}
