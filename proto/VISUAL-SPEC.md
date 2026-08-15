# 视觉还原与场景呈现规格 VISUAL-SPEC v1.0

> 目标：网页端场景**精密、有美感、完全依照 Fandom 版后室**。
> 原则：Fandom 还原是"内容正确性"，视觉精密度是"呈现质量"——两者都是验收项。
> 适用：`proto/web/`（app.js / style.css / index.html）。

## 1. Fandom 还原验收清单（每层强制核对）

| 层级 | F 版要点 | 必须呈现 |
|------|---------|---------|
| Level 0 | 黄色墙纸、潮湿地毯、荧光灯、六亿平方英里空房间 | 黄墙纸纹理、地毯噪点、灯管闪烁、无尽感（循环空间） |
| Level 1 | 仓库、混凝土柱、板条箱、宜居据点 | 柱列、板条箱堆、较亮的暖光、相对整洁 |
| Level 2 | 巨型管道、蒸汽、锈蚀 | 管道占墙、蒸汽粒子（升腾白雾）、暗红点缀 |
| Level 3 | 发电机组、配电柜、裸露电线、臭氧 | 机器轮廓、火花闪烁、灯光明暗不稳 |
| Level 4 | 办公隔间、蒙尘电脑、文件 | 隔间墙、桌子轮廓、冷光、灰尘粒子 |
| Level 5 | 红地毯、昏暗走廊、无数房门 | 红地毯、门列、暖黄暗灯、走廊纵深 |
| Level 0.1 | 无尽楼梯间、同样楼层、异门 | 楼梯符号、重复层错觉、回声感 |
| Level 11 | 无尽城市、路灯、打烊商店、无昼夜 | 街道网格、路灯光晕、玻璃反光 |
| Level 37 | 泳池群、碧蓝水、白瓷砖、回声 | 水波动画、瓷砖反光、蓝色调、光斑 |
| Level 3999 | 商场、音乐、暖光、红色按钮 | 商铺招牌色块、暖光、中央红色按钮高亮 |
| Level -1 | 绝对黑暗、只有黑暗与低语 | 近乎全黑、视野收窄、微光颗粒 |

- 层级描述文本（进入时的展示文字）必须与 `data/levels/*.json` 的 description 一致（原创改写，已合规）。
- 实体视觉形象按 F 版设定：smiler=黑暗中的咧嘴白牙、hound=四肢着地的黑影、partygoer=夸张笑脸、skin-stealer=无脸人形、clump=蠕动的黑色团块、faceling=正常脸但"不对"的人、duller=发光的人形灯泡、watcher=远处静止的人影、moth=飞动的小亮点。

## 2. 渲染层规格（canvas 2D）

### 2.1 程序化纹理（离屏 canvas 预渲染，瓦片级缓存）
- `wallStyle` → 墙纹理：wallpaper（竖条纹+污渍斑点）、tile（勾缝网格）、concrete（裂纹+斑点）、metal（横向拉丝+铆钉）、brick（砖块排布）、glass（透明+高光）、drywall（平整+轻微噪点）。
- `floorStyle` → 地纹理：carpet（细噪点+暗纹）、tile（棋盘格/勾缝）、linoleum（纯色+光泽条）、concrete（噪点）、water（波光动画）、wood（木纹）、grass/gravel（点阵）。
- 纹理尺寸 32-64px 瓦片，绘制前按瓦片类型缓存到 Map，避免每帧重复生成。

### 2.2 灯光体系
- 基础光：DNA `light` 决定全局亮度基调（bright/dim/dark/flickering/pitch 五档，各配亮度系数与色温）。
- 灯光色：DNA `palette.light` 作为光照 tint。
- 玩家光：手电开启 → 径向渐变（暖白），半径 +2；关闭 → 微弱环境光。
- flickering：全局亮度按时间随机骤降（0.3-0.5s 周期 + 随机"熄灯"事件，Level 3 有 2 秒全黑）。
- pitch（Level -1）：视野半径收窄到 3，仅手电光锥可见，周围近黑。
- 迷雾：fog of war——未探索瓦片全黑，已探索但不在视野的瓦片降饱和 40% + 暗化 60%。

### 2.3 每层美学核类（CSS 滤镜 + 调色，DNA `aesthetic` 驱动）
- weirdcore：色相偏移 +2%、饱和 +10%、轻微色差（chromatic aberration 用 canvas 重绘偏移）。
- dreamcore：柔光（blur 0.3px + 提亮）、粉白调。
- poolcore：冷蓝白平衡、水面高光闪烁。
- traumacore：降饱和 30%、偏冷、暗角加深。
- mallcore：暖橙、霓虹色点缀、轻微泛光。
- 默认：F 版原色（黄绿米、低饱和）。

### 2.4 道具呈现（DNA `terrain.extraFeatures`）
- counters/shelves/columns/furniture/doors/windows/fountain/pipes/wires/puddles/stairwell/elevator 每种一个手绘矢量造型（canvas path），放置时按瓦片绘制。
- 摆放规则：靠墙/角落优先，不阻挡路径（生成器已保证）。

### 2.5 氛围层（每帧叠加）
- 暗角 vignette（径向渐变，理智越低越重）。
- 胶片颗粒 noise（预生成 3 帧噪声 canvas 轮播，alpha 随理智降低升高）。
- 尘埃粒子（20-40 个缓慢漂移的半透明点，flickering 层额外有灯下尘埃束）。
- 蒸汽粒子（Level 2/工业层：从管道口上浮的白雾团）。
- 水波高光（Level 37/aquatic：水瓦片周期性光斑）。

## 3. 理智视觉层（与 game.js 状态联动）
- <30 恐惧：CSS filter: saturate(0.85) hue-rotate(-4deg) + 噪声 alpha 提升 + 画面轻微抖动（transform translate 随机 ±1px）。
- <15 崩溃：额外叠加假实体闪烁（随机位置闪现 smiler 剪影 80ms）+ 屏幕边缘红色脉动。
- 幻觉事件：log 面板闪现假消息（"身后有脚步声"）后 1.5s 消失。

## 4. 交互呈现
- 卡出点（E 瓦片）：墙纸位置周期性"撕裂"闪烁（alpha 抖动 + 像素错位），hidden 出口未搜索前不可见（search 后出现提示标记）。
- 过渡遮罩：进入新层级 → 全屏故障效果（scanline + 色偏 + 抖动 0.6s）→ 层级名 + 难度 + description 打字机展示。
- 死亡结算：暗化 + 血丝/噪点 + 结算面板（存活回合/发现层级/死因/Codex 新增）。

## 5. 验收
- [ ] 11 层各截一帧：纹理、灯光、道具、核类滤镜四项全部到位
- [ ] flickering 层肉眼可见灯管闪烁；pitch 层视野收窄
- [ ] 手电开关改变光照与 duller/smiler 行为（渲染与逻辑联动）
- [ ] 理智 <30 时画面失真可见；<15 时假实体闪现
- [ ] 卡出过渡遮罩完整；死亡结算面板完整
- [ ] 全程无外部库、无网络依赖、60fps（普通桌面）
