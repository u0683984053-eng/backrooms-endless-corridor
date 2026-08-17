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
  ACHIEVEMENTS,
} from '../engine/game.js';
import { ITEM_META, viewRadiusOf, TALENTS } from '../engine/player.js';
import { ENTITY_DEFS } from '../engine/entities.js';
import { tileAt, nearestExitInfo, COMPASS_ARROWS, angleToArrow } from '../engine/generator.js';
import { hashString } from '../engine/rng.js';
// 程序化音频（AUDIO-SPEC v1.0）：零依赖 Web Audio，所有调用都 try/catch 包裹
import {
  initAudio,
  setLevelSound,
  onPlayerMove,
  onDoor,
  onExit,
  onHit,
  onShot,
  onDrone,
  onScene,
  onSanityStage,
  onHeartbeat,
  setMuted,
  setVolume,
  isAudioReady,
  startle,
} from './audio.js';

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
  // 上限 200 条：超出后丢弃最旧的野性层级记录（localStorage 体积保护）
  const keys = Object.keys(wildRegistry);
  if (keys.length > 200) {
    for (const k of keys.slice(0, keys.length - 200)) delete wildRegistry[k];
  }
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
  // 出生层级（F 版设定：绝大多数人第一次卡出落在 Level 0，少数人直接出现在其它层级；
  // 排除进入即死的群星——你不会一出生就变成灰烬）
  let startLevel = 'level-0';
  if (Math.random() < 0.1) {
    const others = Object.keys(levels).filter(
      (id) => id !== 'level-0' && !(levels[id].specialMechanisms || []).includes('solar-burn')
    );
    startLevel = others.length ? others[Math.floor(Math.random() * others.length)] : 'level-0';
  }
  game = createGame({ levels, seed, startLevel });
  mergeCodexIntoGame();
  lastLevelId = game.levelId;
  hideOverlay('start-screen');
  document.body.classList.add('in-game');
  rebuildVisuals();
  renderAll();
  saveGame();
  // 与野性入口一致的可见反馈：跌入层级过渡遮罩（含层级名与描述、天赋提示）
  const dna = game.levels[game.levelId];
  const t = game.player.talent && TALENTS[game.player.talent];
  const talentLine = t ? `\n天赋：${t.name}——${t.desc}` : '';
  showTransition(`你跌入了 ${dna.name}（难度 Class ${dna.difficultyClass}）\n${dna.description}${talentLine}`, 3800);
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

