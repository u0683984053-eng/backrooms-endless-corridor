# 技术原型规格书 SPEC v1.0（M0 逻辑内核）

> 目标：验证《后室：无尽回廊》核心循环 —— 层级 DNA 确定性生成 + 生存三态（生命/理智/体力）+ 实体遭遇 + 卡出（Noclipping）+ 探索日志。
> 交付物：纯 JavaScript（ESM，零依赖）的引擎 + Node CLI + 浏览器网页端 + 冒烟测试。
> 数据源：`../data/levels/*.json`（11 个层级 DNA，已存在）；规格见 `../schemas/level-dna.schema.json`。

## 1. 硬性约束

- **纯 ESM JavaScript**，无 TypeScript、无 npm 依赖、无构建步骤。
- 引擎代码必须**双端共用**：Node（CLI）与浏览器（`<script type="module">`）都能 import。
- 引擎模块不得直接依赖 fs/fetch——**数据加载器在入口处注入**（见 §6）。
- 文件只能用 `write` 工具写入 `C:\Users\25072\AppData\Local\Temp\dsh-build\backrooms-labyrinth\proto\...`（绝对路径）。
  ⚠️ **严禁**写入 `C:\Users\25072\Documents` 下的任何路径（沙箱拒绝）；**严禁**用 pwsh 写文件。

## 2. 目录与文件

```
proto/
├─ engine/
│  ├─ rng.js        mulberry32 种子随机数 + hashString
│  ├─ dna.js        DNA 校验/默认值合并/层级注册表
│  ├─ generator.js  确定性程序化生成（房间+走廊+实体+物品+出口+setPieces）
│  ├─ entities.js   实体定义（属性+AI）与行动更新
│  ├─ player.js     玩家属性/状态/动作实现
│  └─ game.js       游戏主循环：回合制状态机、事件日志、胜负判定
├─ cli.js           Node CLI 前端（加载数据 + 渲染 + 命令解析）
├─ test.js          Node 冒烟测试（确定性/可达性/随机对局）
├─ server.js        Node 静态服务器（端口 4173，服务 proto/ 根目录，含数据目录）
└─ web/
   ├─ index.html    单页入口
   ├─ style.css     阈限空间美学样式
   └─ app.js        浏览器前端（canvas 渲染 + HUD + 日志 + 存档 localStorage）
```

## 3. 引擎 API 契约

```js
// rng.js
export function mulberry32(seed)      // -> () => [0,1)
export function hashString(s)         // -> uint32

// dna.js
export function normalizeDna(raw)     // 合并默认值，返回完整 DNA
export async function loadLevels(loader) // loader = { readFile(path)->string } 或 { fetch(path)->Promise<string> }

// generator.js
export function generateLevel(dna, runSeed)
// 返回 Level：
// { id, name, width, height, tiles: string[][], spawn:{x,y},
//   exits:[{x,y,target,kind,hidden,danger,description}],
//   entities:[{x,y,type,aggression}], items:[{x,y,type}],
//   setPieces:[{x,y,type,text,sanityEffect,note}], palette, light,
//   spaceRules, sanDrain, soundscape }
// 确定性：同 (dna.id, runSeed) 必须产出完全相同的 Level（test.js 验证）

// entities.js
export const ENTITY_DEFS = { ... }   // 每种实体的 {name,hp,dmg,aggro,sight,hears,speed,behavior,desc}
export function updateEntity(e, world) // world 提供查 LOS/距离/玩家状态

// player.js
export function createPlayer(x,y)
export function applyPlayerAction(state, action, world) // 返回事件数组

// game.js
export function createGame({levels, seed}) // -> state
export function step(state, action)        // -> {events:[...], over:false|'dead'|'assimilated'}
export function playerVisibleTiles(state)  // 视野内瓦片（供渲染）
```

## 4. 瓦片与生成规则

- 瓦片字符：`#`墙、`.`地板、`~`水、`D`门、`S`楼梯、`E`出口点（卡出点）、`I`物品、`P`玩家（运行时）。
- 生成算法：
  1. 按 DNA `terrain` 放置房间矩形（不重叠），走廊 L 形连接，保证全连通（BFS 验证）。
  2. `spaceRules` 含 `looping`：边界环绕（移动与视线 wrap）；含 `non-euclidean`：放置 2-4 对传送门瓦片（镜像错位）。
  3. 环境 `aquatic`：房间内铺设水瓦片池；`outdoors`：街区网格 + 宽阔街道。
  4. 实体按 `density × 可行走格数` 放置（至少 1 只，密度>0 时）；远离出生点。
  5. 物品按 `itemDensity` 放置（`items` 表内随机类型）。
  6. 出口：每个 DNA exit → 一个 `E` 瓦片（隐藏出口仅在 `search` 后显示）；`button` 类型是特殊出口（Level 3999 红色按钮，必达）。
  7. setPieces 放置到指定位置（center/random/far-corner 对应生成区域），携带 text/note/sanityEffect。
- **可达性保证**：生成后 BFS 出生点→每个出口；失败则用备用种子重试（最多 8 次）。

## 5. 实体规格（Fandom 风格，简化实现）

