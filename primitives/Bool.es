type Bool {
	negate(self Self) -> Bool {
		return @@Bool.negate(self)
	}

	equals(self Self, other Bool) -> Bool {
		return @@Bool.equals(self, other)
	}
}
