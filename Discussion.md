# Next Discussion

## Topics
- should structural typing accept `{ x: Number, y: Number }` to match `{ x: Number }` or should this require an opt-in like `Type extends { x: Number }`
	- this would also allow for the correct return type to be declared
```
function filterSpecific(_ list: List<{ num: Number }>, _ callback: (_ item: { num: Number }) -> Boolean) -> List<{ num: Number }>
function filterGeneric<Item extends { num: Number }>(_ list: List<Item>, _ callback: (_ item: Item) -> Boolean) -> List<Item>

constant list = [ { num = 1, str = "" }, { num = 3, str = "" } ]
function filterCallback(item: { num: Number }) -> Boolean { <- item.num::isLessThan(2) }

§ Should the user be forced to map to the limited type, first?

§ returns [{ num = 1 }]
filterSpecific(list::map((item) -> { num: Number } { <- { num: item.num } }), filterCallback)

§ returns [{ num = 1 }] per the types, but in reality [{ num = 1, str = "" }]
filterSpecific(list, filterCallback)

§ returns [{ num = 1, str = "" }]
filterGeneric(list, filterCallback)
```

- Generics
	- `Type extends {}`
- type-label: `Record<{ x: Type }>` vs `{ x: Type }`
- `type Anything = Nothing | Boolean | String | Integer | Fraction | Record | List<Anything>`
- `enum Theme { Dark, Light, System }` vs `type Theme = Dark | Light | System`
- [RE: Match Syntax](https://elm-lang.org/docs/syntax)
- Should `match` allow control flow/should we have a control flow version of it?
	- ie: if typeOf(x)::is(Types.String) { foo } with the appropriate compiler narrowing afterwards


# Discussion 31.07.2024

## Topics
- should Record::is/Record::isNot always match a subset?
	- probably, yes
- should Lists allow holes?
	- No. If holes are required, make them explicit with Maybe<Type>
- should FunctionLiterals be able to infer their parameter & return types, when passed into a known context?
	- Probably no, further investigation required
- new Namespaces

# Discussion 14.03.2024 & 15.03.2024

## Topics

- Loops and ::map
	- support for Ranges?
- Pattern Matching
	- what patterns should be supported?
		- should list subsetting work?
	- how should `isSubsetOf` work in detail?
	- support for guards?
- Imports & Exports
- Enums
- Ports
- List vs Array?

## Results
- List is better than Array, feels higher level
- Ranges are cool but not useful enough to warrant addition
- Loops are in
- match guards are in
- reverse import notation should be good, less important with Language Server (autoimport)