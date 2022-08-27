implementation {

	constant Tao = 710/113
	variable [Fraction] list = []
	variable Fraction myFraction = list::append(Tao)::first()

	list = list::insert(1/1, atIndex 0)
	list = list::insert(contentsOf [1/1], atIndex 1)

	__print(list)

}