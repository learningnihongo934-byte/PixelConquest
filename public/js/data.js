// Static game data shared by the sim, AI, renderer and UI. Every number here feeds the
// deterministic sim, so changing one changes the game for everyone in a match.

export const TICKS_PER_SEC = 10;
export const TURN_TICKS = 2; // lockstep turn = 2 sim ticks (200ms)

// terrain ids match tools/bake_map.py
export const T = { OCEAN: 0, SHALLOW: 1, PLAINS: 2, FOREST: 3, JUNGLE: 4, DESERT: 5, HILLS: 6, MOUNTAIN: 7, TUNDRA: 8, SNOW: 9, RIVER: 10 };
export const TERRAIN = [
  { name: 'Ocean', water: true, rgb: [30, 52, 92] },
  { name: 'Shallows', water: true, rgb: [44, 84, 132] },
  { name: 'Plains', cost: 1.0, def: 1.0, rgb: [118, 158, 82] },
  { name: 'Forest', cost: 1.4, def: 1.2, rgb: [64, 116, 64] },
  { name: 'Jungle', cost: 1.8, def: 1.3, rgb: [40, 98, 58] },
  { name: 'Desert', cost: 1.3, def: 0.9, rgb: [214, 186, 120] },
  { name: 'Hills', cost: 1.6, def: 1.3, rgb: [146, 140, 92] },
  { name: 'Mountains', cost: 2.6, def: 1.8, rgb: [126, 112, 104] },
  { name: 'Tundra', cost: 1.3, def: 1.0, rgb: [150, 160, 140] },
  { name: 'Snow', cost: 2.0, def: 1.2, rgb: [226, 232, 240] },
  { name: 'River', cost: 1.6, def: 1.25, rgb: [82, 140, 170] },
];

// science needed to reach tier 2, 3, 4
export const TIERS = [0, 0, 60, 240, 600];

// icon = cell in public/art/icons.png (16 per row, 16x16 px)
export const STRUCTURES = {
  capital:    { icon: 0,  name: 'Capital',      tier: 1, cost: 8000, key: '',  desc: '+10 gold/s, +3k troop cap. Losing it slows growth by 30%.' },
  farm:       { icon: 1,  name: 'Farm',         tier: 1, cost: 1200, key: '1', desc: '+25 troops/s growth.' },
  mine:       { icon: 2,  name: 'Mine',         tier: 1, cost: 1500, key: '2', desc: '+12 gold/s, doubled on hills or mountains.' },
  barracks:   { icon: 9,  name: 'Barracks',     tier: 1, cost: 1800, key: '3', desc: '+6,000 troop cap.' },
  lab:        { icon: 5,  name: 'Research Lab', tier: 1, cost: 2000, key: '4', desc: '+1.5 science/s. Science unlocks tiers 2-4.' },
  market:     { icon: 3,  name: 'Market',       tier: 1, cost: 2500, key: '5', desc: '+15 gold/s, +25% more per ally.' },
  bunker:     { icon: 10, name: 'Bunker',       tier: 1, cost: 1500, key: '6', desc: 'Land within 5 tiles is 1.6x harder to take.' },
  watchtower: { icon: 12, name: 'Watchtower',   tier: 1, cost: 1000, key: '7', desc: 'Reveals enemy structures within 18 tiles. 1.25x defense nearby.' },
  harbor:     { icon: 6,  name: 'Harbor',       tier: 1, cost: 3000, key: '8', coastal: true, desc: 'Coast only. Sends troop boats across water. +8 gold/s.' },
  fortress:   { icon: 11, name: 'Fortress',     tier: 2, cost: 6000, key: 'q', desc: 'Land within 8 tiles is 2.5x harder to take.' },
  artillery:  { icon: 15, name: 'Artillery',    tier: 2, cost: 5000, key: 'w', desc: 'Shells hostile land within 10 tiles every 3s. Attacks nearby cost 25% less.' },
  rail:       { icon: 7,  name: 'Rail Hub',     tier: 2, cost: 4000, key: 'e', desc: 'Attacks launched within 14 tiles move 50% faster. +10% troop growth.' },
  hospital:   { icon: 8,  name: 'Field Hospital', tier: 2, cost: 3500, key: 'r', desc: 'Your attacks lose 15% fewer troops (stacks to 3).' },
  navalyard:  { icon: 16, name: 'Naval Yard',   tier: 2, cost: 6000, key: 't', coastal: true, desc: 'Coast only. Launches 2 warships that hunt enemy boats.' },
  radar:      { icon: 14, name: 'Radar',        tier: 3, cost: 5000, key: 'a', desc: 'Reveals structures within 40 tiles and enemy troop counts.' },
  shield:     { icon: 13, name: 'Shield Dome',  tier: 3, cost: 9000, key: 's', desc: 'Stops missiles within 14 tiles. 3 charges, 1 back every 20s.' },
  airbase:    { icon: 17, name: 'Airbase',      tier: 3, cost: 8000, key: 'd', desc: 'Paradrop troops up to 70 tiles away (right-click land).' },
  oil:        { icon: 4,  name: 'Oil Derrick',  tier: 3, cost: 6000, key: 'f', terrain: [5, 8, 9], desc: 'Desert, tundra or snow only. +45 gold/s.' },
  spy:        { icon: 19, name: 'Spy HQ',       tier: 3, cost: 7000, key: 'g', desc: 'Sabotage: disable an enemy structure for 40s and steal 10% gold.' },
  silo:       { icon: 18, name: 'Missile Silo', tier: 3, cost: 12000, key: 'h', desc: 'Launch strikes and EMPs (tier 3) and nukes (tier 4).' },
};
export const STRUCTURE_ORDER = Object.keys(STRUCTURES).filter((k) => k !== 'capital');

