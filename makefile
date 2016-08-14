# build output dirs
BUILD_DIR = lib
JS_BUILD_DIR = $(BUILD_DIR)

# sources
TYPESCRIPT = $(shell find src -name '*.ts')

#targets
JS = $(patsubst src/%.ts, $(JS_BUILD_DIR)/%.js, $(TYPESCRIPT))

TSC := ./node_modules/.bin/tsc
TSC_ARGS := -t es6 -m commonjs --strictNullChecks --pretty --outDir

all: build-setup $(JS)

$(JS_BUILD_DIR)/%.js: src/%.ts
	@echo "Typescript $< -- $@"
	- $(TSC) $< $(TSC_ARGS) $(dir $@)

build-setup:
	mkdir -p $(BUILD_DIR)

watch:
	watchman-make -p 'src/*.ts' 'lib/.js' -t all

clean:
	rm -rf lib/

.PHONY: clean
