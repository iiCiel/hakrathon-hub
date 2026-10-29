# Project: HAkrathon

> Project file from the Command Center, Oct 28, 2026, 11:00 PM. Paste it into a new project (New project, then "Start from a project file") or into a chat to pick up exactly where this left off.

## Goal
HAkrathon Hub: the team portal for HAkrathon 2026 (UA College of Business, Fri Nov 6, 7:30 AM-7:30 PM, 10 teams of 3-5). Students chat, write and run code, link their GitHub repo, and submit; mentors work a help queue; judges score on the 100-point rubric. It has to work reliably on event day.

## What each run does
Read README.md and the notes below. Do the next unchecked item under Next, test it (npm test, plus a browser check at desktop and phone width with screenshots you look at), commit it in this folder from Windows PowerShell, then update these notes. Fix bugs before adding features. One focused item per run.

## Folder
D:\Projects\hakrathon-hub

## Notes (what is done, in progress, next, issues)
###### Status
Built 2026-10-28. Node 22.13+ server (server/, node:sqlite, Express, Socket.IO), plain-JS front end (public/), self-hosted Monaco + highlight.js. Folder D:\Projects\hakrathon-hub, git repo on main, no remote. Latest commit 23b8527 (2026-10-28 fix-up run: server-side demo times).
Verified 2026-10-28 fix-up run (each run to completion, output read):
- npm test (tests/api.test.js + tests/demo.test.js): 19 pass, 0 fail, 1 skipped (sandbox, no Docker).
- npm run eventday: "146 passed, 0 failed", exit 0 (this laptop, no Docker). Cloud copy with Docker earlier: 161/161. It takes over 10 minutes, so run it in the background and write output to a log file (e.g. %TEMP%\hak-eventday.log).
- Demo started exactly as demo.bat does (node scripts\demo.js, port 3100, throwaway DEMO_DATA_DIR in %TEMP%): all 5 Demo clock buttons read 8:40 AM / 1:30 PM / 4:20 PM / 5:15 PM / 6:55 PM. Header banner at 4:20 PM: "Build freeze at 4:30 PM"; at 5:15 PM: "Tabulation at 6:10 PM"; at 6:55 PM: "Awards at 7:00 PM". Student home has the yellow freeze banner. Screenshots at 1366 and 390 px are in .shots/ (git-ignored).
npm run loadtest: 50 students x 10 min, 0 errors, p99 < 30 ms.
Skills run 2026-10-28: security-team, review-team, verify-team; QA round with 3 test agents. All findings fixed.

Showcase run (2026-10-28):
- Demo clock: server/democlock.js (STAGES morning 8:40 / sprint 13:30 / prefreeze 16:20 / judging 17:15 / awards 18:55). jump() moves event settings AND all stored ISO timestamps (TIME_COLUMNS) by the same delta and stores settings.demo_shift_ms. Routes GET/POST /api/admin/demo-clock (404 unless is_demo).
- Browser display: ui.js setDisplayShift/toDisplay; fmtTime/fmtDateTime subtract demo_shift_ms (0 on the real server).
- Server display (fix-up run): settings.displayMs(ms) subtracts demo_shift_ms only when is_demo. Used in admin.js rehearsalAuto (times, backup, offline details) and offline.js fmtTime. The test asserts "Freeze Friday, Nov 6 4:30 PM" and the offline "Built Nov 6, 2026, 1:3x PM". Without the fix the test fails ("Oct 29 1:57 AM").
- Known demo quirk (not fixed): at the 8:40 AM stage the seeded teams already show CP1/CP2 done (the seed is made at 1:30 PM). Start the walkthrough at 1:30 PM.
- scripts/demo.js seeds at the sprint stage; on restart outside 7:30 AM-7:30 PM it auto-resets to 1:30 PM. SHOWCASE.md has the 8-minute walkthrough.
- The commit message of 23b8527 starts with a stray BOM character (from PowerShell Set-Content utf8). It's harmless; next time write the message file with [IO.File]::WriteAllText (no BOM).

Demo: demo.bat -> http://localhost:3100 (127.0.0.1 only, data-demo folder; delete data-demo to reset). Passwords demo-pass-2026; admin@demo.uakron.edu, judge1-3@demo.com, mentor@demo.com, student1-9@zips.uakron.edu.
Event facts: checkpoints 10:00 and 3:15, freeze 4:30, validation 4:30-5:00, judging 5:00, finalist Q&A top 3 (Technical + Presentation only), one prize per team. Rubric 25/25/25/15/10, tie-breaks within 0.25: Impact, Technical, Innovation, judge vote.

###### Rules for this project
- It is Soliman's event tool. No email, posting, GitHub repos or public pushes unless he clicked for it.
- Never weaken the code runner sandbox (no network, read-only root, cap-drop ALL, user 65534, memory/pids limits). Never RUNNER=local with students.
- Plain JS front end; no framework rewrite.
- Test against a throwaway DATA_DIR / DEMO_DATA_DIR, never data\ (real event data).
- Commit from Windows PowerShell in D:\Projects\hakrathon-hub (use git commit -F <file> for multi-line messages).

