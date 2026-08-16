§ The names a generated declaration file has to step around: a Namespace member
§ that shares a Case's name, and a Module export that shares the name this
§ package lends a generated file.

implementation {

	choice Shape {
		Circle { radius: Integer },
		Blank,
	}

	§ Both Cases named again by the Namespace — one as a static constant, one as
	§ a static Method. The binding lets what the Module declares win, so these
	§ are what a host reaches under those names and the constructors are not.
	namespace Shape for Shape {
		static Blank = 5

		static Circle(_ value: Integer) -> Integer {
			<- value
		}

		static drawn() -> Shape {
			<- #Blank
		}
	}

	§ The one name a generated file borrows from this package, exported by a
	§ Module that also has a Rational to spell with it.
	constant EssenceRational = 5

	constant ratio = 1/3
}

export {
	EssenceRational
	Shape
	ratio
}
