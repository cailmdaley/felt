INSTALL_DIR := $(HOME)/.local/bin

.PHONY: build install test

build:
	go build .

install:
	GOBIN=$(INSTALL_DIR) go install .

test:
	go test ./...
