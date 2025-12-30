Here is the full simulator file(CommonJS) updated to:
- preserve the exact output schema by default,
- add a PREDICTIVE_WARNINGS env flag to turn ML promotions on / off(default: ON),
  - safely parse FIREBASE_SERVICE_ACCOUNT or FIREBASE_SERVICE_ACCOUNT_B64,
    - optionally expose ML fields in the returned payload via EXPOSE_ML_FIELDS = false(default ).

Save as simulator.cjs.

```javascript name=simulator.cjs
/* ---------------------------------------------------------
   TwinTech Simulator — Final Stable Version (Render-ready)
   - ML-style predictive warning layer (toggleable via PREDICTIVE_WARNINGS)
   - Optional exposure of ML fields via EXPOSE_ML_FIELDS
   - Safe FIREBASE_SERVICE_ACCOUNT parsing (supports base64)
   - Preserves output schema by default (no breaking changes)
--------------------------------------------------------- */

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");

// ---------------- ENV & FIREBASE INIT ----------------
// Safe handling: support FIREBASE_SERVICE_ACCOUNT (raw JSON) or FIREBASE_SERVICE_ACCOUNT_B64
let serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!serviceAccountJson && process.env.FIREBASE_SERVICE_ACCOUNT_B64) {
  try {
    serviceAccountJson = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, "base64").toString("utf8");
  } catch (e) {
    console.error("Failed to decode FIREBASE_SERVICE_ACCOUNT_B64:", e);
  }
}
if (!serviceAccountJson) {
  throw new Error("Missing Firebase service account in env: set FIREBASE_SERVICE_ACCOUNT or FIREBASE_SERVICE_ACCOUNT_B64");
}
const serviceAccount = JSON.parse(serviceAccountJson);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://twintech-mvp-default-rtdb.firebaseio.com"
});

const db = admin.database();

// Feature toggles (env)
const PREDICTIVE_WARNINGS = process.env.PREDICTIVE_WARNINGS !== "false"; // default true
const EXPOSE_ML_FIELDS = process.env.EXPOSE_ML_FIELDS === "true"; // default false

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

// ---------------- WARNING THRESHOLDS ----------------
const warningThresholds = {
  temperature: { medium: 83.3, high: 88.5, min: 70, max: 100 },
  vibration:   { medium: 3.30, high: 3.9, min: 0, max: 6 },
  pressureLow: { medium: 100.0, high: 97.5, min: 90, max: 105 },
  flowLow:     { medium: 199, high: 178, min: 120, max: 240 }
};
const WARNING_LOCK_MS = 10 * 1000; // 10 seconds

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
   MEMORY, BIAS FLIP, STATUS LOGIC
--------------------------------------------------------- */

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
    warningState: { warning: "normal", event_type: "normal", startTime: Date.now() },
    history: [
      {
        ts: Date.now(),
        temperature: temp,
        vibration: vib,
        pressure: press,
        flow: flow
      }
    ]
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
   ML PREDICTOR (velocity -> time-to-threshold), WARNING EVAL, INSIGHTS
--------------------------------------------------------- */

// ---------------- UTILS ----------------
function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

function updateMemoryHistory(mem, reading) {
  const MAX_HISTORY = 12; // last ~12 readings (with TICK_MS=2000 -> ~24s)
  mem.history.push({
    ts: reading.ts || Date.now(),
    temperature: reading.temperature,
    vibration: reading.vibration,
    pressure: reading.pressure,
    flow: reading.flow
  });
  if (mem.history.length > MAX_HISTORY) mem.history.shift();
}

// Lightweight predictive model: uses short history + trend to estimate time-to-medium-threshold (ms).
function computeMLPrediction(mem) {
  if (!mem || !Array.isArray(mem.history) || mem.history.length < 2) {
    return { ml_score: 0, predicted_event_type: "normal", time_to_warning_ms: Infinity, details: {} };
  }

  const h = mem.history;
  const latest = h[h.length - 1];
  let prev = null;
  for (let i = h.length - 2; i >= 0; i--) {
    if (h[i].ts < latest.ts) {
      prev = h[i];
      break;
    }
  }
  if (!prev) prev = h[0];

  const dt = Math.max(1, latest.ts - prev.ts); // ms

  const v_temp = (latest.temperature - prev.temperature) / dt;
  const v_vib  = (latest.vibration - prev.vibration) / dt;
  const v_press = (latest.pressure - prev.pressure) / dt;
  const v_flow  = (latest.flow - prev.flow) / dt;

  function timeToMedium(value, velPerMs, type) {
    const t = warningThresholds[type];
    if (!t) return Infinity;

    if (type === "temperature" || type === "vibration") {
      const target = t.medium;
      if (value >= target) return 0;
      if (velPerMs <= 0) return Infinity;
      const ms = (target - value) / velPerMs;
      return ms;
    }

    if (type === "pressureLow" || type === "flowLow") {
      const target = t.medium;
      if (value <= target) return 0;
      if (velPerMs >= 0) return Infinity;
      const ms = (value - target) / (-velPerMs);
      return ms;
    }

    return Infinity;
  }

  const nowVals = {
    temperature: latest.temperature,
    vibration: latest.vibration,
    pressure: latest.pressure,
    flow: latest.flow
  };

  const tt_temp = timeToMedium(nowVals.temperature, v_temp, "temperature");
  const tt_vib  = timeToMedium(nowVals.vibration, v_vib, "vibration");
  const tt_press = timeToMedium(nowVals.pressure, v_press, "pressureLow");
  const tt_flow  = timeToMedium(nowVals.flow, v_flow, "flowLow");

  const HORIZON_MS = 20 * 60 * 1000; // 20 minutes
  function urgencyFromTime(tt) {
    if (tt === 0) return 1;
    if (!isFinite(tt)) return 0;
    const u = 1 - Math.min(tt / HORIZON_MS, 1);
    return clamp(u, 0, 1);
  }

  const u_temp = urgencyFromTime(tt_temp);
  const u_vib  = urgencyFromTime(tt_vib);
  const u_press = urgencyFromTime(tt_press);
  const u_flow  = urgencyFromTime(tt_flow);

  const w_temp = 0.35;
  const w_vib  = 0.30;
  const w_press = 0.15;
  const w_flow = 0.20;

  const ml_score_raw = w_temp * u_temp + w_vib * u_vib + w_press * u_press + w_flow * u_flow;
  const ml_score = clamp(ml_score_raw, 0, 1);

  const urgencies = [
    { key: "temperature", u: u_temp, tt: tt_temp },
    { key: "vibration", u: u_vib, tt: tt_vib },
    { key: "pressureLow", u: u_press, tt: tt_press },
    { key: "flowLow", u: u_flow, tt: tt_flow }
  ];
  urgencies.sort((a, b) => b.u - a.u);
  const top = urgencies[0];

  const predicted_event_type = top.u > 0.05 ? (
    top.key === "temperature" ? "overheating" :
    top.key === "vibration" ? "vibration" :
    top.key === "pressureLow" ? "pressure" :
    top.key === "flowLow" ? "low_flow" :
    "normal"
  ) : "normal";

  const time_to_warning_ms = top.tt;

  return {
    ml_score: Number(ml_score.toFixed(3)),
    predicted_event_type,
    time_to_warning_ms,
    details: {
      velocities: { v_temp, v_vib, v_press, v_flow },
      urgencies: { u_temp, u_vib, u_press, u_flow },
      weighted: { w_temp, w_vib, w_press, w_flow }
    }
  };
}

// Updated evaluateWarning to combine threshold checks and predictive ML signal (ML promotions are toggleable)
function evaluateWarning(readings, currentWarningState, mem, predictiveEnabled = true) {
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

  // Predictive ML signal
  let ml = computeMLPrediction(mem || {});
  const ML_HIGH = 0.75;
  const ML_MED = 0.45;

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
      startTime: now,
      ml: ml
    };
  }

  if (
    currentWarningState &&
    currentWarningState.warning !== "normal" &&
    now - currentWarningState.startTime < WARNING_LOCK_MS
  ) {
    const kept = Object.assign({}, currentWarningState);
    kept.ml = ml;
    return kept;
  }

  let mediumCandidates = candidates.filter(c => c.severity === "medium" && c.score > 0);

  if (isInactive || isFixedInactive) {
    mediumCandidates = mediumCandidates.filter(c => c.score > 0.25);
  }

  // Predictive overrides (only if predictiveEnabled)
  if (predictiveEnabled && ml && ml.ml_score >= ML_HIGH && ml.predicted_event_type !== "normal") {
    return {
      warning: "high",
      event_type: ml.predicted_event_type,
      startTime: now,
      ml: ml
    };
  }

  if (predictiveEnabled && ml && ml.ml_score >= ML_MED && ml.predicted_event_type !== "normal") {
    return {
      warning: "medium",
      event_type: ml.predicted_event_type,
      startTime: now,
      ml: ml
    };
  }

  if (mediumCandidates.length === 0) {
    return {
      warning: "normal",
      event_type: "normal",
      startTime: now,
      ml: ml
    };
  }

  mediumCandidates.sort((a, b) => b.score - a.score);
  const bestMedium = mediumCandidates[0];

  if (predictiveEnabled && ml && ml.ml_score > 0.15 && ml.predicted_event_type !== "normal" && ml.predicted_event_type !== bestMedium.event_type) {
    return {
      warning: "medium",
      event_type: ml.predicted_event_type,
      startTime: now,
      ml: ml
    };
  }

  return {
    warning: "medium",
    event_type: bestMedium.event_type,
    startTime: now,
    ml: ml
  };
}

// Enriched buildInsights: adds recommended fixes and role-specific action items
function buildInsights({
  status,
  warning,
  event_type,
  ai_alert,
  temperature,
  vibration,
  pressure,
  flow,
  ml // optional
}) {
  // ---------------- MESSAGE (Operator-facing) ----------------
  let message = "System operating normally.";
  if (status === "inactive") {
    message = "Unit is idle — reduced load conditions.";
  }
  if (warning === "medium") {
    message = `Moderate ${ event_type } deviation detected.`;
  }
  if (warning === "high") {
    message = `Critical ${ event_type } deviation — immediate attention required.`;
  }
  if (ai_alert) {
    message = "AI detected an emerging risk pattern — investigate recommended actions.";
  }

  // Add ML relative timing if available
  if (ml && ml.time_to_warning_ms && isFinite(ml.time_to_warning_ms)) {
    const mins = Math.round(ml.time_to_warning_ms / 60000);
    if (mins <= 0) {
      message += " Predicted to reach warning threshold imminently.";
    } else {
      message += ` Predicted to reach warning threshold in ~${ mins } min.`;
    }
  }

  // ---------------- MANAGER INSIGHT ----------------
  let manager = "Production stable — no action required.";
  if (status === "inactive") manager = "Unit idle — no production impact.";
  if (warning === "medium") manager = "Monitor performance — potential efficiency loss.";
  if (warning === "high") manager = "High-risk condition — potential production impact. Consider load rebalancing or spare activation.";
  if (ai_alert) manager = "AI recommends proactive review to avoid downtime; prioritize by predicted time-to-warning.";

  // ---------------- ENGINEER INSIGHT ----------------
  let engineer = "All parameters within expected ranges.";
  let recommended_actions = [];

  if (event_type === "overheating") {
    engineer = `Temperature trending abnormal${ warning !== "normal" ? " — investigate cooling system and bearing lubrication." : "." } `;
    recommended_actions.push("Check cooling fans and heat exchanger");
    recommended_actions.push("Verify lubrication levels and bearing temps");
    recommended_actions.push("Inspect air intake for obstructions");
  } else if (event_type === "vibration") {
    engineer = `Vibration deviation detected${ warning !== "normal" ? " — inspect rotor balance and mounting." : "." } `;
    recommended_actions.push("Run a balance check on the rotor");
    recommended_actions.push("Inspect motor mounts and coupling");
    recommended_actions.push("Check for loose hardware or soft foot");
  } else if (event_type === "pressure") {
    engineer = `Pressure is trending low${ warning !== "normal" ? " — investigate valves and seals." : "." } `;
    recommended_actions.push("Inspect inlet valves and filters");
    recommended_actions.push("Check for leaks in piping and seals");
    recommended_actions.push("Validate compressor control setpoints");
  } else if (event_type === "low_flow") {
    engineer = `Flow reduced${ warning !== "normal" ? " — inspect flow path and sensors." : "." } `;
    recommended_actions.push("Check flow sensors and sampling lines");
    recommended_actions.push("Inspect for partially closed valves or blockages");
    recommended_actions.push("Verify pump / drive operation for associated systems");
  }

  if (warning === "high") {
    recommended_actions.unshift("If safe, move unit to safe mode or shut down per SOP");
  }

  if (status === "inactive") {
    recommended_actions.push("Verify standby lubrication and purge schedules");
  }

  // Include ML-driven recommendations if present
  if (ml && ml.ml_score && ml.ml_score >= 0.45) {
    recommended_actions.unshift("Prioritize inspection — predictive model indicates elevated near-term risk.");
  }

  // ---------------- MAINTENANCE INSIGHT ----------------
  let maintenance = "No maintenance action required.";
  if (status === "inactive") maintenance = "Unit idle — verify lubrication and standby conditions.";
  if (warning === "medium") maintenance = `Schedule inspection on subsystem related to ${ event_type }.`;
  if (warning === "high") maintenance = `Urgent inspection required — ${ event_type } risk.Follow emergency escalation.`;

  if (ai_alert) {
    maintenance += " AI recommends early maintenance check to prevent escalation.";
    maintenance += " Suggested actions: " + recommended_actions.slice(0, 3).join("; ") + ".";
  } else if (recommended_actions.length > 0) {
    maintenance += " Suggested checks: " + recommended_actions.slice(0, 2).join("; ") + ".";
  }

  return {
    message,
    manager,
    engineer,
    maintenance
  };
}

/* ---------------------------------------------------------
   MAIN DATA GENERATION
--------------------------------------------------------- */
function generateCompressorData(id) {
  const mem = compressorMemory[id];

  updateBias(mem);
  const now = Date.now();

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

  // ---------------- CLAMP VALUES ----------------
  if (status === "active") {
    mem.temperature = clamp(mem.temperature, 80, 87);
    mem.vibration   = clamp(mem.vibration, 2.8, 3.7);
    mem.pressure    = clamp(mem.pressure, 98.5, 102);
    mem.flow        = clamp(mem.flow, 188, 210);
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

  // Update memory history so ML predictor can use latest point
  updateMemoryHistory(mem, {
    ts: now,
    temperature,
    vibration,
    pressure,
    flow
  });

  // ---------------- WARNING EVALUATION ----------------
  const readings = {
    temperature,
    vibration,
    pressure,
    flow,
    status,
    compressor_id: id
  };

  const next = evaluateWarning(readings, mem.warningState, mem, PREDICTIVE_WARNINGS);
  mem.warningState = next;

  let warning = next.warning;
  let event_type = next.event_type;
  const ml = next.ml || null;

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
  } else if (status === "inactive") {
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

    // ML-based early detection
    if (ml && ml.ml_score >= 0.75) {
      ai_alert = true;
      const mins = isFinite(ml.time_to_warning_ms) ? Math.round(ml.time_to_warning_ms / 60000) : null;
      ai_reason = `Predictive model confident: ${ ml.predicted_event_type } likely in ${ mins !== null ? `${mins} min` : "near term" }.`;
    } else if (ml && ml.ml_score >= 0.45) {
      ai_alert = true;
      const mins = isFinite(ml.time_to_warning_ms) ? Math.round(ml.time_to_warning_ms / 60000) : null;
      ai_reason = `Predictive model indicates increased risk: ${ ml.predicted_event_type }${ mins !== null ? ` in ~${mins} min` : "" }.`;
    }

    if (warning !== "normal" && event_type !== "normal") {
      ai_alert = true;
      if (ai_reason === "No AI alert.") {
        ai_reason = `AI confirmed ${ event_type } deviation.`;
      } else {
        ai_reason += ` Confirmed ${ event_type } deviation.`;
      }
    }
  } else if (status === "inactive") {
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
      flow,
      ml
    });

  // ---------------- FINAL RETURN OBJECT ----------------
  const baseResult = {
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

  // Optionally expose ML fields (disabled by default to preserve schema)
  if (EXPOSE_ML_FIELDS && ml) {
    baseResult.ml_score = typeof ml.ml_score === "number" ? ml.ml_score : null;
    baseResult.predicted_event_type = ml.predicted_event_type || null;
    baseResult.time_to_warning_min = isFinite(ml.time_to_warning_ms) ? Math.round(ml.time_to_warning_ms / 60000) : null;
  }

  return baseResult;
}

/* ---------------------------------------------------------
   FIREBASE WRITERS, API, SERVER START
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
```