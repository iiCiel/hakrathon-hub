# Showcasing HAkrathon Hub (about 8 minutes)

**Before you start**
1. Double-click `demo.bat`. Open http://localhost:3100.
2. Open two browser windows side by side: a normal one and a private/incognito one (so two people can be signed in at once).
3. All passwords: `demo-pass-2026`.

| Who | Email |
|---|---|
| Admin | admin@demo.uakron.edu |
| Student (ZipQueue) | student1@zips.uakron.edu (teammates: student2, student3) |
| Mentor | mentor@demo.com |
| Judge | judge1@demo.com (Dr. Rivera, still has to score) |

To reset the demo completely, close the window and delete the `data-demo` folder.

**1. Student, 1:30 PM, Build Sprint 2** (window 1: student1)
- Home: event timeline, countdown to Checkpoint 2 and the 4:30 freeze, team checklist (3 of 8 done).
- Code: shared editor with the team's files. Type in `main.py` and it autosaves. (Run needs Docker; without Docker it says the runner is unavailable.)
- Chat → Team · ZipQueue: private team channel with history.
- Mentors: ask for help ("Technical", one line).

**2. Mentor** (window 2: mentor@demo.com)
- Help queue: the new request pops up live. Click **I'll take it**, then resolve it with a note. It goes into the mentor log.

**3. Admin** (window 2: sign out, then admin@demo.uakron.edu)
- Admin → Overview: every team's checkpoints and package at a glance, the help queue, the code runner status.
- Post an announcement (Chat → Announcements): it pops up on the student's screen in window 1.
- **Demo clock** (top of Admin): click **4:20 PM · 10 min before the build freeze**. Window 1 turns yellow: "Build freeze at 4:30 PM".

**4. Judging** (Admin → Demo clock → **5:15 PM · Primary judging**)
- Window 1 (student) now shows the freeze: code and submissions are locked.
- Window 2: sign in as judge1@demo.com → Judging → **Score** Phish Finders: prototype link, brief, disclosures, checkpoints, 1-10 rubric with the live weighted total. Submit.

**5. Results** (window 2: admin again)
- Admin → Scoring & awards: the tabulation updates (3 judges now), tie-break rules, flags. **Mark top 3 as finalists**, assign awards (one prize per team), tick **Results published**: every screen gets a Results tab.

Back to the start any time: Admin → Demo clock → **1:30 PM · Build Sprint 2**.
