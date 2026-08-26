implementation {

	§ A decimal is a second way of WRITING a Rational, not a Type of its own.
	§ `0.75` and `3/4` are one value, so they compare equal — and `inspect`
	§ shows what a Rational is rather than how it was written.
	Terminal.inspect(0.75::is(3/4)) § true
	Terminal.inspect(19.99) § 1999/100

	§ The decimal form is asked for by name, and it reads back the way it was
	§ written.
	Terminal.inspect(19.99::toString(as #Decimal)) § "19.99"

	§ Nothing here is a floating point number, so two tenths and one tenth are
	§ three tenths exactly — the arithmetic every binary float gets wrong.
	Terminal.inspect(0.1::add(0.2)::is(0.3)) § true

	§ No scale is kept: a Rational has no memory of the digits it was written
	§ with, so a trailing zero changes nothing at all.
	Terminal.inspect(1.50::is(1.5)) § true

	§ `2.0` is a Rational the way `4/2` is one, and a whole Rational prints its
	§ numerator alone — so the spelling that looks like a float still prints a
	§ whole number.
	Terminal.inspect(2.0::toString()) § "2"

	§ A decimal is an ordinary Rational everywhere else too: it takes the
	§ Methods of the numeric tower, and mixes with Integers and fractions in
	§ one List.
	Terminal.inspect(-0.5::absolute()) § 1/2
	Terminal.inspect([1, 0.5, 0.5]::sum()) § 2 — a whole mixed sum is an Integer
}
