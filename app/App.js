// App.js — Shotgun native client (v1, conversation mode)
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

import React, { useEffect, useRef, useState } from "react";
import {
  SafeAreaView, ScrollView, View, Text, Pressable, TextInput, StyleSheet, AppState,
} from "react-native";
import { Audio } from "expo-av";
import * as Speech from "expo-speech";
import { useKeepAwake } from "expo-keep-awake";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { StatusBar } from "expo-status-bar";

// ---------- tunables --------------------------------------------------------
const DEFAULT_SILENCE_MS = 7000;   // long & forgiving — capture the pauses
const MIN_ANSWER_MS = 1500;        // ignore blips shorter than this
const METERING_SILENCE_DB = -40;   // below this = "quiet" (tune in real car)
const METER_INTERVAL_MS = 300;

const COLORS = {
  dusk: "#1c2230", duskDeep: "#151a26", lamp: "#e8b465",
  bone: "#f4efe6", boneDim: "#b9b3a8", ok: "#7fb89a",
};

export default function App() {
  useKeepAwake(); // never let the screen sleep mid-session (in-car essential)

  // config
  const [server, setServer] = useState("");
  const [name, setName] = useState("");
  const [subjectId, setSubjectId] = useState(null);
  const [configured, setConfigured] = useState(false);
  const [silenceMs, setSilenceMs] = useState(DEFAULT_SILENCE_MS);
  const [showSales, setShowSales] = useState(true); // product/sales screen shows first

  // conversation state machine: setup | asking | listening | thinking | error
  const [phase, setPhase] = useState("setup");
  const [question, setQuestion] = useState("");
  const [heard, setHeard] = useState("");
  const [status, setStatus] = useState("");

  const recordingRef = useRef(null);
  const lastLoudRef = useRef(0);
  const startedTalkingRef = useRef(false);
  const meterTimer = useRef(null);
  const aliveRef = useRef(true);

  // ---------- boot: restore config ------------------------------------------
  useEffect(() => {
    (async () => {
      const [s, n, id, sil] = await Promise.all([
        AsyncStorage.getItem("server"), AsyncStorage.getItem("name"),
        AsyncStorage.getItem("subjectId"), AsyncStorage.getItem("silenceMs"),
      ]);
      if (s) setServer(s);
      if (n) setName(n);
      if (sil) setSilenceMs(Number(sil) || DEFAULT_SILENCE_MS);
      if (id) setSubjectId(id);
    })();
    const sub = AppState.addEventListener("change", (st) => {
      if (st !== "active") stopEverything(); // backgrounded: stop cleanly
    });
    return () => { aliveRef.current = false; sub.remove(); stopEverything(); };
  }, []);

  function stopEverything() {
    Speech.stop();
    if (meterTimer.current) clearInterval(meterTimer.current);
    const rec = recordingRef.current;
    recordingRef.current = null;
    if (rec) rec.stopAndUnloadAsync().catch(() => {});
  }

  // ---------- speech out ------------------------------------------------------
  function speak(text) {
    return new Promise((resolve) => {
      Speech.speak(text, { rate: 0.95, onDone: resolve, onStopped: resolve, onError: resolve });
    });
  }

  // ---------- the loop --------------------------------------------------------
  async function startSession() {
    const cleanServer = server.trim().replace(/\/$/, "");
    if (!cleanServer) { setStatus("Enter the server address first."); return; }
    let id = subjectId;
    if (!id) {
      id = "subj_" + Math.random().toString(36).slice(2, 10);
      setSubjectId(id);
    }
    await AsyncStorage.multiSet([
      ["server", cleanServer], ["name", name], ["subjectId", id],
      ["silenceMs", String(silenceMs)],
    ]);
    setConfigured(true);
    setPhase("thinking");
    setStatus("Starting…");
    try {
      const r = await fetch(`${cleanServer}/session/start`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subjectId: id }),
      });
      const data = await r.json();
      await askAndListen(data.question, data.intro, cleanServer, id);
    } catch {
      setPhase("error"); setStatus("Couldn't reach the server.");
    }
  }

  async function askAndListen(q, bridge, srv, id) {
    if (!aliveRef.current) return;
    setQuestion(q); setHeard(""); setPhase("asking"); setStatus("");
    if (bridge) await speak(bridge);
    await speak(q);
    await beginRecording(srv, id);
  }

  async function beginRecording(srv, id) {
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
          await finishTurn(srv, id);
        }
      }, METER_INTERVAL_MS);
    } catch (e) {
      setPhase("error"); setStatus("Recording failed to start. Tap to retry.");
    }
  }

  async function finishTurn(srv, id) {
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

    try {
      const form = new FormData();
      form.append("subjectId", id);
      form.append("audio", { uri, name: "answer.m4a", type: "audio/m4a" });
      const r = await fetch(`${srv}/session/answer-audio`, { method: "POST", body: form });
      if (!r.ok) throw new Error(String(r.status));
      const data = await r.json();
      if (data.empty) {
        // Silence with no real speech — just re-open the mic on the same question.
        await speak("I'm still here whenever you're ready.");
        await beginRecording(srv, id);
        return;
      }
      setHeard(data.transcript || "");
      const lead = data.acknowledgment || data.bridge;
      await askAndListen(data.question, lead, srv, id);
    } catch {
      setPhase("error");
      setStatus("Couldn't send that answer. It's saved on the phone — tap to retry.");
    }
  }

  async function endSession() {
    stopEverything();
    setPhase("thinking"); setStatus("Wrapping up…");
    try {
      await fetch(`${server.trim().replace(/\/$/, "")}/session/end`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subjectId }),
      });
    } catch { /* non-fatal */ }
    setPhase("setup"); setConfigured(false); setStatus("Session saved. See you next drive.");
  }

  // ---------- UI --------------------------------------------------------------

  // Sales / product screen — the FIRST thing a prospective buyer sees.
  // Structured as a long-form sales page: hook → problem → solution →
  // value stack → price anchor → social proof → risk reversal → urgency → CTA.
  // NOTE: the CTA currently advances to the setup screen. Once the account
  // (Sign in with Apple) and payment (Stripe) steps exist, gate them HERE —
  // Sales → Account → Pay → Setup → Interview.
  if (!configured && showSales) {
    return (
      <SafeAreaView style={s.root}>
        <StatusBar style="light" />
        <ScrollView contentContainerStyle={s.salesScroll} showsVerticalScrollIndicator={false}>
          {/* HERO — big emotional promise + a CTA above the fold */}
          <Text style={s.eyebrow}>SHOTGUN</Text>
          <Text style={s.h1}>Their stories deserve to outlive them.</Text>
          <Text style={s.subhead}>
            Shotgun turns easy, everyday conversations into a beautifully written
            biography — told in their own voice, and kept for good.
          </Text>
          <Pressable style={s.primary} onPress={() => setShowSales(false)}>
            <Text style={s.primaryText}>Start their story</Text>
          </Pressable>
          <Text style={s.ctaSub}>$500 · one time · everything included</Text>

          {/* PROBLEM — agitate the real cost of waiting (PAS) */}
          <View style={s.section}>
            <Text style={s.sectionTitle}>One day, the stories stop.</Text>
            <Text style={s.body}>
              Everyone you love is carrying a thousand stories no one has written
              down — how they met, the year everything changed, the advice they'd
              give if you ever asked. Then one day it all goes quiet. Not because
              we didn't care. Because we never quite got around to asking.
            </Text>
          </View>

          {/* SOLUTION — 3 steps, to make it feel effortless */}
          <View style={s.section}>
            <Text style={s.sectionTitle}>So we made asking effortless.</Text>

            <View style={s.step}>
              <Text style={s.stepNum}>1</Text>
              <View style={s.stepBody}>
                <Text style={s.stepTitle}>Just talk.</Text>
                <Text style={s.stepText}>
                  Mount the phone and drive. Shotgun rides along and asks the
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
          </View>

          {/* VALUE STACK — everything included */}
          <View style={s.section}>
            <Text style={s.sectionTitle}>Everything included</Text>
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
          </View>

          {/* PRICE ANCHOR — expensive alternative, crossed out, then the price */}
          {/* NOTE: only keep the $10,000 comparison if it's a defensible claim. */}
          <View style={s.priceCard}>
            <Text style={s.priceStrike}>Ghostwritten memoirs run $10,000 and up</Text>
            <Text style={s.priceBig}>$500</Text>
            <Text style={s.priceSub}>One time. Everything above included.</Text>
          </View>

          {/* SOCIAL PROOF — PLACEHOLDER. Replace with real, verified quotes before
              launch. Never ship fabricated testimonials (dishonest + App Store risk). */}
          <View style={s.section}>
            <Text style={s.sectionTitle}>What families say</Text>
            {[
              { q: "I have my father's voice telling the story of the day I was born. I'll have it forever.", who: "Sarah, a daughter (sample)" },
              { q: "My dad would never sit for an interview. But he'll talk for an hour in the car. This got stories out of him I'd never heard.", who: "Michael, a son (sample)" },
            ].map((t) => (
              <View style={s.quoteCard} key={t.who}>
                <Text style={s.quoteText}>“{t.q}”</Text>
                <Text style={s.quoteAttr}>— {t.who}</Text>
              </View>
            ))}
          </View>

          {/* RISK REVERSAL — PLACEHOLDER. Only keep if you will honor this refund. */}
          <View style={s.guaranteeCard}>
            <Text style={s.guaranteeText}>
              Love it, or it's free. If your first conversations don't move you,
              we'll refund every cent.
            </Text>
          </View>

          {/* URGENCY — gentle, true to the product */}
          <Text style={s.urgency}>
            The best time to start was years ago.{"\n"}The next best time is this weekend.
          </Text>

          {/* FINAL CTA — ask again once value is established */}
          <Pressable style={[s.primary, { marginTop: 22 }]} onPress={() => setShowSales(false)}>
            <Text style={s.primaryText}>Start their story</Text>
          </Pressable>
          <Text style={s.footnote}>Secure checkout · $500 one time</Text>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (!configured) {
    return (
      <SafeAreaView style={s.root}>
        <StatusBar style="light" />
        <View style={s.panel}>
          <Text style={s.h2}>Set up the interview</Text>
          <Text style={s.p}>Do this once, before driving. Then it's just talking.</Text>
          <Text style={s.label}>Who's telling their story?</Text>
          <TextInput style={s.input} value={name} onChangeText={setName}
            placeholder="e.g. Dad" placeholderTextColor={COLORS.boneDim} />
          <Text style={s.label}>Server address</Text>
          <TextInput style={s.input} value={server} onChangeText={setServer}
            autoCapitalize="none" autoCorrect={false} keyboardType="url"
            placeholder="https://your-backend.up.railway.app"
            placeholderTextColor={COLORS.boneDim} />
          <Pressable style={s.primary} onPress={startSession}>
            <Text style={s.primaryText}>Start talking</Text>
          </Pressable>
          {!!status && <Text style={s.hint}>{status}</Text>}
        </View>
      </SafeAreaView>
    );
  }

  const phaseLabel = {
    asking: "…", listening: "Listening", thinking: "Thinking", error: "Hmm",
  }[phase] || "";

  return (
    <SafeAreaView style={s.root}>
      <StatusBar style="light" />
      <Text style={s.eyebrow}>TELLING YOUR STORY{name ? ` · ${name.toUpperCase()}` : ""}</Text>
      <View style={s.qWrap}>
        <Text style={s.question}>{question}</Text>
      </View>
      {!!heard && <Text style={s.heard}>“{heard}”</Text>}
      <View style={[s.orb,
        phase === "listening" && s.orbListening,
        phase === "thinking" && s.orbThinking]}>
        <Text style={s.orbText}>{phaseLabel}</Text>
      </View>
      <Text style={s.hint}>{status ||
        (phase === "listening" ? "Just talk. Long pauses are fine — I'll wait." :
         phase === "asking" ? "" : "")}</Text>
      {phase === "error" && (
        <Pressable style={s.primary} onPress={() => beginRecording(server.trim().replace(/\/$/, ""), subjectId)}>
          <Text style={s.primaryText}>Tap to continue</Text>
        </Pressable>
      )}
      <Pressable style={s.endBtn} onPress={endSession}>
        <Text style={s.endText}>End session</Text>
      </Pressable>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.duskDeep, padding: 24 },
  panel: { marginTop: "auto", marginBottom: "auto", backgroundColor: "rgba(0,0,0,0.22)",
    borderRadius: 18, padding: 22, borderWidth: 1, borderColor: "rgba(244,239,230,0.1)" },
  h2: { color: COLORS.bone, fontSize: 24, fontWeight: "600", marginBottom: 8 },
  p: { color: COLORS.boneDim, fontSize: 15, lineHeight: 21, marginBottom: 14 },
  label: { color: COLORS.lamp, fontSize: 12, letterSpacing: 1.2, marginTop: 10, marginBottom: 6 },
  input: { backgroundColor: "rgba(0,0,0,0.25)", borderWidth: 1, borderColor: "rgba(244,239,230,0.2)",
    borderRadius: 12, padding: 14, color: COLORS.bone, fontSize: 16 },
  primary: { backgroundColor: COLORS.lamp, borderRadius: 14, padding: 16, marginTop: 18, alignItems: "center" },
  primaryText: { color: COLORS.duskDeep, fontWeight: "700", fontSize: 17 },

  // ---- sales / product screen ----
  salesScroll: { paddingBottom: 44 },
  h1: { color: COLORS.bone, fontSize: 34, lineHeight: 42, fontWeight: "700", marginTop: 12 },
  subhead: { color: COLORS.boneDim, fontSize: 17, lineHeight: 25, marginTop: 14 },
  ctaSub: { color: COLORS.boneDim, fontSize: 13, textAlign: "center", marginTop: 10 },
  section: { marginTop: 36 },
  sectionTitle: { color: COLORS.bone, fontSize: 22, fontWeight: "600", marginBottom: 12 },
  body: { color: COLORS.boneDim, fontSize: 16, lineHeight: 24 },
  step: { flexDirection: "row", marginTop: 18 },
  stepNum: { color: COLORS.lamp, fontSize: 18, fontWeight: "800", width: 28 },
  stepBody: { flex: 1 },
  stepTitle: { color: COLORS.bone, fontSize: 17, fontWeight: "600", marginBottom: 3 },
  stepText: { color: COLORS.boneDim, fontSize: 15, lineHeight: 22 },
  benefit: { flexDirection: "row", alignItems: "flex-start", marginTop: 10 },
  benefitDot: { color: COLORS.ok, fontSize: 16, fontWeight: "700", marginRight: 10, marginTop: 1 },
  benefitText: { color: COLORS.bone, fontSize: 16, lineHeight: 23, flex: 1 },
  priceCard: { marginTop: 22, backgroundColor: "rgba(0,0,0,0.22)", borderRadius: 16, padding: 22,
    alignItems: "center", borderWidth: 1, borderColor: "rgba(232,180,101,0.4)" },
  priceStrike: { color: COLORS.boneDim, fontSize: 15, textDecorationLine: "line-through" },
  priceBig: { color: COLORS.lamp, fontSize: 46, fontWeight: "800", marginTop: 8 },
  priceSub: { color: COLORS.boneDim, fontSize: 14, marginTop: 4 },
  quoteCard: { backgroundColor: "rgba(0,0,0,0.22)", borderRadius: 14, padding: 18, marginTop: 14,
    borderLeftWidth: 3, borderLeftColor: COLORS.lamp },
  quoteText: { color: COLORS.bone, fontSize: 16, lineHeight: 24, fontStyle: "italic" },
  quoteAttr: { color: COLORS.lamp, fontSize: 13, marginTop: 10 },
  guaranteeCard: { marginTop: 22, backgroundColor: "rgba(127,184,154,0.1)", borderRadius: 14,
    padding: 18, borderWidth: 1, borderColor: "rgba(127,184,154,0.5)" },
  guaranteeText: { color: COLORS.bone, fontSize: 16, lineHeight: 23 },
  urgency: { color: COLORS.bone, fontSize: 19, lineHeight: 27, fontWeight: "500",
    marginTop: 40, textAlign: "center" },
  footnote: { color: COLORS.boneDim, fontSize: 12, textAlign: "center", marginTop: 12 },
  eyebrow: { color: COLORS.lamp, fontSize: 12, letterSpacing: 2, fontWeight: "600", marginTop: 8 },
  qWrap: { flex: 1, justifyContent: "center" },
  question: { color: COLORS.bone, fontSize: 30, lineHeight: 40, fontWeight: "500" },
  heard: { color: COLORS.boneDim, fontSize: 14, textAlign: "center", marginBottom: 12 },
  orb: { alignSelf: "center", width: 170, height: 170, borderRadius: 85,
    backgroundColor: COLORS.lamp, alignItems: "center", justifyContent: "center" },
  orbListening: { backgroundColor: COLORS.ok },
  orbThinking: { opacity: 0.5 },
  orbText: { color: COLORS.duskDeep, fontWeight: "700", fontSize: 18 },
  hint: { color: COLORS.boneDim, textAlign: "center", marginTop: 16, minHeight: 20, fontSize: 14 },
  endBtn: { alignSelf: "center", marginTop: 18, paddingVertical: 9, paddingHorizontal: 18,
    borderRadius: 999, borderWidth: 1, borderColor: "rgba(244,239,230,0.22)" },
  endText: { color: COLORS.boneDim, fontSize: 14 },
});
