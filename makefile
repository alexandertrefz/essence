# Build Output Directories
TS_SOURCE_DIR = src
JS_BUILD_DIR = lib

# Sources
TYPESCRIPT_SRC   = $(shell find $(TS_SOURCE_DIR) ! -path "$(TS_SOURCE_DIR)/tests/*" -name "*.ts")
TYPESCRIPT_TESTS = $(shell find $(TS_SOURCE_DIR)/tests -name '*.ts')

# Targets
JS_SRC   = $(patsubst $(TS_SOURCE_DIR)/%.ts, $(JS_BUILD_DIR)/%.js, $(TYPESCRIPT_SRC))
JS_TESTS = $(patsubst $(TS_SOURCE_DIR)/%.ts, $(JS_BUILD_DIR)/%.js, $(TYPESCRIPT_TESTS))

# Commands
TSC := ./node_modules/.bin/tsc
TSC_ARGS := -t es6 -m commonjs --strictNullChecks --pretty --experimentalDecorators --rootDir $(TS_SOURCE_DIR)/ --outDir $(JS_BUILD_DIR)/

JASMINE := ./node_modules/.bin/jasmine

$(JS_BUILD_DIR)/%.js: $(TS_SOURCE_DIR)/%.ts
	- $(TSC) $(TSC_ARGS) $<

$(JS_BUILD_DIR)/tests/%.js: $(TS_SOURCE_DIR)/tests/%.ts
	- $(TSC) $(TSC_ARGS) $<

all: build build-tests

build: $(JS_SRC)

build-tests: $(JS_TESTS)

test: all |
	@clear
	@$(JASMINE)

watch:
	@clear
	watchman-make -p '$(TS_SOURCE_DIR)/**/*.ts' -t build

dev:
	@clear
	watchman-make -p '$(TS_SOURCE_DIR)/**/*.ts' '$(TS_SOURCE_DIR)/tests/**/*.ts' -t test

clean:
	- rm -rf $(JS_BUILD_DIR)

