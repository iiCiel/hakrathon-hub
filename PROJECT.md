# Project: HAkrathon

> Project file from the Command Center, Oct 28, 2026, 10:52 PM. Paste it into a new project (New project, then "Start from a project file") or into a chat to pick up exactly where this left off.

## Goal
HAkrathon Hub: the team portal for HAkrathon 2026 (UA College of Business, Fri Nov 6, 7:30 AM-7:30 PM, 10 teams of 3-5). Students chat, write and run code, link their GitHub repo, and submit; mentors work a help queue; judges score on the 100-point rubric. It has to work reliably on event day.

## What each run does
Read README.md and the notes below. Do the next unchecked item under Next, test it (npm test, plus a browser check at desktop and phone width with screenshots you look at), commit it in this folder from Windows PowerShell, then update these notes. Fix bugs before adding features. One focused item per run.

## Folder
D:\Projects\hakrathon-hub

## Notes (what is done, in progress, next, issues)
###### Status
Built 2026-10-28. Node 22.13+ server (server/, node:sqlite, Express, Socket.IO), plain-JS front end (public/), self-hosted Monaco + highlight.js. Folder D:\Projects\hakrathon-hub, git repo on main, no remote. Latest commit 4721ad0 (2026-10-28 night run: showcase prep).
npm test runs tests/api.test.js + tests/demo.test.js: 19 pass, 1 skipped (sandbox, no Docker on this laptop) - verified 2026-10-28 fix-up run.
npm run eventday (this laptop, no Docker): 146/146 pass (2026-10-28). Cloud copy with Docker earlier: 161/161.
npm run loadtest: 50 students x 10 min, 0 errors, p99 < 30 ms.
Skills run 2026-10-28: security-team, review-team, verify-team; QA round with 3 test agents. All findings fixed.

