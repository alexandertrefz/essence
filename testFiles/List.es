implementation {

	constant Tao = 710/113
	variable list: [Fraction] = []
	variable myFraction = list::append(Tao)::first()

	list = list::append(1/1)
	list = list::append(contentsOf [1/1])

	__print(list)

}