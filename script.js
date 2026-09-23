/* ==========================================================================
   GRIDLOCK — Urban Traffic Systems Console
   A coupled-network traffic simulation. Every intervention propagates.
   ========================================================================== */
'use strict';

/* ============================== 1. CONSTANTS ============================== */

const CFG = {
  startBudget: 100000,
  satFlow: 0.55,          // vehicles / second / lane at saturation
  minGap: 3,
  followK: 2.4,
  decel: 60,
  accelResponse: 2.6,
  carLen: 11,
  busLen: 17,
  evLen: 14,
  maxCars: 900,
  abandonWait: 135,
  evAbandonWait: 260,
  pendingTimeout: 26,
  roadOffset: 5,
  laneWidth: 5.4,        // world units per traffic lane, used for drawing and storage
  congestionWeight: 1.8,
  rerouteWeight: 3.8,
  clockRate: 24,          // simulated clock minutes per simulated second
  platoonSpeed: 62,   // observed free-flow running speed, sets green-wave offsets
  costs: { signal: 900, lanes: 6000, closure: 7500, bus: 4500, corridor: 6000, sync: 8000, redirect: 3500 }
};

const REF_TRAVEL_TIME = 50;     // seconds, well-coordinated network trip
const REF_WAIT = 9;             // seconds, nominal junction wait

/* ============================== 2. UTILITIES ============================== */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const sum = a => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function offsetPolyline(pts, off) {
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    let nx = 0, ny = 0;
    if (i > 0) {
      const dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y;
      const l = Math.hypot(dx, dy) || 1; nx += -dy / l; ny += dx / l;
    }
    if (i < n - 1) {
      const dx = pts[i + 1].x - pts[i].x, dy = pts[i + 1].y - pts[i].y;
      const l = Math.hypot(dx, dy) || 1; nx += -dy / l; ny += dx / l;
    }
    const l = Math.hypot(nx, ny) || 1;
    out.push({ x: pts[i].x + (nx / l) * off, y: pts[i].y + (ny / l) * off });
  }
  return out;
}

function mixRGB(a, b, t) {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
}
const rgb = c => `rgb(${c[0]},${c[1]},${c[2]})`;

const CONGESTION_STOPS = [
  [0.00, [40, 46, 54]],
  [0.28, [58, 108, 104]],
  [0.52, [138, 122, 60]],
  [0.74, [168, 100, 47]],
  [0.92, [170, 66, 58]],
  [1.00, [190, 54, 48]]
];
function congestionRGB(s) {
  s = clamp01(s);
  for (let i = 1; i < CONGESTION_STOPS.length; i++) {
    if (s <= CONGESTION_STOPS[i][0]) {
      const [p0, c0] = CONGESTION_STOPS[i - 1], [p1, c1] = CONGESTION_STOPS[i];
      return mixRGB(c0, c1, (s - p0) / Math.max(1e-6, p1 - p0));
    }
  }
  return CONGESTION_STOPS[CONGESTION_STOPS.length - 1][1];
}

function formatClock(startMinutes, simSeconds, rate) {
  const total = Math.floor(startMinutes + (simSeconds * rate) / 60) % 1440;
  const h = Math.floor(total / 60), m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
const pctStr = v => (v >= 0 ? '+' : '') + Math.round(v) + '%';

/* ============================== 3. NETWORK DATA ============================ */

const NODE_DEFS = [
  { id: 0, name: 'Westfield', r: 0, c: 0, x: 180, y: 170, district: 'NORTH RIDGE' },
  { id: 1, name: 'Alder Square', r: 0, c: 1, x: 460, y: 170, district: 'NORTH RIDGE' },
  { id: 2, name: 'Birchfield', r: 0, c: 2, x: 740, y: 170, district: 'NORTH RIDGE' },
  { id: 3, name: 'Harbor Point', r: 0, c: 3, x: 1010, y: 170, district: 'HARBOR' },
  { id: 4, name: 'Westgate', r: 1, c: 0, x: 180, y: 400, district: 'CENTRAL DISTRICT' },
  { id: 5, name: 'Central Junction', r: 1, c: 1, x: 460, y: 400, district: 'CENTRAL DISTRICT' },
  { id: 6, name: 'Kingsway', r: 1, c: 2, x: 740, y: 400, district: 'CENTRAL DISTRICT' },
  { id: 7, name: 'Dockside', r: 1, c: 3, x: 1010, y: 400, district: 'HARBOR' },
  { id: 8, name: 'Southgate', r: 2, c: 0, x: 180, y: 630, district: 'SOUTH WORKS' },
  { id: 9, name: 'Foundry', r: 2, c: 1, x: 460, y: 630, district: 'SOUTH WORKS' },
  { id: 10, name: 'Riverside', r: 2, c: 2, x: 740, y: 630, district: 'SOUTH WORKS' },
  { id: 11, name: 'Eastfield', r: 2, c: 3, x: 1010, y: 630, district: 'SOUTH WORKS' }
];

const LINK_DEFS = [
  { a: 0, b: 1, name: 'North Avenue', lanes: 1, speed: 58, cls: 'LOCAL ROAD' },
  { a: 1, b: 2, name: 'Alder Street', lanes: 1, speed: 55, cls: 'LOCAL ROAD' },
  { a: 2, b: 3, name: 'Harbor Way', lanes: 1, speed: 58, cls: 'LOCAL ROAD' },
  { a: 4, b: 5, name: 'Westfield Road', lanes: 2, speed: 62, cls: 'ARTERIAL' },
  { a: 5, b: 6, name: 'Central Boulevard', lanes: 2, speed: 66, cls: 'PRIMARY ARTERIAL' },
  { a: 6, b: 7, name: 'Dockside Drive', lanes: 2, speed: 62, cls: 'ARTERIAL' },
  { a: 8, b: 9, name: 'Foundry Lane', lanes: 1, speed: 55, cls: 'LOCAL ROAD' },
  { a: 9, b: 10, name: 'Riverside Road', lanes: 1, speed: 55, cls: 'LOCAL ROAD' },
  { a: 10, b: 11, name: 'Eastfield Avenue', lanes: 1, speed: 55, cls: 'LOCAL ROAD' },
  { a: 0, b: 4, name: 'West Gate Approach', lanes: 1, speed: 55, cls: 'LOCAL ROAD' },
  { a: 4, b: 8, name: 'Southgate Link', lanes: 1, speed: 55, cls: 'LOCAL ROAD' },
  { a: 1, b: 5, name: 'Alder Approach', lanes: 2, speed: 60, cls: 'ARTERIAL' },
  { a: 5, b: 9, name: 'Foundry Link', lanes: 2, speed: 60, cls: 'ARTERIAL' },
  { a: 2, b: 6, name: 'Birchfield Approach', lanes: 1, speed: 55, cls: 'LOCAL ROAD' },
  { a: 6, b: 10, name: 'Riverside Link', lanes: 1, speed: 55, cls: 'LOCAL ROAD' },
  { a: 3, b: 7, name: 'Harbor Approach', lanes: 1, speed: 55, cls: 'LOCAL ROAD' },
  { a: 7, b: 11, name: 'Dockside Link', lanes: 2, speed: 60, cls: 'ARTERIAL' },
  { a: 0, b: 8, name: 'West Ring', lanes: 2, speed: 82, via: [[52, 400]], cls: 'RING BYPASS', ring: true },
  { a: 3, b: 11, name: 'East Ring', lanes: 2, speed: 82, via: [[1148, 400]], cls: 'RING BYPASS', ring: true }
];

/* external connections */
const GATE_DEFS = [
  { node: 0, code: 'NW', dir: 'WEST-NORTH' },
  { node: 1, code: 'N', dir: 'NORTH' },
  { node: 3, code: 'NE', dir: 'NORTH-EAST' },
  { node: 4, code: 'W', dir: 'WEST' },
  { node: 7, code: 'E', dir: 'EAST' },
  { node: 8, code: 'SW', dir: 'SOUTH-WEST' },
  { node: 10, code: 'S', dir: 'SOUTH' },
  { node: 11, code: 'SE', dir: 'SOUTH-EAST' }
];

const BUS_ROUTES = [
  [0, 1, 5, 6, 7, 3],
  [8, 9, 5, 6, 2],
  [11, 7, 6, 10, 9]
];

/* ============================== 4. DEMAND PROFILES ======================== */

const PROFILE_MORNING = {
  origins: { 0: 1.6, 1: 1.9, 3: 0.5, 4: 1.5, 7: 0.5, 8: 1.2, 10: 1.3, 11: 0.6, 9: 0.5 },
  dests: { 5: 2.5, 6: 1.9, 2: 1.2, 7: 1.7, 11: 1.0, 3: 0.8, 10: 0.6, 9: 0.8, 4: 0.5, 8: 0.4, 0: 0.3, 1: 0.3 }
};
const PROFILE_MIDDAY = {
  origins: { 0: 1.0, 1: 0.9, 3: 0.9, 4: 1.1, 7: 0.9, 8: 1.0, 10: 1.0, 11: 0.9, 5: 0.8, 6: 0.6, 9: 0.5 },
  dests: { 0: 0.9, 1: 0.9, 2: 0.9, 3: 0.9, 4: 1.0, 5: 1.5, 6: 1.3, 7: 1.0, 8: 0.9, 9: 0.8, 10: 0.9, 11: 0.9 }
};
const PROFILE_EVENING = {
  origins: { 5: 2.3, 6: 1.8, 2: 1.0, 9: 0.9, 0: 0.5, 1: 0.5, 4: 0.5, 7: 0.6, 8: 0.4, 10: 0.4, 11: 0.4, 3: 0.4 },
  dests: { 0: 1.6, 1: 1.8, 4: 1.4, 8: 1.3, 10: 1.2, 3: 0.6, 11: 0.6, 7: 0.5, 9: 0.5, 2: 0.4, 5: 0.4, 6: 0.4 }
};
const PROFILE_EVENT = {
  origins: { 3: 2.7, 7: 1.3, 2: 1.0, 0: 0.7, 1: 0.7, 4: 0.8, 8: 0.7, 10: 0.7, 11: 0.8, 5: 0.6 },
  dests: { 3: 3.2, 7: 1.5, 2: 1.1, 6: 0.9, 5: 0.8, 0: 0.6, 1: 0.6, 4: 0.7, 8: 0.6, 10: 0.6, 11: 0.7, 9: 0.6 }
};
const PROFILE_NIGHT = {
  origins: { 0: 0.7, 1: 0.7, 3: 0.7, 4: 0.7, 7: 0.7, 8: 0.7, 10: 0.7, 11: 0.7 },
  dests: { 0: 0.7, 1: 0.7, 3: 0.7, 4: 0.7, 5: 1.1, 6: 0.9, 7: 0.7, 8: 0.7, 9: 0.7, 10: 0.7, 11: 0.7, 2: 0.7 }
};

/* ============================== 5. SCENARIOS ============================== */

const SCENARIOS = [
  {
    id: 'morning',
    num: '01',
    name: 'MORNING RUSH',
    blurb: 'Commuter demand rises sharply from the residential north and west. A school surge lands on Alder Square while a collision closes a lane on North Avenue.',
    meta: { duration: '7 min', junctions: '12', events: '9' },
    duration: 420,
    startClock: 7 * 60,
    seed: 20260921,
    baseDemand: 3.1,
    init: { signals: { 4: { ns: 30, ew: 10 }, 5: { ns: 34, ew: 10 }, 6: { ns: 34, ew: 10 }, 7: { ns: 30, ew: 10 } } },
    phases: [
      { until: 90, name: 'EARLY PEAK', demand: 2.5, profile: PROFILE_MORNING },
      { until: 260, name: 'MORNING PEAK', demand: 3.25, profile: PROFILE_MORNING },
      { until: 340, name: 'SCHOOL SURGE', demand: 3.5, profile: PROFILE_MORNING },
      { until: 420, name: 'MIDDAY SETTLE', demand: 2.1, profile: PROFILE_MIDDAY }
    ],
    events: [
      { t: 34, kind: 'surge', node: 1, mult: 1.5, duration: 110, title: 'TRAFFIC SURGE DETECTED', body: 'Alder Square inbound demand up 50% — school run convergence.' },
      { t: 96, kind: 'accident', link: 'North Avenue', severity: 0.7, duration: 130, title: 'ACCIDENT — NORTH AVENUE', body: 'Two-vehicle collision. Single lane usable, speed limit reduced.' },
      { t: 150, kind: 'transit', duration: 120, rate: 0.28, title: 'PUBLIC TRANSPORT SURGE', body: 'Additional bus frequency dispatched on all transit corridors.' },
      { t: 205, kind: 'rain', duration: 130, title: 'HEAVY RAIN — NETWORK WIDE', body: 'Advisory speeds reduced 28%. Junction capacity derated 15%.' },
      { t: 198, kind: 'emergency', from: 8, to: 3, title: 'EMERGENCY VEHICLE APPROACHING', body: 'Ambulance from Southgate to Harbor Point. Corridor authorisation available.' },
      { t: 316, kind: 'accident', link: 'Dockside Drive', severity: 0.55, duration: 100, title: 'ACCIDENT — DOCKSIDE DRIVE', body: 'Rear-end collision blocking the outer lane.' },
      { t: 352, kind: 'spike', mult: 1.35, duration: 60, title: 'SUDDEN TRAFFIC SPIKE', body: 'Unmodelled demand injection across the network.' },
      { t: 386, kind: 'outage', nodes: [5, 6], duration: 70, title: 'SIGNAL POWER OUTAGE — CENTRAL', body: 'Central Junction and Kingsway on all-way flash. Junction throughput derated 60%.' },
      { t: 405, kind: 'transit', duration: 40, rate: 0.34, title: 'TRANSIT BUNCHING', body: 'Bus headways collapsed on Central Boulevard.' }
    ],
    /* Measured from the simulation with no interventions at all, on this seed.
       The demand stream is independent of player actions, so this is an exact
       counterfactual rather than an estimate — the objective targets below are
       set as a real improvement on it, and the suite asserts it still
       reproduces so the comparison can never silently drift. */
    baseline: { avgWait: 47.4, avgCong: 30.8, servedRatio: 49.4, emergency: 8.0, composite: 51.1 },
    objectives: [
      { key: 'avgWait', dir: 'below', target: 40, unit: 's', label: 'Mean junction wait under 40s' },
      { key: 'servedRatio', dir: 'above', target: 56, unit: '%', label: 'Serve 56% of trip demand' },
      { key: 'emergency', dir: 'above', target: 60, unit: '', label: 'Emergency response above 60' }
    ]
  },
  {
    id: 'event',
    num: '02',
    name: 'MAJOR EVENT',
    blurb: 'A stadium fixture at Harbor Point injects thousands of vehicles into the north-east quarter. Construction has already closed a lane on Dockside Drive before you arrive.',
    meta: { duration: '6.5 min', junctions: '12', events: '8' },
    duration: 390,
    startClock: 16 * 60 + 30,
    seed: 771102,
    baseDemand: 3.0,
    init: {
      incident: { link: 'Dockside Drive', severity: 0.45, duration: 240 },
      signals: { 1: { ns: 30, ew: 30 }, 2: { ns: 34, ew: 34 }, 3: { ns: 34, ew: 34 }, 6: { ns: 34, ew: 34 }, 7: { ns: 34, ew: 34 } }
    },
    phases: [
      { until: 100, name: 'ARRIVAL BUILD', demand: 2.35, profile: PROFILE_EVENT },
      { until: 250, name: 'EVENT PEAK', demand: 3.1, profile: PROFILE_EVENT },
      { until: 320, name: 'EGRESS WAVE', demand: 3.4, profile: PROFILE_EVENT },
      { until: 390, name: 'CLEARANCE', demand: 2.0, profile: PROFILE_EVENING }
    ],
    events: [
      { t: 18, kind: 'stadium', node: 3, rate: 1.25, destBias: 3, duration: 165, title: 'STADIUM EVENT — HARBOR POINT', body: 'Fixture underway. +2400 vehicles forecast into the Harbor district.' },
      { t: 78, kind: 'surge', node: 7, mult: 1.4, duration: 130, title: 'DISTRICT SATURATION — DOCKSIDE', body: 'Event parking overflow redirecting onto Dockside Drive.' },
      { t: 132, kind: 'emergency', from: 8, to: 3, title: 'EMERGENCY VEHICLE APPROACHING', body: 'Medical response to Harbor Point. Corridor authorisation available.' },
      { t: 175, kind: 'transit', duration: 140, rate: 0.3, title: 'EVENT TRANSIT SURGE', body: 'Shuttle services added on Harbor Way and Dockside Drive.' },
      { t: 205, kind: 'egress', node: 3, rate: 1.35, originBias: 3, duration: 115, title: 'EGRESS WAVE — HARBOR POINT', body: 'Fixture ended. Bulk egress onto the north-east corridor.' },
      { t: 292, kind: 'accident', link: 'Harbor Approach', severity: 0.8, duration: 95, title: 'ACCIDENT — HARBOR APPROACH', body: 'Pedestrian-vehicle incident at the junction mouth.' },
      { t: 330, kind: 'spike', mult: 1.3, duration: 55, title: 'SUDDEN TRAFFIC SPIKE', body: 'Unmodelled demand injection across the network.' },
      { t: 356, kind: 'rain', duration: 70, title: 'HEAVY RAIN — NETWORK WIDE', body: 'Advisory speeds reduced 28%. Junction capacity derated 15%.' }
    ],
    baseline: { avgWait: 39.0, avgCong: 36.2, servedRatio: 53.3, emergency: 8.0, composite: 52.7 },
    /* This shift is the hardest of the three: the stadium surge is not
       suppressible, only absorbable, so the bar is set to what a diligent
       engineer actually reaches here rather than a round number. */
    objectives: [
      { key: 'emergency', dir: 'above', target: 55, unit: '', label: 'Emergency response above 55' },
      { key: 'stability', dir: 'above', target: 63, unit: '', label: 'System stability above 63' },
      { key: 'servedRatio', dir: 'above', target: 57, unit: '%', label: 'Serve 57% of trip demand' }
    ]
  },
  {
    id: 'emergency',
    num: '03',
    name: 'CRITICAL INCIDENT',
    blurb: 'A multi-vehicle collision has shut Central Boulevard outright. A second response vehicle must cross the city, and a substation fault is about to take two junctions offline.',
    meta: { duration: '6 min', junctions: '12', events: '8' },
    duration: 360,
    startClock: 8 * 60 + 15,
    seed: 5150,
    baseDemand: 3.2,
    init: {
      closure: { link: 'Central Boulevard', reason: 'COLLISION — ROAD CLOSED' },
      signals: { 4: { ns: 34, ew: 10 }, 5: { ns: 34, ew: 10 }, 6: { ns: 34, ew: 10 }, 8: { ns: 30, ew: 10 }, 9: { ns: 30, ew: 10 } }
    },
    phases: [
      { until: 80, name: 'INCIDENT RESPONSE', demand: 2.35, profile: PROFILE_MORNING },
      { until: 240, name: 'PEAK LOAD', demand: 3.0, profile: PROFILE_MORNING },
      { until: 360, name: 'RECOVERY', demand: 2.1, profile: PROFILE_MIDDAY }
    ],
    events: [
      { t: 12, kind: 'emergency', from: 0, to: 11, title: 'EMERGENCY VEHICLE APPROACHING', body: 'Fire appliance must cross the full network. Corridor authorisation required.' },
      { t: 62, kind: 'surge', node: 6, mult: 1.45, duration: 150, title: 'DIVERSION LOADING — KINGSWAY', body: 'Central Boulevard closure pushing volume onto parallel corridors.' },
      { t: 104, kind: 'accident', link: 'Foundry Link', severity: 0.6, duration: 120, title: 'ACCIDENT — FOUNDRY LINK', body: 'Secondary collision in the diversion corridor.' },
      { t: 150, kind: 'outage', nodes: [5, 9], duration: 95, title: 'SUBSTATION FAULT — SIGNAL LOSS', body: 'Central Junction and Foundry on all-way flash.' },
      { t: 188, kind: 'emergency', from: 10, to: 4, title: 'EMERGENCY VEHICLE APPROACHING', body: 'Second response vehicle dispatched westbound.' },
      { t: 232, kind: 'rain', duration: 100, title: 'HEAVY RAIN — NETWORK WIDE', body: 'Advisory speeds reduced 28%. Junction capacity derated 15%.' },
      { t: 282, kind: 'transit', duration: 70, rate: 0.3, title: 'PUBLIC TRANSPORT SURGE', body: 'Rail replacement buses dispatched after a signalling failure.' },
      { t: 322, kind: 'spike', mult: 1.3, duration: 38, title: 'SUDDEN TRAFFIC SPIKE', body: 'Unmodelled demand injection across the network.' }
    ],
    /* This shift already opens with a road shut, so its inherited reference is
       the strongest of the three — the bar has to clear that, not just beat it. */
    baseline: { avgWait: 37.8, avgCong: 25.2, servedRatio: 63.2, emergency: 78.1, composite: 69.6 },
    objectives: [
      { key: 'servedRatio', dir: 'above', target: 66, unit: '%', label: 'Serve 66% of trip demand' },
      { key: 'emergency', dir: 'above', target: 88, unit: '', label: 'Emergency response above 88' },
      { key: 'stability', dir: 'above', target: 78, unit: '', label: 'System stability above 78' }
    ]
  }
];

/* ============================== 6. GEOMETRY / ENTITIES ==================== */

class Intersection {
  constructor(def) {
    this.id = def.id; this.name = def.name;
    this.x = def.x; this.y = def.y;
    this.r = def.r; this.c = def.c;
    this.district = def.district || 'CENTRAL DISTRICT';
    this.incoming = []; this.outgoing = [];
    this.nsGreen = 20; this.ewGreen = 20; this.yellow = 3; this.allRed = 1;
    this.offset = 0;
    this.busPriority = false;
    this.outage = false; this.outageUntil = 0;
    this.preemptAxis = null; this.preemptUntil = -1;
    this.syncAxis = null;
    this.queue = 0; this.waitEma = 0;
    /* rolling 30-second window of measured junction waits */
    this.wsum = new Float32Array(30); this.wcnt = new Float32Array(30);
    this.wmark = new Int32Array(30).fill(-1);
    this.congestion = 0; this.volume = 0; this.inflow = 0; this.outflow = 0;
    this.flow = new Float32Array(60); this.flowMark = new Int32Array(60).fill(-1);
    this.inFlow = new Float32Array(60); this.inMark = new Int32Array(60).fill(-1);
    this.outFlow = new Float32Array(60); this.outMark = new Int32Array(60).fill(-1);
    this.gate = null;
    this.incidents = [];
  }
  get cycle() { return this.nsGreen + this.ewGreen + 2 * (this.yellow + this.allRed); }

  phaseAt(t) {
    if (this.outage) return { axis: null, state: 'flash', remaining: 0 };
    if (t < this.preemptUntil) return { axis: this.preemptAxis, state: 'green', remaining: this.preemptUntil - t, preempt: true };
    const cyc = this.cycle;
    let u = ((t + this.offset) % cyc + cyc) % cyc;
    const y = this.yellow, ar = this.allRed;
    if (u < this.nsGreen) return { axis: 'NS', state: 'green', remaining: this.nsGreen - u };
    u -= this.nsGreen;
    if (u < y) return { axis: 'NS', state: 'yellow', remaining: y - u };
    u -= y;
    if (u < ar) return { axis: 'NS', state: 'allred', remaining: ar - u };
    u -= ar;
    if (u < this.ewGreen) return { axis: 'EW', state: 'green', remaining: this.ewGreen - u };
    u -= this.ewGreen;
    if (u < y) return { axis: 'EW', state: 'yellow', remaining: y - u };
    u -= y;
    return { axis: 'EW', state: 'allred', remaining: Math.max(0, ar - u) };
  }
  localPhaseU(t) {
    const cyc = this.cycle;
    return ((t + this.offset) % cyc + cyc) % cyc;
  }
}

class Road {
  constructor(from, to, def, link, reverse) {
    this.from = from; this.to = to;
    this.def = def; this.link = link;
    this.baseLanes = def.lanes;
    this.speedLimit = def.speed;
    this.name = def.name;
    this.cls = def.cls;
    this.uid = def.name + (reverse ? '/rev' : '');
    this.isRing = !!def.ring;
    this.rev = reverse;
    this.cars = [];
    this.closed = false; this.closeReason = null;
    this.condition = 1; this.incident = null;
    this.envCap = 1; this.envSpeed = 1;
    this.nextRelease = 0;
    this.saturation = 0; this.capacity = 1;
    this.flow = new Float32Array(60); this.flowMark = new Int32Array(60).fill(-1);
    this._carCache = [];
    this.buildGeometry();
  }

  buildGeometry() {
    /* Polyline always runs from this road's own origin to its own destination.
       The offset normal flips with travel direction, so applying the same
       offset to both directed roads places them on opposite sides. */
    const via = this.def.via || [];
    const ordered = this.rev ? via.slice().reverse() : via;
    const pts = [{ x: this.from.x, y: this.from.y }];
    for (const p of ordered) pts.push({ x: p[0], y: p[1] });
    pts.push({ x: this.to.x, y: this.to.y });
    this.raw = pts;
    const half = this.link && this.link.halfOffset != null ? this.link.halfOffset : CFG.roadOffset;
    this.pts = offsetPolyline(pts, half);
    this.cum = [0];
    for (let i = 1; i < this.pts.length; i++) {
      this.cum.push(this.cum[i - 1] + Math.hypot(this.pts[i].x - this.pts[i - 1].x, this.pts[i].y - this.pts[i - 1].y));
    }
    this.len = this.cum[this.cum.length - 1];
    const n = this.pts.length;
    const dx = this.pts[n - 1].x - this.pts[n - 2].x, dy = this.pts[n - 1].y - this.pts[n - 2].y;
    this.axis = Math.abs(dx) >= Math.abs(dy) ? 'EW' : 'NS';
    this.mid = this.pts[Math.floor(n / 2)];
  }

  get lanes() { return this._lanes != null ? this._lanes : this.baseLanes; }
  get effSpeed() { return this.closed ? 0 : this.speedLimit * this.condition * this.envSpeed; }

  /* Longitudinal road space one vehicle occupies in a standing queue. A link
     carries its lanes abreast, so a two-lane approach stores roughly twice as
     many vehicles nose-to-tail as a single-lane one. Storage, the hard headway
     and the entry gate all derive from this, which is what keeps `saturation`
     an honest 0..1 occupancy instead of a number that can drift past 100%. */
  get minHeadway() { return (CFG.carLen + CFG.minGap) / this.lanes; }

  /* Lateral centre of lane index `i`, relative to the carriageway centre. */
  laneOffset(i) { return (i - (this.lanes - 1) / 2) * CFG.laneWidth; }

  cost(redirect) {
    /* Redirection off means the network routes on free-flow time, which is what
       an uninstrumented city does: drivers take the shortest road, not the
       emptiest one. Authorising redirection adds a term that grows with the
       square of occupancy, so a loaded link drops out of the shortest path. */
    const w = redirect ? CFG.rerouteWeight : 0;
    return (this.len / Math.max(10, this.speedLimit * this.condition * this.envSpeed)) * (1 + w * this.saturation * this.saturation);
  }

  /* Storage in vehicles: one headway per slot, plus the slot at the stop line.
     The entry gate admits on the same headway, so `load / capacity` is a true
     occupancy that reaches 1.0 when a link is full and cannot pass it. */
  updateCapacity() {
    this.capacity = Math.max(3, this.len / this.minHeadway + 1);
  }

  posAt(d, out) {
    const pts = this.pts, cum = this.cum;
    if (d <= 0 || pts.length < 2) {
      const a = pts[0], b = pts[1] || pts[0];
      out.x = a.x; out.y = a.y; out.angle = Math.atan2(b.y - a.y, b.x - a.x); return out;
    }
    if (d >= this.len) {
      const n = pts.length, a = pts[n - 1], b = pts[n - 2];
      out.x = a.x; out.y = a.y; out.angle = Math.atan2(a.y - b.y, a.x - b.x); return out;
    }
    let lo = 0, hi = cum.length - 1;
    while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= d) lo = mid; else hi = mid; }
    const seg = Math.max(0.0001, cum[lo + 1] - cum[lo]);
    const t = (d - cum[lo]) / seg;
    const a = pts[lo], b = pts[lo + 1];
    out.x = a.x + (b.x - a.x) * t;
    out.y = a.y + (b.y - a.y) * t;
    out.angle = Math.atan2(b.y - a.y, b.x - a.x);
    return out;
  }
}

