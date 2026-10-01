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
  # per-platform in CI (`shuttled_<Os>_<arch>.tar.gz`) and by `make daemon`
  # locally (→ bin/rel). The release launcher is `bin/shuttled`; the Go
  # `shuttle` CLI owns daemon lifecycle commands and is installed beside `felt`.
  # A release always starts the OTP application.
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

  # The release carries the tmux respawn loop and supervisor templates. Copy
  # these tracked sources so a fetched release and a checkout use the same
  # keep-alive behavior:
  #
  #   bin/shuttle-launch the tmux respawn loop used when no systemd user
  #                      session is available
  #   share/*.template   the launchd plist / systemd unit rendered by
  #                      `shuttle daemon install`
  #
  # Copy templates into share/ explicitly; Mix overlays copy directory contents
  # to the release root and would place them at the wrong path.
  defp copy_support_files(release) do
    launch = Path.join([release.path, "bin", "shuttle-launch"])
    File.cp!(Path.expand("../bin/shuttle-launch", __DIR__), launch)
    File.chmod!(launch, 0o755)

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
      # `tz` supplies the IANA rules used by scheduled work. The daemon
      # registers Tz.TimeZoneDatabase on every boot path, so timezone shifts
      # do not fall back to the UTC-only database.
      {:tz, "~> 0.28"},
      {:phoenix, "~> 1.7"},
      {:bandit, "~> 1.0"},
      # The phone page's audio relay is a WebSock handler upgraded on Bandit.
      {:websock_adapter, "~> 0.5"},
      {:credo, "~> 1.7", only: [:dev, :test], runtime: false}
    ]
  end
end
