// proto/web/audio.js — 零依赖程序化音频（Web Audio API）
// 按 AUDIO-SPEC v1.0 实现《后室：无尽回廊》全部声音设计：
//   荧光灯嗡鸣（核心）/ 环境底噪 / 脚步声 / 突发音效 / 理智扭曲 / 心跳 / 卡出·门·受击
// 纯 ESM：无外部音频文件、无 AudioWorklet、无网络请求。
// 设计原则：所有持续节点可停止（层级切换/静音时清理）；音量克制（氛围 > 存在感），避免刺耳。

// ========== 内部状态 ==========
let ctx = null; // AudioContext（首次用户手势后创建）
let master = null; // 主增益（0.8，静音开关 / ducking 挂这里）
let comp = null; // 压缩器（防爆音）
let noiseBuffer = null; // 2s 白噪声 buffer（全模块复用）
let muted = false; // 全局静音

// —— 音景（嗡鸣 + 环境层）——
let humActive = false; // 嗡鸣是否在运行
let humGain = null; // 嗡鸣总线（淡入/闪烁/理智增益 LFO 都作用于此）
let humBase = 0.2; // 嗡鸣基础增益（由 dna.light 决定）
let humOscs = []; // 持续嗡鸣部件 [osc, gain, ...]
let humFlickerStop = null; // 灯管闪烁定时器（停止函数）
let humDrift = null; // 理智漂移 LFO { osc, g }（接各 osc.detune）
let humTrem = null; // 理智增益 LFO { osc, g }（接 humGain.gain）
let humBeatNodes = []; // 崩溃阶段拍频振荡器 [osc, gain, ...]
let ambientLayers = []; // 当前环境层 [{ out, base, stop, setBoost }]
let silenceTimer = null; // silenceEvents 自动 ducking 定时器

// —— 心跳 ——
let heartTimer = null;
let heartOn = false;

// —— 理智阶段 ——
let sanityStage = 'calm';
let collapseTimer = null; // 崩溃阶段刺耳瞬态定时器

// ========== 基础设施 ==========

/** 创建 AudioContext（幂等；必须在用户手势内调用） */
export function initAudio() {
  if (ctx) {
    resumeCtx();
    return;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return; // 浏览器不支持：静默降级，游戏不受影响
  ctx = new AC();

  // 总输出：master(0.8) → compressor → destination（防爆音）
  comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.knee.value = 12;
  comp.ratio.value = 4;
  comp.attack.value = 0.003;
  comp.release.value = 0.25;
  master = ctx.createGain();
  master.gain.value = muted ? 0 : 0.8 * volume;
  master.connect(comp);
  comp.connect(ctx.destination);

  // 预生成 2s 白噪声 buffer（所有噪声类音色共用）
  noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  resumeCtx();
}

function resumeCtx() {
  if (ctx && ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
}

/** AudioContext 是否已可用 */
export function isAudioReady() {
  return !!ctx && ctx.state !== 'closed';
}

let volume = 1; // 用户音量（0-1），与静音开关叠加

/** 设置用户音量（0-1）。静音时保持记忆，取消静音后生效。 */
export function setVolume(v) {
  volume = Math.min(1, Math.max(0, Number(v) || 0));
  if (!ctx || !master) return;
  const t = ctx.currentTime;
  master.gain.cancelScheduledValues(t);
  master.gain.setValueAtTime(muted ? 0 : 0.8 * volume, t);
}

/** 全局静音：仅操作 master 增益（所有音色都经它输出） */
export function setMuted(m) {
  muted = !!m;
  if (!ctx || !master) return;
  const t = ctx.currentTime;
  master.gain.cancelScheduledValues(t);
  master.gain.setValueAtTime(muted ? 0 : 0.8 * volume, t);
}

// ---------- 节点小工具 ----------

function gainAt(v) {
  const g = ctx.createGain();
  g.gain.value = v;
  return g;
}

/** 噪声源：dur 给定时一次性播放；否则循环播放（供环境层用）。when 为可选起始时间 */
function noiseSource(dur, when) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuffer;
  const t = when == null ? ctx.currentTime : when;
  if (dur) {
    s.start(t);
    s.stop(t + dur);
  } else {
    s.loop = true;
    s.start(t);
  }
  return s;
}

function filterNode(type, freq, q) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q || 1;
  return f;
}

