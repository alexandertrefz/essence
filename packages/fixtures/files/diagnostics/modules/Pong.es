import {
	stepped from "./Ping.es"
}

implementation {

	constant STEP = 2

	Terminal.inspect(stepped(0)::toString())
}

export {
	STEP
}
