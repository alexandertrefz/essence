type String {
	join (self Self, other String) -> String {
		return @@String.join(self, other)
	}

	equals (self Self, other String) -> Bool {
		return @@String.equals(self, other)
	}
}
