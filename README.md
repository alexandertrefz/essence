# Disclaimer
NOTHING HERE IS FINAL OR STABLE
DO NOT USE THIS LANGUAGE
Everything about this repo is in constant flux.
Everything can and will change.
If you want to participate please head over to the issues section.
Any feedback or help is very much appreciated!

# Goals
The main goal for this language is to allow the rapid prototyping development of dynamically and weakly typed languages like ECMAScript,
while allowing to upgrade the prototype to a proper program with the safety and performance of static and strongly typed languages like C#.
Its main purpose lies in the space of Applications. It is not suited for Systems or Games development, since it will be garbage collected.
The lack of control over the memory will make is not suited for those low level, performance oriented tasks.

# Features

## v0.1 Main Goal: Getting of the ground | Timeline: 2015
* Modules
* Interfaces
  * with implicit Interface satisfaction
* Classes
* Unified, Static and Dynamic Structural Typing
* Named Parameters // Maybe enforced?
* method Overloading
  * Optional Parameters ? // maybe 0-initialized values like Go?
* First class functions
* Built-in Types
  * Array // Size and type limited at initialization
  * List // dynamic size
  * Tuple // immutable ?
  * Named Tuple // immutable ?
* Generics
* Blocks ? // maybe v2, maybe remove alltogether -> issues with first class block semantics(return outer function/block after being passed)
* overloadable Literals?

## v0.2 Main Goal: Performance improvements, Bug Fixes | Timeline: summer 2015
* much faster Compiler + Runtime based on asm.js
* APIs for external languages for improved performance? // C, for example

## v1 Main Goal: Stability | Timeline: unknown, depends on usage
* Unit Tests for all parts
* Proper Specification
