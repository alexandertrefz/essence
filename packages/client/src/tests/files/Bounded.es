§ A Function bounded by a Protocol this Module declares. The Compiler knows the
§ Protocol by this file's path, and every description of the Function names it.

implementation {
	protocol Sized {
		size() -> Integer
	}

	namespace IntegerSized for Integer is Sized {
		size() -> Integer {
			<- @
		}
	}

	function measure<infer Item is Sized>(_ item: Item) -> Integer {
		<- item::size()
	}
}

export {
	IntegerSized
	Sized
	measure
}
