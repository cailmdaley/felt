// deploy-lock owns an attached transaction and its process group. The observer
// pipe, signals and the host deadline cancel both lock acquisition and work.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func deadline() (time.Time, error) {
	key, value := "SHUTTLE_DEPLOY_DEADLINE", os.Getenv("SHUTTLE_DEPLOY_DEADLINE")
	if value != "" {
		n, err := strconv.ParseInt(value, 10, 64)
		if err != nil {
			return time.Time{}, fmt.Errorf("invalid %s: %q", key, value)
		}
		return time.Unix(n, 0), nil
	}
	return time.Now().Add(2 * time.Hour), nil
}

func acquire(ctx context.Context, path, holder string) (*os.File, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	seconds := 3600
	if v := os.Getenv("SHUTTLE_DEPLOY_LOCK_TIMEOUT_SECONDS"); v != "" {
		seconds, err = strconv.Atoi(v)
		if err != nil || seconds < 0 {
			file.Close()
			return nil, fmt.Errorf("invalid lock timeout: %q", v)
		}
	}
	until := time.Now().Add(time.Duration(seconds) * time.Second)
	waiting := false
	for {
		if ctx.Err() != nil {
			file.Close()
			return nil, context.Cause(ctx)
		}
		err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
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
		if !time.Now().Before(until) {
			file.Close()
			return nil, fmt.Errorf("timed out waiting for %s after %ds; holder: %s", path, seconds, info)
		}
		select {
		case <-ctx.Done():
			file.Close()
			return nil, context.Cause(ctx)
		case <-time.After(100 * time.Millisecond):
		}
	}
	node, err := os.Hostname()
	if err != nil {
		file.Close()
		return nil, err
	}
	info := fmt.Sprintf("%s node=%s; pid=%d; pgid=%d; acquired=%s\n", holder, node, os.Getpid(), syscall.Getpgrp(), time.Now().UTC().Format(time.RFC3339))
	if err = file.Truncate(0); err == nil {
		_, err = file.WriteAt([]byte(info), 0)
	}
	if err != nil {
		file.Close()
		return nil, err
	}
	fmt.Fprint(os.Stderr, "deploy-lock: acquired "+path+"; "+info)
	return file, nil
}

// completion checks the inner bootstrap's final line. A login profile that
// exits zero before executing the bootstrap is not a completed deployment.
type completion struct {
	token   string
	pending string
	seen    bool
	cancel  context.CancelCauseFunc
}

func (c *completion) Write(p []byte) (int, error) {
	c.pending += string(p)
	for {
		i := strings.IndexByte(c.pending, '\n')
		if i < 0 {
			break
		}
		line := c.pending[:i]
		c.pending = c.pending[i+1:]
		if line == c.token+" 0" {
			c.seen = true
		}
	}
	n, err := os.Stdout.Write(p)
	if err != nil {
		c.cancel(err)
	}
	return n, err
}

func owned(ctx context.Context, until time.Time, cmd *exec.Cmd, control *os.File, feed *os.File) error {
	// The helper is the group leader, so its outer shell also knows the group
	// after an uncatchable helper death. The transaction joins this owned group.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pgid: os.Getpid()}
	if ctx.Err() != nil {
		return context.Cause(ctx)
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "deploy-lock: transaction pgid=%d child=%d\n", os.Getpid(), cmd.Process.Pid)
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	events := make(chan byte, 1)
	if control != nil {
		go func() {
			var b [1]byte
			for {
				if _, err := control.Read(b[:]); err != nil {
					return
				}
				events <- b[0]
			}
		}()
	}
	hard := time.NewTimer(time.Until(until))
	defer hard.Stop()
	stopped := ctx.Done()
	var reason error
	var grace <-chan time.Time
	critical := false
	stop := func(why error) {
		if grace != nil {
			return
		}
		reason = why
		fmt.Fprintf(os.Stderr, "deploy-lock: cancelling group %d: %v\n", os.Getpid(), why)
		if feed != nil {
			feed.Close()
		}
		_ = syscall.Kill(-os.Getpid(), syscall.SIGTERM)
		grace = time.After(3 * time.Second)
	}
	for {
		select {
		case err := <-done:
			if reason != nil || ctx.Err() != nil {
				if reason == nil {
					reason = context.Cause(ctx)
				}
				if feed != nil {
					return reason
				}
				stop(reason)
				done = nil
			} else {
				return err
			}
		case <-stopped:
			stopped = nil
			reason = context.Cause(ctx)
			if feed != nil {
				fmt.Fprintln(os.Stderr, "deploy-lock: closing attached transport:", reason)
				feed.Close()
			} else if critical {
				fmt.Fprintln(os.Stderr, "deploy-lock: cancellation deferred through activation")
			} else {
				stop(reason)
			}
		case <-hard.C:
			stop(errors.New("overall host deadline exceeded"))
		case event := <-events:
			if reason == nil && ctx.Err() != nil {
				reason = context.Cause(ctx)
			}
			switch event {
			case 'B':
				ready := 900
				if n, e := strconv.Atoi(os.Getenv("SHUTTLE_DEPLOY_READY_TIMEOUT_SECONDS")); e == nil && n >= 0 {
					ready = n
				}
				reserve := time.Duration(ready)*time.Second + time.Minute
				if reason == nil && time.Until(until) <= reserve {
					reason = fmt.Errorf("insufficient activation deadline budget: need more than %s, have %s", reserve, time.Until(until).Round(time.Second))
				}
				if reason == nil {
					critical = true
					if _, err := control.Write([]byte("ok\n")); err != nil {
						stop(err)
					}
				} else {
					stop(reason)
				}
			case 'E':
				critical = false
				if reason != nil {
					stop(reason)
				} else if _, err := control.Write([]byte("ok\n")); err != nil {
					stop(err)
				}
			}
		case <-grace:
			fmt.Fprintf(os.Stderr, "deploy-lock: cancellation grace expired; KILL group %d\n", os.Getpid())
			_ = syscall.Kill(-os.Getpid(), syscall.SIGKILL)
		}
	}
}

