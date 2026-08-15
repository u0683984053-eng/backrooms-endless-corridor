# 《后室：无尽回廊》资产管线（Asset Pipeline）

> 版本：v0.2 ｜ 状态：草案 ｜ 依据：`docs/gdd-v0.2.md` §4.4、§5.1、§6.1；`schemas/level-dna.schema.json`（terrain.wallStyle/floorStyle、aesthetic）
> 目标：以 2-3 名 3D/TA 的产能，在 48 个月内支撑 A(40)+B(250)+C(无限) 的内容模型——**靠模块化 + AI 辅助 + 程序化组装，不靠手搓单层资产。**

---

## 1. 目标与原则

| 原则 | 说明 |
|------|------|
| 模块化优先 | 资产按"模块"生产，层级 = 模块组合，禁止单层专属资产（A 类除外） |
| 风格驱动 | 资产库按核类美学维度组织，DNA 的 `aesthetic` 直接决定取用范围 |
| 复用率指标 | 单资产至少被 3 个层级引用；A 类专属资产须显式立项 |
| 程序化组装 | 资产只提供"零件"，摆放由 PCG（L2）完成，人工只做 A 类装配 |

**关键指标（验收）**：1.0 时资产库覆盖率 ≥ 90% 的 DNA 风格组合；每层级平均资产引用 ≥ 30 个模块。

---

## 2. 模块化资产库规模（1.0 目标）

| 模块类别 | 目标数量 | 说明 | 优先级 |
|----------|---------|------|--------|
| 地板 floor | 50+ | carpet/tile/linoleum/concrete/grass/water/gravel/wood 全风格 | P0 |
| 墙壁 wall | 50+ | wallpaper/tile/concrete/metal/brick/glass/drywall 全风格 | P0 |
| 天花板 ceiling | 30+ | 含灯槽/管道/裸露板 | P0 |
| 房间布局 room layout | 100+ | 房间模板（形状+内装组合），B/C 类生成主料 | P0 |
| 走廊布局 corridor | 50+ | 直/折/T 型/环形走廊模块 | P0 |
| 家具 furniture | 200+ | 桌/椅/床/货架/柜/柜台等，按风格分组 | P1 |
| 照明 lighting | 50+ | 荧光灯管/壁灯/闪烁灯/应急灯/蜡烛 | P0 |
| 杂物 clutter | 100+ | 纸张/瓶子/箱子/电线/管道/积水贴片 | P1 |
| 交互物 interactive | 30+ | 门/按钮/电梯/梯子/可拾取物 | P0 |
| **set piece 组件库** | **200+** | 怪诞房间/墙上文字/孤物/尸体/壁画/祭坛/石碑/电梯（v0.2 立项） | **P0** |
| 实体 entity | 50+ | 骨架+材质变体，含动画状态机 | P0 |

> **产能换算**：核心 P0 集（地板/墙/顶/照明/交互/set piece）约 460 个模块，按 AI 辅助管线 1.5-3 人日/模块，约 3 人 × 18-24 个月完成——与 M1 EA 时间点对齐（见 `milestones.md`）。

---

## 3. AI 辅助工作流（四步）

```
① Midjourney 概念   →  ② AI 3D 批量建模   →  ③ Blender 减面/展UV   →  ④ UE5 组装
```

### 3.1 概念（Midjourney / Stable Diffusion）

- 输入：风格板（核类美学 moodboard：怪核/梦核/池核/伤核/商业核）+ 参考图 + 规格卡（尺寸/用途）。
- 输出：2-4 张概念图 + 正/侧/顶三视图，供建模对齐。
- 门禁：概念未过 TA 审（风格符合、拓扑合理）不得进入下一步，避免废模。

### 3.2 AI 3D 建模（Meshy / Tripo / 混元 3D）

- 以概念图生成粗模；**批量任务**按风格批次提交（同风格同参数），降低返工率。
- 工具选型：Meshy 主用（文/图生模），Tripo 用于复杂结构补模，混元 3D 作为国内合规备份。
- 产出标准：粗模面数不限（下一步统一减面），但拓扑须闭合、无破面、比例正确。

### 3.3 Blender 减面 / 展 UV / 烘焙（TA 环节）

- 减面：按资产用途定面数上限（见 §7 预算表），A 类近距离资产 5k-10k 面，C 类远景可 500-2k 面。
- 展 UV：统一 texel 密度（1024px/m 为基准），复用材质贴图集（atlas）。
- 烘焙：法线/粗糙度/AO 烘焙到低模；光照贴图按 UE5 规格出。
- **检入门禁**：此步是质量闸门，未过验收清单（§5）不得进 Perforce。

### 3.4 UE5 组装

- 导入后配置碰撞、LOD（3 级）、Nanite 开关（高面数资产走 Nanite）、ISM 兼容性标记。
- 组装房间布局模板：把模块拼成 room layout / set piece 组合件，标好锚点（`PCG_Anchor`）。
- 写资产元数据：`style` 标签（aesthetic）、`dnaTag`（wallStyle/floorStyle 过滤键），供 PCG L2 检索。

---

## 4. 命名规范

**统一格式：`模块类型_风格_编号[_变体]`（全部小写下划线）**

