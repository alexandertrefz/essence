type String {
	join (self Self, other String) -> String {
		return @@String.join(self, other)
	}

	contains (self Self, other String) -> Bool {
		return @@String.contains(self, other)
	}

	equals (self Self, other String) -> Bool {
		return @@String.equals(self, other)
	}
}
