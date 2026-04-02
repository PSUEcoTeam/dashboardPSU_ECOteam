<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=1a1a1a,e8630a,1a1a1a&height=200&section=header&text=PSU%20Eco%20Team%20Dashboard&fontSize=46&fontColor=ffffff&fontAlignY=38&desc=Real-Time%20Race%20Telemetry%20%26%20Driver%20Coaching%20Interface&descAlignY=58&descSize=17&animation=fadeIn" width="100%"/>

<br/>

<img src="https://readme-typing-svg.demolab.com?font=Fira+Code&weight=600&size=17&pause=1000&color=E8630A&center=true&vCenter=true&width=750&lines=Live+telemetry+streamed+via+MQTT;Speed+%7C+Power+%7C+Efficiency+%7C+GPS+%7C+Lap+Counter;AI+coaching+cues+integrated+from+ShellOffTrack;F1-style+paddock+%26+driver+display" alt="Typing SVG" />

<br/><br/>

![HTML](https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)
![CSS](https://img.shields.io/badge/CSS3-1572B6?style=for-the-badge&logo=css3&logoColor=white)
![Python](https://img.shields.io/badge/Python-3776AB?style=for-the-badge&logo=python&logoColor=white)
![MQTT](https://img.shields.io/badge/MQTT-HiveMQ-660066?style=for-the-badge&logo=mqtt&logoColor=white)

</div>

---

## Overview

The **PSU Eco Team Dashboard** is the race-day telemetry and coaching interface used by the team during Shell Eco-Marathon competition. It provides two simultaneous views:

- **Driver Display** — mounted in the cockpit, shows a single colour-coded coaching cue, current speed, efficiency, lap counter, and race timer
- **Paddock Dashboard** — used by the engineering team, shows full live telemetry, GPS track position, analytics graphs, and coaching state

Telemetry is streamed live from the vehicle via **MQTT** (HiveMQ Cloud). The dashboard also supports **CSV playback** for post-race analysis and offline review of recorded sessions.

---

## Dashboard Preview

<div align="center">
<table>
<tr>
<td align="center"><b>Live Telemetry View</b></td>
<td align="center"><b>Analytics View</b></td>
</tr>
<tr>
<td>Speed · Power · Voltage · Current · GPS · Efficiency</td>
<td>Plotly time-series graphs for post-lap analysis</td>
</tr>
</table>
</div>

---

## Features

<table>
<tr>
<td width="50%" valign="top">

### Live Race Monitoring
- Real-time MQTT telemetry stream (`car/telemetry`)
- Speed, voltage, current, power display
- Joulemeter-derived efficiency (km/kWh)
- Cumulative energy consumption (Wh)
- Lap counter + 35-minute race timer

</td>
<td width="50%" valign="top">

### AI Coaching Integration
- Subscribes to `car/cues` from [ShellOffTrack](https://github.com/PSUEcoTeam/ShellOffTrack)
- Colour-coded status indicator (green / red)
- Single context-aware cue displayed in real time
- Zone-aware feedback (STOP · TURN · STRAIGHT)

</td>
</tr>
<tr>
<td width="50%" valign="top">

### GPS & Track Mapping
- Live GPS position via Leaflet.js
- Track position updated every telemetry packet
- Visual lap progress on interactive map

</td>
<td width="50%" valign="top">

### Analytics & Replay
- Plotly.js time-series graphs (speed, power, efficiency)
- CSV playback at 100ms intervals
- Recorded sessions from 2025 race attempts included
- Telemetry logging endpoint (`/log_telemetry`)

</td>
</tr>
</table>

---

## Architecture

```
Vehicle (MQTT publish)
        │
        ▼  car/telemetry
  HiveMQ Cloud Broker
        │
        ├──► Driver Display (cockpit)     ← index.html, single cue + speed
        │
        └──► Paddock Dashboard (laptop)   ← index.html, full telemetry view
                    ▲
                    │  car/cues
             ShellOffTrack
             (coaching engine)
```

---

## MQTT Topics

| Topic | Direction | Content |
|-------|-----------|---------|
| `car/telemetry` | Subscribe | GPS, speed, voltage, current, power, energy |
| `car/cues` | Subscribe | Coaching cue from ShellOffTrack engine |
| `coach/status` | Subscribe | Coaching engine heartbeat / alive status |

---

## Telemetry Data Format

The dashboard expects the following fields from the MQTT `car/telemetry` topic (or CSV columns):

| Field | Source | Unit |
|-------|--------|------|
| `gps_speed` | GPS module | km/h |
| `jm3_voltage` | Joulemeter | V |
| `jm3_current` | Joulemeter | A |
| `gps_latitude` / `gps_longitude` | GPS module | degrees |
| `lap_lap` | Lap counter | — |
| `dist` | Odometer | m |
| `obc_timestamp` | On-board clock | s |

---

## Getting Started

### Prerequisites

```bash
python3 --version   # Python 3.x required
# No npm or build step needed — pure HTML/JS/CSS
```

### Run Locally

```bash
# Clone the repo
git clone https://github.com/PSUEcoTeam/dashboardPSU_ECOteam.git
cd dashboardPSU_ECOteam

# Start the server
python3 server.py
```

Then open **http://localhost:8000** in your browser.

### Live MQTT Mode

The dashboard connects to HiveMQ Cloud automatically on load. To use your own broker, update the MQTT config in `scripts.js`:

```js
const MQTT_HOST = 'wss://your-broker.hivemq.cloud:8884/mqtt'
const MQTT_USER = 'your_username'
const MQTT_PASS = 'your_password'
```

### CSV Replay Mode

To replay a recorded session, update the `csvPath` in `scripts.js`:

```js
const csvPath = '2025/attempt1/705 2025-02-10 09_59_50.csv'
```

---

## Project Structure

```
dashboardPSU_ECOteam/
├── index.html          # Main dashboard — driver display + paddock view
├── style.css           # F1-style dark theme (black & orange)
├── scripts.js          # MQTT client, telemetry processing, Plotly graphs
├── server.py           # Python HTTP server with CSV + telemetry logging endpoints
├── shellLogo.png       # Team logo
├── EQUATIONS.md        # Efficiency & energy calculation reference
└── 2025/               # Recorded telemetry sessions
    ├── attempt1/       # Race attempt 1 — Qatar SEM 2025
    ├── attempt2/       # Race attempt 2
    └── practice1/      # Practice session data
```

---

## Related Projects

| Repo | Description |
|------|-------------|
| [ShellOffTrack](https://github.com/PSUEcoTeam/ShellOffTrack) | Real-time coaching engine — publishes cues consumed by this dashboard |
| [PSUEcoTeam](https://github.com/PSUEcoTeam/PSUEcoTeam) | Team profile & overview |

---

<div align="center">

**[PSU Eco Team](https://github.com/PSUEcoTeam)** · Prince Sultan University · Riyadh, Saudi Arabia

[![GitHub](https://img.shields.io/badge/GitHub-PSUEcoTeam-181717?style=flat-square&logo=github)](https://github.com/PSUEcoTeam)
[![Instagram](https://img.shields.io/badge/Instagram-@psueteam-E4405F?style=flat-square&logo=instagram)](https://www.instagram.com/psueteam/)
[![Email](https://img.shields.io/badge/Email-visionteam@psu.edu.sa-0f3460?style=flat-square&logo=gmail&logoColor=white)](mailto:visionteam@psu.edu.sa)

<img src="https://capsule-render.vercel.app/api?type=waving&color=1a1a1a,e8630a,1a1a1a&height=100&section=footer" width="100%"/>

</div>
