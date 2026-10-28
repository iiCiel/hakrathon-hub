# HAkrathon 2026 Hub

Team portal for HAkrathon 2026 (UA College of Business, Nov 6). Built around the Event Scope: checkpoints, the 4:30 build freeze, the four-part submission package, the weighted judging rubric, tie-breakers and awards.

**What each role gets**

| Role | Can do |
|---|---|
| Participant | Create/join a team (3–5), pick a lane, submit Checkpoint 1 & 2, team chat, shared code editor that runs Python / JavaScript / C / C++ / Java / Bash, request a mentor, submit the package (GitHub repo snapshot or zip, live link, 5-min video, brief, disclosures, backup evidence) |
| Mentor | Help queue (claim → go to table → resolve with a log note), read-only view of any team's code |
| Judge | After freeze: browse each team's repo/zip, run it in the sandbox, watch the video (auto-stops at 5:00), score 1–10 on the rubric with notes, declare conflicts, finalist Q&A adjustments (Technical + Presentation only) |
| Admin | Access codes, people, teams/tables, event times and schedule, announcements (pop up on every screen), staff validation checklist, per-team or global freeze extensions, tabulation with tie-breakers and flags, awards (one prize per team), publish results, CSV exports, audit log |

Everything updates live (chat, files, help queue, submissions). Code and submissions lock automatically at the build freeze, and the official repo snapshot (exact commit SHA) is taken at that moment.

## Run it (Windows)

1. Double-click **`start.bat`**. First run installs packages and prints a one-time admin code (also in `data\ADMIN-SETUP.txt`).
2. Open http://localhost:3000 → **Create account** → use that code. You are now admin.
3. Admin → **Access codes**: paste the registration email list to get one personal code per student (export them as CSV to hand out at check-in), and make single-use codes for each judge and mentor. A shared multi-use code also works, but then anyone holding it could register under a classmate's email.
4. Students on the same Wi-Fi use the "Same Wi-Fi" address printed in the window (click **Allow** on the Windows Firewall prompt the first time). Campus Wi-Fi often blocks device-to-device traffic, so test this at the rehearsal. If it's blocked, or for people off-network, run **`share-online.bat`** (ngrok) and share the https link; over ngrok, ask teams to submit demo videos as Panopto/Stream links instead of uploads.

**Code runner (needs Docker Desktop):** install Docker Desktop, start it, then double-click **`setup-runner.bat`** once. Student code runs in a throwaway container with no internet, a read-only system, 384 MB memory, 128 processes and a 10 s limit (30 s for judges running a repo). Without Docker everything else works; the Run button shows that the runner is unavailable. `RUNNER=local` in `.env` runs code directly on this PC for admin testing only — never use it with students.

**Try every role first:** `demo.bat` starts a separate demo at http://localhost:3100 (`data-demo` folder, this computer only, red DEMO banner) with sample teams, judges and a mentor; all demo passwords are `demo-pass-2026`. Close it before the event.

## Event-day checklist

| When | In the portal |
|---|---|
| Nov 5 rehearsal | `demo.bat` walkthrough; real server: create codes, set table numbers, confirm runner is "Ready" |
| 7:30 check-in | Hand out the participant code; tick "Checked in" in People |
| 8:20 | Event & schedule → tick **Challenge released**; post an announcement |
| 9:15 | Rosters lock automatically; place stragglers via People or Overview |
| 10:00 / 3:15 | Checkpoints due (late ones are flagged) |
| Network down > 30 min | Event & schedule → global freeze extension, then announce it |
| 4:30 | Freeze is automatic; repo snapshots are taken; Overview shows who's complete |
| 4:30–5:00 | Review each team → Staff validation checklist |
| 5:00 | Scoring → **Primary judging open** |
| 6:10 | Scoring → check flags, **Mark top 3 as finalists**, open **Finalist Q&A** |
| 6:50 | Assign awards (suggestions follow the one-prize rule) → **Results published** |
| After | Exports: results, scorecards, mentor log, submission timestamps; run `backup.bat` |

## Settings

Optional `.env` (copy `.env.example`): port, runner mode, GitHub sign-in (OAuth app; callback `<PUBLIC_URL>/api/auth/github/callback`), and a `GITHUB_TOKEN` for snapshotting private repos. The token is only used when an admin presses **Re-snapshot repo** on a team's review page; teams' own snapshots and the automatic freeze snapshot need public repos. Event times, team size, max teams, email domains (`uakron.edu, zips.uakron.edu` by default) and the schedule are edited in Admin → Event & schedule.

## Data and backups

Everything lives in `data\` (SQLite database, uploads, repo snapshots). `backup.bat` writes a safe copy of the database to `data\backups\` while the server runs. Keep the PC plugged in and set Windows to never sleep during the event.

## Development

`npm test` runs the end-to-end API suite (accounts, teams, chat isolation, help queue, workspace conflicts, sandbox, zip safety, freeze, judging math, tie-breaks, awards, exports). Node 22.13+.
