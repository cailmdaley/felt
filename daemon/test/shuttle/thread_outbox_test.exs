defmodule Shuttle.ThreadOutboxTest do
  use ExUnit.Case, async: true
  @moduletag :tmp_dir

  setup %{tmp_dir: dir} do
    Shuttle.Test.Env.own_scope!()
    data = Path.join(dir, "data")
    File.mkdir_p!(data)
    Shuttle.Test.Env.put_env("SHUTTLE_DATA_DIR", data)
    assert :ok = Shuttle.ThreadOutbox.boot_baseline()
    {:ok, data: data}
  end

  test "pruned acknowledgments cannot be replayed beyond the 14-day cutoff", %{data: data} do
    alias Shuttle.ThreadOutbox

    stamp = DateTime.utc_now() |> DateTime.to_iso8601()

    record = %{
      "owner" => "host",
      "text" => "expired result",
      "signal" => %{"stamp" => stamp}
    }

    assert :ok = ThreadOutbox.capture([{"old-result", record}])
    assert :ok = ThreadOutbox.acknowledge("old-result")
    [ack_path] = Path.wildcard(Path.join(data, "thread-outbox/acked/*"))

    {:ok, stamp_date, _} = DateTime.from_iso8601(stamp)
    cutoff = stamp_date |> DateTime.add(1, :second) |> DateTime.to_iso8601()
    File.write!(Path.join(data, "thread-outbox/retention_cutoff"), cutoff)

    expiry =
      stamp_date
      |> DateTime.add(-24 * 60 * 60, :second)
      |> DateTime.to_naive()
      |> NaiveDateTime.to_erl()

    assert :ok = File.touch(ack_path, expiry)
    assert :ok = ThreadOutbox.boot_baseline()
    refute File.exists?(ack_path)

    # The durable cutoff rejects this exact signal after its tombstone is gone.
    assert :ok = ThreadOutbox.capture([{"old-result", record}])
    assert ThreadOutbox.pending("host") == []
    assert Path.wildcard(Path.join(data, "thread-outbox/pending/*")) == []
  end
end
