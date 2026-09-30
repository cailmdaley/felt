//go:build windows

package feltcli

import "fmt"

func lockSyncRepository(commonDir string) (func(), error) {
	return nil, fmt.Errorf("felt sync repository locking is unsupported on Windows")
}
