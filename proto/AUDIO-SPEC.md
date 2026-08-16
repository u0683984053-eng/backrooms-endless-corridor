# 程序化音频模块规格 AUDIO-SPEC v1.0

> 目标：为《后室：无尽回廊》网页端实现**零依赖程序化音频**（Web Audio API），
> 完全按 Fandom 版氛围设计：灯管嗡鸣、环境底噪、脚步声、突发音效、静默切层、理智扭曲。
> 文件：`proto/web/audio.js`（新建，纯 ESM，无外部库），由 `app.js` 接入。

## 1. 模块接口

```js
// audio.js 导出：
export function initAudio()          // 创建 AudioContext（必须在用户手势后调用，幂等）
export function setLevelSound(dna)   // 切换层级音景：dna.soundscape {ambient[], startles[], silenceEvents} + dna.light + dna.aesthetic
export function onPlayerMove(isRun)  // 脚步声（走/跑节奏不同）
export function onDoor()             // 门传送：门轴吱呀 + 空间滑音
export function onExit()             // 卡出：故障音（噪声爆发 + 音高滑落）
export function onHit()              // 受击：低闷响
export function onSanityStage(stage) // 'calm'|'unsettled'|'fear'|'collapse'：理智扭曲程度
export function onHeartbeat(active)  // 危险实体靠近时：心跳声开启/关闭
export function setMuted(m)          // 全局静音
export function isAudioReady()       // AudioContext 是否已可用
```

## 2. 声音设计（Fandom 版）

### 2.1 荧光灯嗡鸣（核心）
- 合成：50Hz 正弦 + 100Hz（0.3 增益）+ 120Hz（0.15），轻微失谐。
- 音量/密度由 `dna.light` 决定：bright 0.12 / dim 0.2 / flickering 0.28（叠加闪烁 LFO：每 0.4-2s 随机骤降 40-80%，时长 0.1-0.5s，模拟灯管）/ dark 0.15 / pitch 0.05。
- 理智扭曲时（见 2.5）对嗡鸣做 playbackRate 漂移 + 增益 LFO。

### 2.2 环境底噪（每层不同）
- 程序化噪声：生成 2s 白噪声 buffer → BiquadFilter 低通成形（颜色由层级 DNA 决定）。
- `dna.soundscape.ambient[]` 是中文描述数组（如 "荧光灯持续嗡鸣"、"管道滴水"、"远处脚步声"）——
  按数组元素数分配噪声层数（1-3 层），每层不同滤波/调制：
  - 嗡鸣类 → 低通 + 慢 LFO
  - 滴水类 → 随机间隔的短促高频滴答（振荡器 1500Hz + 快速衰减）
  - 风声类 → 带通噪声 + 大 LFO
  - 脚步类 → 低频噪声脉冲（节奏随机，暗示"远处有人"）
  - 无 ambient 数据 → 默认为一层暗噪声（pitch/dark 层加大）
- 层级切换：新旧音景交叉淡入淡出 2s。

### 2.3 脚步声
- 走：40Hz 噪声脉冲 + 短促低频正弦（80Hz 衰减 0.08s），音量 0.15，节奏慢（间隔 0.45s）。
- 跑：同素材，音量 0.25，间隔 0.22s，叠加一层摩擦噪声。
- 潜行（sneak）：不发声（由调用方决定是否调用）。
- 音量随地面（水格更闷）——可简化：调用方传 water 标志。

### 2.4 突发音效（startles）
- `dna.soundscape.startles[]` 描述数组 → 每种合成一个程序化音效：
  - "敲门声" → 两声低闷响（60Hz + 噪声，0.15s 间隔）
  - "远处脚步声" → 低频噪声脉冲 x3（渐近）
  - "突然寂静" → 全体增益骤降 1.5s 后恢复（audio ducking，配合 silenceEvents）
  - "墙壁刮擦" → 带通噪声（800Hz）慢扫频
  - "低语" → 带通噪声（1kHz）+ 环形调制 LFO，音量极小
  - "金属碰撞" → 方波 220Hz 短促 + 噪声瞬态
  - 未匹配关键词 → 默认：噪声爆破 + 低正弦。
