# GRIDLOCK — Urban Traffic Systems Console

A real-time traffic-control simulation in the browser. You are the engineer
responsible for a twelve-junction city network: balance signal timing, lane
allocation, transit priority and emergency corridors across a full simulated
day, while rush peaks, incidents and weather stress the system.

The design brief it was built against: interventions that help one part of the
network must visibly harm another — measured from the simulation, not scripted.

## Run it

Open `index.html` in any modern browser. That's it — no build step, no
backend, no dependencies, nothing fetched at runtime.

Optional (avoids any file:// quirks):

```bash
python -m http.server 8000
# then open http://localhost:8000
```

## The three shifts

| Scenario | Character |
|---|---|
| **Morning Rush** | Inbound tidal demand, an early incident, rain late morning. |
| **Event Day** | A stadium lets out mid-shift; one district absorbs the surge. |
| **Emergency** | A serious collision plus an inbound response vehicle — keep the city moving while clearing a corridor. |

Each scenario is a full day cycle: morning peak, midday, evening peak,
overnight. Press **Space** to hold the clock while you study the network.

## How it works

`script.js` is a self-contained microsimulation:

- **Network** — 12 signalised junctions, 19 road links (38 directed roads)
  with lanes, capacity, speed limits and storage.
- **Vehicles** — car-following with hard headway (no overlap), per-lane
  saturation-flow discharge gated by signal phase, spillback: a full link
  refuses entry, so queues physically propagate upstream.
- **Routing** — Dijkstra over the live network with congestion-weighted
  link cost; closures and congestion cause emergent rerouting, and closures
  are removed from the graph outright.
- **Signals** — two-phase (NS/EW) controllers with cycle, split and offset;
  corridor synchronisation harmonises cycle and offsets without stealing
  green from the dominant movement.
- **Consequences** — every intervention snapshots the network and re-measures
  ~26 s later; the log and post-run report show the *measured* second-order
  effects, not canned numbers.
- **Scoring** — weighted composite of traffic efficiency, network stability,
  resource efficiency (return on spend), public impact, emergency response
  and resilience. Doing nothing scores in the mid-50s; engaged play can do
  meaningfully better — or worse, if you over-correct.

## Controls

| Key | Action |
|---|---|
| `Space` | Hold / resume the clock |
| `1` `2` `4` | Simulation speed |
| `←` `→` | Cycle through junctions |
| `Esc` | Deselect asset |
| `H` | How-to overlay (mid-game: resume) |

Click any junction or road on the map to open its control surface.

## Development

Test harnesses are excluded from the repo but kept locally by convention:

- `_calib.js` — lever-by-lever scoring calibration across scenarios
- `_ev.js` — emergency-vehicle lifecycle and corridor payoff
- `_order.js` — vehicle ordering / storage invariants
- `_probe.js` — scenario-level invariants (spawn totals, over-capacity)
- `_shot.js` / `_shot.sh` — headless-Chrome screenshot driver

## Stack

Vanilla HTML / CSS / JavaScript. Canvas 2D renderer. Zero dependencies.
