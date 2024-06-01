implementation {

	for item of [0, 1, 2, 3] {
		__print(item)
	}

	for item, index of [0, 1, 2, 3] {
		§ __print("{index}, {item}")
		__print(index)
		__print(item)
	}

	[0, 1, 2, 3]::map((value) -> String {
		<- @::toString()
	})

}