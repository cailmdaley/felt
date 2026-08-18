defmodule Shuttle.FeltStores.ScanRoster do
  @moduledoc """
  Who is walking which felt store, right now — the bookkeeping behind
  `Shuttle.FeltStores`' single-flight scan.

  This exists because the obvious storage does not work. The roster was a list
  in `:persistent_term`, and every claim on it was a read-modify-write from
  whichever process happened to ask: read the list, decide, write the list back.
  Under concurrency that decides from a stale read. Measured: twenty simultaneous
  `configured_hosts/0` calls on ONE store list started **twenty** scans, and the
  roster never listed more than one of them. A board load fires several API calls
  at once, so that is not a synthetic burst — and on a store parked behind a
  macOS consent dialog, twenty parked walks against the VM's ten dirty IO
  schedulers is the dead node this whole design exists to avoid, reached in
  seconds rather than in the ten minutes a re-probing timer would have taken.

  An ETS set keyed by the store list fixes it, because `:ets.insert_new/2` is a
  single atomic operation: exactly one caller in any burst wins the key, and the
  losers learn a scan is already running. No process is asked anything — a
  serializing GenServer would be a mailbox a caller could queue behind, and the
  point is that claiming must never block.

  ## What is guaranteed and what is not

  **One scan per store list, always.** That is the `insert_new` guarantee, and it
  is the one that matters: repeated reads of the same configuration cannot
  multiply probes into a filesystem that is not answering.

  **The ceiling on concurrent scans is best-effort.** `claim/3` counts the table
  after taking its key, so a simultaneous burst of DISTINCT store lists can
  overshoot by a few before they see each other. Distinct lists only appear while
  the configuration is being changed, and one scan each is the correct behaviour
  anyway; the ceiling is there to stop configuration churn during a stall from
  spending the scheduler pool, not to serialize normal operation.

  Entries leave when the scanner finishes (`release/1`) or dies — `live/0` prunes
  by liveness on every read, so a brutally-killed scanner stops counting the
  moment anyone looks, and a wedged one keeps counting for exactly as long as it
  is wedged.
  """

  use GenServer

  @table :shuttle_felt_store_scans

  @typedoc "A claimed scan: the store list being walked, its process, when it started."
  @type entry :: {[String.t()], pid(), integer()}

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @impl true
  def init(_opts) do
    table = :ets.new(@table, [:named_table, :public, :set, read_concurrency: true])
    {:ok, table}
  end

  @doc """
  Claim the right to scan `base` on behalf of `pid`.

  `:ok` — the caller holds the claim and must scan, then `release/1`.
  `{:error, :in_flight}` — somebody else is already scanning this exact list.
  `{:error, :budget}` — too many scans are parked; do not add another.
  `{:error, :unavailable}` — no roster table (a unit test with the app not
  started); the caller decides, exactly as it did before this module existed.
  """
  @spec claim([String.t()], pid(), non_neg_integer()) ::
          :ok | {:error, :in_flight | :budget | :unavailable}
  def claim(base, pid, max_parked) do
    if :ets.insert_new(@table, {base, pid, System.monotonic_time(:millisecond)}) do
      # Taken first, counted second: a claim that overshoots the ceiling is given
      # back before anything is spawned, so no scan ever runs without a claim
      # that survived the count.
      if length(live()) > max_parked do
        release(base)
        {:error, :budget}
      else
        :ok
      end
    else
      reclaim_or_refuse(base, pid, max_parked)
    end
  rescue
    ArgumentError -> {:error, :unavailable}
  end

  # The key was taken. Either its holder is alive — a genuine in-flight scan —
  # or it died without releasing, in which case the key would wedge this store
  # list forever and the right move is to drop it and try again.
  defp reclaim_or_refuse(base, pid, max_parked) do
    case :ets.lookup(@table, base) do
      [{^base, holder, _started}] ->
        if Process.alive?(holder) do
          {:error, :in_flight}
        else
          :ets.delete(@table, base)
          claim(base, pid, max_parked)
        end

      [] ->
        claim(base, pid, max_parked)
    end
  end

  @doc """
  Hand a claim over to the process that is actually scanning.

  The claim has to be taken BEFORE the scanner is spawned — that is what makes it
  atomic — so it starts out held by the caller and names the scanner once there
  is one. Liveness pruning is why this matters: the caller is often a request
  process that goes away long before a wedged walk returns, and an entry pruned
  while its scan is still parked would let the next caller start a second one.
  """
  @spec adopt([String.t()], pid()) :: :ok
  def adopt(base, pid) do
    case :ets.lookup(@table, base) do
      [{^base, _holder, started}] -> :ets.insert(@table, {base, pid, started})
      [] -> :ok
    end

    :ok
  rescue
    ArgumentError -> :ok
  end

  @doc "Give up the claim on `base`. Idempotent."
  @spec release([String.t()]) :: :ok
  def release(base) do
    :ets.delete(@table, base)
    :ok
  rescue
    ArgumentError -> :ok
  end

  @doc """
  The scans still running, pruned by liveness — a scanner that died without
  releasing stops counting the moment anyone looks.
  """
  @spec live() :: [entry()]
  def live do
    @table
    |> :ets.tab2list()
    |> Enum.filter(fn {base, pid, _started} ->
      Process.alive?(pid) or (:ets.delete(@table, base) && false)
    end)
  rescue
    ArgumentError -> []
  end

  @doc "The live scan of exactly this store list, or nil."
  @spec find([String.t()]) :: entry() | nil
  def find(base) do
    Enum.find(live(), fn {scanned, _pid, _started} -> scanned == base end)
  end
end
