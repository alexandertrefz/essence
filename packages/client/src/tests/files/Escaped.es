§ A Module whose export names JavaScript can not spell verbatim, and one that
§ looks like the bridge's own. `ok?` is emitted as `$user_ok_3f_`, and
§ `$$integer` is emitted untouched — `$` is an ordinary Essence identifier
§ character, which is why the bridge's own names carry a `_` instead.

implementation {

	constant $$integer = 12

	function ok?(_ value: Boolean) -> Boolean {
		<- value
	}
}

export {
	$$integer
	ok?
}
