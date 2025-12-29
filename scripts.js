/* ======================================================
   JM Racing Dashboard – FULL INTEGRATED VERSION
   Features:
   • Live MQTT from HiveMQ Cloud
   • Real-time telemetry + graphs
   • CSV logging (start / stop / download)
   • Reset distance baseline
   ====================================================== */

/* ====== CONFIG ====== */
const MQTT_URL  = "wss://8fac0c92ea0a49b8b56f39536ba2fd78.s1.eu.hivemq.cloud:8884/mqtt";
const MQTT_USER = "ShellJM";
const MQTT_PASS = "psuEcoteam1st";
const TOPIC     = "car/telemetry";

const TRACK_LAP_KM  = 3.7;   // Lusail short lap
const LAPS_TARGET   = 4;
const PACKET_MIN_MS = 90;    // UI throttle (≤ 11 FPS)

/* ====== DOM ====== */
const el = id => document.getElementById(id);

// Header + Controls
const lapCounterEl      = el("lapCounter");
const startSessionBtn   = el("startSessionBtn");
const endSessionBtn     = el("endSessionBtn");
const resetDistanceBtn  = el("resetDistanceBtn");
const aiStatusCircle    = el("aiStatusCircle");
const aiCueDisplay      = el("aiCueDisplay");

// View toggle
const liveBtn   = el("liveTelemetryBtn");
const graphsBtn = el("graphsBtn");
const telemView = el("telemetryView");
const graphsView= el("graphsView");

// Main metrics
const mainEffEl   = el("mainEfficiency");
const mainSpdEl   = el("mainSpeed");
const mainTimerEl = el("mainTimer");

// Telemetry card metrics
const avgSpeedEl      = el("avgSpeed");
const remainingEl     = el("remainingTime");
const distanceEl      = el("distanceCovered");
const consumptionEl   = el("consumption");
const voltageEl       = el("voltage");
const currentEl       = el("current");
const powerEl         = el("power");
const totalEnergyEl   = el("totalEnergy");
const rpmEl           = el("rpm");
const efficiencyEl    = el("efficiency");
const gpsLonEl        = el("gpsLongitude");
const gpsLatEl        = el("gpsLatitude");

// Graph divs
const speedGraphDiv   = el("speedGraph");
const currentGraphDiv = el("currentGraph");
const powerGraphDiv   = el("powerGraph");

/* ====== STATE ====== */
const state = {
  // latest packet
  v: 0, i: 0, p: 0, speed: 0, rpm: 0, distKmAbs: 0, lon: 0, lat: 0,
  // accumulated
  energyWhAbs: 0,
  t0: null,
  lastTsMs: null,
  // relative baseline
  baseDistKm: 0,
  baseEnergyWh: 0,
  // derived
  avgSpeedKmh: 0,
  laps: 0,
  // graph buffers
  series: { t: [], speed: [], current: [], power: [] },
  maxPoints: 3000,
  // AI cues and response
  aiCue: null,
  aiCueTime: null,
  driverResponseGood: null
};
function clampLen(arr, max) {
  if (arr.length > max) arr.splice(0, arr.length - max);
}
/* ====== MAP SETUP (Leaflet) ====== */
let map, marker;

function initMap() {
  // Start with a neutral location (will be updated by telemetry)
  const startPos = [0, 0];

  map = L.map('map').setView(startPos, 2); // zoomed out initially

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  marker = L.marker(startPos).addTo(map);
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(pos => {
      const coords = [pos.coords.latitude, pos.coords.longitude];
      map.setView(coords, 16);
      marker.setLatLng(coords);
    });
  }
  
}


/* ====== MQTT ====== */
let client;
function mqttConnect() {
  client = mqtt.connect(MQTT_URL, {
    username: MQTT_USER,
    password: MQTT_PASS,
    clean: true,
    reconnectPeriod: 2000
  });

  client.on("connect", () => {
    console.log("✅ Connected to HiveMQ Cloud");
    client.subscribe(TOPIC, err => {
      if (err) console.error("Subscribe error:", err);
    });
  });

  client.on("message", (topic, payload) => {
    if (topic !== TOPIC) return;
    let data;
    try { data = JSON.parse(payload.toString()); }
    catch(e){ console.error("Bad packet", e); return; }
    ingestTelemetry(data);
  });

  client.on("error", console.error);
}

