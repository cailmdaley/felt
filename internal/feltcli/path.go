package feltcli

import "path/filepath"

func (a *app) canonicalPath(path string) (string, error) {
	absolute, err := a.env.Abs(path)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(absolute)
}
