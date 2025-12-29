// TwinTech Simulator — 6 Compressors, Dynamic Insights, Firebase + API
// Final tuned version for demo:
// - C1–C4 active, stable
// - C5 always inactive (cooler, quieter, low flow)
// - C6 always offline
// - No warnings at startup
// - Balanced variation: temp, vib, pressure, flow can each trigger occasional medium warnings
// - High warnings very rare
// - 20s warning lock
// - Active → offline almost never
// - Firebase structure unchanged

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

// ---------------- GRACEFUL SHUTDOWN HANDLER ----------------
async function gracefulShutdown() {
  console.log("\n⚠️ Simulator shutting down… closing the gate (isRunning=false)");
  try {
    await db.ref("simulator/isRunning").set(false);
    console.log("✔ Gate closed successfully.");
  } catch (err) {
    console.error("Failed to update Firebase during shutdown:", err);
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
const WARNING_LOCK_MS = 20000; // 20 seconds

let latestBatch = [];
let lastHistorySave = Date.now();

// ---------------- SIMULATOR CONTROL FLAG ----------------
async function checkIsRunning() {
  const snapshot = await db.ref("simulator/isRunning").once("value");
  const raw = snapshot.val();

  console.log("DEBUG Firebase value =", raw);

  if (raw === true) return true;

  await db.ref("simulator/isRunning").set(true);
  console.log("Auto-repair: simulator/isRunning was invalid, reset to TRUE");

  return true;
}

// ---------------- AUTO-STOP INACTIVITY CHECK ----------------
async function checkInactivity() {
  const snapshot = await db.ref("simulator/lastActive").once("value");
  const lastActive = snapshot.val();

  if (!lastActive) return false;

  const now = Date.now();
  const diff = now - lastActive;

  const TEN_MINUTES = 10 * 60 * 1000;
  return diff > TEN_MINUTES;
}

// ---------------- WARNING THRESHOLDS + SCORING ----------------
// Active: temperature ~80–86, vibration ~2.8–3.6, pressure ~99–102, flow ~190–210
// Inactive: temperature ~74–78, vibration ~1.6–2.2, pressure ~98–100, flow ~105–125
// Balanced variation: thresholds tuned so each parameter can occasionally trigger medium warnings.
const warningThresholds = {
  temperature: { medium: 85.2, high: 88.5, min: 70, max: 100 },
  vibration:   { medium: 3.3,  high: 3.9,  min: 0,  max: 6 },
  pressureLow: { medium: 99.2, high: 97.5, min: 90, max: 105 },
  flowLow:     { medium: 188,  high: 178,  min: 120, max: 240 }
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

// ---------------- MEMORY FOR DRIFT + STATUS + WARNING STATE ----------------
const compressorMemory = {
  compressor_1: {
    temperature: 81,
    vibration: 2.9,
    pressure: 100.5,
    flow: 200,
    trend: { temp: 0, vib: 0, press: 0, flow: 0 },
    state: "active",
    lastChange: Date.now(),
    warningState: { warning: "normal", event_type: "normal", startTime: Date.now() }
  },
  compressor_2: {
    temperature: 81,
    vibration: 2.9,
    pressure: 100.5,
    flow: 200,
    trend: { temp: 0, vib: 0, press: 0, flow: 0 },
    state: "active",
    lastChange: Date.now(),
    warningState: { warning: "normal", event_type: "normal", startTime: Date.now() }
  },
  compressor_3: {
    temperature: 81,
    vibration: 2.9,
    pressure: 100.5,
    flow: 200,
    trend: { temp: 0, vib: 0, press: 0, flow: 0 },
    state: "active",
    lastChange: Date.now(),
    warningState: { warning: "normal", event_type: "normal", startTime: Date.now() }
  },
  compressor_4: {
    temperature: 81,
    vibration: 2.9,
    pressure: 100.5,
    flow: 200,
    trend: { temp: 0, vib: 0, press: 0, flow: 0 },
    state: "active",
    lastChange: Date.now(),
    warningState: { warning: "normal", event_type: "normal", startTime: Date.now() }
  },
  compressor_5: {
    temperature: 75,
    vibration: 1.8,
    pressure: 98.5,
    flow: 115,
    trend: { temp: 0, vib: 0, press: 0, flow: 0 },
    state: "inactive",
    lastChange: Date.now(),
    warningState: { warning: "normal", event_type: "normal", startTime: Date.now() }
  },
  compressor_6: {
    temperature: 80,
    vibration: 3.0,
    pressure: 100,
    flow: 200,
    trend: { temp: 0, vib: 0, press: 0, flow: 0 },
    state: "offline",
    lastChange: Date.now(),
    warningState: { warning: "normal", event_type: "normal", startTime: Date.now() }
  }
};

// ---------------- STATUS TRANSITION LOGIC ----------------
function chooseStatus(id) {
  const mem = compressorMemory[id];
  const now = Date.now();
  const elapsed = now - mem.lastChange;

  if (id === "compressor_5") return "inactive";
  if (id === "compressor_6") return "offline";

  const MIN_ACTIVE = 20 * 60 * 1000;   // 20 minutes
  const MIN_INACTIVE = 5 * 60 * 1000;  // 5 minutes
  const MIN_OFFLINE = 20 * 60 * 1000;  // 20 minutes

  let current = mem.state;

  if (current === "active" && elapsed < MIN_ACTIVE) return current;
  if (current === "inactive" && elapsed < MIN_INACTIVE) return current;
  if (current === "offline" && elapsed < MIN_OFFLINE) return current;

  const r = Math.random();

  if (current === "active") {
    if (r < 0.999) return "active";      // 99.9% stay active
    if (r < 0.9999) return "inactive";   // 0.09% chance
    return "offline";                    // 0.01% chance (almost never)
  }

  if (current === "inactive") {
    if (r < 0.96) return "inactive";     // 96% stay inactive
    if (r < 0.995) return "active";      // 3.5% chance
    return "offline";                    // 0.5% chance
  }

  if (current === "offline") {
    if (r < 0.99) return "offline";      // 99% stay offline
    return "inactive";                   // 1% chance
  }

  return current;
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

// ---------------- DATA GENERATION ----------------
function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

function generateCompressorData(id) {
  const mem = compressorMemory[id];

  let status = chooseStatus(id);

  if (status !== mem.state) {
    mem.state = status;
    mem.lastChange = Date.now();
  }

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
      ai_reason: "No AI alert (unit offline, no telemetry).",
      message: "Compressor offline — no telemetry.",
      insights_manager: "Unit offline — no current production impact.",
      insights_engineer: "AI monitoring paused until the compressor returns to operation.",
      insights_maintenance: "Check power, connectivity, and safety interlocks if shutdown was not expected."
    };
  }

  const updateTrend = (trendKey, baseScale) => {
    mem.trend[trendKey] =
      mem.trend[trendKey] * 0.85 + (Math.random() - 0.5) * baseScale;
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

  if (status === "active" || status === "inactive") {
    mem.temperature += mem.trend.temp;
    mem.vibration += mem.trend.vib;
    mem.pressure += mem.trend.press;
    mem.flow += mem.trend.flow;

    mem.vibration += mem.trend.temp * 0.03;
    mem.pressure += mem.trend.flow * -0.02;

    const TEMP_BASE_ACTIVE = 81;
    const TEMP_BASE_INACTIVE = 75.5;
    const VIB_BASE_ACTIVE = 2.9;
    const VIB_BASE_INACTIVE = 1.9;
    const PRESS_BASE_ACTIVE = 100.5;
    const PRESS_BASE_INACTIVE = 98.8;
    const FLOW_BASE_ACTIVE = 200;
    const FLOW_BASE_INACTIVE = 115;

    const TEMP_BASE = status === "active" ? TEMP_BASE_ACTIVE : TEMP_BASE_INACTIVE;
    const VIB_BASE = status === "active" ? VIB_BASE_ACTIVE : VIB_BASE_INACTIVE;
    const PRESS_BASE = status === "active" ? PRESS_BASE_ACTIVE : PRESS_BASE_INACTIVE;
    const FLOW_BASE = status === "active" ? FLOW_BASE_ACTIVE : FLOW_BASE_INACTIVE;

    mem.temperature += (TEMP_BASE - mem.temperature) * 0.02;
    mem.vibration += (VIB_BASE - mem.vibration) * 0.02;
    mem.pressure += (PRESS_BASE - mem.pressure) * 0.02;
    mem.flow += (FLOW_BASE - mem.flow) * 0.04;
  }

  if (status === "active") {
    mem.temperature = clamp(mem.temperature, 80, 86);
    mem.vibration   = clamp(mem.vibration, 2.8, 3.6);
    mem.pressure    = clamp(mem.pressure, 99, 102);
    mem.flow        = clamp(mem.flow, 190, 210);
  } else if (status === "inactive") {
    mem.temperature = clamp(mem.temperature, 74, 78);
    mem.vibration   = clamp(mem.vibration, 1.6, 2.2);
    mem.pressure    = clamp(mem.pressure, 98, 100);
    mem.flow        = clamp(mem.flow, 105, 125);
  }

  let temperature = mem.temperature;
  let vibration = mem.vibration;
  let pressure = mem.pressure;
  let flow = mem.flow;

  let warning = "normal";
  let event_type = "normal";

  if (status === "active" || status === "inactive") {
    const readings = {
      temperature,
      vibration,
      pressure,
      flow,
      status,
      compressor_id: id
    };
    const nextWarningState = evaluateWarning(readings, mem.warningState);
    mem.warningState = nextWarningState;

    warning = nextWarningState.warning;
    event_type = nextWarningState.event_type;
  }

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
  } else if (status === "inactive") {
    if (warning === "normal") {
      risk_score = 0.3 + Math.random() * 1.2;
    } else if (warning === "medium") {
      risk_score = 2.0 + Math.random() * 2.0;
    } else if (warning === "high") {
      risk_score = 3.5 + Math.random() * 1.5;
    }
  }

  if (id === "compressor_5") {
    if (warning === "high") warning = "medium";
    risk_score = Math.min(risk_score, 4.0);
  }

  risk_score = Number(risk_score.toFixed(2));

  let ai_alert = false;
  let ai_reason = "No AI alert.";

  if (status === "active") {
    if (risk_score > 7.5) {
      ai_alert = true;
      ai_reason = "AI detected high combined risk pattern — early intervention recommended.";
    } else if (risk_score > 5.0 && warning === "medium") {
      ai_alert = true;
      ai_reason = "AI detected an emerging pattern — parameters drifting toward risk zone.";
    }

    if (
      warning !== "normal" &&
      event_type !== "normal" &&
      event_type !== "none"
    ) {
      ai_alert = true;
      if (ai_reason === "No AI alert.") {
        ai_reason = `AI confirmed ${event_type} deviation and recommends preventive action.`;
      }
    }
  }

  if (status === "inactive") {
    if (
      warning === "medium" &&
      (event_type === "vibration" || event_type === "pressure") &&
      risk_score >= 3.0
    ) {
      ai_alert = true;
      ai_reason =
        "AI detected an idle-state trend that could impact reliability on the next startup.";
    } else {
      ai_alert = false;
      ai_reason = "No AI alert (idle-state behavior within acceptable range).";
    }
  }

  if (status === "active" && warning === "high") {
    const clearlyAbnormal =
      temperature > 88 ||
      vibration > 4.0 ||
      pressure < 97.5 ||
      flow < 180;

    if (!clearlyAbnormal || risk_score < 8.0) {
      warning = "medium";
    }
  }

  if (status === "active" && ai_alert && warning === "normal") {
    warning = "medium";

    const tempDev = Math.max(0, temperature - 81);
    const vibDev = Math.max(0, vibration - 3.2);
    const pressDev = Math.max(0, 100.5 - pressure);
    const flowDev = Math.max(0, 195 - flow);

    const contributions = [
      { type: "temperature", value: tempDev * 0.35 },
      { type: "vibration", value: vibDev * 0.35 },
      { type: "pressure", value: pressDev * 0.15 },
      { type: "flow", value: flowDev * 0.25 }
    ].sort((a, b) => b.value - a.value);

    const top = contributions[0]?.type || "multi-parameter";

    if (top === "temperature") {
      ai_reason = "AI early detection: subtle overheating trend detected before it becomes critical.";
    } else if (top === "vibration") {
      ai_reason = "AI early detection: vibration pattern indicates early mechanical wear.";
    } else if (top === "pressure") {
      ai_reason = "AI early detection: pressure behavior suggests process instability.";
    } else if (top === "flow") {
      ai_reason = "AI early detection: flow pattern indicates early capacity loss.";
    } else {
      ai_reason = "AI early detection: multi-parameter deviation detected.";
    }
  }

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

  return {
    compressor_id: id,
    timestamp: Date.now(),
    status,
    temperature: Number(temperature.toFixed(2)),
    vibration: Number(vibration.toFixed(2)),
    pressure: Number(pressure.toFixed(2)),
    flow_rate: Number(flow.toFixed(2)),
    warning,
    event_type,
    risk_score,
    ai_alert,
    ai_reason,
    message,
    insights_manager: manager,
    insights_engineer: engineer,
    insights_maintenance: maintenance
  };
}

// ---------------- HELPERS ----------------
function weightedChoice(items, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    if (r < weights[i]) return items[i];
    r -= weights[i];
  }
  return items[items.length - 1];
}

function buildTrendObservations({ status, temperature, vibration, pressure, flow }) {
  const notes = [];

  if (status === "active") {
    if (temperature > 84.5) notes.push("temperature slightly elevated");
    else if (temperature < 80.5) notes.push("temperature slightly below typical range");

    if (vibration > 3.4) notes.push("vibration trending upward");
    else if (vibration < 2.9) notes.push("vibration lower than usual");

    if (pressure < 99.5) notes.push("pressure slightly below baseline");
    else if (pressure > 101.5) notes.push("pressure slightly above baseline");

    if (flow < 192) notes.push("flow approaching lower bound of normal");
    else if (flow > 208) notes.push("flow near upper bound of normal");
  } else if (status === "inactive") {
    if (temperature > 77.5) notes.push("temperature slightly elevated during idle state");
    if (vibration > 2.1) notes.push("vibration higher than expected for idle operation");
    if (pressure < 98.2) notes.push("pressure slightly below expected idle baseline");
    else if (pressure > 99.8) notes.push("pressure slightly above expected idle baseline");
    if (flow < 110) notes.push("flow slightly low for idle state");
    else if (flow > 122) notes.push("flow slightly high for idle state");
  } else if (status === "offline") {
    notes.push("baseline conditions assumed stable while unit is offline");
  }

  if (notes.length === 0) {
    return "Observations: parameters stable across all metrics.";
  }

  return "Observations: " + notes.join(", ") + ".";
}

function buildInsights(ctx) {
  const {
    status,
    warning,
    event_type,
    ai_alert,
    temperature,
    vibration,
    pressure,
    flow
  } = ctx;

  const observations = buildTrendObservations({ status, temperature, vibration, pressure, flow });

  if (status === "offline") {
    return {
      message: "Compressor offline — no telemetry. " + observations,
      manager: "Unit offline — no current production impact. " + observations,
      engineer: "Unit offline — AI monitoring paused until the compressor returns to operation. " + observations,
      maintenance: "Check power, connectivity, and safety interlocks if shutdown was not expected. " + observations
    };
  }

  if (status === "inactive" && warning === "normal") {
    return {
      message: "Compressor inactive — sensors online, no anomalies. " + observations,
      manager: "Idle unit — no production risk. " + observations,
      engineer: "Parameters stable during inactivity. " + observations,
      maintenance: "Routine checks only — no immediate action. " + observations
    };
  }

  if (status === "inactive" && warning === "medium") {
    return {
      message: `Inactive compressor with mild ${event_type} deviation — review before next startup. ${observations}`,
      manager: `No production impact — unit is idle, but follow up before restart. ${observations}`,
      engineer: `Review ${event_type} trend history and plan checks before the next startup. ${observations}`,
      maintenance: `Inspect ${event_type} components before bringing the compressor back online. ${observations}`
    };
  }

  if (ai_alert && event_type === "normal" && warning === "medium" && status === "active") {
    return {
      message: `AI detected early risk pattern — parameters look normal but trends are shifting. ${observations}`,
      manager: `Emerging risk — monitor this compressor to avoid downtime. ${observations}`,
      engineer: `Review vibration, flow, and temperature trends. ${observations}`,
      maintenance: `Plan inspection in the next maintenance window. ${observations}`
    };
  }

  if (warning === "normal") {
    return {
      message: "Operating normally. " + observations,
      manager: "Compressor healthy — no production risk. " + observations,
      engineer: "Parameters within expected range. " + observations,
      maintenance: "Continue routine preventive maintenance. " + observations
    };
  }

  if (warning === "medium") {
    return {
      message: `Medium ${event_type} deviation detected. ${observations}`,
      manager: `Emerging operational risk — monitor this unit. ${observations}`,
      engineer: `Review ${event_type} trend history and process conditions. ${observations}`,
      maintenance: `Inspect ${event_type} components in the next maintenance window. ${observations}`
    };
  }

  if (warning === "high") {
    return {
      message: `High ${event_type} deviation — immediate attention required. ${observations}`,
      manager: `High operational risk — potential production impact. ${observations}`,
      engineer: `Critical ${event_type} deviation — perform root cause analysis. ${observations}`,
      maintenance: `Treat as urgent — schedule immediate inspection for ${event_type}. ${observations}`
    };
  }

  return { message: observations, manager: observations, engineer: observations, maintenance: observations };
}

// ---------------- API ENDPOINTS ----------------

app.get("/wake", async (req, res) => {
  console.log("⚡ Wake request received — keeping simulator alive");
  await db.ref("simulator/lastActive").set(Date.now());
  res.json({ status: "awake" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

app.post("/ui/active", async (req, res) => {
  await db.ref("simulator/lastActive").set(Date.now());
  res.json({ status: "updated" });
});

app.get("/api/compressor/:id", (req, res) => {
  const id = req.params.id;
  const item = latestBatch.find(c => c.compressor_id === id);

  if (!item) {
    return res.status(404).json({ error: "Compressor not found" });
  }

  res.json(item);
});

app.get("/", (req, res) => {
  res.send("TwinTech Simulator is running.");
});

app.get("/api/latest", (req, res) => {
  res.json(latestBatch);
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