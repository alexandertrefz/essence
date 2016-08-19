let print Function = (message String) -> String
	return @@print(message)
end

let greet Function = (greetee String) -> String
	let message String = String.join('Hello, ', greetee)
	message = String.join(message, '!')
	return print(message)
end

greet('World')
