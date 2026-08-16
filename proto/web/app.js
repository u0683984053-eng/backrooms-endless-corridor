// web/app.js — 浏览器前端（canvas 2D 俯视渲染，程序化纹理 + 灯光体系 + 迷雾 + 氛围层 + 理智视觉）
// 纯原生 JS/CSS，零依赖，离屏缓存保证 60fps。含"野性层级"无尽生成入口与 localStorage 存档。

import { loadLevels, mutateDna, AESTHETIC_POOL } from '../engine/dna.js';
import {
  createGame,
  step,
  playerVisibleTiles,
  serializeState,
  deserializeState,
  enterLevel,
} from '../engine/game.js';
import { ITEM_META, viewRadiusOf } from '../engine/player.js';
import { ENTITY_DEFS } from '../engine/entities.js';
import { hashString } from '../engine/rng.js';

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const canvas = $('game-canvas');
const ctx = canvas.getContext('2d');
const mapCanvas = $('map-canvas');
const mapCtx = mapCanvas.getContext('2d');

const SAVE_KEY = 'backrooms.save.v1';
const CODEX_KEY = 'backrooms.codex.v1';
const WILD_KEY = 'backrooms.wild.v1';

// ---------- 全局状态 ----------
let levels = null; // {id -> dna}
let game = null; // 当前对局 state
let lastLevelId = null;
let shiftHeld = false;
let touchMode = false;
let now = 0; // 每帧时间戳（performance.now）

// ---------- 存储工具 ----------
function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 存档失败不致命
  }
}

/** 全局错误可见化：任何运行异常都在屏幕底部展示（线上诊断用） */
function showFatal(msg) {
  let el = document.getElementById('fatal-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fatal-banner';
    el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#7a1e1e;color:#ffd9d9;padding:10px 14px;font:12px/1.5 monospace;white-space:pre-wrap;';
    document.body.appendChild(el);
  }
  el.textContent = '⚠ 运行异常（请截图反馈）：' + msg;
}
window.addEventListener('error', (e) => showFatal(e.message || '未知错误'));
window.addEventListener('unhandledrejection', (e) => showFatal(String((e.reason && e.reason.message) || e.reason)));

/** 安全执行：按钮回调统一入口，异常不静默吞掉 */
function safeRun(fn) {
  try {
    fn();
  } catch (err) {
    console.error(err);
    showFatal(err && err.message ? err.message : String(err));
  }
}

let codex = loadJSON(CODEX_KEY, { levels: {}, deaths: [], notes: [] });
let wildRegistry = loadJSON(WILD_KEY, {}); // { wildId: { baseId, seed } }

function saveCodex() {
  saveJSON(CODEX_KEY, codex);
}

function saveWildRegistry() {
  saveJSON(WILD_KEY, wildRegistry);
}

/** 去重（对象按 JSON 字符串判重） */
function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr || []) {
    const k = typeof x === 'object' && x !== null ? JSON.stringify(x) : String(x);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}

/** 把持久化 Codex 并入当前对局（并集） */
function mergeCodexIntoGame() {
  if (!game) return;
  const lib = codex.levels || {};
  const fresh = game.codex.levels || {};
  const merged = {};
  for (const id of new Set([...Object.keys(lib), ...Object.keys(fresh)])) {
    const l = lib[id] || {};
    const f = fresh[id] || {};
    merged[id] = {
      id,
      name: f.name || l.name || id,
      visits: f.visits || 0,
      firstVisitTurn: f.firstVisitTurn ?? l.firstVisitTurn ?? 0,
      notes: dedupe([...(l.notes || []), ...(f.notes || [])]),
      deaths: f.deaths || 0,
    };
  }
  game.codex = {
    levels: merged,
    deaths: dedupe([...(codex.deaths || []), ...(game.codex.deaths || [])]),
    notes: dedupe([...(codex.notes || []), ...(game.codex.notes || [])]),
  };
}

function syncCodexFromGame() {
  if (!game || !game.codex) return;
  codex = {
    levels: game.codex.levels,
    deaths: dedupe(game.codex.deaths || []),
    notes: dedupe(game.codex.notes || []),
  };
  saveCodex();
}

// ---------- 数据加载（loader 注入） ----------
try {
  levels = await loadLevels({
    fetch: async (p) => {
      // 多候选路径：本地 server.js 映射 /data/ → 项目 data/；
      // GitHub Pages 部署在子路径下时用相对路径 ../../data/ 回退。
      const candidates = ['/' + p, '../../' + p, '../' + p];
      let lastErr = null;
      for (const c of candidates) {
        try {
          const res = await fetch(c);
          if (res.ok) return await res.text();
          lastErr = `HTTP ${res.status}: ${c}`;
        } catch (e) {
          lastErr = `${e.message || e}: ${c}`;
        }
      }
      throw new Error(lastErr);
    },
  });
  // 恢复之前生成的野性层级（跨会话可继续）
  for (const id of Object.keys(wildRegistry)) {
    const rec = wildRegistry[id];
    const base = levels[rec && rec.baseId];
    if (base && !levels[id]) levels[id] = mutateDna(base, rec.seed);
  }
} catch (err) {
  document.body.innerHTML = `<div style="padding:40px;color:#e85a4a">数据加载失败：${err.message}<br>请通过 <b>node server.js</b> 启动后访问。</div>`;
  throw err;
}

// ---------- 存档 ----------
function saveGame() {
  if (!game) return;
  syncCodexFromGame();
  if (!game.over) saveJSON(SAVE_KEY, serializeState(game));
  else { try { localStorage.removeItem(SAVE_KEY); } catch { /* 忽略 */ } }
}

function newGame() {
  const seed = Math.floor(Math.random() * 1e6);
  game = createGame({ levels, seed });
  mergeCodexIntoGame();
  lastLevelId = game.levelId;
  hideOverlay('start-screen');
  document.body.classList.add('in-game');
  rebuildVisuals();
  renderAll();
  saveGame();
  // 与野性入口一致的可见反馈：跌入层级过渡遮罩（含层级名与描述）
  const dna = game.levels[game.levelId];
  showTransition(`你跌入了 ${dna.name}（难度 Class ${dna.difficultyClass}）\n${dna.description}`, 3400);
}

function continueGame() {
  const data = loadJSON(SAVE_KEY, null);
  if (!data) {
    // 无存档：直接开新局（按钮始终可点，不再静默禁用）
    newGame();
    return;
  }
  game = createGame({ levels, seed: data.runSeed || 1 });
  try {
    deserializeState(game, data);
  } catch (err) {
    console.warn('读档失败，开启新冒险：', err);
    game = createGame({ levels, seed: Math.floor(Math.random() * 1e6) });
  }
  mergeCodexIntoGame();
  lastLevelId = game.levelId;
  hideOverlay('start-screen');
  document.body.classList.add('in-game');
  rebuildVisuals();
  renderAll();
  saveGame();
  if (game.over) showDeath();
}

/** 进入野性层级：对 Level 0 做 DNA 变异（seed 随机），注册后可跨会话重建 */
function enterWild() {
  if (!game) newGame();
  if (game.over) newGame(); // 死亡后需先开新局
  const wildSeed = Math.floor(Math.random() * 1e6);
  const base = levels['level-0'];
  const dna = mutateDna(base, wildSeed);
  levels[dna.id] = dna;
  wildRegistry[dna.id] = { baseId: 'level-0', seed: wildSeed };
  saveWildRegistry();
  const prev = game.levelId;
  enterLevel(game, dna.id, { keepPlayer: true });
  rebuildVisuals();
  document.body.classList.add('in-game');
  if (game.levelId !== prev) {
    showTransition(`你挤进一道墙缝……\n${dna.name}\n${dna.description}`, 3400);
  }
  renderAll();
  saveGame();
}

// ---------- 遮罩 / 弹窗 ----------
function showOverlay(id) {
  $(id).classList.remove('hidden');
}

function hideOverlay(id) {
  $(id).classList.add('hidden');
}

