defmodule Shuttle.Projects do
  @moduledoc """
  The curated picker-project list — the Stash/Capture "city" set a human files
  new work into.

  Deliberately **separate** from `Shuttle.FeltStores`. The two lists answer two
  different questions and must not be conflated:

    * **poll-stores** (`FeltStores`) — where the daemon *enumerates* fibers. On
      macOS this is scoped to `~/loom` (outside `~/Documents`) so the daemon
      never reads Full-Disk-Access / TCC-protected paths; substores are reached
      by following the symlinks under `loom/.felt/`.
    * **picker-projects** (this module) — which project *checkouts* a human can
      file into. These live under `~/Documents/projects/*` (and remotes' own
      trees), the very TCC-protected paths the poll list stays out of.

  Reusing one list for both drags polling into TCC-protected territory (the bug
  this split exists to prevent). So the picker gets its own file.

  Source: `~/.config/felt/projects.json` →
  `%{"version" => 1, "projects" => [absolute path, ...]}` (a bare JSON array is
  also accepted). Absent/empty file → `[]`, and the forms fall back to their
  store-registry + current-cards derivation, so an uncurated host is never worse
  off than before. Hand-editable; the owning host serves it via
  `/api/v1/felt-stores` (`origins.<host>.projects`).
  """

  alias Shuttle.PathListConfig

  @spec_ %{
    env: "FELT_PROJECTS",
    config_env: "FELT_PROJECTS_FILE",
    default_path: "~/.config/felt/projects.json",
    json_key: "projects"
  }

  @type project_list :: [String.t()]

  @doc """
  The curated project directories for this host, in file order (de-duplicated).

  Resolution: `FELT_PROJECTS` env (comma-separated) when set, else the persisted
  `~/.config/felt/projects.json`. Empty everywhere → `[]`.
  """
  @spec configured_projects() :: project_list()
  def configured_projects, do: PathListConfig.configured(@spec_)

  @spec registered_projects() :: project_list()
  def registered_projects, do: PathListConfig.registered(@spec_)

  @doc """
  Persist the curated project list, atomically. An empty list deletes the file.
  Returns `{:ok, normalized}` or `{:error, reason}`.
  """
  @spec save(project_list()) :: {:ok, project_list()} | {:error, term()}
  def save(projects) when is_list(projects), do: PathListConfig.save(@spec_, projects)

end
