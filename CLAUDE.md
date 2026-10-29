# HAkrathon

HAkrathon Hub: the team portal for HAkrathon 2026 (UA College of Business, Fri Nov 6, 7:30 AM-7:30 PM, 10 teams of 3-5). Students chat, write and run code, link their GitHub repo, and submit; mentors work a help queue; judges score on the 100-point rubric. It has to work reliably on event day.

Read @PROJECT.md first: it has the goal, the current notes (done, in progress, next, issues), recent runs and what is waiting on Soliman. The Command Center keeps it up to date after every run.

The rules below are permanent (added 2026-10-29). They win over the Next list in PROJECT.md wherever the two disagree.

## Change freeze (Oct 29 showcase until Nov 6 event)
- Only bug fixes and verification. No new features, no redesigns, no new demo content, even when asked to "improve" or "make it perfect". If asked, do the single most useful bug fix or check, and list the other ideas in the notes for after Nov 6.
- One item per run. Finish it, test it, commit it, stop.
- Nice-to-haves wait until the Nov 5 rehearsal has passed (Soliman says so in a run request or the notes mark it done).

## Which Next item to pick
1. Skip every item marked **(waiting on Soliman)**: Docker Desktop install + setup-runner, and the Nov 5 rehearsal on the real server. Do not "partly do" them, and don't pick a nice-to-have because they're blocked.
2. Agent-doable order:
   1. SHOWCASE.md fallback section (done 2026-10-29: "If something goes wrong" table).
   2. Bug fix, after the showcase: stage-aware demo seed, so at the 8:40 AM stage the sample teams don't show CP1/CP2/package as done (scripts/demo.js seed + server/democlock.js). Add a test in tests/demo.test.js that fails without the fix.
   3. Nothing else agent-doable before Nov 5: run the "ready" check below, report, and stop.
3. Nice-to-haves (ffprobe video check, repo size check, .tbl.cards-sm on more tables, hiding "future" rows): only after the Nov 5 rehearsal passed.
When you update the notes, keep the "(waiting on Soliman)" tags on those items and keep this order.

## Before saying "ready" (demo, showcase or event)
- Start the demo exactly as demo.bat does: `node scripts\demo.js` on port 3100, with DEMO_DATA_DIR set to a throwaway folder in %TEMP% (never data\ or Soliman's data-demo). Delete the throwaway folder afterwards.
- Click all 5 Demo clock stages (8:40 AM, 1:30 PM, 4:20 PM, 5:15 PM, 6:55 PM). For every stage, screenshot at 1366 px and 390 px wide, open each screenshot and check the times and banners. Screenshots go in .shots\ (git-ignored).
- `npm test` to completion. Run `npm run eventday` and `npm run loadtest` in the background with output in a log file (e.g. `%TEMP%\hak-eventday.log`, `%TEMP%\hak-loadtest.log`; each takes about 10 minutes, so don't sleep-poll in the foreground). Read the log when it finishes.
- In the report, quote the final summary line of each verbatim (e.g. `146 passed, 0 failed`), not a paraphrase. No log line, no "ready".

## Committing (Windows PowerShell, in D:\Projects\hakrathon-hub)
- Write the message to a file without a BOM, then commit with -F:
  `[IO.File]::WriteAllText("$env:TEMP\hak-msg.txt", $msg, (New-Object System.Text.UTF8Encoding $false))` then `git commit -F "$env:TEMP\hak-msg.txt"`.
- Never `git commit -m` with times or quotes in it (PowerShell breaks on "4:30"), and never Set-Content -Encoding utf8 for the message (adds a BOM).