/* ====== INGEST TELEMETRY ====== */
function num(x){ const v = Number(x); return Number.isFinite(v) ? v : 0; }

function ingestTelemetry(d) {
  // --- VOLTAGE FILTER: Reject packets with voltage >= 60V ---
  const voltage = num(d.voltage);
  if (voltage >= 60) {
    console.warn(`⚠️ Rejected packet: voltage ${voltage}V >= 60V (invalid reading)`);
    return; // Ignore this packet completely - don't process, don't log, don't display
  }

  const now = performance.now();
  if (state.t0 === null) state.t0 = now;
  const dtMs = state.lastTsMs == null ? 0 : (now - state.lastTsMs);
  state.lastTsMs = now;
  const dtH = dtMs / 3600000; // ms → hours

  // --- Raw values from MQTT (only process if voltage < 60V) ---
  state.v      = voltage;
  state.i      = num(d.current);
  state.p      = num(d.power);
  state.speed  = num(d.speed);
  state.rpm    = num(d.rpm);
  state.distKmAbs = num(d.distance_km);
  state.lon    = num(d.longitude);
  state.lat    = num(d.latitude);
  
  // --- AI Cue from MQTT ---
  if (d.ai_cue !== undefined && d.ai_cue !== null && d.ai_cue !== "") {
    state.aiCue = String(d.ai_cue).toLowerCase().trim();
    state.aiCueTime = now;
    updateAICueDisplay(state.aiCue);
  }
  
  // --- Evaluate driver response to AI cue ---
  if (state.aiCue) {
    evaluateDriverResponse();
  }

  // --- Integrate energy (Wh = W × h) ---
  if (dtH > 0 && state.p > -1e6 && state.p < 1e6) {
    state.energyWhAbs += state.p * dtH;
  }

  // --- Avg speed (EWMA smoothing) ---
  state.avgSpeedKmh = state.avgSpeedKmh === 0
    ? state.speed
    : (0.9 * state.avgSpeedKmh + 0.1 * state.speed);

  // --- Lap counting ---
  const distKmRel = Math.max(0, state.distKmAbs - state.baseDistKm);
  state.laps = Math.floor(distKmRel / TRACK_LAP_KM);

  // --- Time-series data for graphs ---
  const tSec = (now - state.t0) / 1000;
  state.series.t.push(tSec);
  state.series.speed.push(state.speed);
  state.series.current.push(state.i);
  state.series.power.push(state.p);
  clampLen(state.series.t, state.maxPoints);
  clampLen(state.series.speed, state.maxPoints);
  clampLen(state.series.current, state.maxPoints);
  clampLen(state.series.power, state.maxPoints);

  // --- Logging to CSV (if enabled) ---
  if (logging) {
    const nowISO = new Date().toISOString();
    const energyWhRel = Math.max(0, state.energyWhAbs - state.baseEnergyWh);
    const kWh = energyWhRel / 1000;
    const km_per_kWh = kWh > 0 ? (distKmRel / kWh) : 0;
    const Wh_per_km  = distKmRel > 0 ? (energyWhRel / distKmRel) : 0;

    logData.push({
      timestamp: nowISO,
      voltage: state.v.toFixed(3),
      current: state.i.toFixed(3),
      power: state.p.toFixed(3),
      speed: state.speed.toFixed(3),
      rpm: state.rpm.toFixed(2),
      distance_km: state.distKmAbs.toFixed(4),
      latitude: state.lat.toFixed(6),
      longitude: state.lon.toFixed(6),
      total_energy_wh: energyWhRel.toFixed(3),
      efficiency_km_per_kwh: km_per_kWh.toFixed(3),
      consumption_wh_per_km: Wh_per_km.toFixed(3)
    });
  }

  // --- Request repaint ---
  requestFrame();
}

