// The 12matt3r roster + store, cast as people/places at the festival.
// Each destination is someone (or something) you walk up to in the crowd.
// `role` places them in the world; `accent` drives their aura + label colour.

export const PALETTE = {
  cyan: '#00F3FF',
  magenta: '#FF0055',
  green: '#39FF14',
  purple: '#b967ff',
  orange: '#ff6b35',
  gold: '#e6c04a',
  ink: '#e6e6f0',
  bg: '#05050e',
};

// Positions are in world units on the festival ground plane.
// The stage sits at -Z (crowd faces it); spawn bench is at +Z.
export const DESTINATIONS = [
  {
    id: 'ravecharles',
    name: 'RAVE CHARLES',
    role: 'headliner // on the main stage',
    accent: PALETTE.magenta,
    pos: [0, 0, -22],          // up on the stage
    onStage: true,
    tag: 'rapper · DJ · founder',
    blurb: 'The headliner running the decks — nearly 400 shows across America, 2014–2020. Walk to the front and his live-history timeline opens.',
    cta: 'Open the tour timeline',
  },
  {
    id: 'shmorez',
    name: 'SHMOREZ',
    role: 'in the pit // front-left',
    accent: PALETTE.orange,
    pos: [-8, 0, -6],
    tag: 'dubstep · weird bass',
    blurb: 'An animated electronic marshmallow squish of fire, throwing down in the pit. His EPK — custom player, press assets, the drops — opens when you reach him.',
    cta: 'Enter SHMOREZ EPK',
  },
  {
    id: 'driftwave',
    name: 'DRIFTWAVE STATIC',
    role: 'chill zone // left',
    accent: PALETTE.purple,
    pos: [-14, 0, 2],
    tag: 'ambient · vaporwave',
    blurb: 'Off to the side in the slushwave chill zone — looping transmissions and neon dusk. The calm counterweight to the main stage.',
    cta: 'Enter DriftWave EPK',
  },
  {
    id: 'tanky',
    name: 'TANKY JOHNSON',
    role: 'crowd // right',
    accent: PALETTE.gold,
    pos: [11, 0, -4],
    tag: 'outlaw country',
    blurb: 'The outlaw of the void, holding down the right flank. Gold-on-black EPK: bio, latest tracks, and a booking desk.',
    cta: 'Enter Tanky EPK',
  },
  {
    id: 'studio',
    name: '12MATT3R',
    role: 'the VJ booth // visuals',
    accent: PALETTE.cyan,
    pos: [7, 0, 8],
    tag: 'glitch art · code · the collective',
    blurb: 'At the VJ booth driving every screen at the festival — the web-OS and glitch-art engine that houses all of this. This is the studio itself.',
    cta: 'Open the web-OS',
  },
  {
    id: 'store',
    name: 'THE MERCH TENT',
    role: 'commissions // off-Etsy',
    accent: PALETTE.green,
    pos: [-6, 0, 12],
    tag: 'high-ticket commissions',
    blurb: 'The vendor at the merch tent. Productized packages — visual identity, audio branding, a web-OS build like this one — with pricing, a tip jar, and an intake + NDA flow. Where the experience converts.',
    cta: 'Browse commissions',
  },
];
