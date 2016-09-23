type String {
	join (self Self, other String) -> String {
		return __String.join(self, other)
	}

	contains (self Self, other String) -> Bool {
		return __String.contains(self, other)
	}

	equals (self Self, other String) -> Bool {
		return __String.equals(self, other)
	}
}
