# 《后室：无尽回廊》Backrooms: Endless Corridor

> 一款以后室（The Backrooms）Fandom 版世界观为核心的**开放世界生存探索游戏**。
> 你不是在"通关"后室，而是在"居住"在后室里。

**当前状态**：设计阶段（GDD v0.2）+ M0 技术原型（可玩）。

## 项目结构

```
backrooms-labyrinth/
├─ docs/
│  ├─ design-review.md           设计书评审报告（v1.0 → v0.2 的修订依据）
│  ├─ gdd-v0.2.md                游戏设计文档 v0.2（当前权威版本）
│  ├─ architecture/
│  │  ├─ pcg-architecture.md     程序化生成架构（两级生成 + set piece 锚定）
│  │  ├─ asset-pipeline.md       资产管线（模块化 + AI 辅助工作流）
│  │  └─ tech-notes.md           技术要点（确定性/持久化/音频/QA）
│  └─ planning/
│     ├─ milestones.md           里程碑（M0→EA→1.0）与预算
│     └─ risk-register.md        风险登记册（14 项）
├─ schemas/
│  └─ level-dna.schema.json      层级 DNA v0.2 JSON Schema（生成器契约）
├─ data/
│  └─ levels/                    11 个示例层级 DNA（Level 0/1/2/3/4/5/0.1/11/37/3999/-1）
├─ proto/                         M0 技术原型（可玩）
│  ├─ SPEC.md                    原型规格书
│  ├─ engine/                    确定性生成引擎 + 核心循环（纯 ESM，零依赖）
│  ├─ cli.js                     终端版（node cli.js）
│  ├─ test.js                    冒烟测试（node test.js）
│  ├─ server.js                  网页版静态服务（node server.js → http://127.0.0.1:4173）
│  └─ web/                       浏览器版（canvas 渲染 + HUD + 存档）
└─ scripts/
   ├─ watchdog.ps1               会话挂起监控（开发辅助，勿删）
   └─ serve.ps1                  旧版启动脚本（8080）
```

## 快速开始（原型）

**在线版（GitHub Pages）**：https://u0683984053-eng.github.io/backrooms-endless-corridor/proto/web/

```powershell
# 终端版
node proto\cli.js

# 网页版（本地）
node proto\server.js
# 浏览器打开 http://127.0.0.1:4173/
```

游戏方式：在 Level 0 出生 → 移动探索（WASD）→ 搜索隐藏卡出点（闪烁的墙）→ 进入 Level 1
→ 喝杏仁水维持理智 → 被猎犬追就跑或潜行 → 找到 Level 3999 的红色按钮 → 回到起点但日志保留。
死亡 = 本轮结束，但 Codex（跨轮行记）永久保存你的发现。

## 核心设计决策（v0.2）

1. **三层内容模型**：A 手工核心层（30-40，博物馆级）+ B 策展生成层（200-300）+ C 野性生成层（无限）——替代"4000 手作层级"。
2. **Set Piece 铁律**：程序化只生成背景板，恐怖由手作场景锚点负责。
3. **死亡 + Codex 闭环**：永久死亡；行记跨轮持久——输掉身体，赢得知识。
4. **确定性生成 + 世界持久化**：`层级ID + 种子 → 布局`，存档只存 delta。
5. **理智系统**：四阶段（平静/不安/恐惧/崩溃），幻觉内容库是正式内容品类。
6. **三通道感知**：光线/声音/视线——潜行玩法的基础。
7. **单人 1.0** + UGC 四阶段（只读导入 → 编辑器 v1/v2 → 策展掉落）。
8. **合规先行**：CC BY-SA 署名策略 + 游戏内文档原创改写。

## 里程碑

| 阶段 | 时间 | 交付 |
|------|------|------|
| M0 原型 | 0-6 月 | 核心循环 + DNA 工具 + 3 个 A 类层（**本仓库 proto/ 即其逻辑内核**） |
| M1 EA | 18-24 月 | Steam 抢先体验：100-150 层级 + 全系统 + Codex + 社区只读导入 |
| M2 | 30-36 月 | 300-500 层级 + 编辑器 v1 + 月度策展掉落 |
| M3 1.0 | 40-48 月 | A40 + B250 + C 无限 + 创意工坊 |

## 技术栈

Unreal Engine 5 ｜ Blender/Maya ｜ Meshy/Tripo/混元 3D（AI 建模）｜ UE5 PCG ｜ Wwise（程序化音频）｜ Perforce

（M0 原型为验证逻辑内核，使用零依赖纯 JS：Node CLI + 浏览器 canvas，确定性生成算法后续平移至 UE5。）

## 注意事项

- **Fandom wiki 内容为 CC BY-SA 3.0**：商业衍生需署名与同许可策略，法务咨询前置（见 risk-register R05）。
- 本仓库 proto/ 目录中的层级文本均为**原创改写**，未直接使用 wiki 原文。
