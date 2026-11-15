package shuttlecli

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"time"

	"github.com/cailmdaley/felt/internal/atomicfile"
	"github.com/cailmdaley/felt/internal/shuttle"
)

const delayedContract = 45

func (a *app) requireDelayedContract(owner string) error {
	local, ok := a.daemonContractLevel("")
	if !ok {
		return fmt.Errorf("local daemon unreachable; delayed messages require contract %d", delayedContract)
	}
	if local.Level < delayedContract {
		return fmt.Errorf("host %s is at contract %d; delayed messages require %d", local.Host, local.Level, delayedContract)
	}
	if local.Host == owner {
		return nil
	}
	remote, ok := a.daemonContractLevel(owner)
	if !ok {
		return fmt.Errorf("owner %s unreachable; delayed messages require contract %d", owner, delayedContract)
	}
	if remote.Host != owner || remote.Level < delayedContract {
		return fmt.Errorf("host %s is at contract %d; delayed messages require %d", owner, remote.Level, delayedContract)
	}
	return nil
}

var dayDuration = regexp.MustCompile(`([0-9]+(?:\.[0-9]+)?)d`)

// resolveMessageTime uses the sender's clock and zone, never the owner's.
func resolveMessageTime(delay, at string, now time.Time, zone *time.Location) (time.Time, error) {
	var t time.Time
	var err error
	if delay != "" {
		delay = dayDuration.ReplaceAllStringFunc(delay, func(s string) string {
			n, _ := strconv.ParseFloat(s[:len(s)-1], 64)
			return strconv.FormatFloat(n*24, 'f', -1, 64) + "h"
		})
		var d time.Duration
		d, err = time.ParseDuration(delay)
		t = now.Add(d)
	} else {
		t, err = time.Parse(time.RFC3339, at)
		if err != nil {
			t, err = time.ParseInLocation("2006-01-02 15:04", at, zone)
			if err == nil && t.In(zone).Format("2006-01-02 15:04") != at {
				return time.Time{}, fmt.Errorf("delivery time does not exist in %s", zone)
			}
		}
		if err != nil {
			var clock time.Time
			clock, err = time.Parse("15:04", at)
			if err == nil {
				// Walk real minutes so a repeated wall-clock time can still be
				// next today, and a skipped clock time waits until it exists.
				for t = now.Truncate(time.Minute).Add(time.Minute); ; t = t.Add(time.Minute) {
					local := t.In(zone)
					if local.Hour() == clock.Hour() && local.Minute() == clock.Minute() {
						break
					}
				}
			}
		}
	}
	if err != nil {
		return time.Time{}, fmt.Errorf("invalid delivery time: %w", err)
	}
	if !t.After(now) {
		return time.Time{}, fmt.Errorf("delivery time must be in the future")
	}
	return t.UTC(), nil
}

// Keep the resolved instant across CLI retries under one publication id.
func (a *app) messageSchedule(id, delay, at string) (string, error) {
	dir, err := shuttle.DataDir(a.env)
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, "message-schedules", fmt.Sprintf("%x.json", sha256.Sum256([]byte(id))))
	type schedule struct{ Delay, At, Instant string }
	read := func() (string, error) {
		data, err := os.ReadFile(path)
		if err != nil {
			return "", err
		}
		var s schedule
		if err := json.Unmarshal(data, &s); err != nil {
			return "", err
		}
		if s.Delay != delay || s.At != at {
			return "", fmt.Errorf("message_id_conflict: this id has a different schedule")
		}
		return s.Instant, nil
	}
	if instant, err := read(); !os.IsNotExist(err) {
		return instant, err
	}
	instant, err := resolveMessageTime(delay, at, time.Now(), time.Local)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return "", err
	}
	data, _ := json.Marshal(schedule{delay, at, instant.Format(time.RFC3339Nano)})
	if err := atomicfile.WriteNewUnsynced(path, data, 0600); err != nil && !os.IsExist(err) {
		return "", err
	}
	return read()
}
