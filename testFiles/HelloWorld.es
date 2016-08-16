let print Function = (message String) -> String
	return @@print(message)
end

let greet Function = (greetee String) -> String
	return print(String.join('Hello, ', greetee))
end

greet('World')
