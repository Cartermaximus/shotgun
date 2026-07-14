# Family Biographer — Product Specification

*Last updated: July 13, 2026 · Status: pre-launch, in family testing*

---

## 1. One-liner

**Family Biographer turns easy, everyday conversations into a professionally
written biography — told in their own voice, and kept for good.**

An iOS app interviews an elderly parent out loud (designed for the car), records
and preserves every answer, and the service turns months of those conversations
into a full-length written biography plus a permanent audio archive, for the
family, forever.

- **Price:** $500 one-time, everything included
- **Planned add-on:** monthly storage subscription to keep the audio archive
  hosted after the biography is delivered (or free download of everything)
- **Domain:** familybiographer.com · **Backend:** Railway · **App:** Expo/React Native (iOS)

## 2. Who it's for

| Role | Who | What they do | What they need |
|---|---|---|---|
| **Buyer** | Adult child, 35–60 | Finds it, pays, gifts it, nudges progress | Trust, clear promise, easy gifting |
| **Storyteller** | Parent/grandparent, 65–90 | Talks. That's it. | Zero learning curve, big print, a warm voice, dignity |
| **Family circle** | Siblings, grandkids | Listen to recordings, add photos, cheer progress | Simple join, shared access |

The buyer and the user are different people. Every flow must survive the
"my 80-year-old dad, alone in his car" test.

## 3. Positioning

| | StoryWorth | Remento | Ghostwriter | **Family Biographer** |
|---|---|---|---|---|
| Price | ~$99/yr | ~$99 | $10,000+ | **$500 once** |
| Input | Typed answers | Voice memos | Interviews | **Spoken conversations, AI-interviewed** |
| Output | Self-written book | Short book | Full biography | **Full-length (~200pp) biography + voice archive** |
| Effort for elder | High (writing) | Medium | Low | **Zero — just talk while driving** |

The moat is the interviewer: it *digs* like a biographer (follow-ups, callbacks,
significance gating) instead of surveying, and the keepsake is the *voice*, not
just text.

## 4. Product principles

1. **The keepsake is never cut.** Record continuously; pauses, laughter, and
   tears stay in. Original audio is preserved forever.
2. **Dig, don't survey.** Chase charged material (people, turning points,
   feelings); abandon mundane veins quickly; let the teller steer.
3. **Nothing to learn.** The storyteller never creates an account, types, or
   configures. A 6-letter code is the entire login.
4. **Kept for good.** Losing a family's recordings is an unforgivable failure.
   (See Gaps §8.2 — this promise is not yet backed by backups.)

## 5. The full customer journey (soup to nuts)

| # | Step | Status |
|---|---|---|
| 1 | Discover: website / App Store / word of mouth | 🟡 Site live; no App Store presence, no marketing |
| 2 | Buy: $500 checkout | ❌ No Stripe — nothing collects money |
| 3 | Gift: send link + 6-letter code | ✅ Built & live |
| 4 | Install: App Store/TestFlight | ❌ Expo Go dev-only; blocked on Apple Developer ($99) |
| 5 | Storyteller onboarding: code → briefing → coaching | ✅ Built |
| 6 | Interviews: voice loop over weeks (~20 hours total) | ✅ Core loop works; in-car robustness unproven (§8.4) |
| 7 | Family engagement: recordings, photos, progress | ✅ Built & live |
| 8 | **Biography production: draft → edit → approve → print** | ❌ **Does not exist in any form** |
| 9 | Delivery: book to the family | ❌ Undefined (format, printer, shipping) |
| 10 | After: storage subscription or full download | ❌ Needs Stripe + export tooling |

## 6. What exists today (shipped & verified)

**iOS app** (Expo, single-file `app/App.js`)
- 5-page sales funnel (hook → problem → solution → proof → paywall), price
  withheld until the paywall page
- Accounts: email + password (bcrypt server-side), sign-in, session tokens
- Gift flow: buyer creates code/link → share sheet; big-print invite web page;
  recipient redeems 6 letters and is in — re-redeemable for phone recovery
- Family circle: invite codes granting shared access (stories, playback, photos)
- Setup: storyteller name + "about them" blurb
- Two-page briefing: mechanics + biographer's coaching (be specific, say the
  names, follow detours, feelings are the story, don't polish)
- Interview loop: neural voice (streams in ~1s) asks; continuous recording;
  7s-of-quiet turn-taking; "Okay, next question" escape hatch; error recovery
  that resumes from the actual failure point
