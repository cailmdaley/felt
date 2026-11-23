package shuttle

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/cailmdaley/felt/internal/sysenv"
)

func TestHostAmbientConfigAndEnvOverrides(t *testing.T) {
	t.Parallel()

	t.Run("default false when host.json missing", func(t *testing.T) {
		t.Parallel()
		env := sysenv.New(t.TempDir(), []string{
			"SHUTTLE_HOST_CONFIG_FILE=" + filepath.Join(t.TempDir(), "missing.json"),
		})
		cfg, err := ResolveHostConfig(env)
		if err != nil {
			t.Fatal(err)
		}
		if cfg.Ambient {
			t.Fatal("expected Ambient=false by default")
		}
		got, err := HostAmbient(env)
		if err != nil || got {
			t.Fatalf("HostAmbient = %v, %v; want false, nil", got, err)
		}
	})

	t.Run("host.json ambient true", func(t *testing.T) {
		t.Parallel()
		path := filepath.Join(t.TempDir(), "host.json")
		if err := os.WriteFile(path, []byte(`{"ambient": true}`), 0o600); err != nil {
			t.Fatal(err)
		}
		env := sysenv.New(t.TempDir(), []string{
			"SHUTTLE_HOST_CONFIG_FILE=" + path,
		})
		cfg, err := ResolveHostConfig(env)
		if err != nil {
			t.Fatal(err)
		}
		if !cfg.Ambient {
			t.Fatal("expected Ambient=true from host.json")
		}
		got, err := HostAmbient(env)
		if err != nil || !got {
			t.Fatalf("HostAmbient = %v, %v; want true, nil", got, err)
		}
	})

	t.Run("SHUTTLE_AMBIENT=0 disables host.json true", func(t *testing.T) {
		t.Parallel()
		path := filepath.Join(t.TempDir(), "host.json")
		if err := os.WriteFile(path, []byte(`{"ambient": true}`), 0o600); err != nil {
			t.Fatal(err)
		}
		env := sysenv.New(t.TempDir(), []string{
			"SHUTTLE_HOST_CONFIG_FILE=" + path,
			"SHUTTLE_AMBIENT=0",
		})
		cfg, err := ResolveHostConfig(env)
		if err != nil {
			t.Fatal(err)
		}
		if cfg.Ambient {
			t.Fatal("expected SHUTTLE_AMBIENT=0 to disable ambient")
		}
		got, err := HostAmbient(env)
		if err != nil || got {
			t.Fatalf("HostAmbient = %v, %v; want false, nil", got, err)
		}
	})

	t.Run("SHUTTLE_AMBIENT=1 enables over host.json false", func(t *testing.T) {
		t.Parallel()
		path := filepath.Join(t.TempDir(), "host.json")
		if err := os.WriteFile(path, []byte(`{"ambient": false}`), 0o600); err != nil {
			t.Fatal(err)
		}
		env := sysenv.New(t.TempDir(), []string{
			"SHUTTLE_HOST_CONFIG_FILE=" + path,
			"SHUTTLE_AMBIENT=1",
		})
		cfg, err := ResolveHostConfig(env)
		if err != nil {
			t.Fatal(err)
		}
		if !cfg.Ambient {
			t.Fatal("expected SHUTTLE_AMBIENT=1 to enable ambient")
		}
		got, err := HostAmbient(env)
		if err != nil || !got {
			t.Fatalf("HostAmbient = %v, %v; want true, nil", got, err)
		}
	})

	t.Run("non-boolean ambient in host.json is malformed", func(t *testing.T) {
		t.Parallel()
		path := filepath.Join(t.TempDir(), "host.json")
		if err := os.WriteFile(path, []byte(`{"ambient": "yes"}`), 0o600); err != nil {
			t.Fatal(err)
		}
		env := sysenv.New(t.TempDir(), []string{
			"SHUTTLE_HOST_CONFIG_FILE=" + path,
		})
		if _, err := ResolveHostConfig(env); err == nil {
			t.Fatal("expected error for non-boolean ambient")
		}
		if _, err := HostAmbient(env); err == nil {
			t.Fatal("expected HostAmbient error for non-boolean ambient")
		}
	})
}