class Car {
  constructor(type, sim) {
    this.type = type;
    this.id = ++sim.carSeq;
    this.len = type === 'bus' ? CFG.busLen : type === 'ev' ? CFG.evLen : CFG.carLen;
    this.lane = 0;
    this._dl = 0;
    this.speedFactor = type === 'bus' ? 0.88 : type === 'ev' ? 1.18 : 1;
    this.speed = 0; this.pos = 0;
    this.wait = 0; this.totalWait = 0; this.trip = 0;
    this.path = null; this.pathIdx = 0; this.destNode = null;
    this.spawnTime = sim.time;
    this.color = null;
    this.gone = false;
  }
}

class Link {
  constructor(def, nodeA, nodeB) {
    this.def = def;
    this.name = def.name;
    this.cls = def.cls;
    this.baseLanes = def.lanes;
    this.bias = 0;
    /* Carriageways of one link must clear each other at the width they are
       actually drawn, so the offset follows the link's lane count rather than
       being a single global constant. */
    this.halfOffset = (def.lanes * CFG.laneWidth) / 2 + 1.1;
    this.a = new Road(nodeA, nodeB, def, this, false);
    this.b = new Road(nodeB, nodeA, def, this, true);
    this.dirs = [this.a, this.b];
  }
  applyLanes() {
    const b = this.baseLanes;
    this.a._lanes = Math.max(1, b + this.bias);
    this.b._lanes = Math.max(1, b - this.bias);
    this.a.updateCapacity(); this.b.updateCapacity();
  }
  get closed() { return this.a.closed && this.b.closed; }
}

class City {
  constructor() {
    this.nodes = NODE_DEFS.map(d => new Intersection(d));
    this.nodeById = {};
    for (const n of this.nodes) this.nodeById[n.id] = n;
    this.gateByNode = {};
    for (const g of GATE_DEFS) { this.nodeById[g.node].gate = g; this.gateByNode[g.node] = g; }

    this.links = LINK_DEFS.map(d => new Link(d, this.nodeById[d.a], this.nodeById[d.b]));
    this.roads = [];
    for (const l of this.links) { l.applyLanes(); this.roads.push(l.a, l.b); }
    for (const rd of this.roads) {
      rd.from.outgoing.push(rd);
      rd.to.incoming.push(rd);
      rd.updateCapacity();
    }
    this.linkBetween = (a, b) => this.links.find(l => (l.def.a === a && l.def.b === b) || (l.def.a === b && l.def.b === a)) || null;
    this.dirBetween = (a, b) => {
      const l = this.linkBetween(a, b);
      if (!l) return null;
      return l.def.a === a ? l.a : l.b;
    };
  }
  roadByName(name) { return this.roads.find(r => r.name === name && !r.rev) || null; }
}

/* ============================== 7. SIMULATION ============================= */

class Simulation {
  constructor(scenarioId, seedOverride) {
    this.scenario = SCENARIOS.find(s => s.id === scenarioId) || SCENARIOS[0];
    this.rng = mulberry32(seedOverride || this.scenario.seed);
    /* Driver behaviour draws from its own stream. If rerouting shared the demand
       stream, every intervention would shift the sequence of future arrivals,
       and the "leave the plan alone" reference would stop being a true
       counterfactual — the comparison would be against a different day. */
    this.rngTraffic = mulberry32((seedOverride || this.scenario.seed) ^ 0x5bf03635);

    this.city = new City();
    this.nodes = this.city.nodes;
    this.links = this.city.links;
    this.roads = this.city.roads;

    this.time = 0;
    this.duration = this.scenario.duration;
    this.budget = CFG.startBudget;
    this.spent = 0;

    this.totalCars = 0;
    this.carSeq = 0;
    this.tripSeq = 0;
    this.pending = [];
    this.droppedRequests = 0;
    this.demandAcc = 0;
    this.busAcc = 0;
    this.streams = [];
    this.weather = { until: 0, speed: 1, cap: 1, label: 'CLEAR' };

    this.events = this.scenario.events.slice().sort((a, b) => a.t - b.t);
    this.eventIndex = 0;
    this.feed = [];
    this.cards = [];
    this.interventions = [];
    this.completed = [];
    this.abandonedCount = 0;
    this.abandonRecent = [];
    this.evLog = [];

    this.metrics = { flow: 50, congestion: 20, stability: 70, satisfaction: 70, emergency: 100 };
    this.history = { flow: [], congestion: [], stability: [], satisfaction: [], emergency: [], budget: [] };
    this.metricTimer = 0; this.routingTimer = 99; this.rerouteTimer = 0;
    this.nextHop = {};
    this.routeVersion = 0;
    this.redirection = false;
    this.corridor = null;
    this.corridorAuthorized = false;
    this.activeEv = null;
    this.finished = false;

    this.peakCongestion = 0; this.sumCongestion = 0; this.samples = 0;
    this.sumQueue = 0; this.sumWait = 0;
    this.throughput = 0; this.avgTravel = REF_TRAVEL_TIME; this.avgWait = 0;
    this.spawnCount = 0; this.dropCount = 0; this.unmetRate = 0; this._pendingQueue = 0;
    this.busWait = null;
    /* demand accounting — the honest measure of whether the network is delivering */
    this.carRequests = 0; this.carCompletions = 0; this.servedRatio = 0; this.peakCars = 0;
    this.avgQueue = 0; this.abandonRate = 0;
    this.recoverySamples = [];
    this.shockStart = -1;
    this.flowSamples = [];

    /* Short-lived consequence badges drawn on the map when an intervention
       settles, and a throttle for the live grade. */
    this.flashes = [];
    this._live = null;
    this._liveAt = -99;

    this.evRequest = null;
    this.buildBusRoutes();
    this.applyInit();
    this.rebuildRouting();
    this.primeSensors();
    this.log('info', 'SYSTEM ONLINE', `${this.scenario.name} — control authority granted. ${this.scenario.blurb}`);
    this.log('warn', 'BASELINE', `Legacy signal estate inherited — uncoordinated offsets network-wide, ` +
      `splits at ${this.legacyFlaws.length} junctions still reflecting a superseded demand model (${this.legacyFlaws.join(', ')}).`);
  }

  /* ---------- setup ---------- */

  buildBusRoutes() {
    this.busPaths = [];
    for (const nodes of BUS_ROUTES) {
      const path = [];
      let ok = true;
      for (let i = 0; i < nodes.length - 1; i++) {
        const rd = this.city.dirBetween(nodes[i], nodes[i + 1]);
        if (!rd) { ok = false; break; }
        path.push(rd);
      }
      if (ok && path.length) this.busPaths.push({ path, nodes });
    }
    for (const bp of this.busPaths) for (const rd of bp.path) rd.isBusRoute = true;
  }

  applyInit() {
    /* Every scenario starts from a legacy signal estate: uncoordinated offsets
       (all junctions switch together, so platoons meet reds) and a handful of
       splits biased against the dominant peak movement. The upside available
       to the player is real and comes from repairing this baseline. */
    for (const n of this.nodes) n.offset = 0;
    this.legacyFlaws = [];
    const init = this.scenario.init || {};

    if (init.signals) {
      for (const id in init.signals) {
        const n = this.city.nodeById[id];
        if (!n) continue;
        const s = init.signals[id];
        n.nsGreen = s.ns; n.ewGreen = s.ew;
        this.legacyFlaws.push(n.name);
      }
    }

    if (init.closure) {
      const rd = this.city.roadByName(init.closure.link);
      if (rd) this.setLinkClosed(rd, true, init.closure.reason);
    }
    if (init.incident) {
      const rd = this.city.roadByName(init.incident.link);
      if (rd) this.applyIncident(rd, init.incident.severity, init.incident.duration, 'PRE-EXISTING INCIDENT');
    }
  }

  primeSensors() {
    /* Warm the network for four simulated seconds so the opening dashboard
       shows a running city rather than an empty grid, then rewind the clock and
       discard everything that warm-up produced. Structural state set by
       applyInit() — closures, standing incidents, signal plans — is deliberately
       preserved: the scenarios open with those already in place. */
    for (let i = 0; i < 240; i++) this.step(1 / 60);

    for (const k in this.history) this.history[k].length = 0;
    this.interventions.length = 0;
    this.feed.length = 0;
    this.cards.length = 0;
    this.completed.length = 0;
    this.abandonedCount = 0;
    this.sumCongestion = 0; this.samples = 0; this.peakCongestion = 0;
    this.spawnCount = 0; this.dropCount = 0; this.droppedRequests = 0;
    this.carRequests = 0; this.carCompletions = 0; this.peakCars = 0;
    this.evLog.length = 0; this.activeEv = null; this.evRequest = null;
    this.sumQueue = 0; this.sumWait = 0;
    this.pending.length = 0;
    this.demandAcc = 0; this.busAcc = 0;
    this.streams.length = 0;
    this.weather = { until: 0, speed: 1, cap: 1, label: 'CLEAR' };
    this.redirection = false;
    this.corridor = null; this.corridorAuthorized = false;
    this.time = 0;
    this.eventIndex = 0;
    this.metricTimer = 0; this.routingTimer = 99; this.rerouteTimer = 0;

    /* Vehicles already on the network are treated as trips admitted before the
       clock started, so the served-demand ratio is not flattered by their
       completions. */
    let warm = 0;
    for (const rd of this.roads) warm += rd.cars.length;
    this.carRequests = warm;

    /* reset rolling measurement windows without touching structural state */
    for (const rd of this.roads) {
      rd.flow.fill(0); rd.flowMark.fill(-1);
      rd.envSpeed = 1; rd.envCap = 1; rd.nextRelease = 0;
      rd.updateCapacity();
    }
    for (const n of this.nodes) {
      n.preemptUntil = -1; n.preemptAxis = null; n.syncAxis = null;
      n.queue = 0; n.waitEma = 0; n.congestion = 0; n.volume = 0;
      n.inflow = 0; n.outflow = 0;
      n.flow.fill(0); n.flowMark.fill(-1);
      n.inFlow.fill(0); n.inMark.fill(-1);
      n.outFlow.fill(0); n.outMark.fill(-1);
      n.wsum.fill(0); n.wcnt.fill(0); n.wmark.fill(-1);
    }
  }

  /* ---------- routing ---------- */

  rebuildRouting() {
    const nodes = this.nodes, n = nodes.length;
    for (const dest of nodes) {
      const dist = new Array(n).fill(Infinity);
      const next = new Array(n).fill(null);
      const visited = new Array(n).fill(false);
      dist[dest.id] = 0;
      for (;;) {
        let u = -1, best = Infinity;
        for (let i = 0; i < n; i++) if (!visited[i] && dist[i] < best) { best = dist[i]; u = i; }
        if (u < 0) break;
        visited[u] = true;
        for (const rd of nodes[u].incoming) {
          if (rd.closed) continue;
          const v = rd.from.id;
          const c = dist[u] + rd.cost(this.redirection);
          if (c < dist[v]) { dist[v] = c; next[v] = rd; }
        }
      }
      this.nextHop[dest.id] = next;
    }
    this.routeVersion++;
  }

  routeRoads(srcId, destId) {
    if (srcId === destId) return null;
    const table = this.nextHop[destId];
    if (!table) return null;
    const out = [];
    let cur = srcId;
    for (let i = 0; i < 40; i++) {
      const rd = table[cur];
      if (!rd) return null;
      out.push(rd);
      cur = rd.to.id;
      if (cur === destId) return out;
    }
    return null;
  }

  rerouteCars() {
    for (const rd of this.roads) {
      if (!rd.cars.length) continue;
      for (const car of rd.cars) {
        if (car.speed > 5) continue;
        if (this.rngTraffic() > 0.34) continue;
        this.rerouteCar(car, rd);
      }
    }
  }

  rerouteCar(car, rd) {
    if (car.type === 'ev' || car.type === 'bus') return false;
    if (car.destNode == null) return false;
    const suffix = this.routeRoads(rd.to.id, car.destNode);
    if (!suffix || !suffix.length) return false;
    car.path = [rd].concat(suffix);
    car.pathIdx = 0;
    return true;
  }

  /* ---------- demand ---------- */

  currentPhase() {
    const ph = this.scenario.phases;
    for (const p of ph) if (this.time < p.until) return p;
    return ph[ph.length - 1];
  }

  boostProfiles() {
    const profile = { origins: {}, dests: {} };
    const base = this.currentPhase().profile;
    for (const k in base.origins) profile.origins[k] = base.origins[k];
    for (const k in base.dests) profile.dests[k] = base.dests[k];
    for (const st of this.streams) {
      if (this.time > st.until) continue;
      if (st.originBias != null) profile.origins[st.originBias] = (profile.origins[st.originBias] || 0) + st.rate * 2.6;
      if (st.destBias != null) profile.dests[st.destBias] = (profile.dests[st.destBias] || 0) + st.rate * 2.6;
      if (st.node != null) {
        profile.origins[st.node] = (profile.origins[st.node] || 1) * (st.mult || 1);
        profile.dests[st.node] = (profile.dests[st.node] || 1) * (st.mult || 1);
      }
    }
    return profile;
  }

  pickWeighted(obj) {
    let total = 0;
    for (const k in obj) total += obj[k];
    if (total <= 0) return null;
    let r = this.rng() * total;
    for (const k in obj) {
      r -= obj[k];
      if (r <= 0) return parseInt(k, 10);
    }
    return parseInt(Object.keys(obj)[Object.keys(obj).length - 1], 10);
  }

  updateDemand(dt) {
    const phase = this.currentPhase();
    let rate = phase.demand * (this.weather.demandMult || 1);
    for (const st of this.streams) if (this.time <= st.until && st.globalMult) rate *= st.globalMult;
    this.demandRate = rate;
    this.demandAcc += rate * dt;
    const profile = this.boostProfiles();
    let guard = 0;
    while (this.demandAcc >= 1 && guard++ < 60) {
      this.demandAcc -= 1;
      const o = this.pickWeighted(profile.origins);
      const d = this.pickWeighted(profile.dests);
      if (o != null && d != null && o !== d) { this.pending.push({ o, d, type: 'car', born: this.time }); this.carRequests++; }
    }
  }

  updateStreams(dt) {
    for (let i = this.streams.length - 1; i >= 0; i--) {
      const st = this.streams[i];
      if (this.time > st.until) { this.streams.splice(i, 1); continue; }
      if (st.rate == null) continue;
      st.acc = (st.acc || 0) + st.rate * dt;
      let guard = 0;
      while (st.acc >= 1 && guard++ < 20) {
        st.acc -= 1;
        const o = st.originBias != null ? st.originBias : this.pickWeighted(this.currentPhase().profile.origins);
        const d = st.destBias != null ? st.destBias : this.pickWeighted(this.currentPhase().profile.dests);
        if (o != null && d != null && o !== d) { this.pending.push({ o, d, type: 'car', born: this.time }); this.carRequests++; }
      }
    }
  }

  updateBusses(dt) {
    let rate = 0.34;
    for (const st of this.streams) if (this.time <= st.until && st.busRate) rate += st.busRate;
    this.busAcc += rate * dt;
    let guard = 0;
    while (this.busAcc >= 1 && guard++ < 8) {
      this.busAcc -= 1;
      const bp = this.busPaths[Math.floor(this.rngTraffic() * this.busPaths.length)];
      if (!bp) continue;
      if (bp.path.some(r => r.closed)) continue;
      this.spawn(bp.path, 'bus', bp.path[bp.path.length - 1].to.id);
    }
  }

  tryPlacePending() {
    let placed = 0;
    for (let i = 0; i < this.pending.length; i++) {
      const req = this.pending[i];
      if (this.time - req.born > CFG.pendingTimeout) {
        this.pending.splice(i, 1); i--;
        this.droppedRequests++; this.dropCount++;
        continue;
      }
      if (placed >= 5) break;
      const path = this.routeRoads(req.o, req.d);
      if (!path) { this.pending.splice(i, 1); i--; this.droppedRequests++; this.dropCount++; continue; }
      if (this.spawn(path, req.type, req.d)) { this.pending.splice(i, 1); i--; placed++; }
    }
  }

  spawn(path, type, destNode) {
    if (!path || !path.length) return false;
    if (this.totalCars >= CFG.maxCars) return false;
    const first = path[0];
    if (first.closed) return false;
    if (first.saturation > 0.97) return false;
    if (type !== 'ev' && this.corridorReserved(first)) return false;
    const last = first.cars.length ? first.cars[first.cars.length - 1] : null;
    if (last && last.pos < first.minHeadway) return false;

    const car = new Car(type, this);
    car.path = path;
    car.pathIdx = 0;
    car.pos = 0;
    car.lane = Math.floor(this.rngTraffic() * Math.max(1, first.lanes));
    car.speed = Math.min(22, first.effSpeed * 0.45);
    car.destNode = destNode;
    first.cars.push(car);
    this.totalCars++;
    if (type !== 'ev') this.spawnCount++;
    if (type === 'ev') {
      car.spawnTime = this.time;
      this.activeEv = car;
      this.evLog.push({ start: this.time, end: null, time: null });
    }
    return true;
  }

  /* ---------- signal pre-emption ---------- */

  trySpawnEv() {
    if (!this.evRequest || this.activeEv) return;
    const req = this.evRequest;
    const path = this.routeRoads(req.from, req.to);
    if (!path) { if (this.time - req.born > 25) this.evRequest = null; return; }
    if (this.spawn(path, 'ev', req.to)) {
      this.afterEvSpawn(path); this.evRequest = null; return;
    }
    if (this.time - req.born > 12) {
      const rd = path[0];
      const car = new Car('ev', this);
      car.path = path; car.pathIdx = 0; car.pos = 0;
      car.speed = 12; car.destNode = req.to;
      rd.cars.push(car);
      this.totalCars++;
      this.evLog.push({ start: this.time, end: null, time: null });
      this.activeEv = car;
      this.afterEvSpawn(path);
      this.evRequest = null;
      this.log('crit', 'EMERGENCY', 'Boundary saturated — response vehicle forced into the network ahead of general traffic.');
    }
  }

  afterEvSpawn(path) {
    this.lastEvRoute = path;
    this.corridor = null;
    this.corridorAuthorized = false;
  }

  /* Two pre-emption claims can exist at one junction: a local bus-priority hold,
     and an authorised emergency corridor, which outranks it.

     The hold is latched for its full duration rather than re-decided every tick.
     When it was re-decided, two buses on crossing approaches at the same
     junction flipped the pre-empted axis sixty times a second, so neither
     movement ever accumulated a green and the junction gridlocked — which made
     bus priority actively harmful once more than one route met at a node. */
  updatePreemption() {
    const corridorOn = this.corridorActive();
    for (const n of this.nodes) {
      if (n.outage) continue;

      if (corridorOn) {
        const axis = this.corridor.nodeAxis[n.id];
        if (axis) {
          n.preemptAxis = axis;
          n.preemptUntil = Math.max(n.preemptUntil, this.time + 0.6);
          continue;
        }
      }

      if (!n.busPriority) continue;
      if (n.preemptUntil > this.time) continue;      // hold the phase already granted

      let axis = null;
      for (const rd of n.incoming) {
        if (rd.closed || !rd.cars.length) continue;
        for (let i = rd.cars.length - 1; i >= 0; i--) {
          const c = rd.cars[i];
          if (c.type !== 'bus') continue;
          /* rd.len is the link's length in world units. Using the array length
             here yielded NaN, so transit pre-emption never fired at all — the
             bus-priority policy was a paid no-op. */
          const d = rd.len - c.pos;
          if (d > 24 && d < 140) { axis = rd.axis; break; }
        }
        if (axis) break;
      }
      if (axis) { n.preemptAxis = axis; n.preemptUntil = this.time + 5.5; }
    }
  }

  corridorActive() {
    return !!(this.corridorAuthorized && this.corridor && this.activeEv && !this.activeEv.gone);
  }

  /* ---------- core movement ---------- */

  canCross(rd, car) {
    const node = rd.to;
    if (node.outage) {
      if (this.time < rd.nextRelease) return false;
    } else {
      const ph = node.phaseAt(this.time);
      if (!(ph.state === 'green' && ph.axis === rd.axis)) return false;
      if (this.time < rd.nextRelease) return false;
    }
    const nextRd = car.path[car.pathIdx + 1];
    if (!nextRd) return true;
    if (nextRd.closed) {
      if (!this.rerouteCar(car, rd)) return false;
      const alt = car.path[car.pathIdx + 1];
      if (!alt || alt.closed) return false;
      if (this.corridorReserved(alt, car)) return false;
      return this.spaceOn(alt);
    }
    if (!this.corridorReserved(rd) && this.corridorReserved(nextRd, car)) return false;
    return this.spaceOn(nextRd);
  }

  /* While a corridor is authorised the route is held clear: ordinary traffic may
     not *enter* it from outside, so the links drain ahead of the response
     vehicle instead of being refilled behind it. Traffic already inside the
     corridor keeps moving and leaves — blocking movement within the corridor as
     well would freeze the vehicles in front of the ambulance and deadlock the
     very route the corridor exists to clear. Response vehicles are exempt. */
  corridorReserved(rd, car) {
    if (car && car.type === 'ev') return false;
    return this.corridorActive() && this.corridor.roadSet.has(rd);
  }  /* Entry gate: a link accepts a vehicle only once its tail has cleared one
     storage slot. Matches Road.jamSpacing, so a link can never hold more than
     its declared capacity. */
  spaceOn(rd) {
    const last = rd.cars.length ? rd.cars[rd.cars.length - 1] : null;
    if (!last) return true;
    return last.pos > rd.minHeadway;
  }

  updateRoads(dt) {
    for (const rd of this.roads) {
      if (rd.cars.length) this.updateRoad(rd, dt);
    }
  }

