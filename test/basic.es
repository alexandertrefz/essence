interface INumber {
	__add__:      func (arg2:INumber) -> INumber {}
	__subtract__: func (arg2:INumber) -> INumber {}
	__divide__:   func (arg2:INumber) -> INumber {}
	__multiply__: func (arg2:INumber) -> INumber {}
	__modulo__:   func (arg2:INumber) -> INumber {}
}

class A {
	constructor: func (public prop:Any) {

	}

	method: func () {

	}
}

class B extends A {
	constructor: func (public prop:Any, public prop2:Any) {
		super(prop)
	}

	method: func (arg1) {
		super()

	}

	method1: func (arg1, arg2) {
		return arg1 + arg2
	}

	method2: func (arg1, arg2) -> INumber {
		if arg1.satisfies(INumber) and arg2.satisfies(INumber) {
			return arg1 + arg2
		}

		return 0
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
