function greet (_ greetee: String) -> String {
	variable message = "Hello, "::append(greetee)

	if greetee::isEmpty() {
		message = "Greetee can not be empty!"
	} else if greetee::is("Universe") {
		message = message::append("!")
	} else {
		message = message::append(".")
	}

	<- __print(message)
}

greet("")
greet("World")
greet("Universe")
