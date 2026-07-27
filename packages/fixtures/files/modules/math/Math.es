implementation {

	constant PI = 314/100

	function squared(_ value: Integer) -> Integer {
		<- value::multiply(with value)
	}
}

export {
	PI
	squared as square
}
