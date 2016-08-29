let print Function = (message String) -> String {
	return @@print(message)
}

let greet Function = (greetee String) -> String {
	let message String = ''
	let messageEnd String = ''

	if String.equals(greetee, '') {
		print('Empty?!')
		print('Defaulting to World...')
		greetee = 'World'
	}

	if String.equals(greetee, 'Universe') {
		messageEnd = '!'
	} else {
		messageEnd = '.'
	}

	message = String.join('Hello, ', greetee)

	return print(String.join(message, messageEnd))
}

greet('')
greet('Universe')
