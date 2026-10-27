//go:build linux

package sysenvtest

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
)

func TestColdConcurrentScriptsStress(t *testing.T) {
	t.Setenv("TMPDIR", t.TempDir())
	for i := 0; i < 200; i++ {
		script := fmt.Sprintf("#!/bin/sh\nprintf 'ok %d\\n'\n", i)
		var wg sync.WaitGroup
		errs := make(chan error, 64)
		for j := 0; j < 64; j++ {
			dest := filepath.Join(os.TempDir(), fmt.Sprintf("link-%d-%d", i, j))
			wg.Add(1)
			go func() {
				defer wg.Done()
				LinkScript(t, dest, script)
				_, err := exec.Command(dest).Output()
				if err != nil {
					errs <- err
				}
			}()
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			t.Errorf("round %d: %v", i, err)
		}
	}
}
