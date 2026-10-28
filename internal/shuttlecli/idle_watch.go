package shuttlecli

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"github.com/cailmdaley/felt/internal/messaging"
	"github.com/spf13/cobra"
)

// spawnIdleWatcher starts `shuttle idle-watch <record>` detached from the
// sending command, in its own session so it outlives the request.
func (a *app) spawnIdleWatcher(recordPath string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	logFile, err := os.OpenFile(recordPath+".log", os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	defer logFile.Close()
	cmd := exec.Command(exe, "idle-watch", recordPath)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = nil, logFile, logFile
	cmd.Dir = filepath.Dir(recordPath)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

func (a *app) idleWatchCmd() *cobra.Command {
	return &cobra.Command{
		Use:    "idle-watch <subscription-record>",
		Short:  "Watch a receiver for one idle notice (started by message --notify-when-idle)",
		Hidden: true,
		Args:   cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			rec, err := messaging.ReadIdleRecord(args[0])
			if err != nil {
				return err
			}
			notice := messaging.WatchIdle(context.Background(), a.env, rec)
			request := messaging.Request{
				Address:   rec.Subscriber,
				Text:      messaging.IdleNoticeText(rec, notice),
				From:      rec.Address,
				Wake:      rec.Wake,
				MessageID: messaging.IdleNoticeID(rec),
			}
			fmt.Fprintf(a.env.Stderr, "%s notice %s: %s\n", time.Now().UTC().Format(time.RFC3339), notice.State, request.Text)
			var last error
			for attempt := 0; attempt < 6; attempt++ {
				if attempt > 0 {
					time.Sleep(time.Duration(attempt) * 10 * time.Second)
				}
				receipt, err := a.postMessage(request)
				if err == nil && messageReceiptError(request.MessageID, receipt, nil) == nil {
					fmt.Fprintf(a.env.Stderr, "delivered: %s\n", receipt.Status)
					_ = os.Remove(args[0])
					_ = os.Remove(args[0] + ".log")
					return nil
				}
				last = err
				if last == nil {
					last = messageReceiptError(request.MessageID, receipt, nil)
				}
				fmt.Fprintf(a.env.Stderr, "delivery attempt %d failed: %v\n", attempt+1, last)
			}
			return last
		},
	}
}
