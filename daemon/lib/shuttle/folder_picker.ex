defmodule Shuttle.FolderPicker do
  @moduledoc """
  The host's native folder-chooser dialog: "which mechanism, if any" and "run it".

  On a host that has a desktop, the OS already ships a folder chooser the human
  knows how to drive — Finder's, GTK's, KDE's — so the Stash/Capture pickers'
  "+ Add project…" raises *that*. A host with no dialog (a remote, whose desktop
  nobody is sitting at; a headless local daemon) gets a typed absolute path
  instead.

  Three mechanisms, probed in order and never more than one per platform:

    * `:osascript` — macOS. `choose folder` inside a `tell application
      "System Events"` block whose first statement is `activate`. Without the
      activate, `osascript` runs as a background LSUIElement and its dialog
      opens *behind* the browser window, which reads as a hang; activating
      System Events first makes the process that owns the dialog frontmost.
    * `:zenity` — Linux/GTK, `--file-selection --directory`.
    * `:kdialog` — Linux/KDE, `--getexistingdirectory`.

  `mechanism/0` answers `nil` when none of them is on PATH (or the platform has
  no dialog at all), which is what lets the UI decide between the dialog and the
  path field *before* the human clicks. Force it in tests with
  `config :shuttle, :folder_picker_mechanism, :osascript | :zenity | :kdialog | :none`.

  ## Timeout

  A human is standing at the dialog, so the bound is generous — five minutes,
  via `Shuttle.Runner`'s `:timeout_ms`. None of the three mechanisms has a
  timeout of its own (`choose folder` and zenity both wait forever), so the
  bound is ours, not theirs: without it a forgotten dialog would pin a daemon
  request open indefinitely. A timeout reads as `{:error, :timeout}`, not as a
  cancellation — nothing was chosen and nothing is known.

  Returns `{:ok, abs_path}` | `:cancelled` | `{:error, reason}`, where
  `reason` is `:unavailable` when no mechanism exists.
  """

  @timeout_ms 300_000

  @applescript """
  tell application "System Events"
  \tactivate
  \tset chosen to choose folder with prompt "Choose a project folder"
  end tell
  POSIX path of chosen
  """

  # The available native mechanism, or `nil` when the host has none.
  defp mechanism do
    case Application.get_env(:shuttle, :folder_picker_mechanism) do
      nil -> detect()
      :none -> nil
      forced -> forced
    end
  end

  @doc "True when this host can raise a native folder dialog."
  @spec available?() :: boolean()
  def available?, do: mechanism() != nil

  @doc "Raise the dialog and wait for the human."
  @spec choose() :: {:ok, String.t()} | :cancelled | {:error, atom()}
  def choose do
    case mechanism() do
      nil -> {:error, :unavailable}
      mech -> mech |> run() |> interpret()
    end
  end

  defp detect do
    case :os.type() do
      {:unix, :darwin} -> if executable?("osascript"), do: :osascript, else: nil
      {:unix, _} -> Enum.find([:zenity, :kdialog], &executable?(Atom.to_string(&1)))
      _ -> nil
    end
  end

  defp executable?(name), do: System.find_executable(name) != nil

  defp run(:osascript), do: cmd("osascript", ["-e", @applescript])
  defp run(:zenity), do: cmd("zenity", ["--file-selection", "--directory"])

  defp run(:kdialog),
    do: cmd("kdialog", ["--getexistingdirectory", System.user_home() || "/"])

  defp cmd(command, args),
    do: runner().cmd(command, args, stderr_to_stdout: true, timeout_ms: @timeout_ms)

  # Exit 0 with a path is a choice; every mechanism signals cancellation with a
  # non-zero exit and no path on stdout, so an empty body behind a non-zero exit
  # IS the cancel — we do not try to parse "User canceled" out of a localized
  # stderr string.
  defp interpret({output, 0}) do
    case output |> String.split("\n", trim: true) |> List.last() do
      nil -> :cancelled
      path -> {:ok, normalize(path)}
    end
  end

  defp interpret({_output, :timeout}), do: {:error, :timeout}
  # 127 is `Shuttle.Runner`'s "not on PATH" — `mechanism/0` just said it was, so
  # the binary vanished mid-flight. Not a cancellation: report it as absence and
  # let the UI fall back to a typed path.
  defp interpret({_output, 127}), do: {:error, :unavailable}
  defp interpret({_output, _status}), do: :cancelled

  # `choose folder` yields a trailing slash on a directory; zenity/kdialog do
  # not. Registration compares paths verbatim, so normalize to the unslashed
  # form every other path in the system uses (never past "/" itself).
  defp normalize(path) do
    trimmed = String.trim(path)
    stripped = String.replace_trailing(trimmed, "/", "")
    if stripped == "", do: "/", else: stripped
  end

  defp runner, do: Application.get_env(:shuttle, :folder_picker_runner, Shuttle.Runner.Default)
end