/* ====== AI CUE & DRIVER RESPONSE ====== */
function updateAICueDisplay(cue) {
  if (!aiCueDisplay) return;
  
  const cueMap = {
    'throttle': 'THROTTLE',
    'coast': 'COAST',
    'stop': 'STOP',
    'brake': 'BRAKE',
    'accelerate': 'ACCELERATE',
    'maintain': 'MAINTAIN'
  };
  
  const displayText = cueMap[cue] || cue.toUpperCase();
  aiCueDisplay.textContent = displayText;
  
  // Remove all cue classes
  aiCueDisplay.className = 'ai-cue-display';
  
  // Add appropriate class
  if (cue === 'throttle' || cue === 'accelerate') {
    aiCueDisplay.classList.add('cue-throttle');
  } else if (cue === 'coast' || cue === 'maintain') {
    aiCueDisplay.classList.add('cue-coast');
  } else if (cue === 'stop') {
    aiCueDisplay.classList.add('cue-stop');
  } else if (cue === 'brake') {
    aiCueDisplay.classList.add('cue-brake');
  }
}

function evaluateDriverResponse() {
  if (!state.aiCue || !aiStatusCircle) return;
  
  const cue = state.aiCue;
  let isGood = false;
  
  // Evaluate based on cue type and current telemetry
  switch(cue) {
    case 'throttle':
    case 'accelerate':
      // Good if power/current is increasing or speed is increasing
      isGood = state.p > 50 || state.i > 0.1 || state.speed > 5;
      break;
      
    case 'coast':
    case 'maintain':
      // Good if power is low (coasting) or maintaining steady speed
      isGood = state.p < 100 && state.i < 0.2;
      break;
      
    case 'stop':
    case 'brake':
      // Good if power is very low or zero (stopping)
      isGood = state.p < 10 && state.speed < 2;
      break;
      
    default:
      isGood = true; // Neutral for unknown cues
  }
  
  // Update status circle
  state.driverResponseGood = isGood;
  aiStatusCircle.className = 'ai-status-circle';
  
  if (isGood) {
    aiStatusCircle.classList.add('good');
      } else {
    aiStatusCircle.classList.add('bad');
  }
  
  // If no cue received for 5 seconds, show neutral
  if (state.aiCueTime && (performance.now() - state.aiCueTime) > 5000) {
    aiStatusCircle.classList.remove('good', 'bad');
    aiStatusCircle.classList.add('neutral');
    aiCueDisplay.textContent = '--';
    aiCueDisplay.className = 'ai-cue-display';
  }
}

/* ====== RENDER LOOP ====== */
let rafPending = false, lastPaintMs = 0;
function requestFrame(){
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(paint);
}
function paint(){
  rafPending = false;
  const now = performance.now();
  if (now - lastPaintMs < PACKET_MIN_MS) return;
  lastPaintMs = now;

  // Only update display if we have received real MQTT data (t0 is set)
  // This prevents showing dummy/initialized values on page load
  if (state.t0 === null) {
    // No MQTT data received yet - keep showing zeros (initial state)
    return;
  }

  const distKmRel   = Math.max(0, state.distKmAbs - state.baseDistKm);
  const energyWhRel = Math.max(0, state.energyWhAbs - state.baseEnergyWh);
  const kWh = energyWhRel / 1000;
  const km_per_kWh = kWh > 0 ? (distKmRel / kWh) : 0;
  const Wh_per_km  = distKmRel > 0 ? (energyWhRel / distKmRel) : 0;

  // Header
  mainSpdEl.textContent = state.speed.toFixed(0);
  mainEffEl.textContent = km_per_kWh.toFixed(1);
  mainTimerEl.textContent = raceClock();

  // Telemetry metrics
  avgSpeedEl.textContent     = state.avgSpeedKmh.toFixed(1);
  remainingEl.textContent    = remainingTime();
  distanceEl.textContent     = distKmRel.toFixed(3);
  consumptionEl.textContent  = Wh_per_km.toFixed(1);
  voltageEl.textContent      = state.v.toFixed(2);
  currentEl.textContent      = state.i.toFixed(2);
  powerEl.textContent        = state.p.toFixed(0);
  totalEnergyEl.textContent  = energyWhRel.toFixed(1);
  rpmEl.textContent          = state.rpm.toFixed(0);
  efficiencyEl.textContent   = km_per_kWh.toFixed(1);
  gpsLonEl.textContent       = state.lon.toFixed(6);
  gpsLatEl.textContent       = state.lat.toFixed(6);

  // Laps
  lapCounterEl.textContent = `${Math.min(state.laps, LAPS_TARGET)}/${LAPS_TARGET}`;
  if (map && marker && state.lat && state.lon) {
    const pos = [state.lat, state.lon];
    marker.setLatLng(pos);  // Move marker to new location
    map.panTo(pos, { animate: true, duration: 0.5 });
  }
  
  // Graph update
  updateGraphs();
}

