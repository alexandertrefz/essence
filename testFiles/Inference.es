implementation {

	constant numbers = [1, 2, 3, 4]

	§ A Function literal passed as an Argument may leave its annotations out —
	§ the parameter it is passed to says what they are.
	__print(numbers::removeEvery(where (item) { <- item::isGreaterThan(2) }))

	§ An unannotated Parameter takes its label from the expected Type too, so
	§ these two spellings mean exactly the same thing. Neither has to know that
	§ `removeEvery`'s callback is labelless.
	__print(numbers::removeEvery(where (_ item) { <- item::isGreaterThan(2) }))

	§ Annotations are still accepted, and still win where they are written.
	__print(numbers::removeEvery(where (item) -> Boolean {
		<- item::isGreaterThan(2)
	}))

	__print(numbers::removeEvery(where (_ item: Integer) -> Boolean {
		<- item::isGreaterThan(2)
	}))

	§ The inferred Type reaches the body: `item` is an Integer here, which is
	§ the only reason `toString` resolves at all.
	constant withoutTwo = numbers::removeEvery(where (item) {
		<- item::toString()::is("2")
	})

	__print(withoutTwo)

	namespace Mapper<infer Item> for List<Item> {
		transformFirst<infer Target>(
			_ transform: (_ item: Item) -> Target,
			fallback fallbackValue: Target,
		) -> Target {
			<- match @::firstItem() -> Target {
				case Nothing { <- fallbackValue }
				case Item { <- transform(@) }
			}
		}
	}

	§ `Item` is bound by the receiver, which types the Parameter. `Target` is
	§ bound by nothing but this literal's own body — so the body is what it is
	§ read off, and it decides the Type of the whole invocation.
	__print(numbers::transformFirst((item) { <- item::toString() }, fallback "none"))

	§ The same call with a body returning a Boolean binds `Target` to Boolean.
	__print(numbers::transformFirst((item) { <- item::isGreaterThan(0) }, fallback false))

	§ A literal that is not an Argument has no expected signature at all, but
	§ its Parameters are written — so only the return Type has to be inferred.
	constant halve = (_ value: Integer) { <- value::divideBy(2) }

	__print(halve(9))

	§ Several `<-` Statements give the Union of what they return.
	constant doubleIfPositive = (_ value: Integer) {
		if value::isGreaterThan(0) { <- value::multiplyWith(2) }

		<- nothing
	}

	__print(doubleIfPositive(5))
	__print(doubleIfPositive(0))

}
