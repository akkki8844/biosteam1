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

- **Top bar** — clock, operating phase, live system grade, pacing controls.
- **Metric strip** — six network indicators with inline trend traces.
- **Map layers** — switch the link colouring, place names and bus network on
  and off, so the same city can be read as a congestion map, a schematic, or a
  transit map.
- **Day timeline** — the shift laid out end to end: demand phases as bands,
  scheduled events as ticks, and a playhead showing where you are.
- **Control panel** — scenario objectives pinned at the top, then either the
  current situation or the selected asset.
- **Event ticker** — the latest log line; click to expand the full log.

Selecting a junction or road replaces the situation card with its controls. The
objectives stay pinned above it, because the moment you open a junction's
controls is exactly the moment its objective matters. Everything else stays out
of the way until it is needed.

The map carries its own furniture — a scale bar, a north mark — so it reads as a
plan drawing rather than a picture.

### Pacing

The clock runs at hold, 1×, 2× or 4×. **NEXT EVENT** fast-forwards to just before
the next scheduled event, stepping the simulation at its own fixed timestep — so
a skipped stretch is the same day you would have sat through, not an
approximation of it. That is what makes a seven-minute shift finish inside five.

### Reverting

Every completed decision can be undone once, refunding its cost. **REVERT** in
the panel head (or `R`) rolls back the most recent intervention only, so an
experiment you regret does not have to be lived with for the rest of the shift.

### Objectives

Each scenario carries three measurable objectives, shown live with progress and
evaluated against the same report the final grade uses. Doing nothing fails all
three: the passive reference run completes none of them in any scenario.

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

## Against doing nothing

The analysis closes with the comparison the whole project is about. At the end of
every run the scenario is re-simulated from scratch with nobody at the desk —
same seed, same demand curve, same incidents, no interventions. Because the
demand stream is drawn from its own random stream, independent of player action,
that re-run is an exact counterfactual rather than a model of one: a shift that
changed nothing scores identically to it, to the decimal.

The report tabulates both runs side by side and then reads the two headline
movements together, because the combination is what says whether traffic was
*removed* from the system or merely pushed around it:

- wait down and congestion up — redistributed, not solved
- wait and congestion both down — an actual capacity gain
- both up — the interventions cost more than they recovered

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
| `N` | Skip to the next scheduled event |
| `R` | Revert the last decision |
| `H` | Operating brief (mid-game: resume) |

## Development

Test harnesses are gitignored but kept locally by convention:

- `_verify.js` — simulation invariants: scenario baselines, determinism,
  intervention settling, badge emission and expiry, closure cascade, live
  grade agreement, budget floor, counterfactual integrity, and fast-forward
  equivalence (a skipped run reproduces the frame-stepped run exactly)
- `_calib.js` — lever-by-lever scoring calibration across scenarios
- `_ev.js` — emergency-vehicle lifecycle and corridor payoff
- `_order.js` — vehicle ordering / storage invariants
- `_probe.js` — scenario-level invariants (spawn totals, over-capacity)
- `_shot.sh` / `_shot.js` — headless-Chrome screenshot driver

```bash
node _verify.js     # expects "N passed, 0 failed"
bash _shot.sh       # re-renders every screen to shots/
```

## Stack

Vanilla HTML / CSS / JavaScript. Canvas 2D renderer. Zero dependencies.