  updateRoad(rd, dt) {
    const cars = rd.cars;
    const next = [];
    const vmax = rd.effSpeed;
    let reordered = false;

    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      const leader = next.length ? next[next.length - 1] : null;
      const free = leader === null;
      let desired = vmax * car.speedFactor;

      if (leader) {
        const gap = (leader.pos - leader.len * 0.5) - (car.pos + car.len * 0.5) - CFG.minGap;
        desired = Math.min(desired, Math.max(0, gap) * CFG.followK);
      }

      const distToStop = rd.len - car.pos;
      let crossing = false;
      if (free) {
        crossing = this.canCross(rd, car);
        if (!crossing) {
          const brake = Math.sqrt(2 * CFG.decel * Math.max(0, distToStop - 1));
          desired = Math.min(desired, brake);
        }
      }

      car.speed += (desired - car.speed) * Math.min(1, dt * CFG.accelResponse);
      if (car.speed < 0.02) car.speed = 0;
      car.pos += car.speed * dt;
      car.trip += dt;

      /* Hard headway. The car-following term above is a first-order lag, so a
         fast vehicle approaching a slow one could still overshoot into it —
         which also let a follower drift ahead of its leader and corrupt the
         front-first ordering of the array. Clamping the integrated position to
         the physical minimum headway removes both problems: no overlaps, and no
         overtaking inside a link. */
      if (leader) {
        const minPos = leader.pos - ((leader.len + car.len) * 0.5 + CFG.minGap) / rd.lanes;
        if (car.pos > minPos) {
          car.pos = Math.max(0, minPos);
          if (car.speed > leader.speed) car.speed = leader.speed;
        }
      }

      if (car.speed < 6) car.wait += dt; else car.wait = Math.max(0, car.wait - dt * 0.7);

      const patience = car.type === 'ev' ? CFG.evAbandonWait : CFG.abandonWait;
      if (car.speed < 1.2 && car.totalWait + car.wait > patience) {
        this.abandonTrip(car, rd);
        continue;
      }

      if (car.pos >= rd.len) {
        car.pos = rd.len;
        if (free && crossing) {
          if (this.transfer(rd, car)) continue;
        }
        car.speed = 0;
        /* held at the stop line — this vehicle is now further along than
           everything behind it, so the list order has to be repaired */
        reordered = true;
      }
      next.push(car);
    }
    /* cars[] is ordered front-first: cars[i - 1] leads cars[i], and the last
       element must be the true tail — `spaceOn` reads that last element as the
       tail when deciding whether the link can admit another vehicle. A lead
       vehicle that reached the stop line without discharging used to be pushed
       to the back of the list and read as the least-advanced vehicle, so the
       entry gate kept admitting traffic onto a link that was already physically
       full. Links then held two to three times their real storage, stop lines
       stopped queuing back through upstream junctions, and saturation pinned at
       100% instead of rising. */
    if (reordered) next.sort((a, b) => b.pos - a.pos);
    rd.cars = next;
  }

  transfer(rd, car) {
    const node = rd.to;
    const derate = node.outage ? 0.4 : 1;
    rd.nextRelease = this.time + 1 / Math.max(0.05, CFG.satFlow * rd.lanes * derate);
    this.incRoadFlow(rd);
    this.incNodeFlow(node, 'in');
    this.incNodeFlow(rd.from, 'out');
    this.bucketNodeWait(node, car.wait);
    car.totalWait += car.wait;
    car.wait = 0;

    const nxt = car.path[car.pathIdx + 1];
    if (!nxt) { this.completeTrip(car); return true; }
    car.pathIdx++;
    car.pos = 0;
    car.speed = Math.min(car.speed, 26);
    nxt.cars.push(car);
    return true;
  }

  completeTrip(car) {
    car.gone = true;
    this.totalCars--;
    const rec = { t: this.time, tt: car.trip, wait: car.totalWait, type: car.type };
    this.completed.push(rec);
    if (car.type === 'car') this.carCompletions++;
    if (car.type === 'ev') {
      const entry = this.evLog[this.evLog.length - 1];
      if (entry && entry.end == null) { entry.end = this.time; entry.time = this.time - entry.start; }
      if (this.activeEv === car) this.activeEv = null;
    }
  }

  abandonTrip(car, rd) {
    car.gone = true;
    this.totalCars--;
    this.abandonedCount++;
    this.abandonRecent.push(this.time);
    if (car.type === 'ev') {
      const entry = this.evLog[this.evLog.length - 1];
      if (entry && entry.end == null) { entry.end = this.time; entry.time = this.time - entry.start; }
      if (this.activeEv === car) this.activeEv = null;
    }
    car.path = null;
    rd.cars = rd.cars.filter(c => c !== car);
  }

  /* ---------- counters ---------- */

  bucketInc(arr, mark) {
    const sec = Math.floor(this.time), b = sec % 60;
    if (mark[b] !== sec) { arr[b] = 0; mark[b] = sec; }
    arr[b]++;
  }
  bucketNodeWait(node, wait) {
    const sec = Math.floor(this.time), b = sec % 30;
    if (node.wmark[b] !== sec) { node.wsum[b] = 0; node.wcnt[b] = 0; node.wmark[b] = sec; }
    node.wsum[b] += wait; node.wcnt[b] += 1;
  }
  nodeWaitWindow(node) {
    let s = 0, c = 0;
    for (let i = 0; i < 30; i++) { s += node.wsum[i]; c += node.wcnt[i]; }
    return c ? s / c : null;
  }
  incRoadFlow(rd) { this.bucketInc(rd.flow, rd.flowMark); }
  incNodeFlow(node, which) {
    if (which === 'in') this.bucketInc(node.inFlow, node.inMark);
    else this.bucketInc(node.outFlow, node.outMark);
  }

  /* ---------- events ---------- */

  dispatchEvents() {
    while (this.eventIndex < this.events.length && this.events[this.eventIndex].t <= this.time) {
      this.fireEvent(this.events[this.eventIndex]);
      this.eventIndex++;
    }
  }

  fireEvent(ev) {
    const clock = formatClock(this.scenario.startClock, this.time, CFG.clockRate);
    switch (ev.kind) {
      case 'accident': {
        const rd = this.city.roadByName(ev.link);
        if (!rd) break;
        this.applyIncident(rd, ev.severity, ev.duration, 'COLLISION');
        this.pushCard({ title: ev.title, body: ev.body, level: 'crit', clock });
        this.log('crit', 'INCIDENT', `${ev.link} — ${ev.body}`);
        break;
      }
      case 'rain': {
        this.weather = { until: this.time + ev.duration, speed: 0.72, cap: 0.85, label: 'HEAVY RAIN', demandMult: 0.94 };
        this.pushCard({ title: ev.title, body: ev.body, level: 'warn', clock });
        this.log('warn', 'CONDITIONS', ev.body);
        break;
      }
      case 'outage': {
        for (const id of ev.nodes) {
          const n = this.city.nodeById[id];
          n.outage = true; n.outageUntil = this.time + ev.duration;
          n.incidents.push({ type: 'outage', until: n.outageUntil });
        }
        this.pushCard({ title: ev.title, body: ev.body, level: 'crit', clock });
        this.log('crit', 'SIGNAL LOSS', `${ev.nodes.map(i => this.city.nodeById[i].name).join(', ')} — all-way flash.`);
        break;
      }
      case 'emergency': {
        /* Never drop a response vehicle: queue it and force entry if the
           boundary is saturated, because the incident still exists. */
        this.evRequest = { from: ev.from, to: ev.to, born: this.time };
        this.pushCard({ title: ev.title, body: ev.body, level: 'info', clock });
        this.log('crit', 'EMERGENCY', `Response vehicle inbound ${this.city.nodeById[ev.from].name} → ${this.city.nodeById[ev.to].name}. Corridor authorisation available.`);
        break;
      }
      case 'stadium':
      case 'egress': {
        this.streams.push({ until: this.time + ev.duration, rate: ev.rate, destBias: ev.destBias, originBias: ev.originBias, node: ev.node, acc: 0 });
        this.pushCard({ title: ev.title, body: ev.body, level: 'warn', clock });
        this.log('warn', 'DEMAND', ev.body);
        break;
      }
      case 'surge': {
        this.streams.push({ until: this.time + ev.duration, mult: ev.mult, node: ev.node, acc: 0 });
        this.pushCard({ title: ev.title, body: ev.body, level: 'warn', clock });
        this.log('warn', 'DEMAND', ev.body);
        break;
      }
      case 'transit': {
        this.streams.push({ until: this.time + ev.duration, busRate: ev.rate, acc: 0 });
        this.pushCard({ title: ev.title, body: ev.body, level: 'info', clock });
        this.log('info', 'TRANSIT', ev.body);
        break;
      }
      case 'spike': {
        this.streams.push({ until: this.time + ev.duration, globalMult: ev.mult, acc: 0 });
        this.pushCard({ title: ev.title, body: ev.body, level: 'crit', clock });
        this.log('crit', 'DEMAND', ev.body);
        break;
      }
    }
  }

  applyIncident(rd, severity, duration, reason) {
    const until = this.time + duration;
    for (const r of rd.link.dirs) {
      r.condition = 1 - severity * 0.55;
      r.incident = { severity, until, reason };
      r.incidents = [{ type: 'incident', until }];
    }
    this.log('crit', 'INCIDENT', `${rd.name} — ${reason}. Capacity and speed derated ${Math.round(severity * 55)}%.`);
  }

  clearExpired() {
    for (const rd of this.roads) {
      if (rd.incident && this.time > rd.incident.until && !rd.closed) {
        rd.incident = null; rd.condition = 1;
      }
    }
    for (const n of this.nodes) {
      if (n.outage && this.time > n.outageUntil) {
        n.outage = false;
        this.log('good', 'SIGNAL RESTORED', `${n.name} returned to coordinated control.`);
      }
      n.incidents = n.incidents.filter(i => i.until > this.time);
    }
    if (this.weather.until && this.time > this.weather.until) {
      this.weather = { until: 0, speed: 1, cap: 1, label: 'CLEAR' };
      this.log('good', 'CONDITIONS', 'Rain cleared. Advisory speeds restored.');
    }
  }

  pushCard(c) {
    this.cards.push({ ...c, born: this.time, id: ++this.tripSeq });
    if (this.cards.length > 24) this.cards.splice(0, this.cards.length - 24);
  }
  log(level, tag, msg) {
    this.feed.push({ level, tag, msg, time: this.time, clock: formatClock(this.scenario.startClock, this.time, CFG.clockRate) });
    if (this.feed.length > 260) this.feed.shift();
  }

  /* ---------- metrics ---------- */

  updateMetrics(dt) {
    this.metricTimer += dt;
    if (this.metricTimer < 0.25) return;
    const mdt = this.metricTimer;
    this.metricTimer = 0;

    /* environment */
    for (const rd of this.roads) {
      rd.envSpeed = this.weather.speed;
      rd.envCap = this.weather.cap;
    }

    /* road saturation */
    let satSum = 0, grid = 0;
    for (const rd of this.roads) {
      const load = rd.closed ? 0 : rd.cars.length;
      rd.saturation = rd.closed ? 0 : clamp01(load / rd.capacity);
      satSum += rd.saturation;
      if (rd.saturation > 0.92) grid++;
    }
    /* Network congestion is a composite index: how full the links are, and how
       much traffic is stacked at junctions waiting for green. Neither alone
       describes the network — link loading misses junction-bound queues, and
       junction queues miss links saturated mid-block. */
    const linkLoad = (satSum / this.roads.length) * 100;
    const junctionLoad = clamp01(this._pendingQueue / 15) * 100;
    const cong = clamp(linkLoad * 0.6 + junctionLoad * 0.4, 0, 100);
    this.metrics.congestion += (cong - this.metrics.congestion) * clamp01(mdt / 2.2);
    this.peakCongestion = Math.max(this.peakCongestion, this.metrics.congestion);
    this.sumCongestion += this.metrics.congestion * mdt;
    this.samples += mdt;

    /* node state */
    let qTotal = 0, waitSum = 0, waitN = 0;
    for (const n of this.nodes) {
      let q = 0;
      for (const rd of n.incoming) {
        if (rd.closed) continue;
        for (let i = rd.cars.length - 1; i >= 0; i--) {
          const car = rd.cars[i];
          const d = rd.len - car.pos;
          if (car.speed < 6 && d < 115) q++;
        }
      }
      n.queue += (q - n.queue) * clamp01(mdt / 1.2);
      /* Mean measured wait over a 30s window — far steadier than an EMA over
         crossing samples, which spikes whenever a junction briefly empties. */
      const wwin = this.nodeWaitWindow(n);
      if (wwin != null) n.waitEma = wwin;
      else n.waitEma *= (1 - clamp01(mdt / 60));
      n.volume = sum(n.inFlow) * 60;
      n.inflow = sum(n.inFlow);
      n.outflow = sum(n.outFlow);
      let maxSat = 0;
      for (const rd of n.incoming) if (!rd.closed) maxSat = Math.max(maxSat, rd.saturation);
      n.congestion = maxSat * 100;
      qTotal += n.queue;
      if (n.volume > 0 || n.queue > 2) { waitSum += n.waitEma; waitN++; }
    }
    this.peakCars = Math.max(this.peakCars, this.totalCars);
    this.avgWait = waitN ? waitSum / waitN : 0;
    this._pendingQueue = qTotal / this.nodes.length;
    this.avgQueue = this._pendingQueue;
    this.sumQueue += this.avgQueue * mdt;
    this.sumWait += this.avgWait * mdt;

    /* trips */
    const cutoff = this.time - 60;
    this.completed = this.completed.filter(r => r.t > cutoff - 120);
    const recent = this.completed.filter(r => r.t > cutoff);
    if (recent.length) {
      let tt = 0, wt = 0;
      for (const r of recent) { tt += r.tt; wt += r.wait; }
      this.avgTravel += ((tt / recent.length) - this.avgTravel) * clamp01(mdt / 3.5);
      const bus = recent.filter(r => r.type === 'bus');
      if (bus.length) {
        let bw = 0; for (const r of bus) bw += r.wait;
        this.busWait = this.busWait == null ? bw / bus.length : this.busWait + ((bw / bus.length) - this.busWait) * clamp01(mdt / 8);
      }
    }
    this.throughput = recent.length;
    /* A rolling abandonment rate over the last minute, not a cumulative ratio.
       The cumulative form grew monotonically with run length and saturated, so
       it punished a long shift for being long. */
    const attempts = recent.length + this.abandonRecent.filter(t => t > cutoff).length;
    this.abandonRecent = this.abandonRecent.filter(t => t > this.time - 180);
    this.abandonRate = attempts > 0 ? this.abandonRecent.filter(t => t > cutoff).length / attempts : 0;

    /* Flow index. Served demand is weighted highest and deliberately so: travel
       time alone rewards a network that simply turns traffic away, and a
       throughput count alone ignores how long each journey took. */
    this.servedRatio = clamp01(this.carCompletions / Math.max(1, this.carRequests));
    const ttRatio = clamp(REF_TRAVEL_TIME / Math.max(12, this.avgTravel), 0, 1.25);
    const flowTarget = clamp01(this.servedRatio * 0.55 + ttRatio * 0.45) * 100;

    /* stability */
    const congPen = clamp01((this.metrics.congestion - 26) / 46) * 58;
    const gridPen = Math.min(26, grid) * 2.1;
    const qPen = clamp01((this.avgWait - 12) / 40) * 20;
    const outagePen = this.nodes.filter(n => n.outage).length * 4.5;
    const stabTarget = clamp(100 - congPen - gridPen - qPen - outagePen, 0, 100);

    /* satisfaction — journey experience is what the public actually perceives:
       how long they waited, how many gave up inside the network, and how many
       trip requests the network could not even admit. */
    this.unmetRate = this.dropCount / Math.max(1, this.dropCount + this.spawnCount);
    const waitPen = clamp01((this.avgWait - 9) / 38) * 50;
    const abPen = clamp01(this.abandonRate / 0.25) * 22;
    const unmetPen = clamp01(this.unmetRate / 0.4) * 16;
    const busDelay = this.busWait == null ? 0 : clamp01((this.busWait - this.avgWait - 4) / 22);
    const satTarget = clamp(100 - waitPen - abPen - unmetPen - busDelay * 14, 0, 100);

    this.metrics.flow += (flowTarget - this.metrics.flow) * clamp01(mdt / 3);
    this.metrics.stability += (stabTarget - this.metrics.stability) * clamp01(mdt / 4);
    this.metrics.satisfaction += (satTarget - this.metrics.satisfaction) * clamp01(mdt / 4.5);

    /* emergency */
    let evTarget = this.metrics.emergency;
    if (this.evLog.length) {
      const done = this.evLog.filter(e => e.time != null);
      if (done.length) {
        let t = 0; for (const e of done) t += e.time;
        const avg = t / done.length;
        evTarget = clamp(100 - clamp01((avg - 45) / 150) * 82, 0, 100);
      } else if (this.activeEv) {
        evTarget = Math.max(18, 100 - clamp01((this.time - this.activeEv.spawnTime - 30) / 80) * 60);
      }
    }
    this.metrics.emergency += (evTarget - this.metrics.emergency) * clamp01(mdt / 2.5);

    this.pushHistory();
  }

  pushHistory() {
    const h = this.history;
    const push = (k, v) => { h[k].push(v); if (h[k].length > 150) h[k].shift(); };
    push('flow', this.metrics.flow);
    push('congestion', this.metrics.congestion);
    push('stability', this.metrics.stability);
    push('satisfaction', this.metrics.satisfaction);
    push('emergency', this.metrics.emergency);
    push('budget', (this.budget / CFG.startBudget) * 100);
  }

  /* ---------- interventions ---------- */

  spend(cost) {
    if (this.finished) return false;          /* the run is closed for decisions */
    if (cost > this.budget) return false;
    this.budget -= cost; this.spent += cost;
    return true;
  }

  snapshot() {
    const nodeWait = {}, nodeCong = {}, roadSat = {};
    for (const n of this.nodes) { nodeWait[n.id] = n.waitEma; nodeCong[n.id] = n.congestion; }
    for (const rd of this.roads) roadSat[rd.name + (rd.rev ? '/rev' : '')] = rd.saturation;
    return { nodeWait, nodeCong, roadSat };
  }

  recordIntervention(label, detail, cost, spec, undo) {
    /* Repeated nudges at the same control surface are one engineering decision,
       not eight. Coalesce them so the post-run analysis reads as a decision log.
       The undo snapshot is deliberately not refreshed on coalesce: the original
       one still describes the state before the first nudge, which is exactly
       where a revert should land. */
    const key = label + '|' + JSON.stringify(spec || {});
    const last = this.interventions[this.interventions.length - 1];
    if (last && last.key === key && this.time - last.t < 35) {
      last.detail = detail;
      last.cost += cost;
      last.measureAt = this.time + 26;
      last.after = null;
      return last;
    }
    const rec = {
      id: ++this.tripSeq, key, label, detail, cost, spec,
      t: this.time,
      clock: formatClock(this.scenario.startClock, this.time, CFG.clockRate),
      before: this.snapshot(),
      after: null,
      undo: undo || null,
      measureAt: this.time + 26
    };
    this.interventions.push(rec);
    return rec;
  }

  /* ---------- control state, for reverting a decision ---------- */

  /* Everything the player can set, in one small object. Signal splits, offsets,
     coordination, bus priority, lane bias, closures and the two network-wide
     toggles. Snapshotting the whole thing rather than per-action diffs means a
     revert is exact for every action — including coordination, which touches a
     dozen junctions at once and would be error-prone to unwind incrementally. */
  controlSnapshot() {
    return {
      nodes: this.nodes.map(n => ({
        id: n.id, ns: n.nsGreen, ew: n.ewGreen, off: n.offset, sync: n.syncAxis, bus: n.busPriority
      })),
      links: this.links.map(l => ({ bias: l.bias, closed: l.a.closed })),
      redirection: this.redirection,
      corridorAuthorized: this.corridorAuthorized
    };
  }

  restoreControls(s) {
    for (const e of s.nodes) {
      const n = this.city.nodeById[e.id];
      n.nsGreen = e.ns; n.ewGreen = e.ew; n.offset = e.off;
      n.syncAxis = e.sync; n.busPriority = e.bus;
    }
    this.links.forEach((l, i) => {
      l.bias = s.links[i].bias;
      l.applyLanes();
      l.a.closed = s.links[i].closed;
      l.b.closed = s.links[i].closed;
      l.a.closeReason = l.b.closeReason = s.links[i].closed ? 'ENGINEER CLOSURE' : null;
    });
    this.redirection = s.redirection;
    this.corridorAuthorized = s.corridorAuthorized;
    if (!this.corridorAuthorized) this.corridor = null;
    this.routeVersion++;
    this.rebuildRouting();
    this._live = null;                       // the grade must not be stale
  }

  /* The revoke control. Experimenting is the whole point of the exercise, and it
     is only cheap to experiment if a wrong move can be taken back — so a revert
     refunds the credits and drops the decision from the log entirely. */
  undoLast() {
    if (this.finished) return { ok: false, msg: 'THE SHIFT IS CLOSED' };
    const rec = this.interventions[this.interventions.length - 1];
    if (!rec) return { ok: false, msg: 'NOTHING TO REVERT' };
    if (!rec.undo) return { ok: false, msg: 'THIS DECISION CANNOT BE REVERTED' };
    this.restoreControls(rec.undo);
    this.budget = Math.min(CFG.startBudget, this.budget + rec.cost);
    this.spent = Math.max(0, this.spent - rec.cost);
    this.interventions.pop();
    this.flashes.length = 0;
    this.log('info', 'REVERTED', `${rec.label} — ${rec.detail}. Credits returned.`);
    return { ok: true, refund: rec.cost, msg: 'REVERTED — ' + rec.label };
  }

  /* ---------- diagnosis ---------- */

  /* Wall-clock minutes past midnight. clockRate is simulated *seconds* per real
     second, so this mirrors formatClock's conversion exactly. */
  clockMinutes() { return this.scenario.startClock + (this.time * CFG.clockRate) / 60; }

  /* Which axis is being starved here. Compares the *worst-loaded* approach on
     each axis rather than their averages, because a signal serves one axis at a
     time and it is the standing queue that hurts, not the mean condition. */
  axisPressure(n) {
    let ns = 0, ew = 0;
    for (const rd of n.incoming) {
      if (rd.closed) continue;
      if (rd.axis === 'NS') ns = Math.max(ns, rd.saturation);
      else ew = Math.max(ew, rd.saturation);
    }
    return { ns, ew };
  }

  /* Every asset ranked by how much trouble it is in, so the console can point at
     the problem instead of leaving the engineer to hunt for a red road. */
  hotspots(limit) {
    const out = [];
    for (const n of this.nodes) {
      const w = clamp01(n.waitEma / 45), c = clamp01(n.congestion / 100), q = clamp01(n.queue / 30);
      let sev = (w * 0.42 + c * 0.38 + q * 0.20) * 100;
      if (n.outage) sev = Math.min(100, sev + 22);
      out.push({
        kind: 'node', id: n.id, name: n.name, sev,
        detail: `${Math.round(n.queue)} queued \u00b7 ${n.waitEma.toFixed(0)}s wait`,
        x: n.x, y: n.y
      });
    }
    for (const rd of this.roads) {
      if (rd.rev || rd.closed || rd.saturation < 0.72) continue;
      out.push({
        kind: 'road', name: rd.name, rev: rd.rev,
        sev: clamp01(rd.saturation) * 100 * (rd.incident ? 1.08 : 1),
        detail: `${Math.round(rd.saturation * 100)}% full${rd.incident ? ' \u00b7 incident' : ''}`,
        x: rd.mid.x, y: rd.mid.y
      });
    }
    out.sort((a, b) => b.sev - a.sev);
    return out.slice(0, limit || 4);
  }

  /* Plain-language guidance: what to look at, and what is worth trying there.
     Every line is derived from the same measured state the map is drawn from, so
     the advice cannot drift away from what is actually happening. */
  advisory() {
    const list = [];
    const ev = this.activeEv;

    if (ev && !this.corridorAuthorized && !this.corridorActive()) {
      const dest = this.city.nodeById[ev.destNode];
      list.push({
        kind: 'corridor', urgency: 'crit', title: 'Response vehicle en route',
        detail: `A response vehicle is inbound to ${dest ? dest.name : 'the incident'}. ` +
          'Authorising a corridor holds cross traffic so it can clear each junction on the way.',
        brief: 'response vehicle en route',
        action: 'AUTHORISE'
      });
    }

    for (const s of this.hotspots(3)) {
      if (s.kind === 'node') {
        const n = this.city.nodeById[s.id];
        if (n.outage) {
          list.push({
            kind: 'node', id: n.id, severity: 'crit', title: n.name, x: n.x, y: n.y, action: 'VIEW',
            brief: 'all-way flash · no control',
            detail: 'Signals are dark on all-way flash. Retiming will do nothing here — move traffic around it and let the fault clear.'
          });
          continue;
        }
        const p = this.axisPressure(n);
        const share = n.nsGreen / Math.max(1, n.nsGreen + n.ewGreen);
        const nsP = Math.round(p.ns * 100), ewP = Math.round(p.ew * 100);
        let detail, preset = null;
        /* Rebalancing only helps if the favoured axis has somewhere to put the
           traffic. When both axes are near saturation there is no spare capacity
           to move green *to*, and reallocating merely relocates the queue — so
           the saturated-either-way case is answered as a symptom, not a fix. */
        /* A signal plan needs time to work. Recommending a change faster than the
           queues it governs can respond to produces flip-flopping between splits,
           which costs a lost phase every time and leaves both streets worse. This
           is real practice as well as a game rule: plans are held for a settling
           period before being re-judged. */
        const settling = (this.time - (n.planAt ?? -1e9)) < 90;
        const nsStarved = !settling && p.ns > 0.55 && p.ns - p.ew > 0.16 && p.ew < 0.8;
        const ewStarved = !settling && p.ew > 0.55 && p.ew - p.ns > 0.16 && p.ns < 0.8;
        if (p.ns > 0.78 && p.ew > 0.78) {
          detail = `Both axes are saturated (${nsP}% / ${ewP}%). No signal split can clear this — ` +
            'there is nowhere for the traffic to go. It is a symptom; the cause is upstream, or the demand itself.';
        } else if (nsStarved && share < 0.6) {
          detail = `The north-south approaches are the fuller pair (${nsP}% v ${ewP}%) but NS holds only ` +
            `${Math.round(share * 100)}% of the green, and the east-west side still has room. Favouring NS would clear it.`;
          preset = 'NS';
        } else if (ewStarved && share > 0.4) {
          detail = `The east-west approaches are the fuller pair (${ewP}% v ${nsP}%) but EW holds only ` +
            `${Math.round((1 - share) * 100)}% of the green, and the north-south side still has room. Favouring EW would clear it.`;
          preset = 'EW';
        } else if (p.ns > 0.7 && p.ew > 0.7) {
          detail = `Both axes are heavily loaded (${nsP}% / ${ewP}%). The split here is already matched to demand, ` +
            'so this junction is a symptom — the cause is what is feeding it.';
        } else if (n.busPriority) {
          detail = `Bus priority is armed, holding the cross phase for transit. That is deliberate — ` +
            'the cost shows up as extra waiting on the side street.';
        } else {
          detail = `The green split already matches the approach loads (${nsP}% / ${ewP}%). ` +
            'Changing it here would move the queue rather than clear it.';
        }
        list.push({ kind: 'node', id: n.id, severity: 'warn', title: n.name, detail, preset, action: 'VIEW', x: n.x, y: n.y,
          brief: `${nsP}% / ${ewP}% approach load` });
      } else {
        const rd = this.roads.find(r => r.name === s.name && r.rev === s.rev);
        const other = rd ? (rd.link.a === rd ? rd.link.b : rd.link.a) : null;
        let detail;
        if (rd && rd.incident) {
          detail = 'An incident is holding this segment. Traffic will only move around it — reroute, or route emergency traffic through.';
        } else if (other && rd && rd.lanes > other.lanes) {
          detail = `Running at ${s.detail}, and the lanes are already biased this way. The opposing direction is the one carrying the cost.`;
        } else {
          detail = `Running at ${s.detail}. Shifting a lane here adds capacity on this side and removes it from the other.`;
        }
        list.push({ kind: 'road', name: s.name, rev: s.rev, severity: 'warn', title: s.name, detail, action: 'VIEW', x: s.x, y: s.y,
          brief: s.detail });
      }
    }
    return list;
  }

  /* Scenario objectives, evaluated against the same live report the grade uses. */
  objectiveStatus() {
    const R = this.liveReport();
    const read = (o) => {
      switch (o.key) {
        case 'avgWait': return R.avgWait;
        case 'avgCong': return R.avgCong;
        case 'servedRatio': return R.servedRatio * 100;
        case 'emergency': return R.scores.emergency;
        case 'budget': return R.budget;
        case 'stability': return R.stability;
        default: return 0;
      }
    };
    return (this.scenario.objectives || []).map(o => {
      const value = read(o);
      const met = o.dir === 'above' ? value >= o.target : value <= o.target;
      const prog = met ? 1 : (o.dir === 'above'
        ? clamp01(value / o.target)
        : clamp01(o.target / Math.max(0.001, value)));
      return { label: o.label, unit: o.unit, dir: o.dir, target: o.target, value, met, prog };
    });
  }

  settleInterventions() {
    for (const rec of this.interventions) {
      if (!rec.after && this.time >= rec.measureAt) {
        rec.after = this.snapshot();
        this.emitFlashes(rec);
      }
    }
  }

  /* ---------- consequence badges ---------- */

  flash(x, y, text, kind) {
    const col = kind === 'good' ? '#4fbe8d' : kind === 'bad' ? '#d05a4e' : '#d7a23f';
    this.flashes.push({ x, y, text, col, born: this.time, life: 7 });
    if (this.flashes.length > 40) this.flashes.shift();
  }

  roadNote(name) {
    const rd = this.roads.find(r => r.name === name && !r.rev) || this.roads.find(r => r.name === name);
    if (!rd) return null;
    return rd.posAt(rd.len * 0.5, { x: 0, y: 0, angle: 0 });
  }

  /* Turn a settled intervention into map badges: what moved, and where. The
     report explains it in prose; this is the same measurement shown in place,
     so a knock-on three junctions away is impossible to miss. */
  emitFlashes(rec) {
    const spec = rec.spec || {};
    const group = (spec.group && spec.group.length) ? spec.group
      : (spec.nodeId != null ? [spec.nodeId] : []);
    const inGroup = new Set(group);
    const WAIT_SIG = 2.5, SAT_SIG = 5, CONG_SIG = 6;

    /* the surface that was actually touched */
    if (spec.nodeId != null) {
      const n = this.city.nodeById[spec.nodeId];
      const b = rec.before.nodeWait[spec.nodeId] || 0;
      const d = (rec.after.nodeWait[spec.nodeId] || 0) - b;
      if (n && Math.abs(d) >= WAIT_SIG) {
        this.flash(n.x, n.y, `${d > 0 ? '+' : '\u2212'}${Math.abs(d).toFixed(1)}s WAIT`, d < 0 ? 'good' : 'bad');
      }
    } else if (spec.roadName && !spec.closed) {
      /* A closure is excluded here: "−71% load" on a road that is now shut is a
         tautology, and the badges that matter are the knock-ons it causes. */
      const note = this.roadNote(spec.roadName);
      const b = (rec.before.roadSat[spec.roadName] || 0) * 100;
      const d = (rec.after.roadSat[spec.roadName] || 0) * 100 - b;
      if (note && Math.abs(d) >= SAT_SIG) {
        this.flash(note.x, note.y, `${d > 0 ? '+' : '\u2212'}${Math.abs(d).toFixed(0)}% LOAD`, d < 0 ? 'good' : 'bad');
      }
    }

    /* the largest adverse second-order effect, reported wherever it landed */
    let worst = null;
    for (const n of this.nodes) {
      if (inGroup.has(n.id)) continue;
      const dc = rec.after.nodeCong[n.id] - rec.before.nodeCong[n.id];
      const dw = rec.after.nodeWait[n.id] - rec.before.nodeWait[n.id];
      const sev = Math.max(dc / (CONG_SIG * 1.4), dw / (WAIT_SIG * 1.4));
      if (sev >= 1 && (!worst || sev > worst.sev)) worst = { sev, n, dc, dw };
    }
    if (worst) {
      const byCong = worst.dc / (CONG_SIG * 1.4) >= worst.dw / (WAIT_SIG * 1.4);
      this.flash(worst.n.x, worst.n.y,
        byCong ? `+${worst.dc.toFixed(0)} CONG` : `+${worst.dw.toFixed(1)}s WAIT`, 'bad');
      return;
    }

    /* nothing got worse — show the best improvement elsewhere, if there is one */
    let best = null;
    for (const n of this.nodes) {
      if (inGroup.has(n.id)) continue;
      const dc = rec.after.nodeCong[n.id] - rec.before.nodeCong[n.id];
      if (dc <= -CONG_SIG && (!best || dc < best.dc)) best = { n, dc };
    }
    if (best) this.flash(best.n.x, best.n.y, `\u2212${Math.abs(best.dc).toFixed(0)} CONG`, 'good');
  }

  /* Post-run scoring, recomputed on a throttle so the console can display a
     live grade from the same formula that produces the final report. */
  liveReport() {
    if (this._live && this.time - this._liveAt < 0.6) return this._live;
    this._liveAt = this.time;
    this._live = this.report();
    return this._live;
  }

  adjustGreen(nodeId, axis, delta) {
    const n = this.city.nodeById[nodeId];
    const cost = CFG.costs.signal;
    if (!this.spend(cost)) return { ok: false, msg: 'INSUFFICIENT BUDGET' };
    const undo = this.controlSnapshot();
    const key = axis === 'NS' ? 'nsGreen' : 'ewGreen';
    const before = n[key];
    n[key] = clamp(n[key] + delta, 6, 46);
    if (n[key] === before) { this.budget += cost; this.spent -= cost; return { ok: false, msg: 'LIMIT REACHED' }; }
    const detail = `${n.name} · ${axis} green ${delta > 0 ? '+' : ''}${delta}s → ${n[key]}s`;
    this.recordIntervention('Signal re-timing', detail, cost, { nodeId, axis }, undo);
    this.log('info', 'CONTROL', `${detail}. Cycle now ${n.cycle}s.`);
    return { ok: true, cost, msg: detail };
  }

  /* One-click rebalance. Most of signal timing is mechanical arithmetic, and the
     engineering judgement is in deciding *whether* to favour an axis at all —
     which is exactly the part left to the player. The 64/36 split is a working
     figure rather than an optimum, and deliberately a moderate one: push the
     green further and the side street starts paying for it, which is the trap
     the shift is meant to teach. */
  applyPreset(nodeId, mode) {
    const n = this.city.nodeById[nodeId];
    if (n.outage) return { ok: false, msg: 'SIGNAL LOSS — NO CONTROL AT THIS JUNCTION' };
    const total = n.nsGreen + n.ewGreen;
    let ns = total * 0.5;
    if (mode === 'NS') ns = total * 0.64;
    else if (mode === 'EW') ns = total * 0.36;
    n.planAt = this.time;
    ns = clamp(Math.round(ns), 6, 46);
    const ew = clamp(total - ns, 6, 46);
    if (ns === n.nsGreen && ew === n.ewGreen) return { ok: false, msg: 'ALREADY AT THAT SPLIT' };
    const cost = CFG.costs.signal;
    if (!this.spend(cost)) return { ok: false, msg: 'INSUFFICIENT BUDGET' };
    const undo = this.controlSnapshot();
    n.nsGreen = ns; n.ewGreen = ew;
    const label = mode === 'NS' ? 'Favour NS' : mode === 'EW' ? 'Favour EW' : 'Balanced split';
    const detail = `${n.name} · NS ${ns}s / EW ${ew}s (cycle ${n.cycle}s)`;
    this.recordIntervention(label, detail, cost, { nodeId, axis: mode, preset: true }, undo);
    this.log('info', 'CONTROL', `${label} — ${detail}.`);
    return { ok: true, cost, msg: detail };
  }

  toggleBusPriority(nodeId) {
    const n = this.city.nodeById[nodeId];
    const cost = CFG.costs.bus;
    if (!n.busPriority) {
      if (!this.spend(cost)) return { ok: false, msg: 'INSUFFICIENT BUDGET' };
      const undo = this.controlSnapshot();
      n.busPriority = true;
      this.recordIntervention('Bus priority enabled', `${n.name} · transit pre-emption armed`, cost, { nodeId }, undo);
      this.log('good', 'POLICY', `${n.name} — transit pre-emption armed. Cross movements will be held.`);
      return { ok: true, cost, msg: 'BUS PRIORITY ENABLED' };
    }
    n.busPriority = false;
    this.log('info', 'POLICY', `${n.name} — transit pre-emption released.`);
    return { ok: true, cost: 0, msg: 'BUS PRIORITY DISABLED' };
  }

  shiftLanes(road, dir) {
    const link = road.link;
    if (link.baseLanes < 2) return { ok: false, msg: 'SINGLE-LANE SEGMENT — NO SURPLUS CAPACITY' };
    const cost = CFG.costs.lanes;
    const nb = clamp(link.bias + dir, -(link.baseLanes - 1), link.baseLanes - 1);
    if (nb === link.bias) return { ok: false, msg: 'ALLOCATION AT LIMIT' };
    if (!this.spend(cost)) return { ok: false, msg: 'INSUFFICIENT BUDGET' };
    const undo = this.controlSnapshot();
    link.bias = nb;
    link.applyLanes();
    this.routeVersion++;
    const detail = `${link.name} · ${link.a.lanes} / ${link.b.lanes} lanes (${link.def.a === road.from.id ? 'A' : 'B'} favoured)`;
    this.recordIntervention('Lane reallocation', detail, cost, { roadName: link.name }, undo);
    this.log('warn', 'GEOMETRY', `${detail}. Opposing approach capacity reduced.`);
    return { ok: true, cost, msg: detail };
  }

  setLinkClosed(rd, closed, reason) {
    const link = rd.link;
    for (const r of link.dirs) { r.closed = closed; r.closeReason = closed ? (reason || 'ADMINISTRATIVE CLOSURE') : null; }
    this.routeVersion++;
    this.rebuildRouting();
  }

  toggleClosure(road) {
    const link = road.link;
    const cost = CFG.costs.closure;
    if (!link.a.closed) {
      if (!this.spend(cost)) return { ok: false, msg: 'INSUFFICIENT BUDGET' };
      const undo = this.controlSnapshot();
      this.setLinkClosed(link.a, true, 'ENGINEER CLOSURE');
      const detail = `${link.name} · segment removed from network`;
      this.recordIntervention('Road closure', detail, cost, { roadName: link.name, closed: true }, undo);
      this.log('crit', 'CLOSURE', `${detail}. Traffic redistributing onto remaining corridors.`);
      return { ok: true, cost, msg: detail };
    }
    this.setLinkClosed(link.a, false);
    this.log('good', 'REOPENED', `${link.name} returned to service.`);
    return { ok: true, cost: 0, msg: 'SEGMENT REOPENED' };
  }

  authorizeCorridor() {
    if (!this.activeEv) return { ok: false, msg: 'NO ACTIVE EMERGENCY VEHICLE' };
    if (this.corridorAuthorized) return { ok: false, msg: 'CORRIDOR ALREADY AUTHORISED' };
    const cost = CFG.costs.corridor;
    if (!this.spend(cost)) return { ok: false, msg: 'INSUFFICIENT BUDGET' };
    const ev = this.activeEv;
    const nodes = [];
    const seen = new Set();
    for (let i = 0; i <= ev.pathIdx; i++) {
      const rd = ev.path[i];
      if (!seen.has(rd.to.id)) { seen.add(rd.to.id); nodes.push({ nodeId: rd.to.id, axis: rd.axis }); }
    }
    for (let i = ev.pathIdx + 1; i < ev.path.length; i++) {
      const rd = ev.path[i];
      if (!seen.has(rd.to.id)) { seen.add(rd.to.id); nodes.push({ nodeId: rd.to.id, axis: rd.axis }); }
    }
    /* nodeAxis lets the pre-emption loop answer "which movement does the
       corridor serve here" without rescanning the route every tick. */
    const nodeAxis = {};
    for (const e of nodes) nodeAxis[e.nodeId] = e.axis;
    const undo = this.controlSnapshot();
    this.corridor = { nodes, roadSet: new Set(ev.path), nodeAxis };
    this.corridorAuthorized = true;
    const detail = `Corridor cleared across ${nodes.length} junctions along ${ev.path.length} segments`;
    this.recordIntervention('Emergency corridor', detail, cost, { ev: true }, undo);
    this.log('crit', 'CORRIDOR', `${detail}. Cross movements held for the duration of the response.`);
    return { ok: true, cost, msg: 'CORRIDOR AUTHORISED' };
  }

  toggleRedirection() {
    const cost = CFG.costs.redirect;
    if (!this.redirection) {
      if (!this.spend(cost)) return { ok: false, msg: 'INSUFFICIENT BUDGET' };
      const undo = this.controlSnapshot();
      this.redirection = true;
      this.rebuildRouting();
      this.recordIntervention('Traffic redirection', 'Routing cost weighted by observed saturation — vehicles reroute around congestion', cost, { global: true }, undo);
      this.log('warn', 'ROUTING', 'Saturation-weighted rerouting enabled. Vehicles will leave loaded corridors.');
      return { ok: true, cost, msg: 'REDIRECTION ENABLED' };
    }
    this.redirection = false;
    this.rebuildRouting();
    this.log('info', 'ROUTING', 'Saturation-weighted rerouting disabled. Free-flow routing restored.');
    return { ok: true, cost: 0, msg: 'REDIRECTION DISABLED' };
  }

  syncCorridor(nodeId, axis) {
    const node = this.city.nodeById[nodeId];
    const cost = CFG.costs.sync;
    if (!this.spend(cost)) return { ok: false, msg: 'INSUFFICIENT BUDGET' };
    const group = this.nodes.filter(n => (axis === 'EW' ? n.r === node.r : n.c === node.c));
    if (group.length < 2) { this.budget += cost; this.spent -= cost; return { ok: false, msg: 'NO ADJACENT JUNCTIONS' }; }
    const undo = this.controlSnapshot();
    group.sort((a, b) => (axis === 'EW' ? a.x - b.x : a.y - b.y));

    /* Coordination harmonises the cycle length and sets progression offsets.
       It deliberately does NOT reallocate green between movements: the split
       at each junction is a separate decision the engineer has already made,
       and silently changing it would mask the trade-off rather than express it.
       The common cycle is the LOWER median of the group: when a corridor is
       split between short and long cycles, breaking the tie toward the short
       cycle repairs the legacy outlier instead of propagating it. */
    const cycles = group.map(n => n.cycle).sort((a, b) => a - b);
    const cycle = cycles[Math.floor((cycles.length - 1) / 2)];
    for (const n of group) {
      const fixed = 2 * (n.yellow + n.allRed);
      const greenTotal = Math.max(12, cycle - fixed);
      const tot = n.nsGreen + n.ewGreen;
      n.nsGreen = clamp(Math.round(greenTotal * (n.nsGreen / tot)), 6, 46);
      n.ewGreen = clamp(greenTotal - n.nsGreen, 6, 46);
      n.syncAxis = axis;
    }
    const origin = group[0];
    for (const n of group) {
      const dist = axis === 'EW' ? Math.abs(n.x - origin.x) : Math.abs(n.y - origin.y);
      const travel = dist / CFG.platoonSpeed;
      const greenStart = axis === 'EW' ? n.nsGreen + n.yellow + n.allRed : 0;
      n.offset = ((greenStart - travel) % cycle + cycle) % cycle;
    }
    const detail = `${axis === 'EW' ? 'ROW' : 'COLUMN'} through ${group.map(n => n.name).join(' → ')} · ${cycle}s common cycle`;
    this.recordIntervention('Signal synchronisation', detail, cost, { nodeId, axis, group: group.map(n => n.id) }, undo);
    this.log('warn', 'COORDINATION', `Progression established on the ${axis === 'EW' ? 'east-west' : 'north-south'} corridor — ${cycle}s common cycle across ${group.length} junctions.`);
    return { ok: true, cost, msg: `GREEN WAVE — ${group.length} JUNCTIONS` };
  }

  /* ---------- loop ---------- */

  step(dt) {
    if (this.finished) return;
    this.time += dt;
    if (this.time >= this.duration) { this.time = this.duration; this.finish(); return; }

    this.dispatchEvents();
    this.trySpawnEv();
    this.updateStreams(dt);
    this.updateDemand(dt);
    this.updateBusses(dt);
    this.tryPlacePending();
    this.updatePreemption();
    this.updateRoads(dt);
    this.updateMetrics(dt);
    this.clearExpired();
    this.settleInterventions();
    if (this.flashes.length) this.flashes = this.flashes.filter(f => this.time - f.born < f.life);

    this.routingTimer += dt;
    if (this.routingTimer > 4) { this.routingTimer = 0; this.rebuildRouting(); }
    this.rerouteTimer += dt;
    if (this.rerouteTimer > 5) { this.rerouteTimer = 0; this.rerouteCars(); }

    if (this.corridorAuthorized && !this.activeEv) {
      this.corridorAuthorized = false;
      this.corridor = null;
      this.log('good', 'CORRIDOR', 'Response complete. Corridor pre-emption released.');
    }
  }

  finish() {
    this.finished = true;
    for (const rec of this.interventions) if (!rec.after) rec.after = this.snapshot();
    /* An ambulance still in the network when the shift ends is an unfinished
       response, not a missing measurement. Close the log book so the analysis
       can report it as a failure rather than as "no data". */
    for (const e of this.evLog) {
      if (e.time == null) { e.incomplete = true; e.end = this.time; }
    }
    if (this.activeEv) this.activeEv = null;
    this.corridorAuthorized = false;
    this.corridor = null;
    this.log('info', 'RUN COMPLETE', 'Simulated day ended. Compiling post-run analysis.');
  }

  /* ---------- reporting ---------- */

  report() {
    const done = this.completed.filter(r => r.t > this.time - 300);
    let tt = 0, wt = 0, n = 0;
    for (const r of done) { tt += r.tt; wt += r.wait; n++; }
    const avgTravel = n ? tt / n : this.avgTravel;
    const avgWait = n ? wt / n : this.avgWait;
    const avgCong = this.samples ? this.sumCongestion / this.samples : this.metrics.congestion;
    const avgQueue = this.samples ? this.sumQueue / this.samples : this.avgQueue;
    const evDone = this.evLog.filter(e => e.time != null);
    const evAvg = evDone.length ? evDone.reduce((a, e) => a + e.time, 0) / evDone.length : null;
    const evRequests = this.evLog.length;
    const evCompletion = evRequests ? evDone.length / evRequests : 1;

    const ttRatio = clamp(REF_TRAVEL_TIME / Math.max(12, avgTravel), 0, 1.2);
    const trafficEff = clamp01(this.servedRatio * 0.55 + Math.min(1, ttRatio) * 0.45) * 100;

    const resilience = clamp(
      100
      - clamp01((this.peakCongestion - 42) / 45) * 50
      - clamp01((avgQueue - 4) / 16) * 28
      - clamp01(this.abandonRate / 0.35) * 14,
      0, 100);
    const publicImpact = clamp(this.metrics.satisfaction * 0.78 + clamp01(1 - this.abandonRate / 0.3) * 22, 0, 100);
    /* Emergency performance is scored on response time AND on whether the
       response actually arrived. An ambulance that never reached the incident
       must not be scored by the absence of data. */
    const evBase = evAvg == null ? 0 : clamp(100 - clamp01((evAvg - 45) / 150) * 82, 0, 100);
    const emergencyPerf = evRequests === 0
      ? this.metrics.emergency
      : clamp(8 + evBase * 0.92 * evCompletion, 0, 100);
    const stabilityScore = this.metrics.stability;

    /* Resource efficiency is return on spend, not frugality. Scoring an
       engineer highly for never touching the controls would be perverse — the
       budget exists to be deployed. Value delivered per credit used. */
    const spentFrac = this.spent / CFG.startBudget;
    const valueGain = clamp01((trafficEff * 0.55 + publicImpact * 0.45 - 58) / 30);
    const resourceEff = clamp(50 + valueGain * 55 - clamp01(spentFrac) * 22, 0, 100);

    const composite = trafficEff * 0.28 + resilience * 0.18 + resourceEff * 0.16 + publicImpact * 0.20 + emergencyPerf * 0.12 + stabilityScore * 0.06;

    let rating = 'MARGINAL';
    if (composite >= 82) rating = 'EXEMPLARY';
    else if (composite >= 72) rating = 'STRONG';
    else if (composite >= 62) rating = 'COMPETENT';
    else if (composite >= 50) rating = 'DEGRADED';

    return {
      avgTravel, avgWait, avgCong, avgQueue,
      maxCong: this.peakCongestion,
      budget: this.budget, spent: this.spent,
      evAvg, evRequests, evCompleted: evDone.length, trips: done.length,
      servedRatio: this.servedRatio,
      requests: this.carRequests,
      completions: this.carCompletions,
      peakCars: this.peakCars,
      abandoned: this.abandonedCount,
      satisfaction: this.metrics.satisfaction,
      stability: this.metrics.stability,
      abandonment: this.abandonRate,
      scores: {
        traffic: trafficEff, resilience, resource: resourceEff,
        publicScore: publicImpact, emergency: emergencyPerf, stability: stabilityScore
      },
      composite, rating
    };
  }

  consequences() {
    /* Effects are reported as absolute deltas — seconds of wait and points of
       saturation — because relative change on a near-empty baseline produces
       meaningless four- and five-digit percentages. A relative figure is only
       quoted when the baseline is substantial enough to mean something. */
    const out = [];
    const WAIT_SIG = 1.5, SAT_SIG = 5, CONG_SIG = 6;

    for (const rec of this.interventions) {
      if (!rec.after) continue;
      const lines = [];
      const spec = rec.spec || {};
      const targetNode = spec.nodeId != null ? spec.nodeId : null;
      const targetRoad = spec.roadName || null;

      if (targetNode != null) {
        /* A coordination decision covers a whole corridor, so it is reported
           against the corridor mean rather than one arbitrary junction. */
        const group = (spec.group && spec.group.length) ? spec.group : [targetNode];
        let b = 0, a = 0;
        for (const id of group) { b += rec.before.nodeWait[id] || 0; a += rec.after.nodeWait[id] || 0; }
        b /= group.length; a /= group.length;
        const d = a - b;
        const grouped = group.length > 1;
        const nm = grouped ? `${group.length} coordinated junctions` : this.city.nodeById[targetNode].name;
        const at = grouped ? 'across' : 'at';
        if (d <= -WAIT_SIG) {
          const rel = b >= 3 ? ` (${Math.round((Math.abs(d) / b) * 100)}% below the baseline mean)` : '';
          lines.push(`cut average wait ${at} <b>${nm}</b> from ${b.toFixed(1)}s to <span class="pos">${a.toFixed(1)}s</span>${rel}`);
        } else if (d >= WAIT_SIG) {
          lines.push(`raised average wait ${at} <b>${nm}</b> from ${b.toFixed(1)}s to <span class="neg">${a.toFixed(1)}s</span>`);
        } else {
          lines.push(`left average wait ${at} <b>${nm}</b> broadly unchanged (${b.toFixed(1)}s → ${a.toFixed(1)}s)`);
        }

        /* the largest adverse change anywhere else in the network */
        const inGroup = new Set(group);
        let worst = null;
        for (const n of this.nodes) {
          if (inGroup.has(n.id)) continue;
          const dc = rec.after.nodeCong[n.id] - rec.before.nodeCong[n.id];
          const dw = rec.after.nodeWait[n.id] - rec.before.nodeWait[n.id];
          if (dc >= CONG_SIG) {
            const sev = dc / 10;
            if (!worst || sev > worst.sev) worst = {
              sev, txt: `congestion at <b>${n.name}</b> rose <span class="neg">${dc.toFixed(0)} points</span> ` +
                `(${rec.before.nodeCong[n.id].toFixed(0)}% → ${rec.after.nodeCong[n.id].toFixed(0)}%)`
            };
          } else if (dw >= 2.5) {
            const sev = dw / 5;
            if (!worst || sev > worst.sev) worst = {
              sev, txt: `waiting time at <b>${n.name}</b> rose <span class="neg">${dw.toFixed(1)}s</span>`
            };
          }
        }
        if (worst) lines.push('but ' + worst.txt);

      } else if (targetRoad) {
        const b = (rec.before.roadSat[targetRoad] || 0) * 100;
        const a = (rec.after.roadSat[targetRoad] || 0) * 100;
        const d = a - b;
        if (spec.closed) {
          /* A closed link reads as zero saturation by definition. Reporting that
             as an achievement would say nothing — a closure is only interesting
             for where its traffic ended up, which is the line below. */
          lines.push(`took <b>${targetRoad}</b> out of service entirely`);
        } else if (d <= -SAT_SIG) lines.push(`reduced saturation on <b>${targetRoad}</b> from ${b.toFixed(0)}% to <span class="pos">${a.toFixed(0)}%</span>`);
        else if (d >= SAT_SIG) lines.push(`raised saturation on <b>${targetRoad}</b> by <span class="neg">${d.toFixed(0)} points</span>`);
        else lines.push(`left <b>${targetRoad}</b> effectively unchanged at ${a.toFixed(0)}% saturation`);

        let best = null;
        for (const k in rec.after.roadSat) {
          if (k === targetRoad) continue;
          const dd = (rec.after.roadSat[k] - rec.before.roadSat[k]) * 100;
          if (dd >= 7 && (!best || dd > best.d)) best = { d: dd, k };
        }
        if (best) lines.push(`with load displaced onto <b>${best.k.replace('/rev', '')}</b> (<span class="neg">+${best.d.toFixed(0)} points</span> saturation)`);

      } else {
        let sumW = 0, sumS = 0, nRoads = 0, worst = null;
        for (const n of this.nodes) {
          sumW += rec.after.nodeWait[n.id] - rec.before.nodeWait[n.id];
          const dc = rec.after.nodeCong[n.id] - rec.before.nodeCong[n.id];
          if (dc >= CONG_SIG && (!worst || dc > worst.d)) worst = { d: dc, n: n.name };
        }
        for (const k in rec.after.roadSat) { sumS += (rec.after.roadSat[k] - rec.before.roadSat[k]) * 100; nRoads++; }
        const mw = sumW / Math.max(1, this.nodes.length);
        const ms = sumS / Math.max(1, nRoads);
        lines.push(ms < -0.8
          ? `lowered network-average saturation by <span class="pos">${Math.abs(ms).toFixed(1)} points</span>, mean junction wait ${mw >= 0 ? '+' : ''}${mw.toFixed(1)}s`
          : `moved network-average saturation ${ms >= 0 ? '+' : ''}${ms.toFixed(1)} points, mean junction wait ${mw >= 0 ? '+' : ''}${mw.toFixed(1)}s`);
        if (worst) lines.push(`but pushed <b>${worst.n}</b> a further ${worst.d.toFixed(0)} points into congestion`);
      }
      out.push({ rec, lines });
    }
    return out;
  }
}

