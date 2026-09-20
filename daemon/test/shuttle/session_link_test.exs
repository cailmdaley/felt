defmodule Shuttle.SessionLinkTest do
  @moduledoc """
  `Shuttle.SessionLink` — the claude.ai bridge URL a remote-controlled Claude
  Code session writes into its own transcript, read from a fixture tree shaped
  like `~/.claude/projects/<cwd-slug>/<uuid>.jsonl`.
  """
  use ExUnit.Case, async: true

  alias Shuttle.SessionLink

  @session "a3edf873-cb1c-40ab-a891-f26f5333b320"
  @unbridged "fef866ba-b397-4277-a01b-16fcecc2b256"
  @first "https://claude.ai/code/session_01FIRST"
  @last "https://claude.ai/code/session_01LAST"

  test "desktop app routes accept only a bare thread UUID and are separate from mobile links" do
    assert SessionLink.desktop_url(@session) == "codex://threads/" <> @session

    for invalid <- [
          nil,
          "",
          "not-a-uuid",
          @session <> "?host=other",
          @session <> "/../new",
          @session <> "\n"
        ] do
      assert SessionLink.desktop_url(invalid) == nil
    end
  end

  defp bridge(url),
    do: %{"type" => "user", "attachment" => %{"type" => "remote_session_change", "url" => url}}

  defp write_tree(files) do
    root = Path.join(System.tmp_dir!(), "shuttle_link_#{System.unique_integer([:positive])}")
    dir = Path.join(root, "-Users-cail-felt")
    File.mkdir_p!(dir)

    Enum.each(files, fn {session, records} ->
      body =
        records
        |> Enum.map(fn
          line when is_binary(line) -> line
          record -> Jason.encode!(record)
        end)
        |> Enum.join("\n")

      File.write!(Path.join(dir, "#{session}.jsonl"), body <> "\n")
    end)

    on_exit(fn -> File.rm_rf(root) end)
    root
  end

  defp default_tree do
    write_tree([
      {@session,
       [
         %{"type" => "user", "message" => %{"content" => "hello"}},
         bridge(@first),
         "{ not json",
         # Prose that mentions the marker is not a record of it.
         %{"type" => "assistant", "message" => %{"content" => "remote_session_change happened"}},
         bridge(@last),
         %{"type" => "user", "attachment" => %{"type" => "remote_session_change", "url" => 7}}
       ]},
      {@unbridged, [%{"type" => "user", "message" => %{"content" => "never bridged"}}]}
    ])
  end

  test "the last well-formed bridge record wins" do
    assert SessionLink.remote_url(@session, root: default_tree()) == @last
  end

  test "no bridge record, or no transcript → nil" do
    root = default_tree()
    assert SessionLink.remote_url(@unbridged, root: root) == nil
    assert SessionLink.remote_url("00000000-0000-0000-0000-000000000000", root: root) == nil
  end

  test "cached_url reads the transcript once and remembers the answer" do
    root = default_tree()
    session = "1234abcd-0000-4000-8000-000000000001"
    on_exit(fn -> SessionLink.forget(session) end)

    write_tree([{session, [bridge(@first)]}]) |> then(fn r -> File.rm_rf(r) end)
    dir = Path.join(root, "-Users-cail-felt")
    File.write!(Path.join(dir, "#{session}.jsonl"), Jason.encode!(bridge(@first)) <> "\n")

    assert SessionLink.cached_url(session, root: root) == @first
    # The file changing underneath does not move a remembered link: it is
    # stable for the life of the session, and the poller must not re-read.
    File.write!(Path.join(dir, "#{session}.jsonl"), Jason.encode!(bridge(@last)) <> "\n")
    assert SessionLink.cached_url(session, root: root) == @first
  end

  test "a session with no link yet is asked again later, not remembered as nil forever" do
    root = default_tree()
    on_exit(fn -> SessionLink.forget(@unbridged) end)
    assert SessionLink.cached_url(@unbridged, root: root) == nil
    # Within the retry window the miss is served from memory.
    assert :persistent_term.get({SessionLink, @unbridged}) |> elem(0) == nil
    # A miss records when it FIRST missed, so the young window survives re-checks.
    assert :persistent_term.get({SessionLink, @unbridged}) |> tuple_size() == 3
  end

  # ── retry cadence ──────────────────────────────────────────────────────────
  #
  # The cadence is wall-clock, so these seed the memo directly with a synthetic
  # `{nil, checked_at, first_miss_at}` rather than sleeping. The fixture always
  # HAS a link on disk: whether `cached_url` returns it is exactly the question
  # of whether the miss was due for a re-check.

  defp bridged_session(root) do
    session =
      "1234abcd-0000-4000-8000-" <>
        String.pad_leading("#{System.unique_integer([:positive])}", 12, "0")

    on_exit(fn -> SessionLink.forget(session) end)

    File.write!(
      Path.join([root, "-Users-cail-felt", "#{session}.jsonl"]),
      Jason.encode!(bridge(@last)) <> "\n"
    )

    session
  end

  defp seed_miss(session, checked_ago_ms, first_miss_ago_ms) do
    now = System.monotonic_time(:millisecond)

    :persistent_term.put(
      {SessionLink, session},
      {nil, now - checked_ago_ms, now - first_miss_ago_ms}
    )
  end

  test "a young session's miss is re-checked within seconds" do
    root = default_tree()
    session = bridged_session(root)
    # First miss 4s ago, last checked 4s ago — past the 3s young retry.
    seed_miss(session, 4_000, 4_000)
    assert SessionLink.cached_url(session, root: root) == @last
  end

  test "a young session's miss inside the young retry is still served from memory" do
    root = default_tree()
    session = bridged_session(root)
    seed_miss(session, 1_000, 1_000)
    assert SessionLink.cached_url(session, root: root) == nil
  end

  test "past the young window the miss settles back to the minute retry" do
    root = default_tree()
    session = bridged_session(root)
    # First missed 6 minutes ago (old), last checked 10s ago — under 60s.
    seed_miss(session, 10_000, 360_000)
    assert SessionLink.cached_url(session, root: root) == nil

    # ... and is re-read once the minute is up.
    seed_miss(session, 70_000, 360_000)
    assert SessionLink.cached_url(session, root: root) == @last
  end

  test "a found link is never re-read, however young the session" do
    root = default_tree()
    session = bridged_session(root)
    assert SessionLink.cached_url(session, root: root) == @last
    File.rm!(Path.join([root, "-Users-cail-felt", "#{session}.jsonl"]))
    assert SessionLink.cached_url(session, root: root) == @last
  end
end
