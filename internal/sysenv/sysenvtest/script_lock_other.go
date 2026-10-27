//go:build !linux

package sysenvtest

func lockScriptWrite() func() { return func() {} }
