let print = (message String) -> String {
	<- __print(message)
}

let greet = (greetee String) -> String {
	let message = String.join('Hello, ', greetee)

	if (String.equals(greetee, '')) {
		<- print('Greetee can not be empty!')
	} else if (String.equals(greetee, 'Universe')) {
		message = String.join(message, '!')
	} else {
		message = String.join(message, '.')
	}

	<- print(message)
}

greet('')
greet('Universe')
