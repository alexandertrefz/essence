import {
	from "./Ping.es" { stepped }
}

implementation {

	constant STEP = 2

	Terminal.inspect(stepped(0)::toString())
}

export {
	STEP
}
