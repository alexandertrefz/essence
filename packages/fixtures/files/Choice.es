implementation {

	§ A Choice declares the shapes a value can take — here, everything the keys
	§ of a pocket calculator can ask for. Each Case carries a Record of its own
	§ fields, and a Case with nothing to carry, like `ClearAll`, carries none.

	choice Operation {
		Add { left: Integer, right: Integer },
		Subtract { left: Integer, right: Integer },
		Multiply { left: Integer, right: Integer },
		Divide { left: Integer, right: Integer },
		SquareRoot { number: Integer },
		ClearAll,
	}

	§ `divide` and `squareRoot` are already fallible, so their arms hand their
	§ Optional straight on; the total ones wrap what they computed.
	function evaluated(_ operation: Operation) -> Optional<Number> {
		<- match operation -> Optional<Number> {
			case #Add        { <- #Value(@.left::add(@.right)) }
			case #Subtract   { <- #Value(@.left::subtract(@.right)) }
			case #Multiply   { <- #Value(@.left::multiply(with @.right)) }
			case #Divide     { <- @.left::divide(by @.right) }
			case #SquareRoot { <- @.number::squareRoot() }
			case #ClearAll   { <- #Empty }
		}
	}

	§ Each key, as a person would write it down.
	function spelled(_ operation: Operation) -> String {
		<- match operation -> String {
			case #Add        { <- "{@.left} + {@.right}" }
			case #Subtract   { <- "{@.left} - {@.right}" }
			case #Multiply   { <- "{@.left} × {@.right}" }
			case #Divide     { <- "{@.left} ÷ {@.right}" }
			case #SquareRoot { <- "√{@.number}" }
			case #ClearAll   { <- "AC" }
		}
	}

	§ A tape of key presses. The annotation types the List, so every bare
	§ `#Case` resolves against `Operation` without a prefix.
	constant tape: List<Operation> = [
		#Add({ left = 7, right = 5 }),
		#Multiply({ left = 6, right = 7 }),
		#Divide({ left = 1, right = 3 }),
		#Divide({ left = 1, right = 0 }),
		#SquareRoot({ number = 9 }),
		#SquareRoot({ number = 2 }),
		#ClearAll,
	]

	§ One line per press. A payload-less Case compares with `is`, so clearing
	§ is told apart without a Match — and a failed computation is not an error,
	§ just an `#Empty` the tape prints as such.
	tape::map((operation) {
		if operation::is(#ClearAll) {
			<- Terminal.inspect("AC — cleared")
		}

		<- Terminal.inspect(
			"{spelled(operation)} = {match evaluated(operation) -> String {
				case #Value(result) { <- result::toString() }
				case #Empty         { <- "nothing" }
			}}",
		)
	})

	§ Another Choice may declare a Case of the same name — context picks the
	§ Choice, so even the shared names never need a prefix.
	choice EditorCommand {
		Undo,
		Redo,
		ClearAll,
	}

	constant command: EditorCommand = #Undo

	Terminal.inspect(
		command::isNot(#ClearAll),
	) § true — EditorCommand's own ClearAll
}
