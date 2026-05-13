# PT Workout Logger

A static, mobile-friendly workout logging app designed for GitHub Pages. The app uses a client-owned Google Sheet as the database and writes workout sets with the Google Sheets API.

## What this app does

- Uses a single sheet-style entry table, not cards.
- Lets each client paste their own Google Sheet URL or ID on first use.
- Stores only the Sheet ID in the browser's local storage.
- Uses Google OAuth in the browser so the signed-in client writes to a Sheet they can access.
- Loads exercises from `Exercise_Library`.
- Filters exercise dropdowns by the selected session's muscle group categories.
- Shows last used load/reps from `Log`.
- Shows target load/reps from `PR_Tracker`, with a fallback calculation of PR load * 1.05 rounded to the nearest 1.25 kg and PR reps + 1.
- Includes tempo as a first-class field.
- Preserves exercise metadata including primary muscle, secondary muscle, movement pattern, equipment, limb type, difficulty, base fatigue score, and variation lineage.
- Optionally updates `PR_Tracker` when a saved row is marked `Y` in the PR column and load/reps are numeric.

## Expected Google Sheet structure

This app is built around the uploaded `Workout_Tracker_V3.xlsx` layout after it has been converted to Google Sheets.

### Exercise_Library

Range: `Exercise_Library!B4:K300`

| Column | Field |
| --- | --- |
| B | Exercise |
| C | Category |
| D | Movement Pattern |
| E | Primary Muscle(s) |
| F | Secondary Muscle(s) |
| G | Equipment |
| H | Limb Type |
| I | Difficulty |
| J | Fatigue Score |
| K | Variation Of |

### PR_Tracker

Range: `PR_Tracker!B5:L300`

| Column | Field |
| --- | --- |
| B | Exercise |
| C | Category |
| D | PR Load |
| E | PR Reps |
| F | PR Date |
| G | PR Tempo |
| H | Target Load |
| I | Target Reps |
| J | Last Seen Load |
| K | Last Seen Reps |
| L | Notes / Cues |

### Log

Reads from: `Log!B5:P5000`

Appends to: `Log!B4:P`

| Column | Field |
| --- | --- |
| B | Date |
| C | Session |
| D | Exercise |
| E | Variation |
| F | Set |
| G | Load kg |
| H | Reps |
| I | Tempo |
| J | RPE |
| K | Rest sec |
| L | Bodyweight kg |
| M | Volume |
| N | e1RM |
| O | PR? |
| P | Notes |

## Setup

### 1. Prepare a client Google Sheet

1. Upload `Workout_Tracker_V3.xlsx` to Google Drive.
2. Open it with Google Sheets so it converts to a native Google Sheet.
3. Make one copy per client.
4. Share that client's copy with the client's Google account as Editor.
5. Copy the Sheet URL or the ID between `/d/` and `/edit`.

### 2. Create a Google OAuth web client

1. In Google Cloud, create or select a project.
2. Enable the Google Sheets API.
3. Configure the OAuth consent screen.
4. Create an OAuth Client ID with application type `Web application`.
5. Add Authorized JavaScript origins:
   - local testing: `http://localhost:8000`
   - GitHub Pages: `https://YOUR-GITHUB-USERNAME.github.io`
   - custom domain, if used: `https://yourdomain.com`
6. Copy the OAuth Web Client ID.
7. Paste it into `config.js` as `GOOGLE_CLIENT_ID`.

Authorized JavaScript origins are origins only. Do not include a path like `/repo-name`.

### 3. Configure sessions

Edit the `SESSIONS` array in `config.js` to match your programming model. Each session filters exercise dropdowns by category.

Example:

```js
{ name: 'Legs', categories: ['Quads', 'Hamstrings', 'Glutes & Hips', 'Calves'] }
```

Use `['*']` to show all exercises.

### 4. Test locally

From this folder:

```bash
python3 -m http.server 8000
```

Open:

```text
http://localhost:8000
```

### 5. Deploy to GitHub Pages

1. Commit these files to a GitHub repository.
2. Go to repository Settings > Pages.
3. Select the branch and root folder that contain `index.html`.
4. Open the published GitHub Pages URL.
5. Paste a client Sheet ID, connect Google, then load the Sheet.

## Client workflow

1. Client opens the app on mobile.
2. Client pastes their Sheet URL or ID once.
3. Client taps `Connect Google` and grants access.
4. Client selects date, session, bodyweight, and default tempo.
5. Client logs sets in the table.
6. Client taps `Save to Sheet`.

## Security notes

- This is a static front-end app. Do not put service account JSON, private keys, or client secrets in GitHub Pages.
- The app uses an OAuth client ID, which is allowed to be public in browser apps.
- The Google access token is kept only in memory and is not saved to local storage.
- The pasted Sheet ID is saved in local storage for convenience.
- Each client must use a Google account that has access to their Sheet.

## Scaling notes

For a small PT client roster, the browser OAuth approach is usually the simplest. If you need a fully public app with many users, account provisioning, or central analytics, consider adding a small backend or a Google Apps Script layer so you can control onboarding, validation, rate limits, and audit logging.
