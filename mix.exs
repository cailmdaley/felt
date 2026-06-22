defmodule Shuttle.MixProject do
  use Mix.Project

  def project do
    [
      app: :shuttle,
      version: "0.1.0",
      elixir: "~> 1.19",
      start_permanent: Mix.env() == :prod,
      escript: escript(),
      deps: deps()
    ]
  end

  def application do
    [
      mod: {Shuttle.Application, []},
      extra_applications: [:logger]
    ]
  end

  defp escript do
    [
      main_module: Shuttle.CLI,
      name: "shuttle",
      path: "bin/shuttle",
      # Don't auto-start the Shuttle OTP application on escript boot.
      # Only `bin/shuttle start` explicitly calls Application.ensure_all_started(:shuttle).
      # Read subcommands (status, snapshot) query the running daemon over HTTP
      # and fall back to direct filesystem/tmux reads — no Poller, no orphan
      # adoption, no leaked BEAMs.
      app: nil
    ]
  end

  defp deps do
    [
      {:jason, "~> 1.4"},
      {:yaml_elixir, "~> 2.12"},
      # tz (compile-time IANA DB) over tzdata: tzdata's runtime data dir
      # resolves to a path *under* the bin/shuttle escript file (:enotdir),
      # which crashes the daemon on boot. tz bakes the data into modules —
      # no runtime data dir, safe in an escript. See finding-self-defeating-loop.
      {:tz, "~> 0.28"},
      {:phoenix, "~> 1.7"},
      {:bandit, "~> 1.0"},
      {:credo, "~> 1.7", only: [:dev, :test], runtime: false}
    ]
  end
end
