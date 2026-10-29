# Family board — design

The family board is a read-time view of the constitution tree, not a separate
store. Each host appends board records to its event stream; its daemon projects
and serves those records, and a family read merges local records with cached
remote feeds. Membership follows current containment, so moving a thread moves
its recorded activity to its new family. Remote refreshes run asynchronously;
a request serves the last cached records without waiting for the network.

The projection holds **up to 14 days, bounded by the two event files**. A
rotation discards records present only in the overwritten `.1` file, so a busy
stream can cover less than 14 days. The board is awareness, not an archive;
fibers and transcripts retain the work itself.
