/* ---------------------------------------------------------
   TwinTech Simulator — Final Stable Version
   Chunk 1 / 4 — Imports, Firebase, Express, Thresholds
   (No output fields here — safe for Retool & logs)
--------------------------------------------------------- */

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

// ---------------- FIREBASE INIT ----------------
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://twintech-mvp-default-rtdb.firebaseio.com"
});

const db = admin.database();

// ---------------- GRACEFUL SHUTDOWN ----------------
async function gracefulShutdown() {
  console.log("\n⚠️ Simulator shutting down… setting isRunning=false");
  try {
    await db.ref("simulator/isRunning").set(false);
    console.log("✔ Simulator stopped cleanly.");
  } catch (err) {
    console.error("Shutdown error:", err);
  }
  process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

// ---------------- EXPRESS APP ----------------
const app = express();
app.use(cors());

const COMPRESSORS = [
  "compressor_1",
  "compressor_2",
  "compressor_3",
  "compressor_4",
  "compressor_5",
  "compressor_6"
];

const TICK_MS = 2000;
const HISTORY_INTERVAL_MS = 30000;

let latestBatch = [];
let lastHistorySave = Date.now();

// ---------------- SIMULATOR CONTROL FLAG ----------------
async function checkIsRunning() {
  const snapshot = await db.ref("simulator/isRunning").once("value");
  const raw = snapshot.val();

  if (raw === true) return true;

  await db.ref("simulator/isRunning").set(true);
  console.log("Auto-repair: simulator/isRunning reset to TRUE");

  return true;
}

// ---------------- AUTO-STOP INACTIVITY ----------------
async function checkInactivity() {
  const snapshot = await db.ref("simulator/lastActive").once("value");
  const lastActive = snapshot.val();

  if (!lastActive) return false;

  const now = Date.now();
  const diff = now - lastActive;

  const TEN_MINUTES = 10 * 60 * 1000;
  return diff > TEN_MINUTES;
}

// ---------------- UPDATED WARNING THRESHOLDS ----------------
// Improved thresholds for smoother, more realistic warning behavior.

const warningThresholds = {
  temperature: { medium: 83.3, high: 88.5, min: 70, max: 100 },
  vibration:   { medium: 3.30, high: 3.9, min: 0, max: 6 },
  pressureLow: { medium: 100.0, high: 97.5, min: 90, max: 105 },
  flowLow:     { medium: 199, high: 178, min: 120, max: 240 }
};

function normalizeScore(value, type) {
  const t = warningThresholds[type];
  if (!t) return 0;

  if (type === "temperature") {
    if (value < t.medium) return 0;
    return Math.min((value - t.medium) / (t.high - t.medium), 1);
  }

  if (type === "vibration") {
    if (value < t.medium) return 0;
    return Math.min((value - t.medium) / (t.high - t.medium), 1);
  }

  if (type === "pressureLow") {
    if (value > t.medium) return 0;
    return Math.min((t.medium - value) / (t.medium - t.high), 1);
  }

  if (type === "flowLow") {
    if (value > t.medium) return 0;
    return Math.min((t.medium - value) / (t.medium - t.high), 1);
  }

  return 0;
}

function getSeverity(value, type) {
  const t = warningThresholds[type];
  if (!t) return "normal";

  if (type === "temperature" || type === "vibration") {
    if (value >= t.high) return "high";
    if (value >= t.medium) return "medium";
    return "normal";
  }

  if (type === "pressureLow" || type === "flowLow") {
    if (value <= t.high) return "high";
    if (value <= t.medium) return "medium";
    return "normal";
  }

  return "normal";
}
/* ---------------------------------------------------------
   TwinTech Simulator — Final Stable Version
   Chunk 2 / 4 — Warning Evaluation, Memory, Bias, Status Logic
--------------------------------------------------------- */

// ---------------- WARNING EVALUATION ----------------
function evaluateWarning(readings, currentWarningState) {
  const now = Date.now();
  const { temperature, vibration, pressure, flow, status, compressor_id } = readings;

  const candidates = [
    {
      key: "temperature",
      severity: getSeverity(temperature, "temperature"),
      score: normalizeScore(temperature, "temperature"),
      event_type: "overheating"
    },
    {
      key: "vibration",
      severity: getSeverity(vibration, "vibration"),
      score: normalizeScore(vibration, "vibration"),
      event_type: "vibration"
    },
    {
      key: "pressureLow",
      severity: getSeverity(pressure, "pressureLow"),
      score: normalizeScore(pressure, "pressureLow"),
      event_type: "pressure"
    },
    {
      key: "flowLow",
      severity: getSeverity(flow, "flowLow"),
      score: normalizeScore(flow, "flowLow"),
      event_type: "low_flow"
    }
  ];

  const isInactive = status === "inactive";
  const isFixedInactive = compressor_id === "compressor_5";

  let highCandidates = candidates.filter(c => c.severity === "high" && c.score > 0);

  if (isInactive || isFixedInactive) {
    highCandidates = [];
  }

  if (highCandidates.length > 0) {
    highCandidates.sort((a, b) => b.score - a.score);
    const best = highCandidates[0];
    return {
      warning: "high",
      event_type: best.event_type,
      startTime: now
    };
  }

  if (
    currentWarningState &&
    currentWarningState.warning !== "normal" &&
    now - currentWarningState.startTime < WARNING_LOCK_MS
  ) {
    return currentWarningState;
  }

  let mediumCandidates = candidates.filter(c => c.severity === "medium" && c.score > 0);

  if (isInactive || isFixedInactive) {
    mediumCandidates = mediumCandidates.filter(c => c.score > 0.25);
  }

  if (mediumCandidates.length === 0) {
    return {
      warning: "normal",
      event_type: "normal",
      startTime: now
    };
  }

  mediumCandidates.sort((a, b) => b.score - a.score);
  const bestMedium = mediumCandidates[0];

  return {
    warning: "medium",
    event_type: bestMedium.event_type,
    startTime: now
  };
}

// ---------------- MEMORY WITH RANDOMIZED BIAS FLIP ----------------
function initMemory(state, temp, vib, press, flow) {
  return {
    temperature: temp,
    vibration: vib,
    pressure: press,
    flow: flow,
    trend: { temp: 0, vib: 0, press: 0, flow: 0 },
    bias: { temp: 0, vib: 0, press: 0, flow: 0 },
    biasLastFlip: Date.now() - Math.random() * 90000, // randomize 0–90s
    state,
    lastChange: Date.now(),
    warningState: { warning: "normal", event_type: "normal", startTime: Date.now() }
  };
}

const compressorMemory = {
  compressor_1: initMemory("active", 81, 2.9, 100.5, 200),
  compressor_2: initMemory("active", 81, 2.9, 100.5, 200),
  compressor_3: initMemory("active", 81, 2.9, 100.5, 200),
  compressor_4: initMemory("active", 81, 2.9, 100.5, 200),
  compressor_5: initMemory("inactive", 75, 1.8, 99.5, 115),
  compressor_6: initMemory("offline", 80, 3.0, 100, 200)
};

// ---------------- UPDATED BIAS LOGIC ----------------
function updateBias(mem) {
  const now = Date.now();
  const BIAS_FLIP_MS = 90 * 1000; // 1.5 minutes

  if (now - mem.biasLastFlip > BIAS_FLIP_MS) {
    mem.biasLastFlip = now;

    if (mem.state === "inactive") {
      mem.bias.temp  = (Math.random() - 0.5) * 0.02;
      mem.bias.vib   = (Math.random() - 0.5) * 0.01;
      mem.bias.press = (Math.random() - 0.5) * 0.01;
      mem.bias.flow  = (Math.random() - 0.5) * 0.04;
      return;
    }

    mem.bias.temp  = (Math.random() - 0.5) * 0.04;
    mem.bias.vib   = (Math.random() - 0.5) * 0.02;
    mem.bias.press = (Math.random() - 0.5) * 0.02;
    mem.bias.flow  = (Math.random() - 0.5) * 0.08;
  }
}

// ---------------- STATUS LOGIC ----------------
function chooseStatus(id) {
  const mem = compressorMemory[id];
  const now = Date.now();
  const elapsed = now - mem.lastChange;

  if (id === "compressor_5") return "inactive";
  if (id === "compressor_6") return "offline";

  const MIN_ACTIVE = 20 * 60 * 1000;
  const MIN_INACTIVE = 5 * 60 * 1000;
  const MIN_OFFLINE = 20 * 60 * 1000;

  let current = mem.state;

  if (current === "active" && elapsed < MIN_ACTIVE) return current;
  if (current === "inactive" && elapsed < MIN_INACTIVE) return current;
  if (current === "offline" && elapsed < MIN_OFFLINE) return current;

  const r = Math.random();

  if (current === "active") {
    if (r < 0.999) return "active";
    if (r < 0.9999) return "inactive";
    return "offline";
  }

  if (current === "inactive") {
    if (r < 0.96) return "inactive";
    if (r < 0.995) return "active";
    return "offline";
  }

  if (current === "offline") {
    if (r < 0.99) return "offline";
    return "inactive";
  }

  return current;
}
/* ---------------------------------------------------------
   TwinTech Simulator — Final Stable Version
   Chunk 3 / 4 — Drift, Bias, Mean Reversion, AI Logic, Return Object
--------------------------------------------------------- */

// ---------------- UTILS ----------------
function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

// ---------------- MAIN DATA GENERATION ----------------
function generateCompressorData(id) {
  const mem = compressorMemory[id];

  updateBias(mem);

  let status = chooseStatus(id);

  if (status !== mem.state) {
    mem.state = status;
    mem.lastChange = Date.now();
  }

  // OFFLINE → no telemetry
  if (status === "offline") {
    return {
      compressor_id: id,
      timestamp: Date.now(),
      status: "offline",
      temperature: null,
      vibration: null,
      pressure: null,
      flow_rate: null,
      warning: "none",
      event_type: "none",
      risk_score: 0,
      ai_alert: false,
      ai_reason: "No AI alert (unit offline).",
      message: "Compressor offline — no telemetry.",
      insights_manager: "Unit offline — no production impact.",
      insights_engineer: "AI monitoring paused.",
      insights_maintenance: "Check power and interlocks if unexpected."
    };
  }

  // ---------------- DRIFT ENGINE ----------------
  const updateTrend = (key, scale) => {
    mem.trend[key] = mem.trend[key] * 0.85 + (Math.random() - 0.5) * scale;
  };

  if (status === "active") {
    updateTrend("temp", 0.03);
    updateTrend("vib", 0.015);
    updateTrend("press", 0.012);
    updateTrend("flow", 0.06);
  } else if (status === "inactive") {
    updateTrend("temp", 0.005);
    updateTrend("vib", 0.003);
    updateTrend("press", 0.002);
    updateTrend("flow", 0.01);
  }

  // Apply drift + bias
  if (status === "active" || status === "inactive") {
    mem.temperature += mem.trend.temp + mem.bias.temp;
    mem.vibration   += mem.trend.vib  + mem.bias.vib;
    mem.pressure    += mem.trend.press + mem.bias.press;
    mem.flow        += mem.trend.flow + mem.bias.flow;

    // Cross-coupling
    mem.vibration += mem.trend.temp * 0.03;
    mem.pressure += mem.trend.flow * -0.02;

    // ---------------- UPDATED MEAN REVERSION ----------------
    const TEMP_BASE_ACTIVE = 81;
    const TEMP_BASE_INACTIVE = 75.5;
    const VIB_BASE_ACTIVE = 2.9;
    const VIB_BASE_INACTIVE = 1.9;
    const PRESS_BASE_ACTIVE = 100.5;
    const PRESS_BASE_INACTIVE = 99.5;
    const FLOW_BASE_ACTIVE = 200;
    const FLOW_BASE_INACTIVE = 115;

    const TEMP_BASE = status === "active" ? TEMP_BASE_ACTIVE : TEMP_BASE_INACTIVE;
    const VIB_BASE = status === "active" ? VIB_BASE_ACTIVE : VIB_BASE_INACTIVE;
    const PRESS_BASE = status === "active" ? PRESS_BASE_ACTIVE : PRESS_BASE_INACTIVE;
    const FLOW_BASE = status === "active" ? FLOW_BASE_ACTIVE : FLOW_BASE_INACTIVE;

    mem.temperature += (TEMP_BASE - mem.temperature) * 0.03;
    mem.vibration   += (VIB_BASE - mem.vibration) * 0.03;
    mem.pressure    += (PRESS_BASE - mem.pressure) * 0.03;
    mem.flow        += (FLOW_BASE - mem.flow) * 0.05;
  }

  // ---------------- CLAMP VALUES ----------------
  if (status === "active") {
    mem.temperature = clamp(mem.temperature, 80, 86);
    mem.vibration   = clamp(mem.vibration, 2.8, 3.6);
    mem.pressure    = clamp(mem.pressure, 99, 102);
    mem.flow        = clamp(mem.flow, 190, 210);
  } else if (status === "inactive") {
    mem.temperature = clamp(mem.temperature, 74, 78);
    mem.vibration   = clamp(mem.vibration, 1.6, 2.2);
    mem.pressure    = clamp(mem.pressure, 99, 100.5);
    mem.flow        = clamp(mem.flow, 105, 125);
  }

  const temperature = mem.temperature;
  const vibration = mem.vibration;
  const pressure = mem.pressure;
  const flow = mem.flow;

  // ---------------- WARNING EVALUATION ----------------
  let warning = "normal";
  let event_type = "normal";

  if (status !== "offline") {
    const readings = {
      temperature,
      vibration,
      pressure,
      flow,
      status,
      compressor_id: id
    };

    const next = evaluateWarning(readings, mem.warningState);
    mem.warningState = next;

    warning = next.warning;
    event_type = next.event_type;
  }

  // ---------------- RISK SCORE ----------------
  let risk_score = 0;

  if (status === "active") {
    const tempDev = Math.max(0, temperature - 81);
    const vibDev = Math.max(0, vibration - 3.2);
    const pressDev = Math.max(0, 100.5 - pressure);
    const flowDev = Math.max(0, 195 - flow);

    risk_score =
      tempDev * 0.35 +
      vibDev * 0.35 +
      pressDev * 0.15 +
      flowDev * 0.25;

    if (warning === "medium") risk_score += 1.5;
    if (warning === "high") risk_score += 3.5;
  }

  if (status === "inactive") {
    if (warning === "normal") risk_score = 0.3 + Math.random() * 1.2;
    if (warning === "medium") risk_score = 2 + Math.random() * 2;
    if (warning === "high") risk_score = 3.5 + Math.random() * 1.5;
  }

  if (id === "compressor_5" && warning === "high") {
    warning = "medium";
  }

  risk_score = Number(risk_score.toFixed(2));

  // ---------------- AI LOGIC ----------------
  let ai_alert = false;
  let ai_reason = "No AI alert.";

  if (status === "active") {
    if (risk_score > 7.5) {
      ai_alert = true;
      ai_reason = "AI detected high combined risk pattern.";
    } else if (risk_score > 5 && warning === "medium") {
      ai_alert = true;
      ai_reason = "AI detected an emerging pattern.";
    }

    if (warning !== "normal" && event_type !== "normal") {
      ai_alert = true;
      if (ai_reason === "No AI alert.") {
        ai_reason = `AI confirmed ${event_type} deviation.`;
      }
    }
  }

  if (status === "inactive") {
    if (
      warning === "medium" &&
      (event_type === "vibration" || event_type === "pressure") &&
      risk_score >= 3
    ) {
      ai_alert = true;
      ai_reason = "AI detected an idle-state trend.";
    } else {
      ai_alert = false;
      ai_reason = "No AI alert (idle-state normal).";
    }
  }

  // Prevent false high warnings
  if (status === "active" && warning === "high") {
    const abnormal =
      temperature > 88 ||
      vibration > 4 ||
      pressure < 97.5 ||
      flow < 180;

    if (!abnormal || risk_score < 8) {
      warning = "medium";
    }
  }

  // AI early detection → medium warning
  if (status === "active" && ai_alert && warning === "normal") {
    warning = "medium";
  }

  // ---------------- INSIGHTS ----------------
  const { message, manager, engineer, maintenance } =
    buildInsights({
      status,
      warning,
      event_type,
      ai_alert,
      temperature,
      vibration,
      pressure,
      flow
    });

  // ---------------- FINAL RETURN OBJECT ----------------
  // ⭐ EXACT SAME FIELD NAMES AS BEFORE ⭐
  return {
    compressor_id: id,
    timestamp: Date.now(),
    status,
    temperature: Number(temperature.toFixed(2)),
    vibration: Number(vibration.toFixed(2)),
    pressure: Number(pressure.toFixed(2)),
    flow_rate: Number(flow.toFixed(2)),   // SAME NAME
    warning,
    event_type,                           // SAME NAME
    risk_score,                           // SAME NAME
    ai_alert,                             // SAME NAME
    ai_reason,                            // SAME NAME
    message,
    insights_manager: manager,            // SAME NAME
    insights_engineer: engineer,          // SAME NAME
    insights_maintenance: maintenance     // SAME NAME
  };
}
/* ---------------------------------------------------------
   TwinTech Simulator — Final Stable Version
   Chunk 4 / 4 — Firebase Writers, API, Server Start
--------------------------------------------------------- */

// ---------------- FIREBASE WRITERS ----------------
async function writeLatestToFirebase(batch) {
  const ref = db.ref("compressors/latest");
  await ref.set(batch);
}

async function writeHistoryToFirebase(batch) {
  const ref = db.ref("compressors/history");
  const ts = Date.now();
  await ref.child(ts).set(batch);
  console.log("History snapshot written:", ts);
}

// ---------------- MAIN LOOP ----------------
async function runTick() {
  const running = await checkIsRunning();
  if (!running) {
    console.log("Simulator paused (isRunning = false)");
    return;
  }

  if (await checkInactivity()) {
    console.log("Auto-stop: No UI activity detected. Pausing simulator.");
    await db.ref("simulator/isRunning").set(false);
    return;
  }

  const batch = COMPRESSORS.map(id => generateCompressorData(id));
  latestBatch = batch;

  console.log("\n=== TwinTech Telemetry Tick ===");
  console.log(JSON.stringify(batch, null, 2));
  console.log("================================\n");

  try {
    await writeLatestToFirebase(batch);

    if (Date.now() - lastHistorySave >= HISTORY_INTERVAL_MS) {
      await writeHistoryToFirebase(batch);
      lastHistorySave = Date.now();
    }
  } catch (err) {
    console.error("Firebase write error:", err);
  }
}

// ---------------- API ENDPOINTS ----------------
app.get("/", (req, res) => {
  res.send("TwinTech Simulator is running.");
});

app.get("/api/latest", (req, res) => {
  // Wake simulator when UI requests data
  db.ref("simulator/isRunning").set(true);

  // Update lastActive so auto-stop knows UI is alive
  db.ref("simulator/lastActive").set(Date.now());

  res.json(latestBatch);
});

// Heartbeat endpoint for UI activity
app.post("/api/heartbeat", (req, res) => {
  db.ref("simulator/lastActive").set(Date.now());
  res.json({ ok: true });
});

// ---------------- SERVER START ----------------
function startServer(port) {
  const server = app.listen(port, () => {
    console.log(`TwinTech Simulator running at http://0.0.0.0:${port}`);
    runTick();
    setInterval(runTick, TICK_MS);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.log(`Port ${port} in use, trying ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error("Unhandled server error:", err);
    }
  });
}

const basePort = process.env.PORT ? Number(process.env.PORT) : 5000;
startServer(basePort);