func run(args []string) error {
	if len(args) < 4 {
		return errors.New("usage: deploy-lock HOST-LOCK TREE-LEASE HOLDER COMMAND [ARGS...] | --observe SCRIPT TOKEN COMMAND [ARGS...]")
	}
	if err := syscall.Setpgid(0, 0); err != nil && syscall.Getpgrp() != os.Getpid() {
		return err
	}
	until, err := deadline()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithDeadline(context.Background(), until)
	defer cancel()
	ctx, cause := context.WithCancelCause(ctx)
	defer cause(nil)
	signals := make(chan os.Signal, 8)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP, syscall.SIGPIPE)
	defer signal.Stop(signals)
	go func() {
		select {
		case s := <-signals:
			cause(fmt.Errorf("received %s", s))
		case <-ctx.Done():
		}
	}()
	go func() {
		_, err := io.Copy(io.Discard, os.Stdin)
		if err != nil {
			cause(err)
		} else {
			cause(errors.New("observer EOF"))
		}
	}()
	if args[0] == "--observe" {
		data, err := os.ReadFile(args[1])
		if err != nil {
			return err
		}
		input, keepalive, err := os.Pipe()
		if err != nil {
			return err
		}
		defer input.Close()
		defer keepalive.Close()
		cmd := exec.Command(args[3], args[4:]...)
		cmd.WaitDelay = time.Second
		cmd.Stdin = input
		proof := &completion{token: args[2], cancel: cause}
		cmd.Stdout = proof
		cmd.Stderr = os.Stderr
		go func() {
			_, e := fmt.Fprintf(keepalive, "%d\n", len(data))
			if e == nil {
				_, e = keepalive.Write(data)
			}
			if e != nil {
				cause(e)
				return
			}
			ticker := time.NewTicker(15 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-ticker.C:
					if _, e = fmt.Fprintln(keepalive); e != nil {
						cause(e)
						return
					}
				case <-ctx.Done():
					return
				}
			}
		}()
		err = owned(ctx, until, cmd, nil, keepalive)
		if err == nil && !proof.seen {
			return errors.New("missing deployment completion sentinel (login/bootstrap did not finish)")
		}
		return err
	}
	host, err := acquire(ctx, args[0], args[2])
	if err != nil {
		return err
	}
	defer host.Close()
	lease, err := acquire(ctx, args[1], args[2])
	if err != nil {
		return err
	}
	defer lease.Close()
	if log := os.Getenv("SHUTTLE_DEPLOY_LOG_FILE"); log != "" {
		if err = os.Rename(log, filepath.Join(os.Getenv("HOME"), ".shuttle/deploy/last-run.log")); err != nil {
			return err
		}
	}
	sockets, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		return err
	}
	syscall.CloseOnExec(sockets[0])
	syscall.CloseOnExec(sockets[1])
	parent, child := os.NewFile(uintptr(sockets[0]), "activation-owner"), os.NewFile(uintptr(sockets[1]), "activation-transaction")
	defer parent.Close()
	defer child.Close()
	cmd := exec.Command(args[3], args[4:]...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	cmd.ExtraFiles = []*os.File{host, lease, child}
	return owned(ctx, until, cmd, parent, nil)
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