let transitionTimer = null;
let typewriterTimer = null;

/** 层级过渡遮罩：故障效果 + 打字机展示层级名/难度/描述 */
function showTransition(text, duration = 2600) {
  const ov = $('transition-overlay');
  const box = $('transition-text');
  clearTimeout(transitionTimer);
  clearInterval(typewriterTimer);
  box.textContent = '';
  ov.classList.remove('hidden');
  // 打字机逐字展示
  let i = 0;
  typewriterTimer = setInterval(() => {
    i = Math.min(text.length, i + 2);
    box.textContent = text.slice(0, i);
    if (i >= text.length) clearInterval(typewriterTimer);
  }, 28);
  transitionTimer = setTimeout(() => {
    clearInterval(typewriterTimer);
    ov.classList.add('hidden');
  }, duration);
}

/** 幻觉闪现：假消息 1.5s 后消失 */
let hallucinationTimer = null;
function flashHallucination(text) {
  const el = $('hallucination');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(hallucinationTimer);
  hallucinationTimer = setTimeout(() => el.classList.add('hidden'), 1500);
}

// ---------- 死亡结算 ----------
function showDeath() {
  const g = game;
  $('death-title').textContent = g.over === 'assimilated' ? '你被层级同化了' : '你死了';
  const discovered = Object.keys(g.codex.levels || {});
  const deaths = (g.codex.deaths || []).length;
  const notes = (g.codex.notes || []).length;
  $('death-body').innerHTML = `
    <div class="death-stats">
      <div class="ds">死因：<b>${g.deathCause || '未知'}</b></div>
      <div class="ds">存活回合：<b>${g.turn}</b></div>
      <div class="ds">发现层级：<b>${discovered.length}</b>（${discovered.map((id) => g.codex.levels[id].name).join('、') || '仅 Level 0'}）</div>
      <div class="ds">日志笔记：<b>${notes}</b> 条</div>
      <div class="ds">死亡记录：<b>${deaths}</b> 次</div>
      <div class="ds">最终位置：<b>${g.codex.levels[g.levelId] ? g.codex.levels[g.levelId].name : g.levelId}</b></div>
    </div>
    <p class="hint">Codex 已更新：本次发现已写入存档。</p>
  `;
  showOverlay('death-modal');
  saveGame();
}

// ============================================================
// 视觉系统：程序化纹理 / 道具矢量 / 实体剪影 / 氛围粒子
// 全部离屏 canvas 预渲染并缓存，每帧只 drawImage，保证 60fps。
// ============================================================

const TS = 48; // 纹理瓦片分辨率（绘制时缩放到实际瓦片大小）

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// ---------- 颜色工具 ----------
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return { r: 136, g: 136, b: 136 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** 明度调整（delta -255..255） */
function shade(hex, delta) {
  const { r, g, b } = hexToRgb(hex);
  const c = (v) => Math.min(255, Math.max(0, v + delta));
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** 不规则斑点 */
function blob(g, x, y, r) {
  g.beginPath();
  const seg = 8;
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const rr = r * (0.6 + Math.random() * 0.7);
    const px = x + Math.cos(a) * rr;
    const py = y + Math.sin(a) * rr;
    i === 0 ? g.moveTo(px, py) : g.lineTo(px, py);
  }
  g.closePath();
  g.fill();
}

/** 随机裂缝折线 */
function crack(g, x, y) {
  let cx = x;
  let cy = y;
  g.beginPath();
  g.moveTo(cx, cy);
  for (let i = 0; i < 4; i++) {
    cx += (Math.random() - 0.5) * 14;
    cy += 3 + Math.random() * 8;
    g.lineTo(cx, cy);
  }
  g.stroke();
}

// ---------- 墙纹理（7 种 wallStyle） ----------
function makeWallTexture(style, pal) {
  const c = makeCanvas(TS, TS);
  const g = c.getContext('2d');
  const base = pal.primary || '#8a847a';
  g.fillStyle = base;
  g.fillRect(0, 0, TS, TS);
  switch (style) {
    case 'wallpaper': {
      // 竖条纹 + 污渍斑点
      for (let x = 0; x < TS; x += 8) {
        g.fillStyle = x % 16 === 0 ? shade(base, -10) : shade(base, 5);
        g.fillRect(x, 0, 8, TS);
      }
      for (let i = 0; i < 6; i++) {
        g.fillStyle = `rgba(60,50,30,${0.05 + Math.random() * 0.08})`;
        blob(g, Math.random() * TS, Math.random() * TS, 3 + Math.random() * 8);
      }
      break;
    }
    case 'tile': {
      // 勾缝网格 + 砖面微差
      for (let y = 0; y < TS; y += 16) {
        for (let x = 0; x < TS; x += 16) {
          g.fillStyle = `rgba(0,0,0,${0.04 + Math.random() * 0.07})`;
          g.fillRect(x + 1, y + 1, 14, 14);
        }
      }
      g.strokeStyle = shade(base, -28);
      g.lineWidth = 2;
      for (let i = 0; i <= TS; i += 16) {
        g.beginPath(); g.moveTo(i, 0); g.lineTo(i, TS); g.stroke();
        g.beginPath(); g.moveTo(0, i); g.lineTo(TS, i); g.stroke();
      }
      break;
    }
    case 'concrete': {
      // 裂纹 + 斑点
      for (let i = 0; i < 9; i++) {
        g.fillStyle = `rgba(0,0,0,${0.05 + Math.random() * 0.09})`;
        blob(g, Math.random() * TS, Math.random() * TS, 1.5 + Math.random() * 3);
      }
      g.strokeStyle = 'rgba(0,0,0,0.16)';
      g.lineWidth = 1;
      crack(g, Math.random() * TS, Math.random() * TS);
      break;
    }
    case 'metal': {
      // 横向拉丝 + 铆钉
      for (let y = 0; y < TS; y += 3) {
        g.fillStyle = y % 6 === 0 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.07)';
        g.fillRect(0, y, TS, 3);
      }
      const rivets = [
        [6, 6],
        [TS - 6, 6],
        [6, TS - 6],
        [TS - 6, TS - 6],
      ];
      g.fillStyle = shade(base, -22);
      for (const [x, y] of rivets) {
        g.beginPath(); g.arc(x, y, 2.5, 0, Math.PI * 2); g.fill();
      }
      g.fillStyle = 'rgba(255,255,255,0.28)';
      for (const [x, y] of rivets) {
        g.beginPath(); g.arc(x - 0.8, y - 0.8, 1, 0, Math.PI * 2); g.fill();
      }
      break;
    }
    case 'brick': {
      // 错缝砖块
      const bh = 12;
      const bw = 16;
      for (let row = 0; row * bh < TS; row++) {
        const off = row % 2 === 0 ? 0 : bw / 2;
        for (let x = -bw; x < TS + bw; x += bw) {
          g.fillStyle = (row + Math.floor((x + off) / bw)) % 2 === 0 ? shade(base, 7) : shade(base, -7);
          g.fillRect(x + off, row * bh, bw - 2, bh - 2);
        }
      }
      g.strokeStyle = shade(base, -32);
      g.lineWidth = 1.5;
      for (let row = 0; row * bh <= TS; row++) {
        g.beginPath(); g.moveTo(0, row * bh); g.lineTo(TS, row * bh); g.stroke();
      }
      for (let row = 0; row * bh < TS; row++) {
        const off = row % 2 === 0 ? 0 : bw / 2;
        for (let x = off - bw; x < TS + bw; x += bw) {
          g.beginPath(); g.moveTo(x, row * bh); g.lineTo(x, (row + 1) * bh); g.stroke();
        }
      }
      break;
    }
    case 'glass': {
      // 透明玻璃 + 高光
      g.fillStyle = 'rgba(170,205,230,0.34)';
      g.fillRect(0, 0, TS, TS);
      g.strokeStyle = 'rgba(255,255,255,0.5)';
      g.lineWidth = 2;
      g.strokeRect(2, 2, TS - 4, TS - 4);
      g.strokeStyle = 'rgba(255,255,255,0.28)';
      g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(TS * 0.3, 0); g.lineTo(TS * 0.55, TS); g.stroke();
      g.beginPath(); g.moveTo(TS * 0.62, 0); g.lineTo(TS * 0.87, TS); g.stroke();
      break;
    }
    case 'drywall': {
      // 平整 + 轻微噪点
      for (let i = 0; i < 34; i++) {
        g.fillStyle = `rgba(${Math.random() < 0.5 ? '0,0,0' : '255,255,255'},${0.02 + Math.random() * 0.03})`;
        g.fillRect(Math.random() * TS, Math.random() * TS, 1 + Math.random() * 2, 1 + Math.random() * 2);
      }
      break;
    }
    default:
      break;
  }
  return c;
}

