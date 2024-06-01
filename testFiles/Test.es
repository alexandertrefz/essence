implementation {
	variable array = ["A", "B", "C", "D", "A"]

	__print(array::contains("A"))    § true
	__print(array::contains("a"))    § false
	__print(array::firstItem())      § "A"
	__print(array::removeAt(2))      § ["A", "B", "D", "A"]
	__print(array::removeFirst())    § ["B", "C", "D", "A"]
	__print(array::removeFirst(3))   § ["D", "A"]
	__print(array::removeEvery("A")) § ["B", "C", "D"]

	__print({}::is({})) § true
	__print({ a = 1 }::isNot({})) § true

	§ constant testPort = Port.open("test")
	
	§ testPort::sendMessage("Message from Essence")
	§ testPort::onMessage((message) -> {})

}