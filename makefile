# build output dirs
JS_BUILD_DIR = lib

# sources
TYPESCRIPT_SRC   = $(shell find src ! -path "src/tests/*" -name "*.ts")
TYPESCRIPT_TESTS = $(shell find src/tests -name '*.ts')


#targets
JS_SRC   = $(patsubst src/%.ts, $(JS_BUILD_DIR)/%.js, $(TYPESCRIPT_SRC))
JS_TESTS = $(patsubst src/%.ts, $(JS_BUILD_DIR)/%.js, $(TYPESCRIPT_TESTS))

TSC := ./node_modules/.bin/tsc
TSC_ARGS := -t es6 -m commonjs --strictNullChecks --pretty --experimentalDecorators --outDir $(JS_BUILD_DIR)/

JASMINE := ./node_modules/.bin/jasmine

$(JS_BUILD_DIR)/%.js: src/%.ts
	- $(TSC) $(TSC_ARGS) $<

$(JS_BUILD_DIR)/tests/%.js: src/tests/%.ts
	- $(TSC) $(TSC_ARGS) $<

all: build

build: build-src build-tests

build-src: $(JS_SRC)

build-tests: $(JS_TESTS)

test: build-src build-tests |
	@clear
	@$(JASMINE)

watch:
	@clear
	watchman-make -p 'src/*.ts' -t build-src

dev:
	@clear
	watchman-make -p 'src/*.ts' 'src/tests/*.ts' -t test

clean:
	rm -rf $(JS_BUILD_DIR)

