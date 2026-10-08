§ The conformer of a Protocol the importing Module declares.

import {
	from "./Walking.es" { Walking }
}

implementation {
	type Walker = { stride: Integer }

	namespace Walkers for Walker is Walking {
		step() -> Integer {
			<- @.stride
		}
	}
}

export {
	Walker
	Walkers
}
