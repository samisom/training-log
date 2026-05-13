window.WORKOUT_APP_CONFIG = {
  APP_NAME: 'PT Workout Logger',
  GOOGLE_CLIENT_ID: '923710834899-14d19addl44a6ju5i2dm8ijdiuer6j1t.apps.googleusercontent.com',
  SHEETS_SCOPE: 'https://www.googleapis.com/auth/spreadsheets',
  DEFAULT_ROWS: 8,
  RANGES: {
    exercises: 'Exercise_Library!B4:K300',
    prTracker: 'PR_Tracker!B5:L300',
    log: 'Log!B5:P5000',
    appendLog: 'Log!B4:P'
  },
  SESSIONS: [
    { name: 'Legs', categories: ['Quads', 'Hamstrings', 'Glutes & Hips', 'Calves'] },
    { name: 'Push', categories: ['Chest', 'Shoulders - Anterior', 'Shoulders - Lateral', 'Triceps'] },
    { name: 'Pull', categories: ['Back - Vertical Pull', 'Back - Horizontal Pull', 'Biceps', 'Shoulders - Posterior', 'Forearms & Grip'] },
    { name: 'Upper', categories: ['Chest', 'Back - Vertical Pull', 'Back - Horizontal Pull', 'Shoulders - Anterior', 'Shoulders - Lateral', 'Shoulders - Posterior', 'Biceps', 'Triceps', 'Forearms & Grip'] },
    { name: 'Core', categories: ['Core & Abs'] },
    { name: 'Full Body', categories: ['*'] },
    { name: 'All Exercises', categories: ['*'] }
  ]
};
