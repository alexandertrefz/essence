let print Function = (message String) -> String
	return @@print(message)
end

let greet Function = (greetee String) -> String
	let message String = String.join('Hello, ', greetee)
	let messageEnd String = '.'

	if String.equals(greetee, 'Universe') then
		messageEnd = '!'
	end

	return print(String.join(message, messageEnd))
end

greet('World')
greet('Universe')
