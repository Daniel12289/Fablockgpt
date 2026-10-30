# FABLOCK AI BUILDER PRO (frontend)

Static site, no build step. Talks to the Floot backend `https://fablockgpt.floot.app/_api`,
which holds the Groq key (`GROQ_API_KEY`) server-side. The key is never in this folder.

## Deploy on Vercel
1. Put these files in a repo (or drag the folder into Vercel). Framework preset: **Other**, no build command, output directory = root.
2. Open the Vercel URL and sign in with an account the owner created.

## Files
- `index.html`, `app.js`, `styles.css` - the app
- `preview.html` - sandboxed preview runtime (served with a `sandbox` CSP by `vercel.json`)
- `config.js` - backend address
- `vercel.json` - headers

## Notes
- CORS on the backend is open (`*`) and auth uses a bearer token in `?token=`, so any origin works.
- Live preview supports plain HTML/CSS/JS. React/JSX is not previewed.
- Create user accounts with the backend admin endpoint `POST /admin/user`.
