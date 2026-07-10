# Shotgun — Native iPhone App (v1) + Launch Path

Conversation mode, as designed: the app is open on a mounted phone, it asks a
question aloud, your dad just talks. It records his actual voice continuously
(pauses and all — the keepsake is never cut), waits through a long 7-second
silence before considering an answer done, sends the audio to the backend,
and speaks the next dug question. "Okay, next question" skips a probe.

## The three pieces

1. `backend/` — the brain (Claude digging engine + transcription + audio archive)
2. `app/` — the native iPhone app (Expo / React Native)
3. `web/` — the browser test version (still useful for quick feedback)

## Step 1 — Deploy the backend (do this first; the app needs a URL)

Railway (or Render/Replit — same idea):
1. Push `backend/` to a GitHub repo.
2. railway.app → New Project → Deploy from GitHub.
3. Set environment variables:
   - `ANTHROPIC_API_KEY` = your Anthropic key (the digging engine)
   - `OPENAI_API_KEY` = an OpenAI key (transcription; ~$0.003/min)
4. IMPORTANT: add a **persistent volume** mounted at `/app/data` (Railway:
   right-click service → Volume). That's where his voice recordings live.
   Without it, audio is lost on redeploys.
5. Grab the URL, check `https://YOUR-URL/health` shows `{"ok":true}`.

## Step 2 — Run the app on your own iPhone (Mac, ~30 min first time)

```bash
# one-time
brew install node          # if you don't have Node
cd app
npm install
npx expo start
```

Install **Expo Go** from the App Store on your iPhone, scan the QR code that
appears, and the app opens on your phone. Enter the server URL from Step 1,
tap Start talking, and have a session. (Expo Go is the zero-Xcode dev loop.)

Tune in the car: `METERING_SILENCE_DB` in App.js is the mic level that counts
as "talking" — road noise may need it raised toward -35.

## Step 3 — TestFlight (get it on your dad's phone, pre-App Store)

1. Apple Developer Program ($99/yr): developer.apple.com → enroll (1–2 days).
2. `npm install -g eas-cli && eas login` (free Expo account).
3. `eas build --platform ios` — builds in Expo's cloud, no Xcode. It walks
   you through Apple credentials the first time.
4. `eas submit --platform ios` — pushes to App Store Connect.
5. In App Store Connect → TestFlight → add your dad as a tester (his Apple
   ID email). He gets an email, installs TestFlight, taps your app. Done —
   he's using the real native app, no App Store review yet (internal testers).

## Step 4 — App Store launch

Same build, plus in App Store Connect: screenshots, description, privacy
labels (declare: audio recordings, collected, linked to user), age rating,
then Submit for Review. Expect ~24h review; budget for one rejection round
(usually metadata or a privacy-label miss). Total cost: the $99/yr.

## What's still deliberately v1

- Foreground only: screen stays awake (the app forces this), phone mounted.
  Locking the phone ends listening. That matches "listens while the app is open."
- Batch transcription per answer, not streaming — swap later behind the same
  endpoint if you want live partials.
- Audio archive is on the server volume, single copy. Before selling this to
  strangers, move to S3/R2 with replication (Phase 2 of the spec).
- No "okay, next question" *interrupt* mid-recording — the phrase is honored
  once transcribed (it still skips the probe), and the long-silence end means
  in practice it works the same. True live interrupt = streaming STT, v2.

## Cost reminder (from our estimate)

~$10–15 of AI+transcription for a full 20-hour archive. Testing with your
dad: cents. Railway ~$5/mo. The $99 Apple fee is the biggest line item.