- Home catalog: stories grouped by life chapter (age order), per-story audio
  playback, hours-recorded progress bar toward ~20h target
- Profile: photos of the storyteller (grid + upload)
- Design: "heirloom publisher" — paper/pine/serif; dark in-car interview screen

**Backend** (Express on Railway, JSON-file storage, persistent volume)
- Session engine: transcription (OpenAI) → digging engine (Claude) →
  next question; per-subject arc: rolling biographical summary, theme coverage
  map, callbacks; significance gate + steering invites
- Durable stores: subjects, stories (text + audio ref + bytes), accounts,
  tokens, gifts/family codes, photos, audio files
- TTS endpoint (OpenAI `gpt-4o-mini-tts`), streamed, instructed for a natural pace
- Rate limiting on auth/redeem; change-password endpoint
- Big-print gift invite pages

**Web** (Cloudflare Workers, familybiographer.com)
- Color-blocked marketing site (Fraunces/pine design)
- Privacy, Terms, Refunds (Stripe-ready)
- `/gift/CODE` redirects to invite pages

## 7. Unit economics (rough)

Per fully-interviewed customer (~20 hours):

| Cost | Est. |
|---|---|
| Transcription (~20h audio) | ~$4 |
| Interviewer voice (TTS) | ~$2 |
| Claude (question engine, ~400 turns) | ~$10–20 |
| Biography drafting (LLM passes over ~150k words) | ~$10–30 |
| Hardcover print + ship (if physical, POD) | ~$35–70 |
| Stripe fees (2.9% + 30¢) | ~$15 |
| **Total** | **~$75–140** |

Margin at $500: healthy (~70%+) **if the biography stays AI-drafted with light
human QA**. A real human-editor pass changes the math entirely — decide
deliberately (§9, Open decision D1).

## 8. Gap analysis — what's missing

### 8.1 ❗ The product itself: no biography pipeline
Everything shipped so far is *input*. Nothing turns 20 hours of stories into a
200-page book. Needed:
- **Drafting engine**: chapter planner from the coverage map → per-chapter
  drafts from stories/transcripts (in scenes, preserving the teller's phrases
  and direct quotes), long-form coherence (callbacks, chronology, repeated
  characters), fact table (names, dates, places) to keep the book consistent
- **Transcription QA**: STT will misspell every proper noun (Tommy/Tommie,
  street names). Needs a family review step — likely a simple web page listing
  detected names for correction *before* drafting
- **Revision loop**: family reads a draft, flags corrections, regenerates
- **Format & delivery**: PDF? printed hardcover (Lulu/Blurb print-on-demand)?
  Both? Cover design with the uploaded photos; audio QR codes next to key
  stories would be a signature touch
- **Definition of done**: what does the customer actually receive, when, and
  who approves it?

### 8.2 ❗ "Kept for good" has no backups
All recordings live on **one Railway volume**. A platform failure or fat-
fingered deletion destroys irreplaceable memories of people who may have died
since recording. This is the single most dangerous gap.
- Nightly (ideally continuous) copy of audio + JSON to object storage
  (Cloudflare R2 / Backblaze B2 — both ~free at this scale)
- Restore procedure, tested once
- Longer term: object storage as primary, Postgres for structured data

### 8.3 ❗ Money
- Stripe checkout ($500) gating gift creation / interview start
- Storage subscription (price point? $5–10/mo) after biography delivery
- "Download everything" export (zip of audio + transcripts + photos) as the
  free exit — also the ethical requirement behind the storage upsell
