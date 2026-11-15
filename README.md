# LearnLoop – AI Study Buddy

LearnLoop turns any lesson into notes, flashcards, quizzes, practice tests and a podcast.
It was made as a Class 9 science project.

**Live app:** https://scalioz.github.io/learnloop/

## Features

| Feature | What it does |
|---|---|
| Upload anything | Paste notes, upload a PDF, add photos of textbook pages, paste a YouTube transcript, record a lecture, or type a topic |
| Smart Notes | Summary, notes in sections and key terms |
| Flashcards | Cards move from New → Learning → Almost there → Mastered. Includes a Match game and card editing |
| Quiz | Multiple choice and fill in the blanks, with explanations for wrong answers |
| Practice Test | Write full answers. AI gives marks and a model answer |
| Ask Loopy | AI tutor that answers doubts from the student's own chapter |
| Listen | Turns the chapter into a two-host audio podcast |
| Voice to Notes | Records the teacher and turns speech into text |
| Photo Solve | Step-by-step help from a photo of a question |
| Essay Check | Rubric marks, corrections and tips |
| Explore | Ready-made Class 9 study sets |
| Progress | Mastery, quiz scores over time, copy results as a table |

## How it is built

- `index.html` – the landing page
- `app.html` – the whole app (runs in the browser, hosted on GitHub Pages)
- `config.js` – the address of the AI server
- `library.json` – the ready-made study sets shown in Explore
- `worker/worker.js` – a small Cloudflare Worker that keeps the AI key secret and talks to Anthropic's Claude API (Claude Sonnet 5.5, with Claude Haiku 5.5 as backup)

Study sets and progress are saved on the student's own device (browser storage).
Voice recording and read-aloud use the browser's built-in speech features (best in Google Chrome or Microsoft Edge).

## Setup (one time)

1. **Get a Claude API key:** console.anthropic.com → Billing → add credit → API keys → Create key → copy it.
2. **Create the AI server:** Cloudflare dashboard → Workers & Pages → Create → Create Worker → name it `learnloop-ai` → Deploy → Edit code → replace everything with `worker/worker.js` → Deploy.
3. **Add settings:** Worker → Settings → Variables and Secrets → Add:
   - `ANTHROPIC_API_KEY` (type Secret) = your Claude API key
   - `ALLOWED_ORIGINS` (type Text) = `https://scalioz.github.io`
4. **Connect the app:** put the Worker address into `config.js`.
5. **Turn on GitHub Pages:** repo Settings → Pages → Branch `main`, folder `/ (root)` → Save.

To check the AI server, open the Worker address in a browser. It should show `"keySet": true`.
