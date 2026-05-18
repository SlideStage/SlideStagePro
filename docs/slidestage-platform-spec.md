# `.stage` 平台开发规范 v1.0

> **面向对象：自建演示平台（slidestage Platform）的后端 / 前端开发者。**
>
> 本文档定义 `.stage` 包的物理格式、`manifest.json` schema、平台 runtime 必须实现的能力契约、批注协议、版本兼容策略和错误处理规范。读完这份文档你应该能够：(1) 在后端实现稳健的上传 / 解压 / 索引流水线；(2) 在前端实现 PowerPoint 级的演讲 runtime（导航 / 演示工具 / 批注同步）；(3) 设计向后兼容的 schema 演进策略。
>
> **配套生成端**：`scripts/pack_deck.mjs`（producer）。本文档完整描述 producer 产出的格式契约。**平台是 consumer**——只要按本文档实现，所有未来版本的 `pack_deck.mjs` 产出都能在你平台上跑。

---

## 目录

1. [设计哲学：为什么是 slidestage](#1-设计哲学为什么是-slidestage)
2. [包格式：`.stage` zip 的物理布局](#2-包格式slidestage-zip-的物理布局)
3. [`manifest.json` schema v1.0 完整规范](#3-manifestjson-schema-v10-完整规范)
4. [Slide 架构类型枚举](#4-slide-架构类型枚举)
5. [平台后端：上传 / 校验 / 解压 / 索引](#5-平台后端上传--校验--解压--索引)
6. [平台前端：渲染 + iframe sandbox 策略](#6-平台前端渲染--iframe-sandbox-策略)
7. [演示工具九件套：行为规范](#7-演示工具九件套行为规范)
8. [批注协议：stroke 数据结构 + 后端同步](#8-批注协议stroke-数据结构--后端同步)
9. [Speaker Notes 与 Speaker View](#9-speaker-notes-与-speaker-view)
10. [缩略图与 Overview](#10-缩略图与-overview)
11. [导航 API（推荐）](#11-导航-api推荐)
12. [版本协商与兼容策略](#12-版本协商与兼容策略)
13. [错误处理与降级](#13-错误处理与降级)
14. [测试包与参考实现](#14-测试包与参考实现)
15. [附录：常见问题与术语表](#15-附录常见问题与术语表)

---

## 1. 设计哲学：为什么是 slidestage

### 1.1 内容 vs 运行时分离

传统 deck（PPTX / Keynote / 单 HTML 文件）把**内容**（文字 / 视觉 / 排版）和**运行时**（导航 / 演示工具 / 批注 / 持久化）打成一坨。后果是：演示工具升级要重做所有 deck，演示工具下线了 deck 也跟着废。

`.stage` 的核心约定：

| 层 | 谁负责 | 在哪里 |
|---|---|---|
| **内容** | producer（`pack_deck.mjs` / agent / 任何符合 schema 的工具） | `.stage` 包内的 `slides/*.html` + `assets/*` + `manifest.json` |
| **运行时** | **平台**（你正在开发的） | 平台前端代码，独立部署 |

**核心收益**：演示工具升级（加个 AI 智能高亮、加个手势识别、加个云批注同步）→ 平台代码迭代一次 → **所有历史 deck 自动获得新能力**，不需要重新生成 deck 文件。这是「只更新平台」而不需要 deck 重新打包的根因。

### 1.2 双模式包：平台优先 + 本地 fallback

`.stage` 包同时是两个东西：

- **平台契约**：`manifest.json` + `slides/*.html` + `assets/*` + `thumbnails/*` —— 平台 runtime 读这些。
- **本地 fallback**：`index.html` + `presenter_tools.js` —— 用户解压后双击就能在浏览器全屏演讲，不依赖平台。

平台**忽略** `index.html` 和 `presenter_tools.js`（仅本地 fallback 用）。`pack_deck.mjs` 默认两个都打，可用 `--no-fallback` 关闭。

### 1.3 不是什么

- **不是** Reveal.js / Impress.js / Slidev 的替代品——这些是「写 deck 的工具」，slidestage 是「打包好的 deck 容器格式」。
- **不是** PPTX 的替代品——PPTX 是文字可编辑的协作格式，slidestage 是视觉保真的演示包。
- **不是** "上传到任何平台都能跑" 的通用格式——它假设平台实现了本文档描述的 runtime。

---

## 2. 包格式：`.stage` zip 的物理布局

### 2.1 文件类型

`.stage` 文件本质是 **ZIP archive**（PKZip / Info-ZIP 格式），后缀名 `.stage`，MIME type 建议 `application/vnd.stage+zip`。可用任何 zip 库解压（Node `adm-zip` / Python `zipfile` / Go `archive/zip` / Rust `zip` 等）。

### 2.2 强制目录结构

```
my-deck.stage/
├── manifest.json                  ← 必须，UTF-8，schema 见 §3
├── slides/                        ← 必须，至少一个 .html
│   ├── 01-cover.html
│   ├── 02-content.html
│   └── ...
├── thumbnails/                    ← 可选，平台后台预览用
│   ├── 01.png                     ← 480×270 PNG（可被 manifest 改写）
│   └── ...
├── shared/                        ← 可选，多页共用资源
│   ├── tokens.css
│   └── fonts.html
├── assets/                        ← 可选，媒体文件
│   ├── images/
│   ├── fonts/
│   └── ...
├── speaker-notes.json             ← 可选，speaker notes 副本（也 inline 在 manifest）
├── index.html                     ← 可选，本地 fallback 入口（平台忽略）
└── presenter_tools.js             ← 可选，本地 fallback 用（平台忽略）
```

### 2.3 路径约定

- 所有路径用**正斜杠 `/`**（Unix-style），即使在 Windows 平台上 producer 也会归一化。
- 路径相对**包根目录**（解压后的目录），不允许 `..` 跳出包外（防 zip slip，见 §5.2）。
- 文件名建议 ASCII，但 UTF-8 文件名（中文 / emoji）也合法——平台需正确处理 Unicode 路径。
- **不允许**符号链接、硬链接、设备文件、FIFO 等——只接受普通文件 + 目录。

### 2.4 文件编码

- HTML / JSON / CSS / JS 文件统一 **UTF-8 无 BOM**。
- 二进制文件（png / jpg / woff2 / mp4 ...）按各自标准。

### 2.5 大小约束（建议）

平台**应该**强制：

| 维度 | 推荐上限 | 理由 |
|---|---|---|
| 整个 `.stage` 文件 | 200 MB | 单 deck 不该比常见 PPT 大太多 |
| 解压后总大小 | 1 GB | 防 zip bomb |
| 单文件大小 | 100 MB | 防嵌入超大视频 |
| `slides/*.html` 单文件 | 5 MB | 超过这个体积说明 deck 设计有问题 |
| `manifest.json` | 5 MB | 含 base64 缩略图等极端情况 |
| `slides/` 数量 | 500 | UI 上极少超过 |

超出限额返回 `413 Payload Too Large` + 明确错误信息。

---

## 3. `manifest.json` schema v1.0 完整规范

### 3.1 顶层字段（TypeScript-style）

```typescript
interface Manifest {
  // ─── 标识与版本（必须） ─────────────────────────────────────────
  schema:   "slidestage@1.0";        // 固定字符串，平台用它做版本协商
  id:       string;                // 包内唯一 slug，[a-z0-9\-_\u4e00-\u9fff]，最长 64
  version:  string;                // 包内容版本（producer 自由定义，建议 semver）

  // ─── 人类可读元信息 ────────────────────────────────────────────
  title:        string;             // 必须，UI 标题
  subtitle:     string | null;
  author:       string | null;
  description:  string | null;

  // ─── 时间戳（ISO 8601） ────────────────────────────────────────
  createdAt:    string;             // 必须
  updatedAt:    string;             // 必须

  // ─── 渲染参数 ─────────────────────────────────────────────────
  architecture: ArchitectureKind;   // 见 §4
  dimensions:   { width: number; height: number };  // logical canvas 尺寸（px）
  totalSlides:  number;             // = slides.length

  // ─── 内容 ────────────────────────────────────────────────────
  slides: Slide[];                  // 见 §3.2

  // ─── 视觉系统（可选） ──────────────────────────────────────────
  fonts:  Font[];                   // 见 §3.3
  tokens: Record<string, any>;      // CSS 变量 / 设计 token（无 schema 约束）

  // ─── 资源清单 ────────────────────────────────────────────────
  assets: AssetIndex;               // 见 §3.4

  // ─── Runtime 期望 ─────────────────────────────────────────────
  runtime:  RuntimeHints;           // 见 §3.5

  // ─── 平台兼容声明 ─────────────────────────────────────────────
  platform: PlatformContract;       // 见 §3.6

  // ─── 打包元数据（producer 写入，平台只读） ──────────────────────
  stats: PackStats;                 // 见 §3.7

  // ─── 可选扩展（forward-compatible） ────────────────────────────
  provenance?: ManifestProvenance;  // 见 §3.9，源格式 / 转换器追踪
  compat?: ManifestCompat;          // 见 §3.10，trust capability 声明
}
```

### 3.2 `slides[]`

```typescript
interface Slide {
  index:     number;                // 1-based, 严格递增
  id:        string;                // 包内唯一，slug 风格
  label:     string;                // UI 标签（"封面" / "数据" / "总结"）
  file:      string;                // 必须，相对包根的 .html 路径
  thumbnail: string | null;         // 可选，相对包根的 .png 路径（约 480×270）
  notes:     string | null;         // speaker notes 文本，可为多行
  duration?: number;                // 可选，秒（用于 auto-advance / 录制）
  transition?: string;              // 可选，"fade" / "slide" / "none"，平台决定如何渲染
}
```

**注意**：
- `index` 必须从 1 开始，**不要用 0-indexed**。用户讲「翻到第 5 页」永远指 `index === 5`。
- `file` 路径不允许 `..`，也不允许指向 `slides/` 目录之外的位置。
- `thumbnail` 缺失时平台**应该**自己生成（用 headless chrome 截图 + 缩放）。
- `notes` 为 null 表示该页无 speaker notes。

### 3.3 `fonts[]`

```typescript
interface Font {
  family:  string;                  // CSS font-family 名
  weights: number[];                // [400, 700, 900]
  source:  "google" | "self-hosted" | "system";
  url?:    string;                  // 当 source === "google" 时，CSS 链接
  files?:  string[];                // 当 source === "self-hosted" 时，相对路径
}
```

平台**应该**预加载所有 `fonts[]` 列出的字体——不预加载不会出错（HTML 里的 `<link>` 兜底），但首页渲染会有 FOUT。

### 3.4 `assets`

```typescript
interface AssetIndex {
  totalSize: number;                // 字节
  count:     number;                // 文件数
  files:     AssetFile[];
}

interface AssetFile {
  path: string;                     // 相对包根
  size: number;                     // 字节
  type: "image" | "font" | "style" | "script" | "audio" | "video" | "other";
}
```

平台**可以**用此清单：
- 在上传完成后做完整性校验（实际文件 vs manifest 声明对得上）。
- 实现内容寻址缓存（asset hash → CDN URL）。
- 在 admin UI 里展示包内容明细。

### 3.5 `runtime`

```typescript
interface RuntimeHints {
  presenterTools: "platform" | "local" | "none";
  // "platform" → 期望平台接管演示工具（默认）
  // "local"    → producer 已经把工具内嵌到 slides 里，平台不要重复注入
  // "none"     → 这是个纯静态 deck，不需要演示工具

  fallbackEntry: string | null;     // 通常 "index.html"，平台**忽略**

  capabilities: Capability[];       // 包**期望**平台提供的能力
}

type Capability =
  | "keyboard-nav"          // ← / → / Space / Home / End / 1-9 / PgUp / PgDn
  | "thumbnail-preview"     // overview 网格 / speaker view
  | "speaker-notes"         // speaker view 双屏
  | "annotation-overlay"    // 演示工具九件套
  | "auto-advance"          // 用 slides[].duration 自动翻页
  | "transitions";          // 用 slides[].transition 渲染过渡
```

`capabilities` 是**包对平台的期望声明**，不是硬要求。平台**可以**只实现 `keyboard-nav` + `thumbnail-preview` 就上线，其他能力陆续加。包**不会**因为平台缺能力而拒绝渲染。

### 3.6 `platform`

```typescript
interface PlatformContract {
  minSchemaVersion: string;            // 包能接受的最低平台 schema 版本，"1.0"
  compatibleArchitectures: ArchitectureKind[];  // 见 §4
}
```

平台**必须**检查 `minSchemaVersion`——如果平台支持的 schema 低于这个值，拒绝加载并提示用户升级平台。

### 3.7 `stats`

```typescript
interface PackStats {
  packedAt:      string;            // ISO 8601
  packerVersion: string;            // 例: "huashu-design@1.1.0"
}
```

仅供调试和日志，平台**不应**依赖这些字段做行为决策。

### 3.8 可选扩展通则

`manifest.json` 顶层使用 `passthrough` 校验：**未来追加的字段不会让旧包被拒**。下面 §3.9 / §3.10 / §3.11 描述的 `provenance` / `compat` / `offline` 都是 slidestage@1.0 内的**可选扩展**，与 Lite 共用同一语义，平台不强制写入；包里没有这些字段时行为完全等价。

### 3.9 `provenance`（可选）

```typescript
interface ManifestProvenance {
  sourceKind?:     string;          // 原始包类型，例 "webcomponent-deck" / "router-html"
  conversionMode?: string;          // 转换模式，例 "wrap" / "split" / "passthrough"
  sourceEntry?:    string;          // 原始入口文件，相对包根
  converter?: {
    name:     string;               // 例 "slides-deck-converter"
    version?: string;
  };
}
```

`provenance` 用于追踪 HTML deck → `.stage` 的转换链。Lite 在 wrap / split 模式下会写入，Pro 收到时**应该**保留并对外可读（API、调试视图），但**不应**用它做行为决策——`architecture` 仍是渲染决策的唯一依据。

### 3.10 `compat`（可选）

```typescript
interface ManifestCompat {
  requires?: string[];              // trust capability 列表，平台过滤为已知枚举
  notes?:    string;                // 给操作者看的解释，<=1024 字
}

type TrustCapability =
  | "same-origin-storage"           // localStorage / IndexedDB / cookies
  | "broadcast-channel"             // BroadcastChannel 跨页同步
  | "window-open";                  // window.open(...) 弹窗
```

`compat.requires` 让 producer 声明 slide HTML 需要的浏览器能力。平台**必须**：

- 接收 `string[]`，丢弃未知值并保留已知 `TrustCapability` 集合（去重 + 排序）。
- 根据归一化结果调整 iframe `sandbox` token：见 §6.3。
- 不强制要求 `compat` 存在；缺省时按最小沙箱（`allow-scripts`）渲染。

### 3.11 `offline`（可选）

`offline` 字段记录"外部资源镜像"流水线（mirror pass）的结果。**镜像**是把
deck 中所有 `https://...` 引用（图片 / 字体 / CSS / 视频 / 音频）下载到包
内 `assets/_mirror/...` 并在 slide HTML / CSS 中**静态重写**为本地相对路
径的过程。带有 `offline.ready = true` 的 deck 在加载时不需要任何外网请
求。

```typescript
interface ManifestOffline {
  /** true = 包内所有 in-scope 外部引用都已镜像或显式跳过。
   *  false = 部分镜像，runtime 仍按原协议处理剩余 external URL，
   *          但 UI 应显示"仅部分离线就绪"。 */
  ready: boolean;

  /** ISO 8601，镜像 pass 完成时间。 */
  mirroredAt: string;

  /** 镜像工具身份。 */
  mirrorTool: { name: string; version?: string };

  /** 默认策略快照——保留以保证可复现镜像。 */
  policy?: {
    includeScripts: boolean;     // 默认 false
    includeIframes: boolean;     // 默认 false
    maxAssetBytes: number;       // 默认 50 * 1024 * 1024
    maxTotalBytes: number;       // 默认 500 * 1024 * 1024
    allowedHosts?: string[];     // null = 任意 host
    blockedHosts?: string[];     // host 后缀，永不抓取
  };

  /** 成功镜像的资源。HTML / CSS 字节已被改写指向 `path`；`originalUrl`
   *  仅作审计保留。 */
  mirroredAssets: Array<{
    originalUrl: string;
    path: string;                // 相对包根，必须在 assets/ 之下
    contentHash: string;         // "sha256-<hex>"
    contentType: string;
    bytes: number;
    fetchedAt: string;
    referencedBy: number[];      // 引用该 URL 的 slide 1-based index
  }>;

  /** 跳过的引用——runtime 不应基于这里做行为决策，仅用于 UI 解释
   *  "为什么是 partial"。 */
  skippedUrls: Array<{
    url: string;
    reason:
      | "unreachable"
      | "blocked-by-policy"
      | "too-large"
      | "unsupported-scheme"
      | "budget-exhausted"
      | "manual-skip";
    detail?: string;
  }>;
}
```

#### 路径约定

- 推荐布局：`assets/_mirror/<category>/<hash>.<ext>`，category 取
  `css | font | img | video | audio | other`。category 仅 cosmetic，平台
  按 manifest path 解析。
- 镜像后的资源**必须**同时出现在 `assets.files[]` 中——这样既有的大小
  审计逻辑无需特例处理。

#### 平台行为合约

| 场景 | 平台行为 |
|---|---|
| 包内无 `offline` 字段 | 按 §6.4 老逻辑加载（slide HTML 中的 `<link>` / `<img src>` 直接走外网）。 |
| `offline.ready === true` | **不应**对 mirror 范围内资源发起外网请求；slide HTML 已经指向本地副本。平台 UI **应该**显示"离线就绪"徽章。 |
| `offline.ready === false` | 按老逻辑加载；UI **应该**显示"仅部分离线就绪 (n 跳过)"提示，可链接到 `offline.skippedUrls` 详情。 |
| `offline.mirroredAssets[].path` 不存在于包中 | manifest 校验**必须**失败（已有的 §5.4 路径校验逻辑覆盖）。 |
| `offline.policy.includeScripts === false` 但 slide 仍引用 `<script src="https://...">` | 不报错。这些 script 标签会沿用基线沙箱策略——若平台禁用 `<script>` external src，则按平台 CSP 走。 |

#### 默认策略

| 维度 | 是否镜像 |
|---|---|
| `<img>` / `srcset` / `<source>` / `<video poster>` | ✅ |
| `<link rel="stylesheet">` + 其 CSS 内部 `url()` / `@import` | ✅ |
| `<link rel="preload" as="font">`、`@font-face url(...)`、Google Fonts CSS 内嵌的 `*.woff2` | ✅ |
| `<video src>` / `<audio src>` / `<source src>` | ✅ |
| `<script src="https://...">` | ❌ 默认（安全）；显式 `--include-scripts` 后镜像 |
| `<iframe src="https://...">` | ❌ 默认；显式 `--include-iframes` 后镜像 |
| `<link rel="preconnect" \| "dns-prefetch">` | ❌ 没有 body 可镜像；pass 结束后从 HTML 中**剥离** |

#### 限额（建议）

| 限制 | 默认 |
|---|---|
| 单个镜像资源 | 50 MB |
| 单次 mirror pass 总下载 | 500 MB |
| 镜像后 `.stage` 体积 | 与 §2.5 一致（200 MB packed / 1 GB unpacked） |
| 每 host 并发 | 4 |
| 单资源 HTTP 超时 | 30 s |

超限即停，生成 `budget-exhausted` / `too-large` 条目记入 `offline.skippedUrls`。manifest 仍然合法，仅 `offline.ready = false`。

#### 与 trust capability 的关系

镜像本身不会改变 `compat.requires`。一个使用 same-origin-storage 的 deck
即使完全镜像也仍然要走 §6.3 的 trust prompt——`offline` 解决的是「不联
外网」的问题，不是「不需要本地能力」的问题。

### 3.11 完整示例

```json
{
  "schema": "slidestage@1.0",
  "id": "ai-psychology-2026",
  "version": "1.0.0",
  "title": "AI 与心理学",
  "subtitle": "技术-人本主义对话",
  "author": "花叔",
  "description": null,
  "createdAt": "2026-04-29T11:54:00.000Z",
  "updatedAt": "2026-04-29T11:54:00.000Z",
  "architecture": "multi-file",
  "dimensions": { "width": 1920, "height": 1080 },
  "totalSlides": 4,
  "slides": [
    {
      "index": 1,
      "id": "cover",
      "label": "封面",
      "file": "slides/01-cover.html",
      "thumbnail": "thumbnails/01.png",
      "notes": "欢迎大家。今天我们要聊聊 AI 与心理学的对话边界。"
    },
    {
      "index": 2,
      "id": "intro",
      "label": "导论",
      "file": "slides/02-intro.html",
      "thumbnail": "thumbnails/02.png",
      "notes": null
    }
  ],
  "fonts": [
    { "family": "Noto Serif SC", "weights": [400, 900], "source": "google",
      "url": "https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;900" }
  ],
  "tokens": {
    "colors": { "primary": "#C04A1A", "ink": "#1A1A1A", "paper": "#FAFAFA" }
  },
  "assets": {
    "totalSize": 12345,
    "count": 1,
    "files": [{ "path": "assets/images/hero.svg", "size": 4321, "type": "image" }]
  },
  "runtime": {
    "presenterTools": "platform",
    "fallbackEntry": "index.html",
    "capabilities": ["keyboard-nav", "thumbnail-preview", "speaker-notes", "annotation-overlay"]
  },
  "platform": {
    "minSchemaVersion": "1.0",
    "compatibleArchitectures": ["multi-file"]
  },
  "stats": {
    "packedAt": "2026-04-29T11:54:00.000Z",
    "packerVersion": "huashu-design@1.1.0"
  }
}
```

---

## 4. Slide 架构类型枚举

`manifest.architecture` 标记原始 deck 类型。这影响平台**如何加载**单页：

| 值 | 含义 | 平台加载方式 |
|---|---|---|
| `"multi-file"` | 每页独立 HTML 在 `slides/*.html`，根目录可能有 `index.html` 聚合（被忽略） | 直接 iframe load `slides/<file>` |
| `"multi-file-flat"` | 同上，但根目录直接放 `01-xxx.html`（无 `slides/` 子目录） | 同上，路径不同 |
| `"single-file-deckstage"` | producer 端是单 HTML + `<deck-stage>` web component，但**已被自动拆解**为 `slides/*.html` 入包 | 同 multi-file |
| `"single-file-html"` | 单 HTML 单页（少见，用于纯静态海报、信息图） | iframe load `slides/<唯一文件>` |

**关键**：除了 `"single-file-html"`，所有 architecture 都已经被 producer 归一化为「每页独立 HTML 在 `slides/`」。**平台只需实现 multi-file 加载逻辑**，单文件 deck-stage 已被 producer 拆好。

未来扩展（v2）可能加 `"video-loop"`、`"interactive-component"` 等，平台用 `architecture` 做能力降级。

---

## 5. 平台后端：上传 / 校验 / 解压 / 索引

### 5.1 推荐流水线

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  Upload  │───▶│ Validate │───▶│  Unpack  │───▶│  Index   │───▶│   CDN    │
└──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘
   .stage     size/MIME       zip extract     parse JSON     mount slides/
```

### 5.2 安全：防 Zip Slip / Path Traversal

**最重要的安全检查。** 解压前校验每个 zip entry 的归一化路径：

```python
import os
def safe_extract(zip_path, dest):
    dest_abs = os.path.realpath(dest)
    with zipfile.ZipFile(zip_path) as z:
        for name in z.namelist():
            target = os.path.realpath(os.path.join(dest, name))
            # 关键检查：解压后的绝对路径必须仍在 dest 之内
            if not target.startswith(dest_abs + os.sep) and target != dest_abs:
                raise SecurityError(f"Zip slip detected: {name}")
        z.extractall(dest)
```

恶意包可能在 entry name 写 `../../etc/passwd` 试图覆盖系统文件——上面的检查可以挡掉。

### 5.3 防 Zip Bomb

单文件解压前先 streaming 解压 + 累计字节，超过 §2.5 限额立刻中断。不要一次 `extractall()` 后才发现。

```python
total = 0
LIMIT = 1024 * 1024 * 1024  # 1 GB
for info in z.infolist():
    total += info.file_size
    if total > LIMIT:
        raise SecurityError("Decompressed size exceeds limit")
```

### 5.4 manifest 校验

按 §3 验证：

```typescript
function validateManifest(m: any): Manifest {
  if (m.schema !== 'slidestage@1.0') throw new Error('Unsupported schema');
  if (!m.id || !/^[a-z0-9\-_\u4e00-\u9fff]{1,64}$/i.test(m.id)) throw new Error('Invalid id');
  if (!Array.isArray(m.slides) || m.slides.length === 0) throw new Error('No slides');
  if (m.slides.length !== m.totalSlides) throw new Error('totalSlides mismatch');
  m.slides.forEach((s, i) => {
    if (s.index !== i + 1) throw new Error(`slides[${i}].index must be ${i+1}`);
    if (!s.file.startsWith('slides/')) throw new Error('slide.file must be in slides/');
    if (s.file.includes('..')) throw new Error('slide.file path traversal');
  });
  // 还要校验 architecture / dimensions / runtime 等...
  return m as Manifest;
}
```

### 5.5 索引落库（推荐 schema）

```sql
CREATE TABLE decks (
  id           VARCHAR(64) PRIMARY KEY,        -- manifest.id
  owner_id     UUID NOT NULL,
  schema_ver   VARCHAR(16) NOT NULL,           -- "slidestage@1.0"
  title        TEXT NOT NULL,
  subtitle     TEXT,
  author       TEXT,
  total_slides INT NOT NULL,
  width        INT NOT NULL,
  height       INT NOT NULL,
  manifest     JSONB NOT NULL,                 -- 整个 manifest，方便后续查询
  storage_root TEXT NOT NULL,                  -- 解压后目录的存储 URI（s3://, /var/data/...）
  size_bytes   BIGINT NOT NULL,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE slides (
  deck_id    VARCHAR(64) REFERENCES decks(id) ON DELETE CASCADE,
  idx        INT NOT NULL,
  slide_id   VARCHAR(128) NOT NULL,
  label      TEXT,
  file_path  TEXT NOT NULL,
  thumb_path TEXT,
  notes      TEXT,
  PRIMARY KEY (deck_id, idx)
);

CREATE TABLE annotations (
  deck_id    VARCHAR(64) REFERENCES decks(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL,
  slide_idx  INT NOT NULL,
  strokes    JSONB NOT NULL,                   -- 见 §8
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (deck_id, user_id, slide_idx)
);
```

### 5.6 静态资源服务

解压后的 `slides/*.html` + `assets/*` + `thumbnails/*` 直接当静态文件服务（CDN / S3 / nginx）即可。**注意**：

- HTML 内的相对引用（`<link href="../shared/tokens.css">`）依赖原始目录层级，**不要**把文件全部 flat 化。
- 给所有 HTML 设置 `Content-Type: text/html; charset=utf-8`。
- CSP 头按 §6.3 配置。

---

## 6. 平台前端：渲染 + iframe sandbox 策略

### 6.1 推荐渲染模型

```html
<!-- 平台 shell（你写的代码） -->
<div class="deck-stage" id="stage" style="--logical-w:1920;--logical-h:1080;">
  <iframe
    id="slide-frame"
    src="/decks/<deck-id>/slides/01-cover.html"
    sandbox="allow-scripts allow-same-origin"
    referrerpolicy="no-referrer"
    loading="eager">
  </iframe>
</div>
<!-- 你的 runtime overlay -->
<div class="presenter-overlay">...</div>
<div class="navigation-counter">1 / 12</div>
```

### 6.2 缩放：logical 1920×1080 → viewport

每个 slide HTML 假设画布 `width × height`（来自 `manifest.dimensions`）。在不同窗口尺寸下，**等比缩放 + letterbox**：

```js
function fit(stageEl, logicalW, logicalH) {
  const vw = window.innerWidth, vh = window.innerHeight;
  const scale = Math.min(vw / logicalW, vh / logicalH);
  stageEl.style.width  = logicalW + 'px';
  stageEl.style.height = logicalH + 'px';
  stageEl.style.transform = `translate(${(vw - logicalW*scale)/2}px, ${(vh - logicalH*scale)/2}px) scale(${scale})`;
  stageEl.style.transformOrigin = 'top left';
}
```

iframe 内的 HTML 不需要知道平台缩放——它就按原始 1920×1080 渲染，外层 `transform: scale` 缩放整个 iframe。

### 6.3 安全：iframe sandbox + CSP

slide HTML 是用户上传内容，可能含恶意 JS。**必须** sandbox：

| 标志 | 意义 | 推荐 |
|---|---|---|
| `allow-scripts` | 允许 JS（动画 / 交互必需） | ✅ |
| `allow-same-origin` | 允许 iframe 内 JS 访问自己 origin | ✅（同源资源加载需要） |
| `allow-forms` | 允许表单提交 | ❌（slide 不该有表单） |
| `allow-popups` | 允许 window.open | ❌ |
| `allow-top-navigation` | 允许跳出 iframe 到 top frame | ❌（**关键安全位**） |
| `allow-modals` | 允许 alert/confirm/prompt | ❌（会卡住主线程） |

推荐 sandbox 基线：`sandbox="allow-scripts"`（最小可用集合）。

**Trust capability 提升**：当 manifest 提供 `compat.requires`（§3.10），平台**必须**按下表向 sandbox 添加 token，使 slide 能拿到声明过的能力：

| `compat.requires` 项 | 增加的 sandbox token |
|---|---|
| `same-origin-storage` | `allow-same-origin` |
| `broadcast-channel`   | `allow-same-origin` |
| `window-open`         | `allow-popups allow-popups-to-escape-sandbox` |

不在 trust capability 枚举里的字符串会被丢弃并记录告警；缺省 / 空 `compat.requires` 时退回基线。Pro 实现见 `apps/web/src/utils/iframeSandbox.ts`。

后端给 slide HTML 响应加 CSP 头：

```
Content-Security-Policy: default-src 'self' https:;
                         script-src 'self' 'unsafe-inline' https:;
                         style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
                         font-src 'self' https://fonts.gstatic.com data:;
                         img-src 'self' https: data: blob:;
                         frame-ancestors 'self';
```

`'unsafe-inline'` 通常需要——大量 slide 内嵌 `<style>` 和 `<script>`。如果你能强制 producer 抽出 inline 内容则更安全（但会破坏现有 deck）。

### 6.4 跨 iframe 通信：postMessage 协议（可选）

如果 slide 内的 JS 需要主动告知平台「我已经准备好了」「用户点了某个按钮要跳页」，定义协议：

```typescript
// slide → 平台
parent.postMessage({ type: 'slidestage:ready', slideIdx: 5 }, '*');
parent.postMessage({ type: 'slidestage:goto', target: 'next' }, '*');

// 平台 → slide
iframe.contentWindow.postMessage({ type: 'slidestage:slide-shown', slideIdx: 5 }, '*');
```

平台**必须**校验 `event.origin` 和 `event.source`——否则任何页面都能伪造命令。

### 6.5 字体加载

每个 slide HTML **应该**自己 `<link>` 引用所需字体（producer 已经这么做了）。平台**可以**额外预加载 `manifest.fonts[]` 加速首屏。

不要假设字体加载完成才显示 slide——会引入不必要的 lag。让浏览器 FOUT 就好。

---

## 7. 演示工具九件套：行为规范

平台 runtime **应该**实现以下九件工具。这一套行为模型基于 PowerPoint 的 6 件套（鼠标 / 激光笔 / 画笔 / 荧光笔 / 橡皮擦 / 黑屏）+ 现代演讲常用的 3 件（聚光灯 / 白屏 / 一键清空）。

参考实现：本 skill 的 `assets/presenter_tools.js`（约 800 行 vanilla JS，平台可以直接复用 / 改写）。

### 7.1 工具行为表

| # | 工具 | 输入 | 视觉表现 | 默认快捷键 |
|---|---|---|---|---|
| 1 | 🖱 鼠标 (Mouse) | — | 默认指针，无 overlay | `Shift+M` / `Esc` |
| 2 | 🔴 激光笔 (Laser) | pointer move | 14px 红圆点跟手，pointerdown 留 800ms 拖尾 | `Shift+L` |
| 3 | ✏️ 画笔 (Pen) | pointer down→move→up | 实色细线，5 色（红/橙/黄/蓝/绿），笔触端点 round | `Shift+P` |
| 4 | 🟡 荧光笔 (Highlighter) | pointer down→move→up | 半透明黄 18px，覆盖文字突出 | `Shift+H` |
| 5 | 🧽 橡皮擦 (Eraser) | pointer down on stroke | 命中即删除整条笔迹 | `Shift+E` |
| 6 | 🔦 聚光灯 (Spotlight) | pointer move | 鼠标周围圆形画亮，其他变暗（默认 240px，范围 80–480px，步进 16px；滚轮 / `[` `]` / Toolbar 滑块可调，localStorage 持久化，跨窗口同步） | `Shift+S` |
| 7 | ⬛ 黑屏 (Blackout) | — | 全屏黑，遮住整个 deck | `B` |
| 8 | ⬜ 白屏 (Whiteout) | — | 全屏白 | `W` |
| 9 | 🗑 清空当前页 | — | 清掉当前页所有 stroke | `Shift+Delete` / `Shift+Backspace` |

附加：

- `Ctrl+Z` / `Cmd+Z` = 撤销当前页最后一笔
- `1` / `2` / `3` / `4` / `5` = 切换画笔颜色（仅 Pen / Highlighter 模式下）
- `Esc` = 退出当前模式 → 回到鼠标

### 7.2 工具栏

浮动工具栏建议挂在视口底部，**鼠标移到下半屏**时渐入显示，2 秒不动渐出。这样不打扰演讲。

工具栏尺寸建议：每个按钮 38×38px，间距 4px，圆角 8-12px，半透明深色背景。

### 7.3 输入设备：PointerEvents 兼容

**必须**用 `PointerEvent` 系列事件（pointerdown / pointermove / pointerup），不要用 mouseEvent + touchEvent 各一套。原因：

- PointerEvents 同时兼容鼠标 / 触屏 / Apple Pencil / Wacom 笔
- 自动处理 hover / drag 状态机
- iPad + Apple Pencil 在 Safari 16+ 下完全支持

```js
overlay.addEventListener('pointerdown', e => {
  overlay.setPointerCapture(e.pointerId);  // 关键：drag 出 overlay 也能继续
  beginStroke(e);
});
overlay.addEventListener('pointermove', e => continueStroke(e));
overlay.addEventListener('pointerup',   e => endStroke(e));
```

### 7.4 全屏布局上的 overlay

演示工具的批注层是一个**全屏透明 canvas / SVG**，覆在 iframe 上方。它**不应该**插进 slide iframe 内（跨 origin / sandbox 限制让批注层难以管理）。

```
┌─────────────────────────────────────────┐
│ Browser viewport                        │
│  ┌─────────────────────────────────┐   │
│  │ Slide iframe (sandboxed)        │   │
│  │  ┌──────────────────────────┐   │   │
│  │  │ slide HTML content       │   │   │
│  │  └──────────────────────────┘   │   │
│  └─────────────────────────────────┘   │
│  ┌─────────────────────────────────┐   │
│  │ Annotation overlay (canvas)     │   │ ← 平台插入，z-index > iframe
│  └─────────────────────────────────┘   │
│  ┌──────────┐                          │
│  │ 工具栏    │                          │
│  └──────────┘                          │
└─────────────────────────────────────────┘
```

### 7.5 黑屏 / 白屏的语义

不是「关掉 slide」，而是「在最上层盖一块黑/白色 div」。`B` / `W` 按第二次回到正常视图。中间观众讲台演讲、想让大家聚焦于自己时用。

---

## 8. 批注协议：stroke 数据结构 + 后端同步

### 8.1 Stroke 数据结构

```typescript
interface Stroke {
  tool:   "pen" | "highlighter";    // eraser 不产生 stroke，它只删除已有 stroke
  color:  string;                   // CSS color, "#FF3B30" / "rgba(255,215,0,0.42)"
  width:  number;                   // 像素宽度（在 logical 1920×1080 坐标系下）
  points: [number, number][];       // [[x1,y1], [x2,y2], ...] 折线顶点
}
```

**关键**：`points` 用 **logical stage 坐标**（1920×1080 默认，由 `manifest.dimensions` 决定）。这样窗口缩放时批注**自动跟着等比缩放**——你画在「这个标题旁边」，永远在那个标题旁边，不论投影到多大屏幕上。

转换公式：

```js
// viewport (px) → logical stage
function viewportToStage(x, y, dim, transform) {
  return [(x - transform.offsetX) / transform.scale,
          (y - transform.offsetY) / transform.scale];
}
```

### 8.2 当前页批注集合

```typescript
// 整页批注（作为 stroke 数组）
type SlideAnnotations = Stroke[];

// 整 deck 批注
type DeckAnnotations = Record<number /* slideIdx 0-based */, SlideAnnotations>;
```

### 8.3 本地 fallback 的 storage key 格式

本地双击 fallback 模式下，存到 localStorage：

```
key:   "huashu-presenter-annotations-<location.pathname>"
value: JSON.stringify({ "0": [stroke, ...], "1": [...] })
```

这是历史命名（来自 producer 端的 presenter_tools.js），**平台不需要遵守**——平台用自己的后端存储，本地 storage 仅是 fallback。

### 8.4 平台后端 API（推荐）

```
POST   /api/decks/{deckId}/annotations/{slideIdx}
Body:  { strokes: Stroke[] }
       → 替换该用户在该页的所有 stroke

PATCH  /api/decks/{deckId}/annotations/{slideIdx}
Body:  { append: Stroke[] } | { remove: number[] }   // remove by index
       → 增量更新

GET    /api/decks/{deckId}/annotations/{slideIdx}
       → 200 { strokes: Stroke[] }

DELETE /api/decks/{deckId}/annotations/{slideIdx}
       → 清空该页

GET    /api/decks/{deckId}/annotations
       → 200 { "0": [...], "1": [...] }   // 整 deck 拉取
```

### 8.5 同步策略

**推荐 debounce + 批量提交**：

```js
let pendingStrokes = [];
let flushTimer = null;
function recordStroke(stroke) {
  pendingStrokes.push(stroke);
  drawStrokeOnCanvas(stroke);     // 立即本地呈现
  scheduleFlush();
}
function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 800);   // 800ms 静默后提交
}
async function flush() {
  if (!pendingStrokes.length) return;
  const batch = pendingStrokes;
  pendingStrokes = [];
  try {
    await fetch(`/api/decks/${deckId}/annotations/${slideIdx}`,
                { method: 'PATCH', body: JSON.stringify({ append: batch }) });
  } catch (e) {
    // 回滚 / 重试 / 降级到 localStorage
  }
}
```

**Strokes 不要每次画一笔就 POST 一次**——演讲时每秒可能产生 30+ stroke，会打爆后端。

### 8.6 多设备同步

如果用户在 iPad 上画批注、希望投影机端实时显示：

- WebSocket / SSE 推送 stroke
- 用 CRDT 或简单 last-writer-wins 处理冲突（演讲场景冲突极少）
- 给每条 stroke 一个 client-side UUID，避免重复 append

### 8.7 隐私

批注属于**演讲者**的私人笔迹（含潜在敏感信息）。平台必须：
- 严格按用户隔离（`user_id` 是主键的一部分）
- 提供一键导出（JSON）+ 一键全清
- 默认不让其他用户看（即使其他用户能看 deck）

---

## 9. Speaker Notes 与 Speaker View

### 9.1 数据来源

每页的 speaker notes 在 `manifest.slides[i].notes`（string | null）。同时 `speaker-notes.json` 是冗余副本：

```json
[
  "第1张的 script...",
  "第2张的 script...",
  "..."
]
```

平台**优先**从 `manifest.slides[].notes` 读，`speaker-notes.json` 仅做兜底（极端情况 manifest 没 inline 但有独立文件时）。

### 9.2 Speaker View 推荐布局

PowerPoint 风格双屏布局：

```
┌─────────────────────────────────┬──────────────┐
│                                 │  下一页       │
│   当前页（大）                   │  thumbnail    │
│                                 ├──────────────┤
│                                 │  计时器       │
│                                 │  当前页/总数   │
├─────────────────────────────────┴──────────────┤
│ Speaker notes（当前页）                          │
│ 字号大、行距宽，方便讲者快速扫读                    │
└────────────────────────────────────────────────┘
```

观众看到的投影 = 单纯的 slide iframe。
讲者看到的本地 = speaker view（演讲者监视器或独立标签页）。

### 9.3 实现：双窗口同步

最简单：用 `BroadcastChannel` 跨标签页同步当前页 index。

```js
const ch = new BroadcastChannel('slidestage-' + deckId);
// 投影端
ch.postMessage({ type: 'slide-changed', idx: currentIdx });
// speaker view
ch.onmessage = e => updateSpeakerView(e.data.idx);
```

---

## 10. 缩略图与 Overview

### 10.1 缩略图规格

- **尺寸**：默认 480×270（16:9），与 logical canvas 等比
- **格式**：PNG（producer 默认，质量最高）；平台**可以**转码 WebP / AVIF 做 CDN 加速
- **路径**：`thumbnails/<index>.png`，index 是 zero-padded 两位数（`01.png`、`02.png`...）
- **缺失**：`slide.thumbnail = null` 时平台**应该**自己用 headless chrome 截图

### 10.2 Overview 网格

```
┌──────┬──────┬──────┐
│ #1   │ #2   │ #3   │
│      │      │      │
└──────┴──────┴──────┘
┌──────┬──────┬──────┐
│ #4   │ #5   │ #6   │
└──────┴──────┴──────┘
```

热键 `O` 或工具栏按钮触发 overview，点击任一 thumbnail → 跳到该页。这是讲者快速跳转的核心 UI。

### 10.3 演讲者监视器 / Speaker view 用途

speaker view 右侧通常有「当前页 + 下一页」两个缩略图，用 `manifest.slides[currentIdx].thumbnail` 和 `manifest.slides[currentIdx + 1].thumbnail`。

---

## 11. 导航 API（推荐）

平台**应该**实现以下导航接口（不强制对外暴露，但内部一致性强）：

```typescript
interface DeckNavigator {
  // 状态
  currentIndex: number;           // 0-based，UI 上显示 +1
  total: number;
  
  // 跳转
  goto(idx: number): Promise<void>;
  next(): Promise<void>;
  prev(): Promise<void>;
  first(): Promise<void>;
  last(): Promise<void>;
  
  // 事件
  on(event: 'change', cb: (idx: number) => void): void;
  on(event: 'ready',  cb: () => void): void;
  
  // 持久化
  rememberPosition(): void;       // 写 localStorage
  restorePosition(): void;        // 读 localStorage
}
```

### 11.1 URL hash 协议

- `/decks/<id>#1` → 第 1 页
- `/decks/<id>#5` → 第 5 页
- 切页时 `history.replaceState` 更新 hash（不是 pushState，避免污染浏览器历史）

### 11.2 键盘快捷键完整表

| 键 | 行为 |
|---|---|
| `→` / `Space` / `PgDown` | 下一页 |
| `←` / `PgUp` | 上一页 |
| `Home` | 第一页 |
| `End` | 最后一页 |
| `1`-`9` | 跳到第 N 页（演示工具未激活时） |
| `Esc` | 退出当前演示工具 / 关闭 overview / 退出 speaker view |
| `F` / `F11` | 全屏切换 |
| `O` | Overview 网格切换 |
| `S` | Speaker view 打开 / 关闭 |
| `B` / `W` | 黑屏 / 白屏 |
| `Shift+L/P/H/E/S/M` | 切演示工具（见 §7） |
| `Ctrl+Z` | 撤销最近一笔 |
| `Shift+Delete` | 清当前页批注 |

注意：`B` 和 `W` 优先级高于其他单字母快捷键（PPT 行为约定）。

---

## 12. 版本协商与兼容策略

### 12.1 Schema 版本号语义

`schema: "slidestage@1.0"` 中：
- **major（1）**：breaking change。平台支持的 major 必须 ≥ 包的 major，否则拒绝加载。
- **minor（0）**：additive change（新可选字段、新 capability）。包要求平台 minor ≥ 自己 minor 才**完全**支持，否则**降级**支持（忽略未知字段）。

### 12.2 平台兼容性自检

```js
function checkCompat(manifest) {
  const supportedSchemas = ['slidestage@1.0', 'slidestage@1.1', 'slidestage@1.2'];
  if (!supportedSchemas.includes(manifest.schema)) {
    throw new IncompatibleError(
      `Schema "${manifest.schema}" not supported. ` +
      `Platform supports: ${supportedSchemas.join(', ')}`,
      'UPDATE_PLATFORM',
    );
  }
}
```

### 12.3 Schema 演进规则

未来版本变更必须遵守（producer 和 consumer 共同约束）：

| 类型 | 允许 | 不允许 |
|---|---|---|
| 加字段（顶层 / 嵌套） | ✅（可选字段） | ❌（必需字段除非 major++） |
| 加 enum 值 | ✅（如 `architecture` 加 `"video-loop"`） | ❌（除非 major++ 否则要求平台兼容旧 enum） |
| 删字段 | ❌（major++） | |
| 改字段类型 | ❌（major++） | |
| 改字段语义 | ❌（major++ 或起新名字） | |

**新字段平台必须**：未识别字段 → 忽略。不要因为字段不认识就拒绝加载。

### 12.4 包向下兼容

producer 应该尽量产出**最低 schema 版本**的包。比如 v1.2 的 producer 没用任何 v1.2 新特性时，就该写 `schema: "slidestage@1.0"`。这样老平台也能加载。

---

## 13. 错误处理与降级

### 13.1 加载流水线错误码

| 阶段 | 错误 | HTTP / Code | 用户应对 |
|---|---|---|---|
| 上传 | 大小超限 | `413` | 减小 deck，或升级套餐 |
| 上传 | MIME 错误 | `415` | 上传 `.stage` 后缀 zip |
| 校验 | zip 损坏 | `400 EUNZIP` | 重新打包 |
| 校验 | manifest.json 缺失 | `400 ENOMANIFEST` | 检查 producer 版本 |
| 校验 | manifest schema 不支持 | `400 EBADSCHEMA` | 升级平台或降级 producer |
| 校验 | path traversal 检测到 | `400 EZIPSLIP` | 包恶意，拒绝 |
| 解压 | 解压后超容量 | `413 EBOMB` | 拒绝 zip bomb |
| 索引 | 数据库写失败 | `500` | 重试 |
| 渲染 | iframe 加载失败 | `slide-error` 事件 | 跳过该页 / 显示降级提示 |

### 13.2 渲染时降级

某一页 HTML 加载失败（404 / JS 报错 / 字体超时）：

- **不要**整 deck 崩溃。
- 在该页位置显示 placeholder（"该幻灯片加载失败，按 → 跳到下一页"）。
- 打 telemetry 告诉运维。
- 其他页继续可以演讲。

### 13.3 已废弃 deck 的处理

如果 deck schema 是未来版本你的平台不支持：

```html
<div class="deck-incompatible">
  <h2>这个 Deck 由更新版本的工具生成</h2>
  <p>Schema: <code>slidestage@2.0</code>，本平台支持到 <code>slidestage@1.5</code>。</p>
  <p>请升级平台到 ≥ v3.0，或用旧版 producer 重新打包。</p>
</div>
```

---

## 14. 测试包与参考实现

### 14.1 生成测试包

clone huashu-design skill 后跑：

```bash
cd huashu-design
npm install
npm run test:pack:keep    # 生成包并保留临时目录
ls _test-pack/out/sample.stage
```

得到一个 4 页 demo 包（约 200 KB），用于平台开发期间的端到端测试。

### 14.2 推荐的平台开发自测矩阵

| 测试 | 验收 |
|---|---|
| 上传 sample.stage | 200，落库 |
| 解压后 manifest 字段齐全 | 与本文档 §3 一致 |
| 在 deck 列表里看到 thumbnails | 4 个 |
| 加载第 1 页 | iframe 正常显示「Slide Deck Packaging Demo」标题 |
| 按右箭头 | 翻到第 2 页，counter 变成 "2 / 4" |
| 按 `O` | overview 显示 4 个 thumbnail |
| 按 `S` | speaker view 显示当前页 notes（"封面页：欢迎大家..."） |
| 按 `B` | 全屏黑，再按 `B` 恢复 |
| 切到 Pen 工具画一笔 | 笔迹显示，刷新页面后还在（同步到后端） |
| 按 `Ctrl+Z` | 撤销最后一笔 |
| 上传一个故意 path traversal 的 zip | 400 EZIPSLIP |
| 上传一个 schema 不存在的 zip | 400 EBADSCHEMA |

### 14.3 producer 端参考

`scripts/pack_deck.mjs`（约 700 行）实现了完整 producer 流水线：

- 自动识别 deck 架构（multi-file / multi-file-flat / single-file-deckstage / single-file-html）
- 单文件 deck-stage 自动拆解（用 Playwright 提取 sections）
- speaker notes 提取（从 `<script id="speaker-notes" type="application/json">`）
- 缩略图生成（Playwright + 可选 sharp 缩放）
- manifest 构造 + 校验
- 系统 zip 命令打包

平台开发期间，producer 是 **可信源**——你以 `pack_deck.mjs` 的输出为准，不要为了适配某种特殊 deck 反过来改 producer。

### 14.4 本地 fallback 是开发参考

`presenter_tools.js`（约 800 行 vanilla JS）实现了演示工具九件套和批注协议——这是**平台前端的最低可行实现**，可以直接 fork 改成你的版本：

- 把 localStorage 存储替换为 `fetch('/api/.../annotations')`
- 工具栏 UI 按你品牌重做
- 加上你的多设备同步逻辑

---

## 15. 附录：常见问题与术语表

### 15.1 FAQ

**Q: 平台一定要支持「黑屏 / 白屏」？**
A: 不一定。`runtime.capabilities` 是包对平台的**期望**，不是硬要求。但黑屏 / 白屏是 PPT 演讲者最常用的两个键，优先级高。

**Q: 为什么 stroke 用 logical 坐标而不是 viewport 坐标？**
A: 投影机分辨率千差万别（笔记本 1440×900 演讲、4K 投影 3840×2160），用 viewport 坐标会让批注在不同设备上漂移。logical 坐标 + 等比缩放保证「画在标题旁边」永远在标题旁边。

**Q: 平台能修改 deck 内容吗？**
A: 不应该。Deck 是不可变工件——producer 生成、用户上传、平台仅作渲染。改了内容就破坏了「playback fidelity」。如果用户要改文字，应该回到 producer 端重新生成。

**Q: 如果 slide HTML 内引用了外部 CDN（如 Google Fonts），平台 offline 模式怎么办？**
A: Producer 默认不打包外部资源。平台**可以**在上传时检测外部引用、提示用户、或自动 mirror 到平台 CDN。这是 producer / 平台双方都可优化的点，不是 schema 范围内的问题。

**Q: 同一个用户上传同 ID 的 deck，是覆盖还是版本化？**
A: schema 没强制要求。推荐版本化（保留历史），UI 上显示 v1 / v2 / v3，回滚成本低。

**Q: 批注能跨 deck 复用吗？**
A: 不能。批注 key 是 `(deckId, userId, slideIdx)`，跨 deck 没意义——slide 内容不同，批注位置也不同。

**Q: 平台能给 deck 二次签名 / 水印吗？**
A: 能。Plat 接管渲染层后，可以在 overlay 上加水印 / 元数据，不影响 manifest 内容。但**不要修改包内文件**——破坏完整性校验。

**Q: slidestage@1.0 何时升 v2？**
A: 当出现 breaking change 需求（比如重新设计 stroke 数据格式 / 加非可选字段 / 改 architecture 语义）。到那时本文档会更新到 v2 spec，slidestage@1.x 仍长期受支持。

### 15.2 术语表

| 术语 | 含义 |
|---|---|
| **producer** | 生成 `.stage` 包的工具，目前是 `pack_deck.mjs` |
| **consumer / 平台** | 读取并渲染 `.stage` 包的运行时 |
| **stage** | logical canvas 的别名（如 1920×1080），与 viewport 区分 |
| **slide** | deck 中一页 HTML |
| **stroke** | 演示工具下一笔批注（pen 或 highlighter） |
| **overlay** | 平台插在 iframe 上方的批注层 / 工具栏层 |
| **fallback** | 包内 `index.html` + `presenter_tools.js`，本地双击演讲用，平台忽略 |
| **schema** | manifest.json 的版本，目前 `slidestage@1.0` |
| **zip slip** | 攻击者在 zip 中放 `../../etc/passwd` 试图覆盖系统文件 |
| **zip bomb** | 极小 zip 解压成超大文件，攻击磁盘 |

### 15.3 相关文档

- 本 skill 整体能力：`SKILL.md`
- 制作 deck 的 agent 视角：`references/slide-decks.md`
- 演示工具 9 件套实现细节：`assets/presenter_tools.js` 文件头注释
- producer 实现细节：`scripts/pack_deck.mjs`
- 端到端测试：`scripts/test_pack_deck.mjs`

---

**spec version**: v1.0 · **last updated**: 2026-04-29

如对本文档有歧义、想反馈、或想申请加 schema 字段：在 huashu-design skill repo 提 issue 或直接改本文档（保留 changelog）。
