# build output dirs
JS_BUILD_DIR = lib
TESTS_BUILD_DIR = compiledTests

# sources
TYPESCRIPT_SRC = $(shell find src -name '*.ts')
TYPESCRIPT_TESTS = $(shell find tests -name '*.ts')

#targets
JS = $(patsubst src/%.ts, $(JS_BUILD_DIR)/%.js, $(TYPESCRIPT_SRC))
TESTS = $(patsubst tests/%.ts, $(TESTS_BUILD_DIR)/%.js, $(TYPESCRIPT_TESTS))

TSC := ./node_modules/.bin/tsc
TSC_ARGS := -t es6 -m commonjs --strictNullChecks --pretty --experimentalDecorators --outDir

MOCHA := ./node_modules/.bin/mocha
MOCHA_ARGS = --ui tdd --growl --reporter spec

all: clean build-src build-tests

build-src: $(JS)

build-tests: $(TESTS)

$(JS_BUILD_DIR)/%.js: src/%.ts
	@clear
	- $(TSC) $(TSC_ARGS) $(dir $@) $<

$(TESTS_BUILD_DIR)/%.js: tests/%.ts
	@clear
	- $(TSC) $(TSC_ARGS) $(dir $@) $<

test:
	@clear
	@$(MOCHA) $(MOCHA_ARGS) $(TESTS_BUILD_DIR)/*.js

watch:
	@clear
	watchman-make -p 'src/*.ts' 'lib/.js' -t build-src -p 'tests/*.ts' 'compiledTests/.js' -t build-tests

watch-src:
	@clear
	watchman-make -p 'src/*.ts' 'lib/.js' -t build-src

watch-tests:
	@clear
	watchman-make -p 'tests/*.ts' 'compiledTests/.js' -t build-tests

watch-all-run-test:
	@clear
	watchman-make -p 'src/*.ts' 'lib/.js' -t build-src test -p 'tests/*.ts' 'compiledTests/.js' -t build-tests test

clean:
	rm -rf $(JS_BUILD_DIR)
	rm -rf $(TESTS_BUILD_DIR)

.NOTPARALLEL: test
