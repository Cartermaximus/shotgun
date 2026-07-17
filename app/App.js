// App.js — Family Biographer native client (v1, conversation mode)
//
// The in-car experience (spec §5.1, updated per our design decisions):
//   - App open on a mounted phone, screen kept awake.
//   - Question spoken aloud (TTS over Bluetooth like any audio).
//   - Mic records CONTINUOUSLY through the whole answer — pauses, crying,
//     trailing off all stay in the recording (the keepsake is never cut).
//   - Turn ends on a LONG silence (default 7s, adjustable) measured via
//     mic level metering — no tap needed. "Okay, next question" also works:
//     it's honored server-side as the escape hatch once transcribed.
//   - Audio uploads to the backend → transcribed → digging engine → next
//     question comes back and is spoken. Loop.
//
// v1 constraints (deliberate): foreground only (screen on, phone mounted —
// matches "listens while the app is open"), batch transcription per answer.
//
// Design language: "heirloom publisher" — warm paper, deep pine green,
// serif display type (the category convention for memoir/keepsake apps).
// The interview screen alone stays dark: it's used mounted in a car,
// often at night, where a bright screen is glare.

import React, { useEffect, useRef, useState } from "react";
import {
  ScrollView, View, Text, Pressable, TextInput, StyleSheet, AppState, Share,
  KeyboardAvoidingView, Image,
} from "react-native";
import * as Linking from "expo-linking";
import * as ImagePicker from "expo-image-picker";
// NOT react-native's SafeAreaView — that one overwrites style padding with
// the device insets (0 on the sides), which erased every side margin.
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { Audio } from "expo-av";
import * as Speech from "expo-speech";
import { useKeepAwake } from "expo-keep-awake";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { StatusBar } from "expo-status-bar";

// ---------- tunables --------------------------------------------------------
// The one production backend every install talks to. Users never see or set
// this.
const SERVER_URL = "https://shotgun-backend-production.up.railway.app";

const DEFAULT_SILENCE_MS = 7000;   // long & forgiving — capture the pauses
const MIN_ANSWER_MS = 1500;        // ignore blips shorter than this
const METERING_SILENCE_DB = -40;   // below this = "quiet" (tune in real car)
const METER_INTERVAL_MS = 300;

const COLORS = {
  // light (funnel, setup, briefing)
  paper: "#FBF8F3",      // warm white — the page of a book
  ink: "#22302B",        // near-black green — body text
  inkSoft: "#5C6B64",    // secondary text
  pine: "#2E5947",       // brand green — buttons, links, active states
  pineDeep: "#1F4033",   // pressed / emphasis
  sageTint: "#E7EFE9",   // soft green fill for cards
  hairline: "#E4DFD5",   // borders on paper
  // dark (in-car interview screen)
  night: "#101B16",      // near-black green
  moon: "#F2F5F0",       // text on night
  moonDim: "#9AA8A0",    // secondary text on night
  sage: "#A8C5B4",       // listening accent on night
};

const SERIF = "Georgia"; // iOS system serif — the editorial/book voice

const SERVER = SERVER_URL.replace(/\/$/, "");

// Life chapters, in age order — mirrors the backend's THEMES. The home
// screen catalogs everything told so far under these headings.
const CHAPTERS = [
  ["childhood", "Childhood"],
  ["growing_up", "Growing up"],
  ["family_and_parents", "Family & parents"],
  ["love_and_relationships", "Love & relationships"],
  ["work_and_purpose", "Work & purpose"],
  ["hard_times", "Hard times"],
  ["beliefs_and_legacy", "Beliefs & legacy"],
];

export default function App() {
  return (
    <SafeAreaProvider>
      <FamilyBiographer />
    </SafeAreaProvider>
  );
}

