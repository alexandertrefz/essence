implementation {

	§ Private: nothing below exports it, so an entry asking for it is refused.
	type Circle = { radius: Integer }

	type Rectangle = { width: Integer, height: Integer }

	variable counter = 0

	function area(_ shape: Rectangle) -> Integer {
		<- shape.width::multiply(with shape.height)
	}
}

export {
	Rectangle
	area
	counter
	nowhere
}
