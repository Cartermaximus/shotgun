# Shotgun — Web Interview Client (test version)

A single HTML page your dad opens in his phone's browser. It speaks each question
aloud, he taps a big button and talks, it shows what it heard, then asks the next
dug question. Built to get **feedback**, not for in-car driving use yet.

## Honest limitations (so the feedback is fair)

- **iOS Safari speech recognition is the weak tier** (your spec flagged this). It
  works but can mishear; there's a **type-instead** fallback button for when it
  struggles. On Android/Chrome it's noticeably better.
- **No hands-free "okay, next question"** while driving — he taps to start and tap
  to stop. Hands-free in the car is what the native app is for later.
- The page needs to reach the **backend** (which holds your API key). So either
  test locally, or deploy the backend somewhere your dad can reach.

---

## Option A — Test it yourself locally (5 minutes, no deploy)

1. Start the backend (from the `backend` folder):
   ```bash
   ANTHROPIC_API_KEY=sk-ant-... npm start
   ```
   It prints `Shotgun backend on :8787`.
2. Open `web/index.html` in Chrome on your Mac.
3. In setup, enter a name and server address `http://localhost:8787`, hit Continue.
4. Allow the microphone when asked, and talk. (Chrome desktop speech works well.)

## Option B — Send it to your dad (deploy, ~15 min)

Your dad's phone can't reach `localhost` on your Mac, so the backend goes online.
Easiest path is **Railway** (or Render — same idea):

1. Put the `backend` folder in a GitHub repo.
2. On railway.app: New Project → Deploy from GitHub → pick the repo.
3. Add an environment variable: `ANTHROPIC_API_KEY = sk-ant-...`
4. Railway gives you a URL like `https://shotgun-production.up.railway.app`.
   Test it: open `THAT-URL/health` in a browser — you should see `{"ok":true}`.
5. **Host the web page.** Easiest free option: drag the `web` folder onto
   netlify.com (or use GitHub Pages). You'll get a URL like
   `https://your-story.netlify.app`.
6. Text your dad that link. On first open he enters his name + the **Railway URL**
   as the server address, taps Continue, and starts talking.

> Tip: pre-fill it for him. You can open the page once on a phone, type the server
> address, and the page remembers it — or just walk him through the one-time setup
> screen over the phone. After that he only ever sees the big button.

---

## What he'll experience

1. A one-time setup screen (name + server) — you can do this for him.
2. A one-time safety note (set up before driving; just talk; pull over to fiddle).
3. Then: a question read aloud → tap the amber button → talk → tap when done →
   it thinks for a second (with a spoken bridge phrase) → next question.

## When you're ready for the real thing

The native iPhone app (Expo/React Native) is what adds: reliable speech, the
hands-free "okay, next question" key phrase, durable **audio recording** (the
keepsake — this web version does NOT save his actual voice yet), and proper in-car
behavior. The backend you just deployed stays exactly the same; only the front
door changes.
