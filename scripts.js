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
const PACKET_MIN_MS = 50;    // UI throttle (≤ 20 FPS) - faster updates for real-time feel

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
  driverResponseGood: null,
  // Packet rate tracking
  packetCount: 0,
  packetRateStartTime: null,
  lastPacketRateLog: 0
};
function clampLen(arr, max) {
  if (arr.length > max) arr.splice(0, arr.length - max);
}
/* ====== MAP SETUP (Leaflet) ====== */
let map, marker;

function initMap() {
  const mapElement = document.getElementById('map');
  if (!mapElement) {
    console.error("❌ Map element 'map' not found in HTML!");
    return;
  }
  
  // Start with a default location (will be updated by browser geolocation)
  const defaultPos = [24.7136, 46.6753]; // Default fallback location
  const defaultZoom = 13;

  try {
    map = L.map('map').setView(defaultPos, defaultZoom);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    // Create a visible red marker (will be positioned by browser geolocation)
    marker = L.marker(defaultPos, {
      icon: L.icon({
        iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-red.png',
        shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
        iconSize: [25, 41],
        iconAnchor: [12, 41],
        popupAnchor: [1, -34],
        shadowSize: [41, 41]
      })
    }).addTo(map);
    
    // Track if we've received GPS data from MQTT yet
    map.hasInitialGPS = false;
    
    // Get browser's current location for initial pin
    if (navigator.geolocation) {
      console.log("📍 Requesting browser location for initial pin...");
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const browserLat = position.coords.latitude;
          const browserLon = position.coords.longitude;
          const browserPos = [browserLat, browserLon];
          
          // Update map and marker to browser's location
          map.setView(browserPos, 16);
          marker.setLatLng(browserPos);
          marker.bindPopup("📍 Your Current Location<br>Waiting for GPS data from MQTT...").openPopup();
          
          console.log(`📍 Browser location received: ${browserLat.toFixed(6)}, ${browserLon.toFixed(6)}`);
          console.log("🗺️ Map centered on your location - will update from MQTT GPS data");
        },
        (error) => {
          console.warn("⚠️ Browser geolocation error:", error.message);
          console.log("📍 Using default location - will update from MQTT GPS data");
          marker.bindPopup("📍 Default Location<br>Waiting for GPS data from MQTT...").openPopup();
        },
        {
          enableHighAccuracy: true,
          timeout: 5000,
          maximumAge: 0
        }
      );
    } else {
      console.warn("⚠️ Browser geolocation not supported");
      marker.bindPopup("📍 Default Location<br>Waiting for GPS data from MQTT...").openPopup();
    }
    
    console.log("🗺️ Map initialized - waiting for browser location, then MQTT GPS updates");
  } catch (error) {
    console.error("❌ Error initializing map:", error);
  }
}


/* ====== MQTT ====== */
let client;
function mqttConnect() {
  // Disconnect existing client if any
  if (client) {
    client.end();
    client = null;
  }
  
  client = mqtt.connect(MQTT_URL, {
    username: MQTT_USER,
    password: MQTT_PASS,
    clean: true,  // Start with clean session (no old messages)
    reconnectPeriod: 2000,
    clientId: 'jm_dashboard_' + Math.random().toString(16).substr(2, 8) // Unique client ID
  });

  client.on("connect", () => {
    console.log("✅ Connected to HiveMQ Cloud");
    // Subscribe with qos 0 and no retained messages
    client.subscribe(TOPIC, { qos: 0 }, (err) => {
      if (err) {
        console.error("Subscribe error:", err);
      } else {
        console.log(`📡 Subscribed to topic: ${TOPIC}`);
        console.log("⏳ Waiting for new MQTT messages...");
      }
    });
  });

  client.on("message", (topic, payload, packet) => {
    if (topic !== TOPIC) return;
    
    // Log received message info
    console.log(`📨 Received MQTT message on ${topic}:`, {
      retained: packet.retain,
      qos: packet.qos,
      payloadLength: payload.length,
      timestamp: new Date().toISOString()
    });
    
    // IGNORE RETAINED MESSAGES - only process new messages
    if (packet.retain) {
      console.log("⚠️ Ignoring RETAINED message (old/cached data)");
      return;
    }
    
    let data;
    try { 
      data = JSON.parse(payload.toString());
      console.log("📊 Parsed NEW data:", data);
    }
    catch(e){ 
      console.error("❌ Bad packet JSON:", e, "Raw:", payload.toString());
      return; 
    }
    
    ingestTelemetry(data);
  });

  client.on("error", (err) => {
    console.error("❌ MQTT error:", err);
  });
  
  client.on("offline", () => {
    console.log("⚠️ MQTT client went offline");
  });
}

