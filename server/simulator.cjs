// TwinTech Simulator — 6 Compressors, Dynamic Insights, Firebase + API
// Updated: realistic drift, status transitions, and correct offline/inactive behavior
// + Threshold-based warning logic with scoring and 30s lock

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const path = require("path");

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
// These are tuned to your current drift ranges:
// temperature: 74–95, vibration: 1.5–5.0, pressure: 96–104, flow: 150–230 (active)
const warningThresholds = {
  temperature: { medium: 90, high: 93, min: 70, max: 100 },
  vibration: { medium: 4.2, high: 4.6, min: 0, max: 6 },
  pressureLow: { medium: 97, high: 96, min: 90, max: 105 },
  flowLow: { medium: 170, high: 160, min: 120, max: 240 }
};

// Normalize score 0–1 based on how far into the warning band we are
function normalizeScore(value, type) {
  const t = warningThresholds[type];

  if (!t) return 0;

  // Temperature: higher is worse
  if (type === "temperature") {
    if (value < t.medium) return 0;
    return Math.min((value - t.medium) / (t.high - t.medium), 1);
  }

  // Vibration: higher is worse
  if (type === "vibration") {
    if (value < t.medium) return 0;
    return Math.min((value - t.medium) / (t.high - t.medium), 1);
  }

  // PressureLow: lower is worse
  if (type === "pressureLow") {
    if (value > t.medium) return 0;
    return Math.min((t.medium - value) / (t.medium - t.high), 1);
  }

  // FlowLow: lower is worse
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

// Evaluate warning with 30s lock + high override
function evaluateWarning(readings, currentWarningState) {
  const now = Date.now();

  // readings: { temperature, vibration, pressure, flow }
  const { temperature, vibration, pressure, flow } = readings;

  // Map to logical warning types
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

  // 1) High warnings override immediately
  const highCandidates = candidates.filter(c => c.severity === "high" && c.score > 0);
  if (highCandidates.length > 0) {
    highCandidates.sort((a, b) => b.score - a.score);
    const best = highCandidates[0];
    return {
      warning: "high",
      event_type: best.event_type,
      startTime: now
    };
  }

  // 2) If we are inside lock period, keep current warning
  if (
    currentWarningState &&
    currentWarningState.warning !== "normal" &&
    now - currentWarningState.startTime < 30000
  ) {
    return currentWarningState;
  }

  // 3) After lock ends, evaluate medium warnings
  const mediumCandidates = candidates.filter(c => c.severity === "medium" && c.score > 0);

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
    temperature: 78,
    vibration: 2.8,
    pressure: 100,
    flow: 200,
    trend: { temp: 0, vib: 0, press: 0, flow: 0 },
    state: "active",
    lastChange: Date.now(),
    warningState: { warning: "normal", event_type: "normal", startTime: Date.now() }
  },
  compressor_2: {
    temperature: 78,
    vibration: 2.8,
    pressure: 100,
    flow: 200,
    trend: { temp: 0, vib: 0, press: 0, flow: 0 },
    state: "active",
    lastChange: Date.now(),
    warningState: { warning: "normal", event_type: "normal", startTime: Date.now() }
  },
  compressor_3: {
    temperature: 78,
    vibration: 2.8,
    pressure: 100,
    flow: 200,
    trend: { temp: 0, vib: 0, press: 0, flow: 0 },
    state: "active",
    lastChange: Date.now(),
    warningState: { warning: "normal", event_type: "normal", startTime: Date.now() }
  },
  compressor_4: {
    temperature: 78,
    vibration: 2.8,
    pressure: 100,
    flow: 200,
    trend: { temp: 0, vib: 0, press: 0, flow: 0 },
    state: "active",
    lastChange: Date.now(),
    warningState: { warning: "normal", event_type: "normal", startTime: Date.now() }
  },
  compressor_5: {
    temperature: 78,
    vibration: 2.8,
    pressure: 100,
    flow: 200,
    trend: { temp: 0, vib: 0, press: 0, flow: 0 },
    state: "inactive", // fixed idle unit
    lastChange: Date.now(),
    warningState: { warning: "normal", event_type: "normal", startTime: Date.now() }
  },
  compressor_6: {
    temperature: 78,
    vibration: 2.8,
    pressure: 100,
    flow: 200,
    trend: { temp: 0, vib: 0, press: 0, flow: 0 },
    state: "offline", // fixed offline unit
    lastChange: Date.now(),
    warningState: { warning: "normal", event_type: "normal", startTime: Date.now() }
  }
};

