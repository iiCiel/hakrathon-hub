# Project: HAkrathon

> Project file from the Command Center, Oct 28, 2026, 9:12 PM. Paste it into a new project (New project, then "Start from a project file") or into a chat to pick up exactly where this left off.

## Goal
HAkrathon Hub: the team portal for HAkrathon 2026 (UA College of Business, Fri Nov 6, 7:30 AM-7:30 PM, 10 teams of 3-5). Students chat, write and run code, link their GitHub repo, and submit; mentors work a help queue; judges score on the 100-point rubric. It has to work reliably on event day.

## What each run does
Read README.md and the notes below. Do the next unchecked item under Next, test it (npm test, plus a browser check at desktop and phone width with screenshots you look at), commit it in this folder from Windows PowerShell, then update these notes. Fix bugs before adding features. One focused item per run.

## Folder
D:\Projects\hakrathon-hub

## Notes (what is done, in progress, next, issues)
###### Status
Built 2026-10-28. Node 22.13+ server (server/, node:sqlite, Express, Socket.IO), plain-JS front end (public/), self-hosted Monaco + highlight.js (gzipped). Folder D:\Projects\hakrathon-hub, git repo on main, no remote yet. Latest commit dacc69c.
npm test: 18 end-to-end API tests; on this laptop 17 pass and the sandbox test is skipped (Docker is not installed). Includes a local git-daemon GitHub test with Windows-hostile file names, run on this laptop.
npm run eventday: whole event day with 50 students in a throwaway data folder (check-in rush, teams, chat, heavy uploads 75 MB zip / 300 MB video / 3000-file zip, freeze snapshots, judging, awards, exports, backup). Cloud copy with Docker: 161/161 pass, worst stall ~0.2 s, peak ~360 MB. This laptop (no Docker): 146/146 pass.
npm run loadtest: 50 simulated students for 10 minutes: 0 errors, p99 under 30 ms.
Skills run 2026-10-28: security-team, review-team, verify-team (all findings fixed). QA round 2026-10-28/29 with 3 test agents (heavy uploads + file types, GitHub linking, 12-16 live browsers): all Critical/Important findings fixed and re-tested.
Key fixes from the QA round: uploads over 5 minutes were cut off (big videos on slow Wi-Fi); teammates uploading at once broke or leaked files; autosave never fired while someone typed steadily and code typed in the last seconds before freeze was lost; per-team extension didn't re-open the editor; nothing caught up after a dropped connection; freeze snapshot could be gamed with back-dated commits (now pinned to what GitHub had at the freeze); Git for Windows failed whole clones on names like CON.txt or a:b.txt (now skipped and reported); desktop chat didn't scroll.
New: Admin > Rehearsal checklist, offline judging package, notebooks/UTF-16/image preview and file download for judges, older chat history, staff see team workspaces live.
Demo: demo.bat -> http://localhost:3100 (127.0.0.1 only, red DEMO banner, data-demo folder). All demo passwords demo-pass-2026; admin@demo.uakron.edu.
Event facts come from Soliman's HAkrathon_2026_Event_Scope.pdf: checkpoints 10:00 and 3:15, build freeze 4:30, validation 4:30-5:00, judging 5:00, finalist Q&A (top 3, only Technical and Presentation may change), awards with one prize per team. Rubric 25/25/25/15/10, tie-breaks within 0.25: Impact, Technical, Innovation, judge vote.

###### Rules for this project
- It is Soliman's event tool. Do not send email, post anything, create GitHub repos or push anywhere public unless he clicked for it.
- Never weaken the code runner sandbox (no network, read-only root, cap-drop ALL, user 65534, memory/pids limits). Never use RUNNER=local with students.
- Keep the front end plain JS; no framework rewrite.
- Test against a throwaway DATA_DIR, never data\ (that is the real event data).
- Commit from Windows PowerShell in D:\Projects\hakrathon-hub; never run git from a Linux VM.

###### Next
- [ ] Install Docker Desktop on this laptop, then run setup-runner.bat and confirm Admin > Rehearsal shows "Code runner ready" (needs Soliman to install Docker: ask him in the report, don't install it yourself). Then run npm run eventday once more here to cover the sandbox checks.
- [ ] Nov 5 rehearsal: work down Admin > Rehearsal on the real server (phone on event Wi-Fi, test team, test score, offline package, backup).
- [ ] Small leftover: a page that finishes loading after you navigate away can attach its live-update handlers to the next page (rare; fix with a per-page token in app.js route()).
- [ ] Nice to have: server-side video length check (ffprobe) instead of trusting the browser; per-file size check of GitHub repos before download.

###### Done
- [x] Portal built: accounts/invite codes, teams, checkpoints, chat (event/help/team/staff), mentor queue with log, shared editor + runner, submission package, repo snapshots, judging, validation, tabulation, awards, results, CSV exports, demo mode.
- [x] Security department full audit + fixes (2026-10-28, e0fe6fd).
- [x] Review department + fixes, offline judging package, load test (2026-10-28, 7ed504c).
- [x] Rehearsal checklist page, gzip, verify follow-ups (2026-10-28, 617af91).
- [x] Event-day simulation script, async password hashing, Windows long-path/CRLF fixes (2026-10-28, d961da9).
- [x] QA round: uploads, GitHub linking, realtime (2026-10-29, d4e9688 + dacc69c).