| type | hp/dmg | 行为 | 感知 | 备注 |
|------|--------|------|------|------|
| moth 飞蛾 | 10/0 | 被动游荡 | 无 | 无威胁，触碰 -1 理智 |
| smiler 笑魇 | 60/15 | 黑暗中出现，LOS 追击 | sight 5，怕光 | 手电/亮瓦片内不追击 |
| hound 猎犬 | 50/12 | 声音吸引，高速追击 | hears：噪音 3 格内 | 奔跑会引它 |
| partygoer 派对客 | 70/18 | 亮处伏击 | sight 4 | 伪装友善，靠近即攻 |
| skin-stealer 皮行者 | 40/20 | 仅'查看'时可见 | 无 sight | 近身伏击 |
| clump 团块 | 120/10 | 缓慢游荡，挡路 | sight 2 | 高血低伤 |
| faceling 假面 | 30/8 | 被动；被打/低理智时敌对 | sight 3 | 城市居民 |
| watcher 注视者 | 50/5 | 远处注视，LOS 内每回合 -4 理智 | sight 6 | 不近身 |
| duller 电灯 | 45/10 | 被光照吸引（玩家开手电时追） | sight 5(光) | 黑暗中不主动 |
| insanity 疯狂 | 20/10 | 相邻 -5 理智/回合 | sight 2 | 攻击时玩家反噬理智 |
| scratcher 抓挠者 | 55/14 | 听觉猎手，潜伏 | hears 2 | 靠近才暴露 |

战斗：玩家徒手 5-10，撬棍 20-30（体力消耗 20/次）；实体攻击玩家 -dmg 生命，部分实体额外 -理智。

## 6. 玩家与状态

- 属性：hp 100 / sanity 100 / stamina 100；回合经济：移动 1 体力、奔跑 2 体力(2格)、战斗 20、搜索 2、休息回复。
- 理智阶段：>50 平静；30-50 不安（随机假消息/假实体闪现）；15-30 恐惧（噪音/视觉失真标志）；<15 崩溃（随机失控行动）；0 → `assimilated` 死亡。
- 理智恢复：杏仁水 +25（同时 hp+15）、光亮处休息 +8、安全层（sanDrain<=0.03 且 light=bright）每回合 +1。
- 物品：almond-water/royal-ration/battery/flashlight/crowbar/medkit/note/key/liquid-pain（后两者预留）。
- 手电：默认关闭；开启时视野半径 +2、Duller 被吸引、Smiler 退避；每 20 回合耗 1 电池，无电池自动熄灭。
- 探索日志：自动记录到达层级/出口发现/文档（setPieces.note）；玩家可添加个人笔记；日志跨轮持久（CLI 存档文件、Web localStorage）。

## 7. 前端规格

### CLI（node cli.js）
- 命令：`w/a/s/d`移动、`shift+方向`或`run <dir>`奔跑、`look`查看周围、`search`搜索相邻、`take`拾取、`use <item>`、`rest`休息、`fight`战斗、`sneak`潜行切换、`light`手电开关、`exit`/`noclip`使用出口、`log`日志、`note <文本>`笔记、`map`地图、`help`、`quit`。
- 渲染：可见半径 ASCII 地图 + 状态栏（HP/SAN/STA）+ 事件日志；理智<30 时字符随机抖动/替换。

### Web（web/）
- canvas 2D 俯视渲染：瓦片色来自 DNA palette（墙/地/水/门），迷雾（fog of war）只显示已探索瓦片，视野内实体/物品/出口图标化；`flickering` 层级灯光明暗动画；`pitch` 层级视野收窄。
- HUD：三态进度条 + 当前层级名/难度 + 物品栏；日志面板；日志/地图弹窗；层级过渡遮罩（"你穿过了故障的墙壁……"）；死亡结算（存活回合/发现层级/死因/Codex 新增）。
- 理智视觉：<30 时 CSS filter 抖动/噪点/色偏；<15 时叠加假实体闪烁。
- 控制：WASD/方向键移动，E 交互/搜索，F 手电，空格休息，J 日志，M 地图，H 帮助，X 卡出（使用出口）；触屏按钮（可选）。
- 持久化：localStorage 保存 Codex（发现层级/笔记/死亡记录）与当前轮存档。
- 纯原生 JS/CSS，**禁止**引入任何外部库。

## 8. 冒烟测试（test.js，node 运行，全部通过才交付）

1. **确定性**：同 (levelId, seed) 生成两次 → 布局哈希一致；不同 seed → 大概率不同。
2. **可达性**：11 个层级 × 5 个种子：出生点 BFS 可达至少 1 个出口；所有实体/物品在网格内。
3. **密度**：实体数在 (0, width×height×density×3] 内；物品数 >0（itemDensity>0 时）。
4. **随机对局**：随机动作模拟 300 回合不死机（允许死亡，死亡后正常结束）。
5. **循环层**：looping 层级边界移动不越界。

## 9. 验收顺序

引擎 → CLI → test.js 全绿 → web → server.js → 手工体验清单：
- [ ] 从 Level 0 出生，找到隐藏卡出点进入 Level 1
- [ ] 理智被侵蚀后饮用杏仁水恢复
- [ ] 遭遇猎犬：奔跑引来 vs 潜行绕过
- [ ] Level 3999 红色按钮 → 回到 Level 0（日志保留）
- [ ] 死亡 → 结算页 → Codex 记录本次发现
