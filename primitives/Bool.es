type Bool {
	negate(self Self) -> Bool {
		return __Bool.negate(self)
	}

	equals(self Self, other Bool) -> Bool {
		return __Bool.equals(self, other)
	}
}
