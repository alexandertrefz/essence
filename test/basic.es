interface INumber {
	__add__:      func (arg1:INumber) -> INumber {}
	__subtract__: func (arg1:INumber) -> INumber {}
	__divide__:   func (arg1:INumber) -> INumber {}
	__multiply__: func (arg1:INumber) -> INumber {}
	__modulo__:   func (arg1:INumber) -> INumber {}
}

class A {
	constructor: func (prop:Type) {

	}

	method: func () {

	}
}

class B extends A {
	constructor: func (prop, prop2:Any) {
		super(prop)
	}

	method: func (arg1) {
		super()

		innerFunc = func () {}

	}

	method1: func (arg1, arg2) {
		return arg1 + arg2
	}

	method2: func (arg1, arg2) -> INumber {
		if arg1.satisfies(INumber) and arg2.satisfies(INumber) {
			return arg1 + arg2
		} else if arg1.satisfies(INumber) {
			return arg1
		} else if arg2.satisfies(INumber) {
			return arg2
		} else {
			return 0
		}
	}

	method3: func (arg1:INumber, arg2:INumber) -> INumber { return arg1 + arg2 }

	static field: 1
	static method: func(arg1, arg2) {
		result = false

		if arg1 == arg2 {
			result = true
		}

		return result
	}
}
