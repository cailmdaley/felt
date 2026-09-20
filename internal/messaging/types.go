package messaging

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
)

const (
	StatusAccepted     = "accepted"
	StatusContextAdded = "context_added"
	StatusSubmitted    = "submitted"
	StatusQueued       = "queued"
	StatusUnknown      = "unknown"
	StatusRejected     = "rejected"
)

type Session struct {
	Address      string   `json:"address"`
	Host         string   `json:"host"`
	Harness      string   `json:"harness"`
	ID           string   `json:"id"`
	Title        string   `json:"title"`
	CWD          string   `json:"cwd"`
	State        string   `json:"state"`
	Capabilities []string `json:"capabilities"`
	LastSeen     int64    `json:"last_seen,omitempty"`
}

type Gap struct {
	Host    string `json:"host"`
	Harness string `json:"harness"`
	Error   string `json:"error"`
}

type Directory struct {
	Host     string    `json:"host"`
	Sessions []Session `json:"sessions"`
	Gaps     []Gap     `json:"gaps"`
}

type Request struct {
	Address   string `json:"address"`
	Text      string `json:"text"`
	From      string `json:"from,omitempty"`
	Wake      bool   `json:"wake"`
	MessageID string `json:"message_id"`
}

type Receipt struct {
	MessageID string `json:"message_id"`
	Address   string `json:"address"`
	Status    string `json:"status"`
	Transport string `json:"transport"`
	Detail    string `json:"detail,omitempty"`
}

type Address struct{ Host, Harness, ID string }

type Error struct{ Code, Message string }

func (e *Error) Error() string { return e.Message }
func errCode(code, format string, args ...any) error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}
func ErrorCode(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return "internal"
}

func FormatAddress(host, harness, id string) (string, error) {
	if err := validatePart("host", host); err != nil {
		return "", err
	}
	if err := validatePart("harness", harness); err != nil {
		return "", err
	}
	if id == "" || len(id) > 4096 || strings.ContainsRune(id, 0) {
		return "", errCode("invalid_address", "invalid native session id")
	}
	return "shuttle://" + host + "/" + harness + "/" + url.PathEscape(id), nil
}

func ParseAddress(raw string) (Address, error) {
	if len(raw) > 8192 {
		return Address{}, errCode("invalid_address", "address is too long")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "shuttle" || u.Host == "" || u.RawQuery != "" || u.Fragment != "" || u.User != nil {
		return Address{}, errCode("invalid_address", "address must be shuttle://<host>/<harness>/<native-id>")
	}
	parts := strings.Split(strings.TrimPrefix(u.EscapedPath(), "/"), "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return Address{}, errCode("invalid_address", "address must contain exactly harness and native id")
	}
	h, id := parts[0], parts[1]
	id, err = url.PathUnescape(id)
	if err != nil {
		return Address{}, errCode("invalid_address", "native id is not valid URL escaping")
	}
	if err := validatePart("host", u.Host); err != nil {
		return Address{}, err
	}
	if err := validatePart("harness", h); err != nil {
		return Address{}, err
	}
	canonical, err := FormatAddress(u.Host, h, id)
	if err != nil || canonical != raw {
		return Address{}, errCode("invalid_address", "address is not canonical")
	}
	return Address{Host: u.Host, Harness: h, ID: id}, nil
}

func validatePart(name, s string) error {
	if s == "" || len(s) > 255 {
		return errCode("invalid_address", "invalid %s", name)
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-' || r == '.' || r == '_') {
			return errCode("invalid_address", "invalid %s", name)
		}
	}
	return nil
}

type adapter interface {
	discover(context.Context, string) ([]Session, error)
	send(context.Context, Address, Request) (Receipt, error)
}
