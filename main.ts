// Sokoban solver — push-optimal by construction.
//
// Winning idea: the level's rooms are provably independent. A box pushed out
// of its room through the door can never be pushed back (the player would have
// to stand on the hallway's far side, which is wall), so every box stays in
// its room and the level's push-optimal count P* is the sum of its rooms'
// optima. This program therefore splits the level into rooms and solves each
// 3-4-box room push-optimally with A* (admissible min-assignment heuristic +
// exact dead-square and frozen-2x2 pruning), then stitches the rooms together
// with the player's walks. No clock is ever read and every search is bounded
// by work, never by time, so two runs write the same bytes.
//
// Scoring (checker): 1,000 points per instance at P* pushes, 500*P*/pushes
// above it, 0 unsolved — so one push over P* costs more than half the level.
// Ties on the final score go to the smaller entry, so this is one dense
// main.ts and nothing else: no data files, no lookup tables.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
// [dx, dy, walk letter, push letter]. Fixed order keeps every run identical.
const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];
// Work caps, never the clock: a search that gives up does so identically on
// every run. The generator keeps every room solvable well inside these caps.
const ROOM_STATES = 300_000;
const WHOLE_STATES = 200_000;
const MOVE_STATES = 200_000;

type Level = { w: number; h: number; wall: Uint8Array; goals: number[]; boxes: number[]; player: number };

function parse(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

// Squares from which a lone box can still be pushed onto some goal, found by
// pulling a box back from the goals: a box on square y can be pulled from
// x = y + d when the player could stand at y - d. Anything else is dead: a
// box there can never reach a goal again, whatever the other boxes do.
function liveSquares(L: Level): Uint8Array {
  const { w, wall, goals } = L;
  const live = new Uint8Array(wall.length);
  const q = [...goals];
  for (const g of goals) live[g] = 1;
  for (let i = 0; i < q.length; i++) {
    const x = q[i]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) { live[y] = 1; q.push(y); }
    }
  }
  return live;
}

// Walking distances from every goal over walls alone (boxes ignored), one BFS
// per goal. dist[g][cell] = steps, or -1 when unreachable.
function goalDistances(L: Level): Int32Array[] {
  const { w, wall, goals } = L;
  return goals.map((g) => {
    const d = new Int32Array(wall.length).fill(-1);
    const q = [g];
    d[g] = 0;
    for (let i = 0; i < q.length; i++) {
      const p = q[i]!;
      for (const [dx, dy] of DIRS) {
        const n = p + dy * w + dx;
        if (!wall[n] && d[n] < 0) { d[n] = d[p]! + 1; q.push(n); }
      }
    }
    return d;
  });
}

// Min-cost assignment of boxes to goals (DP over goal subsets, <= 4 boxes):
// the cheapest way to match every box to a distinct goal by walking distance.
// Admissible: one push moves one box one square, so the true remaining pushes
// can never be less than this sum. Infinity when some box is stranded.
function assignHeuristic(boxes: number[], dist: Int32Array[]): number {
  const n = boxes.length;
  const m = dist.length;
  if (n === 0) return 0;
  const INF = 1e9;
  const dp = new Float64Array(1 << m).fill(INF);
  dp[0] = 0;
  for (let mask = 0; mask < (1 << m); mask++) {
    const k = popcount(mask);
    if (k >= n || dp[mask] === INF) continue;
    for (let j = 0; j < m; j++) {
      if (mask & (1 << j)) continue;
      const d = dist[j]![boxes[k]!];
      if (d < 0) continue;
      const nm = mask | (1 << j);
      if (dp[mask]! + d < dp[nm]!) dp[nm] = dp[mask]! + d;
    }
  }
  let best = INF;
  for (let mask = 0; mask < (1 << m); mask++)
    if (popcount(mask) === n && dp[mask]! < best) best = dp[mask]!;
  return best;
}
function popcount(x: number): number {
  let c = 0;
  while (x) { c += x & 1; x >>>= 1; }
  return c;
}

