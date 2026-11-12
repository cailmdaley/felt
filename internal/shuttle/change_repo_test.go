package shuttle

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestBuildChangeRepositoryIdentityRealGit(t *testing.T) {
	t.Parallel()
	env := testEnv(t)
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	env.Set("PATH", filepath.Dir(gitPath))
	env.Set("GIT_CONFIG_NOSYSTEM", "1")
	env.Set("GIT_CONFIG_GLOBAL", os.DevNull)
	repo := filepath.Join(t.TempDir(), "main-repository")
	if err := os.Mkdir(repo, 0755); err != nil {
		t.Fatal(err)
	}
	git := func(args ...string) {
		t.Helper()
		out, err := env.Command("git", append([]string{"-C", repo}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %s: %v", args, out, err)
		}
	}
	git("init", "-b", "main")
	git("config", "user.name", "Change Author")
	git("config", "user.email", "author@example.invalid")
	git("commit", "--allow-empty", "-m", "base")
	worktree := filepath.Join(t.TempDir(), "feature-worktree")
	git("worktree", "add", "-b", "topic", worktree)
	check := func(name, forge string) {
		t.Helper()
		c, _, err := BuildChange(env, worktree, "main", "HEAD", nil)
		if err != nil {
			t.Fatal(err)
		}
		if c.Repo.Name != name || c.Repo.Dir != worktree {
			t.Fatalf("repository: %+v", c.Repo)
		}
		if forge == "" {
			if c.Repo.ForgeURL != nil {
				t.Fatalf("unexpected forge URL: %s", *c.Repo.ForgeURL)
			}
		} else if c.Repo.ForgeURL == nil || *c.Repo.ForgeURL != forge {
			t.Fatalf("forge URL: %+v, want %s", c.Repo, forge)
		}
	}
	check("main-repository", "")
	git("config", "remote.origin.url", "git@github.com:example/real-repo.git")
	check("real-repo", "https://github.com/example/real-repo")
	git("config", "--unset", "remote.origin.url")
	check("main-repository", "")
}

func TestChangeOriginNamesRepositoryAndForge(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct{ origin, name, forge string }{
		{"git@github.com:example/real-repo.git", "real-repo", "https://github.com/example/real-repo"},
		{"git@gitlab.com:group/subgroup/real-repo.git", "real-repo", "https://gitlab.com/group/subgroup/real-repo"},
		{"http://github.com/example/web-repo.git/", "web-repo", "https://github.com/example/web-repo"},
		{"https://gitlab.com/group/web-repo", "web-repo", "https://gitlab.com/group/web-repo"},
		{"https://user:password@gitlab.example:8443/group/private-repo.git?token=secret", "private-repo", "https://gitlab.example:8443/group/private-repo"},
		{"ssh://git@github.com/example/ssh-repo.git", "ssh-repo", ""},
		{"/srv/git/local-repo.git", "local-repo", ""},
	} {
		name, forge := changeOrigin(tc.origin)
		got := ""
		if forge != nil {
			got = *forge
		}
		if name != tc.name || got != tc.forge {
			t.Errorf("changeOrigin(%q) = %q, %q; want %q, %q", tc.origin, name, got, tc.name, tc.forge)
		}
	}
}
