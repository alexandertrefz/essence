type String {
	join (self Self, other String) -> String {
		<- __String.join(self, other)
	}

	contains (self Self, other String) -> Bool {
		<- __String.contains(self, other)
	}

	equals (self Self, other String) -> Bool {
		<- __String.equals(self, other)
	}
}