// ---------------- STATUS TRANSITION LOGIC ----------------
function chooseStatus(id) {
  const mem = compressorMemory[id];
  const now = Date.now();
  const elapsed = now - mem.lastChange;

  // FIXED STATES
  if (id === "compressor_5") return "inactive";
  if (id === "compressor_6") return "offline";

  const MIN_ACTIVE = 30000;   // 30s
  const MIN_INACTIVE = 20000; // 20s
  const MIN_OFFLINE = 60000;  // 60s

  let current = mem.state;

  // Enforce minimum time in each state
  if (current === "active" && elapsed < MIN_ACTIVE) return current;
  if (current === "inactive" && elapsed < MIN_INACTIVE) return current;
  if (current === "offline" && elapsed < MIN_OFFLINE) return current;

  // Realistic transition probabilities (very stable)
  const r = Math.random();

  if (current === "active") {
    if (r < 0.985) return "active";     // 98.5% stay active
    if (r < 0.995) return "inactive";   // 1% chance
    return "offline";                   // 0.5% chance
  }

  if (current === "inactive") {
    if (r < 0.92) return "inactive";    // 92% stay inactive
    if (r < 0.985) return "active";     // 6.5% chance
    return "offline";                   // 1.5% chance
  }

  if (current === "offline") {
    if (r < 0.98) return "offline";     // 98% stay offline
    return "inactive";                  // 2% chance
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
function generateCompressorData(id) {
  const mem = compressorMemory[id];

  // 1) STATUS: choose realistic state
  let status = chooseStatus(id);
  if (status !== mem.state) {
    mem.state = status;
    mem.lastChange = Date.now();
  }

  // 2) OFFLINE: return early, no telemetry, no AI, no warnings
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

  // 3) REALISTIC DRIFT MODEL (active + inactive only)

  // trend update helper (smooth, directional)
  const updateTrend = (trendKey, baseScale) => {
    mem.trend[trendKey] =
      mem.trend[trendKey] * 0.8 + (Math.random() - 0.5) * baseScale;
  };

  if (status === "active") {
    // stronger trends
    updateTrend("temp", 0.08);
    updateTrend("vib", 0.04);
    updateTrend("press", 0.03);
    updateTrend("flow", 0.15);
  } else if (status === "inactive") {
    // very slow trends
    updateTrend("temp", 0.03);
    updateTrend("vib", 0.015);
    updateTrend("press", 0.01);
    updateTrend("flow", 0.05);
  }

  // apply trend-based drift
  if (status === "active" || status === "inactive") {
    mem.temperature += mem.trend.temp;
    mem.vibration += mem.trend.vib;
    mem.pressure += mem.trend.press;
    mem.flow += mem.trend.flow;

    // correlation: hotter → slightly more vibration
    mem.vibration += mem.trend.temp * 0.05;

    // correlation: flow drop → pressure drop
    mem.pressure += mem.trend.flow * -0.03;

    // baseline pull (stability)
    const TEMP_BASE = 80;
    const VIB_BASE = 3.0;
    const PRESS_BASE = 100;
    const FLOW_BASE = status === "active" ? 200 : 125;

    mem.temperature += (TEMP_BASE - mem.temperature) * 0.01;
    mem.vibration += (VIB_BASE - mem.vibration) * 0.01;
    mem.pressure += (PRESS_BASE - mem.pressure) * 0.01;
    mem.flow += (FLOW_BASE - mem.flow) * 0.02;
  }

  // clamp realistic ranges
  mem.temperature = Math.min(Math.max(mem.temperature, 74), 95);
  mem.vibration = Math.min(Math.max(mem.vibration, 1.5), 5.0);
  mem.pressure = Math.min(Math.max(mem.pressure, 96), 104);
  mem.flow = Math.min(
    Math.max(mem.flow, status === "active" ? 150 : 100),
    status === "active" ? 230 : 150
  );

  // assign final values
  let temperature = mem.temperature;
  let vibration = mem.vibration;
  let pressure = mem.pressure;
  let flow = mem.flow;

  // 4) WARNING + EVENT TYPE via new logic
  let warning = "normal";
  let event_type = "normal";

  if (status === "active" || status === "inactive") {
    const readings = { temperature, vibration, pressure, flow };
    const nextWarningState = evaluateWarning(readings, mem.warningState);
    mem.warningState = nextWarningState;

    warning = nextWarningState.warning;
    event_type = nextWarningState.event_type;
  }

  // 5) RISK SCORE
  let risk_score = 0;

  if (status === "active") {
    const tempDev = Math.max(0, temperature - 80);
    const vibDev = Math.max(0, vibration - 4.0);
    const pressDev = Math.max(0, 100 - pressure);
    const flowDev = Math.max(0, 200 - flow);

    risk_score =
      tempDev * 0.3 +
      vibDev * 0.3 +
      pressDev * 0.2 +
      flowDev * 0.3;

    if (warning === "medium") risk_score += 2;
    if (warning === "high") risk_score += 4;
  } else if (status === "inactive") {
    if (warning === "normal") {
      risk_score = 0.5 + Math.random() * 2.0;
    } else if (warning === "medium") {
      risk_score = 3.0 + Math.random() * 3.0;
    } else if (warning === "high") {
      risk_score = 5.0 + Math.random() * 3.0;
    }
  }

  risk_score = Number(risk_score.toFixed(2));

  // 6) AI LOGIC (active + inactive only)
  let ai_alert = false;
  let ai_reason = "No AI alert.";

  if (status === "active") {
    if (risk_score > 8) {
      ai_alert = true;
      ai_reason = "AI detected high combined risk pattern.";
    }

    if (
      warning !== "normal" &&
      event_type !== "normal" &&
      event_type !== "none"
    ) {
      ai_alert = true;
      ai_reason = `AI confirmed ${event_type} deviation.`;
    }
  }

  if (status === "inactive") {
    if (
      warning === "medium" &&
      (event_type === "vibration" || event_type === "pressure") &&
      risk_score >= 4.0
    ) {
      ai_alert = true;
      ai_reason =
        "AI detected an idle-state trend that could impact reliability on the next startup.";
    } else {
      ai_alert = false;
      ai_reason = "No AI alert (idle-state behavior within acceptable range).";
    }
  }

  // 7) HIGH WARNING sanity check (active only)
  if (status === "active" && warning === "high") {
    const clearlyAbnormal =
      temperature > 82 ||
      vibration > 4.2 ||
      pressure < 97 ||
      pressure > 103 ||
      flow < 185;

    if (!clearlyAbnormal) {
      warning = "medium";
    }
  }

  // 8) AI early detection upgrade (active only)
  if (status === "active" && ai_alert && warning === "normal") {
    warning = "medium";

    const tempDev = Math.max(0, temperature - 80);
    const vibDev = Math.max(0, vibration - 4.0);
    const pressDev = Math.max(0, 100 - pressure);
    const flowDev = Math.max(0, 200 - flow);

    const contributions = [
      { type: "temperature", value: tempDev * 0.3 },
      { type: "vibration", value: vibDev * 0.3 },
      { type: "pressure", value: pressDev * 0.2 },
      { type: "flow", value: flowDev * 0.3 }
    ].sort((a, b) => b.value - a.value);

    const top = contributions[0]?.type || "multi-parameter";

    if (top === "temperature") {
      ai_reason = "AI early detection: subtle overheating trend detected.";
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

  // 9) INSIGHTS
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

  // 10) FINAL OBJECT (structure unchanged)
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
    if (temperature > 81.5) notes.push("temperature slightly elevated");
    else if (temperature < 76.5) notes.push("temperature slightly below typical range");

    if (vibration > 3.8) notes.push("vibration trending upward");
    else if (vibration < 2.2) notes.push("vibration lower than usual");

    if (pressure < 99) notes.push("pressure slightly below baseline");
    else if (pressure > 101.5) notes.push("pressure slightly above baseline");

    if (flow < 195) notes.push("flow approaching lower bound of normal");
    else if (flow > 210) notes.push("flow near upper bound of normal");
  } else if (status === "inactive") {
    if (temperature > 81.5) notes.push("temperature slightly elevated during idle state");
    if (vibration > 3.5) notes.push("vibration higher than expected for idle operation");
    if (pressure < 98.5) notes.push("pressure slightly below expected idle baseline");
    else if (pressure > 101.5) notes.push("pressure slightly above expected idle baseline");
    if (flow < 115) notes.push("flow slightly low for idle state");
    else if (flow > 135) notes.push("flow slightly high for idle state");
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

// Wake endpoint (frontend calls this after login)
app.get("/wake", async (req, res) => {
  console.log("⚡ Wake request received — keeping simulator alive");
  await db.ref("simulator/lastActive").set(Date.now());
  res.json({ status: "awake" });
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

// UI heartbeat (frontend calls every 10–20 seconds)
app.post("/ui/active", async (req, res) => {
  await db.ref("simulator/lastActive").set(Date.now());
  res.json({ status: "updated" });
});

// Single compressor endpoint
app.get("/api/compressor/:id", (req, res) => {
  const id = req.params.id;
  const item = latestBatch.find(c => c.compressor_id === id);

  if (!item) {
    return res.status(404).json({ error: "Compressor not found" });
  }

  res.json(item);
});

// Root endpoint
app.get("/", (req, res) => {
  res.send("TwinTech Simulator is running.");
});

// Latest batch endpoint
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