import {
	from "./Pong.es" { STEP }
}

implementation {

	function stepped(_ value: Integer) -> Integer {
		<- value::add(STEP)
	}

	Terminal.inspect(stepped(1)::toString())
}

export {
	stepped
}
