declarations {

	namespace Nothing for Nothing is Equatable, is Printable {
		§§ Answers whether both values are Nothing — there is only one Nothing, so this is always `true`.
		§§
		§§ @param other the Nothing to compare with
		§§ @returns `true`.
		is(_ other: Nothing) -> Boolean {
			<- true
		}

		§§ Answers whether the values differ — there is only one Nothing, so this is always `false`.
		§§
		§§ @param other the Nothing to compare with
		§§ @returns `false`.
		isNot(_ other: Nothing) -> Boolean {
			<- false
		}

		§§ Represents Nothing as the String `Nothing`.
		§§
		§§ @returns the String `Nothing`.
		toString() -> String {
			<- "Nothing"
		}
	}
}
