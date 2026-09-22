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

## The interface

The map is the interface. It fills the window and everything else floats over
it, so no panel ever steals width from the network:

- **Top bar** — clock, operating phase, live system grade.
- **Metric strip** — six network indicators with inline trend traces.
- **Day timeline** — the shift laid out end to end: demand phases as bands,
  scheduled events as ticks, and a playhead showing where you are.
- **Control panel** — either the current situation, or the selected asset.
- **Event ticker** — the latest log line; click to expand the full log.

Selecting a junction or road replaces the situation card with its controls.
Everything else stays out of the way until it is needed.

## The three shifts

| Scenario | Character |
|---|---|
| **Morning Rush** | Inbound tidal demand, an early incident, rain late morning. |
| **Event Day** | A stadium lets out mid-shift; one district absorbs the surge. |
| **Emergency** | A serious collision plus an inbound response vehicle — keep the city moving while clearing a corridor. |

Press **Space** to hold the clock while you study the network.

## Reading the grade

The letter in the top bar is the *same* weighted composite the post-run report
closes on — traffic efficiency 28%, public impact 20%, resilience 18%, resource
efficiency 16%, emergency response 12%, stability 6%. The situation card breaks
that composite into its components live, so you can see which part of your
performance is holding the grade down while there is still time to act.

Doing nothing scores in the mid-50s. Engaged play can do meaningfully better —
or worse, if you over-correct.

## Seeing the consequences

Every intervention snapshots the network and re-measures it about 26 seconds
later. When that measurement lands, badges appear **on the map** at the places
that actually moved. Raise green time at a junction and you will typically see
one green badge there and one red badge somewhere else: the second-order effect,
drawn where it happened rather than asserted in a text box.

The same measurements are written up in prose in the post-run analysis under
*System Consequences*.

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
  it later; the map badges, the event log and the report all read from those
  measurements, never from canned numbers.

## Controls

| Input | Action |
|---|---|
| Scroll | Zoom about the cursor |
| Drag | Pan the map |
| Double-click a junction | Focus it |
| Click | Select a junction or road |
| `Space` | Hold / resume the clock |
| `1` `2` `4` | Simulation speed |
| `←` `→` | Step through junctions |
| `F` | Fit the network to view |
| `Esc` | Deselect |
| `H` | Operating brief (mid-game: resume) |

## Development

Test harnesses are gitignored but kept locally by convention:

- `_verify.js` — simulation invariants: scenario baselines, determinism,
  intervention settling, badge emission and expiry, closure cascade, live
  grade agreement, budget floor
- `_calib.js` — lever-by-lever scoring calibration across scenarios
- `_ev.js` — emergency-vehicle lifecycle and corridor payoff
- `_order.js` — vehicle ordering / storage invariants
- `_probe.js` — scenario-level invariants (spawn totals, over-capacity)
- `_shot.sh` / `_shot.js` — headless-Chrome screenshot driver

```bash
node _verify.js     # expects "N passed, 0 failed"
```

## Stack

Vanilla HTML / CSS / JavaScript. Canvas 2D renderer. Zero dependencies.
