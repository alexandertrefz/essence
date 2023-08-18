implementation {
	
	namespace AlternativeNumber {

		static TAO = 710/113
		static PI  = 355/113
		
		overload static lowestNumber(_ fractionA: Fraction, _ fractionB: Fraction) -> Fraction {
			<- 0/0
		}

		overload static lowestNumber(_ fraction: Fraction, _ integer: Integer) -> Fraction | Integer {
			<- 0/0
		}

		overload static lowestNumber(_ integer: Integer, _ fraction: Fraction) -> Integer | Fraction {
			<- 0/0
		}

		overload static lowestNumber(_ fractions: [Fraction]) -> Fraction {
			<- 0/0
		}
		
		overload static lowestNumber(_ integer: [Integer]) -> Integer {
			<- 0
		}
		
		overload static lowestNumber(_ numbers: [Fraction | Integer]) -> Fraction | Integer {
			<- 0/0
		}

	}

	constant PI = AlternativeNumber.PI
	
}