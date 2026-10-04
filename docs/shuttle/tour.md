# Board tour

A silent, under-a-minute tour of the Shuttle board's Desk and Chronicle.
It walks one fictional project — planning a small workshop — through the
three Desk lanes shown in this example: tasks not yet started, tasks a worker is running, and
finished work waiting for you to review.

<video controls preload="metadata" playsinline width="100%"
  poster="../../assets/shuttle-board-tour-poster.jpg">
  <source src="../../assets/shuttle-board-tour.mp4" type="video/mp4">
  <track kind="captions" srclang="en" label="English (same as on-screen text)"
    src="../../assets/shuttle-board-tour.vtt">
  <a href="../../assets/shuttle-board-tour.mp4">Download the board tour (MP4)</a>.
</video>

The video is built from two still screenshots of the real board, the same ones
on [The board](board.md) page, showing example data for a fictional workshop.
The camera pans and zooms across those stills and the outlines and captions are
drawn on top; nothing in it is clicked, started or recorded live. The captions
are part of the picture, so the video has no sound.

## Transcript

<!-- tour-transcript:start -->
| Time | On screen |
|---|---|
| 0:00 | **The Shuttle board — A short tour of the Desk and Chronicle — Screenshots of the real board, over a fictional example** |
| 0:04 | The Desk groups tasks by what needs attention. |
| 0:08 | Here, the tasks belong to a fictional workshop. |
| 0:12 | Drafts: tasks written down, but not started. |
| 0:18 | In flight: an agent, called a worker, is running on each of these. |
| 0:23 | The card names the task and the result it should reach. |
| 0:27 | Aloft marks a running worker. Click it to open that worker’s conversation. |
| 0:32 | Awaiting review: a worker finished and recorded an outcome. |
| 0:37 | This outcome says what still needs confirming before the workshop. |
| 0:42 | Temper accepts the result. Discard sets it aside. |
| 0:47 | Chronicle, the second tab, lays each task along the calendar. |
| 0:51 | Marks show the days its workers were busy, through today. |
| 0:55 | **Set up Shuttle — Start with one machine and one small task — cailmdaley.github.io/felt/shuttle/setup/** |
<!-- tour-transcript:end -->

## Read more

- [The board](board.md) describes every view and lane, and the Settings sheet.
- [Opening conversations](conversations.md) covers where Aloft opens a
  worker: a terminal, Claude in the browser, or the Claude app.
- [The Shuttle overview](index.md) explains how a written task reaches a worker.

To rebuild the video after the screenshots change, run `npm run video:docs`
from `ui/`. It needs only `ffmpeg`, and rewrites the video, poster, captions
and the transcript above.
