implementation {

	union CalculatorOperation {
		Add { left: Number, right: Number },
		Subtract { left: Number, right: Number },
		Divide { left: Number, right: Number },
		Multiply { left: Number, right: Number },

		Negate { number: Number },
		Factorial { number: Number },
		SquareRoot { number: Number },
		RaiseToPower { base: Number, power: Number },

		ClearAll,
	}

	§ We could leave the Union Name (`CalculatorOperation`) off whenever there is no ambiguity,
	§ and call for disambiguation when needed, just like for namespace resolution in method calls:
	§ constant operation = #Add({ left: 1, right: 1 })
	constant operation = CalculatorOperation#Add({ left: 1, right: 1 })

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

		§ TODO: Implement the remainder of the operations
		case _ {
			<- Nothing
		}
	}

}