/** 进入野性层级：随机基底层级做 DNA 变异（seed 随机），注册后可跨会话重建 */
function enterWild() {
  if (!game) newGame();
  if (game.over) newGame(); // 死亡后需先开新局
  const wildSeed = Math.floor(Math.random() * 1e6);
  // 基底随机：23 个层级任选其一（野性 = 任何层级都有"另一个版本"）
  const baseIds = Object.keys(levels);
  const baseId = baseIds[Math.floor(Math.random() * baseIds.length)];
  const base = levels[baseId];
  const dna = mutateDna(base, wildSeed);
  // 野性变异让群星熄灭：以 Level 599 为基底的野性层不再进入即死（否则毫无意义）
  if ((dna.specialMechanisms || []).includes('solar-burn')) {
    dna.specialMechanisms = dna.specialMechanisms.filter((m) => m !== 'solar-burn');
    dna.name = (dna.name || '野性层级').replace('群星', '熄灭的群星');
  }
  levels[dna.id] = dna;
  wildRegistry[dna.id] = { baseId, seed: wildSeed };
  saveWildRegistry();
  const prev = game.levelId;
  enterLevel(game, dna.id, { keepPlayer: true });
  rebuildVisuals();
  document.body.classList.add('in-game');
  let wildTalent = '';
  // 野性变异：30% 概率天赋被野性层级扭曲成另一个随机天赋（F 版"野性会改变你"）
  if (Math.random() < 0.3) {
    const ids = Object.keys(TALENTS);
    const newT = ids[Math.floor(Math.random() * ids.length)];
    game.player.talent = newT;
    const t = TALENTS[newT];
    wildTalent = `\n野性变异：你的天赋扭曲成了【${t.name}】——${t.desc}`;
    renderEvents([{ text: `野性变异：你的天赋扭曲成了 ${t.name}。`, kind: 'sanity' }]);
  }
  showTransition(`你挤进一道墙缝……\n${dna.name}\n${dna.description}${wildTalent}`, 3800);
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
  const EPILOGUES = [
    '后室不会记得你。但 Codex 会。',
    '每一层都在等你。它们有的是时间。',
    '你的脚步声还留在走廊里。',
    '这里没有墓碑，只有下一次醒来。',
    '理智是一种消耗品。你刚才用完了。',
    '有人会找到你的笔记。希望那对他有用。',
    '走廊会记住你路过的样子。',
    '这不是结束——后室没有结束。',
  ];
  const epilogue = EPILOGUES[Math.floor(Math.random() * EPILOGUES.length)];
  const st = g.stats || {};
  $('death-body').innerHTML = `
    <div class="death-stats">
      <div class="ds">死因：<b>${g.deathCause || '未知'}</b></div>
      <div class="ds">存活回合：<b>${g.turn}</b> · 移动 ${st.movesTotal || 0} 格 · 击杀 ${st.kills || 0}</div>
      <div class="ds">触发的场景：<b>${st.scenesSeen || 0}</b> · 无人机 ${st.dronesUsed || 0} · 手枪击杀 ${st.pistolKills || 0}</div>
      <div class="ds">发现层级：<b>${discovered.length}</b>（${discovered.map((id) => g.codex.levels[id].name).join('、') || '仅 Level 0'}）</div>
      <div class="ds">日志笔记：<b>${notes}</b> 条 · 死亡记录：<b>${deaths}</b> 次</div>
      <div class="ds">最终位置：<b>${g.codex.levels[g.levelId] ? g.codex.levels[g.levelId].name : g.levelId}</b></div>
    </div>
    <p class="death-epilogue">${epilogue}</p>
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
      // 半开的门洞：门框 + 向内开的门扇 + 门洞阴影（明确"可通行"的暗示）
      g.fillStyle = 'rgba(0,0,0,0.55)'; // 门洞内的阴影
      g.fillRect(4, 2, 40, 44);
      g.strokeStyle = shade(prim, -36);
      g.lineWidth = 3;
      g.strokeRect(4, 2, 40, 44); // 门框
      g.fillStyle = shade(prim, -8);
      g.save();
      g.translate(36, 24);
      g.rotate(-0.55); // 半开的门扇（向内打开）
      g.fillRect(-14, -17, 28, 34);
      g.restore();
      g.strokeStyle = 'rgba(0,0,0,0.35)';
      g.lineWidth = 1.5;
      g.strokeRect(9, 8, 26, 32);
      g.fillStyle = acc;
      g.beginPath();
      g.arc(13, 24, 2, 0, Math.PI * 2); // 门把手（在开着的门扇上）
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
    case 'crates': {
      // 板条箱：木框 + 斜撑
      g.fillStyle = shade(prim, -20);
      g.fillRect(6, 10, 36, 32);
      g.strokeStyle = shade(prim, -45);
      g.lineWidth = 2;
      g.strokeRect(6, 10, 36, 32);
      g.beginPath();
      g.moveTo(6, 10);
      g.lineTo(42, 42);
      g.moveTo(42, 10);
      g.lineTo(6, 42);
      g.stroke();
      g.strokeRect(12, 22, 24, 8);
      break;
    }
    case 'papers': {
      // 文件堆：层叠纸张
      for (let i = 0; i < 4; i++) {
        g.fillStyle = i % 2 ? '#d8d0b8' : '#c8c0a8';
        g.save();
        g.translate(24, 30 - i * 3);
        g.rotate((i - 1.5) * 0.12);
        g.fillRect(-14, -10, 28, 20);
        g.restore();
      }
      g.strokeStyle = 'rgba(0,0,0,0.25)';
      g.lineWidth = 1;
      g.beginPath();
      for (let i = 0; i < 3; i++) {
        const y = 26 - i * 3;
        g.moveTo(14, y);
        g.lineTo(34, y);
      }
      g.stroke();
      break;
    }
    case 'plants': {
      // 盆栽：陶盆 + 绿叶
      g.fillStyle = '#8a5a3a';
      g.beginPath();
      g.moveTo(10, 38);
      g.lineTo(14, 22);
      g.lineTo(34, 22);
      g.lineTo(38, 38);
      g.closePath();
      g.fill();
      g.fillStyle = '#3a7a3a';
      g.beginPath();
      g.ellipse(24, 16, 10, 7, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#4a9a4a';
      g.beginPath();
      g.ellipse(20, 12, 5, 8, -0.4, 0, Math.PI * 2);
      g.fill();
      g.beginPath();
      g.ellipse(29, 14, 4, 7, 0.4, 0, Math.PI * 2);
      g.fill();
      break;
    }
    case 'posters': {
      // 海报：贴墙的纸（半透明、微皱）
      g.save();
      g.globalAlpha = 0.85;
      g.fillStyle = '#e8e0c0';
      g.fillRect(8, 6, 32, 36);
      g.strokeStyle = 'rgba(0,0,0,0.4)';
      g.lineWidth = 1;
      g.strokeRect(8, 6, 32, 36);
      // 海报上的模糊图形（看不太清的"内容"）
      g.fillStyle = 'rgba(120,40,40,0.5)';
      g.fillRect(14, 12, 20, 12);
      g.fillStyle = 'rgba(40,60,120,0.45)';
      g.fillRect(14, 28, 20, 8);
      g.restore();
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
    case 'deathmoth': {
      // 死亡飞蛾：大翅膀 + 暗色身体 + 红色复眼
      g.fillStyle = 'rgba(30,25,35,0.95)';
      g.beginPath(); g.ellipse(24, 24, 8, 12, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(45,35,55,0.9)';
      g.beginPath(); g.ellipse(13, 18, 11, 6, -0.5, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.ellipse(35, 18, 11, 6, 0.5, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(60,45,75,0.8)';
      g.beginPath(); g.ellipse(11, 30, 9, 4, -0.4, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.ellipse(37, 30, 9, 4, 0.4, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(220,40,40,0.95)';
      g.beginPath(); g.arc(21, 22, 2, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(27, 22, 2, 0, Math.PI * 2); g.fill();
      break;
    }
    case 'glowfolk': {
      // 发光者：柔和的人形光晕
      const glow = g.createRadialGradient(24, 26, 2, 24, 26, 22);
      glow.addColorStop(0, 'rgba(200,235,255,0.5)');
      glow.addColorStop(1, 'rgba(200,235,255,0)');
      g.fillStyle = glow;
      g.beginPath(); g.arc(24, 26, 22, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(230,246,255,0.95)';
      g.beginPath(); g.ellipse(24, 14, 6, 8, 0, 0, Math.PI * 2); g.fill();
      g.fillRect(18, 22, 12, 20);
      g.fillStyle = 'rgba(255,255,255,0.7)';
      g.beginPath(); g.arc(24, 15, 2, 0, Math.PI * 2); g.fill();
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
  // 音频：进入/切换层级 → 切换音景（交叉淡化 2s）+ 重置随机突发音效定时器
  audioSetLevelSafe();
  const level = game.level;
  const pal = level.palette || {};
  visualCache = {
    wall: makeWallTexture(level.terrain.wallStyle || 'wallpaper', pal),
    wallVariants: Array.from({ length: 4 }, () =>
      makeWallTexture(level.terrain.wallStyle || 'wallpaper', pal)
    ),
    floor: makeFloorTexture(level.terrain.floorStyle || 'carpet', pal),
    floorVariants: Array.from({ length: 3 }, () =>
      makeFloorTexture(level.terrain.floorStyle || 'carpet', pal)
    ),
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
// 视野 BFS 缓存：玩家位置未变时复用（渲染每帧调用，BFS 只在移动后重算）
let visibleCache = { key: '', set: new Set() };

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
  // 矩形视口：瓦片目标 48px、下限 24px（小屏保清晰度）；高度受限时裁剪视野行，
  // 横向可显示远超最小视野的列数（横屏无限世界探索视野更大），画面铺满画布且不变形
  const minView = radius * 2 + 1;
  const target = 48;
  const minTile = 24;
  let vr = Math.max(minView, Math.floor(H / target));
  let tile = H / vr;
  if (tile < minTile) {
    vr = Math.max(7, Math.floor(H / minTile));
    tile = H / vr;
  }
  const viewCols = Math.max(minView, Math.floor(W / tile));
  const viewRows = vr;
  tile = Math.min(W / viewCols, H / viewRows);
  const ox = (W - viewCols * tile) / 2;
  const oy = (H - viewRows * tile) / 2;
  document.body.dataset.view = viewCols + 'x' + viewRows + ' t=' + tile.toFixed(1) + ' ox=' + ox.toFixed(0) + ' oy=' + oy.toFixed(0);
  const halfCols = Math.floor(viewCols / 2);
  const halfRows = Math.floor(viewRows / 2);
  const looping = level.spaceRules.includes('looping') && !level.infinite;
  const vc = visualCache;

  // 视野 BFS 缓存：玩家位置未变时复用（渲染每帧调用，BFS 只在移动后重算）
  const vkey = g.levelId + '|' + player.x + ',' + player.y;
  if (visibleCache.key !== vkey) {
    visibleCache = { key: vkey, set: new Set(playerVisibleTiles(g).map((t) => t.x + ',' + t.y)) };
  }
  const visible = visibleCache.set;
  const explored = g.explored[g.levelId];

  // 道具/实体快速查找
  const propMap = new Map();
  for (const p of level.props || []) propMap.set(p.x + ',' + p.y, p);

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  const px = ox + halfCols * tile; // 玩家屏幕坐标（居中）
  const py = oy + halfRows * tile;

  for (let sy = 0; sy < viewRows; sy++) {
    for (let sx = 0; sx < viewCols; sx++) {
      let gx = player.x - halfCols + sx;
      let gy = player.y - halfRows + sy;
      if (looping) {
        gx = ((gx % level.width) + level.width) % level.width;
        gy = ((gy % level.height) + level.height) % level.height;
      }
      if (!level.infinite && (gx < 0 || gy < 0 || gx >= level.width || gy >= level.height)) continue;
      const key = gx + ',' + gy;
      const tx = ox + sx * tile;
      const ty = oy + sy * tile;
      const t = level.infinite ? tileAt(level, gx, gy) : level.tiles[gy][gx];

      if (visible.has(key)) {
        // ---- 视野内：程序化纹理（多版本轮换，打破平铺重复感） ----
        let tex = null;
        const variant = (gx * 7 + gy * 13) % 4;
        if (t === '#') tex = (vc.wallVariants && vc.wallVariants[variant % vc.wallVariants.length]) || vc.wall;
        else if (t === '~') tex = vc.waterTex || vc.floor;
        else tex = (vc.floorVariants && vc.floorVariants[variant % vc.floorVariants.length]) || vc.floor;
        if (tex) ctx.drawImage(tex, tx, ty, tile, tile);

        // 墙壁投影：相邻墙的地板格压暗边缘（纵深与阈限空间感）
        if (t !== '#') {
          const adj = [
            [0, -1, 'top'],
            [0, 1, 'bottom'],
            [-1, 0, 'left'],
            [1, 0, 'right'],
          ];
          for (const [adx, ady, side] of adj) {
            let wx = gx + adx;
            let wy = gy + ady;
            if (level.spaceRules.includes('looping') && !level.infinite) {
              wx = ((wx % level.width) + level.width) % level.width;
              wy = ((wy % level.height) + level.height) % level.height;
            }
            if (!level.infinite && (wx < 0 || wy < 0 || wx >= level.width || wy >= level.height)) continue;
            if (tileAt(level, wx, wy) === '#') {
              ctx.fillStyle = 'rgba(0,0,0,0.28)';
              if (side === 'top') ctx.fillRect(tx, ty, tile, tile * 0.16);
              else if (side === 'bottom') ctx.fillRect(tx, ty + tile * 0.84, tile, tile * 0.16);
              else if (side === 'left') ctx.fillRect(tx, ty, tile * 0.16, tile);
              else ctx.fillRect(tx + tile * 0.84, ty, tile * 0.16, tile);
            }
          }
        }

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

        // 楼梯/电梯（'S' 可走标记）：斜向阶梯线（Level 15 无尽楼梯间氛围）
        if (t === 'S') {
          ctx.strokeStyle = 'rgba(210,210,200,0.45)';
          ctx.lineWidth = Math.max(2, tile * 0.07);
          ctx.beginPath();
          ctx.moveTo(tx + tile * 0.15, ty + tile * 0.85);
          ctx.lineTo(tx + tile * 0.85, ty + tile * 0.15);
          ctx.stroke();
          for (let i = 1; i <= 3; i++) {
            const bx = tx + tile * 0.15 + tile * 0.2 * i;
            const by = ty + tile * 0.85 - tile * 0.2 * i;
            ctx.beginPath();
            ctx.moveTo(bx, by);
            ctx.lineTo(bx + tile * 0.12, by);
            ctx.stroke();
          }
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
        // ---- 已探索但不在视野：降饱和+暗化（一次合并覆盖，减少 fillRect） ----
        let tex = null;
        if (t === '#') tex = vc.wall;
        else if (t === '~') tex = vc.waterTex || vc.floor;
        else tex = vc.floor;
        if (tex) ctx.drawImage(tex, tx, ty, tile, tile);
        ctx.fillStyle = 'rgba(36,33,26,0.85)';
        ctx.fillRect(tx, ty, tile, tile);
      } else {
        // ---- 未探索：黑色底已整屏铺过，跳过（省去逐格 fillRect） ----
      }
    }
  }

  // ---- 场景锚点（未触发的 setPieces：微光 ✦，走近触发后消失；致命场景为暗红微光） ----
  const seenSp = g.seenSetPieces[g.levelId] || new Set();
  for (let i = 0; i < level.setPieces.length; i++) {
    const sp = level.setPieces[i];
    if (seenSp.has(i)) continue;
    const dx = sp.x - (player.x - halfCols);
    const dy = sp.y - (player.y - halfRows);
    if (dx < 0 || dy < 0 || dx >= viewCols || dy >= viewRows) continue;
    if (!visible.has(sp.x + ',' + sp.y)) continue;
    const tx = ox + dx * tile;
    const ty = oy + dy * tile;
    const pulse = 0.5 + 0.5 * Math.sin(now * 0.002 + i * 2.7);
    const fatal = (sp.sanityEffect || 0) <= -50;
    ctx.fillStyle = fatal ? `rgba(140,30,20,${0.08 + pulse * 0.14})` : `rgba(180,140,90,${0.06 + pulse * 0.1})`;
    ctx.fillRect(tx + tile * 0.12, ty + tile * 0.12, tile * 0.76, tile * 0.76);
    ctx.fillStyle = fatal ? `rgba(235,90,70,${0.4 + pulse * 0.4})` : `rgba(232,224,138,${0.3 + pulse * 0.35})`;
    ctx.font = `${Math.floor(tile * 0.55)}px "Segoe UI Emoji", "Noto Sans SC", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(fatal ? '✦' : '✦', tx + tile / 2, ty + tile / 2 + tile * 0.04);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  // ---- 物品（emoji） ----
  for (const it of g.items) {
    const dx = it.x - (player.x - halfCols);
    const dy = it.y - (player.y - halfRows);
    if (dx < 0 || dy < 0 || dx >= viewCols || dy >= viewRows) continue;
    if (!visible.has(it.x + ',' + it.y)) continue;
    const meta = ITEM_META[it.type] || { emoji: '❓' };
    drawEmoji(meta.emoji, ox + dx * tile, oy + dy * tile, tile, '#fff');
  }

  // ---- 实体（F 版剪影，带轻微浮动） ----
  for (const e of g.entities) {
    if (e.hp <= 0 || !e.visible) continue;
    const dx = e.x - (player.x - halfCols);
    const dy = e.y - (player.y - halfRows);
    if (dx < 0 || dy < 0 || dx >= viewCols || dy >= viewRows) continue;
    if (!visible.has(e.x + ',' + e.y)) continue;
    const tex = vc.entities.get(e.type);
    if (!tex) continue;
    const bob = Math.sin(now * 0.003 + (hashString(e.type + e.x + ',' + e.y) % 628)) * tile * 0.05;
    // 呼吸缩放：阈限空间的"活物感"；警觉时起伏更急促
    const amp = e.alert ? 0.05 : 0.02;
    const breath = 1 + Math.sin(now * 0.004 + e.x * 3 + e.y * 5) * amp;
    const cx = ox + dx * tile + tile / 2;
    const cy = oy + dy * tile + tile / 2 + bob;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(breath, breath);
    ctx.drawImage(tex, -tile / 2, -tile / 2, tile, tile);
    ctx.restore();
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
      radius * tile * 0.9
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
  setBar('hp', p.hp, p.hpMax || 100);
  setBar('san', p.sanity, p.sanityMax || 100);
  setBar('sta', p.stamina, p.staminaMax || 100);
  $('hp-num').textContent = `${Math.round(p.hp)}/${p.hpMax || 100}`;
  $('san-num').textContent = `${Math.round(p.sanity)}/${p.sanityMax || 100}`;
  $('sta-num').textContent = `${Math.round(p.stamina)}/${p.staminaMax || 100}`;
  $('level-name').textContent = level.name;
  const talentText = p.talent && TALENTS[p.talent] ? ` · 天赋:${TALENTS[p.talent].name}` : '';
  $('level-meta').textContent = `难度 Class ${level.difficultyClass} · ${level.environment} · 光照:${level.light} · 空间:${level.spaceRules.join('/')} · 美学:${level.aesthetic || '默认'}${talentText}`;
  $('turn-info').textContent = `第 ${g.turn} 回合`;
  $('light-info').textContent = `手电:${p.flashlight ? '开' : '关'} 电量 ${Math.floor(p.battery)}% · 潜行:${p.sneak ? '开' : '关'} · 武器:${p.weapon ? (ITEM_META[p.weapon] ? ITEM_META[p.weapon].name : p.weapon) : '徒手'}`;

  // 背包：仅更新按钮角标与弹窗内容（不常驻 HUD，避免挤压画面）
  updateInvUI();

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

  // 无限层出口罗盘：指向最近的出口（隐藏出口未发现时显示模糊方向，解决无限世界迷路）
  const compass = $('exit-compass');
  if (compass) {
    const info = nearestExitInfo(level, p.x, p.y);
    if (info) {
      const arrow = COMPASS_ARROWS[angleToArrow(info.angle)];
      const known =
        g.player.talent === 'guide' ||
        !info.hidden ||
        (disc && disc.has(level.exits.findIndex((e) => e.x === info.x && e.y === info.y)));
      compass.textContent = known ? `${arrow} 出口 ${Math.round(info.d)}m` : `${arrow} 出口 ?`;
      compass.classList.remove('hidden');
    } else {
      compass.classList.add('hidden');
    }
  }
}

function setBar(id, v, max = 100) {
  $(id + '-fill').style.width = `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
}

/** 背包：角标数量 + 弹窗物品网格（B 键/🎒按钮打开） */
function updateInvUI() {
  if (!game) return;
  const p = game.player;
  const count = $('inv-count');
  if (count) count.textContent = p.inventory.length > 0 ? String(p.inventory.length) : '';
  if (!$('inv-modal').classList.contains('hidden')) fillInvModal();
}

function fillInvModal() {
  if (!game) return;
  const p = game.player;
  const grid = $('inv-grid');
  grid.innerHTML = '';
  if (p.inventory.length === 0) {
    grid.innerHTML = '<div class="inv-empty">背包是空的……去层级里找找杏仁水吧。</div>';
    return;
  }
  p.inventory.forEach((item, idx) => {
    const meta = ITEM_META[item] || { name: item, emoji: '❓' };
    const el = document.createElement('button');
    el.className = 'inv-cell' + (item === 'crowbar' && p.weapon === 'crowbar' ? ' weapon' : '');
    el.title = `${meta.name}：${meta.desc}（点击使用 / 按 ${idx + 1}）`;
    el.innerHTML = `<span class="inv-cell-emoji">${meta.emoji}</span><span class="inv-cell-name">${meta.name}</span><span class="inv-cell-key">${idx + 1}</span>`;
    el.addEventListener('click', () => {
      doAction({ type: 'use', item });
      fillInvModal();
      renderHud();
    });
    grid.appendChild(el);
  });
}

/** 关闭所有打开的弹窗（触屏按键操作前调用，解决"弹窗遮罩挡住按钮"） */
function closeOpenModals() {
  for (const id of ['log-modal', 'map-modal', 'help-modal', 'inv-modal']) {
    hideOverlay(id);
  }
}

function toggleInvModal() {
  if ($('inv-modal').classList.contains('hidden')) {
    fillInvModal();
    showOverlay('inv-modal');
  } else {
    hideOverlay('inv-modal');
  }
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
    // 成就解锁：全屏成就横幅 4s
    if (e.kind === 'achievement') showAchievementToast(e.text);
  }
  log.scrollTop = log.scrollHeight;
}

/** 成就解锁横幅（Fandom 风：后室也会为你喝彩，这本身就很奇怪） */
let achieveTimer = null;
function showAchievementToast(text) {
  const el = $('achieve-toast');
  if (!el) return;
  clearTimeout(achieveTimer);
  el.textContent = text;
  el.classList.remove('hidden');
  el.classList.add('pop');
  achieveTimer = setTimeout(() => {
    el.classList.add('hidden');
    el.classList.remove('pop');
  }, 4000);
}

/** 实体图鉴（Codex 的"活体博物馆"） */
function renderBestiary(c) {
  const best = (c && c.bestiary) || {};
  const keys = Object.keys(best);
  if (keys.length === 0) return '';
  const lines = keys
    .map((t) => {
      const b = best[t];
      return `<div class="beast-line"><span class="beast-emoji">${b.emoji || '❓'}</span><b>${escapeHtml(b.name)}</b> — 目击 ${b.seen} 次<span class="beast-desc">${escapeHtml(b.desc || '')}</span></div>`;
    })
    .join('');
  return `<div class="codex-summary"><div class="cs-title">实体图鉴（${keys.length}/${Object.keys(ENTITY_DEFS).length}）</div>${lines}</div>`;
}

/** 画布自适应：canvas 像素 = 父容器(#view)像素，显示 1:1 铺满可用区域（任何设备都不变形、不留黑边） */
let lastCanvasSize = '';
function resizeCanvas() {
  const c = $('game-canvas');
  const view = $('view');
  if (!c || !view) return;
  const availW = Math.floor(view.clientWidth || c.width);
  const availH = Math.floor(view.clientHeight || c.height);
  if (availW < 80 || availH < 80) return;
  const key = availW + 'x' + availH;
  if (key === lastCanvasSize) return;
  lastCanvasSize = key;
  c.width = availW;
  c.height = availH;
  c.style.width = availW + 'px';
  c.style.height = availH + 'px';
  document.body.dataset.csize = availW + 'x' + availH;
}

function renderAll() {
  if (!game) return;
  resizeCanvas();
  renderHud();
  drawGame();
  // 开局/读档/野性层级：建立理智阶段基线 + 心跳判定
  audioCheckSanity();
  audioCheckHeartbeat();
}

// 窗口尺寸/方向变化时自适应画布
window.addEventListener('resize', () => {
  resizeCanvas();
  if (game && !game.over) drawGame();
});
if (typeof window.matchMedia === 'function') {
  window.matchMedia('(orientation: landscape)').addEventListener?.('change', () => {
    setTimeout(() => {
      resizeCanvas();
      if (game && !game.over) drawGame();
    }, 120);
  });
}

// ---------- 弹窗内容 ----------
function fillLogModal() {
  if (!game) return;
  const g = game;
  const c = g.codex || {};
  const levelNames = Object.keys(c.levels || {})
    .map((id) => c.levels[id].name || id)
    .join('、');
  const st = (game && game.stats) || {};
  const earned = game.achievements || new Set();
  const achList = ACHIEVEMENTS.map(
    (a) =>
      `<div class="ach-row ${earned.has(a.id) ? 'unlocked' : ''}">${earned.has(a.id) ? '🏆' : '○'} <b>${escapeHtml(a.name)}</b><span class="ach-desc">${escapeHtml(a.desc)}</span></div>`
  ).join('');
  $('log-body').innerHTML =
    `<div class="codex-summary">` +
    `<div class="cs-title">行记 Codex</div>` +
    `<div class="cs-line">已发现 ${Object.keys(c.levels || {}).length} 个层级：${levelNames || '仅 Level 0'}</div>` +
    `<div class="cs-line">笔记 ${(c.notes || []).length} 条 · 死亡 ${(c.deaths || []).length} 次 · 成就 ${earned.size}/${ACHIEVEMENTS.length} 个</div>` +
    `<div class="cs-line">统计：回合 ${(game && game.turn) || 0} · 移动 ${st.movesTotal || 0} 格 · 击杀 ${st.kills || 0} · 场景 ${st.scenesSeen || 0} · 无人机 ${st.dronesUsed || 0} · 手枪击杀 ${st.pistolKills || 0} · 黑暗回合 ${st.darkTurns || 0}</div>` +
    (c.notes && c.notes.length
      ? `<div class="cs-notes">${c.notes.map((n) => `「${escapeHtml(String(n))}」`).join(' ')}</div>`
      : '') +
    `</div>` +
    `<div class="codex-summary"><div class="cs-title">成就（${earned.size}/${ACHIEVEMENTS.length}）</div>${achList}</div>` +
    renderBestiary(c) +
    game.log
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
  mapCtx.fillStyle = '#050403';
  mapCtx.fillRect(0, 0, W, H);
  if (level.infinite) {
    // 无限层：局部地图（以玩家为中心的 41×41，走过的地方才显示）
    const R = 20;
    const tw = W / (R * 2 + 1);
    const th = H / (R * 2 + 1);
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const x = g.player.x + dx;
        const y = g.player.y + dy;
        const key = x + ',' + y;
        if (!explored.has(key) && !(dx === 0 && dy === 0)) continue;
        const t = tileAt(level, x, y);
        let color = '#1d1a12';
        if (t === '#') color = '#3a3424';
        else if (t === '~') color = '#16324a';
        else if (t === 'T') color = '#4a2a5a';
        else if (t === 'D' || t === 'S') color = '#5a5038';
        mapCtx.fillStyle = color;
        mapCtx.fillRect((dx + R) * tw, (dy + R) * th, tw + 1, th + 1);
      }
    }
    // 出口（仅玩家附近已发现的；范围外的画边缘箭头指方向）
    for (let i = 0; i < level.exits.length; i++) {
      const ex = level.exits[i];
      if (ex.hidden && !g.discoveredExits[g.levelId].has(i)) continue;
      const dx = ex.x - g.player.x;
      const dy = ex.y - g.player.y;
      if (Math.abs(dx) <= R && Math.abs(dy) <= R) {
        mapCtx.fillStyle = ex.hidden ? '#e8e08a' : '#8ad8a0';
        mapCtx.fillRect((dx + R) * tw + tw * 0.25, (dy + R) * th + th * 0.25, tw * 0.5 + 1, th * 0.5 + 1);
      } else {
        // 边缘箭头：指向出口方向（归一化到局部地图边缘）
        const norm = Math.max(Math.abs(dx), Math.abs(dy));
        const ax = (dx / norm) * R + R;
        const ay = (dy / norm) * R + R;
        const ang = Math.atan2(dy, dx);
        mapCtx.save();
        mapCtx.translate(ax * tw + tw / 2, ay * th + th / 2);
        mapCtx.rotate(ang);
        mapCtx.fillStyle = ex.hidden ? 'rgba(232,224,138,0.9)' : 'rgba(138,216,160,0.9)';
        mapCtx.beginPath();
        mapCtx.moveTo(8, 0);
        mapCtx.lineTo(-4, -5);
        mapCtx.lineTo(-4, 5);
        mapCtx.closePath();
        mapCtx.fill();
        mapCtx.restore();
      }
    }
    // 玩家（中心）
    mapCtx.fillStyle = '#f2f2f2';
    mapCtx.beginPath();
    mapCtx.arc(W / 2, H / 2, Math.max(2, tw * 0.4), 0, Math.PI * 2);
    mapCtx.fill();
    return;
  }
  const tw = W / level.width;
  const th = H / level.height;
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
    case 'b':
      toggleInvModal();
      break;
    case 'e':
      doAction({ type: 'interact' });
      break;
    case 'x':
      doAction({ type: 'exit' });
      break;
    case 'f':
      doAction({ type: 'light' });
      break;
    case 'c':
      doAction({ type: 'fight' });
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
let autosaveCounter = 0;
function doAction(action) {
  if (!game || game.over) return;
  if (action.type === 'interact') {
    const onItem = game.items.some((it) => it.x === game.player.x && it.y === game.player.y);
    action = onItem ? { type: 'take' } : { type: 'search' };
  }

  const prevLevelId = game.levelId;
  const prevX = game.player.x;
  const prevY = game.player.y;
  const res = step(game, action);
  const events = res.events;

  renderEvents(events);

  // 音频：事件音效 + 移动脚步声（位置变化才算移动成功）
  const moved =
    (action.type === 'move' || action.type === 'run') &&
    (game.player.x !== prevX || game.player.y !== prevY);
  audioAfterStep(events, moved, action.type === 'run');

  // 层级切换 → 故障过渡遮罩
  if (game.levelId !== prevLevelId) {
    const dna = game.levels[game.levelId];
    rebuildVisuals();
    showTransition(`你穿过了故障的墙壁……\n${dna ? `${dna.name}（难度 Class ${dna.difficultyClass}）` : game.levelId}\n${dna ? dna.description : ''}`, 3200);
  }

  renderHud();
  drawGame();
  // 自动保存节流：每 5 回合全量存档（层级切换/死亡立即保存，避免每回合序列化开销）
  if (game.levelId !== prevLevelId || game.over) {
    autosaveCounter = 0;
    saveGame();
  } else {
    autosaveCounter++;
    if (autosaveCounter >= 5) {
      autosaveCounter = 0;
      saveGame();
    }
  }

  // 每回合结算：理智跨阶段检测 + 危险实体心跳检测
  audioCheckSanity();
  audioCheckHeartbeat();

  if (game.over) {
    // 死亡：停止心跳与随机突发音效定时器
    try {
      onHeartbeat(false);
    } catch (err) {
      /* 忽略 */
    }
    stopStartles();
    showDeath();
  }
}

// ============================================================
// 音频接入（AUDIO-SPEC §4）：所有调用 try/catch 包裹，
// AudioContext 未初始化 / 浏览器不支持时静默失败，绝不影响游戏逻辑。
// ============================================================

/** 首次用户手势创建 AudioContext（幂等） */
function audioInitSafe() {
  try {
    initAudio();
  } catch (err) {
    /* 音频失败不影响游戏 */
  }
}

/** 层级切换：切换音景 + 重置随机突发音效定时器 */
function audioSetLevelSafe() {
  try {
    if (game) setLevelSound(game.levels[game.levelId]);
  } catch (err) {
    /* 忽略 */
  }
  scheduleStartles();
}

/** 事件文本命中突发音效关键词才触发（与 audio.js 内部匹配表对齐） */
const STARTLE_KEYWORDS = /(脚步声|咔哒|刮擦|抓挠|低语|水滴|滴水|水珠|水花|滴落|碰撞|敲击|撞击|金属|寂静|安静|敲门|门|呼吸|窃笑|叹息|蒸汽|噼啪|入水)/;

/**
 * 每回合结算后的音频联动（AUDIO-SPEC §4.4）：
 *  含"穿过" → onExit（卡出）；门/传送门 → onDoor；受击 → onHit；
 *  移动成功 → onPlayerMove(run)；其余事件命中关键词 → startle。
 */
function audioAfterStep(events, moved, ran) {
  if (!isAudioReady()) return; // 未初始化：静默
  let teleported = false; // 门/传送门（播放 onDoor，抑制脚步）
  let exited = false; // 卡出
  let hit = false; // 受击
  let shot = false; // 手枪射击
  let drone = false; // 无人机
  let scene = false; // 场景触发
  const startles = [];
  for (const e of events || []) {
    const t = e.text || '';
    if (/穿过/.test(t)) {
      exited = true;
      continue;
    }
    if ((e.kind === 'level' || e.kind === 'system') && /(门|吱呀|空间扭曲)/.test(t)) {
      teleported = true;
      continue;
    }
    if (e.kind === 'combat' && /(攻击了你|反击了你|受了伤)/.test(t)) {
      hit = true;
      continue;
    }
    if (e.kind === 'combat' && /用手枪攻击/.test(t)) {
      shot = true;
      continue;
    }
    if (e.kind === 'item' && /无人机/.test(t)) {
      drone = true;
      continue;
    }
    if (e.kind === 'sanity' && /【场景】/.test(t)) {
      scene = true;
      continue;
    }
    if (STARTLE_KEYWORDS.test(t)) startles.push(t);
  }
  try {
    if (exited) onExit();
    if (shot) onShot();
    if (hit) onHit();
    if (teleported) onDoor();
    else if (!exited && moved) onPlayerMove(ran, playerOnWater()); // 卡出时不再叠加脚步
    if (drone) onDrone();
    if (scene) onScene();
    for (const t of startles) startle(t);
  } catch (err) {
    /* 音频失败不影响游戏 */
  }
}

/** 玩家当前所在格是否为水格（脚步更闷） */
function playerOnWater() {
  const lv = game && game.level;
  if (!lv || !lv.tiles) return false;
  const row = lv.tiles[game.player.y];
  return !!(row && row[game.player.x] === '~');
}

// ---------- 理智阶段检测（每回合结算后比较，跨阶段才调用） ----------

let lastAudioSanity = null; // 上次通知过的阶段

function audioSanityStageOf(s) {
  if (s > 50) return 'calm';
  if (s > 30) return 'unsettled';
  if (s > 15) return 'fear';
  return 'collapse';
}

function audioCheckSanity() {
  if (!game || !isAudioReady()) return;
  const stage = audioSanityStageOf(game.player.sanity);
  if (stage === lastAudioSanity) return;
  lastAudioSanity = stage;
  try {
    onSanityStage(stage);
  } catch (err) {
    /* 忽略 */
  }
}

// ---------- 危险实体心跳（hostile 且距离 <6） ----------

// 会主动追击/近身攻击的实体行为表（wander/watch/civilian 不算）
const AGGRESSIVE_BEHAVIORS = new Set([
  'dark-chase',
  'noise-chase',
  'lit-ambush',
  'stealth-ambush',
  'slow-wander',
  'light-attract',
  'madness',
  'lurk-chase',
]);

function isHostileEntity(e) {
  if (!e || e.hp <= 0) return false;
  if (e.aggression === 'hostile') return true; // 层级 DNA 显式标记
  const def = ENTITY_DEFS[e.type] || {};
  return (def.dmg || 0) > 0 && AGGRESSIVE_BEHAVIORS.has(def.behavior);
}

function audioCheckHeartbeat() {
  if (!game || !isAudioReady()) return;
  const p = game.player;
  const lv = game.level;
  const looping = lv && lv.spaceRules && lv.spaceRules.includes('looping');
  const W = lv ? lv.width : 1;
  const H = lv ? lv.height : 1;
  let near = false;
  for (const e of game.entities || []) {
    if (!isHostileEntity(e)) continue;
    let dx = Math.abs(e.x - p.x);
    let dy = Math.abs(e.y - p.y);
    if (looping) {
      // 环形层级按环绕距离计算
      dx = Math.min(dx, W - dx);
      dy = Math.min(dy, H - dy);
    }
    if (Math.max(dx, dy) < 6) {
      near = true;
      break;
    }
  }
  try {
    onHeartbeat(near);
  } catch (err) {
    /* 忽略 */
  }
}

// ---------- 随机突发音效（DNA soundscape.startles，25-60s，理智越低越频繁） ----------

let startleTimer = null;

function scheduleStartles() {
  clearTimeout(startleTimer);
  startleTimer = null;
  if (!game || game.over || !isAudioReady()) return;
  const dna = game.levels[game.levelId];
  const pool = dna && dna.soundscape && dna.soundscape.startles;
  if (!pool || pool.length === 0) return;
  const s = Math.max(0, Math.min(100, game.player.sanity));
  const base = 60 - (s / 100) * 35; // 25..60s
  const factor = s < 15 ? 0.55 : s < 30 ? 0.75 : 1; // 理智越低频率越高
  const interval = (base * factor + Math.random() * 15) * 1000;
  startleTimer = setTimeout(() => {
    startleTimer = null;
    try {
      startle(pool[Math.floor(Math.random() * pool.length)]);
    } catch (err) {
      /* 忽略 */
    }
    scheduleStartles();
  }, interval);
}

function stopStartles() {
  clearTimeout(startleTimer);
  startleTimer = null;
}

// ---------- 静音开关 ----------

let audioMuted = false;

function toggleMute() {
  audioMuted = !audioMuted;
  try {
    setMuted(audioMuted);
  } catch (err) {
    /* 忽略 */
  }
  const btn = $('btn-mute');
  if (btn) {
    btn.textContent = audioMuted ? '🔇' : '🔊';
    btn.classList.toggle('muted', audioMuted);
    btn.title = audioMuted ? '已静音（点击恢复）' : '静音';
  }
}

// ---------- 音量滑杆 ----------
function wireVolumeSlider() {
  const slider = $('vol-slider');
  if (!slider) return;
  slider.addEventListener('input', () => {
    try {
      setVolume(Number(slider.value) / 100);
    } catch (err) {
      /* 忽略 */
    }
  });
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
  // 静音开关（🔊/🔇，点击切换）
  $('btn-mute').addEventListener('click', toggleMute);
  $('btn-inv').addEventListener('click', toggleInvModal);
  wireVolumeSlider();
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
  // 奔跑模式：点按方向键=奔跑（2 格），长按仍为安全行走
  let runMode = false;
  const runBtn = document.querySelectorAll('#action-pad [data-act="run"]')[0];
  const setRunMode = (on) => {
    runMode = on;
    if (runBtn) runBtn.classList.toggle('active', on);
    renderEvents([{ text: on ? '奔跑模式开启：点按方向键将奔跑 2 格（长按仍为行走）' : '奔跑模式关闭。', kind: 'system' }]);
  };
  document.querySelectorAll('#touch-pad .pad-btn').forEach((btn) => {
    // 长按不弹系统菜单
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    if (btn.dataset.dir) {
      const DIRS = { up: { dx: 0, dy: -1 }, down: { dx: 0, dy: 1 }, left: { dx: -1, dy: 0 }, right: { dx: 1, dy: 0 } };
      const d = DIRS[btn.dataset.dir];
      let holdTimer = null;
      const stepOnce = () => safeRun(() => doAction(runMode ? { type: 'run', dx: d.dx, dy: d.dy } : { type: 'move', dx: d.dx, dy: d.dy }));
      const stepHold = () => safeRun(() => doAction({ type: 'move', dx: d.dx, dy: d.dy }));
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
        closeOpenModals(); // 弹窗打开时先关掉，避免遮罩挡住按键
        stepOnce();
        holdTimer = setInterval(stepHold, 170);
      });
      for (const ev of upEvs) btn.addEventListener(ev, stopHold);
    } else if (btn.dataset.act) {
      const acts = {
        rest: { type: 'rest' },
        search: { type: 'interact' },
        light: { type: 'light' },
        log: { type: 'log' },
        exit: { type: 'exit' },
        fight: { type: 'fight' },
        map: { type: 'map' },
        help: { type: 'help' },
        run: { type: 'run' },
      };
      const a = acts[btn.dataset.act];
      btn.addEventListener('click', () => {
        if (a.type === 'log') {
          fillLogModal();
          showOverlay('log-modal');
        } else if (a.type === 'map') {
          drawMapModal();
          showOverlay('map-modal');
        } else if (a.type === 'help') {
          showOverlay('help-modal');
        } else if (a.type === 'run') {
          setRunMode(!runMode);
        } else {
          closeOpenModals(); // 弹窗打开时先关掉，避免遮罩挡住按键
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
  // 首次运行自动展示操作说明（一次性，关闭后不再弹出）
  if (!loadJSON('backrooms.guide.v1', false)) {
    saveJSON('backrooms.guide.v1', true);
    showOverlay('help-modal');
  }
}

// ---------- 启动 ----------
// 启动标记：无头浏览器/诊断用（body[data-boot] 证明模块已执行、数据已加载）
document.body.dataset.boot = 'ok';
document.body.dataset.levels = String(Object.keys(levels || {}).length);
logClick('boot', `模块已加载，${Object.keys(levels || {}).length} 个层级就绪`);
window.addEventListener('keydown', (e) => {
  // 首次用户手势：创建 AudioContext（幂等，浏览器自动播放策略要求）
  audioInitSafe();
  if (e.key === 'Shift') shiftHeld = true;
  handleKey(e);
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'Shift') shiftHeld = false;
});
// 触屏/鼠标首次点击同样初始化音频
window.addEventListener('pointerdown', () => audioInitSafe());

wireButtons();
animate();

// 深链调试：?autostart=1 自动开局，可选 &level=level-19 指定层级（无头浏览器截图/自动化测试用；对普通玩家无影响）
try {
  if (new URLSearchParams(location.search).get('autostart') === '1') {
    document.body.dataset.autostart = 'queued';
    setTimeout(() => {
      document.body.dataset.autostart = 'running';
      try {
        newGame();
        const want = new URLSearchParams(location.search).get('level');
        if (want && game.levels[want]) {
          enterLevel(game, want, {});
          rebuildVisuals();
        }
        document.body.classList.add('in-game');
        renderAll();
        document.body.dataset.autostart = 'done';
      } catch (err) {
        document.body.dataset.autostart = 'error:' + (err && err.message ? err.message : err);
        showFatal('autostart: ' + (err && err.message ? err.message : err));
      }
    }, 50);
  }
} catch (err) {
  document.body.dataset.autostart = 'outer:' + (err && err.message ? err.message : err);
}