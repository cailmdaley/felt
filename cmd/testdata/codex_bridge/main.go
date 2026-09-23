//go:build bridge_test

package main

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/gorilla/websocket"
)

func main() {
	if path := os.Getenv("FELT_BRIDGE_ARGS_FILE"); path != "" {
		data, _ := json.Marshal(os.Args[1:])
		_ = os.WriteFile(path, data, 0600)
	}
	if path := os.Getenv("FELT_BRIDGE_ENV_FILE"); path != "" {
		data, _ := json.Marshal(map[string]string{
			"CODEX_CLI_PATH":            os.Getenv("CODEX_CLI_PATH"),
			"CODEX_APP_TOOLS_PIPE_PATH": os.Getenv("CODEX_APP_TOOLS_PIPE_PATH"),
			"FELT_BRIDGE_ENV_MARKER":    os.Getenv("FELT_BRIDGE_ENV_MARKER"),
			"FELT_BRIDGE_HELPER_PID":    strconv.Itoa(os.Getpid()),
		})
		_ = os.WriteFile(path, data, 0600)
	}
	if os.Getenv("FELT_BRIDGE_NO_SOCKET") == "1" {
		select {}
	}

	path := os.Getenv("FELT_BRIDGE_SOCKET")
	if path == "" {
		os.Exit(2)
	}
	_ = os.MkdirAll(filepath.Dir(path), 0700)
	ln, err := net.Listen("unix", path)
	if err != nil {
		if errorPath := os.Getenv("FELT_BRIDGE_ERROR_FILE"); errorPath != "" {
			_ = os.WriteFile(errorPath, []byte(err.Error()), 0600)
		}
		os.Exit(3)
	}
	_ = os.Chmod(path, 0600)

	closed := make(chan struct{})
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer ws.Close()
		for {
			kind, data, err := ws.ReadMessage()
			if err != nil {
				closeOnce(closed)
				return
			}
			if kind == websocket.TextMessage || kind == websocket.BinaryMessage {
				_ = ws.WriteMessage(websocket.TextMessage, data)
			}
		}
	})}
	go server.Serve(ln)
	<-closed
	_ = server.Close()
	_ = ln.Close()
	_ = os.Remove(path)
	time.Sleep(10 * time.Millisecond)
}

func closeOnce(ch chan struct{}) {
	select {
	case <-ch:
	default:
		close(ch)
	}
}