Showcase run (2026-10-28, for Soliman's showcase on Oct 29):
- Demo clock: server/democlock.js (STAGES morning 8:40 / sprint 13:30 / prefreeze 16:20 / judging 17:15 / awards 18:55). jump() moves event settings AND all stored ISO timestamps (TIME_COLUMNS list) by the same delta and stores settings.demo_shift_ms; it sets judging_open per stage. Routes GET/POST /api/admin/demo-clock (404 unless is_demo). Admin page shows a "Demo clock" card on top when is_demo.
- Browser shows event-day times in the demo: ui.js setDisplayShift/toDisplay; fmtTime/fmtDateTime and admin datetime inputs subtract demo_shift_ms (always 0 on the real server; /api/me sends demo_shift_ms only when is_demo).
- Server-made text too (fix-up run): settings.displayMs(ms) subtracts demo_shift_ms only when is_demo. Used in Admin > Rehearsal (times, backup, offline details) and offline.js fmtTime. Test in tests/demo.test.js asserts 'Freeze Friday, Nov 6 4:30 PM' and the offline 'Built Nov 6, 2026, 1:3x PM'.
- Known demo quirk (not fixed): at the 8:40 AM stage the seeded teams already show CP1/CP2 done (seed data is from 1:30 PM). Mention it or start the walkthrough at 1:30 PM.
- scripts/demo.js: seed calls democlock.jump('sprint') before inserting rows; on restart, if the demo time is outside 7:30 AM-7:30 PM on event day it auto-resets to 1:30 PM. Seed now has: Phish Finders + RoomRadar with CP2, full package, validation, scores from judge2+judge3; open help request from RoomRadar; ZipQueue team chat. ZipQueue stays 3/8 for live demoing.
- SHOWCASE.md: 8-minute walkthrough (two browser windows, accounts, the click order).
- Fixed the "small leftover": app.js route() now waits (up to 6 s) for the previous render to settle before clearing page handlers, so a slow page can't attach handlers to the next one (verified in the browser: 0 leaked tick calls).
- Judge team list uses .tbl.cards-sm (rows become cards under 640px). Home "Today" timeline scrolls to now reliably.

Demo: demo.bat -> http://localhost:3100 (127.0.0.1 only, data-demo folder; delete data-demo to reset). Passwords demo-pass-2026; admin@demo.uakron.edu, judge1-3@demo.com, mentor@demo.com, student1-9@zips.uakron.edu.
Event facts from HAkrathon_2026_Event_Scope.pdf: checkpoints 10:00 and 3:15, freeze 4:30, validation 4:30-5:00, judging 5:00, finalist Q&A top 3 (Technical + Presentation only), one prize per team. Rubric 25/25/25/15/10, tie-breaks within 0.25: Impact, Technical, Innovation, judge vote.

###### Rules for this project
- It is Soliman's event tool. No email, posting, GitHub repos or public pushes unless he clicked for it.
- Never weaken the code runner sandbox (no network, read-only root, cap-drop ALL, user 65534, memory/pids limits). Never RUNNER=local with students.
- Plain JS front end; no framework rewrite.
- Test against a throwaway DATA_DIR / DEMO_DATA_DIR, never data\ (real event data).
- Commit from Windows PowerShell in D:\Projects\hakrathon-hub.

###### Next
- [ ] Docker Desktop on this laptop (Soliman installs it), then setup-runner.bat, confirm Admin > Rehearsal "Code runner ready", re-run npm run eventday for sandbox checks.
- [ ] Nov 5 rehearsal: work down Admin > Rehearsal on the real server (phone on event Wi-Fi, test team, test score, offline package, backup).
- [ ] Nice to have: server-side video length check (ffprobe); per-file size check of GitHub repos before download.
- [ ] Nice to have: other wide tables (results criteria, admin tables) could use .tbl.cards-sm on phones too.

###### Done
- [x] Portal built (all roles, judging, awards, exports, demo mode).
- [x] Security audit + fixes (e0fe6fd). Review fixes, offline package, load test (7ed504c). Rehearsal checklist, gzip (617af91). Event-day simulation, Windows fixes (d961da9). QA round (d4e9688 + dacc69c).
- [x] Showcase prep: demo clock, event-day times, richer demo seed, SHOWCASE.md, page-switch handler fix, phone judge list (4721ad0).

## Recent runs (newest first)
### Oct 28, 2026: done
- He asked: improve, make sure it perfect and ready, im gonna be showcasing it tomorrow,
- Did: Demo is ready for tomorrow: double-click demo.bat and follow SHOWCASE.md (8-min walkthrough). 1. Done: the demo now shows real event times (Fri Nov 6, freeze 4:30 PM). Before, it showed odd clock times like "Build Sprint 2 at 9:33 PM". 2. Done: new Admin > Demo clock. One click jumps the demo to morning, 10 min before freeze, judging, or awards, and every open screen updates live. 3. Done: the demo has more to show. 2 teams have finished packages, 2 of 3 judges have scored (judge1 scores live), a mentor request is waiting, and there's team chat. 4. Done: fixed the page-switch bug from the notes, and the judge's team list now fits on phones. 5. Needs you: the code Run button only works with Docker Desktop. Without it, the Run button says the code runner is unavailable. Next: tonight, double-click demo.bat, open http://localhost:3100, sign in as admin@demo.uakron.edu (password demo-pass-2026) and click through the 5 Demo clock buttons once. Details: commit 4721ad0 (no remote, not pushed). npm test: 18 pass, 1 skipped (Docker). Event-day simulation: 146/146 pass. Screenshots checked at 1366px and 390px.
- Where it stood: Showcase-ready: the demo has event-day times, a one-click Demo clock for every stage, and a walkthrough in SHOWCASE.md. The only gap is the code runner (needs Docker Desktop).

## Waiting on Soliman
- Install Docker Desktop so the code Run button works (due 2026-11-05)
- Before the showcase: run demo.bat once and click through Admin > Demo clock (due 2026-10-29)
