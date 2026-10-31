# Debug log

A double click on the **?** button saves `m8-explorer-debug-<song>-<date>-<time>.json`, to attach to a
bug report. It has three parts with three lifetimes (`src/model/debugLog.ts`):

- **Global state**, read at the moment of the export (`global`): `environment` (browser, frame, SDK
  version), `permissions` (Web MIDI with and without SysEx, audio input, Web Serial and WebUSB
  grants, the frame's permission policy, the MIDI ports the browser lists when MIDI is already
  granted: nothing is asked for), `connection` (through yam8d or standalone, serial / USB / MIDI,
  audio, device model), `midi` (SYNC OUT, CC MAP CHAN and SONG ROW CUE CHAN of the song, whether
  SYNC OUT is the CLK+TRANSP+SPP the playheads need, the mute / solo output), `playback` (time base,
  MIDI clock enabled or refused, clock events, tempo and gaps, totals), `song` (sizes, project
  settings, the grooves the song plays with and which are not plain 6-6 sixteenths with what points
  at them, the exploration's warnings), `settings` and `handshake`.
- **Exploration runs, device tasks and problems**, kept for the whole session: the last 5 runs of
  *Explore song* (`exploration`: phases with their time, what the driver said while it went, the
  warnings, the counts it ended with, cancelled or failed), the MIDI sync checks and theme reads
  (`deviceTasks`), and `problems` (errors, warning notices, a failing screen read or sync, a refused
  MIDI clock, storage that cannot be written), each counted once with its first and last time.
- **Rolling events** (`events`, the last 400, `eventsDropped` says how many left): user activity and
  playback. Play pressed (`play-key`) and the start (`play-start`: from the MIDI transport or the
  screen, the cursor's song row and track, the view, Follow M8 and Auto select, the time base, and
  per track the chain, whether its position is exact and how its step lengths differ from 6 ticks),
  `transport` messages, `clock-gap`, `tempo`, `no-clock-while-playing`, `drift` (a phrase view
  showed another step than predicted: track, song row, predicted and shown step, difference, step
  length, time since the start), `reanchor` (a track's position restarted), `phrase-loop` (a track
  began or stopped looping one phrase, and why), `play-stop` (why, how
  long, the corrections of that stretch), `long-task` (main thread stalls while playing),
  `visibility` (a background tab slows the page), Follow M8 / Auto select, `device-view` (the view
  the M8 moved to, not every cursor move), `device-edit` (an edit made on the M8 folded in),
  `other-song`, `connection`, mute / solo and channel changes, show on M8, toolbar actions and
  notices. Bursts of drifts and gaps are thinned out (`suppressed` counts what was left out).

`public/debug-log-analyzer.html` (served at `/debug-log-analyzer.html`) reads such a file (open it in a browser, drop the log on it): a
green / amber / red light per check (permissions, connection, the MIDI clock link, song, each
exploration with its own MIDI sync & clock card, each play with its corrections, problems), a timeline and the raw events. Everything
stays in the page; "Copy summary" gives a text version to paste into a bug report.
