"""A real Hark pause monitor and transcript sink, fed synthetic audio without devices."""
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
from hark.pause import PauseMonitor
from hark.transcript import Sink

home = Path(os.environ["HARK_DIR"])
home.mkdir(parents=True, exist_ok=True)
transcript = home / "probe.txt"
mic_only = sys.argv[1] == "mic-only"
sink = Sink(transcript, "pause probe")
monitor = PauseMonitor(home, (), system_paused=mic_only)
monitor.start()
(home / "meeting.json").write_text(json.dumps({
    "launch": "pause-probe", "pid": os.getpid(), "phase": "live",
    "transcript": str(transcript), "system_audio": not mic_only,
}))
print("ready", flush=True)
try:
    for command in sys.stdin:
        if command.strip() == "quit":
            break
        monitor.poll()
        for event in monitor.take_events():
            sink.pause(event)
        # Use Hark's actual mute intervals and PCM gate, on both tracks.
        with monitor.lock:
            now = time.time()
            mic = monitor.state.gate(np.ones(1600, np.float32), now)
            system = monitor.system_state.gate(np.ones(1600, np.float32), now)
        print(json.dumps({"mic_silent": not bool(mic.any()),
                          "system_silent": not bool(system.any())}), flush=True)
finally:
    monitor.stop()
    sink.close("ended")
