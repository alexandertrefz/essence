§ Deliberately broken: member paths written where the position names no
§ Function of one Parameter for them to stand for.

implementation {
	type Product = { name: String, price: Integer }

	§ A path standing on its own, with nothing to read the member off.
	constant price = .price

	§ The same, one step further in: a Constant whose annotation is a Type, not
	§ a Function of one Parameter.
	constant name: String = .name

	§ A Function of TWO Parameters names no single Argument to read off.
	constant order: (_: Product, _: Product) -> Ordering = .price
}
