export const SPEC9 = ['#FF3D3D','#FF7A1A','#FFD51F','#B7FF3B','#2CE66A','#29E6E6','#2F6BFF','#8A3DFF','#FF3BBD'];

export const ZONES = [
  { id:'ridge',  name:'EASTERN RIDGE', tag:'WARM',   accent:'#FF7A1A', hunters:312, hunts:4, loot:'$44.50',  diff:'BEGINNER', blurb:'Where the clue points. Gentle hunts, friendly crowd.' },
  { id:'flats',  name:'GOLDEN FLATS',  tag:'BUSY',   accent:'#FFD51F', hunters:540, hunts:7, loot:'$128.00', diff:'OPEN',      blurb:'The busiest board. Big prizes, big competition.' },
  { id:'tide',   name:'NEON TIDE',     tag:'NEW',    accent:'#29E6E6', hunters:171, hunts:5, loot:'$67.00',  diff:'OPEN',      blurb:'Fresh grid, just dropped. Clues still cooling.' },
  { id:'hollow', name:'DEEP HOLLOW',   tag:'EXPERT', accent:'#8A3DFF', hunters:96,  hunts:3, loot:'$310.00', diff:'EXPERT',    blurb:'High-stakes vault grid. Hardest games, richest loot.' },
];

export const COLS = 12;
export const ROWS = 18;

const HUNTS = {
  '2,9':  { prize:'$12.00', beat:38, creator:'@maya' },
  '8,1':  { prize:'$5.50',  beat:12, creator:'@deji' },
  '14,8': { prize:'$24.00', beat:71, creator:'@ama'  },
  '5,11': { prize:'$3.00',  beat:6,  creator:'@kofi' },
};
const PUZZLES = {
  '4,6':  { xp:120, beat:9,  creator:'@deji' },
  '10,2': { xp:80,  beat:4,  creator:'@ama'  },
  '13,9': { xp:150, beat:17, creator:'@zara' },
};
const SEEDS = {
  '1,2':  { type:'clue'  },
  '2,6':  { type:'empty' },
  '3,3':  { type:'found', prize:'$4.20' },
  '4,9':  { type:'trap'  },
  '5,1':  { type:'empty' },
  '6,7':  { type:'mystery' },
  '7,10': { type:'clue'  },
  '8,4':  { type:'empty' },
  '9,8':  { type:'puzzle' },
  '11,2': { type:'found', prize:'$8.00' },
  '12,9': { type:'empty' },
  '13,5': { type:'trap'  },
  '15,7': { type:'clue'  },
  '16,3': { type:'empty' },
  '10,5': { type:'mystery' },
  '14,2': { type:'empty' },
};

function hiddenType(r, c) {
  const h = (r * 31 + c * 17 + 5) % 100;
  if (h < 56) return 'empty';
  if (h < 73) return 'clue';
  if (h < 85) return 'trap';
  if (h < 94) return 'mystery';
  return 'puzzle';
}

export function buildGrid() {
  const cells = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const k = `${r},${c}`;
      const cell = { id: k, r, c, opened: false, treasure: false, seedOpened: false, runtimeOpened: false, type: hiddenType(r, c) };
      if (HUNTS[k]) {
        Object.assign(cell, { treasure: true, type: 'treasure', ...HUNTS[k] });
      } else if (PUZZLES[k]) {
        Object.assign(cell, { puzzle: true, type: 'puzzleHunt', ...PUZZLES[k] });
      } else if (SEEDS[k]) {
        cell.opened = true;
        cell.seedOpened = true;
        cell.type = SEEDS[k].type;
        if (SEEDS[k].prize) cell.prize = SEEDS[k].prize;
      }
      cells.push(cell);
    }
  }
  return cells;
}

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
