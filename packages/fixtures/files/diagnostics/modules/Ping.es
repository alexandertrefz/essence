import {
	from "./Pong.es" { STEP }
}

implementation {

	function stepped(_ value: Integer) -> Integer {
		<- value::add(STEP)
	}

	constant START = 1

	Terminal.inspect(stepped(START)::toString())
}

export {
	START
	stepped
}
