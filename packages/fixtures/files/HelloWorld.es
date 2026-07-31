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

		<- message
	}

	Terminal.print(greet(""))
	Terminal.print(greet("World"))
	Terminal.print(greet("Universe"))
}