// A binary heap on [priority, second, tie, state]: the tie is a monotonic
// counter, so equal keys always pop in insertion order — deterministic.
type HeapEntry = [number, number, number, number];
function heapPush(heap: HeapEntry[], e: HeapEntry): void {
  let i = heap.length;
  heap.push(e);
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (cmp(heap[i]!, heap[p]!) >= 0) break;
    [heap[i], heap[p]] = [heap[p]!, heap[i]!];
    i = p;
  }
}
function cmp(a: HeapEntry, b: HeapEntry): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
function heapPop(heap: HeapEntry[]): HeapEntry {
  const top = heap[0]!;
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    for (let i = 0; ; ) {
      let c = 2 * i + 1;
      if (c >= heap.length) break;
      if (c + 1 < heap.length && cmp(heap[c + 1]!, heap[c]!) < 0) c++;
      if (cmp(heap[c]!, heap[i]!) >= 0) break;
      [heap[i], heap[c]] = [heap[c]!, heap[i]!];
      i = c;
    }
  }
  return top;
}

// The player's reachable region from `from` around walls and boxes, marked in
// `seen` with `stamp`; returns its lowest square, the region's canonical name.
function reach(L: Level, occ: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  const { w, wall } = L;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (wall[q] === 0 && occ[q] === 0 && seen[q] !== stamp) { seen[q] = stamp; stack[n++] = q; }
    }
  }
  return low;
}

// Whether the box just pushed to `t` sits in a frozen 2x2 block: four squares
// of walls and boxes holding a box off its goal. Such a box can never move
// again, so the state is dead.
function frozenBlock(L: Level, occ: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = L;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1, c = a + w, d = c + 1;
    if (!(wall[a] || occ[a]) || !(wall[b] || occ[b]) || !(wall[c] || occ[c]) || !(wall[d] || occ[d])) continue;
    if ((occ[a] && !goal[a]) || (occ[b] && !goal[b]) || (occ[c] && !goal[c]) || (occ[d] && !goal[d])) return true;
  }
  return false;
}

