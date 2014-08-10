namespace Test
	variable1: 1
	variable2: "Test"

	class TestClass
		@instanceField: 1
		@instanceMethod: func (arg1, arg2)
			return arg1 + arg2
		@instanceMethod2: func (arg1, arg2)
			if arg1? and arg2?
				return arg1 + arg2
			return 0

		@instanceMethod2: func (arg1, arg2) return arg1 + arg2

		staticField: 1
		staticMethod: func (arg1, arg2)
			if arg1 == arg2
				global.variable = null

	variable3: variable1


test = new Test.TestClass()
test.instanceMethod()

Test.TestClass.staticMethod()

x = 1
++x
