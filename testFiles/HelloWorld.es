let print Function = (message String) -> String {
	return @@print(message)
}

let greet Function = (greetee String) -> String {
	let message String = String.join('Hello, ', greetee)
	let messageEnd String = ''

	if String.equals(greetee, 'Universe') {
		messageEnd = '!'
	} else {
		messageEnd = '.'
	}

	return print(String.join(message, messageEnd))
}

greet('World')
greet('Universe')