function FamilyBiographer() {
  useKeepAwake(); // never let the screen sleep mid-session (in-car essential)

  // config
  const [name, setName] = useState("");
  const [about, setAbout] = useState("");
  const [subjectId, setSubjectId] = useState(null);
  const [configured, setConfigured] = useState(false);
  const [silenceMs, setSilenceMs] = useState(DEFAULT_SILENCE_MS);
  const [showSales, setShowSales] = useState(true); // funnel shows first
  const [salesPage, setSalesPage] = useState(0);    // which funnel page
  const [briefPage, setBriefPage] = useState(0);    // briefing: mechanics, then coaching
  const [view, setView] = useState(null);           // "home" | "account" | null
  const [stories, setStories] = useState([]);       // everything told so far
  const [photos, setPhotos] = useState([]);         // pictures of the storyteller
  const [audioBytes, setAudioBytes] = useState(0);  // total recorded audio (progress)
  const [playingAudio, setPlayingAudio] = useState(null); // story audio file now playing

  // account (email + password; sessions are backend tokens)
  const [account, setAccount] = useState(null);
  const [buyerName, setBuyerName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState("create"); // "create" | "signin"

  // gifting — buyer side creates a code/link; recipient side redeems it
  const [giftName, setGiftName] = useState("");
  const [giftResult, setGiftResult] = useState(null); // { code, url }
  const [giftCodeInput, setGiftCodeInput] = useState("");

  // conversation state machine: setup | brief | asking | listening | thinking | error
  const [phase, setPhase] = useState("setup");
  const [question, setQuestion] = useState("");
  const [heard, setHeard] = useState("");
  const [status, setStatus] = useState("");

  const recordingRef = useRef(null);
  const lastLoudRef = useRef(0);
  const startedTalkingRef = useRef(false);
  const meterTimer = useRef(null);
  const soundRef = useRef(null);
  const aliveRef = useRef(true);
  // True only while an interview is actually running. Guards every step of
  // the ask→listen chain so that stopping speech (which resolves pending
  // speak() promises) can never accidentally start the microphone after the
  // session has ended — the bug where "End session" began listening.
  const sessionActiveRef = useRef(false);
  // An answer that recorded fine but failed to upload — kept so "tap to
  // retry" actually re-sends it instead of silently re-recording.
  const pendingUploadRef = useRef(null);

  // ---------- boot: restore config ------------------------------------------
  useEffect(() => {
    (async () => {
      const [n, a, id, sil, acRaw] = await Promise.all([
        AsyncStorage.getItem("name"), AsyncStorage.getItem("about"),
        AsyncStorage.getItem("subjectId"), AsyncStorage.getItem("silenceMs"),
        AsyncStorage.getItem("account"),
      ]);
      if (n) setName(n);
      if (a) setAbout(a);
      if (sil) setSilenceMs(Number(sil) || DEFAULT_SILENCE_MS);
      let acct = null;
      if (acRaw) {
        try { acct = JSON.parse(acRaw); } catch { /* corrupt — ignore */ }
        if (acct) { setAccount(acct); setEmail(acct.email || ""); }
      }
      if (id) {
        setSubjectId(id);
        // Returning user with stories on file → land on the home catalog,
        // not the sales funnel.
        const st = await loadStories(id);
        if (st.length) { setShowSales(false); setView("home"); return; }
      }
      // Signed in but no stories yet → straight to setup, skip the funnel.
      if (acct) setShowSales(false);
    })();
    // "background" only — the mic-permission alert briefly makes the app
    // "inactive", and treating that as backgrounding would kill the session.
    const sub = AppState.addEventListener("change", (st) => {
      if (st === "background") {
        sessionActiveRef.current = false;
        stopEverything();
      }
    });
    return () => { aliveRef.current = false; sub.remove(); stopEverything(); };
  }, []);

  async function loadStories(id) {
    try {
      const r = await fetch(`${SERVER}/subject/${id}`);
      const data = await r.json();
      const st = Array.isArray(data.stories) ? data.stories : [];
      setStories(st);
      setPhotos(Array.isArray(data.photos) ? data.photos : []);
      setAudioBytes(data.audioBytes || 0);
      return st;
    } catch {
      return [];
    }
  }

  // Replay a saved recording — the keepsake, in their own voice.
  async function togglePlayback(st) {
    const snd = soundRef.current;
    soundRef.current = null;
    if (snd) await snd.unloadAsync().catch(() => {});
    if (playingAudio === st.audio) { setPlayingAudio(null); return; } // tapped stop
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false, playsInSilentModeIOS: true, staysActiveInBackground: false,
      });
      const { sound } = await Audio.Sound.createAsync(
        { uri: `${SERVER}/subject/${subjectId}/audio/${st.audio}` },
        { shouldPlay: true }
      );
      soundRef.current = sound;
      setPlayingAudio(st.audio);
      sound.setOnPlaybackStatusUpdate((ps) => {
        if (!ps.isLoaded || ps.didJustFinish) setPlayingAudio(null);
      });
    } catch {
      setPlayingAudio(null);
    }
  }

  // Add a photo of the storyteller (for the biography's illustrations).
  async function addPhoto() {
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"], quality: 0.8,
    }).catch(() => null);
    if (!picked || picked.canceled || !picked.assets?.length) return;
    const asset = picked.assets[0];
    setStatus("Uploading photo…");
    try {
      const form = new FormData();
      form.append("photo", {
        uri: asset.uri,
        name: asset.fileName || "photo.jpg",
        type: asset.mimeType || "image/jpeg",
      });
      const r = await fetch(`${SERVER}/subject/${subjectId}/photos`, { method: "POST", body: form });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { setStatus(data.error || "Couldn't upload that photo — try again."); return; }
      setPhotos(data.photos || []);
      setStatus("");
    } catch {
      setStatus("Couldn't upload that photo — try again.");
    }
  }

  // Invite the rest of the family to see stories, hear recordings, add photos.
  async function inviteFamily() {
    if (!account?.token) { setStatus("Create your account first."); return; }
    try {
      const r = await fetch(`${SERVER}/family`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: account.token, subjectId, recipientName: name }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { setStatus(data.error || "Something went wrong — try again."); return; }
      await Share.share({
        message:
          `Join ${name || "our"} family circle on Family Biographer — see the stories, ` +
          `hear the recordings in their own voice, and add photos.\n\n` +
          `Get the app, tap "I have a gift code", and enter ${data.code}\n${data.url}`,
      }).catch(() => {});
    } catch {
      setStatus("Couldn't reach the server — try again.");
    }
  }

  async function submitAccount() {
    const em = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) {
      setStatus("Enter a valid email address."); return;
    }
    if (authMode === "create" && password.length < 8) {
      setStatus("Password needs at least 8 characters."); return;
    }
    setStatus("One moment…");
    try {
      const path = authMode === "create" ? "signup" : "login";
      const r = await fetch(`${SERVER}/account/${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: em, password, name: buyerName.trim() }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { setStatus(data.error || "Something went wrong — try again."); return; }
      const acct = { token: data.token, email: data.email, name: data.name };
      await AsyncStorage.setItem("account", JSON.stringify(acct));
      setAccount(acct);
      setPassword("");
      setStatus("");
      if (stories.length) { setView("home"); }
      else { setView(null); setShowSales(false); } // on to interview setup
    } catch {
      setStatus("Couldn't reach the server — try again.");
    }
  }

  // Recipient side of a gift: the 6-letter code signs this phone in and
  // links it to the buyer's account — no email or password for them.
  // Redeeming again (new phone, reinstall) recovers the same story.
  async function redeemGift(codeRaw) {
    const code = String(codeRaw || "").trim().toUpperCase();
    if (code.length !== 6) { setStatus("The code is 6 letters — check the gift page."); return; }
    setStatus("One moment…");
    try {
      const r = await fetch(`${SERVER}/gift/redeem`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { setStatus(data.error || "That code didn't work — check the letters."); return; }
      const acct = {
        gift: data.role !== "family",
        family: data.role === "family",
        email: data.buyerEmail, buyerName: data.buyerName,
      };
      await AsyncStorage.multiSet([
        ["subjectId", data.subjectId],
        ["name", data.recipientName],
        ["account", JSON.stringify(acct)],
      ]);
      setSubjectId(data.subjectId);
      setName(data.recipientName);
      setAccount(acct);
      setStatus("");
      const st = await loadStories(data.subjectId);
      setShowSales(false);
      if (st.length) setView("home");
      else setView(null); // setup, with their name already filled in
    } catch {
      setStatus("Couldn't reach the server — try again.");
    }
  }

  // Buyer side: create the gift, then hand the link to Messages/Mail.
  async function createGift() {
    if (!account?.token) { setStatus("Create your account first."); return; }
    const who = giftName.trim();
    if (!who) { setStatus("Who is the gift for?"); return; }
    setStatus("One moment…");
    try {
      const r = await fetch(`${SERVER}/gift`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: account.token, recipientName: who }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { setStatus(data.error || "Something went wrong — try again."); return; }
      setGiftResult(data);
      setStatus("");
    } catch {
      setStatus("Couldn't reach the server — try again.");
    }
  }

  async function shareGift() {
    if (!giftResult) return;
    await Share.share({
      message:
        `I got you Family Biographer — it turns your stories into a biography for the family, ` +
        `just by talking.\n\nOpen this link on your phone and follow the three steps:\n` +
        `${giftResult.url}\n\nYour code is ${giftResult.code}`,
    }).catch(() => {});
  }

  // Gift links (familybiographer://gift/CODE) open the app already signed in.
  useEffect(() => {
    const handle = (url) => {
      const m = String(url || "").match(/gift[/=]([A-Za-z0-9]{6})/);
      if (m) redeemGift(m[1]);
    };
    Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener("url", (e) => handle(e.url));
    return () => sub.remove();
  }, []);

  function stopEverything() {
    Speech.stop();
    const snd = soundRef.current;
    soundRef.current = null;
    if (snd) snd.unloadAsync().catch(() => {});
    if (meterTimer.current) clearInterval(meterTimer.current);
    const rec = recordingRef.current;
    recordingRef.current = null;
    if (rec) rec.stopAndUnloadAsync().catch(() => {});
  }

  // ---------- speech out ------------------------------------------------------
  // Primary voice: the backend's /tts endpoint (neural, warm). Falls back to
  // the on-device system voice if the server can't be reached.
  async function speak(text) {
    if (!text) return;
    try {
      // Playback mode first — with recording mode active, iOS routes audio
      // to the tiny earpiece speaker instead of the loud one.
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
      });
      const { sound } = await Audio.Sound.createAsync(
        { uri: `${SERVER}/tts?text=${encodeURIComponent(text.slice(0, 1200))}` },
        { shouldPlay: true }
      );
      soundRef.current = sound;
      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(watchdog);
          resolve();
        };
        // Watchdog so a lost status callback can never freeze the loop.
        const watchdog = setTimeout(finish, 6000 + text.length * 120);
        sound.setOnPlaybackStatusUpdate((st) => {
          if (!st.isLoaded || st.didJustFinish) finish();
        });
      });
      soundRef.current = null;
      await sound.unloadAsync().catch(() => {});
    } catch {
      await speakLocal(text);
    }
  }

  function speakLocal(text) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        resolve();
      };
      // Watchdog: expo-speech's completion callbacks occasionally never fire
      // on iOS, which used to freeze the whole loop before the mic opened.
      const watchdog = setTimeout(finish, 2500 + text.length * 100);
      Speech.speak(text, { rate: 0.95, onDone: finish, onStopped: finish, onError: finish });
    });
  }

  // ---------- the loop --------------------------------------------------------
  async function saveSetup() {
    let id = subjectId;
    if (!id) {
      id = "subj_" + Math.random().toString(36).slice(2, 10);
      setSubjectId(id);
    }
    await AsyncStorage.multiSet([
      ["name", name], ["about", about], ["subjectId", id],
      ["silenceMs", String(silenceMs)],
    ]);
    setStatus("");
    setBriefPage(0);
    setConfigured(true);
    setPhase("brief");
  }

  async function startSession() {
    sessionActiveRef.current = true;
    setPhase("thinking");
    setStatus("Starting…");
    try {
      // Ask for the mic up front — we're about to need it. (speak() and
      // beginRecording() each set the right audio mode for their turn.)
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) {
        setPhase("error"); setStatus("Family Biographer needs the microphone to hear the answers. Allow it in Settings, then tap to continue.");
        return;
      }
      const r = await fetch(`${SERVER}/session/start`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subjectId, subjectName: name, subjectNotes: about }),
      });
      const data = await r.json();
      if (data.capped) {
        sessionActiveRef.current = false;
        setConfigured(false);
        setShowSales(false);
        setView("home");
        setStatus(data.message || "The interview is complete — a full book's worth of stories.");
        return;
      }
      await askAndListen(data.question, data.intro, subjectId);
    } catch {
      setPhase("error"); setStatus("Couldn't connect. Check your signal and tap to try again.");
    }
  }

  async function askAndListen(q, bridge, id) {
    if (!aliveRef.current || !sessionActiveRef.current) return;
    setQuestion(q); setHeard(""); setPhase("asking"); setStatus("");
    if (bridge) await speak(bridge);
    await speak(q);
    if (!sessionActiveRef.current) return; // session ended while speaking
    await beginRecording(id);
  }

  async function beginRecording(id) {
    if (!sessionActiveRef.current) return;
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) { setPhase("error"); setStatus("Microphone permission needed."); return; }
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
      });
      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync({
        ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
        isMeteringEnabled: true,
      });
      await rec.startAsync();
      recordingRef.current = rec;
      lastLoudRef.current = Date.now();
      startedTalkingRef.current = false;
      setPhase("listening");
      setStatus("Listening — take all the time you need.");

      const startedAt = Date.now();
      meterTimer.current = setInterval(async () => {
        const r = recordingRef.current;
        if (!r) return;
        let st;
        try { st = await r.getStatusAsync(); } catch { return; }
        const db = st.metering ?? -160;
        const now = Date.now();
        if (db > METERING_SILENCE_DB) {
          lastLoudRef.current = now;
          if (now - startedAt > MIN_ANSWER_MS) startedTalkingRef.current = true;
        }
        // End of turn: they've talked, then gone quiet for the long window.
        if (startedTalkingRef.current && now - lastLoudRef.current >= silenceMs) {
          clearInterval(meterTimer.current);
          await finishTurn(id);
        }
      }, METER_INTERVAL_MS);
    } catch (e) {
      setPhase("error"); setStatus("Recording failed to start. Tap to retry.");
    }
  }

  async function finishTurn(id) {
    const rec = recordingRef.current;
    recordingRef.current = null;
    if (!rec) return;
    setPhase("thinking"); setStatus("");
    let uri = null;
    try {
      await rec.stopAndUnloadAsync();
      uri = rec.getURI();
    } catch { /* fallthrough */ }
    if (!uri) { setPhase("error"); setStatus("Lost the recording — tap to continue."); return; }
    await uploadAnswer(uri, id);
  }

  async function uploadAnswer(uri, id) {
    setPhase("thinking"); setStatus("");
    try {
      const form = new FormData();
      form.append("subjectId", id);
      form.append("audio", { uri, name: "answer.m4a", type: "audio/m4a" });
      const r = await fetch(`${SERVER}/session/answer-audio`, { method: "POST", body: form });
      if (!r.ok) throw new Error(String(r.status));
      pendingUploadRef.current = null;
      const data = await r.json();
      if (data.empty) {
        // Silence with no real speech — just re-open the mic on the same question.
        await speak("I'm still here whenever you're ready.");
        await beginRecording(id);
        return;
      }
      setHeard(data.transcript || "");
      const lead = data.acknowledgment || data.bridge;
      await askAndListen(data.question, lead, id);
    } catch {
      pendingUploadRef.current = { uri, id };
      setPhase("error");
      setStatus("Couldn't send that answer. It's saved on the phone — tap to retry.");
    }
  }

  // The one error-recovery button. Resume from wherever things actually broke:
  // a failed upload re-sends the saved answer; a failed session start
  // reconnects; otherwise re-open the mic on the current question.
  function retryFromError() {
    sessionActiveRef.current = true;
    const pending = pendingUploadRef.current;
    if (pending) return uploadAnswer(pending.uri, pending.id);
    if (!question) return startSession();
    return beginRecording(subjectId);
  }

  async function endSession() {
    sessionActiveRef.current = false;
    stopEverything();
    setPhase("thinking"); setStatus("Wrapping up…");
    try {
      await fetch(`${SERVER}/session/end`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subjectId }),
      });
    } catch { /* non-fatal */ }
    setQuestion(""); setHeard("");
    setPhase("setup"); setConfigured(false);
    setStatus("Session saved. See you next drive.");
    // Land on the story catalog, freshly updated with this session.
    await loadStories(subjectId);
    setShowSales(false);
    setView("home");
  }

  // ---------- UI --------------------------------------------------------------

  // Sales funnel — the FIRST thing a prospective buyer sees. One idea per
  // page, tapped through in order (hook → problem → solution → proof →
  // paywall), price withheld until value is built. Progress dots up top,
  // back chevron on every page after the first.
  // NOTE: the final CTA currently advances to the setup screen. Once the
  // account (Sign in with Apple) and payment (Stripe) steps exist, gate them
  // HERE — Funnel → Account → Pay → Setup → Interview.
  const funnelPages = [
    {
      key: "hook",
      cta: "Start their story",
      render: () => (
        <>
          <Text style={s.eyebrow}>FAMILY BIOGRAPHER</Text>
          <Text style={s.h1}>Their stories deserve to outlive them.</Text>
          <Text style={s.subhead}>
            Family Biographer turns easy, everyday conversations into a beautifully written
            biography — told in their own voice, and kept for good.
          </Text>
          <Image source={require("./assets/drive.png")} style={s.illo} resizeMode="cover" />
        </>
      ),
    },
    {
      key: "problem",
      cta: "Continue",
      render: () => (
        <>
          <Text style={s.h1}>One day, the stories stop.</Text>
          <Text style={s.subhead}>
            Everyone you love is carrying a thousand stories no one has written
            down — how they met, the year everything changed, the advice they'd
            give if you ever asked. Then one day it all goes quiet. Not because
            we didn't care. Because we never quite got around to asking.
          </Text>
        </>
      ),
    },
    {
      key: "solution",
      cta: "Continue",
      render: () => (
        <>
          <Text style={s.h1}>So we made asking effortless.</Text>
          <Image source={require("./assets/book.png")} style={s.illo} resizeMode="cover" />
          <View style={s.step}>
            <Text style={s.stepNum}>1</Text>
            <View style={s.stepBody}>
              <Text style={s.stepTitle}>Just talk.</Text>
              <Text style={s.stepText}>
                Mount the phone and drive. Family Biographer rides along and asks the
                questions a great biographer would — one at a time, warm and
                unhurried.
              </Text>
            </View>
          </View>
          <View style={s.step}>
            <Text style={s.stepNum}>2</Text>
            <View style={s.stepBody}>
              <Text style={s.stepTitle}>We chase the real story.</Text>
              <Text style={s.stepText}>
                It listens for the moments that matter — the people, the turning
                points, the things they've never told anyone — and keeps every
                word in their own voice.
              </Text>
            </View>
          </View>
          <View style={s.step}>
            <Text style={s.stepNum}>3</Text>
            <View style={s.stepBody}>
              <Text style={s.stepTitle}>You receive their biography.</Text>
              <Text style={s.stepText}>
                We turn those conversations into a professionally written life
                story, delivered to you — a keepsake for your whole family.
              </Text>
            </View>
          </View>
        </>
      ),
    },
    {
      key: "proof",
      cta: "Continue",
      render: () => (
        <>
          <Text style={s.h1}>What families say</Text>
          {/* SOCIAL PROOF — PLACEHOLDER. Replace with real, verified quotes before
              launch. Never ship fabricated testimonials (dishonest + App Store risk). */}
          {[
            { q: "I have my father's voice telling the story of the day I was born. I'll have it forever.", who: "Sarah, a daughter (sample)" },
            { q: "My dad would never sit for an interview. But he'll talk for an hour in the car. This got stories out of him I'd never heard.", who: "Michael, a son (sample)" },
          ].map((t) => (
            <View style={s.quoteCard} key={t.who}>
              <Text style={s.quoteText}>“{t.q}”</Text>
              <Text style={s.quoteAttr}>— {t.who}</Text>
            </View>
          ))}
        </>
      ),
    },
    {
      key: "paywall",
      cta: "Start their story",
      footnote: "Secure checkout · $500 one time",
      render: () => (
        <>
          <Text style={s.h1}>Everything included</Text>
          <Image source={require("./assets/gift.png")} style={s.illoSmall} resizeMode="cover" />
          {[
            "A professionally written biography of their life",
            "Every conversation preserved in their own voice",
            "Guided interviews that draw out the untold stories",
            "A keepsake your family keeps for generations",
          ].map((b) => (
            <View style={s.benefit} key={b}>
              <Text style={s.benefitDot}>✓</Text>
              <Text style={s.benefitText}>{b}</Text>
            </View>
          ))}
          {/* PRICE ANCHOR — expensive alternative, crossed out, then the price */}
          {/* NOTE: only keep the $10,000 comparison if it's a defensible claim. */}
          <View style={s.priceCard}>
            <Text style={s.priceStrike}>Ghostwritten memoirs run $10,000 and up</Text>
            <Text style={s.priceBig}>$500</Text>
            <Text style={s.priceSub}>One time. Everything above included.</Text>
          </View>
          {/* RISK REVERSAL — PLACEHOLDER. Only keep if you will honor this refund. */}
          <View style={s.guaranteeCard}>
            <Text style={s.guaranteeText}>
              Love it, or it's free. If your first conversations don't move you,
              we'll refund every cent.
            </Text>
          </View>
        </>
      ),
    },
  ];

  // Home — the story so far, cataloged by life chapter, oldest age first.
  // Shown to returning users instead of the sales funnel.
  if (!configured && view === "home") {
    const grouped = CHAPTERS
      .map(([key, label]) => [label, stories.filter((st) => st.theme === key)])
      .filter(([, list]) => list.length > 0);
    return (
      <SafeAreaView style={s.rootLight}>
        <StatusBar style="dark" />
        <KeyboardAvoidingView style={s.kav} behavior="padding">
        <ScrollView contentContainerStyle={s.homeScroll} showsVerticalScrollIndicator={false}>
          <Text style={s.eyebrow}>FAMILY BIOGRAPHER</Text>
          <Text style={s.h1}>{name ? `${name}'s story so far` : "The story so far"}</Text>
          <Text style={s.subhead}>
            {stories.length} {stories.length === 1 ? "story" : "stories"} saved for your family.
          </Text>
          {/* Progress toward a full-length biography (~200 pages ≈ ~20 hours
              of recorded material at ~1MB per minute of audio). */}
          {audioBytes > 0 && (() => {
            const mins = Math.round(audioBytes / 1e6);
            const target = 20 * 60;
            const pct = Math.min(100, (mins / target) * 100);
            return (
              <View style={s.progressWrap}>
                <View style={s.progressBar}>
                  <View style={[s.progressFill, { width: `${Math.max(2, pct)}%` }]} />
                </View>
                <Text style={s.progressText}>
                  ≈{Math.floor(mins / 60)}h {mins % 60}m recorded · a full biography
                  wants ~20 hours of stories
                </Text>
              </View>
            );
          })()}
          {grouped.map(([label, list]) => (
            <View style={s.chapter} key={label}>
              <Text style={s.chapterTitle}>{label}</Text>
              {list.map((st, i) => (
                <View style={s.storyCard} key={st.at || i}>
                  <Text style={s.storyText} numberOfLines={3}>
                    “{st.text.length > 180 ? st.text.slice(0, 180).trim() + "…" : st.text}”
                  </Text>
                  {!!st.audio && (
                    <Pressable style={s.playBtn} hitSlop={8} onPress={() => togglePlayback(st)}>
                      <Text style={s.playBtnText}>
                        {playingAudio === st.audio ? "◼ Stop" : "▶ Hear it in their voice"}
                      </Text>
                    </Pressable>
                  )}
                </View>
              ))}
            </View>
          ))}
          {!!status && <Text style={s.hintLight}>{status}</Text>}
        </ScrollView>
        <Pressable style={s.primary}
          onPress={() => { setStatus(""); setBriefPage(0); setConfigured(true); setPhase("brief"); }}>
          <Text style={s.primaryText}>Continue the interview</Text>
        </Pressable>
        <View style={s.homeLinks}>
          <Pressable style={s.homeSettings} hitSlop={8}
            onPress={() => { setStatus(""); setView("profile"); }}>
            <Text style={s.homeSettingsText}>Profile & photos</Text>
          </Pressable>
          <Pressable style={s.homeSettings} hitSlop={8}
            onPress={() => { setStatus(""); setView(null); }}>
            <Text style={s.homeSettingsText}>Interview setup</Text>
          </Pressable>
        </View>
        {!!account?.token && (
          <View style={s.homeLinks}>
            <Pressable style={s.homeSettings} hitSlop={8} onPress={inviteFamily}>
              <Text style={s.homeSettingsText}>Invite family</Text>
            </Pressable>
            <Pressable style={s.homeSettings} hitSlop={8}
              onPress={() => { setStatus(""); setGiftResult(null); setView("gift"); }}>
              <Text style={s.homeSettingsText}>Send as a gift</Text>
            </Pressable>
          </View>
        )}
        {!!account && (
          <Text style={s.signedIn}>
            {account.family
              ? `In ${name ? name + "'s" : "the"} family circle`
              : account.gift
              ? `A gift from ${account.buyerName || account.email}`
              : `Signed in as ${account.email}`}
          </Text>
        )}
      </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // Profile — who the storyteller is, and the family's photos of them.
  // The pictures will illustrate the finished biography.
  if (!configured && view === "profile") {
    return (
      <SafeAreaView style={s.rootLight}>
        <StatusBar style="dark" />
        <View style={s.funnelHeader}>
          <Pressable style={s.backBtn} hitSlop={12}
            onPress={() => { setStatus(""); setView("home"); }}>
            <Text style={s.backText}>‹</Text>
          </Pressable>
          <View style={s.backBtn} />
        </View>
        <ScrollView contentContainerStyle={s.homeScroll} showsVerticalScrollIndicator={false}>
          <Text style={s.eyebrow}>PROFILE</Text>
          <Text style={s.h1}>{name || "The storyteller"}</Text>
          {!!about && <Text style={s.subhead}>{about}</Text>}
          <Text style={s.chapterTitle2}>PHOTOS · {photos.length}</Text>
          <Text style={s.stepText}>
            Add pictures from across their life — they'll illustrate the finished
            biography alongside the stories.
          </Text>
          <View style={s.photoGrid}>
            {photos.map((p) => (
              <Image key={p} source={{ uri: `${SERVER}/subject/${subjectId}/photos/${p}` }}
                style={s.photo} />
            ))}
          </View>
          <Pressable style={s.primary} onPress={addPhoto}>
            <Text style={s.primaryText}>Add a photo</Text>
          </Pressable>
          {!!status && <Text style={s.hintLight}>{status}</Text>}
        </ScrollView>
      </SafeAreaView>
    );
  }

  // Gift code entry — the recipient's whole "login": big print, one code.
  if (!configured && view === "redeem") {
    return (
      <SafeAreaView style={s.rootLight}>
        <StatusBar style="dark" />
        <KeyboardAvoidingView style={s.kav} behavior="padding">
        <View style={s.funnelHeader}>
          <Pressable style={s.backBtn} hitSlop={12}
            onPress={() => { setStatus(""); setView(null); setShowSales(true); }}>
            <Text style={s.backText}>‹</Text>
          </Pressable>
          <View style={s.backBtn} />
        </View>
        <ScrollView contentContainerStyle={s.setupScroll} showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled">
          <Text style={s.h1}>Type in your gift code</Text>
          <Text style={s.subhead}>
            It's the 6 big letters on the page your family sent you. That's all
            you need — no account, no password.
          </Text>
          <TextInput style={s.codeInput} value={giftCodeInput}
            onChangeText={(t) => setGiftCodeInput(t.toUpperCase())}
            autoCapitalize="characters" autoCorrect={false} maxLength={6}
            placeholder="ABC123" placeholderTextColor={COLORS.hairline} />
          <Pressable style={s.primary} onPress={() => redeemGift(giftCodeInput)}>
            <Text style={s.primaryText}>That's my code</Text>
          </Pressable>
          {!!status && <Text style={s.hintLight}>{status}</Text>}
        </ScrollView>
      </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // Gift creation — the buyer makes a code/link and shares it.
  if (!configured && view === "gift") {
    return (
      <SafeAreaView style={s.rootLight}>
        <StatusBar style="dark" />
        <KeyboardAvoidingView style={s.kav} behavior="padding">
        <View style={s.funnelHeader}>
          <Pressable style={s.backBtn} hitSlop={12}
            onPress={() => { setStatus(""); setGiftResult(null); setView(stories.length ? "home" : null); }}>
            <Text style={s.backText}>‹</Text>
          </Pressable>
          <View style={s.backBtn} />
        </View>
        <ScrollView contentContainerStyle={s.setupScroll} showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled">
          <View style={s.panel}>
            <Text style={s.h2}>Send Family Biographer as a gift</Text>
            {giftResult ? (
              <>
                <Text style={s.p}>
                  Done — send {giftResult.recipientName} this link. The page walks
                  them through it in three big-print steps, and the code below
                  signs their phone in automatically. No account, no password,
                  nothing for them to learn.
                </Text>
                <Text style={s.codeShow}>{giftResult.code}</Text>
                <Pressable style={s.primary} onPress={shareGift}>
                  <Text style={s.primaryText}>Send the link</Text>
                </Pressable>
                <Pressable style={s.homeSettings} hitSlop={8}
                  onPress={() => { setGiftResult(null); setGiftName(""); }}>
                  <Text style={s.homeSettingsText}>Make another gift</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Text style={s.p}>
                  For someone far away. You'll get a link to text them — their
                  phone signs itself in, and their story shows up in your account.
                </Text>
                <Text style={s.label}>WHO IS IT FOR?</Text>
                <TextInput style={s.input} value={giftName} onChangeText={setGiftName}
                  autoCapitalize="words"
                  placeholder="e.g. Dad" placeholderTextColor={COLORS.inkSoft} />
                <Pressable style={s.primary} onPress={createGift}>
                  <Text style={s.primaryText}>Create the gift</Text>
                </Pressable>
              </>
            )}
            {!!status && <Text style={s.hintLight}>{status}</Text>}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // Account — after the paywall, before setup.
  if (!configured && view === "account") {
    const creating = authMode === "create";
    return (
      <SafeAreaView style={s.rootLight}>
        <StatusBar style="dark" />
        <KeyboardAvoidingView style={s.kav} behavior="padding">
        <View style={s.funnelHeader}>
          <Pressable style={s.backBtn} hitSlop={12}
            onPress={() => { setStatus(""); setView(null); setShowSales(true); }}>
            <Text style={s.backText}>‹</Text>
          </Pressable>
          <View style={s.backBtn} />
        </View>
        <ScrollView contentContainerStyle={s.setupScroll} showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled">
          <View style={s.panel}>
            <Text style={s.h2}>{creating ? "Create your account" : "Welcome back"}</Text>
            <Text style={s.p}>
              {creating
                ? "Your account is where the finished biography is delivered — and how the recordings stay safe if the phone doesn't."
                : "Sign in with the email you used before."}
            </Text>
            {creating && (
              <>
                <Text style={s.label}>YOUR NAME</Text>
                <TextInput style={s.input} value={buyerName} onChangeText={setBuyerName}
                  autoCapitalize="words" autoComplete="name"
                  placeholder="e.g. Carter" placeholderTextColor={COLORS.inkSoft} />
              </>
            )}
            <Text style={s.label}>EMAIL</Text>
            <TextInput style={s.input} value={email} onChangeText={setEmail}
              autoCapitalize="none" autoCorrect={false} keyboardType="email-address"
              autoComplete="email"
              placeholder="you@example.com" placeholderTextColor={COLORS.inkSoft} />
            <Text style={s.label}>PASSWORD</Text>
            <TextInput style={s.input} value={password} onChangeText={setPassword}
              secureTextEntry autoCapitalize="none"
              autoComplete={creating ? "new-password" : "password"}
              placeholder={creating ? "At least 8 characters" : "Your password"}
              placeholderTextColor={COLORS.inkSoft} />
            <Pressable style={s.primary} onPress={submitAccount}>
              <Text style={s.primaryText}>{creating ? "Create account" : "Sign in"}</Text>
            </Pressable>
            <Pressable style={s.homeSettings} hitSlop={8}
              onPress={() => { setStatus(""); setAuthMode(creating ? "signin" : "create"); }}>
              <Text style={s.homeSettingsText}>
                {creating ? "Already have an account? Sign in" : "New here? Create an account"}
              </Text>
            </Pressable>
            {!!status && <Text style={s.hintLight}>{status}</Text>}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  if (!configured && showSales) {
    const page = funnelPages[salesPage];
    const isLast = salesPage === funnelPages.length - 1;
    return (
      <SafeAreaView style={s.rootLight}>
        <StatusBar style="dark" />
        <KeyboardAvoidingView style={s.kav} behavior="padding">
        {/* Header: back chevron (after page 1) + progress dots */}
        <View style={s.funnelHeader}>
          {salesPage > 0 ? (
            <Pressable style={s.backBtn} hitSlop={12} onPress={() => setSalesPage(salesPage - 1)}>
              <Text style={s.backText}>‹</Text>
            </Pressable>
          ) : (
            <View style={s.backBtn} />
          )}
          <View style={s.dots}>
            {funnelPages.map((p, i) => (
              <View key={p.key} style={[s.dot, i === salesPage && s.dotActive]} />
            ))}
          </View>
          <View style={s.backBtn} />
        </View>

        <ScrollView contentContainerStyle={s.funnelScroll} showsVerticalScrollIndicator={false}>
          {page.render()}
        </ScrollView>

        <Pressable
          style={s.primary}
          onPress={() => {
            if (!isLast) { setSalesPage(salesPage + 1); return; }
            // Paywall CTA → account (or straight to setup when signed in).
            setShowSales(false);
            if (account) setView(null); else setView("account");
          }}
        >
          <Text style={s.primaryText}>{page.cta}</Text>
        </Pressable>
        {!!page.footnote && <Text style={s.footnote}>{page.footnote}</Text>}
        {salesPage === 0 && (
          <Pressable style={s.homeSettings} hitSlop={8}
            onPress={() => { setStatus(""); setShowSales(false); setView("redeem"); }}>
            <Text style={s.homeSettingsText}>I have a gift code</Text>
          </Pressable>
        )}
      </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  if (!configured) {
    return (
      <SafeAreaView style={s.rootLight}>
        <StatusBar style="dark" />
        <KeyboardAvoidingView style={s.kav} behavior="padding">
        <View style={s.funnelHeader}>
          <Pressable style={s.backBtn} hitSlop={12}
            onPress={() => {
              setStatus("");
              if (stories.length) setView("home"); else setShowSales(true);
            }}>
            <Text style={s.backText}>‹</Text>
          </Pressable>
          <View style={s.backBtn} />
        </View>
        <ScrollView contentContainerStyle={s.setupScroll} showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled">
          <View style={s.panel}>
            <Text style={s.h2}>Set up the interview</Text>
            <Text style={s.p}>Do this once, before driving. Then it's just talking.</Text>
            <Text style={s.label}>WHO'S TELLING THEIR STORY?</Text>
            <TextInput style={s.input} value={name} onChangeText={setName}
              placeholder="e.g. Dad" placeholderTextColor={COLORS.inkSoft} />
            <Text style={s.label}>A LITTLE ABOUT THEM (OPTIONAL)</Text>
            <TextInput style={[s.input, s.inputMultiline]} value={about} onChangeText={setAbout}
              multiline numberOfLines={3}
              placeholder="e.g. Born 1951 in Ohio. Retired teacher. Married to Mom for 45 years."
              placeholderTextColor={COLORS.inkSoft} />
            <Pressable style={s.primary} onPress={saveSetup}>
              <Text style={s.primaryText}>Continue</Text>
            </Pressable>
            <Text style={s.privacyNote}>
              Every conversation is recorded and stored safely — it becomes the
              biography your family keeps.
            </Text>
            {!!status && <Text style={s.hintLight}>{status}</Text>}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // Briefing — shown every time before the interview starts. Two pages:
  // the mechanics of talking to Family Biographer, then the coaching a biographer
  // gives a subject before an interview (specifics, names, feelings —
  // that's what makes the difference between recollections and a book).
  // The begin button is also the user tap that kicks off audio, which iOS
  // treats far more reliably than autoplay.
  if (phase === "brief") {
    const briefPages = [
      {
        title: "How this works",
        cta: "Continue",
        items: [
          ["Turn the volume up.", "Questions are spoken aloud — through the car speakers if your phone is connected to Bluetooth."],
          ["Just talk, naturally.", "Answer out loud the way you'd talk to a friend in the passenger seat. Take your time — long pauses are fine, it won't cut you off."],
          ["Quiet means \"done.\"", `When you've finished and stay quiet for about ${Math.round(DEFAULT_SILENCE_MS / 1000)} seconds, the next question comes.`],
          ["Skip anytime.", "Say “Okay, next question” out loud to move on from any question."],
          ["Nothing is lost.", "Every word is recorded and saved — these conversations become the biography your family keeps."],
          ["Stop whenever.", "Tap “End session” when you're done. Next drive picks up right where you left off."],
        ],
      },
      {
        title: "How to tell it well",
        subtitle: "The same advice a biographer gives before any interview:",
        cta: "Begin — the first question is spoken aloud",
        items: [
          ["Go specific, not general.", "One real afternoon beats “we always used to.” Where were you standing? Who else was there? What could you smell?"],
          ["Say the names.", "“My brother Tommy,” not “my brother.” Names, places, and dates make it a biography — don't worry about getting them perfect."],
          ["Follow the detours.", "If one memory sparks another, chase it. The story you didn't plan to tell is usually the best one in the book."],
          ["Feelings are the story.", "Not just what happened — what you were afraid of, what you hoped, what you'd say to that younger you now."],
          ["Don't polish it.", "No preparing, no wrong answers, no starting over. The first telling is the truest — and anything you'd rather not answer, just skip."],
        ],
      },
    ];
    const bp = briefPages[briefPage];
    const isLastBrief = briefPage === briefPages.length - 1;
    return (
      <SafeAreaView style={s.rootLight}>
        <StatusBar style="dark" />
        <KeyboardAvoidingView style={s.kav} behavior="padding">
        <View style={s.funnelHeader}>
          <Pressable style={s.backBtn} hitSlop={12}
            onPress={() => (briefPage > 0 ? setBriefPage(briefPage - 1) : setConfigured(false))}>
            <Text style={s.backText}>‹</Text>
          </Pressable>
          <View style={s.dots}>
            {briefPages.map((p, i) => (
              <View key={p.title} style={[s.dot, i === briefPage && s.dotActive]} />
            ))}
          </View>
          <View style={s.backBtn} />
        </View>
        <ScrollView contentContainerStyle={s.funnelScroll} showsVerticalScrollIndicator={false}>
          <Text style={s.h1}>{bp.title}</Text>
          {!!bp.subtitle && <Text style={s.subhead}>{bp.subtitle}</Text>}
          {bp.items.map(([title, body]) => (
            <View style={s.step} key={title}>
              <Text style={s.briefDot}>•</Text>
              <View style={s.stepBody}>
                <Text style={s.stepTitle}>{title}</Text>
                <Text style={s.stepText}>{body}</Text>
              </View>
            </View>
          ))}
        </ScrollView>
        <Pressable style={s.primary}
          onPress={() => (isLastBrief ? startSession() : setBriefPage(briefPage + 1))}>
          <Text style={s.primaryText}>{bp.cta}</Text>
        </Pressable>
      </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  const phaseLabel = {
    asking: "…", listening: "Listening", thinking: "Thinking", error: "Hmm",
  }[phase] || "";

  return (
    <SafeAreaView style={s.rootDark}>
      <StatusBar style="light" />
      <Text style={s.eyebrowDark}>TELLING YOUR STORY{name ? ` · ${name.toUpperCase()}` : ""}</Text>
      <View style={s.qWrap}>
        <Text style={s.question}>{question}</Text>
      </View>
      {!!heard && <Text style={s.heard}>“{heard}”</Text>}
      <View style={[s.orb,
        phase === "listening" && s.orbListening,
        phase === "thinking" && s.orbThinking]}>
        <Text style={[s.orbText, phase === "listening" && s.orbTextListening]}>{phaseLabel}</Text>
      </View>
      <Text style={s.hint}>{status ||
        (phase === "listening" ? "Just talk. Long pauses are fine — I'll wait." :
         phase === "asking" ? "" : "")}</Text>
      {phase === "error" && (
        <Pressable style={s.primaryOnDark} onPress={retryFromError}>
          <Text style={s.primaryOnDarkText}>Tap to continue</Text>
        </Pressable>
      )}
      <Text style={s.tips}>
        Quiet for {Math.round(silenceMs / 1000)}s = next question · say “Okay, next question” to skip
      </Text>
      <Pressable style={s.endBtn} onPress={endSession}>
        <Text style={s.endText}>End session</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  kav: { flex: 1 },
  // ---- light chrome (funnel + setup + briefing + home) ----
  rootLight: { flex: 1, backgroundColor: COLORS.paper, paddingHorizontal: 32, paddingVertical: 20 },

  // home / story catalog
  homeScroll: { paddingBottom: 16, paddingTop: 8 },
  chapter: { marginTop: 26 },
  chapterTitle: { color: COLORS.pine, fontSize: 13, letterSpacing: 1.6, fontWeight: "700",
    textTransform: "uppercase", marginBottom: 4 },
  storyCard: { backgroundColor: "#FFFFFF", borderRadius: 12, padding: 14, marginTop: 8,
    borderWidth: 1, borderColor: COLORS.hairline },
  storyText: { color: COLORS.ink, fontSize: 15, lineHeight: 23, fontFamily: SERIF, fontStyle: "italic" },
  homeSettings: { alignSelf: "center", marginTop: 12, paddingVertical: 4 },
  homeSettingsText: { color: COLORS.inkSoft, fontSize: 14, textDecorationLine: "underline" },
  homeLinks: { flexDirection: "row", justifyContent: "center", gap: 24 },
  progressWrap: { marginTop: 18 },
  progressBar: { height: 8, borderRadius: 4, backgroundColor: COLORS.hairline, overflow: "hidden" },
  progressFill: { height: 8, borderRadius: 4, backgroundColor: COLORS.pine },
  progressText: { color: COLORS.inkSoft, fontSize: 13, marginTop: 8 },
  playBtn: { marginTop: 10, alignSelf: "flex-start" },
  playBtnText: { color: COLORS.pine, fontSize: 14, fontWeight: "700" },
  chapterTitle2: { color: COLORS.pine, fontSize: 13, letterSpacing: 1.6, fontWeight: "700",
    textTransform: "uppercase", marginTop: 30, marginBottom: 6 },
  photoGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 14 },
  photo: { width: "31.5%", aspectRatio: 1, borderRadius: 10, backgroundColor: COLORS.hairline },
  signedIn: { color: COLORS.inkSoft, fontSize: 12, textAlign: "center", marginTop: 6 },

  // gift code entry (recipient) / display (buyer) — big print on purpose
  codeInput: { backgroundColor: "#FFFFFF", borderWidth: 2, borderColor: COLORS.pine,
    borderRadius: 16, padding: 18, marginTop: 22, color: COLORS.ink,
    fontSize: 36, letterSpacing: 10, textAlign: "center",
    fontFamily: "Menlo" },
  codeShow: { backgroundColor: COLORS.paper, borderWidth: 2, borderColor: COLORS.pine,
    borderRadius: 16, padding: 16, marginTop: 6, marginBottom: 4, color: COLORS.ink,
    fontSize: 36, letterSpacing: 10, textAlign: "center", fontFamily: "Menlo" },
  funnelHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    marginTop: 4, marginBottom: 8 },
  backBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  backText: { color: COLORS.ink, fontSize: 34, lineHeight: 38, marginTop: -4 },
  dots: { flexDirection: "row", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS.hairline },
  dotActive: { backgroundColor: COLORS.pine },
  funnelScroll: { flexGrow: 1, justifyContent: "center", paddingBottom: 24 },
  illo: { width: "100%", aspectRatio: 1.45, borderRadius: 20, marginTop: 18 },
  illoSmall: { width: "100%", aspectRatio: 2.1, borderRadius: 20, marginTop: 14 },
  setupScroll: { flexGrow: 1, justifyContent: "center", paddingBottom: 24 },

  eyebrow: { color: COLORS.pine, fontSize: 13, letterSpacing: 3, fontWeight: "700", marginTop: 8 },
  h1: { color: COLORS.ink, fontSize: 33, lineHeight: 41, fontFamily: SERIF, marginTop: 12 },
  subhead: { color: COLORS.inkSoft, fontSize: 17, lineHeight: 26, marginTop: 14 },

  step: { flexDirection: "row", marginTop: 20 },
  stepNum: { color: COLORS.pine, fontSize: 20, fontFamily: SERIF, width: 30 },
  briefDot: { color: COLORS.pine, fontSize: 20, width: 24, marginTop: -2 },
  stepBody: { flex: 1 },
  stepTitle: { color: COLORS.ink, fontSize: 17, fontWeight: "600", marginBottom: 3 },
  stepText: { color: COLORS.inkSoft, fontSize: 15, lineHeight: 22 },

  benefit: { flexDirection: "row", alignItems: "flex-start", marginTop: 10 },
  benefitDot: { color: COLORS.pine, fontSize: 16, fontWeight: "700", marginRight: 10, marginTop: 1 },
  benefitText: { color: COLORS.ink, fontSize: 16, lineHeight: 23, flex: 1 },

  priceCard: { marginTop: 22, backgroundColor: "#FFFFFF", borderRadius: 16, padding: 22,
    alignItems: "center", borderWidth: 1, borderColor: COLORS.hairline,
    shadowColor: COLORS.ink, shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } },
  priceStrike: { color: COLORS.inkSoft, fontSize: 15, textDecorationLine: "line-through" },
  priceBig: { color: COLORS.pine, fontSize: 48, fontFamily: SERIF, marginTop: 8 },
  priceSub: { color: COLORS.inkSoft, fontSize: 14, marginTop: 4 },

  quoteCard: { backgroundColor: "#FFFFFF", borderRadius: 14, padding: 18, marginTop: 14,
    borderWidth: 1, borderColor: COLORS.hairline, borderLeftWidth: 3, borderLeftColor: COLORS.pine },
  quoteText: { color: COLORS.ink, fontSize: 17, lineHeight: 26, fontFamily: SERIF, fontStyle: "italic" },
  quoteAttr: { color: COLORS.pine, fontSize: 13, marginTop: 10, fontWeight: "600" },

  guaranteeCard: { marginTop: 22, backgroundColor: COLORS.sageTint, borderRadius: 14, padding: 18 },
  guaranteeText: { color: COLORS.ink, fontSize: 16, lineHeight: 23 },

  primary: { backgroundColor: COLORS.pine, borderRadius: 14, padding: 16, marginTop: 18, alignItems: "center" },
  primaryText: { color: COLORS.paper, fontWeight: "700", fontSize: 16, textAlign: "center" },
  footnote: { color: COLORS.inkSoft, fontSize: 12, textAlign: "center", marginTop: 12 },

  // setup card
  panel: { backgroundColor: "#FFFFFF",
    borderRadius: 18, padding: 22, borderWidth: 1, borderColor: COLORS.hairline,
    shadowColor: COLORS.ink, shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } },
  h2: { color: COLORS.ink, fontSize: 26, fontFamily: SERIF, marginBottom: 8 },
  p: { color: COLORS.inkSoft, fontSize: 15, lineHeight: 21, marginBottom: 14 },
  label: { color: COLORS.pine, fontSize: 12, letterSpacing: 1.2, fontWeight: "700",
    marginTop: 10, marginBottom: 6 },
  input: { backgroundColor: COLORS.paper, borderWidth: 1, borderColor: COLORS.hairline,
    borderRadius: 12, padding: 14, color: COLORS.ink, fontSize: 16 },
  inputMultiline: { minHeight: 84, textAlignVertical: "top" },
  privacyNote: { color: COLORS.inkSoft, fontSize: 13, lineHeight: 19, marginTop: 14 },
  hintLight: { color: COLORS.inkSoft, textAlign: "center", marginTop: 16, minHeight: 20, fontSize: 14 },

  // ---- dark in-car interview screen ----
  rootDark: { flex: 1, backgroundColor: COLORS.night, paddingHorizontal: 32, paddingVertical: 20 },
  eyebrowDark: { color: COLORS.sage, fontSize: 12, letterSpacing: 2, fontWeight: "600", marginTop: 8 },
  qWrap: { flex: 1, justifyContent: "center" },
  question: { color: COLORS.moon, fontSize: 30, lineHeight: 42, fontFamily: SERIF },
  heard: { color: COLORS.moonDim, fontSize: 14, textAlign: "center", marginBottom: 12 },
  orb: { alignSelf: "center", width: 170, height: 170, borderRadius: 85,
    backgroundColor: COLORS.pine, alignItems: "center", justifyContent: "center" },
  orbListening: { backgroundColor: COLORS.sage },
  orbThinking: { opacity: 0.5 },
  orbText: { color: COLORS.moon, fontWeight: "700", fontSize: 18 },
  orbTextListening: { color: COLORS.night },
  hint: { color: COLORS.moonDim, textAlign: "center", marginTop: 16, minHeight: 20, fontSize: 14 },
  tips: { color: COLORS.moonDim, fontSize: 12, textAlign: "center", marginTop: 14, opacity: 0.8 },
  primaryOnDark: { backgroundColor: COLORS.moon, borderRadius: 14, padding: 16, marginTop: 18, alignItems: "center" },
  primaryOnDarkText: { color: COLORS.night, fontWeight: "700", fontSize: 17 },
  endBtn: { alignSelf: "center", marginTop: 12, paddingVertical: 9, paddingHorizontal: 18,
    borderRadius: 999, borderWidth: 1, borderColor: "rgba(242,245,240,0.25)" },
  endText: { color: COLORS.moonDim, fontSize: 14 },
});
