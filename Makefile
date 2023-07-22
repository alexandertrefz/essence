JEST     := ./node_modules/.bin/jest
NEARLEYC := ./node_modules/.bin/nearleyc

src/parser/grammar.ts: src/parser/grammar.ne
	$(NEARLEYC) $< -o $@

all: build

compile-grammar: src/parser/grammar.ts

build: compile-grammar

test: compile-grammar |
	@clear
	@$(JEST)

update-snapshot: compile-grammar |
	@clear
	@$(JEST) --updateSnapshot

ci-test: compile-grammar |
	@clear
	@$(JEST) --ci

watch:
	@clear
	watchman-make -p 'src/parser/grammar.ne' -t build

clean:
	- rm src/parser/grammar.ts
	- rm testFiles/*.js
