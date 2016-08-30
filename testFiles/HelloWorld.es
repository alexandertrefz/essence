let print Function = (message String) -> String {
	return @@print(message)
}

let greet Function = (greetee String) -> String {
	let message String = String.join('Hello, ', greetee)

	if String.equals(greetee, '') {
		return print('Greetee can not be empty!')
	} else if String.equals(greetee, 'Universe') {
		message = String.join(message, '!')
	} else {
		message = String.join(message, '.')
	}

	return print(message)
}

greet('')
greet('Universe')
