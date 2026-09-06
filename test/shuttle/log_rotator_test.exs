defmodule Shuttle.LogRotatorTest do
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias Shuttle.LogRotator

  @moduletag :tmp_dir

  # Every test drives the rotator against tmp_dir files, never the real
  # ~/Library/Logs/shuttle.log or ~/.local/state/shuttle — :paths and
  # :tunnel_log_dir exist for exactly that.
  defp start_rotator(opts) do
    opts = Keyword.merge([interval_ms: :timer.hours(24), name: nil], opts)
    start_supervised!({LogRotator, opts})
  end

  defp write(path, bytes), do: File.write!(path, String.duplicate("x", bytes))

  describe "size cap" do
    test "a file over the cap is copied to .1 and truncated in place", %{tmp_dir: tmp} do
      log = Path.join(tmp, "shuttle.log")
      # Written AFTER start_rotator throughout, except where the startup pass
      # is the thing under test: the pass in init would otherwise have already
      # rotated the file by the time rotate_now/1 runs.
      pid = start_rotator(paths: [log], tunnel_log_dir: nil, max_bytes: 1_000)
      write(log, 4_000)

      %File.Stat{inode: inode_before} = File.stat!(log)

      log_output = capture_log(fn -> assert LogRotator.rotate_now(pid) == [log] end)
      assert log_output =~ "rotated #{log}"

      assert File.stat!(log).size == 0
      assert File.stat!(log <> ".1").size == 4_000
      # Truncated in place: the inode must survive, or the supervisor's
      # append-mode fd would keep writing to a file nobody reads.
      assert File.stat!(log).inode == inode_before
    end

    test "a file under the cap is untouched", %{tmp_dir: tmp} do
      log = Path.join(tmp, "shuttle.log")
      write(log, 500)

      pid = start_rotator(paths: [log], tunnel_log_dir: nil, max_bytes: 1_000)

      assert LogRotator.rotate_now(pid) == []
      assert File.stat!(log).size == 500
      refute File.exists?(log <> ".1")
    end

    test "an existing .1 is replaced, not appended to", %{tmp_dir: tmp} do
      log = Path.join(tmp, "shuttle.log")
      pid = start_rotator(paths: [log], tunnel_log_dir: nil, max_bytes: 1_000)
      File.write!(log <> ".1", String.duplicate("old", 5_000))
      write(log, 4_000)

      capture_log(fn -> assert LogRotator.rotate_now(pid) == [log] end)

      assert File.stat!(log <> ".1").size == 4_000
      refute File.read!(log <> ".1") =~ "old"
    end

    test "the startup pass caps an already-huge log without waiting a tick", %{tmp_dir: tmp} do
      log = Path.join(tmp, "shuttle.log")
      write(log, 4_000)

      capture_log(fn ->
        pid = start_rotator(paths: [log], tunnel_log_dir: nil, max_bytes: 1_000)
        # A call is ordered after the handle_continue that runs the pass.
        :sys.get_state(pid)
      end)

      assert File.stat!(log).size == 0
      assert File.stat!(log <> ".1").size == 4_000
    end
  end

  describe "tunnel logs" do
    test "every tunnel-*.log over the cap is rotated, and nothing else is", %{tmp_dir: tmp} do
      dir = Path.join(tmp, "state")
      File.mkdir_p!(dir)

      hot = Path.join(dir, "tunnel-remote-a.log")
      cold = Path.join(dir, "tunnel-remote-b.log")
      unrelated = Path.join(dir, "autossh.log")

      pid = start_rotator(paths: [], tunnel_log_dir: dir, max_bytes: 1_000)
      write(hot, 4_000)
      write(cold, 100)
      write(unrelated, 4_000)

      capture_log(fn -> assert LogRotator.rotate_now(pid) == [hot] end)

      assert File.stat!(hot).size == 0
      assert File.stat!(cold).size == 100
      assert File.stat!(unrelated).size == 4_000
    end

    test "a tunnel log added after boot is picked up on the next pass", %{tmp_dir: tmp} do
      dir = Path.join(tmp, "state")
      File.mkdir_p!(dir)

      pid = start_rotator(paths: [], tunnel_log_dir: dir, max_bytes: 1_000)
      assert LogRotator.rotate_now(pid) == []

      late = Path.join(dir, "tunnel-new-remote.log")
      write(late, 4_000)

      capture_log(fn -> assert LogRotator.rotate_now(pid) == [late] end)
      assert File.stat!(late).size == 0
    end

    test "a missing tunnel log directory is a silent no-op", %{tmp_dir: tmp} do
      dir = Path.join(tmp, "nonexistent")
      pid = start_rotator(paths: [], tunnel_log_dir: dir, max_bytes: 1_000)

      output = capture_log(fn -> assert LogRotator.rotate_now(pid) == [] end)

      assert output == ""
      assert Process.alive?(pid)
    end
  end

  describe "robustness" do
    test "a per-file failure warns, spares the rest of the pass, and does not crash the server",
         %{tmp_dir: tmp} do
      # .1 as a DIRECTORY makes :file.copy fail with :eisdir — a per-file
      # failure the rotator cannot avoid by looking first.
      broken = Path.join(tmp, "broken.log")
      healthy = Path.join(tmp, "healthy.log")

      pid = start_rotator(paths: [broken, healthy], tunnel_log_dir: nil, max_bytes: 1_000)

      write(broken, 4_000)
      File.mkdir_p!(broken <> ".1")
      write(healthy, 4_000)

      output = capture_log(fn -> assert LogRotator.rotate_now(pid) == [healthy] end)

      assert output =~ "cannot rotate #{broken}"
      # The failure did not stop the pass.
      assert File.stat!(healthy).size == 0
      assert File.stat!(healthy <> ".1").size == 4_000
      # ...nor take the process down.
      assert Process.alive?(pid)
    end

    test "a missing file is not an error", %{tmp_dir: tmp} do
      gone = Path.join(tmp, "never-existed.log")
      pid = start_rotator(paths: [gone], tunnel_log_dir: nil, max_bytes: 1_000)

      assert capture_log(fn -> assert LogRotator.rotate_now(pid) == [] end) == ""
      assert Process.alive?(pid)
    end

    test "a directory in :paths is skipped, not rotated", %{tmp_dir: tmp} do
      dir = Path.join(tmp, "a-directory")
      File.mkdir_p!(dir)

      pid = start_rotator(paths: [dir], tunnel_log_dir: nil, max_bytes: 0)

      assert LogRotator.rotate_now(pid) == []
      assert Process.alive?(pid)
      refute File.exists?(dir <> ".1")
    end
  end
end
