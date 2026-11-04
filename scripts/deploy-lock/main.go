// deploy-lock runs a host transaction under kernel locks. The source is shipped
// to the host and run with its build toolchain, independently of installed CLIs.
package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

func acquire(path, holder string) (*os.File, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	seconds := 3600
	if value := os.Getenv("SHUTTLE_DEPLOY_LOCK_TIMEOUT_SECONDS"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 0 {
			file.Close()
			return nil, fmt.Errorf("invalid SHUTTLE_DEPLOY_LOCK_TIMEOUT_SECONDS: %q", value)
		}
		seconds = parsed
	}
	deadline := time.Now().Add(time.Duration(seconds) * time.Second)
	waiting := false
	for {
		err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			break
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) {
			file.Close()
			return nil, err
		}
		info, _ := os.ReadFile(path)
		if !waiting {
			fmt.Fprintf(os.Stderr, "deploy-lock: waiting for %s; holder: %s\n", path, info)
			waiting = true
		}
		if !time.Now().Before(deadline) {
			file.Close()
			return nil, fmt.Errorf("timed out waiting for %s after %ds; holder: %s", path, seconds, info)
		}
		time.Sleep(100 * time.Millisecond)
	}
	info := fmt.Sprintf("%s; pid=%d; acquired=%s\n", holder, os.Getpid(), time.Now().UTC().Format(time.RFC3339))
	if err := file.Truncate(0); err != nil {
		file.Close()
		return nil, err
	}
	if _, err := file.WriteAt([]byte(info), 0); err != nil {
		file.Close()
		return nil, err
	}
	fmt.Fprint(os.Stderr, "deploy-lock: acquired "+path+"; "+info)
	return file, nil
}

func run(args []string) error {
	if len(args) < 4 {
		return errors.New("usage: deploy-lock HOST-LOCK TREE-LEASE HOLDER COMMAND [ARGS...]")
	}
	host, err := acquire(args[0], args[2])
	if err != nil {
		return err
	}
	defer host.Close()
	lease, err := acquire(args[1], args[2])
	if err != nil {
		return err
	}
	defer lease.Close()
	command := exec.Command(args[3], args[4:]...)
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	// The transaction shell and local build subprocess retain these locks
	// across a helper crash. Non-build steps close them before launching children.
	// Scheduler jobs on other nodes rely on the submitting transaction's lifetime.
	command.ExtraFiles = []*os.File{host, lease}
	return command.Run()
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "deploy-lock:", err)
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() > 0 {
			os.Exit(exit.ExitCode())
		}
		os.Exit(1)
	}
}
