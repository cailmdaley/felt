package shuttlecli

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/cailmdaley/felt/internal/felt"
)

func TestBootstrapSupervisorStoreFreshHomeAndReinstall(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	registry := filepath.Join(home, ".config", "shuttle", "stores.json")
	t.Setenv("SHUTTLE_STORES_FILE", registry)
	options := supervisorOptions{StoresFile: registry}
	cwd := t.TempDir()
	if err := testApp(t).bootstrapSupervisorStore(options, cwd); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(home, "felt")
	if !felt.NewStorage(root).Exists() {
		t.Fatal("default store missing")
	}
	stores, err := testApp(t).registeredFeltStores()
	if err != nil || !reflect.DeepEqual(stores, []string{root}) {
		t.Fatalf("stores %v: %v", stores, err)
	}
	sentinel := filepath.Join(root, ".felt", ".gitignore")
	if err := os.WriteFile(sentinel, []byte("keep me\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := testApp(t).bootstrapSupervisorStore(options, cwd); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(sentinel)
	if err != nil || string(content) != "keep me\n" {
		t.Fatalf("reinstall altered store: %q %v", content, err)
	}
}

func TestBootstrapSupervisorStorePreservesOperatorConfiguration(t *testing.T) {
	for _, config := range []string{"", `[]`, `{"version":1,"felt_stores":[]}`, `{"felt_stores":["/operator/store"],"extra":true}`, "invalid json"} {
		t.Run(config, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			registry := filepath.Join(home, "stores.json")
			if err := os.WriteFile(registry, []byte(config), 0600); err != nil {
				t.Fatal(err)
			}
			if err := testApp(t).bootstrapSupervisorStore(supervisorOptions{StoresFile: registry}, t.TempDir()); err != nil {
				t.Fatal(err)
			}
			actual, _ := os.ReadFile(registry)
			if string(actual) != config {
				t.Fatal("operator configuration changed")
			}
			if _, err := os.Stat(filepath.Join(home, "felt")); !os.IsNotExist(err) {
				t.Fatal("unexpected default store")
			}
		})
	}
	t.Run("fixed stores", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("HOME", home)
		registry := filepath.Join(home, "stores.json")
		if err := testApp(t).bootstrapSupervisorStore(supervisorOptions{StoresFile: registry, Stores: "/fixed/store"}, t.TempDir()); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(registry); !os.IsNotExist(err) {
			t.Fatal("created registry for fixed stores")
		}
	})
}

func TestBootstrapSupervisorStoreReusesCurrentProject(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	project, storage := newStore(t)
	child := filepath.Join(project, "subdir")
	if err := os.MkdirAll(child, 0755); err != nil {
		t.Fatal(err)
	}
	registry := filepath.Join(home, "stores.json")
	t.Setenv("SHUTTLE_STORES_FILE", registry)
	if err := testApp(t).bootstrapSupervisorStore(supervisorOptions{StoresFile: registry}, child); err != nil {
		t.Fatal(err)
	}
	stores, err := testApp(t).registeredFeltStores()
	if err != nil || !reflect.DeepEqual(stores, []string{project}) || !storage.Exists() {
		t.Fatalf("project stores %v: %v", stores, err)
	}
	if _, err := os.Stat(filepath.Join(home, "felt")); !os.IsNotExist(err) {
		t.Fatal("created unnecessary default")
	}
}

func TestDaemonInstallPreviewDoesNotBootstrapStoreAndHonorsStoresEnvironment(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("SHUTTLE_STORES_FILE", filepath.Join(home, "stores.json"))
	t.Setenv("AGENT_STORES", "")
	t.Setenv("SHUTTLE_STORES", "/explicit/store")
	t.Setenv("SHUTTLE_RELEASE", writeTestDaemonRelease(t, filepath.Join(t.TempDir(), "release")).Dir)
	unsetEnv(t, "SHUTTLE_CODEX_SOCKET")
	unsetEnv(t, "CODEX_HOME")
	a := stubLoginEnv(t, loginEnv{Path: "/bin"})
	release, err := testApp(t).findDaemonRelease()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(release.Dir, "share"), 0755); err != nil {
		t.Fatal(err)
	}
	for name, source := range supervisorTemplateFixtures() {
		if err := os.WriteFile(filepath.Join(release.Dir, "share", name), []byte(source), 0600); err != nil {
			t.Fatal(err)
		}
	}
	out, stderr, err := executeApp(t, a, t.TempDir(), "daemon", "install", "--print")
	if err != nil {
		t.Fatalf("preview: %v %s", err, stderr)
	}
	if !strings.Contains(out, "/explicit/store") {
		t.Fatal("stores environment omitted")
	}
	for _, path := range []string{filepath.Join(home, "felt"), filepath.Join(home, "stores.json")} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("preview wrote %s", path)
		}
	}
}

func TestBootstrapDirectoryHonorsExplicitStore(t *testing.T) {
	t.Parallel()
	project, _ := newStore(t)
	a := newApp(testEnv(t))
	a.dir = project
	root, err := a.supervisorBootstrapDirectory()
	if err != nil || root != project {
		t.Fatalf("explicit store %q %v", root, err)
	}
	a.dir = t.TempDir()
	if _, err := a.supervisorBootstrapDirectory(); err == nil {
		t.Fatal("invalid explicit store accepted")
	}
}

func TestSupervisorPreservesInstalledFixedStores(t *testing.T) {
	for _, osName := range []string{"Darwin", "Linux"} {
		t.Run(osName, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			unsetEnv(t, "AGENT_STORES")
			unsetEnv(t, "SHUTTLE_STORES")
			unsetEnv(t, "SHUTTLE_CODEX_SOCKET")
			unsetEnv(t, "CODEX_HOME")
			path := filepath.Join(home, "Library", "LaunchAgents", "test.plist")
			source := `<plist><dict><key>EnvironmentVariables</key><dict><key>SHUTTLE_STORES</key><string>/existing/store</string></dict></dict></plist>`
			if osName == "Linux" {
				path = filepath.Join(home, ".config", "systemd", "user", systemdUnitName("test"))
				source = "[Service]\nEnvironment=\"SHUTTLE_STORES=/existing/store\"\n"
			}
			if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(source), 0600); err != nil {
				t.Fatal(err)
			}
			options := supervisorOptions{OS: osName, Label: "test"}
			if err := testApp(t).resolveSupervisorCodex(&options); err != nil {
				t.Fatal(err)
			}
			if options.Stores != "/existing/store" {
				t.Fatalf("lost installed stores %q", options.Stores)
			}
			options.Stores, options.StoresSet = "", true
			if err := testApp(t).resolveSupervisorCodex(&options); err != nil || options.Stores != "" {
				t.Fatalf("explicit empty ignored: %q %v", options.Stores, err)
			}
			options.StoresSet = false
			t.Setenv("SHUTTLE_STORES", "")
			if err := testApp(t).resolveSupervisorCodex(&options); err != nil || options.Stores != "" {
				t.Fatalf("environment reset ignored: %q %v", options.Stores, err)
			}
		})
	}
}
