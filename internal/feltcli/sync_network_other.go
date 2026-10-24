//go:build !unix

package feltcli

import "os/exec"

func cancelSyncNetworkTree(_ *exec.Cmd) {}
