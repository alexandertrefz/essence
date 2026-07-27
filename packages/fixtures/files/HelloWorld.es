implementation {

	function greet(_ greetee: String) -> String {
		variable message = "Hello, {greetee}"

		if greetee::isEmpty() {
			message = "Greetee can not be empty!"
		} else if greetee::is("Universe") {
			message = "{message}!"
		} else {
			message = "{message}."
		}

		<- __print(message)
	}

	greet("")
	greet("World")
	greet("Universe")
}