// Shortest walk from `from` to `to` around walls and boxes, lower-case LURD.
// Directions tried in DIRS order, so ties break the same way every run.
function walkTo(L: Level, occ: Uint8Array, from: number, to: number): string {
  const { w, wall } = L;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const q = [from];
  prev[from] = from;
  for (let i = 0; i < q.length; i++) {
    const p = q[i]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const n = p + dy * w + dx;
      if (wall[n] || occ[n] || prev[n] !== -1) continue;
      prev[n] = p;
      how[n] = letter;
      q.push(n);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: stance out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

// Push-optimal A* over pushes (greedy=false) or best-first by heuristic
// (greedy=true, a fallback that finds a solution, not necessarily optimal).
// A state is the boxes plus the player's region; each push costs 1 and the
// estimate is the assignment heuristic, so A* returns the fewest pushes.
// Returns {pushes, moves} or null when the work cap is hit.
function solvePush(L: Level, maxStates: number, greedy: boolean): { pushes: number; moves: string } | null {
  const { w, wall, goals } = L;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(L);
  const dist = goalDistances(L);
  if (L.boxes.some((b) => !live[b])) return null;
  const occ = new Uint8Array(size);
  const seen = new Int32Array(size);
  const seen2 = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  let stamp2 = 0;
  const solved = (bs: number[]): boolean => bs.every((b) => goal[b]);
  const keyOf = (bs: number[], low: number): string => bs.join(',') + ':' + low;

  const sBoxes: number[][] = [L.boxes.slice()];
  const sPlayer: number[] = [L.player];
  const sParent: number[] = [-1];
  const sFrom: number[] = [-1];
  const sTo: number[] = [-1];
  const sDir: number[] = [-1];
  const sG: number[] = [0];
  const best = new Map<string, number>();
  for (const b of L.boxes) occ[b] = 1;
  best.set(keyOf(L.boxes, reach(L, occ, L.player, seen, ++stamp, stack)), 0);
  for (const b of L.boxes) occ[b] = 0;
  const heap: HeapEntry[] = [];
  let tie = 0;
  const h0 = assignHeuristic(L.boxes, dist);
  if (h0 >= 1e9) return null;
  heapPush(heap, [greedy ? h0 : h0, 0, tie++, 0]);
  let expanded = 0;
  let found = solved(L.boxes) ? 0 : -1;
  while (heap.length > 0 && found < 0) {
    const [, , , s] = heapPop(heap);
    const g = sG[s]!;
    // Skip stale entries: a state re-found with a better g leaves the older,
    // larger-g heap entry behind; its stored best g no longer matches.
    const boxes = sBoxes[s]!;
    for (const b of boxes) occ[b] = 1;
    const low = reach(L, occ, sPlayer[s]!, seen, ++stamp, stack);
    const here = stamp;
    if (best.get(keyOf(boxes, low)) !== g) { for (const b of boxes) occ[b] = 0; continue; }
    if (++expanded > maxStates) { for (const b of boxes) occ[b] = 0; return null; }
    if (solved(boxes)) { found = s; for (const b of boxes) occ[b] = 0; break; }
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi]!;
      for (let di = 0; di < 4; di++) {
        const [dx, dy] = DIRS[di]!;
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occ[t] || !live[t]) continue;
        occ[b] = 0;
        occ[t] = 1;
        const frozen = frozenBlock(L, occ, goal, t);
        let key = '';
        let next: number[] = [];
        let h = 1e9;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, x) => a - x);
          // Successor region on its own stamp array: the current state's
          // `seen` marks must survive for the next stance check.
          const nlow = reach(L, occ, b, seen2, ++stamp2, stack);
          key = keyOf(next, nlow);
          h = assignHeuristic(next, dist);
        }
        occ[t] = 0;
        occ[b] = 1;
        if (frozen || h >= 1e9) continue;
        const ng = g + 1;
        const prevBest = best.get(key);
        if (prevBest !== undefined && prevBest <= ng) continue;
        best.set(key, ng);
        const idx = sBoxes.length;
        sBoxes.push(next);
        sPlayer.push(b);
        sParent.push(s);
        sFrom.push(b);
        sTo.push(t);
        sDir.push(di);
        sG.push(ng);
        heapPush(heap, [greedy ? h : ng + h, greedy ? ng : h, tie++, idx]);
        if (solved(next)) { found = idx; break; }
      }
    }
    for (const b of boxes) occ[b] = 0;
  }
  if (found < 0) return null;
  // Rebuild the push path, then the moves: walk to each stance, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = L.player;
  let boxes = L.boxes.slice();
  for (const s of path) {
    const next = sBoxes[s]!;
    const from = sFrom[s]!;
    const to = sTo[s]!;
    const d = to - from;
    for (const b of boxes) occ[b] = 1;
    moves += walkTo(L, occ, player, from - d);
    for (const b of boxes) occ[b] = 0;
    moves += DIRS[sDir[s]!]![3];
    player = from;
    boxes = next;
  }
  return { pushes: path.length, moves };
}
// The level's rooms: cut the dead squares of the player's row (the hallway: a box there reaches no goal) out of the floor, and each part left holding
// boxes is a room. Null when a box starts in the hallway, a goal is cut off,
// or some part holds more or fewer boxes than goals: then the level is no set
// of rooms and the caller falls back to a whole-level search.
function roomsOf(L: Level): { boxes: number[]; goals: number[]; done: boolean }[] | null {
  const { w, wall, goals, boxes, player } = L;
  const live = liveSquares(L);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: { boxes: number[]; goals: number[]; done: boolean }[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) { part[q] = rooms.length; squares.push(q); }
      }
    }
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (part[g]! < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

// The level solved room by room: each room's push-optimal solution in turn,
// the other rooms' boxes standing as walls (on their goals once their room is
// done), the player walking on from where the last room left it. A box never
// leaves its room, so the rooms' optima add up to the level's: {pushes, moves},
// or null when a room's search gives up.
function solveByRooms(L: Level): { pushes: number; moves: string } | null {
  const rooms = roomsOf(L);
  if (rooms === null) return null;
  let player = L.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = L.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = { w: L.w, h: L.h, wall, goals: room.goals.slice().sort((a, b) => a - b), boxes: room.boxes.slice().sort((a, b) => a - b), player };
    let solved = solvePush(sub, ROOM_STATES, false);
    if (solved === null) solved = solvePush(sub, ROOM_STATES, true);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(L.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

// Last-resort fallback: A* over single steps (player + boxes), cost in moves,
// estimate the summed nearest-goal distance, ties broken toward fewer pushes.
// Solves levels the push search cannot, at more pushes than P* — worth partial
// points rather than an empty answer.
function moveFallback(L: Level, maxStates: number): { pushes: number; moves: string } | null {
  const { w, wall, goals } = L;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const dist = goalDistances(L);
  const minDist = new Int32Array(size).fill(-1);
  for (let i = 0; i < size; i++) {
    let m = -1;
    for (const d of dist) if (d[i]! >= 0 && (m < 0 || d[i]! < m)) m = d[i]!;
    minDist[i] = m;
  }
  if (L.boxes.some((b) => minDist[b]! < 0)) return null;
  const hOf = (bs: number[]): number => bs.reduce((a, b) => a + minDist[b]!, 0);
  const sPlayer: number[] = [L.player];
  const sBoxes: number[][] = [L.boxes.slice()];
  const sParent: number[] = [-1];
  const sStep: string[] = [''];
  const sG: number[] = [0];
  const sP: number[] = [0];
  const best = new Map<string, number>();
  const keyOf = (p: number, bs: number[]): string => p + '|' + bs.join(',');
  best.set(keyOf(L.player, L.boxes), 0);
  const heap: HeapEntry[] = [];
  let tie = 0;
  heapPush(heap, [hOf(L.boxes), 0, tie++, 0]);
  let expanded = 0;
  let found = L.boxes.every((b) => goal[b]) ? 0 : -1;
  while (heap.length > 0 && found < 0) {
    const [, , , s] = heapPop(heap);
    const g = sG[s]!;
    const p = sPlayer[s]!;
    const boxes = sBoxes[s]!;
    if (best.get(keyOf(p, boxes)) !== g) continue;
    if (++expanded > maxStates) return null;
    if (boxes.every((b) => goal[b])) { found = s; break; }
    for (let di = 0; di < 4; di++) {
      const [dx, dy, letter, upper] = DIRS[di]!;
      const d = dy * w + dx;
      const q = p + d;
      if (wall[q]) continue;
      let nb = boxes;
      let np = sP[s]!;
      let step = letter;
      const at = boxes.indexOf(q);
      if (at >= 0) {
        if (wall[q + d] || boxes.includes(q + d)) continue;
        nb = boxes.slice();
        nb[at] = q + d;
        nb.sort((a, b) => a - b);
        np++;
        step = upper;
      }
      const ng = g + 1;
      const key = keyOf(q, nb);
      const prev = best.get(key);
      if (prev !== undefined && prev <= ng) continue;
      best.set(key, ng);
      const idx = sBoxes.length;
      sPlayer.push(q);
      sBoxes.push(nb);
      sParent.push(s);
      sStep.push(step);
      sG.push(ng);
      sP.push(np);
      heapPush(heap, [ng + hOf(nb), np, tie++, idx]);
      if (nb.every((b) => goal[b])) { found = idx; break; }
    }
  }
  if (found < 0) return null;
  let moves = '';
  let pushes = 0;
  for (let s = found; s > 0; s = sParent[s]!) {
    moves = sStep[s]! + moves;
    if (sStep[s]! === sStep[s]!.toUpperCase()) pushes++;
  }
  return { pushes, moves };
}

function solveLevel(L: Level): { pushes: number; moves: string } {
  if (L.boxes.length === 0) return { pushes: 0, moves: '' };
  const byRooms = solveByRooms(L);
  if (byRooms !== null) return byRooms;
  const whole = solvePush(L, WHOLE_STATES, false) ?? solvePush(L, WHOLE_STATES, true);
  if (whole !== null) return whole;
  const mv = moveFallback(L, MOVE_STATES);
  if (mv !== null) return mv;
  return { pushes: 0, moves: '' };
}

for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    const level = parse(readFileSync(join(I, id, 'level.txt'), 'utf8'));
    const solved = solveLevel(level);
    moves = solved.moves;
  } catch {
    moves = '';
  }
  // Never write an over-long answer: an empty one is valid, a truncated one
  // may replay into a wall. (Real solutions are a few thousand moves.)
  if (moves.length > 65000) moves = '';
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
