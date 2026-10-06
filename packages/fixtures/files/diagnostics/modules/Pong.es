import {
	from "./Ping.es" {
		START
		stepped
	}
}

implementation {

	function started() -> Integer {
		<- stepped(START)
	}

	constant STEP = 2

	Terminal.inspect(started()::toString())
}

export {
	STEP
}