/* ============================== 8. RENDERER =============================== */

/* The world is a fixed drawing box. Terrain, roads and vehicles all live in it;
   only text and chrome are positioned in device space so they stay crisp. */
const WORLD = { x: 24, y: 68, w: 1152, h: 688 };
const DISTRICT_BANDS = [
  { y0: 74, y1: 285, label: 'NORTH RIDGE' },
  { y0: 285, y1: 515, label: 'CENTRAL DISTRICT' },
  { y0: 515, y1: 748, label: 'SOUTH WORKS' }
];
const HARBOUR = { x: 1026, y: 74, w: 150, h: 248 };

/* Recognisable city fabric: a jittered block lattice with a park and a harbour
   basin. Purely presentational — the simulation never reads any of it — but the
   map has to read as a city rather than as a wiring diagram. */
function buildTerrain() {
  const rng = mulberry32(90210);
  const X = [180, 460, 740, 1010];
  const Y = [170, 400, 630];
  const CLR = 27;                       // corridor half-clearance, world units
  const bands = (arr, lo, hi) => {
    const out = [[lo, arr[0] - CLR]];
    for (let i = 0; i < arr.length - 1; i++) out.push([arr[i] + CLR, arr[i + 1] - CLR]);
    out.push([arr[arr.length - 1] + CLR, hi]);
    return out;
  };
  const xb = bands(X, 44, 1156);
  const yb = bands(Y, 88, 744);
  const buildings = [];
  const inHarbour = (x, y) => x > HARBOUR.x - 20 && y < HARBOUR.y + HARBOUR.h + 8;
  for (const [x0, x1] of xb) {
    for (const [y0, y1] of yb) {
      const w = x1 - x0, h = y1 - y0;
      if (w < 46 || h < 42) continue;
      if (inHarbour(x0, y0)) continue;
      const cols = Math.max(1, Math.min(4, Math.round(w / 76)));
      const rows = Math.max(1, Math.min(4, Math.round(h / 66)));
      const cw = w / cols, ch = h / rows;
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          if (rng() < 0.14) continue;              // occasional vacant lot
          const pad = 3 + rng() * 5;
          const bw = cw - pad * 2 - rng() * 7;
          const bh = ch - pad * 2 - rng() * 7;
          if (bw < 13 || bh < 11) continue;
          buildings.push({
            x: x0 + i * cw + pad + rng() * 3,
            y: y0 + j * ch + pad + rng() * 3,
            w: bw, h: bh, tone: rng()
          });
        }
      }
    }
  }
  const park = { x: X[2] + CLR, y: Y[1] + CLR, w: X[3] - X[2] - CLR * 2, h: Y[2] - Y[1] - CLR * 2 };
  /* Tree canopy positions. The park gets a structured grove — perimeter rows
     plus a loose interior cluster — and two street groves soften the harder
     blocks. Deterministic, so every run draws the same city. */
  const trees = [];
  const plant = (x, y, r) => trees.push({ x, y, r: r * (0.82 + rng() * 0.36), tone: rng() });
  const pw = park.w, ph = park.h;
  for (let i = 0; i < 6; i++) {                          // perimeter rows
    plant(park.x + pw * (0.10 + i * 0.16), park.y + ph * 0.12, 9);
    plant(park.x + pw * (0.10 + i * 0.16), park.y + ph * 0.88, 9);
  }
  for (let j = 0; j < 3; j++) {
    plant(park.x + pw * 0.10, park.y + ph * (0.30 + j * 0.20), 9);
    plant(park.x + pw * 0.90, park.y + ph * (0.30 + j * 0.20), 9);
  }
  for (let i = 0; i < 7; i++)                            // interior cluster
    plant(park.x + pw * (0.30 + rng() * 0.40), park.y + ph * (0.28 + rng() * 0.44), 11);
  for (let i = 0; i < 5; i++)                            // street groves — kept clear of
    plant(xb[0][0] + 56 + rng() * (xb[0][1] - xb[0][0] - 86), yb[1][0] + 96 + rng() * (yb[1][1] - yb[1][0] - 120), 8); // district labels
  for (let i = 0; i < 5; i++)
    plant(xb[3][0] + 26 + rng() * (xb[3][1] - xb[3][0] - 52), yb[2][0] + 24 + rng() * (yb[2][1] - yb[2][0] - 48), 8);
  return { buildings, park, trees };
}

