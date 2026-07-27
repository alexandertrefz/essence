import {
	halved from "./B.es"
}

implementation {

	§ A cycle is allowed for everything that hoists: `halved` is in scope here
	§ although `B.es` takes `Amount` and `doubled` straight back.
	type Amount = { cents: Integer }

	function doubled(_ amount: Amount) -> Amount {
		<- { cents = amount.cents::multiply(with 2) }
	}

	function averaged(_ amount: Amount) -> Amount {
		<- halved(doubled(amount))
	}
}

export {
	Amount
	averaged
	doubled
}
