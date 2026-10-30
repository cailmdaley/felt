package messaging

// ProcessParent returns a process's parent PID, executable name, and whether
// the operating system supplied a complete observation.
func ProcessParent(pid int) (int, string, bool) { return processParent(pid) }
