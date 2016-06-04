() -> Any
end

() -> Nothing
	NaughtySideEffect()
end

() -> Any
	return 'Hello, ' + self.name
end
