§ The shapes a generated declaration file has to have an answer for and the
§ other fixtures do not exercise: a Protocol, a Type Parameter, a Namespace that
§ conforms, a Rational, and a List of Records.

implementation {

	protocol Measurable {
		area() -> Integer
	}

	type Rectangle = { width: Integer, height: Integer }

	namespace RectangleMeasurable for Rectangle is Measurable {
		area() -> Integer {
			<- @.width::multiply(with @.height)
		}
	}

	function firstOf<ItemType>(_ items: List<ItemType>) -> Optional<ItemType> {
		<- items::firstItem()
	}

	function widths(_ rectangles: List<Rectangle>) -> List<Integer> {
		<- rectangles::map(({ width }) { <- width })
	}

	constant ratio = 22/7
}

export {
	Measurable
	Rectangle
	RectangleMeasurable
	firstOf
	widths
	ratio
}
