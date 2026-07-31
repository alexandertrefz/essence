§ Everything about CALLING a Module: labels, a Namespace's two kinds of Method,
§ an Overload set, and the Types a return value comes back as.

implementation {

	choice Colour {
		Red,
		Named { name: String },
	}

	type Point = { x: Integer, y: Integer }

	function labelled(first: Integer, second: Integer) -> Integer {
		<- first::subtract(second)
	}

	function positional(_ first: Integer, _ second: Integer) -> Integer {
		<- first::subtract(second)
	}

	function mixed(_ first: Integer, second: Integer) -> Integer {
		<- first::subtract(second)
	}

	function nothing() -> String {
		<- "nothing"
	}

	§ A Parameter nothing on the JavaScript side can fill: a Function can come
	§ out of a Module, but one can not be built from a JavaScript value and
	§ passed in.
	function applied(_ value: Integer, with transform: (_: Integer) -> Integer) -> Integer {
		<- transform(value)
	}

	function moved(_ point: Point) -> Point {
		<- point
	}

	function evened(_ value: Integer) -> Optional<Integer> {
		if value::isEven() {
			<- #Value(value)
		} else {
			<- #Empty
		}
	}

	function coloured(_ name: String) -> Colour {
		if name::is("red") {
			<- #Red
		} else {
			<- #Named({ name = name })
		}
	}

	namespace Point for Point {
		static of(x: Integer, y: Integer) -> Point {
			<- { x = x, y = y }
		}

		static origin() -> Point {
			<- { x = 0, y = 0 }
		}

		static named = "Point"

		overload static from {
			(x: Integer) -> Point {
				<- { x = x, y = 0 }
			}

			(x: Integer, y: Integer) -> Point {
				<- { x = x, y = y }
			}
		}

		shifted(by amount: Integer) -> Point {
			<- { x = @.x::add(amount), y = @.y::add(amount) }
		}

		flipped() -> Point {
			<- { x = @.y, y = @.x }
		}

		overload grown {
			(_ amount: Integer) -> Point {
				<- { x = @.x::add(amount), y = @.y::add(amount) }
			}

			(by amount: Integer, and other: Integer) -> Point {
				<- { x = @.x::add(amount), y = @.y::add(other) }
			}
		}
	}
}

export {
	Colour
	Point
	labelled
	positional
	mixed
	nothing
	applied
	moved
	evened
	coloured
}
