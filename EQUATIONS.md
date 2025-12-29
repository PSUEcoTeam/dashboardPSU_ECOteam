# Energy and Efficiency Calculation Equations

## Energy Calculation

### Total Energy (Wh - Watt-hours)
```
Energy (Wh) = ∫ Power (W) × dt (hours)
```

**In code:**
```javascript
// Energy integration over time
dtH = dtMs / 3600000  // Convert milliseconds to hours
energyWhAbs += power × dtH
```

**Explanation:**
- Energy is the integral of power over time
- Each MQTT packet updates energy by: `power × time_difference_in_hours`
- This accumulates total energy used since start

---

## Efficiency Calculations

### Efficiency (km/kWh - kilometers per kilowatt-hour)
```
Efficiency (km/kWh) = Distance (km) / Energy (kWh)
```

**In code:**
```javascript
energyWhRel = energyWhAbs - baseEnergyWh  // Relative energy (since reset)
kWh = energyWhRel / 1000                  // Convert Wh to kWh
km_per_kWh = distKmRel / kWh              // Efficiency calculation
```

**Explanation:**
- Measures how far the vehicle travels per unit of energy
- Higher value = more efficient
- Uses relative distance and energy (since reset button was pressed)

---

### Consumption (Wh/km - Watt-hours per kilometer)
```
Consumption (Wh/km) = Energy (Wh) / Distance (km)
```

**In code:**
```javascript
Wh_per_km = energyWhRel / distKmRel
```

**Explanation:**
- Inverse of efficiency
- Measures energy consumed per kilometer traveled
- Lower value = more efficient

---

## Average Speed Calculation

### Exponential Weighted Moving Average (EWMA)
```
avgSpeed = 0.9 × previous_avgSpeed + 0.1 × current_speed
```

**In code:**
```javascript
state.avgSpeedKmh = (0.9 * state.avgSpeedKmh) + (0.1 * state.speed)
```

**Explanation:**
- Smooths out speed fluctuations
- 90% weight on previous average, 10% on new reading
- Provides stable average speed over time

---

## Sampling Rate

### UI Update Rate
```
PACKET_MIN_MS = 90ms
Max updates per second = 1000 / 90 = ~11.1 FPS
```

### Logging Rate
- **All MQTT packets are logged** (no throttling)
- If MQTT sends at 10 Hz (100ms intervals), you log 10 samples/second
- If MQTT sends at 20 Hz (50ms intervals), you log 20 samples/second
- **No limit on logging rate** - every valid packet is saved

**Note:** Only packets with voltage < 60V are logged (invalid readings are filtered out)

---

## Example Calculation

Given:
- Distance traveled: 1.5 km
- Total energy used: 500 Wh = 0.5 kWh

Efficiency:
```
Efficiency = 1.5 km / 0.5 kWh = 3.0 km/kWh
```

Consumption:
```
Consumption = 500 Wh / 1.5 km = 333.3 Wh/km
```

