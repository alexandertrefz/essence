type Bool {
	negate(self Self) -> Bool {
		<- __Bool.negate(self)
	}

	equals(self Self, other Bool) -> Bool {
		<- __Bool.equals(self, other)
	}
}
