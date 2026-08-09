import {
	halved from "./B.es"
}

implementation {

	§ A cycle is allowed for everything that hoists: `halved` is in scope here
	§ although `B.es` takes `Amount` and `doubled` straight back.
	type Amount = { cents: Integer }

	§ A Pattern stands where the Parameter's internal name goes, so the body
	§ names the field it wants and the signature says nothing new — the Type
	§ it takes apart is the imported `Amount` either way.
	function doubled(_ { cents }: Amount) -> Amount {
		<- { cents = cents::multiply(with 2) }
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
