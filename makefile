# build output dirs
JS_BUILD_DIR = lib

# sources
TYPESCRIPT_SRC = $(shell find src -name '*.ts')

#targets
JS = $(patsubst src/%.ts, $(JS_BUILD_DIR)/%.js, $(TYPESCRIPT_SRC))

TSC := ./node_modules/.bin/tsc
TSC_ARGS := -t es6 -m commonjs --strictNullChecks --pretty --experimentalDecorators --outDir $(JS_BUILD_DIR)/

MOCHA := ./node_modules/.bin/mocha
MOCHA_ARGS = --ui tdd --growl --reporter spec

all: build

build: $(JS)

$(JS_BUILD_DIR)/%.js: src/%.ts
	- $(TSC) $(TSC_ARGS) $<

$(JS_BUILD_DIR)/tests/%.js: src/tests/%.ts
	- $(TSC) $(TSC_ARGS) $<

test: build |
	@clear
	@$(MOCHA) $(MOCHA_ARGS) $(JS_BUILD_DIR)/tests/*.js

watch:
	@clear
	watchman-make -p 'src/*.ts' 'src/tests/*.ts' -t build

dev:
	@clear
	watchman-make -p 'src/*.ts' 'src/tests/*.ts' -t test

clean:
	rm -rf $(JS_BUILD_DIR)