/** 停止一组节点（振荡器/源/增益），异常静默 */
function stopNodes(nodes) {
  for (const n of nodes) {
    if (!n) continue;
    try {
      if (typeof n.stop === 'function') n.stop();
      if (typeof n.disconnect === 'function') n.disconnect();
    } catch {
      /* 已停止/已断开：忽略 */
    }
  }
}

// ============================================================
// 2.1 荧光灯嗡鸣（核心氛围）
// 合成：50Hz 正弦 + 100Hz(0.3) + 120Hz(0.15)，轻微失谐；
// 音量/密度由 dna.light 决定；flickering 叠加灯管闪烁 LFO；
// 理智扭曲阶段对其做 playbackRate(detune) 漂移 + 增益 LFO（见 onSanityStage）。
// ============================================================

const HUM_PART = [
  { f: 50, amp: 1.0 },
  { f: 100, amp: 0.3 },
  { f: 120, amp: 0.15 },
];

// light → 嗡鸣基础增益（AUDIO-SPEC §2.1）
const LIGHT_HUM_GAIN = { bright: 0.12, dim: 0.2, flickering: 0.28, dark: 0.15, pitch: 0.05 };

function startHum(light) {
  const base = LIGHT_HUM_GAIN[light] != null ? LIGHT_HUM_GAIN[light] : 0.2;
  humBase = base;
  humActive = true;
  humGain = gainAt(0);
  humGain.connect(master);
  // 2s 淡入（进入层级即"听得到"）
  humGain.gain.linearRampToValueAtTime(base, ctx.currentTime + 2);

  for (const p of HUM_PART) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    // 轻微失谐，避免干涩的正弦叠加（荧光灯"嗡嗡"质感）
    osc.frequency.value = p.f * (1 + (Math.random() - 0.5) * 0.006);
    const g = gainAt(p.amp * base);
    osc.connect(g).connect(humGain);
    osc.start();
    humOscs.push(osc, g);
  }

  // 闪烁灯管：每 0.4-2s 随机骤降 40-80%，0.1-0.5s 后回升
  if (light === 'flickering') humFlickerStop = startFlicker(base);

  // 按当前理智阶段建立漂移 / 增益 LFO / 拍频
  applySanityHum();
}

/** 灯管闪烁：对 humGain 做随机骤降自动化（与理智 LFO 叠加互不冲突） */
function startFlicker(base) {
  let timer = null;
  const loop = () => {
    timer = setTimeout(() => {
      const t = ctx.currentTime;
      const dip = 0.4 + Math.random() * 0.4; // 40-80%
      const dur = 0.1 + Math.random() * 0.4; // 0.1-0.5s
      const target = base * (1 - dip);
      humGain.gain.cancelScheduledValues(t);
      humGain.gain.setValueAtTime(base, t);
      humGain.gain.linearRampToValueAtTime(target, t + 0.02);
      humGain.gain.linearRampToValueAtTime(base, t + 0.02 + dur + 0.1 + Math.random() * 0.25);
      loop();
    }, 400 + Math.random() * 1600);
  };
  loop();
  return () => {
    clearTimeout(timer);
    timer = null;
  };
}

// 各阶段嗡鸣扭曲参数：cents = detune 漂移深度；trem = 增益 LFO 幅度（相对 base）；beat = 拍频
const STAGE_HUM = {
  calm: { cents: 0, trem: 0, beat: false },
  unsettled: { cents: 50, trem: 0, beat: false }, // ±3% ≈ 50 cents
  fear: { cents: 130, trem: 0.1, beat: false }, // ±8% ≈ 130 cents，增益 LFO 0.5Hz
  collapse: { cents: 250, trem: 0.15, beat: true }, // ±15% ≈ 250 cents + 拍频相位感
};