function raceClock(){
  if (state.t0 == null) return "00:00";
  const t = (performance.now() - state.t0) / 1000;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}
function remainingTime(){
  if (state.t0 == null) return "35:00";
  const elapsed = (performance.now() - state.t0) / 1000;
  const left = Math.max(0, 35*60 - elapsed);
  const m = Math.floor(left / 60);
  const s = Math.floor(left % 60);
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

/* ====== GRAPHS ====== */
let graphsInited = false;
let lastGraphMs = 0;

// get references to all graph divs
const trackGraphDiv      = document.getElementById("trackGraph");
const currentDistGraphDiv= document.getElementById("currentDistGraph");
const speedDistGraphDiv  = document.getElementById("speedDistGraph");
const accelSpeedGraphDiv = document.getElementById("accelSpeedGraph");

function ensureGraphs(){
  if (graphsInited) return;
  graphsInited = true;

  const baseLayout = {
    margin: { t: 30 },
    autosize: true,
    paper_bgcolor: "transparent",
    plot_bgcolor: "transparent",
      showlegend: false
  };

  Plotly.newPlot(speedGraphDiv, [{
    x: [], y: [], name: "Speed (km/h)", mode: "lines"
  }], { ...baseLayout, title: "Speed vs Time", xaxis:{title:"Time (s)"}, yaxis:{title:"km/h"} }, {responsive:true});

  Plotly.newPlot(currentGraphDiv, [{
    x: [], y: [], name: "Current (A)", mode: "lines"
  }], { ...baseLayout, title: "Current vs Time", xaxis:{title:"Time (s)"}, yaxis:{title:"A"} }, {responsive:true});

  Plotly.newPlot(powerGraphDiv, [{
    x: [], y: [], name: "Power (W)", mode: "lines"
  }], { ...baseLayout, title: "Power vs Time", xaxis:{title:"Time (s)"}, yaxis:{title:"W"} }, {responsive:true});

  Plotly.newPlot(trackGraphDiv, [{
    x: [], y: [], mode: "lines", line:{width:3}, name:"GPS Path"
  }], { ...baseLayout, title:"Track Visualization (Current Heatmap)", xaxis:{title:"Longitude"}, yaxis:{title:"Latitude"} }, {responsive:true});

  Plotly.newPlot(currentDistGraphDiv, [{
    x: [], y: [], mode: "lines", name: "Current (A)", line:{width:2}
  }], { ...baseLayout, title:"Current vs Distance", xaxis:{title:"Distance (km)"}, yaxis:{title:"Current (A)"} }, {responsive:true});

  Plotly.newPlot(speedDistGraphDiv, [{
    x: [], y: [], mode: "lines", name: "Speed (km/h)", line:{width:2}
  }], { ...baseLayout, title:"Speed vs Distance", xaxis:{title:"Distance (km)"}, yaxis:{title:"Speed (km/h)"} }, {responsive:true});

  Plotly.newPlot(accelSpeedGraphDiv, [{
    x: [], y: [], mode: "markers",
    marker:{size:6, color:[], colorscale:"Turbo", colorbar:{title:"Consumption"}}
  }], { ...baseLayout, title:"Acceleration vs Speed", xaxis:{title:"Acceleration (m/s²)"}, yaxis:{title:"Speed (km/h)"} }, {responsive:true});
}

function updateGraphs(){
  if (graphsView.style.display === "none") return;
  ensureGraphs();
  const now = performance.now();
  if (now - lastGraphMs < 500) return;
  lastGraphMs = now;

  const {t, speed, current, power} = state.series;
  const latest = t.length - 1;
  if (latest < 0) return;

  // compute derived quantities
  const dist = Math.max(0, state.distKmAbs - state.baseDistKm);
  const prevIndex = Math.max(0, latest - 1);
  const dt = t[latest] - t[prevIndex];
  const dv = speed[latest] - speed[prevIndex];
  const dE = state.energyWhAbs - state.baseEnergyWh;
  state.acceleration = dt > 0 ? (dv / dt) : 0;
  state.consumption  = dist > 0 ? (dE / dist) : 0;

  // extend base graphs
  Plotly.extendTraces(speedGraphDiv,   {x:[[t[latest]]], y:[[speed[latest]]]}, [0], 3000);
  Plotly.extendTraces(currentGraphDiv, {x:[[t[latest]]], y:[[current[latest]]]}, [0], 3000);
  Plotly.extendTraces(powerGraphDiv,   {x:[[t[latest]]], y:[[power[latest]]]}, [0], 3000);

  // analytics graphs
  Plotly.extendTraces(currentDistGraphDiv, {x:[[dist]], y:[[state.i]]}, [0], 3000);
  Plotly.extendTraces(speedDistGraphDiv,   {x:[[dist]], y:[[state.speed]]}, [0], 3000);
  Plotly.extendTraces(trackGraphDiv, {x:[[state.lon]], y:[[state.lat]]}, [0], 3000);
  Plotly.restyle(trackGraphDiv, {"line.color": [[`rgb(${Math.min(255, state.i*5)},0,200)`]]}, [0]);
  Plotly.extendTraces(accelSpeedGraphDiv,
    {x:[[state.acceleration]], y:[[state.speed]], "marker.color":[[state.consumption]]},
    [0], 1000);
}


/* ====== UI EVENTS ====== */
liveBtn?.addEventListener("click", () => {
  liveBtn.classList.add("active");
  graphsBtn.classList.remove("active");
  telemView.style.display = "";
  graphsView.style.display = "none";
});


resetDistanceBtn?.addEventListener("click", () => {
  state.baseDistKm = state.distKmAbs;
  state.baseEnergyWh = state.energyWhAbs;
  resetDistanceBtn.textContent = " Reset!";
  setTimeout(() => resetDistanceBtn.textContent = "Reset Distance", 1500);
});

// Start Session: Connect MQTT and start logging
startSessionBtn?.addEventListener("click", () => {
  // Connect MQTT if not connected
  if (!client || !client.connected) {
    mqttConnect();
    // Wait a moment for connection
    setTimeout(() => {
      if (client && client.connected) {
        // Start logging
        logging = true;
        logStartTime = performance.now();
        logData = [];
        startSessionBtn.disabled = true;
        endSessionBtn.disabled = false;
        alert("✅ Session started! MQTT connected and logging active.");
    } else {
        alert("❌ Failed to connect to MQTT. Please check your connection.");
      }
    }, 2000);
      } else {
    // Already connected, just start logging
    logging = true;
    logStartTime = performance.now();
    logData = [];
    startSessionBtn.disabled = true;
    endSessionBtn.disabled = false;
    alert("✅ Logging started!");
  }
});

// End Session: Stop logging and save file
endSessionBtn?.addEventListener("click", () => {
  if (!logging) {
    alert("⚠️ No active logging session.");
      return;
    }
    
  // Prompt for filename
  const defaultName = `telemetry_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)}`;
  const fileName = prompt("Enter filename to save (without .csv extension):", defaultName);
  
  if (!fileName || fileName.trim() === "") {
    alert("❌ Filename is required. Session not ended.");
    return; // User cancelled or entered empty name
  }
  
  const cleanFileName = fileName.trim().replace(/[^a-zA-Z0-9_-]/g, '_'); // Sanitize filename
  
  logging = false;
  startSessionBtn.disabled = false;
  endSessionBtn.disabled = true;

  const csv = toCSV(logData);
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `${cleanFileName}.csv`;
  a.click();
  URL.revokeObjectURL(url);

  alert(`📁 Session ended! Log saved as ${cleanFileName}.csv`);
});
graphsBtn.addEventListener("click", () => {
  graphsBtn.classList.add("active");
  liveBtn.classList.remove("active");
  telemView.style.display = "none";
  graphsView.style.display = "";
  ensureGraphs();
  requestFrame();
  // 👇 Important: trigger Plotly to recalc layout after becoming visible
  setTimeout(() => Plotly.Plots.resize(document.querySelector('#graphsView')), 300);
});


/* ====== CSV LOGGING ====== */
let logging = false;
let logData = [];
let logStartTime = 0;


function toCSV(dataArray) {
  if (!dataArray.length) return "";
  const headers = Object.keys(dataArray[0]).join(",");
  const rows = dataArray.map(obj => Object.values(obj).join(","));
  return [headers, ...rows].join("\n");
}

/* ====== AI CUE TESTING ====== */
// Test function to simulate AI cues and driver responses
function testAICue(cueName, simulateGoodResponse = true) {
  console.log(`🧪 Testing AI Cue: ${cueName}, Good Response: ${simulateGoodResponse}`);
  
  // Update cue display
  updateAICueDisplay(cueName);
  
  // Simulate telemetry based on cue and response quality
  const originalSpeed = state.speed;
  const originalPower = state.p;
  const originalCurrent = state.i;
  
  if (simulateGoodResponse) {
    // Simulate good driver response
    switch(cueName) {
      case 'throttle':
      case 'accelerate':
        state.p = 500;  // High power = accelerating
        state.i = 10;   // High current
        state.speed = Math.max(originalSpeed, 30); // Speed increasing
        break;
      case 'coast':
      case 'maintain':
        state.p = 20;   // Low power = coasting
        state.i = 0.05; // Low current
        state.speed = originalSpeed; // Maintaining speed
        break;
      case 'stop':
      case 'brake':
        state.p = 5;    // Very low power = stopping
        state.i = 0.01; // Minimal current
        state.speed = Math.max(0, originalSpeed - 5); // Speed decreasing
        break;
    }
    } else {
    // Simulate bad driver response (opposite of what cue suggests)
    switch(cueName) {
      case 'throttle':
      case 'accelerate':
        state.p = 10;   // Low power when should accelerate = BAD
        state.i = 0.1;
        state.speed = Math.max(0, originalSpeed - 2);
        break;
      case 'coast':
      case 'maintain':
        state.p = 800;  // High power when should coast = BAD
        state.i = 15;
        state.speed = originalSpeed + 10;
        break;
      case 'stop':
      case 'brake':
        state.p = 600;  // High power when should stop = BAD
        state.i = 12;
        state.speed = originalSpeed + 5;
        break;
    }
  }
  
  // Evaluate and update display
  state.aiCue = cueName;
  state.aiCueTime = performance.now();
  evaluateDriverResponse();
  
  // Restore original values after 3 seconds
  setTimeout(() => {
    state.p = originalPower;
    state.i = originalCurrent;
    state.speed = originalSpeed;
  }, 3000);
}

// Make test function available in browser console
window.testAICue = testAICue;

/* ====== BOOT ====== */
mqttConnect();
initMap();

// Initialize AI status display
if (aiStatusCircle) {
  aiStatusCircle.classList.add('neutral');
}
if (aiCueDisplay) {
  aiCueDisplay.textContent = '--';
}

// Add test instructions to console
console.log(`
╔══════════════════════════════════════════════════════════════╗
║  AI CUE SYSTEM - TESTING INSTRUCTIONS                       ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  To test AI cues in browser console, use:                    ║
║                                                              ║
║  testAICue('throttle', true)   - Good throttle response     ║
║  testAICue('coast', true)      - Good coast response        ║
║  testAICue('stop', true)       - Good stop response         ║
║  testAICue('throttle', false)  - Bad throttle response      ║
║  testAICue('coast', false)     - Bad coast response         ║
║  testAICue('stop', false)      - Bad stop response          ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`);
