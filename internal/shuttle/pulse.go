package shuttle

import (
	"fmt"
	"regexp"
	"time"

	"gopkg.in/yaml.v3"
)

var clockPattern = regexp.MustCompile(`^(?:[01][0-9]|2[0-3]):[0-5][0-9]$`)

// Pulse requests another turn in the same conversation at a fixed interval.
type Pulse struct {
	Every  string       `json:"every" yaml:"every"`
	Window *PulseWindow `json:"window,omitempty" yaml:"window,omitempty"`
}

type PulseWindow struct {
	Start string `json:"start" yaml:"start"`
	End   string `json:"end" yaml:"end"`
	TZ    string `json:"tz" yaml:"tz"`
}

// UnmarshalYAML also accepts the compact `pulse: 59m` form.
func (p *Pulse) UnmarshalYAML(n *yaml.Node) error {
	if n.Kind == yaml.ScalarNode {
		p.Every = n.Value
		return nil
	}
	var value struct {
		Every  string       `yaml:"every"`
		Window *PulseWindow `yaml:"window"`
	}
	if err := n.Decode(&value); err != nil {
		return err
	}
	p.Every, p.Window = value.Every, value.Window
	return nil
}

// Interval validates a pulse interval and returns its duration.
func (p *Pulse) Interval() (time.Duration, error) {
	if p == nil {
		return 0, fmt.Errorf("is required")
	}
	d, err := time.ParseDuration(p.Every)
	if err != nil || d < time.Minute || d > 24*time.Hour || d%time.Millisecond != 0 {
		return 0, fmt.Errorf("must be a duration from 1m through 24h with millisecond precision")
	}
	return d, nil
}