- Sales tax (Stripe Tax), receipts, refund mechanics matching the 30-day promise
- **Apple risk (strategic):** if the $500 unlocks app functionality, Apple
  demands In-App Purchase (30% = $150/sale) and may reject external payment.
  Mitigation: sell on the **web** (the buyer already isn't the app user);
  position as a service + physical goods (the book), which legitimately sits
  outside IAP. Decide before App Store submission; this shapes the funnel.

### 8.4 In-car reality (unproven physics)
- **Road noise vs. the -40dB silence threshold**: at 70mph the cabin may never
  read "quiet" → turns never end. Needs real-car testing; likely an adaptive
  noise floor or proper voice-activity detection
- **Dead zones**: uploads fail mid-drive today with a "tap to retry." Should
  queue recordings locally and sync when signal returns — a drive should never
  be lost or interrupted
- **Interruptions**: phone calls, Siri, navigation prompts mid-answer
- Foreground-only is v1-acceptable (mounted phone) but calls will background it
- Long sessions: battery/heat with screen locked on
- **Driving safety framing**: legal review of "use while driving" positioning;
  the storyteller may also just do it in an armchair — don't over-couple to cars

### 8.5 Trust & security (before strangers' money)
- Real authorization: audio/photos/subject endpoints are guarded only by
  unguessable IDs today; session/interview endpoints are fully open
- Password reset + email verification (needs an email provider — Resend/Postmark;
  also unlocks receipts and "your book is ready" notifications)
- Sign in with Apple (required by App Store once any login exists)
- Consent: a storyteller-facing consent moment (they're told they're recorded,
  but an explicit first-session "yes" recorded on tape is both ethical and
  evidentiary); recording-consent laws vary by state
- Data deletion/export mechanisms (the privacy policy already promises them)
- Encrypt backups; scrub key material from logs

### 8.6 Product completeness (in-app)
- Edit/correct a story's text; delete a story or photo
- Multiple storytellers per account (data model supports it; app UI doesn't —
  a buyer with two living parents is a common, doubled sale)
- The "about them" setup blurb is sent to the backend but **the digging engine
  never reads it** — first questions start cold when they could start warm
- Silence-window setting exists in code with no UI (elderly speakers vary)
- Barge-in: no way to interrupt a question being spoken
- Interview-side view of progress ("we're in your working years now")
- Accessibility: Dynamic Type support (the audience is 65–90!), VoiceOver labels
- Android: eventually — grandparents own Androids at high rates

### 8.7 Operations
- Nothing observes production: no error tracking (Sentry), no uptime alerts,
  no analytics (funnel conversion, session completion rates)
- No admin view: who's stuck, whose interview is done, cost per subject
- Support: support@ inbox exists; no process behind it
- Storage architecture: JSON files won't survive concurrency at even modest
  scale → Postgres + R2 when real customers arrive
- Single Railway instance, in-memory rate limiter (resets on deploy)

### 8.8 Business & legal
- Form an entity (LLC) before taking $500 payments
- Lawyer pass on Terms/Privacy (drafts are solid but unreviewed)
- Substantiate or soften the "$10,000 ghostwriter" comparison
- Replace placeholder testimonials before launch (App Store + FTC risk)
- App Store assets: icon, screenshots, review notes explaining recording
  consent (recording apps get extra scrutiny)

## 9. Open decisions

- **D1 — Who writes the book?** AI-drafted + family review (scales, ~$0) vs.
  AI + human editor pass (better, ~$100–200/book, kills margin at $500).
  Recommendation: AI + strong review tooling at $500; human-edit as a premium
  tier ($1,500+) later.
- **D2 — Deliverable format:** PDF only, or printed hardcover included?
  Recommendation: one printed hardcover + PDF included; extra copies as an
  upsell (families buy 4–6).
- **D3 — Where does purchase happen?** Web checkout (avoids Apple's 30%,
  matches gift-buyer behavior) vs. in-app. Recommendation: web.
- **D4 — Storage plan price** and what free looks like (download always free).
- **D5 — Voice**: current "ash" at conversational pace — test alternatives with
  real storytellers.
- **D6 — Interview target**: is ~20 hours honest for 200 pages? Validate after
  the first full biography draft; adjust the progress bar's promise.

## 10. Suggested roadmap

**Phase 0 — Prove it with Dad (now, ~$99)**
Apple Developer → TestFlight → Dad interviews for real, in a real car.
Fix what the road breaks (silence threshold, dead zones). *Also: stand up
backups (8.2) — before Dad records anything precious.*

**Phase 1 — Take money (1–2 weeks of work)**
Stripe web checkout + storage plan + export download; email provider
(reset/verification/receipts); real authz on media endpoints; entity + lawyer
pass.

**Phase 2 — Deliver a book (the make-or-break)**
Name-correction review page → chapter drafting engine → family revision loop →
print-on-demand hardcover. Run the entire pipeline on Dad's interview as the
pilot book.

**Phase 3 — Public launch**
Sign in with Apple, App Store submission (web purchase positioning), real
testimonials from pilot families, monitoring/analytics, Postgres+R2 migration.

**Phase 4 — Scale & upsells**
Human-edit premium tier, extra copies, multiple storytellers, Android,
"anniversary edition" updates with new stories.
