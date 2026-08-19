§ Deliberately broken: member paths written where the position names no
§ Function of one Parameter for them to stand for, and paths whose steps read
§ off something that has no members to read.

implementation {
	type Maker = { town: String }
	type Product = {
		name: String,
		price: Integer,
		maker: Maker,
		tags: List<String>,
		nickname: Optional<String>,
	}

	constant products: List<Product> = []

	§ A path standing on its own, with nothing to read the member off.
	constant price = .price

	§ The same, one step further in: a Constant whose annotation is a Type, not
	§ a Function of one Parameter.
	constant name: String = .name

	§ A Function of TWO Parameters names no single Argument to read off.
	constant order: (_: Product, _: Product) -> Ordering = .price

	§ A step read off a List, which is decided before it is read.
	constant tagCounts = products::map(.tags.length)

	§ And off an Optional, which is a Choice and asks for a Match.
	constant nicknames = products::map(.nickname.length)
}
