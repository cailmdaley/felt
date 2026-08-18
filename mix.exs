defmodule Shuttle.MixProject do
  use Mix.Project

  def project do
    [
      app: :shuttle,
      version: "0.1.0",
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
  # the :copy_cli_shim step so tarball and checkout expose the same verbs.
  # A release always starts the OTP application — the old escript's
  # bare-BEAM read verbs live in the shim as HTTP calls to the daemon.
  defp releases do
    [
      shuttled: [
        applications: [shuttle: :permanent],
        include_executables_for: [:unix],
        strip_beams: true,
        steps: [:assemble, &copy_cli_shim/1]
      ]
    ]
  end

  defp copy_cli_shim(release) do
    src = Path.expand("bin/shuttle", __DIR__)
    dst = Path.join([release.path, "bin", "shuttle"])
    File.cp!(src, dst)
    File.chmod!(dst, 0o755)
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
