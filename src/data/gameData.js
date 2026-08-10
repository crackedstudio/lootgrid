export const SPEC9 = ['#FF3D3D','#FF7A1A','#FFD51F','#B7FF3B','#2CE66A','#29E6E6','#2F6BFF','#8A3DFF','#FF3BBD'];

/**
 * Presentation copy only, keyed by the zone ids the server owns. Names, accents,
 * epochs and live hunt counts all come from GET /zones.
 *
 * NOTE: `buildGrid`, `hiddenType`, HUNTS, PUZZLES and SEEDS used to live here.
 * They are gone on purpose — the grid was computable from the bundle, so every
 * treasure location was readable from devtools. The map now exists only on the
 * server, and the client is told about a cell once somebody uncovers it.
 */
export const ZONE_COPY = {
  ridge:  { tag: 'WARM',   diff: 'BEGINNER', blurb: 'Where the clue points. Gentle hunts, friendly crowd.' },
  flats:  { tag: 'BUSY',   diff: 'OPEN',     blurb: 'The busiest board. Big prizes, big competition.' },
  tide:   { tag: 'NEW',    diff: 'OPEN',     blurb: 'Fresh grid, just dropped. Clues still cooling.' },
  hollow: { tag: 'EXPERT', diff: 'EXPERT',   blurb: 'High-stakes vault grid. Hardest games, richest loot.' },
};

export const BOARD_DATA = {
  daily: [
    { rank:1, handle:'@maya',   won:'$48.20', finds:9 },
    { rank:2, handle:'@ama',    won:'$36.00', finds:7 },
    { rank:3, handle:'@deji',   won:'$24.50', finds:6 },
    { rank:4, handle:'@0xKofi', won:'$18.00', finds:5 },
    { rank:5, handle:'@otaiki', won:'$12.00', finds:4, you:true },
    { rank:6, handle:'@zara',   won:'$8.40',  finds:3 },
    { rank:7, handle:'@tomi',   won:'$5.00',  finds:2 },
  ],
  all: [
    { rank:1, handle:'@deji',   won:'$1,204', finds:212 },
    { rank:2, handle:'@maya',   won:'$980',   finds:188 },
    { rank:3, handle:'@otaiki', won:'$642',   finds:141, you:true },
    { rank:4, handle:'@ama',    won:'$511',   finds:120 },
    { rank:5, handle:'@0xKofi', won:'$430',   finds:103 },
    { rank:6, handle:'@zara',   won:'$295',   finds:77  },
  ],
};

export const PROFILE_FINDS = [
  { type:'found',  label:'CRACKED A HUNT', meta:'$12.00 · beat 38 · 2h ago', color:'#FFD51F' },
  { type:'clue',   label:'FOUND A CLUE',   meta:'eastern ridge · 5h ago',    color:'#29E6E6' },
  { type:'puzzle', label:'SOLVED A PUZZLE',meta:'+120 XP · yesterday',        color:'#8A3DFF' },
  { type:'found',  label:'CRACKED A HUNT', meta:'$5.50 · beat 12 · 2d ago',  color:'#FFD51F' },
];

export const ONB_CARDS = [
  { bg:'#FF7A1A', kick:'01 — HUNT',    title:'A LIVING MAP OF HIDDEN PRIZES', body:'Tap to uncover fog tiles. Clues run warm when treasure is near. Spend energy, follow the trail.' },
  { bg:'#29E6E6', kick:'02 — COMPETE', title:'FIRST TO CRACK IT WINS',        body:'Treasure tiles glow with the spectrum. Beat everyone else to the mini-game — speed and skill, not luck.' },
  { bg:'#FFD51F', kick:'03 — WIN REAL',title:'CASH SOMEONE ELSE PUT UP',      body:'Every hunt is pre-funded and locked on-chain. Win it and it pays straight to your MiniPay wallet.' },
];

export const HOME_COINS = [
  { left:'8%',  top:'12%', color:'#FFD51F', size:28, delay:0    },
  { left:'86%', top:'16%', color:'#29E6E6', size:22, delay:0.3  },
  { left:'15%', top:'72%', color:'#FF7A1A', size:34, delay:0.6  },
  { left:'80%', top:'68%', color:'#2CE66A', size:26, delay:0.9  },
  { left:'48%', top:'7%',  color:'#FF3BBD', size:22, delay:1.2  },
  { left:'70%', top:'38%', color:'#FFD51F', size:30, delay:1.5  },
  { left:'24%', top:'42%', color:'#8A3DFF', size:26, delay:1.8  },
  { left:'90%', top:'50%', color:'#FF3D3D', size:22, delay:2.1  },
];
