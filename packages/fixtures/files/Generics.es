implementation {

	§ A generic Namespace is written once and works over every List — the Type
	§ Parameter is inferred from the receiver of each call. This one turns any
	§ List into a Stack, and a Stack of Strings into an undo history.

	namespace Stack<infer Item> for List<Item> {
		push(_ item: Item) -> NonEmptyList<Item> {
			<- @::append(item)
		}

		pop() -> List<Item> {
			<- @::removeLast()
		}

		peek() -> Optional<Item> {
			<- @::lastItem()
		}
	}

	§ Editing a document, remembering every state it passes through.
	variable history: List<String> = []

	history = history::push("Hello")
	history = history::push("Hello, World")
	history = history::push("Hello, World!")

	Terminal.inspect(history::peek()) § Optional#Value("Hello, World!")

	§ Undo is a pop.
	history = history::pop()

	Terminal.inspect(history::peek()) § Optional#Value("Hello, World")
	Terminal.inspect(history::length()) § 2

	§ The same Namespace, bound to a different Item by a different receiver.
	constant moves: List<Integer> = []

	Terminal.inspect(moves::push(4)::push(2)::pop()::peek()) § Optional#Value(4)

	§ A generic Function stands alone, and infers several Type Parameters at
	§ once — `First` and `Second` bind from the two Arguments, and the Record
	§ Type of the answer is built from both.
	function paired<infer First, infer Second>(
		_ first: First,
		with second: Second,
	) -> { first: First, second: Second } {
		<- { first = first, second = second }
	}

	Terminal.inspect(paired(1, with "one")) § { first = 1, second = "one" }
	Terminal.inspect(
		paired("half", with 1/2),
	) § { first = "half", second = 1/2 }
}
