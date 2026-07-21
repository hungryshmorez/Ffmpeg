# 12matt3r // The Festival

A walkable 3D EDM-festival portfolio experience. You spawn on a bench at the
edge of the crowd, staring at the main stage. Walk through the crowd and reach
an artist to open their world — each destination is a **person at the festival**,
not a menu item.

Built with **Three.js + Vite**. This is the immersive landing layer for the
12matt3r store: the "wow" that always ends on a way to hire you.

## The world

| Destination        | Where they are at the festival        |
| ------------------ | ------------------------------------- |
| **Rave Charles**   | Headliner, up on the main stage       |
| **12matt3r**       | The VJ booth, driving every screen     |
| **SHMOREZ**        | In the pit, front-left                 |
| **DriftWave Static** | The chill zone, off to the left      |
| **Tanky Johnson**  | Holding the right flank                |
| **The Merch Tent** | Commissions / pricing / tip jar / NDA  |

Reach a character (walk within range, or click their name to auto-walk over)
and their destination panel opens with a call to action.

## Run it

```bash
npm install
npm run dev      # local dev server (hot reload)
npm run build    # production build → dist/
npm run preview  # preview the production build
```

Then open the printed URL.

## Controls

- **W A S D** / arrow keys — walk
- **drag** — look around
- **click a person's name** — auto-walk to them
- **Shift** — run
- **◐ motion** button — toggle reduced motion (also honours the OS setting)

## Structure

```
src/
  main.js               orchestration, input, beat clock, render loop
  data/destinations.js  the roster, cast as festival roles + copy
  scene/festival.js     ground, sky, stage, LED screen, lights, lasers, haze
  scene/crowd.js        instanced bobbing crowd + glowsticks
  scene/characters.js   the named artists (walk-to destinations)
  player/controls.js    first-person walk + look + auto-walk
  ui/hud.js             projected name tags + proximity panel
```

Everything is beat-driven (128 BPM): a `pulse` value spikes on each beat and
feeds the stage lights, LED screen, crowd bounce, and character auras.

## Status — prototype

This is a first cut proving the concept. Known next steps:
- Wire each destination CTA to the real EPK / store instead of the stub.
- Feed the crowd/lights from real audio (Web Audio analyser) instead of a fixed BPM.
- Nicer character models + the spawn bench object; merch tent, VJ booth structures.
- Mobile on-screen movement + pinch, and touch-tuned targets.
- Code-split the Three.js bundle (currently one ~500 KB chunk).
