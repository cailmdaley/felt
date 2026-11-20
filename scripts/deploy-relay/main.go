// deploy-relay carries a deploy transaction to a remote daemon's deploy-run
// routes over HTTP, in place of ssh. As the transport under deploy-lock
// --observe it behaves like the ssh command it replaces: the framed bootstrap
// arrives on stdin, heartbeats follow it, the remote output streams to stdout,
// and the exit status is the remote script's.
//
//	deploy-relay create URL                    prints "<id>\t<dir>"
//	deploy-relay put URL RUN NAME FILE         uploads FILE as <dir>/NAME
//	deploy-relay run URL RUN LAUNCH [--attached]
//
// run starts LAUNCH and polls the run's output once a second; each poll is
// the heartbeat the remote script checks. With --attached, stdin first holds
// a length-framed bootstrap, stored as <dir>/bootstrap before the start, and
// its EOF means the observer is gone. Then, and on TERM, INT or HUP, the relay
// asks the daemon to cancel the run; after EOF it reads on until the run exits
// or the host has been unreachable for 15 seconds. Polls fail while the daemon
// restarts itself mid-run; the relay retries until the host has been
// unreachable for the tailnet lease, SHUTTLE_DEPLOY_TAILNET_LEASE_SECONDS (300
// by default), after which the run, hearing no polls, cancels itself. A run
// without --attached is a short probe and is given ten minutes.
package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

// A poll that hangs counts as a failed one; an upload of a release is slow.
var (
	client   = &http.Client{Timeout: 10 * time.Second}
	uploader = &http.Client{Timeout: 30 * time.Minute}
)

// call makes one request and fails unless its status is one of ok.
func call(c *http.Client, method, url string, body io.Reader, ok ...int) ([]byte, error) {
	req, err := http.NewRequest(method, url, body)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/octet-stream")
	}
	resp, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	for _, code := range ok {
		if resp.StatusCode == code {
			return data, nil
		}
	}
	if resp.StatusCode == http.StatusNotFound && !bytes.Contains(data, []byte("deploy run")) {
		return nil, fmt.Errorf("%s answered 404: its daemon predates deploys over the tailnet", resp.Request.URL.Host)
	}
	return nil, fmt.Errorf("%s %s: HTTP %d: %s", resp.Request.Method, resp.Request.URL.Path, resp.StatusCode, strings.TrimSpace(string(data)))
}

func create(base string) error {
	body, err := call(client, "POST", base+"/api/v1/deploy/runs", nil, http.StatusCreated)
	if err != nil {
		return err
	}
	var run struct{ ID, Dir string }
	if err = json.Unmarshal(body, &run); err != nil || run.ID == "" || run.Dir == "" {
		return fmt.Errorf("unexpected create response: %s", body)
	}
	fmt.Printf("%s\t%s\n", run.ID, run.Dir)
	return nil
}

func put(base, run, name string, body io.Reader) error {
	_, err := call(uploader, "PUT", base+"/api/v1/deploy/runs/"+run+"/files/"+name, body, http.StatusNoContent)
	return err
}

func lease() time.Duration {
	if n, err := strconv.Atoi(os.Getenv("SHUTTLE_DEPLOY_TAILNET_LEASE_SECONDS")); err == nil && n > 0 {
		return time.Duration(n) * time.Second
	}
	return 5 * time.Minute
}

func run(base, id, launch string, attached bool) (int, error) {
	runURL := base + "/api/v1/deploy/runs/" + id
	var closed atomic.Bool
	if attached {
		in := bufio.NewReader(os.Stdin)
		line, err := in.ReadString('\n')
		if err != nil {
			return 1, fmt.Errorf("bootstrap frame: %w", err)
		}
		size, err := strconv.Atoi(strings.TrimSpace(line))
		if err != nil || size < 0 {
			return 1, fmt.Errorf("invalid bootstrap frame %q", line)
		}
		frame := make([]byte, size)
		if _, err = io.ReadFull(in, frame); err != nil {
			return 1, fmt.Errorf("bootstrap frame: %w", err)
		}
		if err = put(base, id, "bootstrap", io.MultiReader(strings.NewReader(line), bytes.NewReader(frame))); err != nil {
			return 1, err
		}
		go func() {
			io.Copy(io.Discard, in)
			closed.Store(true)
		}()
	}
	script, err := os.Open(launch)
	if err != nil {
		return 1, err
	}
	defer script.Close()
	cancel := func() error {
		_, err := call(client, "POST", runURL+"/cancel", nil, http.StatusAccepted)
		return err
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	if _, err = call(client, "POST", runURL+"/start", script, http.StatusAccepted); err != nil {
		return 1, err
	}
	go func() {
		<-signals
		cancel()
		os.Exit(143)
	}()

	started, offset, asked := time.Now(), 0, false
	var lost time.Time
	for {
		if closed.Load() && !asked {
			asked = cancel() == nil
		}
		if !attached && time.Since(started) > 10*time.Minute {
			cancel()
			return 1, errors.New("the probe did not finish in ten minutes")
		}
		resp, err := client.Get(runURL + "/output?offset=" + strconv.Itoa(offset))
		var chunk []byte
		if err == nil && resp.StatusCode == http.StatusNotFound {
			resp.Body.Close()
			return 1, errors.New("the deploy run disappeared from its host")
		}
		if err == nil && resp.StatusCode == http.StatusOK {
			chunk, err = io.ReadAll(resp.Body)
			resp.Body.Close()
		} else if err == nil {
			resp.Body.Close()
			err = fmt.Errorf("HTTP %d", resp.StatusCode)
		}
		if err != nil {
			if lost.IsZero() {
				lost = time.Now()
				fmt.Fprintf(os.Stderr, "deploy-relay: %s unreachable (%v); retrying\n", base, err)
			} else if closed.Load() && time.Since(lost) > 15*time.Second || time.Since(lost) > lease() {
				return 1, fmt.Errorf("%s unreachable since %s; the run cancels itself without polls", base, lost.Format(time.TimeOnly))
			}
			time.Sleep(time.Second)
			continue
		}
		if !lost.IsZero() {
			fmt.Fprintf(os.Stderr, "deploy-relay: %s answering again after %s\n", base, time.Since(lost).Round(time.Second))
			lost = time.Time{}
		}
		if _, err = os.Stdout.Write(chunk); err != nil {
			return 1, err
		}
		offset += len(chunk)
		if status := resp.Header.Get("x-deploy-status"); status != "" {
			code, err := strconv.Atoi(status)
			if err != nil {
				return 1, fmt.Errorf("invalid exit status %q", status)
			}
			call(client, "DELETE", runURL, nil, http.StatusNoContent)
			return code, nil
		}
		if len(chunk) == 0 {
			time.Sleep(time.Second)
		}
	}
}

func main() {
	args := os.Args[1:]
	var err error
	code := 0
	switch {
	case len(args) == 2 && args[0] == "create":
		err = create(args[1])
	case len(args) == 5 && args[0] == "put":
		var file *os.File
		if file, err = os.Open(args[4]); err == nil {
			err = put(args[1], args[2], args[3], file)
			file.Close()
		}
	case (len(args) == 4 || len(args) == 5 && args[4] == "--attached") && args[0] == "run":
		code, err = run(args[1], args[2], args[3], len(args) == 5)
	default:
		err = errors.New("usage: deploy-relay create URL | put URL RUN NAME FILE | run URL RUN LAUNCH [--attached]")
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "deploy-relay:", err)
		if code == 0 {
			code = 1
		}
	}
	os.Exit(code)
}
