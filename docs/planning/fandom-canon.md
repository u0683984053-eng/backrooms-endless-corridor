# Fandom 版还原对照表（Canon Reference）

> 目的：把"完全依照 Fandom 版"落实为可核对清单。游戏内所有命名、设定、行为以本表为基准；wiki 原文不直接使用（合规，见 risk-register R05），本表为团队内部参考。
> 版本：v0.2 ｜ 更新：随 Fandom 版本演变季度复核

## 1. 层级（首批 A 类，11 层）

| 游戏内编号 | 游戏内名称 | F 版条目名 | 核心还原点 | 数据文件 |
|-----------|-----------|-----------|-----------|---------|
| Level 0 | 教学关卡 | The Lobby | 黄色墙纸、潮湿地毯、荧光灯、6 亿平方英里 | level-0.json |
| Level 1 | 宜居地带 | Habitable Zone | 混凝土仓库、板条箱、据点感 | level-1.json |
| Level 2 | 管道梦境 | Pipe Dreams | 巨型管道、蒸汽、锈蚀 | level-2.json |
| Level 3 | 电气室 | Electrical Station | 发电机、配电柜、裸露电线、臭氧 | level-3.json |
| Level 4 | 废弃办公室 | Abandoned Office | 隔间、蒙尘电脑、散落文件 | level-4.json |
| Level 5 | 恐怖旅馆 | Terror Hotel | 红地毯、昏暗走廊、无数房门 | level-5.json |
| Level 0.1 | 入侵者的楼梯间 | The Interloper's Stairwell | 无尽楼梯、重复楼层、异门 | level-0.1.json |
| Level 11 | 无尽城市 | The Endless City | 街道网格、路灯、打烊商店、无昼夜 | level-11.json |
| Level 37 | 泳池天堂 | Poolrooms | 泳池群、白瓷砖、回声 | level-37.json |
| Level 3999 | 真核商场 | The True Hub | 商场、背景音乐、红色按钮→Level 0 | level-3999.json |
| Level -1 | 黑暗之地 | The Dark Place | 绝对黑暗、低语 | level--1.json |
| Level 6 | 灯灭 | Lights Out | 荧光灯全部熄灭、绝对黑暗、声音引敌 | level-6.json |
| Level 7 | 洪水 | Flooded Level | 走廊被齐腰深的水淹没、深海恐惧 | level-7.json |
| Level 8 | 洞穴系统 | Cave System | 无尽黑暗洞穴、滴水与回声 | level-8.json |
| Level 9 | 郊区 | Suburbia | 永恒黄昏、浓雾、空无一人的街道 | level-9.json |
| Level 10 | 田野 | The Fields | 无尽农田、白昼、相对安全 | level-10.json |
| Level 14 | 天堂 | Paradise | 绿草河流阳光、过于完美而令人不安、安全层 | level-14.json |
| Level 34 | 食堂 | Dining Hall | 无尽宴会厅、长桌烛台、食物永不腐坏 | level-34.json |
| Level 69 | 游乐园 | Carnivale | 旋转木马、摩天轮、小丑音乐、反常的快乐 | level-69.json |
| Level 404 | 错误页 | ERROR | 灰色机房、绿色终端、错误日志 | level-404.json |
| Level 666 | 地狱 | Hell | 焦黑走廊、高温盐霜、持续低吟 | level-666.json |
| 枢纽 | 枢纽 | The Hub | 紫色灯光、通往 0/1/2/3/4/5/11 的门、安全中转 | level-hub.json |
| Level ! | 跑 | Run For Your Life | 红色走廊、绿色 EXIT、派对客成群追击 | level-!.json |
| Level 33 | 地下室 | The Basement | 无尽黑暗潮湿地下室、锅炉、低矮天花板 | level-33.json |
| Level 52 | 航空母舰 | The Aircraft Carrier | 永不靠岸的航母、无发动机的飞机、瞭望塔外的另一艘航母 | level-52.json |
| Level 66 | 旅馆泳池 | The Hotel Pool | 恒温泳池、叠好的毛巾、舒服得让人不想走 | level-66.json |
| Level 90 | 停车场 | The Parking Lot | 无尽多层停车场、温引擎盖的空车、循环车位号 | level-90.json |
| Level 13 | 蓝色通道 | The Blue Channel | 蓝色荧光走廊、渗水的墙、比脚步慢半拍的回声 | level-13.json |
| Level 18 | 储物间 | The Storage Rooms | 无尽储物架、贴着标签的柜子、浮尘 | level-18.json |
| Level 922 | 温室 | The Greenhouse | 玻璃穹顶、疯长的植物、朝向你的向日葵 | level-922.json |

