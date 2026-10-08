§ A Protocol whose conformer lives in a Module that imports this one, and is
§ exported again from here. Its provided Method crosses with it.

implementation {
	protocol Walking {
		step() -> Integer

		twice() -> Integer {
			<- @::step()::multiply(with 2)
		}
	}
}

export {
	Walking
	from "./Walkers.es" {
		Walker
		Walkers
	}
}
