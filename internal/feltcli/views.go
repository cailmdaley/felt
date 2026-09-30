package feltcli

import "github.com/cailmdaley/felt/internal/felt"

// ViewOptions adapts a Felt view command to the binary and data decoration
// that owns its output.
type ViewOptions struct {
	Binary    string
	Directory func() string
	IsJSON    func() bool
	Decorate  func(...*felt.Felt) error
}

func (options ViewOptions) directory() string {
	if options.Directory != nil {
		return options.Directory()
	}
	return changeDir
}

func (options ViewOptions) jsonOutput() bool {
	if options.IsJSON != nil {
		return options.IsJSON()
	}
	return jsonOutput
}

func (options ViewOptions) commandName(feltCommand string) string {
	if options.Binary == "" || options.Binary == "felt" {
		return "felt " + feltCommand
	}
	return options.Binary + " " + feltCommand
}
