defmodule Shuttle.MixProject do
  use Mix.Project

  # The daemon's version lives here and nowhere else. The release workflow
  # stamps the pushed tag (SHUTTLE_VERSION=1.1.0-rc.1); a plain checkout —
  # `make daemon`, `mix test`, no env set at all — falls back to the literal,
  # so the developer path needs no ceremony. A leading "v" is tolerated
  # because the tag carries one and forgetting to strip it shouldn't fail the
  # build with an opaque SemVer error.
  #
  # Runtime readers must NOT come back here: a Mix release has no Mix. They
  # read `Shuttle.version/0`, which reads the .app file Mix generates FROM
  # this value — same source, available in a release.
  @version (case System.get_env("SHUTTLE_VERSION") do
              v when is_binary(v) and v != "" -> String.trim_leading(v, "v")
              _ -> "0.1.0"
            end)

  def project do
    [
      app: :shuttle,
      version: @version,
      elixir: "~> 1.19",
      start_permanent: Mix.env() == :prod,
      elixirc_paths: elixirc_paths(Mix.env()),
      releases: releases(),
      deps: deps()
    ]
  end

  # test/support holds helpers shared across test files (stubs, env
  # save/restore). Compiled only under MIX_ENV=test, so nothing there can
  # reach the release.
  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  def application do
    [
      mod: {Shuttle.Application, []},
      # :inets — FileController's If-Modified-Since parsing calls
      # :httpd_util.convert_request_date/1; without the app in the release the
      # module is absent and the first conditional GET crashes.
      extra_applications: [:logger, :inets]
    ]
  end

  # The daemon ships as a Mix release: an ERTS-bundled directory tree, built
  # per-platform in CI (`shuttle_<Os>_<arch>.tar.gz`) and by `make daemon`
  # locally (→ bin/rel). The release launcher is `bin/shuttled`; the stable
  # front door is the tracked `bin/shuttle` shim, copied into every release by
  # the :copy_support_files step so tarball and checkout expose the same verbs.
  # A release always starts the OTP application — the old escript's
  # bare-BEAM read verbs live in the shim as HTTP calls to the daemon.
  defp releases do
    [
      shuttled: [
        applications: [shuttle: :permanent],
        include_executables_for: [:unix],
        strip_beams: true,
        steps: [:assemble, &copy_support_files/1]
      ]
    ]
  end

  # Everything a release needs that Mix does not put there itself. Three
  # tracked files, copied — never forked — so a fetched tarball and a checkout
  # answer the same verbs from the same source:
  #
  #   bin/shuttle        the front-door shim (start / snapshot / install-agent …)
  #   bin/shuttle-launch the tmux respawn loop, the only durable keep-alive on
  #                      a host with no systemd user session (an HPC login
  #                      node); `shuttle install-agent` points at it when the
  #                      systemd probe fails, and it resolves its root from its
  #                      own directory, so it works unmodified in a release tree
  #   share/*.template   the launchd plist / systemd unit that
  #                      `shuttle install-agent` renders
  #
  # Not `:overlays`: overlays copy the *contents* of a directory to the release
  # root, so shipping share/ that way would either flatten the templates into
  # the root or require a second copy of them under rel/overlays/share — two
  # files to keep in sync, which is exactly what a supervisor template must
  # never be.
  defp copy_support_files(release) do
    for name <- ["shuttle", "shuttle-launch"] do
      dst = Path.join([release.path, "bin", name])
      File.cp!(Path.expand("bin/#{name}", __DIR__), dst)
      File.chmod!(dst, 0o755)
    end

    share = Path.join(release.path, "share")
    File.mkdir_p!(share)

    for src <- Path.wildcard(Path.expand("share/*.template", __DIR__)) do
      File.cp!(src, Path.join(share, Path.basename(src)))
    end

    release
  end

  defp deps do
    [
      {:jason, "~> 1.4"},
      {:yaml_elixir, "~> 2.12"},
      # tz (compile-time IANA DB) over tzdata. Forced by the escript era:
      # tzdata's runtime data dir resolved to a path *under* the bin/shuttle
      # escript file (:enotdir), crashing the daemon on boot — see
      # finding-self-defeating-loop. A release has a real priv dir, so that
      # particular crash is history; tz stays right anyway, because the DB is
      # baked into modules and there is no runtime data dir to ship, write, or
      # refresh.
      {:tz, "~> 0.28"},
      {:phoenix, "~> 1.7"},
      {:bandit, "~> 1.0"},
      {:credo, "~> 1.7", only: [:dev, :test], runtime: false}
    ]
  end
end