// ---------- 地纹理（floorStyle 各型，含 water 静态底） ----------
function makeFloorTexture(style, pal) {
  const c = makeCanvas(TS, TS);
  const g = c.getContext('2d');
  const base = pal.secondary || '#6a665e';
  g.fillStyle = base;
  g.fillRect(0, 0, TS, TS);
  switch (style) {
    case 'carpet': {
      // 细噪点 + 暗纹
      for (let i = 0; i < 130; i++) {
        g.fillStyle = `rgba(0,0,0,${0.03 + Math.random() * 0.06})`;
        g.fillRect(Math.random() * TS, Math.random() * TS, 2, 2);
      }
      g.strokeStyle = 'rgba(0,0,0,0.07)';
      g.lineWidth = 2;
      for (let y = 4; y < TS; y += 12) {
        g.beginPath(); g.moveTo(0, y); g.lineTo(TS, y); g.stroke();
      }
      break;
    }
    case 'tile': {
      // 棋盘格 + 勾缝
      for (let y = 0; y < TS; y += 16) {
        for (let x = 0; x < TS; x += 16) {
          g.fillStyle = (x / 16 + y / 16) % 2 === 0 ? shade(base, 8) : shade(base, -12);
          g.fillRect(x, y, 16, 16);
        }
      }
      g.strokeStyle = 'rgba(0,0,0,0.22)';
      g.lineWidth = 1;
      for (let i = 0; i <= TS; i += 16) {
        g.beginPath(); g.moveTo(i, 0); g.lineTo(i, TS); g.stroke();
        g.beginPath(); g.moveTo(0, i); g.lineTo(TS, i); g.stroke();
      }
      break;
    }
    case 'linoleum': {
      // 纯色 + 光泽条
      g.fillStyle = 'rgba(255,255,255,0.1)';
      g.fillRect(0, 10, TS, 6);
      g.fillStyle = 'rgba(255,255,255,0.06)';
      g.fillRect(0, 30, TS, 3);
      for (let i = 0; i < 12; i++) {
        g.fillStyle = `rgba(0,0,0,${0.02 + Math.random() * 0.04})`;
        g.fillRect(Math.random() * TS, Math.random() * TS, 5, 2);
      }
      break;
    }
    case 'concrete': {
      for (let i = 0; i < 60; i++) {
        g.fillStyle = `rgba(0,0,0,${0.03 + Math.random() * 0.06})`;
        g.fillRect(Math.random() * TS, Math.random() * TS, 2, 2);
      }
      g.strokeStyle = 'rgba(0,0,0,0.12)';
      g.lineWidth = 1;
      crack(g, Math.random() * TS, Math.random() * TS);
      break;
    }
    case 'water': {
      // 波光静态底（动画高光在渲染层叠加）
      g.fillStyle = shade(base, -12);
      g.fillRect(0, 0, TS, TS);
      g.strokeStyle = 'rgba(255,255,255,0.14)';
      g.lineWidth = 1.5;
      for (let y = 0; y < TS; y += 6) {
        g.beginPath();
        for (let x = 0; x <= TS; x += 6) {
          const yy = y + Math.sin(x * 0.5 + y) * 1.5;
          x === 0 ? g.moveTo(x, yy) : g.lineTo(x, yy);
        }
        g.stroke();
      }
      break;
    }
    case 'wood': {
      // 木纹
      for (let y = 0; y < TS; y += 8) {
        g.fillStyle = y % 16 === 0 ? shade(base, 7) : shade(base, -7);
        g.fillRect(0, y, TS, 8);
      }
      g.strokeStyle = 'rgba(0,0,0,0.16)';
      g.lineWidth = 1;
      for (let i = 0; i < 5; i++) {
        g.beginPath();
        const y0 = Math.random() * TS;
        g.moveTo(0, y0);
        g.lineTo(TS, y0 + (Math.random() - 0.5) * 6);
        g.stroke();
      }
      break;
    }
    case 'grass':
    case 'gravel': {
      for (let i = 0; i < 90; i++) {
        g.fillStyle = `rgba(${Math.random() < 0.5 ? '40,70,30' : '120,120,110'},${0.2 + Math.random() * 0.3})`;
        g.beginPath();
        g.arc(Math.random() * TS, Math.random() * TS, 1 + Math.random() * 1.5, 0, Math.PI * 2);
        g.fill();
      }
      break;
    }
    default:
      break;
  }
  return c;
}