/** 理智阶段 → 嗡鸣扭曲（漂移 LFO / 增益 LFO / 崩溃拍频） */
function applySanityHum() {
  if (!humActive || !ctx || !humGain) return;
  const cfg = STAGE_HUM[sanityStage] || STAGE_HUM.calm;
  const t = ctx.currentTime;

  // 漂移 LFO（0.06-0.1Hz 缓慢）→ 各 osc.detune
  if (!humDrift) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 0.06 + Math.random() * 0.04;
    const g = gainAt(0);
    osc.connect(g);
    for (let i = 0; i < humOscs.length; i += 2) g.connect(humOscs[i].detune);
    osc.start();
    humDrift = { osc, g };
  }
  humDrift.g.gain.cancelScheduledValues(t);
  humDrift.g.gain.setTargetAtTime(cfg.cents, t, 3);

  // 增益 LFO（0.5Hz，fear/collapse 时嗡鸣随之起伏）
  if (!humTrem) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 0.5;
    const g = gainAt(0);
    osc.connect(g).connect(humGain.gain);
    osc.start();
    humTrem = { osc, g };
  }
  humTrem.g.gain.cancelScheduledValues(t);
  humTrem.g.gain.setTargetAtTime(cfg.trem * humBase, t, 1.5);

  // 崩溃：加一对失谐振荡器（+2%）制造拍频相位感
  if (cfg.beat && humBeatNodes.length === 0) {
    for (const p of HUM_PART) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = p.f * 1.02;
      const g = gainAt(p.amp * 0.35 * humBase);
      osc.connect(g).connect(humGain);
      osc.start();
      humBeatNodes.push(osc, g);
    }
  } else if (!cfg.beat && humBeatNodes.length > 0) {
    stopNodes(humBeatNodes);
    humBeatNodes = [];
  }
}

function stopDriftTrem() {
  if (humDrift) {
    stopNodes([humDrift.osc, humDrift.g]);
    humDrift = null;
  }
  if (humTrem) {
    stopNodes([humTrem.osc, humTrem.g]);
    humTrem = null;
  }
}

// ============================================================
// 2.2 环境底噪（每层不同，1-3 层；按 ambient 描述分类合成）
// ============================================================

/** 按中文描述把 ambient 条目分类成噪声层类型 */
function classifyAmbient(text) {
  if (/嗡鸣|电流|低鸣|运转|泵|风扇|机械|气流|空调|通风|电梯|背景音乐|广播|变压器/.test(text)) return 'hum';
  if (/水滴|滴水|水珠|滴落|喷泉|水声|水花|入水/.test(text)) return 'drip';
  if (/风/.test(text)) return 'wind';
  if (/脚步|拖行|敲击|键盘|关门|移动|门/.test(text)) return 'steps';
  return 'dark';
}

/**
 * 启动一个环境层。返回 { out, base, stop, setBoost }：
 *  - out：该层输出增益（整体缩放，理智 boost 与 2s 淡入淡出都作用于此）
 *  - setBoost(db)：理智阶段噪声增益（fear +3dB / collapse +6dB）
 */
function startLayer(kind, light) {
  const out = gainAt(0);
  out.connect(master);
  let timer = null;
  const extras = []; // 持续运行的源/振荡器（stop 时一并停掉）
  const layer = {
    kind,
    out,
    base: 1,
    stop() {
      clearTimeout(timer);
      stopNodes(extras);
      try {
        out.disconnect();
      } catch {
        /* 忽略 */
      }
    },
    setBoost(db) {
      const k = Math.pow(10, db / 20);
      out.gain.setTargetAtTime(layer.base * k, ctx.currentTime, 1.2);
    },
  };

  switch (kind) {
    case 'hum': {
      // 嗡鸣类：低通噪声 + 慢 LFO 呼吸
      layer.base = 0.03;
      const src = noiseSource();
      const lp = filterNode('lowpass', 240 + Math.random() * 60, 0.8);
      src.connect(lp).connect(out);
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.07 + Math.random() * 0.07;
      const lg = gainAt(layer.base * 0.3);
      lfo.connect(lg).connect(out.gain);
      lfo.start();
      extras.push(src, lfo, lg);
      break;
    }
    case 'drip': {
      // 滴水类：随机间隔的短促高频滴答（1500Hz 振荡器 + 快速衰减）
      layer.base = 1;
      const loop = () => {
        timer = setTimeout(() => {
          dripTick(out);
          loop();
        }, 1800 + Math.random() * 4200);
      };
      loop();
      break;
    }
    case 'wind': {
      // 风声类：带通噪声 + 大 LFO
      layer.base = 0.035;
      const src = noiseSource();
      const bp = filterNode('bandpass', 350 + Math.random() * 150, 1.2);
      src.connect(bp).connect(out);
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 0.08 + Math.random() * 0.08;
      const lg = gainAt(layer.base * 0.55);
      lfo.connect(lg).connect(out.gain);
      lfo.start();
      extras.push(src, lfo, lg);
      break;
    }
    case 'steps': {
      // 脚步类：低频噪声脉冲（节奏随机，暗示"远处有人"）
      layer.base = 1;
      const loop = () => {
        timer = setTimeout(() => {
          stepPulse(out);
          if (Math.random() < 0.35) setTimeout(() => stepPulse(out), 380); // 偶发两步
          loop();
        }, 2600 + Math.random() * 4400);
      };
      loop();
      break;
    }
    default: {
      // 暗噪声层：无 ambient 数据时的默认层（pitch/dark 层级加大）
      layer.base = light === 'pitch' || light === 'dark' ? 0.05 : 0.03;
      const src = noiseSource();
      const lp = filterNode('lowpass', 160 + Math.random() * 60, 0.9);
      src.connect(lp).connect(out);
      extras.push(src);
      break;
    }
  }

  // 2s 淡入（与旧音景交叉淡化）
  const t = ctx.currentTime;
  out.gain.setValueAtTime(0.0001, t);
  out.gain.linearRampToValueAtTime(layer.base, t + 2);
  return layer;
}

