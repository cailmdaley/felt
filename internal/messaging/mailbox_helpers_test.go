package messaging

import "context"

func offerMailbox(dir string, accepts func(Request) bool, emit func([]Request) error) error {
	return offerMailboxWithAck(dir, accepts, emit, false, nil, "")
}

func offerMailboxValidated(dir string, accepts func(Request) bool, current func(context.Context, Request) (bool, error), emit func([]Request) error) error {
	return offerMailboxWithAck(dir, accepts, emit, false, current, "")
}
