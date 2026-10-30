package messaging

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/cailmdaley/felt/internal/sysenv"
)

const threadValidationRetryDelay = 30 * time.Second

type threadValidationFailure struct {
	RetryAt time.Time `json:"retry_at"`
}

func currentThreadSignalWithBackoff(ctx context.Context, env *sysenv.Env, request Request) (bool, error) {
	return validateThreadSignalWithBackoff(ctx, env, request, func(ctx context.Context, request Request) (bool, error) {
		return currentThreadSignal(ctx, env, request)
	})
}

// Failure state and the probe lock are shared by hook processes and mailboxes.
// Only failures are cached: a successful check always examines current state.
func validateThreadSignalWithBackoff(ctx context.Context, env *sysenv.Env, request Request, check func(context.Context, Request) (bool, error)) (bool, error) {
	if request.ThreadSignal == nil || request.ThreadSignal.Owner == "" || !strings.HasPrefix(request.MessageID, "thread-") || isUnblockedNotice(request.Text) {
		return check(ctx, request)
	}
	owner := request.ThreadSignal.Owner
	dir := filepath.Join(dataDir(env), "thread-validation")
	if err := ensureDir(dir, 0700); err != nil {
		return false, err
	}
	path := filepath.Join(dir, mailboxKey(owner))
	lock, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return false, err
	}
	defer lock.Close()
	// Waiting for an in-flight probe obeys the hook's overall validation budget.
	for {
		err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			break
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN) {
			return false, err
		}
		timer := time.NewTimer(5 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return false, ctx.Err()
		case <-timer.C:
		}
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	bytes, err := readBounded(path+".json", 16384)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	var failure threadValidationFailure
	if err == nil && json.Unmarshal(bytes, &failure) == nil && time.Now().Before(failure.RetryAt) {
		return false, fmt.Errorf("thread signal owner %s validation deferred until %s", owner, failure.RetryAt.Format(time.RFC3339))
	}
	current, err := check(ctx, request)
	if err != nil {
		var skew threadSignalSkewError
		if errors.As(err, &skew) {
			return false, err
		}
		bytes, _ := json.Marshal(threadValidationFailure{RetryAt: time.Now().Add(threadValidationRetryDelay)})
		return false, errors.Join(err, mailboxWrite(path+".json", bytes, false))
	}
	if err := os.Remove(path + ".json"); err != nil && !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	return current, nil
}
