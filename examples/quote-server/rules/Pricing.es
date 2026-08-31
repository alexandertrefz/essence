import {
	Catalog from "./Catalog.es"
	Money   from "./Money.es"
}

implementation {

	§ Where an order ships to. A Choice with no payloads crosses to
	§ JavaScript as the bare Case name — the JSON a client sends says
	§ `"zone": "Europe"` and that string IS this value, in both directions.
	choice Zone {
		Domestic,
		Europe,
		Overseas,
	}

	§ What a client sends. `coupon` is Optional: a request without the key,
	§ or with `undefined`, is `#Empty` on this side, and no other reading of
	§ "no coupon" exists to be confused with it.
	type Line = { sku: String, quantity: Integer }

	type Order = { lines: List<Line>, zone: Zone, coupon: Optional<String> }

	§ Everything that can be wrong with an order — each with what a client
	§ needs to fix it, rather than a message.
	choice Problem {
		UnknownSku { sku: String },
		OutOfStock { sku: String, requested: Integer, available: Integer },
		NotPositive { sku: String, quantity: Integer },
		UnknownCoupon { code: String },
		EmptyOrder,
	}

	type PricedLine = {
		sku: String,
		name: String,
		quantity: Integer,
		unitPrice: Integer,
		total: Integer,
	}

	§ The answer: either a price with everything that went into it, or the
	§ list of problems — never a price with a warning attached. On the
	§ JavaScript side these are `{ $case: "Quote#Priced", … }` and
	§ `{ $case: "Quote#Rejected", problems: [ … ] }`.
	choice Quote {
		Priced {
			lines: List<PricedLine>,
			subtotal: Integer,
			discount: Integer,
			shipping: Integer,
			tax: Integer,
			total: Integer,
			display: String,
		},
		Rejected { problems: List<Problem> },
	}

	§ A line is checked once and comes back as one of two things: priced,
	§ with the weight shipping will need, or wrong, with why. The order is
	§ then two folds over these — one collecting the problems, one the prices
	§ — and neither ever meets a line the other Case describes.
	§
	§ The line is taken apart at the Parameter and the product at the Match,
	§ so every payload below is written in the names it was handed.
	type FineLine = { line: PricedLine, weightGrams: Integer }

	choice CheckedLine {
		Fine { line: PricedLine, weightGrams: Integer },
		Wrong { problem: Problem },
	}

	function checked(_ { sku, quantity }: Line) -> CheckedLine {
		<- match Catalog.find(sku) -> CheckedLine {
			case #Value({ name, unitPrice, weightGrams, stock }) {
				if quantity::isLessThanOrEqualTo(0) {
					<- #Wrong(#NotPositive({ sku, quantity }))
				}

				if quantity::isGreaterThan(stock) {
					<- #Wrong(
						#OutOfStock({
							sku,
							requested = quantity,
							available = stock,
						})
					)
				}

				<- #Fine({
					line = {
						sku,
						name,
						quantity,
						unitPrice,
						total = unitPrice::multiply(with quantity),
					},
					weightGrams = weightGrams::multiply(with quantity),
				})
			}
			case #Empty { <- #Wrong(#UnknownSku({ sku })) }
		}
	}

	§ The rates. Every one is a Rational and every sum over them is exact;
	§ `Money.percent` is where a rate meets cents and rounds, once.
	constant taxRate = 19/100

	§ Volume discount by items in the order.
	function volumeRate(items: Integer) -> Rational {
		<- define {
			as 10/100 if items::isGreaterThanOrEqualTo(25)
			as 5/100  if items::isGreaterThanOrEqualTo(10)
			as 0/1    otherwise
		}
	}

	§ A coupon is a String from the outside world; the codes the shop honours
	§ are matched by value, and anything else is empty. Match on a String
	§ takes the VALUE apart, so no table has to be searched.
	function couponRate(_ code: String) -> Optional<Rational> {
		<- match code -> Optional<Rational> {
			case "WELCOME10" { <- #Value(10/100) }
			case "FRIENDS15" { <- #Value(15/100) }
			case String      { <- #Empty }
		}
	}

	§ Shipping: a base charge for the zone, plus a charge for every 500 g
	§ started beyond the first, and free at home for a large enough basket.
	function shipping(
		to zone: Zone,
		weighing grams: Integer,
		onGoodsWorth goods: Integer,
	) -> Integer {
		constant extraSteps = grams
			::subtract(1)
			::quotient(dividingBy 500)
			::clamp(between 0, and 1_000)

		<- match zone -> Integer {
			case #Domestic {
				if goods::isGreaterThanOrEqualTo(5_000) {
					<- 0
				}

				<- 490::add(extraSteps::multiply(with 150))
			}
			case #Europe   { <- 990::add(extraSteps::multiply(with 350)) }
			case #Overseas { <- 2_490::add(extraSteps::multiply(with 900)) }
		}
	}

	§§ The price of an order, or every reason it has none.
	function quote(_ order: Order) -> Quote {
		constant checks = order.lines::map(checked)

		constant problems: List<Problem> = checks
			::map((check) {
				<- match check -> Optional<Problem> {
					case #Wrong({ problem }) { <- #Value(problem) }
					case #Fine               { <- #Empty }
				}
			})
			::values()

		constant couponProblems = match order.coupon -> List<Problem> {
			case #Value(code) {
				<- match couponRate(code) -> List<Problem> {
					case #Value { <- [] }
					case #Empty { <- [#UnknownCoupon({ code })] }
				}
			}
			case #Empty { <- [] }
		}

		constant everyProblem = problems::append(contentsOf couponProblems)

		if order.lines::isEmpty() {
			<- #Rejected({ problems = everyProblem::append(#EmptyOrder) })
		}

		if everyProblem::hasItems() {
			<- #Rejected({ problems = everyProblem })
		}

		constant fine: List<FineLine> = checks
			::map((check) {
				<- match check -> Optional<FineLine> {
					case #Fine({ line, weightGrams }) {
						<- #Value({ line, weightGrams })
					}
					case #Wrong                       { <- #Empty }
				}
			})
			::values()

		constant lines    = fine::map(.line)
		constant subtotal = lines::sum(on .total)
		constant items    = lines::sum(on .quantity)
		constant grams    = fine::sum(on .weightGrams)

		§ Two rates add exactly — 5/100 and 15/100 are 1/5, not 0.2 twice
		§ rounded — and meet the cents once, in `percent`. `andThen` runs the
		§ lookup on a coupon that is there and hands an absent one through.
		constant coupon   = order.coupon
			::andThen(couponRate)
			::value(defaultingTo 0/1)
		constant rate     = volumeRate(items items)::add(coupon)
		constant discount = subtotal::percent(rate)
		constant goods    = subtotal::subtract(discount)
		constant carriage = shipping(
			to order.zone,
			weighing grams,
			onGoodsWorth goods,
		)
		constant tax      = goods::add(carriage)::percent(taxRate)
		constant total    = goods::add(carriage)::add(tax)

		<- #Priced({
			lines,
			subtotal,
			discount,
			shipping = carriage,
			tax,
			total,
			display = total::formatted(),
		})
	}
}

