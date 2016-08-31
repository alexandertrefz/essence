type String {
	join (self Self, other String) -> String {
		return @@stringJoin(self, other)
	}

	equals (self Self, other String) -> Bool {
		return @@stringEquals(self, other)
	}
}
