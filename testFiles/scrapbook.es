(1 + 3) * 4
1 > add 3 > multiply 4 § 'left handed' piping
multiply(add(1, 3), 4) § classical pure functional way

1::add(3)::multiply(4) § 'struct methods'
(let ___var1 = Number.add(1, 3), Number.multiply(___var1, 4)) § unfolded from 'struct methods' syntax sugar
(Number.multiply(Number.add(1, 3), 4)) $ repacked, after optimizer step, to optimize variable away

§ declare that this file is a requireable package, must be first non-comment token
package 'OHAI'

§ imports and exports, modelled after ES6 which does them right
import 'sys' as sys

§ types, non-inheritable,
type Greeter
	name String
	age  Number

	greet () -> String
		return 'Hello, ' + self.name
	end
end



let anotherPerson Person § anotherPerson = undef = Person { name = undef } = Person { name = '' }