/* The HUD floats over the map, so the camera fits the network into the region
   that is *not* covered by chrome. These numbers mirror the CSS custom
   properties; keeping them here means the fit stays correct at any size. */
/* Deterministic pseudo-random in [0,1) from two integers. Used for weather
   placement so rain falls the same way in every frame it is redrawn. */
function hash01(i, k) {
  const v = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

/* Dashboard ticks (~6/s) between advisory re-evaluations. Advice that rewrites
   itself several times a second is unreadable and unclickable. */
const ADV_REFRESH_TICKS = 8;

const HUD = {
  gutter: 10, topbar: 54, metrics: 64, panel: 320, strip: 44, ticker: 30,
  get left() { return this.gutter + 6; },
  get right() { return this.gutter + this.panel + 24; },
  get top() { return this.gutter + this.topbar + 8 + this.metrics + 18; },
  get bottom() { return this.gutter + this.strip + 8 + this.ticker + 10; }
};

class Renderer {
  constructor(canvas, sim) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.sim = sim;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    /* `cam` is what is drawn; `camT` is where it is heading. Easing between the
       two is what makes a focus move feel like a camera rather than a jump. */
    this.cam = { scale: 1, ox: 0, oy: 0 };
    this.camT = { scale: 1, ox: 0, oy: 0 };
    this.camRate = 16;
    this.hover = null;
    this.selected = null;
    this.t = 0;
    /* What the map is showing. The console draws one city and lets the operator
       choose which reading of it to look at, rather than having separate views. */
    this.layers = { heat: true, names: true, transit: true };
    this.terrain = buildTerrain();
    this._laneCache = new Map();
    this._bounds = null;
    this.resize(true);
  }
  setSim(sim) { this.sim = sim; this._bounds = null; }

  resize(refit) {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(320, rect.width), h = Math.max(240, rect.height);
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this.cw = w; this.ch = h;
    this.minScale = null;
    if (refit) this.fit(true); else this.fit(false);
  }

  /* ---------- camera ---------- */

  /* Footprint of the *network* rather than of the world box. The city fabric
     deliberately runs off-frame, so fitting the roads makes the network fill
     the view instead of floating inside a margin of empty ground. */
  networkBounds() {
    if (this._bounds && !this._boundsStale) return this._bounds;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const rd of this.sim.roads) {
      const pad = this.roadWidth(rd) / 2 + rd.link.halfOffset;
      for (const p of rd.pts) {
        if (p.x - pad < x0) x0 = p.x - pad;
        if (p.y - pad < y0) y0 = p.y - pad;
        if (p.x + pad > x1) x1 = p.x + pad;
        if (p.y + pad > y1) y1 = p.y + pad;
      }
    }
    this._bounds = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    this._boundsStale = false;
    return this._bounds;
  }

  /* The rectangle of the viewport actually available to the map. */
  freeRect() {
    const l = Math.min(HUD.left, this.cw * 0.2);
    const r = Math.min(HUD.right, this.cw * 0.34);
    const t = Math.min(HUD.top, this.ch * 0.3);
    const b = Math.min(HUD.bottom, this.ch * 0.26);
    return { x: l, y: t, w: Math.max(160, this.cw - l - r), h: Math.max(140, this.ch - t - b) };
  }

  /* Fit the whole network into the free rectangle. `immediate` skips the easing
     so the opening frame is already framed rather than flying in. */
  fit(immediate) {
    if (!this.sim || !this.sim.roads.length) return;
    const b = this.networkBounds();
    const fr = this.freeRect();
    const pad = Math.min(26, fr.w * 0.05);
    const s = Math.min((fr.w - pad * 2) / b.w, (fr.h - pad * 2) / b.h);
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const ox = (fr.x + fr.w / 2) - cx * s;
    const oy = (fr.y + fr.h / 2) - cy * s;
    this.camRate = immediate ? 1e6 : 7;
    this.setCam({ scale: s, ox, oy }, immediate);
    if (!this.minScale) { this.minScale = s * 0.66; this.maxScale = s * 3.4; }
    else { this.minScale = s * 0.66; this.maxScale = s * 3.4; }
  }

  setCam(c, immediate) {
    this.camT.scale = c.scale; this.camT.ox = c.ox; this.camT.oy = c.oy;
    if (immediate) { this.cam.scale = c.scale; this.cam.ox = c.ox; this.cam.oy = c.oy; }
  }

  viewCentre() {
    return {
      x: (this.cw / 2 - this.cam.ox) / this.cam.scale,
      y: (this.ch / 2 - this.cam.oy) / this.cam.scale
    };
  }

  zoomAt(mx, my, factor, immediate) {
    const w = this.toWorld(mx, my);
    const ns = clamp(this.camT.scale * factor, this.minScale || 0.3, this.maxScale || 4);
    const ox = mx - w.x * ns, oy = my - w.y * ns;
    this.camRate = immediate ? 1e6 : 20;
    this.setCam({ scale: ns, ox, oy }, immediate);
  }

  panBy(dx, dy) {
    this.camRate = 1e6;
    this.setCam({ scale: this.camT.scale, ox: this.camT.ox + dx, oy: this.camT.oy + dy }, true);
  }

  /* Centre a world point, optionally at a specific zoom (clamped). */
  focusOn(x, y, wantScale) {
    const fr = this.freeRect();
    const s = clamp(wantScale || this.camT.scale, this.minScale || 0.3, this.maxScale || 4);
    this.camRate = 7;
    this.setCam({
      scale: s,
      ox: (fr.x + fr.w / 2) - x * s,
      oy: (fr.y + fr.h / 2) - y * s
    }, false);
  }

  zoomBy(factor) {
    this.zoomAt(this.cw / 2, this.ch / 2, factor, false);
  }

  /* Pan just enough to bring a world point inside the visible region, leaving
     the zoom alone. Used for keyboard stepping through the network. */
  ensureVisible(x, y) {
    const fr = this.freeRect();
    const p = this.toScreen(x, y);
    const m = 46;
    if (p.x > fr.x + m && p.x < fr.x + fr.w - m && p.y > fr.y + m && p.y < fr.y + fr.h - m) return;
    this.focusOn(x, y, this.camT.scale);
  }

  tick(dt) {
    const k = 1 - Math.exp(-dt * this.camRate);
    const c = this.cam, t = this.camT;
    if (Math.abs(t.scale - c.scale) < 1e-4 && Math.abs(t.ox - c.ox) < 0.05 && Math.abs(t.oy - c.oy) < 0.05) {
      c.scale = t.scale; c.ox = t.ox; c.oy = t.oy;
    } else {
      c.scale += (t.scale - c.scale) * k;
      c.ox += (t.ox - c.ox) * k;
      c.oy += (t.oy - c.oy) * k;
    }
  }

  get scaleView() { return this.cam.scale; }

  toWorld(mx, my) {
    return { x: (mx - this.cam.ox) / this.cam.scale, y: (my - this.cam.oy) / this.cam.scale };
  }
  toScreen(x, y) {
    return { x: x * this.cam.scale + this.cam.ox, y: y * this.cam.scale + this.cam.oy };
  }

  /* ---------- geometry helpers ---------- */

  pathOf(ctx, pts, off) {
    const p = off ? offsetPolyline(pts, off) : pts;
    ctx.beginPath();
    ctx.moveTo(p[0].x, p[0].y);
    for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y);
  }

  /* Lane lines are rebuilt only when a link's lane count changes. */
  laneLine(rd, off) {
    const key = rd.uid + ':' + off;
    let e = this._laneCache.get(key);
    if (!e) {
      e = offsetPolyline(rd.pts, off);
      if (this._laneCache.size > 220) this._laneCache.clear();
      this._laneCache.set(key, e);
    }
    return e;
  }

  roadWidth(rd) { return rd.lanes * CFG.laneWidth; }

  /* Asphalt footprint of a junction: big enough to cover the widest carriageway
     that meets there, so stop lines and kerbs terminate cleanly. */
  junctionExtent(n) {
    let e = 8;
    for (const rd of n.incoming) e = Math.max(e, rd.lanes * CFG.laneWidth / 2 + rd.link.halfOffset);
    for (const rd of n.outgoing) e = Math.max(e, rd.lanes * CFG.laneWidth / 2 + rd.link.halfOffset);
    return e + 1.6;
  }

  draw(dt) {
    const ctx = this.ctx, sim = this.sim;
    this.t += dt;
    this.tick(Math.min(dt, 0.05));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = '#06080b';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!sim) return;

    const c = this.cam;
    ctx.setTransform(this.dpr * c.scale, 0, 0, this.dpr * c.scale, this.dpr * c.ox, this.dpr * c.oy);
    this.drawDistricts(ctx);
    this.drawBlocks(ctx);
    this.drawPark(ctx);
    this.drawTrees(ctx);
    this.drawJunctionSlabs(ctx);
    this.drawRoadCasings(ctx);
    this.drawRoadSurfaces(ctx);
    this.drawLaneMarkings(ctx);
    this.drawStopBars(ctx);
    if (this.layers.transit) this.drawBusRoutes(ctx);
    this.drawCorridor(ctx);
    this.drawCars(ctx);
    this.drawIncidents(ctx);
    this.drawNodes(ctx);
    this.drawSelection(ctx);

    /* device-space pass: text keeps a constant on-screen size and stays sharp
       at any fitted scale */
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    /* Atmosphere is painted between the two passes: the city itself is tinted by
       the hour, while place names and callouts are drawn afterwards so they stay
       crisp and legible whatever the light is doing. */
    this.drawLight(ctx);
    this.drawWeather(ctx);
    if (this.layers.names) this.drawLabels(ctx);
    this.drawFlashes(ctx);
    this.drawFurniture(ctx);
  }

  /* Map furniture: the scale bar and north mark every plan drawing carries.
     Drawn in device space so it stays a fixed size and remains readable at any
     zoom, the way it would on a printed schematic. */
  drawFurniture(ctx) {
    if (!this.sim) return;
    ctx.save();
    /* Anchored to the free rectangle rather than the viewport, so the furniture
       always sits in the strip of map that no panel covers. */
    const fr = this.freeRect();
    const right = fr.x + fr.w - 8;
    const bot = fr.y + fr.h - 10;

    /* Scale bar: the roundest distance that lands between 70 and 150 px. */
    const choices = [20, 50, 100, 200, 250, 500, 1000];
    let dist = choices[0], px = choices[0] * this.cam.scale;
    for (const c of choices) {
      const p = c * this.cam.scale;
      dist = c; px = p;
      if (p >= 70) break;
    }
    ctx.strokeStyle = 'rgba(230,238,246,0.32)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(right - px, bot - 4); ctx.lineTo(right - px, bot + 4);
    ctx.moveTo(right - px, bot); ctx.lineTo(right, bot);
    ctx.moveTo(right, bot - 4); ctx.lineTo(right, bot + 4);
    ctx.moveTo(right - px / 2, bot); ctx.lineTo(right - px / 2, bot + 2.5);
    ctx.stroke();
    ctx.fillStyle = 'rgba(158,170,182,0.72)';
    ctx.font = '8.5px ui-monospace, monospace';
    ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillText(`${dist} m`, right, bot - 7);

    /* North mark, above the scale bar, clear of the timeline strip. */
    const nx = right - 4, ny = bot - 34;
    ctx.strokeStyle = 'rgba(230,238,246,0.30)';
    ctx.beginPath();
    ctx.moveTo(nx, ny + 11); ctx.lineTo(nx, ny - 5);
    ctx.moveTo(nx - 4, ny); ctx.lineTo(nx, ny - 5); ctx.lineTo(nx + 4, ny);
    ctx.stroke();
    ctx.fillStyle = 'rgba(158,170,182,0.62)';
    ctx.font = '8px ui-monospace, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText('N', nx, ny + 13);
    ctx.restore();
  }

  /* Daylight, keyed to the simulated clock. The three shifts open at dawn, in
     morning light and at dusk, so the same network reads differently in each. */
  drawLight(ctx) {
    if (!this.sim.clockMinutes) return;
    const h = (((this.sim.clockMinutes() / 60) % 24) + 24) % 24;
    let col = null, a = 0;
    if (h < 5) { col = '12,22,50'; a = 0.36; }
    else if (h < 8) { col = '255,148,68'; a = 0.22 - (h - 5) / 3 * 0.17; }
    else if (h < 16.5) { col = null; a = 0; }
    else if (h < 20) { col = '255,138,60'; a = 0.05 + (h - 16.5) / 3.5 * 0.20; }
    else { col = '12,22,50'; a = 0.36; }

    /* Rain darkens and cools the whole scene rather than being drawn on top of
       it, which is how an overcast city actually looks. */
    const wet = this.sim.weather && this.sim.weather.speed < 1;
    if (wet) {
      if (col) { a = Math.min(0.42, a + 0.10); }
      else { col = '40,58,84'; a = 0.13; }
    }
    if (!col) return;
    ctx.fillStyle = `rgba(${col},${a.toFixed(3)})`;
    ctx.fillRect(0, 0, this.cw, this.ch);
  }

  drawWeather(ctx) {
    const sim = this.sim;
    if (!sim.weather || sim.weather.speed >= 1) return;
    const t = this.t;
    ctx.save();
    ctx.strokeStyle = 'rgba(170,198,224,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const n = Math.round(this.cw / 10);
    for (let i = 0; i < n; i++) {
      const x = ((hash01(i, 1) * (this.cw + 160) + t * 80) % (this.cw + 160)) - 80;
      const y = ((hash01(i, 2) * (this.ch + 140) + t * 640) % (this.ch + 140)) - 70;
      ctx.moveTo(x, y);
      ctx.lineTo(x - 4, y + 12);
    }
    ctx.stroke();
    ctx.restore();
  }

  drawDistricts(ctx) {
    ctx.save();
    const x0 = WORLD.x + 12, w = WORLD.w - 24;
    const dpr = 1 / Math.max(0.35, this.cam.scale);      // keeps hairlines hairlines
    for (const d of DISTRICT_BANDS) {
      ctx.fillStyle = 'rgba(255,255,255,0.013)';
      ctx.fillRect(x0, d.y0, w, d.y1 - d.y0);
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = dpr * 0.8;
      ctx.strokeRect(x0, d.y0, w, d.y1 - d.y0);
    }
    ctx.restore();
  }

  /* Building footprints and the harbour basin. Drawn first, so road casings
     drawn later naturally read as cutting through the fabric. */
  drawBlocks(ctx) {
    const t = this.terrain;
    ctx.save();
    for (const b of t.buildings) {
      ctx.fillStyle = b.tone > 0.72 ? 'rgba(255,255,255,0.030)' : b.tone > 0.34 ? 'rgba(255,255,255,0.021)' : 'rgba(255,255,255,0.013)';
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.strokeStyle = 'rgba(255,255,255,0.030)';
      ctx.lineWidth = 0.6;
      ctx.strokeRect(b.x + 0.3, b.y + 0.3, b.w - 0.6, b.h - 0.6);
    }
    /* Rooftop detail on the taller blocks. Sub-metre marks that only resolve
       when you zoom in, which is what makes close inspection worth doing. */
    ctx.save();
    for (const b of t.buildings) {
      if (b.tone < 0.74 || b.w < 26 || b.h < 24) continue;
      ctx.fillStyle = 'rgba(255,255,255,0.022)';
      ctx.fillRect(b.x + b.w * 0.22, b.y + b.h * 0.22, b.w * 0.56, b.h * 0.56);
      ctx.strokeStyle = 'rgba(255,255,255,0.026)';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(b.x + b.w * 0.22, b.y + b.h * 0.22, b.w * 0.56, b.h * 0.56);
    }
    ctx.restore();

    /* ---------------- the harbour ----------------
       The city sits on the west and south edges of the basin, so the working
       waterfront is the near side and open water is the far side. Water is
       deepest seaward, the apron carries container stacks and cranes, piers
       reach out from the land, and the swell drifts. A single flat rectangle
       read as a dead panel, which is the one thing a harbour must not look
       like. Everything is placed from a fixed hash, so the quay does not
       shuffle between frames. */
    const h = HARBOUR;
    const basin = () => {
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(h.x, h.y, h.w, h.h, 7) : ctx.rect(h.x, h.y, h.w, h.h);
    };

    const water = ctx.createLinearGradient(h.x, h.y + h.h, h.x + h.w, h.y);
    water.addColorStop(0, 'rgba(46,84,112,0.40)');
    water.addColorStop(0.45, 'rgba(34,66,92,0.50)');
    water.addColorStop(1, 'rgba(20,42,64,0.62)');
    ctx.fillStyle = water;
    basin();
    ctx.fill();

    ctx.save();
    basin();
    ctx.clip();

    /* swell — long, shallow, drifting, so the basin is never quite still */
    const drift = (this.t * 2.4) % 26;
    ctx.strokeStyle = 'rgba(150,196,226,0.070)';
    ctx.lineWidth = 0.9;
    for (let i = -1; i < 12; i++) {
      const y = h.y + i * 26 + drift;
      ctx.beginPath();
      ctx.moveTo(h.x - 8, y);
      ctx.bezierCurveTo(h.x + h.w * 0.3, y - 3.2, h.x + h.w * 0.7, y + 3.2, h.x + h.w + 8, y);
      ctx.stroke();
    }

    /* quay coping: a pale lip where the water meets the apron */
    ctx.fillStyle = 'rgba(140,184,214,0.20)';
    ctx.fillRect(h.x, h.y, 2.4, h.h);
    ctx.fillRect(h.x, h.y + h.h - 2.4, h.w, 2.4);

    /* piers reaching out from the land, with bollards along the deck */
    for (let i = 0; i < 2; i++) {
      const py = h.y + 52 + i * 108;
      const pw = h.w * (i ? 0.56 : 0.72);
      ctx.fillStyle = 'rgba(12,17,22,0.92)';
      ctx.fillRect(h.x, py, pw, 8);
      ctx.fillStyle = 'rgba(140,184,214,0.24)';
      ctx.fillRect(h.x, py + 8, pw, 1.4);
      ctx.fillStyle = 'rgba(198,214,226,0.22)';
      for (let b = 0; b < 6; b++) ctx.fillRect(h.x + 12 + b * (pw - 22) / 5, py + 3.4, 1.6, 1.6);
      /* hulls lying alongside the pier */
      const hulls = i ? 2 : 3;
      for (let v = 0; v < hulls; v++) {
        const hx = h.x + 20 + v * (pw / hulls) + hash01(i * 7 + v, 3) * 10;
        const hl = 20 + hash01(i * 5 + v, 4) * 16;
        ctx.fillStyle = 'rgba(186,202,214,0.30)';
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(hx, py + 12, hl, 6, 2.5) : ctx.rect(hx, py + 12, hl, 6);
        ctx.fill();
        ctx.fillStyle = 'rgba(200,218,230,0.20)';
        ctx.fillRect(hx + hl * 0.32, py + 9.5, hl * 0.34, 2.4);
      }
    }

    /* container stacks on the apron, three to a row, tones from the palette */
    const stackTone = ['rgba(198,148,62,0.30)', 'rgba(96,150,180,0.30)', 'rgba(160,110,96,0.28)', 'rgba(120,150,132,0.28)'];
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 3; c++) {
        if (hash01(r * 3 + c, 9) < 0.22) continue;
        const bx = h.x + h.w - 12 - c * 13;
        const by = h.y + 12 + r * 27 + hash01(r + c, 11) * 8;
        ctx.fillStyle = stackTone[Math.floor(hash01(r * 3 + c, 13) * 4) % 4];
        ctx.fillRect(bx - 9, by, 9.5, 5.6);
      }
    }

    /* two ship-to-shore cranes, legs on the quay and jib over the water */
    ctx.strokeStyle = 'rgba(206,220,230,0.26)';
    ctx.lineWidth = 1.2;
    for (let i = 0; i < 2; i++) {
      const cx = h.x + h.w - 30 - i * 34;
      const cy = h.y + 26 + i * 96;
      ctx.beginPath();
      ctx.moveTo(cx - 7, cy + 12); ctx.lineTo(cx - 7, cy - 12);
      ctx.lineTo(cx + 24, cy - 12);
      ctx.moveTo(cx + 3, cy - 12); ctx.lineTo(cx + 3, cy + 4);
      ctx.moveTo(cx - 7, cy + 12); ctx.lineTo(cx + 6, cy + 12);
      ctx.stroke();
    }
    ctx.restore();

    /* the basin's own edge, drawn over the water so it reads as a quay wall */
    ctx.strokeStyle = 'rgba(112,164,200,0.34)';
    ctx.lineWidth = 1;
    basin();
    ctx.stroke();
    ctx.restore();
  }

  /* Canopies: a dark under-disc keeps the crown off the paper, the crown is
     two offset lobes rather than a plain circle, and a lit rim suggests an
     upper storey catching the light. */
  drawTrees(ctx) {
    ctx.save();
    for (const t of this.terrain.trees) {
      const s = Math.sin(this.t * 0.4 + t.x * 0.011 + t.y * 0.013);
      const sway = s * 0.9;
      ctx.fillStyle = 'rgba(0,0,0,0.30)';
      ctx.beginPath();
      ctx.ellipse(t.x + 2.4, t.y + 2.2, t.r, t.r * 0.86, 0, 0, Math.PI * 2);
      ctx.fill();
      const crown = t.tone > 0.5 ? 'rgba(46,92,70,0.85)' : 'rgba(39,80,62,0.85)';
      ctx.fillStyle = crown;
      ctx.beginPath();
      ctx.ellipse(t.x + sway, t.y, t.r, t.r * 0.86, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(t.x + t.r * 0.38 + sway, t.y - t.r * 0.30, t.r * 0.55, t.r * 0.46, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(120,190,150,0.22)';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.ellipse(t.x + sway, t.y, t.r, t.r * 0.86, 0, Math.PI * 1.05, Math.PI * 1.85);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawPark(ctx) {
    const p = this.terrain.park;
    ctx.save();
    ctx.fillStyle = 'rgba(74,140,108,0.075)';
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(p.x, p.y, p.w, p.h, 7) : ctx.rect(p.x, p.y, p.w, p.h);
    ctx.fill();
    ctx.strokeStyle = 'rgba(94,168,128,0.16)';
    ctx.lineWidth = 0.9;
    ctx.stroke();
    ctx.restore();
  }

  drawJunctionSlabs(ctx) {
    const sim = this.sim;
    ctx.save();
    ctx.fillStyle = '#12161b';
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 0.8;
    for (const n of sim.nodes) {
      const e = this.junctionExtent(n);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(n.x - e, n.y - e, e * 2, e * 2, 4);
      else ctx.rect(n.x - e, n.y - e, e * 2, e * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  /* Kerb and outline, drawn wider than the carriageway so every link reads as a
     road with substance rather than as a coloured line. */
  drawRoadCasings(ctx) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const rd of this.sim.roads) {
      const w = this.roadWidth(rd);
      this.pathOf(ctx, rd.pts);
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = w + 5;
      ctx.stroke();
      ctx.strokeStyle = '#1a1f25';
      ctx.lineWidth = w + 2.4;
      ctx.stroke();
    }
    ctx.restore();
  }

  drawRoadSurfaces(ctx) {
    const sim = this.sim;
    ctx.save();
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    for (const rd of sim.roads) {
      const w = this.roadWidth(rd);
      this.pathOf(ctx, rd.pts);

      if (rd.closed) {
        ctx.strokeStyle = '#262b32';
        ctx.lineWidth = w;
        ctx.stroke();
        ctx.save();
        ctx.setLineDash([3, 5]);
        ctx.strokeStyle = 'rgba(198,96,84,0.6)';
        ctx.lineWidth = Math.max(1.3, w * 0.42);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      if (this.layers.heat) {
        ctx.strokeStyle = rgb(congestionRGB(rd.saturation));
      } else {
        /* Heat off: neutral asphalt, so geometry, lane count and incidents are
           readable without the traffic colouring competing with them. */
        ctx.strokeStyle = '#2b3138';
      }
      ctx.lineWidth = w;
      ctx.stroke();

      /* A link past ~60% of storage gets a warm bloom, so a queue that is
         forming is visible before anyone has to read a number. */
      if (this.layers.heat && rd.saturation > 0.6) {
        ctx.globalAlpha = (rd.saturation - 0.6) / 0.4 * 0.2;
        ctx.strokeStyle = '#ff7a58';
        ctx.lineWidth = w + 8;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      if (rd.incident) {
        ctx.globalAlpha = 0.28;
        ctx.strokeStyle = '#d05a4e';
        ctx.lineWidth = w + 6;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();
  }

  drawLaneMarkings(ctx) {
    ctx.save();
    ctx.lineCap = 'butt';
    for (const rd of this.sim.roads) {
      if (rd.closed || rd.lanes < 2) continue;
      /* one dashed divider between each pair of lanes */
      for (let i = 1; i < rd.lanes; i++) {
        const off = rd.laneOffset(i) - CFG.laneWidth / 2;
        ctx.setLineDash([6, 8]);
        ctx.strokeStyle = 'rgba(255,255,255,0.19)';
        ctx.lineWidth = 0.7;
        this.pathOf(ctx, this.laneLine(rd, off));
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  /* Stop line across the approach end of every carriageway. */
  drawStopBars(ctx) {
    const sim = this.sim;
    const p = { x: 0, y: 0, angle: 0 };
    ctx.save();
    for (const rd of sim.roads) {
      if (rd.closed) continue;
      const w = this.roadWidth(rd);
      rd.posAt(rd.len - 1.6, p);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      ctx.fillStyle = 'rgba(230,238,246,0.42)';
      ctx.fillRect(-1.5, -w / 2, 3, w);
      ctx.restore();
    }
    ctx.restore();
  }

  /* The bus network carries its own colour, so a transit corridor is legible
     even when the link underneath it is deep red. */
  drawBusRoutes(ctx) {
    ctx.save();
    ctx.lineCap = 'round';
    const sc = clamp(this.cam.scale / Math.max(0.001, this.minScale || 1), 1, 2.4);
    ctx.setLineDash([3 * sc, 7 * sc]);
    ctx.lineWidth = 1.5 * sc;
    ctx.strokeStyle = 'rgba(198,148,62,0.42)';
    ctx.shadowColor = 'rgba(198,148,62,0.30)';
    ctx.shadowBlur = 5;
    for (const rd of this.sim.roads) {
      if (!rd.isBusRoute || rd.closed) continue;
      ctx.beginPath();
      ctx.moveTo(rd.pts[0].x, rd.pts[0].y);
      for (let i = 1; i < rd.pts.length; i++) ctx.lineTo(rd.pts[i].x, rd.pts[i].y);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawCorridor(ctx) {
    const sim = this.sim;
    if (!sim.corridorActive()) return;
    ctx.save();
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    const dash = ((this.t * 40) % 18);
    ctx.setLineDash([9, 9]);
    ctx.lineDashOffset = -dash;
    ctx.strokeStyle = 'rgba(70,199,214,0.55)';
    ctx.shadowColor = 'rgba(70,199,214,0.55)';
    ctx.shadowBlur = 12;
    for (const rd of sim.corridor.roadSet) {
      if (rd.closed) continue;
      ctx.beginPath();
      ctx.moveTo(rd.pts[0].x, rd.pts[0].y);
      for (let i = 1; i < rd.pts.length; i++) ctx.lineTo(rd.pts[i].x, rd.pts[i].y);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawCars(ctx) {
    const sim = this.sim;
    const p = { x: 0, y: 0, angle: 0 };
    const slow = [196, 88, 56], fast = [178, 194, 208];
    ctx.save();
    for (const rd of sim.roads) {
      const cars = rd.cars;
      if (!cars.length) continue;
      const lanes = Math.max(1, rd.lanes);

      /* Vehicles are stored as one ordered stream, so lateral placement is a
         rendering decision: nose-to-tail traffic is laid out alternately across
         the available lanes — which is what a queue actually looks like from
         above — while freely flowing traffic keeps the lane it was admitted to. */
      let prev = Infinity, lane = 0;
      for (let i = 0; i < cars.length; i++) {
        const c = cars[i];
        const queued = i > 0 && prev - c.pos < rd.minHeadway * 1.8;
        lane = queued ? (lane + 1) % lanes : Math.abs(c.lane) % lanes;
        c._dl = lane;
        prev = c.pos;
      }

      for (let i = cars.length - 1; i >= 0; i--) {
        const car = cars[i];
        rd.posAt(car.pos, p);
        const off = rd.laneOffset(car._dl);
        const nx = -Math.sin(p.angle), ny = Math.cos(p.angle);
        const isBus = car.type === 'bus', isEv = car.type === 'ev';
        const spd = rd.effSpeed > 0 ? clamp01(car.speed / rd.effSpeed) : 0;
        const col = isEv ? '#48c9d8' : isBus ? '#c08d3a' : rgb(mixRGB(slow, fast, spd));

        ctx.save();
        ctx.translate(p.x + nx * off, p.y + ny * off);
        ctx.rotate(p.angle);
        if (isEv) { ctx.shadowColor = 'rgba(72,201,216,0.9)'; ctx.shadowBlur = 9; }
        ctx.fillStyle = col;
        const w = isBus ? 6.4 : isEv ? 5.8 : 5.0;
        const l = car.len * 0.92;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(-l / 2, -w / 2, l, w, w * 0.34);
        else ctx.rect(-l / 2, -w / 2, l, w);
        ctx.fill();
        if (isBus) {
          ctx.fillStyle = 'rgba(12,16,20,0.5)';
          ctx.fillRect(-l / 2 + 2.6, -w / 2 + 1.6, l - 5.6, w - 3.2);
        }
        ctx.restore();
      }
    }
    ctx.restore();
  }

  drawIncidents(ctx) {
    const sim = this.sim;
    for (const rd of sim.roads) {
      if (rd.rev || rd.closed) continue;
      if (!rd.incident) continue;
      const m = rd.posAt(rd.len * 0.5, { x: 0, y: 0, angle: 0 });
      const pl = 0.5 + 0.5 * Math.sin(this.t * 4);
      ctx.save();
      ctx.translate(m.x, m.y);
      ctx.strokeStyle = `rgba(205,90,79,${0.45 + pl * 0.45})`;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(0, 0, 13 + pl * 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(30,14,13,0.9)';
      ctx.beginPath();
      ctx.moveTo(0, -8); ctx.lineTo(7, 5); ctx.lineTo(-7, 5); ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(214,110,98,0.95)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = 'rgba(232,160,150,0.95)';
      ctx.font = '600 9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('!', 0, 4);
      ctx.restore();
    }
  }

  /* One lamp per approach, coloured by the phase that approach is being served
     by: the vertical pair carries the NS movement, the horizontal pair the EW
     movement. A driver glancing at any junction can read which way has green —
     and, importantly, see the cross-street go red when a corridor is pre-empted. */
  drawNodes(ctx) {
    const sim = this.sim;
    const SIG = { green: '#54c896', yellow: '#e0ae4b', red: '#d95f52', flash: '#e0ae4b' };
    ctx.save();
    for (const n of sim.nodes) {
      const p = n.phaseAt(sim.time);
      let nsCol, ewCol;
      if (n.outage) { nsCol = ewCol = SIG.flash; }
      else if (p.state === 'green') { nsCol = p.axis === 'NS' ? SIG.green : SIG.red; ewCol = p.axis === 'EW' ? SIG.green : SIG.red; }
      else if (p.state === 'yellow') { nsCol = p.axis === 'NS' ? SIG.yellow : SIG.red; ewCol = p.axis === 'EW' ? SIG.yellow : SIG.red; }
      else { nsCol = SIG.red; ewCol = SIG.red; }

      const congested = n.congestion > 72;
      const e = this.junctionExtent(n);
      const d = e + 3.4;

      /* approach lamps */
      const heads = [
        [0, -d, nsCol], [0, d, nsCol], [-d, 0, ewCol], [d, 0, ewCol]
      ];
      for (const h of heads) {
        if (h[2] === SIG.green) { ctx.shadowColor = 'rgba(84,200,150,0.8)'; ctx.shadowBlur = 7; }
        ctx.fillStyle = h[2];
        ctx.beginPath();
        ctx.arc(n.x + h[0], n.y + h[1], 3.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      /* control cabinet at the centre of the junction */
      ctx.beginPath();
      const r = congested ? 5.2 : 4.4;
      if (ctx.roundRect) ctx.roundRect(n.x - r, n.y - r, r * 2, r * 2, 1.6);
      else ctx.rect(n.x - r, n.y - r, r * 2, r * 2);
      ctx.fillStyle = n.outage ? 'rgba(46,34,17,0.96)' : 'rgba(11,14,18,0.96)';
      ctx.fill();
      ctx.strokeStyle = n.outage ? 'rgba(224,174,75,0.85)' : congested ? 'rgba(217,95,82,0.75)' : 'rgba(255,255,255,0.32)';
      ctx.lineWidth = 1.3;
      ctx.stroke();

      if (n.outage) {
        ctx.save();
        ctx.setLineDash([2, 3]);
        ctx.strokeStyle = 'rgba(224,174,75,0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(n.x, n.y, e + 8, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
      if (n.busPriority) {
        ctx.fillStyle = 'rgba(192,141,58,0.95)';
        ctx.beginPath(); ctx.arc(n.x - e - 1, n.y + e + 1, 2.6, 0, Math.PI * 2); ctx.fill();
      }

      /* boundary gate marker — where traffic enters and leaves the modelled area */
      if (n.gate) {
        const dx = n.x < 600 ? -1 : 1;
        ctx.strokeStyle = 'rgba(255,255,255,0.24)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(n.x + dx * (e + 10), n.y);
        ctx.lineTo(n.x + dx * (e + 2), n.y);
        ctx.moveTo(n.x + dx * (e + 10), n.y - 3.4);
        ctx.lineTo(n.x + dx * (e + 10), n.y + 3.4);
        ctx.stroke();
      }

      if (this.selected && this.selected.kind === 'node' && this.selected.id === n.id) {
        const pulse = 0.5 + 0.5 * Math.sin(this.t * 3.2);
        ctx.strokeStyle = 'rgba(63,191,174,0.85)';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(n.x, n.y, e + 7 + pulse * 2.5, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = 'rgba(63,191,174,0.22)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(n.x, n.y, e + 13, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.restore();
  }

  roadFor(hit) {
    return this.sim.roads.find(r => r.name === hit.name && r.rev === hit.rev) || null;
  }

  drawSelection(ctx) {
    ctx.save();
    ctx.lineCap = 'round';
    const hair = 1 / this.cam.scale;          // one device pixel, in world units

    if (this.hover && this.hover.kind === 'road') {
      const rd = this.roadFor(this.hover);
      if (rd) {
        this.pathOf(ctx, rd.pts);
        ctx.strokeStyle = 'rgba(255,255,255,0.34)';
        ctx.lineWidth = this.roadWidth(rd) + 3.5 * hair;
        ctx.stroke();
      }
    }
    if (this.selected && this.selected.kind === 'road') {
      const rd = this.roadFor(this.selected);
      if (rd) {
        const pulse = 0.5 + 0.5 * Math.sin(this.t * 2.6);
        this.pathOf(ctx, rd.pts);
        ctx.strokeStyle = `rgba(63,191,174,${0.42 + pulse * 0.22})`;
        ctx.lineWidth = this.roadWidth(rd) + 5 * hair;
        ctx.stroke();
      }
    }

    /* Hover ring on junctions, so it is obvious what a click will select. */
    if (this.hover && this.hover.kind === 'node') {
      const n = this.sim.city.nodeById[this.hover.id];
      if (n) {
        const e = this.junctionExtent(n) + 6 * hair;
        ctx.strokeStyle = 'rgba(255,255,255,0.45)';
        ctx.lineWidth = 1.4 * hair;
        ctx.setLineDash([5 * hair, 4 * hair]);
        ctx.beginPath(); ctx.arc(n.x, n.y, e, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    ctx.restore();
  }

  /* Measured consequence badges. When an intervention settles, the junctions
     and links that actually moved get a short-lived label showing by how much —
     so the second-order effect is visible on the network itself, not only in the
     end-of-run report. */
  drawFlashes(ctx) {
    const sim = this.sim;
    if (!sim.flashes || !sim.flashes.length) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const f of sim.flashes) {
      const age = sim.time - f.born;
      if (age < 0 || age > f.life) continue;
      const u = age / f.life;
      const rise = 30 * Math.min(1, u * 2.6);
      const alpha = u < 0.1 ? u / 0.1 : u > 0.72 ? Math.max(0, 1 - (u - 0.72) / 0.28) : 1;
      const p = this.toScreen(f.x, f.y);
      if (p.x < -200 || p.x > this.cw + 200 || p.y < -120 || p.y > this.ch + 120) continue;
      /* Clears the junction's own name and queue badge, which occupy the first
         ~45px above the node — the badge must not fight the labels it explains. */
      const y = p.y - 46 - rise;
      ctx.font = '600 10px ui-monospace, monospace';
      const tw = ctx.measureText(f.text).width;
      const h = 17, padX = 7;
      const by = y - h / 2, bx = p.x - tw / 2 - padX, bw = tw + padX * 2;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx, by, bw, h, 4); else ctx.rect(bx, by, bw, h);
      ctx.fillStyle = 'rgba(8,11,14,0.94)';
      ctx.fill();
      ctx.strokeStyle = f.col;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.globalAlpha = alpha * 0.4;
      ctx.beginPath(); ctx.moveTo(p.x, by + h); ctx.lineTo(p.x, p.y - 5); ctx.stroke();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = f.col;
      ctx.fillText(f.text, p.x, y + 0.5);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  /* All text is laid out in device space: constant on-screen size, sharp at any
     fitted scale, and never distorted by the world transform. Labels are kept
     deliberately sparse at low zoom so the network reads before the names do. */
  drawLabels(ctx) {
    const sim = this.sim;
    const s = this.cam.scale;
    /* Named junctions appear when they are far enough apart on screen to fit a
       name between them. Keying this off the *layout* rather than an absolute
       zoom means the label density adapts to the window size as well — a fixed
       threshold that suited one monitor blanked every name on a smaller one. */
    const nb = this.networkBounds();
    const gap = Math.min((nb.w * s) / 3, (nb.h * s) / 2);
    const roomy = gap > 110;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const d of DISTRICT_BANDS) {
      const p = this.toScreen(WORLD.x + 16, d.y0 + 15);
      ctx.textAlign = 'left';
      ctx.font = '600 9px ui-monospace, monospace';
      ctx.fillStyle = `rgba(255,255,255,${roomy ? 0.15 : 0.10})`;
      ctx.fillText(d.label, p.x, p.y);
    }

    const selNode = this.selected && this.selected.kind === 'node' ? this.selected.id : null;
    const hovNode = this.hover && this.hover.kind === 'node' ? this.hover.id : null;

    ctx.textAlign = 'center';
    for (const n of sim.nodes) {
      const p = this.toScreen(n.x, n.y);
      const hot = n.id === selNode || n.id === hovNode;
      if (!roomy && !hot) continue;                 // declutter when zoomed out
      const above = n.y > 300;
      const ly = p.y + (above ? -27 : 28);
      ctx.font = hot ? '600 10.5px -apple-system, "Segoe UI", Roboto, sans-serif'
                     : '500 10px -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.fillStyle = hot ? 'rgba(236,244,250,0.96)' : 'rgba(214,224,232,0.62)';
      ctx.fillText(n.name.toUpperCase(), p.x, ly);
      if (hot) {
        ctx.font = '500 9px ui-monospace, monospace';
        ctx.fillStyle = 'rgba(63,191,174,0.95)';
        ctx.fillText(`${Math.round(n.queue)} QUEUED \u00b7 ${n.waitEma.toFixed(0)}s WAIT`, p.x, ly + (above ? -15 : 15));
      }
    }

    /* Name the road under the cursor or in the detail panel, so a segment can be
       identified without leaving the map. */
    const rt = (this.hover && this.hover.kind === 'road') ? this.hover
             : (this.selected && this.selected.kind === 'road') ? this.selected : null;
    if (rt) {
      const rd = this.roadFor(rt);
      if (rd) {
        const mid = rd.posAt(rd.len * 0.5, { x: 0, y: 0, angle: 0 });
        const p = this.toScreen(mid.x, mid.y);
        const txt = `${rd.name.toUpperCase()}  \u00b7  ${Math.round(rd.saturation * 100)}% FULL`;
        ctx.font = '600 9.5px ui-monospace, monospace';
        const tw = ctx.measureText(txt).width;
        const h = 18, padX = 8;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(p.x - tw / 2 - padX, p.y - 12 - h, tw + padX * 2, h, 4);
        else ctx.rect(p.x - tw / 2 - padX, p.y - 12 - h, tw + padX * 2, h);
        ctx.fillStyle = 'rgba(8,11,14,0.9)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(63,191,174,0.5)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = 'rgba(180,232,220,0.96)';
        ctx.fillText(txt, p.x, p.y - 12 - h / 2 + 0.5);
      }
    }
    ctx.restore();
  }

  /* Pick targets are sized in *device* pixels, so a junction stays as easy to
     hit at 3x zoom as it is when the network is fitted. */
  hitTest(mx, my) {
    const w = this.toWorld(mx, my);
    const s = this.cam.scale || 1;
    const nodeR = Math.max(15, 24 / s);
    for (const n of this.sim.nodes) {
      if (Math.hypot(n.x - w.x, n.y - w.y) < nodeR) return { kind: 'node', id: n.id };
    }
    let best = null, bestD = Infinity;
    for (const rd of this.sim.roads) {
      const d = this.distToRoad(rd, w);
      if (d < bestD) { bestD = d; best = rd; }
    }
    if (best && bestD <= this.roadWidth(best) / 2 + 8 / s) {
      return { kind: 'road', name: best.name, rev: best.rev };
    }
    return null;
  }

  distToRoad(rd, p) {
    let best = Infinity;
    for (let i = 1; i < rd.pts.length; i++) {
      const a = rd.pts[i - 1], b = rd.pts[i];
      const dx = b.x - a.x, dy = b.y - a.y;
      const l2 = dx * dx + dy * dy || 1;
      let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
      t = clamp01(t);
      best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t)));
    }
    return best;
  }
}

/* ============================== 9. UI CONTROLLER ========================== */

class UI {
  constructor() {
    this.$ = id => document.getElementById(id);
    this.speed = 1;
    this.sim = null;
    this.renderer = null;
    this.selected = null;
    this.accum = 0;
    this.lastFrame = 0;
    this.uiTimer = 0;
    this.sparks = {};
    this.boundScenario = SCENARIOS[0].id;
    this.raf = null;
    this.lastCardId = 0;
    this.lastRunSpeed = 1;
    this.howReturn = 'scrMenu';
    this.drag = null;
    this.feedOpen = false;
    this.tlFor = null;
    /* First-run coaching: three prompts that retire themselves once the player
       has actually done the three things the console is built around. */
    this.coachStep = 0;
    this.coachDone = false;
    this._advSig = null;
    this._advAll = [];
    this.advTimer = 0;

    this.buildScenarioCards();
    this.bindEvents();
    this.initCosts();
    this.runLoading();
  }

  /* Intervention prices live in CFG.costs, so the buttons are annotated from
     that single source instead of repeating the numbers in the markup. */
  initCosts() {
    document.querySelectorAll('[data-cost-key]').forEach(btn => {
      const cost = CFG.costs[btn.dataset.costKey];
      if (cost == null || btn.querySelector('.btn-cost')) return;
      const el = document.createElement('span');
      el.className = 'btn-cost';
      el.textContent = (cost / 1000).toFixed(1) + 'k';
      btn.appendChild(el);
    });
  }

  /* ---------- boot ---------- */

  runLoading() {
    const steps = [
      'INITIALISING NETWORK MODEL',
      'LOADING SIGNAL CONTROLLERS',
      'CALIBRATING DEMAND PROFILES',
      'CONSOLE READY'
    ];
    let i = 0, p = 0;
    const fill = this.$('loadFill'), status = this.$('loadStatus');
    const tick = () => {
      p = Math.min(100, p + 6 + Math.random() * 12);
      fill.style.width = p + '%';
      const ni = Math.min(steps.length - 1, Math.floor((p / 100) * steps.length));
      if (ni !== i) { i = ni; status.textContent = steps[i]; }
      if (p < 100) setTimeout(tick, 120 + Math.random() * 90);
      else setTimeout(() => this.showScreen('scrMenu'), 260);
    };
    setTimeout(tick, 220);
  }

  showScreen(id) {
    for (const s of document.querySelectorAll('.screen')) s.classList.remove('active');
    if (id) {
      this.$('overlay').classList.remove('idle');
      this.$(id).classList.add('active');
    } else {
      this.$('overlay').classList.add('idle');
    }
  }

  buildScenarioCards() {
    const wrap = this.$('scenarioList');
    wrap.innerHTML = SCENARIOS.map(s => `
      <button class="sc-card${s.id === this.boundScenario ? ' sel' : ''}" data-id="${s.id}">
        <div class="sc-num">SCENARIO ${s.num}</div>
        <h3>${s.name}</h3>
        <p>${s.blurb}</p>
        <div class="sc-meta">
          <span>DURATION <b>${s.meta.duration}</b></span>
          <span>EVENTS <b>${s.meta.events}</b></span>
        </div>
      </button>`).join('');
    wrap.querySelectorAll('.sc-card').forEach(el => {
      el.addEventListener('click', () => {
        this.boundScenario = el.dataset.id;
        wrap.querySelectorAll('.sc-card').forEach(e => e.classList.toggle('sel', e === el));
      });
    });
  }

  bindEvents() {
    this.$('btnStart').addEventListener('click', () => this.startScenario(this.boundScenario));
    this.$('btnHow').addEventListener('click', () => this.openHow('scrMenu'));
    this.$('btnHowBack').addEventListener('click', () => {
      if (this.howReturn) this.showScreen(this.howReturn);
      else this.showScreen(null);          /* resume the paused run */
    });
    this.$('btnMenu').addEventListener('click', () => { this.setSpeed(0); this.showScreen('scrMenu'); });
    this.$('btnReplay').addEventListener('click', () => this.startScenario(this.sim ? this.sim.scenario.id : this.boundScenario));
    this.$('btnNewScenario').addEventListener('click', () => this.showScreen('scrMenu'));

    document.querySelectorAll('.speed').forEach(b => {
      b.addEventListener('click', () => this.setSpeed(parseInt(b.dataset.speed, 10)));
    });

    window.addEventListener('keydown', e => this.onKey(e));
    this.bindCamera();

    window.addEventListener('resize', () => { if (this.renderer) this.renderer.resize(false); });

    /* event ticker */
    this.$('feedToggle').addEventListener('click', () => {
      this.feedOpen = !this.feedOpen;
      this.$('feed').classList.toggle('open', this.feedOpen);
    });

    /* camera buttons */
    this.$('btnZoomIn').addEventListener('click', () => this.renderer && this.renderer.zoomBy(1.25));
    this.$('btnZoomOut').addEventListener('click', () => this.renderer && this.renderer.zoomBy(1 / 1.25));
    this.$('btnZoomFit').addEventListener('click', () => this.renderer && this.renderer.fit(false));

    /* panel controls */
    this.$('btnNsMinus').addEventListener('click', () => this.doGreen('NS', -4));
    this.$('btnNsPlus').addEventListener('click', () => this.doGreen('NS', 4));
    this.$('btnEwMinus').addEventListener('click', () => this.doGreen('EW', -4));
    this.$('btnEwPlus').addEventListener('click', () => this.doGreen('EW', 4));
    this.$('btnBusPriority').addEventListener('click', () => this.doBus());
    this.$('btnSyncRow').addEventListener('click', () => this.doSync('EW'));
    this.$('btnSyncCol').addEventListener('click', () => this.doSync('NS'));
    this.$('btnLaneLeft').addEventListener('click', () => this.doLane(1));
    this.$('btnLaneRight').addEventListener('click', () => this.doLane(-1));
    this.$('btnCloseRoad').addEventListener('click', () => this.doClosure());
    this.$('btnCorridorRoad').addEventListener('click', () => this.doCorridor());
    this.$('btnCorridor').addEventListener('click', () => this.doCorridor());
    this.$('btnRedirect').addEventListener('click', () => this.doRedirect());
    this.$('btnCloseNode').addEventListener('click', () => this.selectAsset(null));
    this.$('btnCloseRoadPanel').addEventListener('click', () => this.selectAsset(null));
    this.$('btnUndo').addEventListener('click', () => this.doUndo());
    this.$('btnPresetNs').addEventListener('click', () => this.doPreset('NS'));
    this.$('btnPresetBal').addEventListener('click', () => this.doPreset('BALANCE'));
    this.$('btnPresetEw').addEventListener('click', () => this.doPreset('EW'));
    this.$('btnSkip').addEventListener('click', () => this.skipToNext());

    /* Map layers. Clicking a chip is the whole interaction — the map re-reads
       itself on the next frame rather than being rebuilt. */
    this.$('layerCtrls').querySelectorAll('.lchip').forEach(chip => {
      chip.addEventListener('click', () => this.toggleLayer(chip.dataset.layer, chip));
    });
  }

  toggleLayer(name, chip) {
    if (!this.renderer) return;
    const on = !this.renderer.layers[name];
    this.renderer.layers[name] = on;
    chip.classList.toggle('on', on);
    const label = name === 'heat' ? 'Link colouring' : name === 'names' ? 'Place names' : 'Bus network';
    this.toast(`${label.toUpperCase()} ${on ? 'ON' : 'OFF'}`, 'info');
  }

  /* ---------- advisory / objectives / revert ---------- */

  coachCard() {
    if (this.coachDone) return null;
    if (this.coachStep === 0) return {
      coach: true, step: '1 / 3', title: 'Pick a junction to work on',
      detail: 'The advisory below ranks the network\u2019s worst trouble spots. Click one to fly there, or click any junction on the map yourself.'
    };
    if (this.coachStep === 1) return {
      coach: true, step: '2 / 3', title: 'Change its signal timing',
      detail: 'Its controls are in this panel now. Three preset splits do the arithmetic for you \u2014 deciding which axis deserves the green is the part that is up to you.'
    };
    if (this.coachStep === 2) return {
      coach: true, step: '3 / 3', title: 'Watch for the consequence',
      detail: 'Roughly half a minute after a decision, a badge appears on the map showing what changed and where. It is rarely all good news.'
    };
    return null;
  }

  /* Re-evaluated on a slow cadence and re-rendered only when the content really
     changes. Rebuilding every frame would make the text flicker and would steal
     the pointer target out from under the cursor. */
  renderAdvisory() {
    const list = this.sim.advisory();
    const coach = this.coachCard();
    const items = coach ? [coach].concat(list) : list;
    this._advAll = items;

    const sig = items.map(a =>
      `${a.coach ? 'c' : a.kind}:${a.id != null ? a.id : (a.name || '')}:${a.preset || ''}:${a.urgency || a.severity || ''}:${a.action || ''}`
    ).join('|');
    if (sig === this._advSig) return;
    this._advSig = sig;

    this.$('advCount').textContent = list.length ? `${list.length} FLAGGED` : '\u2014';
    const wrap = this.$('advisory');
    if (!items.length) {
      wrap.innerHTML = '<div class="adv-empty">No faults flagged. The network is running within design '
        + 'parameters \u2014 a good moment to prepare for what the timeline shows coming next.</div>';
      return;
    }
    /* Compaction. The ranked list can otherwise read as four versions of one
       sentence, which is worse than saying nothing: findings that repeat word
       for word are dropped, and only the leading one keeps its full
       explanation. The rest carry their numbers, which is the part you act on. */
    const seen = new Set();
    const kept = [];
    for (const a of items) {
      const key = a.coach ? 'coach' : (a.title + '|' + (a.brief || '')).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(a);
      if (!a.coach && kept.filter(k => !k.coach).length >= 3) break;
    }
    wrap.innerHTML = kept.map(a => {
      const i = items.indexOf(a);
      const crit = a.urgency === 'crit' || a.severity === 'crit';
      const cls = a.coach ? 'coach' : crit ? 'crit' : 'warn';
      const badge = a.coach ? 'STEP ' + a.step : crit ? 'ACT NOW' : '';
      const first = kept.filter(k => !k.coach)[0] === a;
      const body = first
        ? `<div class="adv-body">${a.detail}</div>`
        : `<div class="adv-body">${a.brief || ''}</div>`;
      const act = a.action
        ? `<span class="adv-act${crit ? ' urgent' : ''}">` +
          `${a.action === 'AUTHORISE' ? 'AUTHORISE CORRIDOR' : 'SHOW ME'}</span>`
        : '';
      return `<button class="adv-card ${cls}" data-i="${i}">` +
        `<div class="adv-title"><b>${a.title}</b><span>${badge}</span></div>${body}${act}</button>`;
    }).join('');

    wrap.querySelectorAll('.adv-card').forEach(el => {
      el.addEventListener('click', () => this.onAdvisory(parseInt(el.dataset.i, 10)));
    });
  }

  /* Clicking advice acts on it: the corridor item authorises, everything else
     takes the camera to the asset it is talking about. */
  onAdvisory(i) {
    const a = this._advAll[i];
    if (!a || a.coach) return;
    if (a.kind === 'corridor') { this.doCorridor(); return; }
    if (a.x == null || !this.renderer) return;
    if (a.kind === 'node') this.selectAsset({ kind: 'node', id: a.id });
    else this.selectAsset({ kind: 'road', name: a.name, rev: a.rev });
    this.renderer.focusOn(a.x, a.y, Math.max(this.renderer.camT.scale, (this.renderer.minScale || 1) * 1.7));
  }

  renderObjectives() {
    const sim = this.sim;
    const list = sim.objectiveStatus();
    this.$('objectives').innerHTML = list.map(o => {
      const dp = o.unit === '%' ? 0 : 1;
      return `<div class="obj${o.met ? ' met' : ''}">` +
        `<span class="obj-mark">${o.met ? '\u2713' : ''}</span>` +
        `<div class="obj-body"><div class="obj-label">${o.label}</div>` +
        `<div class="obj-track"><i style="width:${(o.prog * 100).toFixed(0)}%"></i></div></div>` +
        `<span class="obj-val">${o.value.toFixed(dp)}${o.unit}</span></div>`;
    }).join('');
    const met = list.filter(o => o.met).length;
    this.$('objMet').textContent = `${met} / ${list.length} MET`;
    /* The bar to beat. Stated in the panel and then measured for real at the end
       of the run, so the number a player is aiming at is never a decoration. */
    const b = sim.scenario.baseline;
    this.$('objNote').innerHTML = b
      ? `Unmanaged reference: <b>${b.avgWait.toFixed(1)}s</b> mean wait \u00b7 `
        + `<b>${b.servedRatio.toFixed(0)}%</b> served \u00b7 composite <b>${b.composite.toFixed(0)}</b>.`
      : '';
  }

  /* ---------- pacing ---------- */

  /* Fast-forward through the quiet stretches to just before the next scheduled
     event. The simulation is stepped at its own fixed timestep, so a skip is
     the same day as waiting it out would have been — not an approximation of
     one. This is what makes a seven-minute shift finish inside five. */
  skipToNext() {
    const sim = this.sim;
    if (!sim || sim.finished) return;
    const next = sim.events.find(e => e.t > sim.time);
    const target = Math.min(sim.time + 200, next ? next.t - 2 : sim.duration - 1);
    if (target - sim.time < 8) return;
    const before = sim.cards.length;
    const step = 1 / 60;
    let guard = 0;
    while (sim.time < target && !sim.finished && guard++ < 40000) sim.step(step);
    this.accum = 0;
    /* Cards for everything the skip passed are suppressed — the log keeps them,
       and one toast says what was skipped rather than four the player never saw
       happen in real time. */
    const passed = sim.cards.length - before;
    this.lastCardId = sim.cards.length;
    const clock = formatClock(sim.scenario.startClock, sim.time, CFG.clockRate);
    this.toast(passed
      ? `CLOCK ADVANCED TO ${clock} — ${passed} EVENT${passed === 1 ? '' : 'S'} LOGGED`
      : `CLOCK ADVANCED TO ${clock}`, 'info');
    this._advSig = null;
    this.updateDashboard();
    if (sim.finished) this.showReport();
  }

  renderUndo() {
    const btn = this.$('btnUndo');
    const last = this.sim.interventions[this.sim.interventions.length - 1];
    const can = !!last && !!last.undo && !this.sim.finished;
    btn.disabled = !can;
    btn.classList.toggle('hot', can);
    btn.title = can ? `Revert: ${last.label} \u2014 ${last.detail}` : 'Nothing to revert';
  }

  /* Map navigation. The camera is the only thing these touch — driving the view
     around must never perturb the simulation, or cause and effect stop being
     attributable to the player's engineering decisions. */
  bindCamera() {
    const stage = this.$('stage');
    const canvas = this.$('map');

    canvas.addEventListener('wheel', e => {
      if (!this.renderer) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      this.renderer.zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.16 : 1 / 1.16, false);
    }, { passive: false });

    canvas.addEventListener('mousedown', e => {
      if (!this.renderer || e.button !== 0) return;
      this.drag = { x: e.clientX, y: e.clientY, moved: 0 };
    });

    window.addEventListener('mousemove', e => {
      if (!this.drag || !this.renderer) return;
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      this.drag.moved += Math.abs(dx) + Math.abs(dy);
      this.drag.x = e.clientX; this.drag.y = e.clientY;
      if (this.drag.moved > 4) {
        stage.classList.add('dragging');
        this.renderer.panBy(dx, dy);
      }
    });

    /* Canvas mouseup precedes the window handler below, so the drag distance is
       still readable here — which is how a pan is told apart from a click. */
    canvas.addEventListener('mouseup', e => {
      if (!this.renderer || !this.sim || e.button !== 0) return;
      if (this.drag && this.drag.moved > 4) return;
      this.onClick(e);
    });

    window.addEventListener('mouseup', () => {
      this.drag = null;
      stage.classList.remove('dragging');
    });

    canvas.addEventListener('dblclick', e => {
      if (!this.renderer || !this.sim) return;
      const rect = canvas.getBoundingClientRect();
      const hit = this.renderer.hitTest(e.clientX - rect.left, e.clientY - rect.top);
      if (hit && hit.kind === 'node') {
        this.selectAsset(hit);
        const n = this.sim.city.nodeById[hit.id];
        this.renderer.focusOn(n.x, n.y, Math.max(this.renderer.camT.scale, (this.renderer.minScale || 1) * 1.9));
      }
    });

    canvas.addEventListener('mouseleave', () => {
      if (this.renderer) this.renderer.hover = null;
      this.$('tooltip').classList.add('hidden');
    });
    canvas.addEventListener('mousemove', e => this.onHover(e));
  }

  openHow(from) {
    this.howReturn = from || null;
    this.setSpeed(0);
    /* Mid-game the button resumes the run it paused; from the menu it returns
       to scenario selection. Same screen, honest labels. */
    const midGame = !!this.sim;
    this.$('btnHowBack').textContent = midGame ? 'RESUME SIMULATION' : 'BACK TO SCENARIOS';
    this.showScreen('scrHow');
  }

  /* Console keys. Space is the one that matters most: holding the clock is how
     an engineer actually studies a network before touching it. */
  onKey(e) {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey) return;
    const overlayOpen = !this.$('overlay').classList.contains('idle');
    if (e.code === 'Space') {
      e.preventDefault();
      if (overlayOpen || !this.sim) return;
      this.setSpeed(this.speed === 0 ? this.lastRunSpeed : 0);
      return;
    }
    if (e.key === 'h' || e.key === 'H') {
      if (overlayOpen && this.$('scrHow').classList.contains('active')) this.showScreen(this.howReturn);
      else if (!overlayOpen) this.openHow(null);
      return;
    }
    if (overlayOpen || !this.sim) return;
    if (e.key === '1') this.setSpeed(1);
    else if (e.key === '2') this.setSpeed(2);
    else if (e.key === '4') this.setSpeed(4);
    else if (e.key === 'Escape') this.selectAsset(null);
    else if (e.key === 'f' || e.key === 'F') { if (this.renderer) this.renderer.fit(false); }
    else if (e.key === 'ArrowRight') this.cycleNode(1);
    else if (e.key === 'ArrowLeft') this.cycleNode(-1);
    else if (e.key === 'n' || e.key === 'N') this.skipToNext();
    else if (e.key === 'r' || e.key === 'R') this.doUndo();
  }

  cycleNode(dir) {
    const ids = this.sim.nodes.map(n => n.id);
    const cur = this.selected && this.selected.kind === 'node' ? this.selected.id : null;
    const i = cur == null ? (dir > 0 ? -1 : 0) : ids.indexOf(cur);
    const next = ids[((i + dir) % ids.length + ids.length) % ids.length];
    this.selectAsset({ kind: 'node', id: next });
    const n = this.sim.city.nodeById[next];
    /* Only move the camera if the junction is actually off-view, so stepping
       through the network with the arrow keys does not lurch about. */
    if (this.renderer) this.renderer.ensureVisible(n.x, n.y);
  }

  /* ---------- lifecycle ---------- */

  startScenario(id) {
    this.sim = new Simulation(id);
    if (!this.renderer) {
      this.renderer = new Renderer(this.$('map'), this.sim);
      this.sparks = {};
      for (const k of ['flow', 'congestion', 'stability', 'satisfaction', 'emergency', 'budget']) {
        const el = this.$('spark' + k[0].toUpperCase() + k.slice(1));
        this.sparks[k] = { el, ctx: el.getContext('2d') };
      }
    } else {
      this.renderer.setSim(this.sim);
      this.renderer.resize(true);
    }
    this.selected = null;
    this.renderer.selected = null;
    this.renderer.hover = null;
    this.lastCardId = 0;
    this.tlFor = null;
    this.feedOpen = false;
    this.coachStep = 0;
    this.coachDone = false;
    this._advSig = null;
    this.advTimer = 0;
    this.$('feed').classList.remove('open');
    this.$('toastLayer').innerHTML = '';
    this.clearFeed();
    this.renderFeed();
    this.showScreen(null);
    this.selectAsset(null);
    this.setSpeed(1);
    this.updateDashboard();
    if (!this.raf) { this.lastFrame = performance.now(); this.loop(this.lastFrame); }
  }

  /* ---------- day timeline ---------- */

  /* Drawn once per run. Phase bands give the shape of demand and the ticks show
     what is scheduled, so the player can see a surge coming and act before it
     lands — which is most of what separates a game from a dashboard. */
  buildTimeline() {
    const sim = this.sim, sc = sim.scenario, D = sim.duration;
    const PCOL = ['rgba(255,255,255,.30)', 'rgba(255,255,255,.16)', 'rgba(215,162,63,.30)', 'rgba(72,201,216,.24)'];
    let prev = 0;
    this.$('tlPhases').innerHTML = sc.phases.map((p, i) => {
      const left = (prev / D) * 100;
      const w = ((p.until - prev) / D) * 100;
      prev = p.until;
      return `<i style="left:${left}%;width:${w}%;background:${PCOL[i % PCOL.length]}" title="${p.name} — demand ${p.demand}"></i>`;
    }).join('');

    const COL = {
      accident: '#d05a4e', incident: '#d05a4e', outage: '#d7a23f', surge: '#d7a23f',
      rain: '#6f93b5', transit: '#c08d3a', ev: '#48c9d8', spike: '#d7a23f'
    };
    this.$('tlEvents').innerHTML = sim.events.map(e => {
      const left = clamp01(e.t / D) * 100;
      const col = COL[e.kind] || '#8a93a0';
      return `<i class="tl-ev" style="left:${left}%;background:${col}" title="${e.title}"></i>`;
    }).join('');
    this.tlFor = sc.id;
  }

  setSpeed(s) {
    this.speed = s;
    if (s > 0) this.lastRunSpeed = s;
    document.querySelectorAll('.speed').forEach(b => b.classList.toggle('active', parseInt(b.dataset.speed, 10) === s));
    const live = this.$('liveText');
    const wrap = document.querySelector('.live');
    const stage = this.$('stage');
    if (this.sim && this.sim.finished) {
      live.textContent = 'RUN COMPLETE';
      wrap.classList.add('paused');
      stage.classList.remove('held');
    } else if (s === 0) {
      live.textContent = 'SIMULATION HELD';
      wrap.classList.add('paused');
      stage.classList.add('held');
    } else {
      live.textContent = 'SIMULATION ACTIVE';
      wrap.classList.remove('paused');
      stage.classList.remove('held');
    }
  }

  loop(now) {
    this.raf = requestAnimationFrame(t => this.loop(t));
    const raw = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    if (this.sim && this.speed > 0 && !this.sim.finished) {
      this.accum += raw * this.speed;
      const step = 1 / 60;
      let guard = 0;
      while (this.accum >= step && guard++ < 24) { this.sim.step(step); this.accum -= step; }
      if (this.sim.finished) { this.showReport(); }
    }

    if (this.renderer && this.sim) this.renderer.draw(raw);

    this.uiTimer += raw;
    if (this.uiTimer > 0.16 && this.sim) { this.uiTimer = 0; this.updateDashboard(); }
  }

  /* ---------- interaction ---------- */

  onHover(e) {
    if (!this.renderer) return;
    const rect = this.$('map').getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const hit = this.renderer.hitTest(mx, my);
    this.renderer.hover = hit;
    const tip = this.$('tooltip');
    if (!hit || !this.sim) { tip.classList.add('hidden'); return; }
    const data = hit.kind === 'node' ? this.nodeTooltip(hit.id) : this.roadTooltip(hit);
    tip.innerHTML = data;
    tip.classList.remove('hidden');
    tip.style.left = Math.min(mx + 16, rect.width - 200) + 'px';
    tip.style.top = Math.max(8, my - 10) + 'px';
  }

  nodeTooltip(id) {
    const n = this.sim.city.nodeById[id];
    const ph = n.phaseAt(this.sim.time);
    const state = n.outage ? 'ALL-WAY FLASH'
      : `${ph.axis || ''} ${ph.state.toUpperCase()}`.trim();
    return `<div class="tt-title">${n.name}</div>
      <div class="tt-sub">${n.district}${n.gate ? ' · GATE ' + n.gate.code : ''}</div>
      <div class="tt-row"><span>SIGNAL</span><b>${state}</b></div>
      <div class="tt-row"><span>QUEUE</span><b>${Math.round(n.queue)} veh</b></div>
      <div class="tt-row"><span>AVG WAIT</span><b>${n.waitEma.toFixed(1)} s</b></div>
      <div class="tt-row"><span>VOLUME</span><b>${Math.round(n.volume)} veh/h</b></div>
      <div class="tt-row"><span>CONGESTION</span><b>${Math.round(n.congestion)}%</b></div>`;
  }

  roadTooltip(hit) {
    const rd = this.roads().find(r => r.name === hit.name && r.rev === hit.rev);
    if (!rd) return '';
    const status = rd.closed ? 'CLOSED' : rd.incident ? 'INCIDENT' : rd.saturation > 0.88 ? 'GRIDLOCKED'
      : rd.saturation > 0.6 ? 'HEAVY' : 'OPEN';
    return `<div class="tt-title">${rd.name}</div>
      <div class="tt-sub">${rd.from.name} \u2192 ${rd.to.name} · ${rd.lanes} LANE${rd.lanes === 1 ? '' : 'S'}</div>
      <div class="tt-row"><span>SATURATION</span><b>${Math.round(rd.saturation * 100)}%</b></div>
      <div class="tt-row"><span>STORAGE</span><b>${rd.cars.length} / ${Math.round(rd.capacity)} veh</b></div>
      <div class="tt-row"><span>THROUGHPUT</span><b>${Math.round(sum(rd.flow) * 60)} veh/h</b></div>
      <div class="tt-row"><span>STATUS</span><b>${status}</b></div>`;
  }

  roads() { return this.sim.roads; }

  onClick(e) {
    if (!this.renderer || !this.sim) return;
    const rect = this.$('map').getBoundingClientRect();
    const hit = this.renderer.hitTest(e.clientX - rect.left, e.clientY - rect.top);
    this.selectAsset(hit);
  }

  selectAsset(hit) {
    this.selected = hit;
    if (this.renderer) this.renderer.selected = hit;
    if (this.coachStep === 0 && hit && hit.kind === 'node') { this.coachStep = 1; this._advSig = null; }
    const sit = this.$('sitCard');
    const nd = this.$('detailNode');
    const rdd = this.$('detailRoad');
    sit.classList.toggle('hidden', !!hit);
    nd.classList.toggle('hidden', !(hit && hit.kind === 'node'));
    rdd.classList.toggle('hidden', !(hit && hit.kind === 'road'));
    if (hit && hit.kind === 'node') this.fillNode(hit.id);
    if (hit && hit.kind === 'road') this.fillRoad(hit);
  }

  /* Traffic-light colouring for a readout, so a number carries its own warning. */
  tone(id, cls) {
    const el = this.$(id);
    if (el) el.className = 'vital' + (cls ? ' ' + cls : '');
  }

  /* ---------- panel rendering ---------- */

  fillNode(id) {
    const n = this.sim.city.nodeById[id];
    this.$('ndName').textContent = n.name;
    this.$('ndDistrict').textContent = n.district;
    this.$('btnBusPriority').classList.toggle('on', n.busPriority);
  }

  fillRoad(hit) {
    const rd = this.sim.roads.find(r => r.name === hit.name && r.rev === hit.rev);
    if (!rd) return;
    this.$('rdName').textContent = rd.name;
    this.$('rdClass').textContent = rd.cls;
    this.$('rdFrom').textContent = rd.from.name;
    this.$('rdTo').textContent = rd.to.name;
    this.$('laneAName').textContent = rd.link.a.from.name + ' → ' + rd.link.a.to.name;
    this.$('laneBName').textContent = rd.link.b.from.name + ' → ' + rd.link.b.to.name;
    this.$('rdLanes').textContent = `${rd.link.a.lanes} / ${rd.link.b.lanes}`;
  }

  gradeOf(c) {
    if (c >= 82) return 'A';
    if (c >= 72) return 'B';
    if (c >= 62) return 'C';
    if (c >= 50) return 'D';
    return 'E';
  }

  updateDashboard() {
    const sim = this.sim;
    if (!sim) return;

    /* top bar */
    this.$('simClock').textContent = formatClock(sim.scenario.startClock, sim.time, CFG.clockRate);
    this.$('feedClock').textContent = this.$('simClock').textContent;
    this.$('simPhase').textContent = sim.currentPhase().name;

    /* Live grade. Deliberately the *same* composite the post-run report
       produces, so the letter on the bar is never a different formula from the
       one the analysis closes on. */
    const R = sim.liveReport();
    const letter = this.gradeOf(R.composite);
    const col = letter === 'A' ? 'var(--good)' : letter === 'B' ? '#7fd8c4'
      : letter === 'C' ? 'var(--warn)' : 'var(--bad)';
    const gl = this.$('gradeLetter');
    if (gl.textContent !== letter) gl.textContent = letter;
    gl.style.color = col;
    const gf = this.$('gradeFill');
    gf.style.width = clamp(R.composite, 0, 100) + '%';
    gf.style.background = col;

    /* conditions */
    const condBox = document.querySelector('.clock-cond');
    if (condBox) condBox.classList.toggle('wet', sim.weather.speed < 1);
    this.$('simCond').textContent = sim.weather.label;

    this.updateTimeline();

    /* metrics */
    const m = sim.metrics;
    const budgetPct = (sim.budget / CFG.startBudget) * 100;
    const vals = {
      flow: m.flow, congestion: m.congestion, stability: m.stability,
      satisfaction: m.satisfaction, emergency: m.emergency, budget: budgetPct
    };
    const label = { flow: 'Flow', congestion: 'Congestion', stability: 'Stability', satisfaction: 'Satisfaction', emergency: 'Emergency', budget: 'Budget' };
    for (const k in vals) {
      const v = vals[k];
      const key = label[k];
      this.$('val' + key).textContent = k === 'budget' ? Math.round(sim.budget / 1000) : Math.round(v);
      const bar = this.$('bar' + key);
      bar.style.width = clamp01(v / 100) * 100 + '%';
      let col = '#3fbfae';
      if (k === 'congestion') col = v > 72 ? '#cd5a4f' : v > 48 ? '#d5a03f' : '#3fbfae';
      else if (k === 'budget') col = v < 25 ? '#cd5a4f' : v < 50 ? '#d5a03f' : '#3fbfae';
      else col = v < 40 ? '#cd5a4f' : v < 60 ? '#d5a03f' : '#3fbfae';
      bar.style.background = col;

      /* The delta is the change over the visible sparkline window, so the figure
         and the trace always describe the same period. A dash means "inside
         noise" rather than a printed +0.0, which reads as a measurement when it
         is really just rounding. */
      const h = sim.history[k];
      if (h && h.length > 4) {
        const span = Math.min(12, h.length - 1);
        const d = h[h.length - 1] - h[h.length - 1 - span];
        const el = this.$('delta' + key);
        if (k === 'budget') {
          const credits = (d / 100) * (CFG.startBudget / 1000);
          if (Math.abs(credits) < 0.05) { el.textContent = '\u2014'; el.className = 'metric-delta'; }
          else {
            el.textContent = (credits > 0 ? '+' : '\u2212') + Math.abs(credits).toFixed(1) + 'k';
            el.className = 'metric-delta' + (credits < 0 ? ' spend' : '');
          }
        } else if (Math.abs(d) < 0.5) {
          el.textContent = '\u2014';
          el.className = 'metric-delta';
        } else {
          const risesIsGood = k !== 'congestion';
          el.textContent = (d > 0 ? '+' : '\u2212') + Math.abs(d).toFixed(1);
          el.className = 'metric-delta ' + (d > 0 ? (risesIsGood ? 'up' : 'down') : (risesIsGood ? 'down' : 'up'));
        }
      }
      this.sparkline(k);
    }
    document.querySelector('.metric[data-key="congestion"]').classList.toggle('alert', m.congestion > 78);
    document.querySelector('.metric[data-key="stability"]').classList.toggle('alert', m.stability < 42);

    /* situation card */
    this.$('demandVal').textContent = (sim.demandRate || 0).toFixed(1);
    this.$('activeVal').textContent = sim.totalCars;
    this.$('servedVal').textContent = Math.round(sim.servedRatio * 100);
    this.$('sitPhase').textContent = sim.currentPhase().name;
    this.$('sysId').textContent = 'GRD-' + sim.scenario.num;
    this.renderLiveScores(R);

    /* Coaching retires itself the moment its last lesson has visibly landed. */
    if (this.coachStep === 2 && sim.flashes.length) {
      this.coachStep = 3; this.coachDone = true; this._advSig = null;
    }
    if (++this.advTimer >= ADV_REFRESH_TICKS) { this.advTimer = 0; this._advSig = null; }
    this.renderAdvisory();
    this.renderObjectives();
    this.renderUndo();

    const redirectBtn = this.$('btnRedirect');
    redirectBtn.classList.toggle('on', sim.redirection);
    this.$('redirectSub').textContent = sim.redirection
      ? 'ON — DRIVERS AVOID SATURATED LINKS'
      : 'OFF — DRIVERS USE FREE-FLOW COST';

    const corridorBtn = this.$('btnCorridor');
    const ev = sim.activeEv;
    if (sim.corridorActive()) {
      corridorBtn.className = 'btn wide on urgent';
      this.$('corridorSub').textContent = 'ACTIVE — CROSS MOVEMENTS HELD';
    } else if (ev) {
      corridorBtn.className = 'btn wide on urgent';
      this.$('corridorSub').textContent = 'RESPONSE VEHICLE EN ROUTE — AUTHORISE';
    } else {
      corridorBtn.className = 'btn wide';
      this.$('corridorSub').textContent = 'NO ACTIVE INCIDENT';
    }

    /* selection detail */
    if (this.selected && this.selected.kind === 'node') this.updateNodePanel(this.selected.id);
    if (this.selected && this.selected.kind === 'road') this.updateRoadPanel(this.selected);

    this.renderCards();
    this.renderIncidents();
    this.renderFeed();
  }

  /* The same six components the post-run report breaks down, shown live. Making
     the grading model visible during the shift is what turns the metrics into a
     plan rather than a mystery to be discovered at the end. */
  renderLiveScores(R) {
    const wrap = this.$('liveScores');
    if (!wrap) return;
    const rows = [
      ['TRAFFIC', R.scores.traffic],
      ['RESILIENCE', R.scores.resilience],
      ['RESOURCE', R.scores.resource],
      ['PUBLIC', R.scores.publicScore],
      ['EMERGENCY', R.scores.emergency],
      ['STABILITY', R.scores.stability]
    ];
    const key = rows.map(r => Math.round(r[1])).join(',');
    if (wrap.dataset.k === key) return;                  // rebuild only on change
    wrap.dataset.k = key;
    wrap.innerHTML = rows.map(r => {
      const v = clamp(r[1], 0, 100);
      const col = v >= 70 ? 'var(--good)' : v >= 50 ? 'var(--warn)' : 'var(--bad)';
      return `<div class="ls-row"><span>${r[0]}</span>` +
        `<i><b style="width:${v.toFixed(0)}%;background:${col}"></b></i>` +
        `<em>${v.toFixed(0)}</em></div>`;
    }).join('');
  }

  /* Day plan: phase bands, event ticks, playhead, and the next thing coming. */
  updateTimeline() {
    const sim = this.sim;
    if (this.tlFor !== sim.scenario.id) this.buildTimeline();
    this.$('tlPlay').style.left = (clamp01(sim.time / sim.duration) * 100) + '%';
    this.$('tlNow').textContent = this.$('simClock').textContent;

    const ne = this.$('nextEvent');
    const next = sim.events.find(e => e.t > sim.time);
    if (next) {
      const mins = Math.max(0, Math.round((next.t - sim.time) / CFG.clockRate));
      ne.className = 'next-event' + (next.kind === 'accident' ? ' crit' : '');
      ne.innerHTML = `<span class="ne-t">+${mins}m</span><span class="ne-b">${next.title}</span>`;
    } else {
      ne.className = 'next-event idle';
      ne.innerHTML = '<span class="ne-t">\u2014</span><span class="ne-b">No further events scheduled. Close out the shift.</span>';
    }

    /* The skip control carries the same next-event reading, so the two can
       never disagree about what is coming. */
    const btn = this.$('btnSkip');
    if (btn) {
      const reachable = !sim.finished && next && (next.t - sim.time) > 14;
      btn.disabled = !reachable;
      this.$('skipIn').textContent = sim.finished ? '\u2014'
        : next ? formatClock(sim.scenario.startClock, next.t, CFG.clockRate) : '\u2014';
    }
  }

  sparkline(k) {
    const s = this.sparks[k];
    if (!s || !this.sim) return;
    const h = this.sim.history[k];
    const ctx = s.ctx, w = s.el.width, ht = s.el.height;
    ctx.clearRect(0, 0, w, ht);
    if (!h || h.length < 2) return;

    /* Every series shares a fixed 0..100 vertical band, so the slope of one
       metric is directly comparable with another instead of each being scaled
       to its own min and max. */
    const pad = 4;
    const n = h.length;
    const xAt = i => (i / (n - 1)) * w;
    const yAt = v => ht - pad - clamp01(v / 100) * (ht - pad * 2);

    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = xAt(i), y = yAt(h[i]);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    const tone = k === 'congestion' ? '217,95,82' : k === 'budget' ? '215,162,63' : '63,191,174';
    ctx.strokeStyle = `rgba(${tone},0.88)`;
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    ctx.lineTo(w, ht);
    ctx.lineTo(0, ht);
    ctx.closePath();
    ctx.fillStyle = `rgba(${tone},0.10)`;
    ctx.fill();
  }

  updateNodePanel(id) {
    const n = this.sim.city.nodeById[id];
    const $ = x => this.$(x);

    /* the three numbers that decide what you do here */
    $('ndQueue').textContent = Math.round(n.queue);
    $('ndWait').textContent = n.waitEma.toFixed(1);
    $('ndCong').textContent = Math.round(n.congestion);
    this.tone('vitQueue', n.queue > 26 ? 'crit' : n.queue > 14 ? 'warn' : '');
    this.tone('vitWait', n.waitEma > 38 ? 'crit' : n.waitEma > 22 ? 'warn' : '');
    this.tone('vitCong', n.congestion > 80 ? 'crit' : n.congestion > 58 ? 'warn' : '');

    const st = $('ndStatus');
    if (n.outage) { st.textContent = 'SIGNAL LOSS'; st.className = 'status crit'; }
    else if (n.congestion > 80 || n.queue > 26) { st.textContent = 'CRITICAL'; st.className = 'status crit'; }
    else if (n.congestion > 58 || n.queue > 14) { st.textContent = 'LOADED'; st.className = 'status warn'; }
    else { st.textContent = 'NOMINAL'; st.className = 'status ok'; }

    $('nsGreenVal').textContent = n.nsGreen;
    $('ewGreenVal').textContent = n.ewGreen;
    $('cycleVal').textContent = 'CYCLE ' + n.cycle + 's';

    const share = Math.max(1, n.nsGreen + n.ewGreen);
    const nsPct = Math.round((n.nsGreen / share) * 100);
    $('ndSplitNs').textContent = nsPct;
    $('ndSplitEw').textContent = 100 - nsPct;
    $('splitNs').style.width = nsPct + '%';
    $('splitEw').style.width = (100 - nsPct) + '%';

    let worst = 0;
    for (const rd of n.incoming) if (!rd.closed) worst = Math.max(worst, rd.saturation);
    $('ndApproach').textContent = Math.round(worst * 100);
    $('ndGate').textContent = n.gate ? n.gate.code : 'INTERNAL';
    $('ndVolume').textContent = Math.round(n.volume);
    $('ndIn').textContent = Math.round(n.inflow);
    $('ndOut').textContent = Math.round(n.outflow);
    $('ndMode').textContent = n.outage ? 'FLASH'
      : n.syncAxis ? 'COORD ' + n.syncAxis
      : n.preemptUntil > this.sim.time ? 'PRE-EMPT'
      : n.busPriority ? 'TRANSIT' : 'LOCAL';

    const p = n.phaseAt(this.sim.time);
    const names = { green: 'GREEN', yellow: 'YELLOW', allred: 'ALL-RED', flash: 'ALL-WAY FLASH' };
    $('phaseName').textContent = (p.axis ? p.axis + ' ' : '') + (names[p.state] || '');
    $('phaseCount').textContent = n.outage ? '--' : p.remaining.toFixed(1) + 's';

    $('btnBusPriority').classList.toggle('on', n.busPriority);
    $('busSub').textContent = n.busPriority
      ? 'ON — APPROACHING TRANSIT PRE-EMPTS THE CROSS PHASE'
      : 'OFF — CARS GIVEN THE FULL CYCLE';
  }

  updateRoadPanel(hit) {
    const rd = this.sim.roads.find(r => r.name === hit.name && r.rev === hit.rev);
    if (!rd) return;
    const $ = x => this.$(x);
    rd.updateCapacity();
    $('rdCapacity').textContent = Math.round(rd.capacity);
    $('rdLoad').textContent = rd.cars.length;
    $('rdSat').textContent = Math.round(rd.saturation * 100);
    const v = Math.max(4, rd.effSpeed);
    $('rdTime').textContent = (rd.len / v).toFixed(1);
    $('rdFlow').textContent = Math.round(sum(rd.flow) * 60);
    $('rdFrom').textContent = rd.from.name;
    $('rdTo').textContent = rd.to.name;

    const heavy = rd.saturation > 0.88 ? 'crit' : rd.saturation > 0.62 ? 'warn' : '';
    this.tone('vitSat', heavy);
    this.tone('vitLoad', heavy);
    this.tone('vitTime', heavy);

    const st = $('rdStatus');
    if (rd.closed) { st.textContent = 'CLOSED'; st.className = 'status crit'; }
    else if (rd.incident) { st.textContent = 'INCIDENT'; st.className = 'status warn'; }
    else if (rd.saturation > 0.88) { st.textContent = 'GRIDLOCKED'; st.className = 'status crit'; }
    else if (rd.saturation > 0.6) { st.textContent = 'HEAVY'; st.className = 'status warn'; }
    else { st.textContent = 'OPEN'; st.className = 'status ok'; }

    const link = rd.link;
    $('laneACount').textContent = link.a.lanes;
    $('laneBCount').textContent = link.b.lanes;
    const total = link.a.lanes + link.b.lanes;
    $('laneABar').style.width = (link.a.lanes / total) * 100 + '%';
    $('laneBBar').style.width = (link.b.lanes / total) * 100 + '%';
    $('rdLanes').textContent = `${link.a.lanes} / ${link.b.lanes}`;

    $('laneLeftLbl').textContent = 'GIVE A LANE TO ' + link.a.from.name.toUpperCase();
    $('laneRightLbl').textContent = 'GIVE A LANE TO ' + link.b.from.name.toUpperCase();

    const closed = !!link.a.closed;
    $('closureLbl').textContent = closed ? 'REOPEN SEGMENT' : 'CLOSE SEGMENT';
    $('closureSub').textContent = closed
      ? 'RETURNS THE LINK TO THE ROUTING GRAPH'
      : 'REMOVES THE LINK FROM THE ROUTING GRAPH';

    const narrow = link.baseLanes < 2;
    $('btnLaneLeft').disabled = narrow;
    $('btnLaneRight').disabled = narrow;
  }

  /* ---------- cards / feed ---------- */

  renderCards() {
    const sim = this.sim;
    const layer = this.$('cardLayer');
    const now = sim.time;
    const fresh = sim.cards.filter(c => c.id > this.lastCardId);
    if (fresh.length) {
      for (const c of fresh) {
        const el = document.createElement('div');
        el.className = 'evcard ' + (c.level === 'crit' ? 'crit' : c.level === 'info' ? 'info' : c.level === 'good' ? 'good' : '');
        el.innerHTML = `<div class="ev-top"><span class="ev-title">${c.title}</span><span class="ev-time">${c.clock}</span></div>
          <div class="ev-body">${c.body}</div>`;
        layer.appendChild(el);
        setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 520); }, 7200);
      }
      this.lastCardId = Math.max(...fresh.map(c => c.id));
      while (layer.children.length > 3) layer.removeChild(layer.firstChild);
    }
  }

  clearFeed() { this.$('feedList').innerHTML = ''; this.$('incidentChips').innerHTML = ''; }

  renderFeed() {
    const sim = this.sim;
    const list = this.$('feedList');
    if (list.dataset.n !== String(sim.feed.length)) {
      list.dataset.n = String(sim.feed.length);
      const slice = sim.feed.slice(-70).reverse();
      list.innerHTML = slice.map(f =>
        `<div class="log-row ${f.level}"><span class="lt">${f.clock}</span><span class="lv">${f.tag}</span><span class="lm">${f.msg}</span></div>`
      ).join('');
    }

    /* the collapsed ticker always carries the most recent line */
    const last = sim.feed[sim.feed.length - 1];
    if (!last) return;
    const tag = this.$('feedTag');
    tag.textContent = last.tag;
    tag.className = 'feed-tag' + (last.level === 'crit' ? ' t-crit-t' : '');
    this.$('feedLatest').textContent = last.msg;
    this.$('feedDot').className =
      last.level === 'crit' ? 't-crit' : last.level === 'warn' ? 't-warn'
      : last.level === 'good' ? 't-good' : '';
  }

  renderIncidents() {
    const sim = this.sim;
    const wrap = this.$('incidentChips');
    const items = [];
    for (const rd of sim.roads) {
      if (rd.rev || !rd.incident) continue;
      const left = Math.max(0, Math.round(rd.incident.until - sim.time));
      items.push({ label: `ACCIDENT · ${rd.name}`, t: left, col: '#cd5a4f', dur: Math.max(1, rd.incident.until) });
    }
    for (const l of sim.links) {
      if (!l.a.closed) continue;
      items.push({ label: `CLOSED · ${l.name}`, t: null, col: '#8a5a55', dur: 1 });
    }
    for (const n of sim.nodes) {
      if (!n.outage) continue;
      items.push({ label: `SIGNAL LOSS · ${n.name}`, t: Math.max(0, Math.round(n.outageUntil - sim.time)), col: '#d5a03f', dur: 1 });
    }
    if (sim.activeEv) items.push({ label: `RESPONSE VEHICLE EN ROUTE`, t: null, col: '#46c7d6', dur: 1 });
    if (sim.weather.until > sim.time) items.push({ label: `HEAVY RAIN · NETWORK WIDE`, t: Math.max(0, Math.round(sim.weather.until - sim.time)), col: '#6f93b5', dur: 1 });

    if (!items.length) { wrap.innerHTML = '<div class="inc-empty">No active incidents. Network operating within design parameters.</div>'; return; }
    wrap.innerHTML = items.map(i =>
      `<div class="inc-chip"><i style="background:${i.col}"></i><span>${i.label}</span><span class="t">${i.t == null ? '—' : i.t + 's'}</span></div>`
    ).join('');
  }

  /* ---------- actions ---------- */

  toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    this.$('toastLayer').appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 420); }, 2100);
  }

  apply(result) {
    if (!result) return;
    this.toast(result.msg, result.ok ? 'good' : 'bad');
    /* Advice is stale the moment a control moves, so it is re-evaluated now
       rather than waiting for the next cadence tick. */
    this._advSig = null;
    if (result.ok) {
      if (this.coachStep === 1) { this.coachStep = 2; this._advSig = null; }
      this.updateDashboard();
    }
  }

  doPreset(mode) {
    if (!this.selected || this.selected.kind !== 'node') return;
    this.apply(this.sim.applyPreset(this.selected.id, mode));
  }

  doUndo() {
    this.apply(this.sim.undoLast());
  }

  doGreen(axis, delta) {
    if (!this.selected || this.selected.kind !== 'node') return;
    this.apply(this.sim.adjustGreen(this.selected.id, axis, delta));
  }
  doBus() {
    if (!this.selected || this.selected.kind !== 'node') return;
    this.apply(this.sim.toggleBusPriority(this.selected.id));
  }
  doSync(axis) {
    if (!this.selected || this.selected.kind !== 'node') return;
    this.apply(this.sim.syncCorridor(this.selected.id, axis));
  }
  doLane(dir) {
    if (!this.selected || this.selected.kind !== 'road') return;
    const rd = this.sim.roads.find(r => r.name === this.selected.name && r.rev === this.selected.rev);
    if (rd) this.apply(this.sim.shiftLanes(rd, dir));
  }
  doClosure() {
    if (!this.selected || this.selected.kind !== 'road') return;
    const rd = this.sim.roads.find(r => r.name === this.selected.name && r.rev === this.selected.rev);
    if (rd) this.apply(this.sim.toggleClosure(rd));
  }
  doCorridor() { this.apply(this.sim.authorizeCorridor()); }
  doRedirect() { this.apply(this.sim.toggleRedirection()); }

  /* ---------- report ---------- */

  showReport() {
    this.setSpeed(0);
    const sim = this.sim;
    const R = sim.report();
    const $ = x => this.$(x);
    const objStatus = sim.objectiveStatus();
    const objectivesMet = `${objStatus.filter(o => o.met).length} / ${objStatus.length}`;
    $('repScenario').textContent = `SCENARIO ${sim.scenario.num} — ${sim.scenario.name}`;
    $('repElapsed').textContent = `${formatClock(sim.scenario.startClock, 0, 1)} → ${formatClock(sim.scenario.startClock, sim.duration, CFG.clockRate)}`;
    $('repTrips').textContent = R.trips;
    $('repRating').textContent = R.rating;
    $('repComposite').textContent = `${this.gradeOf(R.composite)}  \u00b7  ${R.composite.toFixed(1)}`;

    const cells = [
      ['AVERAGE TRAVEL TIME', R.avgTravel.toFixed(1), 's'],
      ['MEAN JUNCTION WAIT', R.avgWait.toFixed(1), 's'],
      ['AVERAGE QUEUE LENGTH', R.avgQueue.toFixed(1), 'veh'],
      ['NETWORK CONGESTION (AVG)', R.avgCong.toFixed(0), '%'],
      ['PEAK CONGESTION', R.maxCong.toFixed(0), '%'],
      ['PEAK VEHICLES IN NETWORK', R.peakCars, 'veh'],
      ['TRIP REQUESTS', R.requests, 'trips'],
      ['TRIPS COMPLETED', R.completions, 'trips'],
      ['TRIPS ABANDONED', R.abandoned, 'trips'],
      ['DEMAND SERVED', (R.servedRatio * 100).toFixed(0), '%'],
      ['ABANDONMENT RATE', (R.abandonment * 100).toFixed(1), '%'],
      ['BUDGET REMAINING', Math.round(R.budget / 1000), 'k'],
      ['TOTAL SPEND', Math.round(R.spent / 1000), 'k'],
      ['PUBLIC SATISFACTION', R.satisfaction.toFixed(0), '%'],
      ['SYSTEM STABILITY', R.stability.toFixed(0), '%'],
      ['EMERGENCY RESPONSE',
        R.evRequests === 0 ? 'NO INCIDENT' : R.evAvg == null ? 'NOT COMPLETED' : R.evAvg.toFixed(0),
        R.evAvg == null ? '' : 's'],
      ['RESPONSES COMPLETED',
        R.evRequests === 0 ? '\u2014' : `${R.evCompleted} / ${R.evRequests}`,
        ''],
      ['INTERVENTIONS APPLIED', sim.interventions.length, ''],
      ['SCENARIO OBJECTIVES MET', objectivesMet, '']
    ];
    $('perfGrid').innerHTML = cells.map(c =>
      `<div class="perf-cell"><span class="k">${c[0]}</span><span class="v">${c[1]}${c[2] ? `<em>${c[2]}</em>` : ''}</span></div>`
    ).join('');

    const scores = [
      ['TRAFFIC EFFICIENCY', R.scores.traffic],
      ['NETWORK RESILIENCE', R.scores.resilience],
      ['RESOURCE EFFICIENCY', R.scores.resource],
      ['PUBLIC IMPACT', R.scores.publicScore],
      ['EMERGENCY PERFORMANCE', R.scores.emergency],
      ['SYSTEM STABILITY', R.scores.stability]
    ];
    /* Width is baked inline and revealed by a CSS keyframe — no JS timer, so
       the bars render even when the frame is captured immediately. */
    $('scoreList').innerHTML = scores.map(s => `
      <div class="score-row">
        <span class="lbl">${s[0]}</span>
        <span class="track"><i class="fill" style="--w:${clamp(s[1], 0, 100)}%"></i></span>
        <span class="num">${s[1].toFixed(0)}%</span>
      </div>`).join('');

    /* decisions */
    const dec = sim.interventions;
    $('decisionList').innerHTML = dec.length ? dec.map(d =>
      `<div class="rec"><span class="rt">${d.clock}</span>
        <div class="rbody"><div class="rname">${d.label}</div><div class="rdesc">${d.detail}</div></div>
        <span class="rcost">−${(d.cost / 1000).toFixed(1)}k</span></div>`).join('')
      : `<div class="rec empty">No interventions applied. The network was left to its default signal plan and demand profile.</div>`;

    /* consequences */
    const cons = sim.consequences();
    $('consequenceList').innerHTML = cons.length ? cons.map(c =>
      `<div class="rec"><span class="rt">${c.rec.clock}</span>
        <div class="rbody"><div class="rname">${c.rec.label} — ${c.rec.detail.split('·')[0].trim()}</div>
        <div class="rdesc">${c.lines.join(', ')}.</div></div></div>`).join('')
      : `<div class="rec empty">No interventions were applied, so no second-order effects were observed. The measured network behaviour is the baseline case.</div>`;

    this.showScreen('scrReport');
    $('baselineTable').innerHTML =
      '<div class="baseline-state">Running the unmanaged reference \u2014 the same' +
      ' scenario, same seed, no interventions\u2026</div>';
    this.startBaselineRun(R);
  }

  /* The reference run. Because the demand stream is drawn from its own RNG (see
     the split in Simulation) it is completely independent of what the player
     did, so re-running the scenario with nobody at the desk is an exact
     counterfactual rather than an estimate. It is stepped in slices between
     animation frames: the analysis appears immediately and the comparison lands
     a second later, instead of the screen locking up while it is computed. */
  startBaselineRun(mine) {
    const ref = new Simulation(this.sim.scenario.id);
    const step = 1 / 60;
    const slice = () => {
      const t0 = performance.now();
      while (!ref.finished && performance.now() - t0 < 22) ref.step(step);
      if (!ref.finished) { requestAnimationFrame(slice); return; }
      this.renderBaseline(mine, ref.report());
    };
    requestAnimationFrame(slice);
  }

  renderBaseline(mine, ref) {
    const rows = [
      { label: 'Mean junction wait', a: mine.avgWait, b: ref.avgWait, unit: 's', dp: 1, good: 'low' },
      { label: 'Network congestion', a: mine.avgCong, b: ref.avgCong, unit: '%', dp: 1, good: 'low' },
      { label: 'Demand served', a: mine.servedRatio * 100, b: ref.servedRatio * 100, unit: '%', dp: 1, good: 'high' },
      { label: 'Trips completed', a: mine.completions, b: ref.completions, unit: '', dp: 0, good: 'high' },
      { label: 'Trips abandoned', a: mine.abandoned, b: ref.abandoned, unit: '', dp: 0, good: 'low' },
      { label: 'Mean trip travel time', a: mine.avgTravel, b: ref.avgTravel, unit: 's', dp: 1, good: 'low' },
      { label: 'Emergency response', a: mine.evAvg, b: ref.evAvg, unit: 's', dp: 0, good: 'low' },
      { label: 'Budget remaining', a: mine.budget / 1000, b: ref.budget / 1000, unit: 'k', dp: 0, good: 'high' },
      { label: 'Composite score', a: mine.composite, b: ref.composite, unit: '', dp: 1, good: 'high' }
    ];

    const fmt = (v, r) => v == null ? '\u2014' : v.toFixed(r.dp) + (r.unit ? ' ' + r.unit : '');
    const verdictClass = (r) => {
      if (r.a == null || r.b == null) return 'flat';
      const d = r.a - r.b;
      const eps = r.dp ? 0.05 : 0.5;
      if (Math.abs(d) < eps) return 'flat';
      return (r.good === 'high' ? d > 0 : d < 0) ? 'better' : 'worse';
    };
    const strength = (r) => {
      if (r.a == null || r.b == null) return '';
      const d = r.a - r.b;
      if (Math.abs(d) < (r.dp ? 0.05 : 0.5)) return '\u2014';
      return (d > 0 ? '+' : '\u2212') + Math.abs(d).toFixed(r.dp) +
        (r.unit === '%' ? 'pt' : r.unit === 'k' ? 'k' : r.unit ? ' ' + r.unit : '');
    };

    this.$('baselineTable').innerHTML =
      '<div class="bl-head"><span>MEASURE</span><span>THIS RUN</span><span>UNMANAGED</span><span>DIFFERENCE</span></div>' +
      rows.map(r => `<div class="bl-row"><span>${r.label}</span><b>${fmt(r.a, r)}</b>` +
        `<i>${fmt(r.b, r)}</i><b class="${verdictClass(r)}">${strength(r)}</b></div>`).join('');

    /* Read the two headline movements together. Individually they are just
       numbers; the combination is what says whether traffic was removed from
       the network or merely pushed around it. */
    const waitV = verdictClass(rows[0]), congV = verdictClass(rows[1]);
    const serveV = verdictClass(rows[2]);
    const gap = mine.composite - ref.composite;
    const gapTxt = `${gap >= 0 ? '+' : '\u2212'}${Math.abs(gap).toFixed(1)}`;
    let shape;
    if (waitV === 'better' && congV === 'worse') shape =
      'Mean wait came down while network congestion went up. That is traffic being ' +
      'moved around the system rather than removed from it \u2014 the classic second-order result.';
    else if (waitV === 'worse' && congV === 'better') shape =
      'Congestion fell while mean wait rose: the queues were spread thinner, so fewer people ' +
      'sat in any one junction, but the average journey spent longer stopped.';
    else if (waitV === 'better' && congV === 'better') shape =
      'Wait and congestion both came down together, which is what an actual capacity gain looks ' +
      'like rather than a redistribution.';
    else if (waitV === 'worse' && congV === 'worse') shape =
      'Neither headline measure improved. The interventions cost the network more than they ' +
      'recovered \u2014 the most expensive outcome available.';
    else if (Math.abs(gap) < 2) shape =
      'The managed network finished close to the unmanaged one. Worth reading the decision log ' +
      'against the consequences below: the same traffic was often simply moved between streets.';
    else shape = 'The two headline measures moved in opposite directions depending on which part ' +
      'of the network you look at, which is the normal result of optimising one component of a coupled system.';

    const lead = gap > 2
      ? `Managing the shift beat leaving the network alone by <b>${gapTxt} composite points</b>.`
      : gap < -2
        ? `The run finished <b>${gapTxt} composite points</b> below leaving the network alone.`
        : `Composite finished within noise of leaving the network alone (<b>${gapTxt} points</b>).`;
    const serve = serveV === 'better'
      ? ` It also admitted <b>${(mine.servedRatio * 100 - ref.servedRatio * 100).toFixed(1)} percentage points</b> more of the demand it was asked to carry.`
      : serveV === 'worse'
        ? ` It served <b>${(ref.servedRatio * 100 - mine.servedRatio * 100).toFixed(1)} percentage points</b> less of the demand than doing nothing would have.`
        : '';
    this.$('baselineTable').insertAdjacentHTML('beforeend',
      `<p class="bl-verdict">${lead}${serve} ${shape}</p>`);
  }
}

/* ============================== 10. BOOT ================================== */

if (typeof document !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => { window.__gridlock = new UI(); });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Simulation, City, SCENARIOS, CFG, Intersection, Road, Car, Renderer, UI };
}