## 2. 实体（首批 11 种）

| 类型 | F 版名 | 行为还原要点 | 引擎实现（proto） |
|------|--------|-------------|------------------|
| moth | Moth | 被动、趋光、无害 | 被动游荡 |
| smiler | Smiler | 黑暗中出现、咧嘴笑、怕光 | 暗处追击、光退避 |
| hound | Hound | 听觉猎手、成群 | 噪音吸引、高速 |
| partygoer | Partygoers | 伪装友善、聚集、笑 | 亮处伏击 |
| skin-stealer | Skin-stealer | 剥皮伪装、仅特定条件可见 | 仅'查看'可见 |
| clump | Clumps | 群体聚合体、缓慢 | 高血低伤挡路 |
| faceling | Facelings | 类人、智力、多数中立 | 被动/低理智敌对 |
| watcher | Watchers | 远处注视、不主动近身 | 视线理智侵蚀 |
| duller | Dullers | 逐光、回避黑暗 | 光照吸引 |
| insanity | Insanity | 精神侵蚀类实体 | 相邻理智侵蚀 |
| scratcher | Scratchers | 潜伏、抓挠声 | 听觉猎手 |

## 3. 资源与物品

| 游戏内名 | F 版对应 | 效果（GDD §3.5） |
|---------|---------|-----------------|
| 杏仁水 | Almond Water | 理智 +25 / 生命 +15 |
| 皇家口粮 | Royal Ration | 体力 +20 |
| 医疗包 | Medkit | 生命 +40 |
| 电池 | Battery | 手电续航 |
| 手电 | Flashlight | 视野/驱退 |
| 撬棍 | Crowbar | 战斗/撬门 |
| 液体疼痛 | Liquid Pain（预留） | 负面物品 |
| 钥匙 | Key（预留） | 门锁机制 |

## 4. 组织与环境叙事

- **M.E.G.（探险者总署）**：以环境叙事出现（补给指示牌、广播、据点涂鸦），**不发布任务**。游戏内文案为原创改写。
- **前室（The Frontrooms）**：玩家来源，不可回归（除 Level 3999 红色按钮的"重启"隐喻）。
- **穿模（Noclipping）**：层级间移动核心机制，故障点视觉呈现（墙纸撕裂）。

## 5. 美学核类（F 版"核内美学"体系）

| 核类 | 代表层级 | 视觉基调 | 引擎滤镜 |
|------|---------|---------|---------|
| 怪核 Weirdcore | Level 0/3、Level -1 | 熟悉又怪异、荧光、低饱和黄 | 色相偏移+轻微色差 |
| 梦核 Dreamcore | Level 2/0.1 | 超现实宁静、柔光 | 柔光提亮 |
| 池核 Poolcore | Level 37 | 水、瓷砖、碧蓝 | 冷蓝白平衡+水光 |
| 伤核 Traumacore | Level 1/4/5 | 创伤暗示、冷、褪色 | 降饱和+暗角 |
| 商业核 Mallcore | Level 11/3999 | 商场霓虹、暖光、虚假繁荣 | 暖橙+霓虹点缀 |

## 6. 还原纪律

1. 新增层级/实体前必须在本表登记 F 版依据；无 F 版依据的原创内容标注"原创"。
2. 游戏内文本原创改写（禁止 wiki 原文直用）；F 版名保留（公共知识）。
3. 行为还原以 F 版条目描述为准，简化实现须在引擎注释标注"简化"。
4. 每季度对照 Fandom 更新复核一次（版本演化）。