###### Next
- [ ] Docker Desktop on this laptop (Soliman installs it), then setup-runner.bat, confirm Admin > Rehearsal "Code runner ready", re-run npm run eventday for sandbox checks.
- [ ] Nov 5 rehearsal: work down Admin > Rehearsal on the real server (phone on event Wi-Fi, test team, test score, offline package, backup).
- [ ] Nice to have: the demo's 8:40 AM stage could hide CP2/package rows that are "in the future" (or the seed could be stage-aware).
- [ ] Nice to have: server-side video length check (ffprobe); per-file size check of GitHub repos before download.
- [ ] Nice to have: other wide tables (results criteria, admin tables) could use .tbl.cards-sm on phones too.

###### Done
- [x] Portal built (all roles, judging, awards, exports, demo mode).
- [x] Security audit + fixes (e0fe6fd). Review fixes, offline package, load test (7ed504c). Rehearsal checklist, gzip (617af91). Event-day simulation, Windows fixes (d961da9). QA round (d4e9688 + dacc69c).
- [x] Showcase prep: demo clock, event-day times, richer demo seed, SHOWCASE.md, page-switch handler fix, phone judge list (4721ad0).
- [x] Fix-up: server-made demo times (Rehearsal, offline package) + proven test/eventday/demo-on-3100 results (23b8527).

## Recent runs (newest first)
### Oct 28, 2026: done
- He asked: Fix-up run started by the supervisor. It checked the last run's work itself and found 2 problems: 1. In the demo, Admin > Rehearsal and the offline judging package show times from the shifted clock, not event-day time. This goes against the claim that the demo shows real event times. (seen: server/r
- Did: Both supervisor problems are fixed and checked. The demo now shows event-day times everywhere, and the test results are confirmed. 1. Fixed: Admin > Rehearsal now says "Freeze Friday, Nov 6 4:30 PM". Before, it said "Thursday, Oct 29 1:57 AM". The offline judging package now reads "Built Nov 6, 2026, 4:20 PM". The real server is unchanged. 2. Checked: npm test ran to the end: 19 passed, 0 failed, 1 skipped (Docker). Without the fix, the new test fails, so it really catches this bug. 3. Checked: the event-day simulation ran to the end: "146 passed, 0 failed", exit 0. 4. Checked: I started the demo the way demo.bat does, on port 3100. I clicked all 5 Demo clock buttons, and they read 8:40 AM, 1:30 PM, 4:20 PM, 5:15 PM and 6:55 PM. At 4:20 PM the student home shows the yellow banner "Build freeze at 4:30 PM". I took screenshots of the admin and student screens at 1366 px and 390 px and looked at each one. 5. Not fixed: in the demo at 8:40 AM, the sample teams already show both checkpoints done, because the sample data was made at 1:30 PM. Start your walkthrough at 1:30 PM so nobody sees this. Next: before the showcase, double-click demo.bat, open http://localhost:3100 and sign in as …
- Where it stood: Ready for the showcase. Server text and browser text both show event-day times in the demo, and the tests and simulation pass. The only gap is the code runner, which needs Docker Desktop.
### Oct 28, 2026: done, supervisor grade B
- He asked: improve, make sure it perfect and ready, im gonna be showcasing it tomorrow,
- Did: Demo is ready for tomorrow: double-click demo.bat and follow SHOWCASE.md (8-min walkthrough). 1. Done: the demo now shows real event times (Fri Nov 6, freeze 4:30 PM). Before, it showed odd clock times like "Build Sprint 2 at 9:33 PM". 2. Done: new Admin > Demo clock. One click jumps the demo to morning, 10 min before freeze, judging, or awards, and every open screen updates live. 3. Done: the demo has more to show. 2 teams have finished packages, 2 of 3 judges have scored (judge1 scores live), a mentor request is waiting, and there's team chat. 4. Done: fixed the page-switch bug from the notes, and the judge's team list now fits on phones. 5. Needs you: the code Run button only works with Docker Desktop. Without it, the Run button says the code runner is unavailable. Next: tonight, double-click demo.bat, open http://localhost:3100, sign in as admin@demo.uakron.edu (password demo-pass-2026) and click through the 5 Demo clock buttons once. Details: commit 4721ad0 (no remote, not pushed). npm test: 18 pass, 1 skipped (Docker). Event-day simulation: 146/146 pass. Screenshots checked at 1366px and 390px.
- Where it stood: Showcase-ready: the demo has event-day times, a one-click Demo clock for every stage, and a walkthrough in SHOWCASE.md. The only gap is the code runner (needs Docker Desktop).
- Problems: Spent about 10 of 22 minutes waiting on the event-day simulation, with a blocked sleep, a Monitor, and a timed-out wait. The 146/146 figure is still not visible.; One edit script hit an AssertionError on db.js (duplicate addColumn) and needed a second pass.; Bash quoting error on the chat-channel grep, worked around with Grep.; The broad scope of the changes (clock, seed data, CSS, tests, docs) the night before a showcase raises regression risk. The only full-flow check used a different port and data folder than the real demo.; Soliman's 'make it perfect' was met with many additions rather than a focus on stability, and the notes' one-item-per-run rule was not followed.
- Advice for the next run: Verify the real demo.bat on port 3100, not a test port. Confirm test and simulation counts from the log before reporting them. Before a showcase, freeze features and only fix bugs. Keep the final report's claims tied to a visible result.

## Waiting on Soliman
- The supervisor opened the last HAkrathon run's work and found 2 problems; a fix-up run is fixing them now.
- Install Docker Desktop so the code Run button works (due 2026-11-05)
- Before the showcase: run demo.bat once and click through Admin > Demo clock (due 2026-10-29)
