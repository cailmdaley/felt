defmodule Shuttle.ConfigFiles do
  @moduledoc """
  The operator files, as one addressable set — so a surface that is not a shell
  can read and rewrite them.

  Everything shuttle can be told about a host lives in four JSON files under
  `~/.config/felt/`, and until the board grew a settings page the only way to
  turn one of those knobs was an editor on the machine that owns it. That was
  fine while the board was something you opened beside a terminal. It stopped
  being fine once the board became reachable from a phone and from a second
  hub: the surface that steers the fleet cannot be the one surface that cannot
  configure it.

  | id | file | what it says |
  |---|---|---|
  | `:stores` | `stores.json` | which felt stores the daemon polls |
  | `:projects` | `projects.json` | which checkouts the Stash/Capture pickers offer |
  | `:agents` | `agents.json` | this host's layer over the shipped agent registry |
  | `:remotes` | `remotes.json` | the remote daemons this host aggregates |

  ## Text, not a model

  This module reads and writes each file's **bytes**. It deliberately does not
  parse a file into a structure, let the caller edit the structure, and encode
  it back: that round trip silently drops every key the structure does not know
  about, which is exactly the loss `Shuttle.Remotes` warns against — "the fleet
  is operator setup a UI round-trip must never clobber". `remotes.json` carries
  `auth`, `ssh_flags`, per-entry timeouts and `tunnel.label`, none of which the
  CLI's own `remotes add` flags can express; a text edit cannot lose them
  because nothing ever re-encoded them.

  The two path-list files (`stores.json`, `projects.json`) are flat lists of
  strings, so their structured writers (`Shuttle.FeltStores.save/1`,
  `Shuttle.Projects.save/1`) stay the right tool for adding and dropping a
  path. This module is the escape hatch that makes "all of the configuration"
  true rather than "the configuration we built a form for".

  ## Validation belongs to whoever owns the grammar

  A write is refused unless the tool that *reads* the file for real accepts it
  first. The candidate bytes go to a temporary file, the owning reader is
  pointed at that file through its own path-override environment variable, and
  only a clean exit commits:

    * `:remotes` → `felt shuttle remotes list --json` under `FELT_REMOTES_FILE`
      — the CLI that is already the fleet file's sole writer, and whose `list`
      verb is documented as its validator (duplicate names, port collisions,
      an unparseable `defaults.https_proxy`, a managed tunnel with no port).
    * `:agents` → `felt shuttle agents --json` under `FELT_AGENTS_FILE` — which
      fails loud on an unsupported `version` or an unknown `builtins` mode.
    * `:stores` / `:projects` → checked here, against the shape
      `Shuttle.PathListConfig` actually accepts, because no CLI verb reads them.

  So the daemon never grows a second opinion about what a valid fleet file is.
  It grows one opinion about *when* to ask, and asks felt.

  ## What this module will not touch

  `~/.shuttle/host` — the host identity — is readable here and deliberately not
  writable. The daemon freezes its own host id once per boot into
  `:persistent_term`, so a value rewritten under a live daemon would take
  effect for the CLI and not for the process dispatching work, and the two
  disagreeing about who this machine is is the worst failure this system has.
  Changing it is a stop-edit-start, which is a shell's job.
  """

  alias Shuttle.{Felt, FeltStores, Projects, Remotes}

  require Logger

  @type id :: :stores | :projects | :agents | :remotes

  @ids [:stores, :projects, :agents, :remotes]

  @doc "Every writable operator file's id, in the order a settings page reads."
  @spec ids() :: [id()]
  def ids, do: @ids

  @doc """
  Resolve a wire string to an id, or `:error`.

  The wire names match the files' own stems, so a route reads
  `/api/v1/config/remotes` rather than carrying a second vocabulary.
  """
  @spec parse_id(String.t()) :: {:ok, id()} | :error
  def parse_id("stores"), do: {:ok, :stores}
  def parse_id("projects"), do: {:ok, :projects}
  def parse_id("agents"), do: {:ok, :agents}
  def parse_id("remotes"), do: {:ok, :remotes}
  def parse_id(_), do: :error

  @doc """
  Where a file resolves on this host, exactly as its own reader resolves it —
  each one's `*_FILE` environment override, else `~/.config/felt/<stem>.json`.

  Three of the four delegate to the module that already answers this, so a
  settings page can never show a path the daemon is not in fact reading.
  """
  @spec path(id()) :: String.t()
  def path(:remotes), do: Remotes.config_path()
  def path(:stores), do: FeltStores.config_path()
  def path(:projects), do: Projects.config_path()

  def path(:agents) do
    case System.get_env("FELT_AGENTS_FILE") do
      value when is_binary(value) and value != "" -> Path.expand(value)
      _ -> Path.expand("~/.config/felt/agents.json")
    end
  end

  @doc """
  One line per file: where it is, whether it exists, how big, when it last
  moved, and whether anything is overriding it.

  A file that does not exist is not an error — three of the four are optional
  by design (an absent `remotes.json` is a correct local-only daemon), so
  `exists: false` is a state to render, not a failure to report.
  """
  @spec index() :: [map()]
  def index, do: Enum.map(@ids, &summary/1)

  @doc """
  One file's `index/0` row, including the `digest` a caller sends back to prove
  it is replacing the bytes it read.
  """
  @spec summary(id()) :: map()
  def summary(id) do
    path = path(id)

    base =
      case File.stat(path, time: :posix) do
        {:ok, %File.Stat{size: size, mtime: mtime}} ->
          %{id: id, path: path, exists: true, size: size, updated_at: mtime}

        _ ->
          %{id: id, path: path, exists: false, size: 0, updated_at: nil}
      end

    base
    |> Map.put(:env_override, env_override(id))
    |> Map.put(:digest, digest(id))
  end

  @doc """
  The two path-list files as a LIST, parsed by the reader that owns them.

  `nil` for `:agents` and `:remotes`, whose contents are not a list of paths.

  It exists so a structured editor can read the authoritative current list from
  the host that owns it, rather than from the hub's cached origins feed. That
  feed reports an empty list for a remote it has not yet heard from — which a
  whole-list write would then persist, replacing that host's registry with
  whatever single row the caller had typed. A list read off the file cannot say
  "empty" about a host that never answered: the read either works or fails.
  """
  @spec entries(id()) :: [String.t()] | nil
  def entries(:stores), do: FeltStores.registered_hosts()
  def entries(:projects), do: Projects.registered_projects()
  def entries(_), do: nil

  @doc """
  Check a caller's `expected_digest` against the file as it is now, without
  writing anything.

  Public so the two STRUCTURED list endpoints can take the same precondition
  the text editor does. Nothing else would explain why one half of a section is
  protected from a concurrent writer and the other half is not.
  """
  @spec check_digest(id(), String.t() | nil | :any) :: :ok | {:conflict, String.t()}
  def check_digest(id, expected), do: check_expected(id, expected)

  @doc """
  A content hash of the file as it is right now, or `nil` when it does not
  exist.

  The board is reachable from two hubs and a phone at the same time, so "this
  file has not changed since I read it" is a real question here rather than a
  theoretical one — an editor left open on a phone while `felt shuttle remotes
  add` runs on the laptop would otherwise save the old text back over the new
  entry, silently.

  A hash rather than an mtime: POSIX mtime is second-granular, so a write
  landing in the same second as the read is invisible to it, and that is
  precisely the interleaving a fast tool produces.
  """
  @spec digest(id()) :: String.t() | nil
  def digest(id) do
    case File.read(path(id)) do
      {:ok, content} -> hash(content)
      _ -> nil
    end
  end

  defp hash(content), do: :crypto.hash(:sha256, content) |> Base.encode16(case: :lower)

  # The one way this page could lie. Both path-list files have a compact
  # comma-separated environment form that wins over the file ENTIRELY when it
  # is set — so a host started with `FELT_STORES=...` polls that list while
  # `stores.json` sits on disk being read by nobody. An editor that showed the
  # file without saying so would let you carefully fix a setting that has no
  # effect, which is worse than having no editor.
  #
  # The fleet and agent files have no such form (deliberately, in both cases:
  # a structured entry has no comma grammar), so they never override.
  defp env_override(id) when id in [:stores, :projects] do
    var = if id == :stores, do: "FELT_STORES", else: "FELT_PROJECTS"

    case System.get_env(var) do
      value when is_binary(value) and value != "" -> %{var: var, value: value}
      _ -> nil
    end
  end

  defp env_override(_), do: nil

  @doc """
  A file's bytes, plus its `summary/0` row.

  An absent file reads as empty text rather than an error, so the editor opens
  on a blank page you can fill in instead of on a refusal. An unreadable one
  (a permission problem, a directory in its place) is a real error and says so.
  """
  @spec read(id()) :: {:ok, map()} | {:error, String.t()}
  def read(id) do
    path = path(id)

    cond do
      not File.exists?(path) ->
        {:ok, summary(id) |> Map.put(:text, "") |> Map.put(:entries, entries(id))}

      true ->
        case File.read(path) do
          # The digest is of THESE bytes, not of a second read. `summary/1`
          # would hash the file again, and a write landing between the two
          # reads would hand the caller old text under the new file's digest —
          # which its next save would then pass cleanly, overwriting the newer
          # bytes. That is exactly the outcome the digest exists to prevent, so
          # the guarantee must not have a hole where it is issued.
          {:ok, text} ->
            {:ok,
             summary(id)
             |> Map.put(:text, text)
             |> Map.put(:digest, hash(text))
             |> Map.put(:entries, entries(id))}

          {:error, reason} ->
            {:error, "#{path}: #{:file.format_error(reason)}"}
        end
    end
  end

  @doc """
  Replace a file's contents, once its own reader has accepted the candidate.

  Empty (or whitespace-only) text **removes** the file. That is the same
  vocabulary the two structured writers already speak — `PathListConfig.save/2`
  deletes on `[]`, and the Go CLI deletes `remotes.json` when the last remote
  goes — and it is the only way to say "this host has no fleet" from a surface
  with no shell.

  The write itself is tmp + rename inside the file's own directory, so a
  reader polling the path sees either the old bytes or the new ones and never
  a half-written file. Every reader here polls: `Shuttle.RemoteRegistry` stats
  the fleet file every second. The staging name carries a unique suffix, so
  two writers racing on one file cannot rename each other's bytes into place —
  see `commit/2`.
  """
  @spec write(id(), String.t(), keyword()) ::
          {:ok, map()}
          | {:error, String.t()}
          | {:conflict, String.t()}
          | {:unavailable, String.t()}
  def write(id, text, opts \\ []) when is_binary(text) do
    with :ok <- check_expected(id, Keyword.get(opts, :expected_digest, :any)) do
      if String.trim(text) == "" do
        remove(id)
      else
        with :ok <- validate(id, text), do: commit(id, text)
      end
    end
  end

  # `:any` is an editor that did not tell us what it read — a script, an older
  # client — and it keeps the old last-write-wins behaviour rather than being
  # refused. A caller that DID send a digest is asking to be stopped, and the
  # refusal names the situation rather than the hashes, which are no use to
  # anybody reading them.
  defp check_expected(_id, :any), do: :ok

  defp check_expected(id, expected) do
    case digest(id) do
      ^expected ->
        :ok

      nil when expected in [nil, ""] ->
        :ok

      nil ->
        {:conflict, "#{path(id)} was deleted since you opened it. Reload before saving."}

      _ ->
        {:conflict,
         "#{path(id)} changed since you opened it. Reload to see the new contents — saving now would overwrite them."}
    end
  end

  @doc """
  Check candidate bytes without writing them — the same gate `write/2` runs.

  `:ok` or `{:error, message}`, where the message is the owning reader's own
  words. felt names the file and the offending entry; repeating that verbatim
  is more use than any sentence this module could compose about it.
  """
  @spec validate(id(), String.t()) :: :ok | {:error, String.t()} | {:unavailable, String.t()}
  def validate(id, text) when is_binary(text) do
    case Jason.decode(text) do
      {:ok, decoded} -> validate_decoded(id, text, decoded)
      {:error, %Jason.DecodeError{} = error} -> {:error, "not valid JSON: #{Exception.message(error)}"}
    end
  end

  # ── Per-file validation ──────────────────────────────────────────────────

  # The two CLI-owned grammars go to the tool that reads them. The candidate is
  # written to a temp file and the reader is pointed at it by the same
  # environment variable a human would use, so what passes here is exactly what
  # the daemon and the CLI will read back off disk a moment later.
  defp validate_decoded(:remotes, text, _decoded),
    do: validate_via_felt(text, "FELT_REMOTES_FILE", ["shuttle", "remotes", "list", "--json"])

  defp validate_decoded(:agents, text, _decoded),
    do: validate_via_felt(text, "FELT_AGENTS_FILE", ["shuttle", "agents", "--json"])

  # No CLI verb reads the path-list files, so the shape check lives here — and
  # it is the shape `PathListConfig` accepts, not a stricter one. In particular
  # a bare JSON array is valid: both readers take it, and refusing it here
  # would reject a file the daemon then happily polls.
  defp validate_decoded(id, _text, decoded) when id in [:stores, :projects] do
    key = json_key(id)

    case decoded do
      %{^key => paths} when is_list(paths) -> all_strings(paths, key)
      paths when is_list(paths) -> all_strings(paths, key)
      %{} -> {:error, ~s(expected an object with a "#{key}" array, or a bare array of paths)}
      _ -> {:error, ~s(expected an object with a "#{key}" array, or a bare array of paths)}
    end
  end

  defp all_strings(paths, key) do
    case Enum.find_index(paths, &(not is_binary(&1))) do
      nil -> :ok
      index -> {:error, ~s("#{key}"[#{index}] is not a string — every entry must be a path)}
    end
  end

  defp json_key(:stores), do: "felt_stores"
  defp json_key(:projects), do: "projects"

  # Run felt against a throwaway copy of the candidate. The env entry is an
  # override on the inherited environment (Port semantics), so felt keeps its
  # PATH and everything else and reads only this one file from somewhere else.
  defp validate_via_felt(text, env_var, args) do
    with {:ok, tmp} <- write_temp(text) do
      try do
        case Felt.run(args, env: [{env_var, tmp}], timeout_ms: 15_000) do
          {:ok, _output} ->
            :ok

          # THE WORLD DIDN'T ANSWER, which `Shuttle.Runner` warns is never
          # evidence of absence. A wedged felt on a loaded login node, and a
          # felt missing from a supervised daemon's PATH (the Runner maps that
          # to the shell's 127 rather than raising), are both failures of this
          # machine. Reported as a refusal they would arrive in the box that
          # means "your JSON is wrong", about bytes that may be perfectly good.
          {:command_error, :timeout, _output} ->
            {:unavailable,
             "the validator did not answer within 15s on this host, so the edit was not saved. " <>
               "Nothing is wrong with what you wrote; try again."}

          {:command_error, 127, _output} ->
            {:unavailable,
             "felt is not on this daemon's PATH, so there is nothing here that can validate " <>
               "this file. The edit was not saved."}

          {:command_error, _status, output} ->
            {:error, output |> scrub_path(tmp) |> String.trim()}

          {:error, reason} when is_binary(reason) ->
            {:unavailable, "could not run felt to validate: #{reason}"}
        end
      after
        File.rm(tmp)
      end
    end
  end

  # The candidate is written 0600 into a 0700 directory, because `remotes.json`
  # can carry an `auth` key and this daemon may be running on a shared login
  # node where `$TMPDIR` is `/tmp`. A validator's scratch file should not be the
  # thing that publishes a fleet's credentials to everyone with an account.
  defp write_temp(text) do
    dir = Path.join(System.tmp_dir!(), "shuttle-config-check")
    path = Path.join(dir, "#{System.unique_integer([:positive])}.json")

    with :ok <- File.mkdir_p(dir),
         :ok <- File.chmod(dir, 0o700),
         :ok <- File.write(path, text),
         :ok <- File.chmod(path, 0o600) do
      {:ok, path}
    else
      {:error, reason} ->
        {:unavailable,
         "could not stage the candidate for validation: #{:file.format_error(reason)}"}
    end
  end

  # felt names the file it was reading, and the file it was reading is our
  # temporary copy — a path the human has never seen and cannot act on.
  #
  # The replacement is positional, not textual, and that distinction is load
  # bearing. Stripping `"<tmp>: "` anywhere it appears works for the fleet
  # validator, whose path leads the line, and MANGLES the agent one, whose
  # path sits mid-sentence: `parsing <tmp>: unsupported version 99` became
  # `parsing unsupported version 99`, eating the colon that held the sentence
  # together. So only a LEADING occurrence is stripped; anywhere else the path
  # is replaced by a name, leaving the grammar around it intact.
  defp scrub_path(output, tmp) do
    output
    |> String.split("\n")
    |> Enum.map_join("\n", fn line ->
      line
      |> String.replace_prefix(tmp <> ": ", "")
      |> String.replace(tmp, "the file")
    end)
  end

  # ── Writing ──────────────────────────────────────────────────────────────

  # The staging name is unique per write, not `<path>.tmp`.
  #
  # A fixed name is only atomic against a reader. Against a second WRITER it is
  # worse than no staging at all: A stages its bytes, B overwrites the same
  # staging file, A renames — and B's bytes land under A's write, with both
  # calls reporting success. `expected_digest` cannot catch it, because at the
  # moment both writers check, neither has committed and both digests are
  # legitimately current. That interleaving is exactly the one this surface
  # invites, since the same file is now reachable from two hubs and a phone.
  defp commit(id, text) do
    path = path(id)
    tmp = "#{path}.tmp.#{System.unique_integer([:positive])}"

    with :ok <- File.mkdir_p(Path.dirname(path)),
         :ok <- File.write(tmp, text),
         :ok <- File.rename(tmp, path) do
      Logger.info("ConfigFiles: wrote #{path} (#{byte_size(text)} bytes)")
      # The digest is of the bytes just written, NOT of a fresh read — the same
      # hole `read/1` closes, at the other end. A writer landing between the
      # rename and a re-read would hand this caller its own text under someone
      # else's digest, and the caller stores that pair as its new base: the
      # next save would then pass the precondition and overwrite bytes it never
      # saw. An editor's guarantee cannot have a gap at the moment it is issued.
      {:ok,
       summary(id)
       |> Map.put(:text, text)
       |> Map.put(:digest, hash(text))
       |> Map.put(:entries, entries(id))}
    else
      {:error, reason} ->
        File.rm(tmp)
        {:error, "#{path}: #{:file.format_error(reason)}"}
    end
  end

  defp remove(id) do
    path = path(id)

    case File.rm(path) do
      :ok ->
        Logger.info("ConfigFiles: removed #{path}")
        {:ok, summary(id) |> Map.put(:text, "") |> Map.put(:digest, nil) |> Map.put(:entries, entries(id))}

      {:error, :enoent} ->
        {:ok, summary(id) |> Map.put(:text, "") |> Map.put(:digest, nil) |> Map.put(:entries, entries(id))}

      {:error, reason} ->
        {:error, "#{path}: #{:file.format_error(reason)}"}
    end
  end
end
