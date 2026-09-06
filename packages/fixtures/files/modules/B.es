import {
	from "./A.es" {
		Amount
		doubled
	}
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
