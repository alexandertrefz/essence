implementation {

	§ What the shop sells. A price is cents (see `Money.es`); a weight is
	§ grams, and it is what shipping is charged on.
	type Product = {
		sku: String,
		name: String,
		unitPrice: Integer,
		weightGrams: Integer,
		stock: Integer,
	}

	§ The catalog is a List a JavaScript host reads as an Array of plain
	§ objects — `GET /catalog` in the server is exactly this constant.
	constant catalog: List<Product> = [
		{
			sku = "BEAN-250",
			name = "House blend, 250 g",
			unitPrice = 895,
			weightGrams = 280,
			stock = 120,
		},
		{
			sku = "BEAN-1KG",
			name = "House blend, 1 kg",
			unitPrice = 2990,
			weightGrams = 1050,
			stock = 40,
		},
		{
			sku = "SNGL-250",
			name = "Single origin, 250 g",
			unitPrice = 1250,
			weightGrams = 280,
			stock = 25,
		},
		{
			sku = "FILT-100",
			name = "Paper filters, 100",
			unitPrice = 450,
			weightGrams = 120,
			stock = 300,
		},
		{
			sku = "MUG-01",
			name = "Stoneware mug",
			unitPrice = 1800,
			weightGrams = 420,
			stock = 12,
		},
		{
			sku = "GRND-01",
			name = "Hand grinder",
			unitPrice = 6900,
			weightGrams = 650,
			stock = 3,
		},
		{
			sku = "SCALE-01",
			name = "Pour-over scale",
			unitPrice = 5400,
			weightGrams = 500,
			stock = 0,
		},
	]

	§ The catalog keyed by the SKU, worked out once. `index(on:)` is the
	§ one-to-one crossing from a List to a Dictionary — `group(on:)` is the
	§ one that keeps every item under its key, and a SKU names one product.
	constant bySku = catalog::index(on .sku)

	namespace Catalog {
		§§ The product under a SKU, if the shop sells one.
		static find(_ sku: String) -> Optional<Product> {
			§ One question of the Dictionary, where a walk of the whole List
			§ asked every product whether it was the one.
			<- bySku::value(at sku)
		}
	}
}

export {
	Catalog
	Product
	catalog
}

tests {

	suite "Catalog" {
		test "finds a product under its SKU" {
			require #Value(product) = Catalog.find("MUG-01")

			expect product.name::is("Stoneware mug")
			expect product.unitPrice::is(1800)
		}

		test "answers nothing for a SKU the shop does not sell" {
			expect Catalog.find("NOPE")::is(#Empty)
		}

		§ One walk, holding the SKUs it has met — where counting the catalog's
		§ own SKU for every product in it asked the whole List once per row.
		test "sells every product under a SKU of its own" {
			expect catalog::hasDuplicates(on .sku)::negate()
		}
	}
}
