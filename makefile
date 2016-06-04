tsc := ./node_modules/typescript/bin/tsc
tscArgs := -t es6 -m commonjs --outDir ./lib/
tsFiles := $(shell find src -name "*.ts")
tsFilesNoDir := $(notdir $(tsFiles))
jsFiles := $(addprefix lib/, $(tsFilesNoDir:.ts=.js))

all: $(jsFiles)

lib/%.js: src/%.ts
	- $(tsc) $< $(tscArgs)

watch:
	watchman-make -p 'src/*.ts' 'lib/.js' -t all

clean:
	rm -rf lib/

.PHONY: clean