/** 滴水滴答：短促高频正弦 + 快速衰减 */
function dripTick(out) {
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = 1200 + Math.random() * 600;
  const g = gainAt(0.0001);
  g.gain.exponentialRampToValueAtTime(0.02 + Math.random() * 0.015, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + 0.16);
}

/** 远处脚步脉冲：低频成形的短噪声 */
function stepPulse(out) {
  const t = ctx.currentTime;
  const src = noiseSource(0.3, t);
  const lp = filterNode('lowpass', 120 + Math.random() * 40, 1);
  const g = gainAt(0.0001);
  g.gain.exponentialRampToValueAtTime(0.045 + Math.random() * 0.02, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
  src.connect(lp).connect(g).connect(out);
}

// ============================================================
// 音景管理器：层级切换（setLevelSound）时停止旧节点、交叉淡化 2s
// ============================================================

/** 切换层级音景：dna = { soundscape: {ambient[], startles[], silenceEvents}, light, aesthetic } */
export function setLevelSound(dna) {
  if (!ctx) return; // 尚未初始化（首次手势前）：由下一次进入层级时建立
  stopSoundscape();
  const sc = (dna && dna.soundscape) || {};
  const light = (dna && dna.light) || 'dim';

  startHum(light);

  // 环境层：按 ambient 描述数量分配 1-3 层；无数据则默认一层暗噪声
  const list = (sc.ambient || []).slice(0, 3);
  const kinds = list.length > 0 ? list.map(classifyAmbient) : ['dark'];
  for (const kind of kinds) ambientLayers.push(startLayer(kind, light));
  applySanityAmbient(); // 按当前理智阶段设置噪声增益

  // silenceEvents：每 30-90s 自动 ducking 一次（"突然寂静"）
  if (sc.silenceEvents) scheduleSilence();

  // 层级切换后重置心跳（由 app.js 每回合重新判定）
  stopHeart();
}

/** 停止旧音景：嗡鸣与环境层 2s 淡出后彻底清理 */
function stopSoundscape() {
  if (!ctx) return;
  const t = ctx.currentTime;

  if (humGain) {
    try {
      humGain.gain.cancelScheduledValues(t);
      humGain.gain.setValueAtTime(humGain.gain.value, t);
      humGain.gain.linearRampToValueAtTime(0.0001, t + 2);
    } catch {
      /* 忽略 */
    }
    const oldGain = humGain;
    const oldOscs = humOscs.slice();
    const oldBeat = humBeatNodes.slice();
    humOscs = [];
    humBeatNodes = [];
    humGain = null;
    setTimeout(() => {
      stopNodes(oldOscs.concat(oldBeat));
      try {
        oldGain.disconnect();
      } catch {
        /* 忽略 */
      }
    }, 2100);
  }
  if (humFlickerStop) {
    humFlickerStop();
    humFlickerStop = null;
  }
  stopDriftTrem();

  const oldLayers = ambientLayers;
  ambientLayers = [];
  for (const layer of oldLayers) {
    try {
      layer.out.gain.cancelScheduledValues(t);
      layer.out.gain.setValueAtTime(layer.out.gain.value, t);
      layer.out.gain.linearRampToValueAtTime(0.0001, t + 2);
    } catch {
      /* 忽略 */
    }
  }
  setTimeout(() => {
    for (const layer of oldLayers) layer.stop();
  }, 2100);

  clearTimeout(silenceTimer);
  silenceTimer = null;
  humActive = false;
}

/** silenceEvents：30-90s 触发一次整体 ducking */
function scheduleSilence() {
  clearTimeout(silenceTimer);
  const loop = () => {
    silenceTimer = setTimeout(() => {
      duckAll(1.5);
      loop();
    }, 30000 + Math.random() * 60000);
  };
  loop();
}

/** 全体增益骤降 hold 秒后恢复（"突然寂静"突发音效） */
function duckAll(hold) {
  if (!ctx || !master) return;
  const cur = master.gain.value;
  if (cur <= 0.001) return; // 静音中不额外 duck
  const t = ctx.currentTime;
  master.gain.cancelScheduledValues(t);
  master.gain.setValueAtTime(cur, t);
  master.gain.linearRampToValueAtTime(cur * 0.2, t + 0.35);
  master.gain.linearRampToValueAtTime(cur * 0.2, t + 0.35 + hold);
  master.gain.linearRampToValueAtTime(cur, t + 0.35 + hold + 1.2);
}

// ============================================================
// 2.3 脚步声（走/跑节奏不同；水格更闷）
// ============================================================

export function onPlayerMove(isRun, water) {
  if (!ctx || !master) return;
  const t = ctx.currentTime;
  const vol = isRun ? 0.25 : 0.15;
  const jitter = (Math.random() - 0.5) * 0.02;

  // 低频成形的噪声脉冲（落脚"噗"声）
  const src = noiseSource(isRun ? 0.18 : 0.15, t + jitter);
  const lp = filterNode('lowpass', water ? 150 : 230, 1.1);
  const g = gainAt(0.0001);
  g.gain.exponentialRampToValueAtTime(vol, t + jitter + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + jitter + (isRun ? 0.14 : 0.11));
  src.connect(lp).connect(g).connect(master);

  // 短促低频正弦（落脚感；水格更低更闷）
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = (water ? 72 : 82) + (Math.random() - 0.5) * 8;
  const og = gainAt(0.0001);
  og.gain.exponentialRampToValueAtTime(vol * 0.85, t + jitter + 0.004);
  og.gain.exponentialRampToValueAtTime(0.0001, t + jitter + 0.08);
  osc.connect(og).connect(master);
  osc.start(t + jitter);
  osc.stop(t + jitter + 0.1);

  // 奔跑：叠加一层摩擦噪声
  if (isRun) {
    const fs = noiseSource(0.16, t + jitter);
    const bp = filterNode('bandpass', 1200, 0.8);
    const fg = gainAt(0.0001);
    fg.gain.exponentialRampToValueAtTime(0.07, t + jitter + 0.004);
    fg.gain.exponentialRampToValueAtTime(0.0001, t + jitter + 0.15);
    fs.connect(bp).connect(fg).connect(master);
  }
}

// ============================================================
// 2.7 门 / 卡出 / 受击
// ============================================================

/** 门传送：门轴吱呀 + 空间滑音 + 短延迟空间感 */
export function onDoor() {
  if (!ctx || !master) return;
  const t = ctx.currentTime;

  // 门轴吱呀：带通噪声 600 → 950 → 480Hz 扫频
  const src = noiseSource(0.7, t);
  const bp = filterNode('bandpass', 600, 6);
  bp.frequency.setValueAtTime(600, t);
  bp.frequency.linearRampToValueAtTime(950, t + 0.28);
  bp.frequency.linearRampToValueAtTime(480, t + 0.65);
  const g = gainAt(0.0001);
  g.gain.exponentialRampToValueAtTime(0.09, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
  src.connect(bp).connect(g);

  // 低频吱呀 90Hz + 7Hz 颤音
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = 90;
  const og = gainAt(0.0001);
  og.gain.exponentialRampToValueAtTime(0.055, t + 0.02);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 7;
  const lg = gainAt(0.02);
  lfo.connect(lg).connect(og.gain);
  osc.connect(og);

  // 空间感：0.03s 延迟 + 0.2 反馈（短混响感）
  const delay = ctx.createDelay(0.2);
  delay.delayTime.value = 0.03;
  const fb = gainAt(0.2);
  const wet = gainAt(0.1);
  delay.connect(fb);
  fb.connect(delay);
  delay.connect(wet);
  wet.connect(master);
  g.connect(master);
  og.connect(master);
  g.connect(delay);
  og.connect(delay);

  src.start(t);
  src.stop(t + 0.75);
  osc.start(t);
  osc.stop(t + 0.55);
  lfo.start(t);
  lfo.stop(t + 0.55);
  // 反馈环会自然衰减，1.4s 后清理延迟网络
  setTimeout(() => stopNodes([delay, fb, wet]), 1400);
}

/** 卡出：白噪声爆破（低通 4kHz→200Hz）+ 正弦滑音（300→80Hz） */
export function onExit() {
  if (!ctx || !master) return;
  const t = ctx.currentTime;

  const src = noiseSource(0.35, t);
  const lp = filterNode('lowpass', 4000, 0.7);
  lp.frequency.setValueAtTime(4000, t);
  lp.frequency.exponentialRampToValueAtTime(200, t + 0.3);
  const g = gainAt(0.0001);
  g.gain.exponentialRampToValueAtTime(0.26, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
  src.connect(lp).connect(g).connect(master);

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(300, t);
  osc.frequency.exponentialRampToValueAtTime(80, t + 0.3);
  const og = gainAt(0.0001);
  og.gain.exponentialRampToValueAtTime(0.11, t + 0.02);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
  osc.connect(og).connect(master);
}

/** 受击：60Hz 正弦衰减 + 噪声瞬态（低闷响） */
export function onHit() {
  if (!ctx || !master) return;
  const t = ctx.currentTime;

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(60, t);
  osc.frequency.exponentialRampToValueAtTime(38, t + 0.2);
  const og = gainAt(0.0001);
  og.gain.exponentialRampToValueAtTime(0.38, t + 0.01);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
  osc.connect(og).connect(master);

  const src = noiseSource(0.1, t);
  const bp = filterNode('bandpass', 300, 1);
  const g = gainAt(0.0001);
  g.gain.exponentialRampToValueAtTime(0.16, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
  src.connect(bp).connect(g).connect(master);
}

/** 枪声：短促噪声爆发 + 高频瞬态 + 低音炮冲击（手枪射击） */
export function onShot() {
  if (!ctx || !master) return;
  const t = ctx.currentTime;

  // 爆破噪声（极短）
  const src = noiseSource(0.05, t);
  const bp = filterNode('bandpass', 1800, 0.7);
  const g = gainAt(0.0001);
  g.gain.exponentialRampToValueAtTime(0.5, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  src.connect(bp).connect(g).connect(master);

  // 低频冲击
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(150, t);
  osc.frequency.exponentialRampToValueAtTime(40, t + 0.08);
  const og = gainAt(0.0001);
  og.gain.exponentialRampToValueAtTime(0.45, t + 0.005);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
  osc.connect(og).connect(master);

  // 高频金属尾音
  const osc2 = ctx.createOscillator();
  osc2.type = 'square';
  osc2.frequency.setValueAtTime(3200, t);
  osc2.frequency.exponentialRampToValueAtTime(1400, t + 0.1);
  const og2 = gainAt(0.0001);
  og2.gain.exponentialRampToValueAtTime(0.06, t + 0.002);
  og2.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
  osc2.connect(og2).connect(master);
}

/** 无人机：升空嗡鸣（滑音 + 螺旋桨噪声，约 1.2 秒） */
export function onDrone() {
  if (!ctx || !master) return;
  const t = ctx.currentTime;

  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(120, t);
  osc.frequency.exponentialRampToValueAtTime(260, t + 0.5);
  osc.frequency.exponentialRampToValueAtTime(180, t + 1.2);
  const og = gainAt(0.0001);
  og.gain.exponentialRampToValueAtTime(0.1, t + 0.15);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
  osc.connect(og).connect(master);

  const src = noiseSource(1.3, t);
  const bp = filterNode('bandpass', 900, 1.5);
  const g = gainAt(0.0001);
  g.gain.exponentialRampToValueAtTime(0.05, t + 0.2);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
  src.connect(bp).connect(g).connect(master);
}

/** 场景触发：低八度钟声 + 噪声沙粒（细思极恐的提示音） */
export function onScene() {
  if (!ctx || !master) return;
  const t = ctx.currentTime;

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(220, t);
  osc.frequency.exponentialRampToValueAtTime(110, t + 0.6);
  const og = gainAt(0.0001);
  og.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
  osc.connect(og).connect(master);

  const src = noiseSource(0.4, t + 0.05);
  const bp = filterNode('highpass', 2400, 1);
  const g = gainAt(0.0001);
  g.gain.exponentialRampToValueAtTime(0.03, t + 0.1);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
  src.connect(bp).connect(g).connect(master);
}

// ============================================================
// 2.4 突发音效（startles）：按文本关键词选合成器
// ============================================================

/**
 * 突发音效入口：text 为事件/音景描述，内部按关键词匹配合成器。
 * 未匹配任何关键词 → 默认噪声爆破 + 低正弦（音量克制）。
 */
export function startle(text) {
  if (!ctx || !master) return;
  const s = String(text || '');
  if (/敲门|门/.test(s)) return playKnock(s);
  if (/脚步/.test(s)) return playDistantSteps();
  if (/寂静|安静/.test(s)) return duckAll(1.5); // 突然寂静：整体 ducking
  if (/刮擦|抓挠|拖行/.test(s)) return playScrape();
  if (/低语|呼吸|窃笑|叹息/.test(s)) return playWhisper();
  if (/金属|碰撞|敲击|撞击|噼啪|爆出|跳电/.test(s)) return playClang();
  if (/咔哒|嗒/.test(s)) return playClick();
  if (/水滴|滴水|水珠|滴落|水花|入水|喷泉/.test(s)) return playDroplet();
  if (/蒸汽/.test(s)) return playSteam();
  playTransient(0.08); // 默认：噪声爆破 + 低正弦
}

/** 敲门声：两声低闷响（60Hz + 噪声，0.15s 间隔）；"停顿/一下"加第三下 */
function playKnock(text) {
  const thump = (dt) => {
    const t = ctx.currentTime + dt;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 60;
    const og = gainAt(0.0001);
    og.gain.exponentialRampToValueAtTime(0.26, t + 0.006);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    const src = noiseSource(0.08, t);
    const lp = filterNode('lowpass', 300, 1);
    const g = gainAt(0.0001);
    g.gain.exponentialRampToValueAtTime(0.09, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    osc.connect(og).connect(master);
    src.connect(lp).connect(g).connect(master);
    osc.start(t);
    osc.stop(t + 0.2);
  };
  thump(0);
  thump(0.15);
  if (/停顿|一下/.test(text)) setTimeout(() => thump(0), 500);
}

/** 远处脚步声：低频噪声脉冲 x3（渐近） */
function playDistantSteps() {
  for (let i = 0; i < 3; i++) {
    const t = ctx.currentTime + i * 0.42;
    const src = noiseSource(0.3, t);
    const lp = filterNode('lowpass', 110 + i * 30, 1);
    const g = gainAt(0.0001);
    g.gain.exponentialRampToValueAtTime(0.04 * ((i + 1) / 3), t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    src.connect(lp).connect(g).connect(master);
  }
}

/** 墙壁刮擦：带通噪声（800Hz）慢扫频 */
function playScrape() {
  const t = ctx.currentTime;
  const src = noiseSource(0.9, t);
  const bp = filterNode('bandpass', 800, 2);
  bp.frequency.setValueAtTime(600 + Math.random() * 300, t);
  bp.frequency.linearRampToValueAtTime(900 + Math.random() * 400, t + 0.5);
  bp.frequency.linearRampToValueAtTime(700, t + 0.85);
  const g = gainAt(0.0001);
  g.gain.exponentialRampToValueAtTime(0.07, t + 0.05);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
  src.connect(bp).connect(g).connect(master);
}

/** 低语：带通噪声（1kHz）+ 环形调制 LFO，音量极小 */
function playWhisper() {
  const t = ctx.currentTime;
  const dur = 1.4;
  const src = noiseSource(dur, t);
  const bp = filterNode('bandpass', 1000, 3);
  const g = gainAt(0.0001);
  g.gain.exponentialRampToValueAtTime(0.035, t + 0.15);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur - 0.1);
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 4 + Math.random() * 2;
  const lg = gainAt(0.015);
  lfo.connect(lg).connect(g.gain);
  src.connect(bp).connect(g).connect(master);
  lfo.start(t);
  lfo.stop(t + dur);
}

/** 金属碰撞：方波 220Hz 短促 + 噪声瞬态 */
function playClang() {
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.value = 220;
  const g = gainAt(0.0001);
  g.gain.exponentialRampToValueAtTime(0.045, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
  const src = noiseSource(0.05, t);
  const hp = filterNode('highpass', 2000, 0.7);
  const ng = gainAt(0.0001);
  ng.gain.exponentialRampToValueAtTime(0.09, t + 0.002);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  osc.connect(g).connect(master);
  src.connect(hp).connect(ng).connect(master);
}

/** 咔哒：短促高频噪声滴答 + 高频 ping */
function playClick() {
  const t = ctx.currentTime;
  const src = noiseSource(0.03, t);
  const bp = filterNode('bandpass', 2500, 6);
  const g = gainAt(0.0001);
  g.gain.exponentialRampToValueAtTime(0.09, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
  const osc = ctx.createOscillator();
  osc.frequency.value = 1800;
  const og = gainAt(0.0001);
  og.gain.exponentialRampToValueAtTime(0.05, t + 0.002);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.02);
  src.connect(bp).connect(g).connect(master);
  osc.connect(og).connect(master);
}

/** 水滴：1500Hz 振荡器 + 快速衰减 */
function playDroplet() {
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = 1500;
  const g = gainAt(0.0001);
  g.gain.exponentialRampToValueAtTime(0.045, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
  osc.connect(g).connect(master);
  osc.start(t);
  osc.stop(t + 0.18);
}

/** 蒸汽：带通噪声嘶声扫频 */
function playSteam() {
  const t = ctx.currentTime;
  const src = noiseSource(0.5, t);
  const bp = filterNode('bandpass', 2000, 1);
  bp.frequency.setValueAtTime(3000, t);
  bp.frequency.exponentialRampToValueAtTime(800, t + 0.4);
  const g = gainAt(0.0001);
  g.gain.exponentialRampToValueAtTime(0.07, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
  src.connect(bp).connect(g).connect(master);
}

/** 噪声爆破 + 低正弦（默认突发 / 崩溃阶段随机瞬态） */
function playTransient(vol) {
  const t = ctx.currentTime;
  const v = vol || 0.08;
  const src = noiseSource(0.12, t);
  const hp = filterNode('highpass', 1200, 0.7);
  const g = gainAt(0.0001);
  g.gain.exponentialRampToValueAtTime(v, t + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.value = 180 + Math.random() * 220;
  const og = gainAt(0.0001);
  og.gain.exponentialRampToValueAtTime(v * 0.5, t + 0.003);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
  src.connect(hp).connect(g).connect(master);
  osc.connect(og).connect(master);
}

// ============================================================
// 2.5 理智扭曲（与 game 状态联动）
// ============================================================

/**
 * 理智阶段：'calm' | 'unsettled' | 'fear' | 'collapse'
 * 由 app.js 在理智跨阶段时调用。
 */
export function onSanityStage(stage) {
  sanityStage = stage || 'calm';
  applySanityHum();
  applySanityAmbient();
  // 进入阶段的一次性音效
  if (stage === 'unsettled') playWhisper(); // 偶发 1 次低语
  else if (stage === 'fear') playDistantSteps(); // 偶发假脚步声（音量小）
  else if (stage === 'collapse') startCollapseTransients();
  else stopCollapseTransients();
}

// fear +3dB / collapse +6dB 的噪声层增益
const STAGE_AMBIENT_DB = { calm: 0, unsettled: 0, fear: 3, collapse: 6 };

function applySanityAmbient() {
  const db = STAGE_AMBIENT_DB[sanityStage] || 0;
  for (const layer of ambientLayers) layer.setBoost(db);
}

/** 崩溃阶段：随机刺耳瞬态（6-12s 一次，音量小） */
function startCollapseTransients() {
  stopCollapseTransients();
  const loop = () => {
    collapseTimer = setTimeout(() => {
      playTransient(0.05 + Math.random() * 0.05);
      loop();
    }, 6000 + Math.random() * 6000);
  };
  loop();
}

function stopCollapseTransients() {
  clearTimeout(collapseTimer);
  collapseTimer = null;
}

// ============================================================
// 2.6 心跳（危险实体靠近）：60Hz 双脉冲"咚-咚"，间隔 0.8s
// ============================================================

export function onHeartbeat(active) {
  if (!ctx) return;
  if (active === heartOn) return;
  if (active) {
    heartOn = true;
    clearTimeout(heartTimer);
    const beat = () => {
      heartThump(0);
      heartThump(0.18);
      heartTimer = setTimeout(beat, 800);
    };
    beat();
  } else {
    stopHeart();
  }
}

function stopHeart() {
  clearTimeout(heartTimer);
  heartTimer = null;
  heartOn = false;
}

function heartThump(dt) {
  const t = ctx.currentTime + dt;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(62, t);
  osc.frequency.exponentialRampToValueAtTime(44, t + 0.13);
  const g = gainAt(0.0001);
  g.gain.exponentialRampToValueAtTime(0.32, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.17);
  osc.connect(g).connect(master);
  osc.start(t);
  osc.stop(t + 0.2);
}
