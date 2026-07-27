import {
	STEP from "./Pong.es"
}

implementation {

	function stepped(_ value: Integer) -> Integer {
		<- value::add(STEP)
	}

	__print(stepped(1)::toString())
}

export {
	stepped
}
