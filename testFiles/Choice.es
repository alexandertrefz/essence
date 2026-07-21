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

	constant result = match operation -> Number | Nothing {
		case #Add {
			<- @.left::add(@.right)
		}

		case #Subtract {
			<- @.left::subtract(@.right)
		}

		case #Divide {
			<- @.left::divideBy(@.right)
		}

		case #Multiply {
			<- @.left::multiplyWith(@.right)
		}

		case _ {
			<- nothing
		}
	}

	__print(match result -> String {
		case Nothing { <- "nothing" }
		case Integer { <- @::toString() }
		case Fraction { <- @::toString() }
	})

	constant cleared: CalculatorOperation = #ClearAll

	__print(match cleared -> String {
		case #ClearAll { <- "cleared" }
		case _ { <- "not cleared" }
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
		case #Undo { <- "undone" }
		case #Redo { <- "redone" }
		case #ClearAll { <- "cleared everything" }
	})

}