| 段 | 取值示例 | 说明 |
|----|---------|------|
| 模块类型 | floor / wall / ceiling / room / corridor / furniture / light / clutter / interactive / setpiece / entity | 固定枚举 |
| 风格 | wallpaper / tile / carpet / concrete / metal / brick / glass / drywall（墙）；对应地/顶/家具各自枚举 | 对应 DNA 枚举值 |
| 编号 | 001-999 | 同类型内递增，禁止重排 |
| 变体（可选） | _a / _b / _worn（磨损）/ _lit（点亮） | 材质变体 |

示例：

```
floor_carpet_012_worn        // 磨损地毯地板 012
wall_wallpaper_034           // 墙纸墙 034
setpiece_writing_007         // 墙上文字 set piece 007
light_fluorescent_015_lit    // 荧光灯管 015（点亮变体）
```

> **强制约束**：资产命名即检索键。命名与 DNA 枚举不一致的资产，PCG 检索不到 = 视为不存在，CI 会对"DNA 引用缺失资产"报错。

---

## 5. 资产验收清单（检入 Perforce 前逐项打勾）

| # | 检查项 | 判定 |
|---|--------|------|
| 1 | 命名符合 §4 规范 | 硬性 |
| 2 | 面数/texel/LOD 满足预算表（§7 tech-notes） | 硬性 |
| 3 | 碰撞体正确（实体可走、玩家可过、无穿模缝隙） | 硬性 |
| 4 | 三视图对位、比例与场景单位一致（1u=1cm） | 硬性 |
| 5 | 材质引用有效、无 missing texture | 硬性 |
| 6 | style/dnaTag 元数据已填写 | 硬性 |
| 7 | 参考概念图对比留存（可追溯） | 建议 |
| 8 | 已在 3 个代表性 DNA 模板中试生成无冲突 | 建议（B/A 类资产） |
| 9 | 无 Fandom wiki 原文贴图/文本（合规，见 GDD §9） | 硬性 |

CI 自动化检查 1/2/3/5/6/9；人工抽检 4/7/8。

---

## 6. Perforce 版本管理

| 项 | 规范 |
|----|------|
| 目录 | `//depot/backrooms/assets/{floor,wall,ceiling,room,corridor,furniture,light,clutter,interactive,setpiece,entity}/{style}/` |
| 检入粒度 | 一个模块 + 其材质/贴图/元数据为一个 changelist，附 `#dna: style=weirdcore, wall=tile` 提交说明 |
| 分支 | main（可出包）← dev（日常）← feature/{资产批次}；每批风格资产独立 feature 分支 |
| 锁定 | UE5 资产检入前先 checkout（binary 锁），禁止同资产并发编辑 |
| 集成 | 每周 dev→main 集成 + 冒烟测试；发版打 label |
| 清理 | 未验收资产放 `//depot/backrooms/wip/`，进不了打包路径 |

---

## 7. 与 DNA 字段的映射表

DNA 字段（schema）决定资产检索，资产元数据反向决定生成结果：

| DNA 字段 | 检索键 | 资产池 | 备注 |
|----------|--------|--------|------|
| `terrain.wallStyle` | `wall_{wallStyle}_*` | 墙壁模块 | 8 种枚举全覆盖为 P0 |
| `terrain.floorStyle` | `floor_{floorStyle}_*` | 地板模块 | 8 种枚举全覆盖为 P0 |
| `terrain.extraFeatures` | `clutter_*` / `interactive_*` / `light_*` | 管道/电线/门/窗/喷泉/货架等 | 按特性组合取用 |
| `aesthetic`（核类美学） | `style` 标签 | 全库按风格过滤 | 决定氛围统一性 |
| `light` | `light_*` 含 `_lit` 变体 | 照明模块 | `flickering` 需闪烁组件资产 |
| `setPieces[].type` | `setpiece_{type}_*` | set piece 组件库 | 8 种类型，1.0 前 ≥ 200 件 |
| `entities[].type` | `entity_{type}_*` | 实体骨架+材质 | 50+ 骨架 |
| `palette.*` | 材质实例参数 | 同资产换色 | 减少独立资产数量 |

**执行规则**：PCG L2 取资产 = `AND(墙/地枚举, aesthetic 标签, 类型)`；命中为空 → 生成报错进 CI 队列，不静默用别的风格顶替。

---

## 8. 产能与排期锚点

| 阶段 | 资产产出目标 | 依赖 |
|------|-------------|------|
| M0（0-6 月） | 3 个 A 类层所需资产（墙纸/地毯/荧光灯最小集 + 定制 set piece 15-30 件） | 概念风格板冻结 |
| M1 EA（18-24 月） | P0 集全量（约 460 模块）+ B 类模板所需 60% | AI 建模批次稳定 |
| M2（30-36 月） | P1 集（家具/杂物）补齐 + set piece 库 150+ | 社区导入内容反哺风格 |
| M3 1.0（40-48 月） | 全库目标数 + 策展掉落所需变体 | 月度策展反馈 |

> 配套：每批资产进库后须跑一次"3 个 DNA 模板试生成"回归（验收清单第 8 项），防止资产入库即污染生成结果。

---

## 9. 风险与对策

| 风险 | 对策 |
|------|------|
| AI 建模质量不稳定 | 概念门禁（§3.1）+ 批量同参数 + TA 减面兜底 |
| 资产风格漂移（aesthetic 混乱） | 风格板版本化 + 每周风格评审 + CI 元数据检查 |
| set piece 库产能不足 | 定为 P0 优先级，复用 A 类层定制组件反哺库 |
| 合规贴图/文本混入 | 验收清单第 9 项硬性 + Perforce 提交扫描钩子 |