export const MISSILES = {
  strike: { name: 'Strike Missile', icon: 22, cost: 6000, tier: 3, range: 140, radius: 6 },
  emp:    { name: 'EMP',            icon: 27, cost: 5000, tier: 3, range: 140, radius: 10 },
  nuke:   { name: 'Nuke',           icon: 23, cost: 30000, tier: 4, range: 9999, radius: 14 },
};

export const ABILITIES = {
  blitz:    { name: 'Blitz',    icon: 27, key: 'z', cd: 900, dur: 150, desc: 'Attacks move 2x faster and cost 15% less for 15s.' },
  entrench: { name: 'Entrench', icon: 28, key: 'x', cd: 900, dur: 200, desc: 'Your land is 1.5x harder to take for 20s.' },
  rally:    { name: 'Rally',    icon: 29, key: 'c', cd: 1200, gold: 3000, desc: '+20% troops now (can go over cap), costs 3,000 gold.' },
};

export const EMOTES = ['Hello!', 'Good game', 'Ally?', 'Leave me alone', 'Attack them!', 'Help!', 'Oops', 'Nice move', 'You are next', 'Peace?'];

export const ICON = { troops: 25, gold: 26, science: 5, explosion: 24, transport: 20, warship: 21, missile: 22, nuke: 23, plane: 17, peace: 30, war: 31 };

export const COLORS = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990',
  '#dcbeff', '#9a6324', '#00e5a0', '#800000', '#aaffc3', '#ff3d7f', '#ffd8b1', '#3d2bff', '#ff9ff3', '#ffe119',
  '#ff6f61', '#6b5b95', '#88b04b', '#f7cac9', '#92a8d1', '#955251', '#b565a7', '#009b77', '#dd4124', '#d65076',
  '#45b8ac', '#efc050', '#5b5ea6', '#9b2335', '#dfcfbe', '#55b4b0', '#e15d44', '#7fcdcd', '#bc243c', '#c3447a',
];

export const AI_DIFFICULTY = {
  easy:   { name: 'Easy',   econ: 0.7, think: 20, aggro: 0.6, smart: 0 },
  normal: { name: 'Normal', econ: 1.0, think: 10, aggro: 1.0, smart: 1 },
  hard:   { name: 'Hard',   econ: 1.2, think: 7,  aggro: 1.3, smart: 2 },
  brutal: { name: 'Brutal', econ: 1.5, think: 5,  aggro: 1.6, smart: 3 },
};

const SYL_A = ['Vor', 'Kes', 'Ald', 'Bran', 'Cor', 'Dun', 'El', 'Fen', 'Gal', 'Har', 'Ist', 'Jor', 'Kal', 'Lor', 'Mar', 'Nor', 'Os', 'Pel', 'Quin', 'Ros', 'Sar', 'Tal', 'Ul', 'Val', 'Wes', 'Yar', 'Zan'];
const SYL_B = ['land', 'tria', 'mark', 'heim', 'ovia', 'gard', 'ania', 'reach', 'stan', 'mere', 'dor', 'vale', 'ora', 'holm', 'ica', 'wyn'];
export function empireName(n) {
  return SYL_A[n % SYL_A.length] + SYL_B[Math.floor(n / SYL_A.length) % SYL_B.length];
}
