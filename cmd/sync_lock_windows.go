//go:build windows

package cmd

import "fmt"

func lockSyncRepository(commonDir string) (func(), error) {
	return nil, fmt.Errorf("felt sync repository locking is unsupported on Windows")
}
