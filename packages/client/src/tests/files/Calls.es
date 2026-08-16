§ Everything about CALLING a Module: labels, a Namespace's two kinds of Method,
§ an Overload set, and the Types a return value comes back as.

implementation {

	choice Colour {
		Red,
		Named { name: String },
	}

	type Point = { x: Integer, y: Integer }

	type Box = { box: Integer }

	§ A Type Alias holding a callback — nothing on the JavaScript side can fill
	§ the member, and a Parameter naming the Alias has to say so.
	type Handler = { callback: (_: Integer) -> Integer }

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

	§ A Function passed IN, and called once.
	function applied(
		_ value: Integer,
		with transform: (_: Integer) -> Integer,
	) -> Integer {
		<- transform(value)
	}

	§ The same Parameter called TWICE, so that a value crosses out and back for
	§ each call rather than once for the whole Argument.
	function applyTwice(
		_ transform: (_: Integer) -> Integer,
		_ value: Integer,
	) -> Integer {
		<- transform(transform(value))
	}

	§ A callback handed a Record — which crosses OUT to reach it, the way round
	§ the Function itself did not. Every Parameter carries a label, so it can be
	§ called with one object as well.
	function measured(
		box: Box,
		by measure: (_: Box) -> Integer,
	) -> Integer {
		<- measure(box)
	}

	function moved(_ point: Point) -> Point {
		<- point
	}

	§ One labelled Parameter a Record can inhabit without BEING its Type — the
	§ Union's Box arm, and the Box inside an Optional. An object passed to
	§ either is the value, never a labelled call.
	function boxed(box: Box | Integer) -> Box | Integer {
		<- box
	}

	function measure(box: Optional<Box>) -> Optional<Box> {
		<- box
	}

	§ A Function crossing OUT — the answer of a call, and a Record member. Each
	§ crosses wrapped against its declared signature rather than raw.
	function makeAdder(_ amount: Integer) -> (_: Integer) -> Integer {
		<- (_ value: Integer) -> Integer { <- value::add(amount) }
	}

	function doubled(_ value: Integer) -> Integer {
		<- value::multiply(with 2)
	}

	constant handler: Handler = { callback = doubled }

	function invoke(_ handler: Handler) -> Integer {
		constant { callback } = handler

		<- callback(7)
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

		§ The two member names a JavaScript class refuses — the Rewriter mangles
		§ them, and the binding has to read them under the mangled key.
		static constructor = 5

		prototype() -> Integer {
			<- @.x
		}

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
	Box
	Colour
	Handler
	Point
	applied
	applyTwice
	boxed
	coloured
	evened
	handler
	invoke
	labelled
	makeAdder
	measure
	measured
	mixed
	moved
	nothing
	positional
}
