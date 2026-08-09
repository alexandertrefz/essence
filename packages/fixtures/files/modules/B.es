import {
	Amount  from "./A.es"
	doubled from "./A.es"
}

implementation {

	function halved(_ { cents }: Amount) -> Amount {
		<- { cents = cents::divide(by 2)::round(toward #TowardZero) }
	}

	function quadrupled(_ amount: Amount) -> Amount {
		<- doubled(doubled(amount))
	}
}

export {
	halved
	quadrupled
}