/* ====== MAP GPS UPDATE ====== */
function updateMapFromGPS(lat, lon) {
  // Check for valid GPS coordinates (not zero, and within reasonable bounds)
  const isValidGPS = lat !== 0 && lon !== 0 && 
                     Math.abs(lat) <= 90 && Math.abs(lon) <= 180 &&
                     !isNaN(lat) && !isNaN(lon);
  
  if (!map || !marker) {
    if (isValidGPS) {
      console.warn("⚠️ Map or marker not initialized - cannot update GPS");
    }
    return;
  }
  
  if (isValidGPS) {
    const pos = [lat, lon];
    
    // Log GPS updates for debugging
    console.log(`📍 GPS received: lat=${lat.toFixed(6)}, lon=${lon.toFixed(6)}`);
    
    // Only pan/zoom on first valid GPS reading, then just update marker position
    if (!map.hasInitialGPS) {
      map.setView(pos, 16); // Zoom in on first GPS reading
      map.hasInitialGPS = true;
      marker.closePopup(); // Close the initial browser location popup
      console.log(`🗺️ Map now tracking MQTT GPS: ${lat.toFixed(6)}, ${lon.toFixed(6)}`);
    }
    
    // Always update marker position immediately (even if map hasn't panned)
    try {
      marker.setLatLng(pos);
      
      // Smoothly pan to new location if it's moved significantly
      const currentCenter = map.getCenter();
      const distance = map.distance(currentCenter, pos);
      if (distance > 50) { // Only pan if moved more than 50 meters
        map.panTo(pos, { animate: true, duration: 0.5 });
      }
    } catch (error) {
      console.error("❌ Error updating marker:", error);
    }
  } else if (lat !== 0 || lon !== 0) {
    // Only warn if we have non-zero but invalid coordinates
    console.warn(`⚠️ Invalid GPS coordinates: lat=${lat}, lon=${lon}`);
  }
}

/* ====== INGEST TELEMETRY ====== */
function num(x){ const v = Number(x); return Number.isFinite(v) ? v : 0; }

function ingestTelemetry(d) {
  const now = performance.now();
  
  // --- VOLTAGE FILTER: Reject packets with voltage >= 60V ---
  const voltage = num(d.voltage);
  if (voltage >= 60) {
    return; // Ignore this packet completely - don't process, don't log, don't display
  }
  
  // Initialize timing on first valid packet
  if (state.t0 === null) {
    state.t0 = now;
    state.packetRateStartTime = now;
    state.lastPacketRateLog = now;
    console.log("🎬 First MQTT packet received - starting data collection");
  }
  
  // --- Packet rate tracking ---
  state.packetCount++;
  
  // Log packet rate every 5 seconds
  if (now - state.lastPacketRateLog > 5000) {
    const elapsed = (now - state.packetRateStartTime) / 1000; // seconds
    const rate = state.packetCount / elapsed;
    console.log(`📊 Packet rate: ${rate.toFixed(1)} packets/second (${state.packetCount} total packets, ${logData.length} logged)`);
    state.lastPacketRateLog = now;
  }
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
  // Parse GPS coordinates - support multiple field name variants
  state.lon = num(d.longitude || d.lon || d.lng || d.gps_longitude);
  state.lat = num(d.latitude || d.lat || d.gps_latitude);
  
  // Update map immediately when valid GPS coordinates are received
  updateMapFromGPS(state.lat, state.lon);
  
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
  // IMPORTANT: Log EVERY packet, no throttling for logging
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
let rafPending = false, lastPaintMs = 0, needsUpdate = false;
function requestFrame(){
  needsUpdate = true; // Mark that we have new data to display
  if (rafPending) return; // Already have a frame scheduled
  rafPending = true;
  requestAnimationFrame(paint);
}
function paint(){
  rafPending = false;
  const now = performance.now();
  
  // Throttle painting, but always paint the latest state when we do paint
  if (now - lastPaintMs < PACKET_MIN_MS) {
    // Too soon to paint, but schedule another paint if we have updates
    if (needsUpdate) {
      rafPending = true;
      requestAnimationFrame(paint);
    }
    return;
  }
  
  lastPaintMs = now;
  needsUpdate = false; // We're painting now, clear the flag

  // Only update display if we have received real MQTT data (t0 is set)
  // This prevents showing dummy/initialized values on page load
  // t0 is only set when first MQTT packet is received in ingestTelemetry()
  if (state.t0 === null || !state.t0) {
    // No MQTT data received yet - do not update display
    // Keep showing initial zeros from HTML/initializeDisplay()
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


function toCSV(dataArray) {
  if (!dataArray.length) return "";
  const headers = Object.keys(dataArray[0]).join(",");
  const rows = dataArray.map(obj => Object.values(obj).join(","));
  return [headers, ...rows].join("\n");
}


/* ====== BOOT ====== */
// Initialize display to zeros (will only update when real MQTT data arrives)
function initializeDisplay() {
  if (mainSpdEl) mainSpdEl.textContent = '0';
  if (mainEffEl) mainEffEl.textContent = '0';
  if (mainTimerEl) mainTimerEl.textContent = '00:00';
  if (avgSpeedEl) avgSpeedEl.textContent = '0';
  if (remainingEl) remainingEl.textContent = '35:00';
  if (distanceEl) distanceEl.textContent = '0';
  if (consumptionEl) consumptionEl.textContent = '0';
  if (voltageEl) voltageEl.textContent = '0';
  if (currentEl) currentEl.textContent = '0';
  if (powerEl) powerEl.textContent = '0';
  if (totalEnergyEl) totalEnergyEl.textContent = '0';
  if (rpmEl) rpmEl.textContent = '0';
  if (efficiencyEl) efficiencyEl.textContent = '0';
  if (gpsLonEl) gpsLonEl.textContent = '0.000000';
  if (gpsLatEl) gpsLatEl.textContent = '0.000000';
  if (lapCounterEl) lapCounterEl.textContent = '0/4';
}

initializeDisplay();

mqttConnect();
initMap();

// Initialize AI status display
if (aiStatusCircle) {
  aiStatusCircle.classList.add('neutral');
}
if (aiCueDisplay) {
  aiCueDisplay.textContent = '--';
}