// ---------- 道具矢量造型（extraFeatures 12 种） ----------
function makePropTexture(kind, pal) {
  const c = makeCanvas(TS, TS);
  const g = c.getContext('2d');
  const acc = pal.accent || '#c8b46a';
  const prim = pal.primary || '#8a847a';
  switch (kind) {
    case 'counter': {
      g.fillStyle = shade(prim, 12);
      g.fillRect(4, 24, 40, 20);
      g.fillStyle = shade(prim, 32);
      g.fillRect(4, 24, 40, 5);
      g.strokeStyle = 'rgba(0,0,0,0.3)';
      g.lineWidth = 2;
      g.strokeRect(4, 24, 40, 20);
      break;
    }
    case 'shelves': {
      g.fillStyle = shade(prim, -12);
      g.fillRect(8, 6, 32, 38);
      g.strokeStyle = 'rgba(0,0,0,0.35)';
      g.lineWidth = 1.5;
      g.strokeRect(8, 6, 32, 38);
      g.fillStyle = shade(prim, 22);
      for (const y of [16, 26, 36]) g.fillRect(10, y, 28, 3);
      g.fillStyle = acc;
      g.fillRect(12, 11, 6, 3);
      g.fillStyle = '#6a9a7a';
      g.fillRect(22, 11, 6, 3);
      g.fillStyle = '#9a6a9a';
      g.fillRect(30, 11, 6, 3);
      break;
    }
    case 'column': {
      g.fillStyle = shade(prim, -18);
      g.fillRect(18, 4, 12, 40);
      g.fillStyle = 'rgba(255,255,255,0.22)';
      g.fillRect(19, 4, 3, 40);
      g.fillStyle = shade(prim, 12);
      g.fillRect(14, 4, 20, 4);
      g.fillRect(14, 40, 20, 4);
      break;
    }
    case 'furniture': {
      g.fillStyle = shade(prim, -6);
      roundRect(g, 6, 14, 36, 26, 5);
      g.fill();
      g.fillStyle = shade(prim, 16);
      roundRect(g, 6, 14, 36, 8, 5);
      g.fill();
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.fillRect(10, 35, 28, 3);
      break;
    }
    case 'door': {
      g.strokeStyle = shade(prim, -36);
      g.lineWidth = 3;
      g.strokeRect(4, 2, 40, 44);
      g.fillStyle = shade(prim, -8);
      g.fillRect(7, 5, 34, 41);
      g.strokeStyle = 'rgba(0,0,0,0.35)';
      g.lineWidth = 1.5;
      g.strokeRect(10, 8, 28, 35);
      g.fillStyle = acc;
      g.beginPath();
      g.arc(36, 26, 2.2, 0, Math.PI * 2);
      g.fill();
      break;
    }
    case 'window': {
      g.fillStyle = 'rgba(170,210,235,0.5)';
      g.fillRect(4, 2, 40, 44);
      g.strokeStyle = shade(prim, -40);
      g.lineWidth = 3;
      g.strokeRect(4, 2, 40, 44);
      g.strokeStyle = 'rgba(255,255,255,0.6)';
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(24, 2); g.lineTo(24, 46);
      g.moveTo(4, 24); g.lineTo(44, 24);
      g.stroke();
      break;
    }
    case 'fountain': {
      g.fillStyle = '#7a9ab8';
      g.beginPath();
      g.ellipse(24, 28, 16, 10, 0, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.5)';
      g.lineWidth = 2;
      g.stroke();
      g.strokeStyle = 'rgba(200,230,255,0.7)';
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(24, 28); g.quadraticCurveTo(18, 12, 24, 6);
      g.stroke();
      g.beginPath();
      g.moveTo(24, 28); g.quadraticCurveTo(30, 12, 24, 6);
      g.stroke();
      break;
    }
    case 'pipes': {
      g.fillStyle = shade(prim, -26);
      g.fillRect(0, 18, TS, 10);
      g.fillStyle = 'rgba(255,255,255,0.18)';
      g.fillRect(0, 18, TS, 3);
      g.fillStyle = shade(prim, -42);
      g.fillRect(20, 13, 8, 20);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.fillRect(20, 13, 8, 3);
      break;
    }
    case 'wires': {
      g.strokeStyle = 'rgba(18,18,24,0.85)';
      g.lineWidth = 1.5;
      for (let i = 0; i < 3; i++) {
        const y = 8 + i * 13;
        g.beginPath();
        for (let x = 0; x <= TS; x += 5) {
          const yy = y + Math.sin(x * 0.35 + i * 2.1) * 3 + Math.sin(x * 0.9 + i) * 1.5;
          x === 0 ? g.moveTo(x, yy) : g.lineTo(x, yy);
        }
        g.stroke();
      }
      break;
    }
    case 'puddle': {
      g.fillStyle = 'rgba(90,150,200,0.45)';
      g.beginPath();
      g.ellipse(24, 26, 17, 9, 0.2, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(255,255,255,0.28)';
      g.beginPath();
      g.ellipse(17, 22, 5, 2.5, 0.3, 0, Math.PI * 2);
      g.fill();
      break;
    }
    case 'stairwell': {
      g.strokeStyle = 'rgba(0,0,0,0.5)';
      g.lineWidth = 2;
      for (let i = 0; i < 5; i++) {
        const y = 8 + i * 7;
        g.beginPath(); g.moveTo(8, y); g.lineTo(40 - i * 6, y); g.stroke();
        g.beginPath(); g.moveTo(40 - i * 6, y); g.lineTo(40 - i * 6, y + 7); g.stroke();
      }
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.font = 'bold 11px sans-serif';
      g.fillText('↓', 21, 46);
      break;
    }
    case 'elevator': {
      g.fillStyle = shade(prim, -20);
      g.fillRect(6, 6, 36, 36);
      g.strokeStyle = 'rgba(0,0,0,0.4)';
      g.lineWidth = 2;
      g.strokeRect(6, 6, 36, 36);
      g.fillStyle = 'rgba(255,255,255,0.15)';
      g.fillRect(9, 9, 30, 12);
      g.fillStyle = acc;
      g.fillRect(20, 24, 8, 8);
      g.fillStyle = 'rgba(255,255,255,0.7)';
      g.font = 'bold 10px sans-serif';
      g.fillText('▲', 14, 16);
      g.fillText('▼', 31, 16);
      break;
    }
    default:
      break;
  }
  return c;
}

// ---------- 实体剪影（F 版风格，11 种） ----------
function makeEntityTexture(type) {
  const c = makeCanvas(TS, TS);
  const g = c.getContext('2d');
  switch (type) {
    case 'smiler': {
      g.fillStyle = 'rgba(8,8,10,0.95)';
      g.beginPath(); g.ellipse(24, 24, 17, 15, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#f0f0f0';
      for (let i = 0; i < 8; i++) g.fillRect(12 + i * 3.2, 27, 2.2, 4.5);
      g.fillStyle = '#141414';
      g.fillRect(24, 27, 2.2, 4.5); // 缺一颗牙
      break;
    }
    case 'hound': {
      g.fillStyle = 'rgba(8,8,10,0.95)';
      g.beginPath();
      g.ellipse(16, 30, 9, 6, 0, 0, Math.PI * 2);
      g.ellipse(30, 27, 11, 7, 0, 0, Math.PI * 2);
      g.ellipse(39, 21, 6, 5, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(210,30,30,0.9)';
      g.beginPath(); g.arc(42, 20, 1.6, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(36, 19, 1.6, 0, Math.PI * 2); g.fill();
      break;
    }
    case 'partygoer': {
      g.fillStyle = '#e8c060';
      g.beginPath(); g.arc(24, 24, 16, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#a03020';
      g.beginPath(); g.ellipse(24, 26, 11, 8, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff';
      for (let i = 0; i < 7; i++) g.fillRect(13 + i * 3.2, 23, 2, 4);
      g.fillStyle = '#202030';
      g.beginPath(); g.arc(18, 18, 2.5, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(30, 18, 2.5, 0, Math.PI * 2); g.fill();
      break;
    }
    case 'skin-stealer': {
      g.fillStyle = 'rgba(190,185,175,0.92)';
      g.beginPath(); g.ellipse(24, 14, 8, 10, 0, 0, Math.PI * 2); g.fill();
      g.fillRect(15, 22, 18, 22);
      g.fillStyle = 'rgba(120,115,108,0.9)';
      g.fillRect(13, 24, 6, 16);
      g.fillRect(29, 24, 6, 16);
      break;
    }
    case 'clump': {
      g.fillStyle = 'rgba(12,12,14,0.95)';
      g.beginPath();
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const r = 13 + Math.sin(i * 2.7) * 3;
        const x = 24 + Math.cos(a) * r;
        const y = 26 + Math.sin(a) * r;
        i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.closePath();
      g.fill();
      g.fillStyle = 'rgba(130,60,60,0.55)';
      g.beginPath(); g.arc(20, 22, 2, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(28, 24, 2, 0, Math.PI * 2); g.fill();
      break;
    }
    case 'faceling': {
      g.fillStyle = 'rgba(215,195,170,0.95)';
      g.beginPath(); g.ellipse(24, 16, 8, 9, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(150,130,110,0.95)';
      g.fillRect(16, 24, 16, 20);
      g.fillStyle = '#2a2a30';
      g.fillRect(20, 14, 2.5, 2.5);
      g.fillRect(27, 14, 2.5, 2.5);
      g.fillStyle = 'rgba(160,120,100,0.9)';
      g.fillRect(23, 20, 3, 2.5);
      break;
    }
    case 'watcher': {
      g.fillStyle = 'rgba(18,18,24,0.92)';
      g.beginPath(); g.ellipse(24, 14, 7, 8, 0, 0, Math.PI * 2); g.fill();
      g.fillRect(17, 22, 14, 22);
      g.fillStyle = 'rgba(255,255,255,0.55)';
      g.beginPath(); g.arc(24, 15, 2, 0, Math.PI * 2); g.fill();
      break;
    }
    case 'duller': {
      g.fillStyle = 'rgba(255,240,190,0.95)';
      g.beginPath(); g.arc(24, 16, 9, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,240,190,0.75)';
      g.fillRect(20, 24, 8, 18);
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.beginPath(); g.arc(24, 16, 4, 0, Math.PI * 2); g.fill();
      break;
    }
    case 'moth': {
      g.fillStyle = 'rgba(240,240,240,0.95)';
      g.beginPath(); g.arc(24, 24, 2.5, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(240,240,240,0.5)';
      g.beginPath(); g.ellipse(18, 20, 5, 2, -0.5, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.ellipse(30, 20, 5, 2, 0.5, 0, Math.PI * 2); g.fill();
      break;
    }
    case 'insanity': {
      g.strokeStyle = 'rgba(160,90,200,0.9)';
      g.lineWidth = 2.5;
      g.beginPath();
      for (let i = 0; i < 40; i++) {
        const a = i * 0.5;
        const r = i * 0.55;
        const x = 24 + Math.cos(a) * r;
        const y = 24 + Math.sin(a) * r;
        i === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.stroke();
      break;
    }
    case 'scratcher': {
      g.fillStyle = 'rgba(15,15,18,0.95)';
      g.beginPath(); g.ellipse(24, 26, 13, 11, 0, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.ellipse(36, 18, 5, 6, 0.4, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(220,60,50,0.85)';
      g.lineWidth = 1.5;
      for (let i = 0; i < 3; i++) {
        const sx = 10 + i * 4;
        g.beginPath(); g.moveTo(sx, 12); g.lineTo(sx + 4, 22); g.stroke();
      }
      g.fillStyle = 'rgba(220,60,50,0.9)';
      g.beginPath(); g.arc(38, 16, 1.5, 0, Math.PI * 2); g.fill();
      break;
    }
    default: {
      g.fillStyle = '#888';
      g.fillRect(12, 12, 24, 24);
    }
  }
  return c;
}

// ---------- 离屏预渲染：噪声帧 / 暗角 / 红光 ----------
const noiseFrames = [];
{
  for (let f = 0; f < 3; f++) {
    const c = makeCanvas(256, 256);
    const g = c.getContext('2d');
    const img = g.createImageData(256, 256);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = (Math.random() * 255) | 0;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 26;
    }
    g.putImageData(img, 0, 0);
    noiseFrames.push(c);
  }
}
const vignetteCanvas = (() => {
  const c = makeCanvas(320, 320);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(160, 160, 60, 160, 160, 230);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.55)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 320, 320);
  return c;
})();
const redPulseCanvas = (() => {
  const c = makeCanvas(320, 320);
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(160, 160, 40, 160, 160, 230);
  grad.addColorStop(0, 'rgba(180,20,10,0)');
  grad.addColorStop(1, 'rgba(180,20,10,0.5)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 320, 320);
  return c;
})();

// ---------- 每层视觉缓存（进入层级时重建一次） ----------
let visualCache = null;

function rebuildVisuals() {
  if (!game) return;
  const level = game.level;
  const pal = level.palette || {};
  visualCache = {
    wall: makeWallTexture(level.terrain.wallStyle || 'wallpaper', pal),
    floor: makeFloorTexture(level.terrain.floorStyle || 'carpet', pal),
    waterTex: makeFloorTexture('water', pal),
    props: new Map(),
    entities: new Map(),
    dust: [],
    steam: [],
  };
  // 道具纹理（去重按 kind）
  for (const p of level.props || []) {
    if (!visualCache.props.has(p.kind)) {
      visualCache.props.set(p.kind, makePropTexture(p.kind, pal));
    }
  }
  // 实体剪影
  for (const type of Object.keys(ENTITY_DEFS)) {
    visualCache.entities.set(type, makeEntityTexture(type));
  }
  // 尘埃粒子（20-40）
  const dustCount = 20 + Math.floor(Math.random() * 21);
  for (let i = 0; i < dustCount; i++) {
    visualCache.dust.push({
      x: Math.random(),
      y: Math.random(),
      vx: (Math.random() - 0.5) * 0.0004,
      vy: -0.0001 - Math.random() * 0.0003,
      r: 0.6 + Math.random() * 1.6,
      a: 0.05 + Math.random() * 0.14,
      phase: Math.random() * Math.PI * 2,
    });
  }
  // 蒸汽粒子（工业层/泳池）
  if (level.environment === 'industrial' || level.environment === 'aquatic' || level.environment === 'mixed') {
    const steamCount = 8 + Math.floor(Math.random() * 8);
    for (let i = 0; i < steamCount; i++) {
      visualCache.steam.push({
        x: Math.random(),
        y: 0.85 + Math.random() * 0.15,
        r: 6 + Math.random() * 14,
        a: 0.05 + Math.random() * 0.1,
        vy: -(0.00012 + Math.random() * 0.0002),
        phase: Math.random() * Math.PI * 2,
      });
    }
  }
}

// ---------- 灯光体系 ----------
const flickerState = { base: performance.now(), nextDip: 400, dipUntil: 0, blackoutUntil: 0 };

/** 五档光的全局亮度系数（0-1） */
function getLightFactor(level) {
  const t = now;
  switch (level.light) {
    case 'bright':
      return 1.0;
    case 'dim':
      return 0.68;
    case 'dark':
      return 0.5;
    case 'flickering':
      return flickerValue(level);
    case 'pitch':
      return 0.16;
    default:
      return 0.75;
  }
}

/** flickering：0.3-0.5s 周期随机骤降 + 随机"熄灯"（Level 3 2 秒全黑） */
function flickerValue(level) {
  if (now < flickerState.blackoutUntil) return 0.05;
  if (now < flickerState.dipUntil) return 0.32 + Math.random() * 0.22;
  if (now >= flickerState.nextDip) {
    flickerState.nextDip = now + 300 + Math.random() * 500;
    flickerState.dipUntil = now + 60 + Math.random() * 120;
    const isL3 = /level-3/.test(level.id);
    if (Math.random() < (isL3 ? 0.014 : 0.004)) {
      flickerState.blackoutUntil = now + (isL3 ? 2000 : 500);
    }
  }
  return 0.82 + Math.random() * 0.18;
}

// ---------- 氛围粒子更新 ----------
let lastFrame = performance.now();

function updateParticles() {
  const vc = visualCache;
  if (!vc) return;
  const dt = Math.min(0.05, (performance.now() - lastFrame) / 1000);
  lastFrame = performance.now();
  for (const d of vc.dust) {
    d.x += d.vx * dt * 60;
    d.y += d.vy * dt * 60;
    if (d.y < -0.02) {
      d.y = 1.02;
      d.x = Math.random();
    }
    if (d.x < -0.02) d.x = 1.02;
    if (d.x > 1.02) d.x = -0.02;
  }
  for (const s of vc.steam) {
    s.y += s.vy * dt * 60;
    if (s.y < -0.1) {
      s.y = 0.9 + Math.random() * 0.1;
      s.x = Math.random();
    }
  }
}

// ---------- 主渲染 ----------
const EXIT_EMOJI = {
  door: '🚪',
  stairwell: '🪜',
  elevator: '🛗',
  button: '🔴',
  hole: '🕳️',
  noclip: '✨',
  light: '💡',
  window: '🪟',
};

function drawGame() {
  if (!game || game.over) return;
  const g = game;
  const level = g.level;
  const player = g.player;
  const W = canvas.width;
  const H = canvas.height;
  const radius = viewRadiusOf(level, player);
  const view = radius * 2 + 1;
  const tile = Math.max(6, Math.floor(Math.min(W, H) / view));
  const ox = (W - view * tile) / 2;
  const oy = (H - view * tile) / 2;
  const looping = level.spaceRules.includes('looping');
  const vc = visualCache;

  const visible = new Set(playerVisibleTiles(g).map((t) => t.x + ',' + t.y));
  const explored = g.explored[g.levelId];

  // 道具/实体快速查找
  const propMap = new Map();
  for (const p of level.props || []) propMap.set(p.x + ',' + p.y, p);

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  const px = ox + radius * tile; // 玩家屏幕坐标（左偏移基准）
  const py = oy + radius * tile;

  for (let sy = 0; sy < view; sy++) {
    for (let sx = 0; sx < view; sx++) {
      let gx = player.x - radius + sx;
      let gy = player.y - radius + sy;
      if (looping) {
        gx = ((gx % level.width) + level.width) % level.width;
        gy = ((gy % level.height) + level.height) % level.height;
      }
      if (gx < 0 || gy < 0 || gx >= level.width || gy >= level.height) continue;
      const key = gx + ',' + gy;
      const tx = ox + sx * tile;
      const ty = oy + sy * tile;
      const t = level.tiles[gy][gx];

      if (visible.has(key)) {
        // ---- 视野内：程序化纹理 ----
        let tex = null;
        if (t === '#') tex = vc.wall;
        else if (t === '~') tex = vc.waterTex || vc.floor;
        else tex = vc.floor;
        if (tex) ctx.drawImage(tex, tx, ty, tile, tile);

        // 水面动画高光
        if (t === '~') {
          const wave = 0.5 + 0.5 * Math.sin(now * 0.002 + gx * 1.7 + gy * 0.9);
          ctx.fillStyle = `rgba(220,245,255,${0.06 + wave * 0.12})`;
          ctx.fillRect(tx, ty, tile, tile * 0.35);
        }

        // 道具矢量造型
        const prop = propMap.get(key);
        if (prop && vc.props.has(prop.kind)) {
          ctx.drawImage(vc.props.get(prop.kind), tx, ty, tile, tile);
        }

        // 传送门
        if (t === 'T') {
          const pulse = 0.5 + 0.5 * Math.sin(now * 0.004 + gx + gy);
          ctx.fillStyle = `rgba(150,80,200,${0.25 + pulse * 0.25})`;
          ctx.beginPath();
          ctx.arc(tx + tile / 2, ty + tile / 2, tile * 0.3, 0, Math.PI * 2);
          ctx.fill();
        }

        // 卡出点：墙纸撕裂闪烁（alpha 抖动 + 像素错位）
        for (let i = 0; i < level.exits.length; i++) {
          const ex = level.exits[i];
          if (ex.x !== gx || ex.y !== gy) continue;
          if (ex.hidden && !g.discoveredExits[g.levelId].has(i)) break;
          const tear = 0.5 + 0.5 * Math.sin(now * 0.013 + i * 3.1);
          ctx.fillStyle = `rgba(232,224,138,${0.35 + tear * 0.4})`;
          ctx.fillRect(tx, ty, tile, 2 + tear * 3);
          ctx.fillRect(tx, ty + tile - 3, tile, 2 + tear * 2);
          ctx.globalAlpha = 0.5 + tear * 0.4;
          ctx.drawImage(
            vc.wall,
            tx + Math.sin(now * 0.02 + i) * tile * 0.12,
            ty + Math.cos(now * 0.017 + i * 2) * tile * 0.1,
            tile,
            tile
          );
          ctx.globalAlpha = 1;
          drawEmoji(EXIT_EMOJI[ex.kind] || '✨', tx, ty, tile, 'rgba(255,255,255,0.95)');
          break;
        }
      } else if (explored.has(key)) {
        // ---- 已探索但不在视野：降饱和 40% + 暗化 60% ----
        let tex = null;
        if (t === '#') tex = vc.wall;
        else if (t === '~') tex = vc.waterTex || vc.floor;
        else tex = vc.floor;
        if (tex) ctx.drawImage(tex, tx, ty, tile, tile);
        ctx.fillStyle = 'rgba(128,128,128,0.28)'; // 降饱和
        ctx.fillRect(tx, ty, tile, tile);
        ctx.fillStyle = 'rgba(0,0,0,0.62)'; // 暗化
        ctx.fillRect(tx, ty, tile, tile);
      } else {
        ctx.fillStyle = '#000';
        ctx.fillRect(tx, ty, tile, tile);
      }
    }
  }

  // ---- 物品（emoji） ----
  for (const it of g.items) {
    const dx = it.x - (player.x - radius);
    const dy = it.y - (player.y - radius);
    if (dx < 0 || dy < 0 || dx >= view || dy >= view) continue;
    if (!visible.has(it.x + ',' + it.y)) continue;
    const meta = ITEM_META[it.type] || { emoji: '❓' };
    drawEmoji(meta.emoji, ox + dx * tile, oy + dy * tile, tile, '#fff');
  }

  // ---- 实体（F 版剪影，带轻微浮动） ----
  for (const e of g.entities) {
    if (e.hp <= 0 || !e.visible) continue;
    const dx = e.x - (player.x - radius);
    const dy = e.y - (player.y - radius);
    if (dx < 0 || dy < 0 || dx >= view || dy >= view) continue;
    if (!visible.has(e.x + ',' + e.y)) continue;
    const tex = vc.entities.get(e.type);
    if (!tex) continue;
    const bob = Math.sin(now * 0.003 + hashString(e.type + e.x + ',' + e.y) % 628) * tile * 0.05;
    ctx.drawImage(tex, ox + dx * tile, oy + dy * tile + bob, tile, tile);
  }

  // ---- 玩家 ----
  ctx.fillStyle = '#f2f2f2';
  ctx.beginPath();
  ctx.arc(px + tile / 2, py + tile / 2, tile * 0.36, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#1a1a1a';
  ctx.beginPath();
  ctx.moveTo(px + tile / 2, py + tile * 0.18);
  ctx.lineTo(px + tile * 0.38, py + tile * 0.46);
  ctx.lineTo(px + tile * 0.62, py + tile * 0.46);
  ctx.closePath();
  ctx.fill();

  // ================= 灯光叠加 =================
  const lightFactor = getLightFactor(level);
  if (lightFactor < 1) {
    ctx.fillStyle = `rgba(0,0,0,${1 - lightFactor})`;
    ctx.fillRect(0, 0, W, H);
  }
  // DNA 灯光色 tint
  const lightTint = hexToRgb(level.palette.light || '#ffffff');
  ctx.fillStyle = `rgba(${lightTint.r},${lightTint.g},${lightTint.b},${0.07 * lightFactor})`;
  ctx.fillRect(0, 0, W, H);

  // 手电径向光（暖白，半径 +2 已计入视野）
  if (player.flashlight) {
    ctx.globalCompositeOperation = 'lighter';
    const grad = ctx.createRadialGradient(
      px + tile / 2,
      py + tile / 2,
      tile * 0.4,
      px + tile / 2,
      py + tile / 2,
      tile * (radius + 0.5)
    );
    grad.addColorStop(0, 'rgba(255,240,200,0.5)');
    grad.addColorStop(0.45, 'rgba(255,228,180,0.16)');
    grad.addColorStop(1, 'rgba(255,228,180,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
  } else {
    // 关闭手电：微弱环境光
    const grad = ctx.createRadialGradient(
      px + tile / 2,
      py + tile / 2,
      tile * 0.3,
      px + tile / 2,
      py + tile / 2,
      tile * 3
    );
    grad.addColorStop(0, `rgba(${lightTint.r},${lightTint.g},${lightTint.b},${0.05 * lightFactor})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  // pitch：视野外近黑（视野半径已收窄到 3，此处再加一圈深压）
  if (level.light === 'pitch') {
    const grad = ctx.createRadialGradient(
      px + tile / 2,
      py + tile / 2,
      tile * 1.2,
      px + tile / 2,
      py + tile / 2,
      view * tile * 0.62
    );
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.88)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  // ================= 氛围层 =================
  // 暗角（理智越低越重）
  const vigAlpha = Math.min(1, 0.55 + (100 - player.sanity) * 0.004);
  ctx.globalAlpha = vigAlpha;
  ctx.drawImage(vignetteCanvas, 0, 0, W, H);
  ctx.globalAlpha = 1;

  // 胶片颗粒（3 帧轮播，alpha 随理智降低升高）
  const grainAlpha = 0.04 + (100 - player.sanity) * 0.0008;
  ctx.globalAlpha = grainAlpha;
  ctx.drawImage(noiseFrames[Math.floor(now / 90) % 3], 0, 0, W, H);
  ctx.globalAlpha = 1;

  // 尘埃粒子
  for (const d of vc.dust) {
    const tw = 0.5 + 0.5 * Math.sin(now * 0.001 + d.phase);
    ctx.fillStyle = `rgba(240,235,210,${d.a * tw})`;
    ctx.beginPath();
    ctx.arc(d.x * W, d.y * H, d.r, 0, Math.PI * 2);
    ctx.fill();
  }
  // flickering 层灯下尘埃束
  if (level.light === 'flickering' || level.light === 'bright') {
    for (let i = 0; i < 2; i++) {
      const bx = (0.25 + i * 0.5) * W + Math.sin(now * 0.0004 + i) * 30;
      const grad = ctx.createLinearGradient(bx, 0, bx + 40, H);
      grad.addColorStop(0, 'rgba(232,224,138,0.05)');
      grad.addColorStop(1, 'rgba(232,224,138,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(bx, 0, 40, H);
    }
  }

  // 蒸汽粒子（工业层/泳池）
  for (const s of vc.steam) {
    const pulse = 0.6 + 0.4 * Math.sin(now * 0.0015 + s.phase);
    const grad = ctx.createRadialGradient(s.x * W, s.y * H, 1, s.x * W, s.y * H, s.r);
    grad.addColorStop(0, `rgba(235,235,235,${s.a * pulse})`);
    grad.addColorStop(1, 'rgba(235,235,235,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(s.x * W, s.y * H, s.r, 0, Math.PI * 2);
    ctx.fill();
  }

  // 美学核类画布调色（叠加在 CSS 滤镜之上）
  const tint = AESTHETIC_TINTS[level.aesthetic];
  if (tint) {
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, W, H);
  }

  // 崩溃：屏幕边缘红色脉动
  if (player.sanity <= 15) {
    const pulse = 0.25 + 0.2 * Math.sin(now * 0.004);
    ctx.globalAlpha = pulse;
    ctx.drawImage(redPulseCanvas, 0, 0, W, H);
    ctx.globalAlpha = 1;
  }
}

const AESTHETIC_TINTS = {
  weirdcore: 'rgba(255,190,150,0.03)',
  dreamcore: 'rgba(255,235,245,0.07)',
  poolcore: 'rgba(160,220,255,0.06)',
  traumacore: 'rgba(110,120,170,0.05)',
  mallcore: 'rgba(255,190,120,0.05)',
};

function drawEmoji(emoji, x, y, tile, color) {
  ctx.save();
  ctx.font = `${Math.floor(tile * 0.72)}px "Segoe UI Emoji", "Apple Color Emoji", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (color) {
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;
  }
  ctx.fillText(emoji, x + tile / 2, y + tile / 2 + tile * 0.04);
  ctx.restore();
}

// ---------- 渲染：HUD / 日志 ----------
function renderHud() {
  if (!game) return;
  const g = game;
  const p = g.player;
  const level = g.level;
  setBar('hp', p.hp);
  setBar('san', p.sanity);
  setBar('sta', p.stamina);
  $('hp-num').textContent = `${Math.round(p.hp)}/100`;
  $('san-num').textContent = `${Math.round(p.sanity)}/100`;
  $('sta-num').textContent = `${Math.round(p.stamina)}/100`;
  $('level-name').textContent = level.name;
  $('level-meta').textContent = `难度 Class ${level.difficultyClass} · ${level.environment} · 光照:${level.light} · 空间:${level.spaceRules.join('/')} · 美学:${level.aesthetic || '默认'}`;
  $('turn-info').textContent = `第 ${g.turn} 回合`;
  $('light-info').textContent = `手电:${p.flashlight ? '开' : '关'} 电量 ${Math.floor(p.battery)}% · 潜行:${p.sneak ? '开' : '关'} · 武器:${p.weapon ? '撬棍' : '徒手'}`;

  // 物品栏
  const inv = $('inv');
  inv.innerHTML = '';
  p.inventory.forEach((item, idx) => {
    const meta = ITEM_META[item] || { name: item, emoji: '❓' };
    const el = document.createElement('span');
    el.className = 'inv-item' + (item === 'crowbar' && p.weapon === 'crowbar' ? ' weapon' : '');
    el.title = `${meta.name}：${meta.desc}（按 ${idx + 1} 使用）`;
    el.textContent = `${meta.emoji} ${meta.name}`;
    el.addEventListener('click', () => doAction({ type: 'use', item }));
    inv.appendChild(el);
  });

  // 美学核类滤镜类（#view）与理智滤镜类（#stage）
  const view = $('view');
  view.className = 'a-' + (AESTHETIC_POOL.includes(level.aesthetic) ? level.aesthetic : 'default');
  const stage = $('stage');
  stage.classList.toggle('sanity-fear', p.sanity <= 30 && p.sanity > 15);
  stage.classList.toggle('sanity-collapse', p.sanity <= 15);

  // 出口提示：站在/紧邻已发现出口时提示按 X 卡出
  const disc = g.discoveredExits[g.levelId];
  const nearExit = level.exits.some((ex) => {
    const d = Math.abs(ex.x - p.x) + Math.abs(ex.y - p.y);
    if (d > 1) return false;
    if (ex.hidden && !(disc && disc.has(level.exits.indexOf(ex)))) return false;
    return true;
  });
  const hint = $('exit-hint');
  if (hint) {
    hint.classList.toggle('hidden', !nearExit);
    if (nearExit) hint.textContent = '✨ 附近有卡出点 —— 按 X 卡出';
  }
}

function setBar(id, v) {
  $(id + '-fill').style.width = `${Math.max(0, Math.min(100, v))}%`;
}

function renderEvents(events) {
  if (!events || events.length === 0) return;
  const log = $('event-log');
  for (const e of events) {
    const div = document.createElement('div');
    div.className = `ev k-${e.kind || 'system'}`;
    div.textContent = e.text;
    log.appendChild(div);
    while (log.childNodes.length > 80) log.removeChild(log.firstChild);
    // 幻觉事件：全屏闪现假消息 1.5s
    if (e.hallucination) flashHallucination(e.text);
  }
  log.scrollTop = log.scrollHeight;
}

function renderAll() {
  if (!game) return;
  renderHud();
  drawGame();
}

// ---------- 弹窗内容 ----------
function fillLogModal() {
  if (!game) return;
  $('log-body').innerHTML = game.log
    .map((e) => `<div class="ev k-${e.kind || 'system'}">[${e.turn}] ${escapeHtml(e.text)}</div>`)
    .join('');
}

function drawMapModal() {
  if (!game) return;
  const g = game;
  const level = g.level;
  const explored = g.explored[g.levelId];
  const W = mapCanvas.width;
  const H = mapCanvas.height;
  const tw = W / level.width;
  const th = H / level.height;
  mapCtx.fillStyle = '#050403';
  mapCtx.fillRect(0, 0, W, H);
  for (let y = 0; y < level.height; y++) {
    for (let x = 0; x < level.width; x++) {
      const key = x + ',' + y;
      if (!explored.has(key) && !(g.player.x === x && g.player.y === y)) continue;
      const t = level.tiles[y][x];
      let color = '#1d1a12';
      if (t === '#') color = '#3a3424';
      else if (t === '~') color = '#16324a';
      else if (t === 'T') color = '#4a2a5a';
      else if (t === 'D' || t === 'S') color = '#5a5038';
      mapCtx.fillStyle = color;
      mapCtx.fillRect(x * tw, y * th, tw + 1, th + 1);
    }
  }
  // 出口
  for (let i = 0; i < level.exits.length; i++) {
    const ex = level.exits[i];
    if (ex.hidden && !g.discoveredExits[g.levelId].has(i)) continue;
    mapCtx.fillStyle = ex.hidden ? '#e8e08a' : '#8ad8a0';
    mapCtx.fillRect(ex.x * tw + tw * 0.25, ex.y * th + th * 0.25, tw * 0.5 + 1, th * 0.5 + 1);
  }
  // 玩家
  mapCtx.fillStyle = '#f2f2f2';
  mapCtx.beginPath();
  mapCtx.arc(g.player.x * tw + tw / 2, g.player.y * th + th / 2, Math.max(2, tw * 0.4), 0, Math.PI * 2);
  mapCtx.fill();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------- 输入处理 ----------
const KEY_DIRS = {
  w: { dx: 0, dy: -1 },
  a: { dx: -1, dy: 0 },
  s: { dx: 0, dy: 1 },
  d: { dx: 1, dy: 0 },
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
};

function handleKey(e) {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

  // 弹窗关闭（死亡结算只能通过按钮重新开始）
  if (key === 'Escape') {
    for (const id of ['log-modal', 'map-modal', 'help-modal']) {
      if (!$(id).classList.contains('hidden')) {
        hideOverlay(id);
        return;
      }
    }
    return;
  }

  // 开始界面未消失时：Enter 继续 / 或由按钮操作
  if (!$('start-screen').classList.contains('hidden')) {
    if (key === 'Enter') {
      e.preventDefault();
      continueGame();
    }
    return;
  }

  if (!game || game.over) return;

  // 弹窗打开时仅响应关闭键
  const anyModalOpen = ['log-modal', 'map-modal', 'help-modal'].some(
    (id) => !$(id).classList.contains('hidden')
  );
  if (anyModalOpen) {
    if (key === 'j') hideOverlay('log-modal');
    else if (key === 'm') hideOverlay('map-modal');
    else if (key === 'h') hideOverlay('help-modal');
    return;
  }

  if (KEY_DIRS[key]) {
    e.preventDefault();
    const d = KEY_DIRS[key];
    if (shiftHeld) doAction({ type: 'run', dx: d.dx, dy: d.dy });
    else doAction({ type: 'move', dx: d.dx, dy: d.dy });
    return;
  }

  switch (key) {
    case 'e':
      doAction({ type: 'interact' });
      break;
    case 'x':
      doAction({ type: 'exit' });
      break;
    case 'f':
      doAction({ type: 'light' });
      break;
    case ' ':
      e.preventDefault();
      doAction({ type: 'rest' });
      break;
    case 'j':
      fillLogModal();
      showOverlay('log-modal');
      break;
    case 'm':
      drawMapModal();
      showOverlay('map-modal');
      break;
    case 'h':
      showOverlay('help-modal');
      break;
    case '1':
    case '2':
    case '3':
    case '4':
    case '5':
    case '6':
    case '7':
    case '8':
    case '9': {
      const idx = Number(key) - 1;
      const item = game.player.inventory[idx];
      if (item) doAction({ type: 'use', item });
      break;
    }
    default:
      break;
  }
}

/** 统一的动作入口：E 交互 = 站在物品上则拾取，否则搜索 */
function doAction(action) {
  if (!game || game.over) return;
  if (action.type === 'interact') {
    const onItem = game.items.some((it) => it.x === game.player.x && it.y === game.player.y);
    action = onItem ? { type: 'take' } : { type: 'search' };
  }

  const prevLevelId = game.levelId;
  const res = step(game, action);
  const events = res.events;

  renderEvents(events);

  // 层级切换 → 故障过渡遮罩
  if (game.levelId !== prevLevelId) {
    const dna = game.levels[game.levelId];
    rebuildVisuals();
    showTransition(`你穿过了故障的墙壁……\n${dna ? `${dna.name}（难度 Class ${dna.difficultyClass}）` : game.levelId}\n${dna ? dna.description : ''}`, 3200);
  }

  renderHud();
  drawGame();
  saveGame();

  if (game.over) showDeath();
}

// ---------- 动画循环（60fps：粒子 + 灯光明暗 + 理智闪烁） ----------
function animate() {
  now = performance.now();
  updateParticles();
  if (game && !game.over) drawGame();
  fakeFlashLoop();
  requestAnimationFrame(animate);
}

/** 崩溃阶段：假实体在画面上方 DOM 层闪现 80ms */
function fakeFlashLoop() {
  const layer = $('fake-flash-layer');
  if (!game || game.player.sanity > 15 || game.over) {
    layer.innerHTML = '';
    return;
  }
  if (Math.random() < 0.05) {
    const div = document.createElement('div');
    div.style.cssText = `position:absolute;left:${Math.random() * 85}%;top:${Math.random() * 85}%;font-size:${18 + Math.random() * 30}px;opacity:0.5;filter:grayscale(1) brightness(0.4);pointer-events:none;`;
    div.textContent = '😬';
    layer.appendChild(div);
    setTimeout(() => div.remove(), 80);
  }
}

// ---------- 开始界面 & 按钮 ----------
/** 点击诊断条：任何开始按钮被点击都会在这里留痕（排查"按钮无效"用） */
function logClick(id, extra) {
  const dbg = $('click-debug');
  if (!dbg) return;
  dbg.classList.remove('hidden');
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  dbg.textContent = `[${t}] 点击: ${id}${extra ? ' → ' + extra : ''}`;
}

function wireButtons() {
  $('btn-new').addEventListener('click', () => {
    logClick('btn-new', '开始新游戏');
    safeRun(newGame);
  });
  $('btn-continue').addEventListener('click', () => {
    logClick('btn-continue', '继续/新开局');
    safeRun(continueGame);
  });
  $('btn-wild').addEventListener('click', () => {
    logClick('btn-wild', '野性层级');
    safeRun(enterWild);
  });
  $('btn-death-new').addEventListener('click', () => {
    hideOverlay('death-modal');
    logClick('btn-death-new', '再次跌落');
    safeRun(newGame);
  });
  document.querySelectorAll('.modal-close').forEach((btn) => {
    btn.addEventListener('click', () => hideOverlay(btn.dataset.close));
  });

  // 触屏控制：十字方向键（按下即走 + 长按连续移动）+ 动作键（点击）
  document.querySelectorAll('#touch-pad .pad-btn').forEach((btn) => {
    // 长按不弹系统菜单
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    if (btn.dataset.dir) {
      const DIRS = { up: { dx: 0, dy: -1 }, down: { dx: 0, dy: 1 }, left: { dx: -1, dy: 0 }, right: { dx: 1, dy: 0 } };
      const d = DIRS[btn.dataset.dir];
      let holdTimer = null;
      const move = () => safeRun(() => doAction({ type: 'move', dx: d.dx, dy: d.dy }));
      const stopHold = () => {
        if (holdTimer) {
          clearInterval(holdTimer);
          holdTimer = null;
        }
      };
      // 事件兼容：新浏览器用 PointerEvent；旧浏览器回退 touchstart/mousedown
      const hasPointer = typeof window.PointerEvent !== 'undefined';
      const hasTouch = 'ontouchstart' in window;
      const downEv = hasPointer ? 'pointerdown' : hasTouch ? 'touchstart' : 'mousedown';
      const upEvs = hasPointer
        ? ['pointerup', 'pointerleave', 'pointercancel']
        : hasTouch
          ? ['touchend', 'touchcancel']
          : ['mouseup', 'mouseleave'];
      btn.addEventListener(downEv, (e) => {
        if (e.preventDefault) e.preventDefault();
        move();
        holdTimer = setInterval(move, 170);
      });
      for (const ev of upEvs) btn.addEventListener(ev, stopHold);
    } else if (btn.dataset.act) {
      const acts = { rest: { type: 'rest' }, search: { type: 'interact' }, light: { type: 'light' }, log: { type: 'log' }, exit: { type: 'exit' } };
      const a = acts[btn.dataset.act];
      btn.addEventListener('click', () => {
        if (a.type === 'log') {
          fillLogModal();
          showOverlay('log-modal');
        } else {
          safeRun(() => doAction(a));
        }
      });
    }
  });

  // 开始界面 Codex 摘要
  const discovered = Object.keys(codex.levels || {}).length;
  const deaths = (codex.deaths || []).length;
  $('start-codex').textContent = discovered
    ? `Codex：已发现 ${discovered} 个层级 · 死亡 ${deaths} 次 · 笔记 ${(codex.notes || []).length} 条`
    : '';
}

// ---------- 启动 ----------
window.addEventListener('keydown', (e) => {
  if (e.key === 'Shift') shiftHeld = true;
  handleKey(e);
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'Shift') shiftHeld = false;
});

wireButtons();
animate();