export {
	Line
	Order
	Problem
	Quote
	Zone
	quote
	Product from "./Catalog.es"
	catalog from "./Catalog.es"
}

tests {

	§ The order the README prices, as a value rather than as JSON — the rules
	§ are what is under test here, and the boundary is the server's own spec.
	constant order: Order = {
		lines = [
			{ sku = "BEAN-1KG", quantity = 2 },
			{ sku = "MUG-01", quantity = 1 },
		],
		zone = #Europe,
		coupon = #Value("WELCOME10"),
	}

	suite "quote" {
		test "prices an order exactly, cent by cent" {
			require #Priced({ subtotal, discount, shipping, tax, total, display }) = quote(
				order,
			)

			expect subtotal::is(7_780)
			expect discount::is(778)
			expect shipping::is(2_740)
			expect tax::is(1_851)
			expect total::is(11_593)
			expect display::is("€115.93")
		}

		test "keeps a line for every line it was given" {
			require #Priced({ lines }) = quote(order)

			expect lines::map(.sku)::is(["BEAN-1KG", "MUG-01"])
			expect lines::sum(on .quantity)::is(3)
		}

		§ Never a price with a warning attached: an order with anything wrong
		§ with it comes back as every reason at once.
		test "names every problem an order has, in the order they were found" {
			require #Rejected({ problems }) = quote({
				lines = [
					{ sku = "SCALE-01", quantity = 1 },
					{ sku = "NOPE", quantity = 1 },
				],
				zone = #Domestic,
				coupon = #Value("FREE"),
			})

			expect problems::is([
				#OutOfStock({ sku = "SCALE-01", requested = 1, available = 0 }),
				#UnknownSku({ sku = "NOPE" }),
				#UnknownCoupon({ code = "FREE" }),
			])
		}

		test "refuses an order with no lines in it" {
			require #Rejected({ problems }) = quote({
				lines = [],
				zone = #Domestic,
				coupon = Optional<String>#Empty,
			})

			expect problems::is([#EmptyOrder])
		}

		test "refuses a quantity that is not positive" {
			require #Rejected({ problems }) = quote({
				lines = [{ sku = "BEAN-250", quantity = 0 }],
				zone = #Domestic,
				coupon = Optional<String>#Empty,
			})

			expect problems::is([
				#NotPositive({ sku = "BEAN-250", quantity = 0 }),
			])
		}
	}

	§ Two rates add exactly — 5/100 and 15/100 are 1/5, not 0.2 twice rounded
	§ — so the rates themselves are Rationals and are tested as Rationals.
	suite "the rates" {
		test "gives no volume discount under ten items" {
			expect volumeRate(items 9)::is(0/1)
		}

		test "gives five percent from ten items" {
			expect volumeRate(items 10)::is(5/100)
		}

		test "gives ten percent from twenty-five items" {
			expect volumeRate(items 25)::is(10/100)
		}

		test "honours the coupons the shop knows and no others" {
			expect couponRate("WELCOME10")::is(#Value(10/100))
			expect couponRate("FRIENDS15")::is(#Value(15/100))
			expect couponRate("FREE")::is(#Empty)
		}
	}

	suite "shipping" {
		test "is free at home on a large enough basket" {
			expect shipping(to #Domestic, weighing 400, onGoodsWorth 5_000)::is(
				0,
			)
		}

		test "charges the base rate at home under that" {
			expect shipping(to #Domestic, weighing 400, onGoodsWorth 4_999)::is(
				490,
			)
		}

		test "charges for every started 500 g beyond the first" {
			expect shipping(to #Europe, weighing 500, onGoodsWorth 100)::is(990)
			expect shipping(to #Europe, weighing 501, onGoodsWorth 100)::is(
				1_340,
			)
			expect shipping(to #Europe, weighing 1_001, onGoodsWorth 100)::is(
				1_690,
			)
		}

		test "charges overseas more than it charges Europe" tagged slow {
			expect shipping(
				to #Overseas,
				weighing 500,
				onGoodsWorth 100,
			)::isGreaterThan(
				shipping(to #Europe, weighing 500, onGoodsWorth 100),
			)
		}
	}

	suite "a checked line" {
		test "prices a line the shop can fill, with its shipping weight" {
			require #Fine({ line, weightGrams }) = checked({
				sku = "BEAN-250",
				quantity = 2,
			})

			expect line.total::is(1_790)
			expect weightGrams::is(560)
		}

		test "refuses more than the shop has" {
			require #Wrong({ problem }) = checked({
				sku = "GRND-01",
				quantity = 4,
			})

			expect problem::is(
				#OutOfStock({ sku = "GRND-01", requested = 4, available = 3 }),
			)
		}
	}
}
