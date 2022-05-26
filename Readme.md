![Codeship](https://img.shields.io/codeship/a25dea30-b777-0135-b641-2e2e62b24312/master.svg?style=for-the-badge)
![Codecov](https://img.shields.io/codecov/c/github/alexandertrefz/essence/master.svg?style=for-the-badge)

# Goals
The main goal for this language is to allow the authoring of bug-free maintainable code, in a fast and pleasant manner.
Essence features a strong typing system combined with a mixture of functional and object oriented concepts, enabling understandable & maintainable code.

Its syntax and features are designed with modern IDE's in mind, allowing for great code completion & inline documentation features.

Essence compiles to modern ECMAScript versions, allowing execution in both Node.js as well as Browsers.

# The Essence
* Explicit is better than implicit.
* Extensibility is better than completeness.
* Creating correct code must be enjoyable.
* Prototyping must be fast – thus refactoring must be painless.
* Readability counts.
* There should be one – and preferably only one – obvious way to do it.
* Practicality beats purity.
* Simple is better than complex.
* Complex is better than complicated.
* Beautiful is better than ugly.
* Clever is seldom good.

# Features
* Static Structural Typing
* Algebraic Data Types
* Type Inference
* Modules
* Interfaces
* Generics
* Named Parameters
* Arbitrary Precision Numbers
* Unicode Strings
* First-Class Functions
* Memory Managed
* Compact & Readable Syntax
* All Data is Immutable

# Example Code
You can find the most recent and working example of syntax in the [HelloWorld.es](testFiles/HelloWorld.es)
as well as the other files in [testFiles](testFiles). It also should be noted that the syntax is meant to
be viewed with a font with code ligatures, like FiraCode.

Currently, the only supported output target is JS.

You can compile the testFiles with the `esc` executable in `bin` (after building the project with `yarn && yarn build`). This will create a .js file with the same name in the same directory. These files can be executed via node or in a browser.

The current runtime implementation is rudimentary however:

- Strings are UTF-16 rather than UTF-8
- There are generally very few methods implemented yet
- Fractions are not implemented yet

# Disclaimer
This language is still a work in progress. It is not ready for use yet and there is no documentation as most things are in flux. Generally: Here be dragons!
