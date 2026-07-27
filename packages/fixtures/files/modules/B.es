import {
	Amount  from "./A.es"
	doubled from "./A.es"
}

implementation {

	function halved(_ amount: Amount) -> Amount {
		<- { cents = amount.cents::divide(by 2)::otherwise(0/1)::truncate() }
	}

	function quadrupled(_ amount: Amount) -> Amount {
		<- doubled(doubled(amount))
	}
}

export {
	halved
	quadrupled
}