- 调用方式：app.js 在随机回合事件（world 的 ambient/startle 事件）时调用 `audio.startle(text)`（模块内部按关键词选合成器）；silenceEvents 层每 30-90s 自动触发一次 ducking。

### 2.5 理智扭曲（与 game 状态联动）
| 阶段 | 效果 |
|------|------|
| calm (>50) | 正常 |
| unsettled (30-50) | 嗡鸣 playbackRate ±3% 缓慢漂移；偶发 1 次低语 |
| fear (15-30) | 嗡鸣 ±8% 漂移 + 增益 LFO 0.5Hz；噪声层 +3dB；偶发假脚步声（音量小） |
| collapse (<15) | 嗡鸣 ±15% 漂移 + 相位感（两个失谐振荡器拍频）；噪声 +6dB；随机刺耳瞬态 |
- `onSanityStage(stage)` 由 app.js 在理智跨阶段时调用。

### 2.6 心跳（危险实体靠近）
- 60Hz 双脉冲（"咚-咚"），间隔 0.8s；激活时循环，关闭即停。
- app.js 在实体阶段检测到 hostile 实体距离 <6 时调用 `onHeartbeat(true)`，否则 false。

### 2.7 卡出/门/受击
- 卡出（onExit）：白噪声爆破（0.3s，低通扫频 4kHz→200Hz）+ 正弦滑音（300→80Hz）。
- 门（onDoor）：门轴吱呀（带通噪声 600Hz 扫频 + 低频吱呀 90Hz 颤音）+ 轻微空间感（convolver 短混响或用延迟 0.03s 反馈 0.2）。
- 受击（onHit）：60Hz 正弦衰减 + 噪声瞬态，0.2s。

## 3. 实现约束
- 纯 Web Audio API：OscillatorNode / AudioBufferSourceNode / BiquadFilterNode / GainNode / AudioBuffer（噪声预生成）。
- **禁用**：外部音频文件、AudioWorklet（保持兼容简单）、任何网络请求。
- 所有节点在 `setMuted(true)` 时静音（master gain 0），`false` 恢复。
- AudioContext 在首次用户手势（pointerdown/keydown）时创建（浏览器自动播放策略）。
- 总输出经 master GainNode（音量 0.8），再经 CompressorNode 防爆音。
- 代码结构：每类声音一个工厂函数 + 一个"音景管理器"（层级切换时停止旧节点）。
- 保留所有节点引用以便停止：`stopAll()` 内部调用。

## 4. 接入点（app.js 需要改动的部分）
1. `import { initAudio, ... } from './audio.js'`。
2. 首次 pointerdown/keydown → `initAudio()`（在现有 keydown/pointer 处理器里加一行）。
3. `rebuildVisuals()` 或层级切换处 → `setLevelSound(game.levels[game.levelId])`。
4. doAction/step 后检查事件：事件 text 含"脚步声/咔哒/刮擦/低语/水滴"等 → `startle(text)`；玩家移动成功 → `onPlayerMove(run)`；含"门"事件 → `onDoor()`；含"穿过"（卡出）→ `onExit()`；受伤事件 → `onHit()`。
5. 理智阶段变化检测（在 renderHud 或 endTurn 后比较阶段）→ `onSanityStage(stage)`。
6. 危险实体检测（每回合遍历实体，hostile 且距离<6）→ `onHeartbeat(bool)`。

## 5. 验收
- [ ] 进入 Level 0：能听到荧光灯嗡鸣 + 潮湿环境底噪
- [ ] 移动有脚步声；奔跑节奏更快
- [ ] 偶发突发音效（敲门/刮擦/低语）
- [ ] 理智低于 30：嗡鸣明显变调/失真；低于 15 更严重
- [ ] 危险实体靠近：心跳声
- [ ] 卡出/门传送/受击有对应音效
- [ ] 静音开关有效；层级切换音景平滑过渡
- [ ] 无任何外部资源请求（Network 面板零音频请求）
