implementation {

	choice CalculatorOperation {
		Add { left: Integer, right: Integer },
		Subtract { left: Integer, right: Integer },
		Divide { left: Integer, right: Integer },
		Multiply { left: Integer, right: Integer },

		Negate { number: Integer },
		Factorial { number: Integer },
		SquareRoot { number: Integer },
		RaiseToPower { base: Integer, power: Integer },

		ClearAll,
	}

	constant operation: CalculatorOperation = #Add({ left = 1, right = 1 })

	§ `divide` and `squareRoot` are already fallible, so their arms hand their
	§ Optional on; the total ones wrap what they computed.
	constant result = match operation -> Optional<Number> {
		case #Add        { <- #Value(@.left::add(@.right)) }

		case #Subtract   { <- #Value(@.left::subtract(@.right)) }

		case #Divide     { <- @.left::divide(by @.right) }

		case #Multiply   { <- #Value(@.left::multiply(with @.right)) }

		case #SquareRoot { <- @.number::squareRoot() }

		case _           { <- #Empty }
	}

	__print(match result -> String {
		case #Empty { <- "nothing" }

		case #Value(value) {
			<- match value -> String {
				case Integer        { <- @::toString() }
				case Rational       { <- @::toString() }
				case Algebraic      { <- @::toString() }
				case Transcendental { <- @::toString() }
			}
		}
	})

	constant cleared: CalculatorOperation = #ClearAll

	__print(match cleared -> String {
		case #ClearAll { <- "cleared" }
		case _         { <- "not cleared" }
	})

	§ `EditorCommand` also declares `ClearAll` — the annotations above pick
	§ the right Choice from context, so the bare Cases need no prefix even
	§ though the name is shared between two Choices.
	choice EditorCommand {
		Undo,
		Redo,
		ClearAll,
	}

	constant undone: EditorCommand = #Undo

	__print(match undone -> String {
		case #Undo     { <- "undone" }
		case #Redo     { <- "redone" }
		case #ClearAll { <- "cleared everything" }
	})
}
