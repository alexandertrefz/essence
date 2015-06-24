# Goals
The main goal for this language is to allow the rapid prototyping development of dynamically and weakly typed languages like ECMAScript,
while allowing to upgrade the prototype to a proper program with the safety and performance of static and strongly typed languages like C#. It also allows for a unified syntactical interface for blocking and non blocking code – making refactoring painless and easy.

# Contribution
Keep the essence of Essence in mind.
Issues labeled `specification` are meant to hold any discussion surrounding the specific feature in terms of specification and syntax. If there is any question or need for discussion about any specification related topic, create an issue with the label and link it in the feature list down below.

# The essence of Essence
	Extensibility is better than completeness.
	Explicit is better than implicit.
	Creating correct code must be enjoyable.
	Prototyping must be fast – thus refactoring must be painless.
	Readability counts.
	There should be one – and preferably only one – obvious way to do it.
	Practicality beats purity.
	Simple is better than complex.
	Complex is better than complicated.
	Beautiful is better than ugly.
	Clever is seldom good.
	Only type-annotated code is releasable code.

# Features
* Unified, Static and Dynamic Structural Typing
* Modules & Namespaces
* Interfaces | Protocols
	* with implicit Interface satisfaction
* Generics
* Named Parameters
* Method Overloading
	* Optional Parameters
* First class functions
* [Memory Managed?](https://github.com/atrefz/essence/issues/1)
* Built-in Types - could those be implemented in a standard library satisfactory?
	* Array - Size and type limited at initialization
	* List - dynamic size
	* Tuple - immutable ?
	* Named Tuple - immutable ?
