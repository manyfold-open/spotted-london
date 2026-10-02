# London Pop-ups Platform — Product & Technical Spec (v0.1)

> 狀態：Draft · 日期：2026-09-30 · 範圍：MVP（前端 UI/UX 另案設計）

---

## 1. 概述

### 1.1 問題
倫敦 pop-up（Food & Drink、Supper Clubs & Residencies、Markets & Fairs、Exhibitions、Art Pop-ups、Events & Festivals、Fashion、Sample Sale、Beauty、Tech、Other）資訊散落在 IG、TikTok、Time Out、Eventbrite 與口耳相傳之間：
- 找不到「**今天 / 這週末 / 我附近**」有什麼
- 文章式內容很快過期，不知道活動還在不在、是不是真的
- 免費、非售票的 pop-up 幾乎沒有平台收錄

### 1.2 解法
一個 **UGC + 社群驗證** 的 pop-up 平台：任何人都能上傳，透過 **Admin 審核** 與 **社群投票（類 Reddit）** 雙軌驗證，搭配地圖、時間篩選、收藏提醒與每週 newsletter。

### 1.3 定位
「倫敦 pop-up 的 Reddit + Google Maps」——只做短期活動、即時、社群驗證、免費與付費活動都收。

### 1.4 目標（MVP 上線後 3 個月）
| 指標 | 目標 |
|---|---|
| 已上架且驗證的 pop-up | ≥ 300 |
| 用戶上傳佔比（非 admin） | ≥ 40% |
| Newsletter 訂閱 | ≥ 2,000 |
| WAU | ≥ 1,500 |
| 驗證準確率（verified 後被檢舉成立比例） | ≤ 3% |

### 1.5 Non-goals（MVP 不做）
- 票務 / 金流 / 預約
- 主辦方付費 dashboard、Featured listing
- 原生 App（先做 Web + PWA）
- 留言區、私訊
- 倫敦以外城市
- AI 自動爬蟲匯入（Phase 3）

---

## 2. 使用者角色

| 角色 | 說明 | 權限 |
|---|---|---|
| **Visitor** | 未登入 | 瀏覽、搜尋、地圖、訂閱 newsletter |
| **User** | 已登入 | + 上傳、投票、check-in、收藏、檢舉 |
| **Organizer** | 已認領主辦方身份的 User（Phase 2） | + 編輯自己的活動、官方徽章 |
| **Admin** | 平台管理員 | + 審核佇列、覆寫狀態、封鎖用戶、調整 karma |

---

## 3. 功能需求

### 3.1 瀏覽與探索（P0）
- **列表頁**：預設顯示「進行中 + 未來 7 天」，依 `hot` 排序
- **篩選**：
  - 時間：Today / This weekend / This week / 自選日期
  - 類別：Food & Drink、Supper Clubs & Residencies、Markets & Fairs、Exhibitions、Art Pop-ups、Events & Festivals、Fashion、Sample Sale、Beauty、Tech、Other
  - 區域：Borough / 區塊（Soho、Shoreditch、Covent Garden…）
  - 驗證狀態：只看 verified
  - 免費 / 付費
- **地圖檢視**：地圖 pin，依目前視窗範圍載入
- **附近**：用瀏覽器定位，顯示 X km 內
- **搜尋**：標題 / 描述 / 主辦方關鍵字
- **詳情頁**：標題、圖片、時間、地址（導航連結）、來源連結、類別、驗證徽章、真實性信心、熱度票數、check-in 數、上傳者
- **SEO**：每個 pop-up 為 SSR 靜態頁，含 schema.org `Event` 結構化資料；區域/類別落地頁（例：`/soho/this-weekend`）

**驗收條件**
- 已結束（`end_at < now`）活動不出現在列表與地圖，但詳情頁仍可存取並標示「已結束」
- 列表 API p95 < 300ms

### 3.2 上傳 Pop-up（P0）
欄位：

| 欄位 | 必填 | 規則 |
|---|---|---|
| 標題 | ✅ | 3–100 字 |
| 類別 | ✅ | 單選 |
| 地點 | ✅ | 地址自動補完 → lat/lng、borough、geohash |
| 開始 / 結束時間 | ✅ | 結束 > 開始；最長 90 天；開始不得早於 7 天前 |
| 圖片 | ✅ | 1–5 張，≤ 5MB，存 R2 |
| 來源連結 | 建議 | IG / 官網 / Eventbrite；有填者信任加分 |
| 描述 | ⬜ | ≤ 2000 字 |
| 價格 | ⬜ | Free / Paid / 價格文字 |
| 營業時段 | ⬜ | 每日時段（文字，MVP） |

流程：
1. 填表 → Turnstile 驗證 → 送出
2. **重複偵測**：同 geohash(6) 範圍 + 日期重疊 + 標題相似度 > 0.8 → 提示「是這個嗎？」，用戶可選擇改為投票/補充
3. 依上傳者 `trust` 決定初始狀態（見 §4.4）
4. 上傳者可在 `pending` / `community` 狀態下編輯；編輯重大欄位（地點、日期）會重置真實性投票

**限制**：帳號 < 7 天每日最多上傳 3 則；一般用戶每日 10 則。

### 3.3 驗證與投票（P0）
詳見 §4。用戶介面包含：
- ✅ 確認存在 / ❌ 假的或已取消（真實性票）
- 👍 / 👎（熱度票）
- 📍「我在現場」check-in（需定位，可附照片）
- 🚩 檢舉（原因：不存在、已取消、資訊錯誤、重複、垃圾/廣告、不當內容）

### 3.4 帳號（P0）
- 登入：Google OAuth、Email magic link（MVP 不做密碼）
  - Magic link：單次使用、15 分鐘過期；連結先開確認頁、按按鈕（POST）才登入，避免信箱掃描器用掉；每個 email 每小時 3 封、每個 IP 每小時 10 封
  - Google：authorization code + PKCE + state cookie；同 email 的既有帳號自動連結，不重複開帳號
  - Session：HttpOnly、SameSite=Lax cookie，30 天；資料庫只存 session 與登入 token 的 SHA-256
  - CSRF：帶 session cookie 的寫入請求，Origin 不是本站就拒絕
  - 顯示名稱可自訂（不可含 email 或連結），email 永不公開
- 個人頁：karma、上傳紀錄、收藏、徽章
- 刪除帳號（GDPR）：刪除個資，貼文匿名化保留

### 3.5 收藏與提醒（P0）
- 收藏 pop-up
- 提醒：活動開始前 24 小時 Email；結束前 24 小時「最後一天」提醒（可關閉）
- PWA Web Push（P1）

### 3.6 Newsletter（P0）
- 首頁與詳情頁的訂閱入口（不需登入）
- 每週四寄出「This Weekend in London Pop-ups」：本週末 hot top 10 + 新上架 verified
- MVP：Cron 產生內容草稿 → Admin 在後台編輯 → 寄送
- 雙重確認訂閱（double opt-in）、一鍵退訂

### 3.7 Admin 後台（P0）
- **審核佇列**：pending、被自動 hidden、檢舉中；依優先度排序
- 對單則 pop-up：Approve（→ verified_admin）/ Reject（→ removed，附原因）/ Hide / 編輯 / 合併重複
- 用戶管理：查看 karma_log、手動調整 karma、封鎖（shadowban / ban）
- 可疑投票警示列表（投票環、同 IP 群組）
- Newsletter 編輯與寄送
- 所有 admin 動作寫入 `audit_log`

### 3.8 AI 貼連結自動填表（P0）
目的：降低上傳門檻。多數 pop-up 資訊都在 IG / TikTok / Eventbrite 貼文裡，讓用戶「貼連結 → 檢查 → 送出」，不用手打。

**輸入（三選一）**
1. 連結（IG、TikTok、Eventbrite、官網）
2. 貼上貼文文字（caption）
3. 上傳截圖（IG 常擋預覽，這是最可靠的備援）

**處理流程（Worker）**
1. URL 正規化 + 白名單網域判斷
2. `fetch` 頁面 → **先用確定性解析**：JSON-LD `Event` schema、Open Graph（`og:title`、`og:description`、`og:image`）。Eventbrite / 官網多半到這步就夠了
3. 解析不足 → 把可讀文字（≤ 8k 字元）丟給 **Workers AI 文字模型（JSON mode）**；截圖走 **Workers AI 視覺模型**
4. 後處理（確定性）：
   - 日期正規化為 Europe/London，補年份（「this Sat」→ 依今天推算）
   - 地點 → Mapbox Geocoding → lat/lng、borough；落在大倫敦範圍外 → 標記
   - 類別限制在 enum 內
   - 跑重複偵測（§3.2）
5. 回傳每個欄位的值 + `confidence: high | check`

**輸出 schema**
```json
{
  "title": "...", "host": "...", "category": "food",
  "address": "...", "start_date": "2026-10-02", "end_date": "2026-10-09",
  "hours_text": "...", "price_text": "...", "description": "...",
  "image_url": "...",
  "confidence": { "end_date": "check", "address": "high", "...": "..." },
  "source": "json_ld | og | llm_text | llm_vision"
}
```

**UI 規則**
- AI 填的欄位用藍色標示（Sketchbook 的 AI 色），`check` 欄位加「Check this」標籤
- 用戶手動改過的欄位就移除 AI 標示
- AI **只填表、不送出**，一定由用戶按 Submit；送出後照一般驗證流程走（AI 填的不會加信任分）
- 失敗時顯示明確原因 + 備援：「讀不到這個連結，上傳截圖或自己填」

**限制與成本**
- Rate limit：每人每天 10 次（新帳號 3 次），Turnstile 保護
- 快取：同一 URL 的結果存 KV 24 小時
- Workers AI 免費額度每天有上限 → 超過時降級成「只做 JSON-LD / OG 解析」
- IG / TikTok：伺服器端 fetch 常被擋或拿不到 caption → UI 預設引導「貼文字或截圖」；官方 oEmbed API 需要 Meta app 審核，列為之後的改善項
- 不儲存抓取的原始頁面，只存用戶最後送出的欄位 + `source_url`

**驗收條件**
- Eventbrite 或含 JSON-LD 的官網連結：標題 / 日期 / 地點正確率 ≥ 90%
- IG 截圖：標題 + 日期正確率 ≥ 75%
- p95 回應時間 < 6 秒；失敗時 UI 在 10 秒內給出備援

### 3.9 Mobile first（P0）
手機是主要使用情境（在街上找、到現場 check-in），所有頁面先設計手機版。
- **導航用底部 tab bar，不用 hamburger**：Explore / Map / **Add（中間凸起）** / Saved / Me。最常用的 5 個功能單手一點就到；hamburger 會把功能藏起來，降低使用率
- 較少用的功能（審核佇列、newsletter、通知設定、角色）收在 **Me** 頁
- 篩選用可橫向滑動的 chip 列（時間一列、類別一列）
- 詳情頁用 **bottom sheet**，底部固定 Save / Directions
- 地圖頁：地圖 + 下方可滑動的卡片列，點 pin 跳到對應卡片
- 「Happening now」橫向輪播放在 Explore 最上方
- 桌機版：左側 sidebar + 右側 drawer

### 3.10 Phase 2 / 3（僅列出，不在 MVP）
- P2：主辦方 claim、現場回報（排隊時間）、用戶照片牆、追蹤類別/主辦方通知、留言
- P3：主辦方付費 dashboard、Featured listing、票務/候補、AI 爬蟲匯入、空店面媒合、其他城市

---

## 4. 驗證與 Karma 系統

### 4.1 狀態機

```
draft → pending ─(trust ≥ 50 自動)─→ community ─(信心達標)─→ verified_community
          │                             │
          ├─ admin approve ─→ verified_admin ←─ admin 可隨時覆寫任何狀態
          │                             │
          └─ admin reject ─→ removed    └─(信心過低/檢舉過多)─→ hidden ─admin─→ 恢復 / removed

任何非 removed 狀態，end_at < now → ended（Cron）
```

| 狀態 | 公開列表 | 徽章 |
|---|---|---|
| pending | ❌（僅上傳者 + admin；「新提交」頁 P1） | — |
| community | ✅ | 「社群確認中」 |
| verified_community | ✅ | ✅ Community verified |
| verified_admin | ✅ | 🛡️ Verified |
| hidden | ❌ | — |
| removed | ❌ | — |
| ended | ❌（詳情頁可看） | 「已結束」 |

### 4.2 投票權重

```
weight = base(karma) × age_factor × proof_factor

base(karma) = karma < 0 ? 0.2 : clamp(1 + log10(max(karma,1)), 0.2, 4)

age_factor:  帳號 < 24h → 0 ; < 7d → 0.5 ; ≥ 7d → 1.0
             email 已驗證 × 1.2

proof_factor（僅真實性票）:
  有效 check-in（距離 ≤ 200m 且在活動時段內）→ × 3
  附現場照片 → 再 × 1.5
  一般投票 → × 1
```
- 權重在投票當下計算並寫入 `votes.weight`（避免 karma 變動回溯影響歷史）
- 同一 IP hash 的多帳號對同一 pop-up，只取權重最高的一票計入

### 4.3 社群驗證判定（Wilson lower bound）

```
n = exist_pos + exist_neg        (加權)
p = exist_pos / n
z = 1.28
confidence = (p + z²/(2n) − z·√(p(1−p)/n + z²/(4n²))) / (1 + z²/n)
```

| 條件 | 動作 |
|---|---|
| confidence ≥ 0.75 且 n ≥ 8 且（有效 check-in ≥ 1 或 不同投票者 ≥ 3） | community → verified_community |
| confidence ≤ 0.30 且 n ≥ 5 | → hidden，進審核佇列 |
| report_weight ≥ 5 | → hidden，進審核佇列 |
| 活動尚未開始 | check-in 條件不適用，改需 不同投票者 ≥ 5 |

- verified_community 若之後 confidence 跌破 0.5 → 退回 community 並通知 admin
- verified_admin 不受社群投票自動影響，只會觸發 admin 通知

### 4.4 上傳者信任分

```
trust = karma × 0.5
      + verified_posts × 5
      − hidden_or_removed_posts × 15
```
另外，該則有 source_url（IG/官網/Eventbrite）時 +10（只影響這一則）。
- `trust + source_bonus ≥ 50` → 跳過 pending 直接進 community
- Organizer 發自己的活動 → 直接 verified_admin（P2）

### 4.5 Karma 規則

| 事件 | Δ karma | 結算時機 |
|---|---|---|
| 上傳的 pop-up 變為 verified（任一種） | +10 | 狀態變更時 |
| 上傳的 pop-up 被 removed / 最終 hidden | −20 | 狀態變更時 |
| 真實性票與最終結果一致 | +1 | 活動 ended 或 admin 裁定後（每日 Cron） |
| 真實性票與最終結果相反 | −2 | 同上 |
| 有效 check-in | +2 | 即時 |
| 現場照片被採用 | +3 | admin 採用時 |
| 檢舉成立 / 不成立 | +3 / −1 | admin 處理時 |
| 貼文每累積 10 個 👍 | +1（每篇上限 +20） | 每日 Cron |

- 所有變動寫入 `karma_log`，`users.karma` 為快取值，可由 log 重算
- 單一用戶每日 karma 增加上限 +50（防刷）

### 4.6 Hot 排序（在 Worker 計算）

```
q      = quality_pos − quality_neg
order  = log10(max(|q|, 1)) × sign(q)
bonus  = verified_admin ? 2 : verified_community ? 1 : 0
live   = 進行中 ? 1.5 : 0
decay  = 未開始 ? hours_until_start / 48 : 0
hot    = order + bonus + live − decay
```
每 10 分鐘由 Cron 重算未結束的 pop-up；投票時即時更新該筆。

### 4.7 防濫用
- Cloudflare Turnstile：註冊、上傳、檢舉
- Rate limit（Workers Rate Limiting binding 或 Durable Object）：投票 50/日（新帳號）、200/日（一般）；上傳見 §3.2
- IP hash（`sha256(cf-connecting-ip + salt)`，不存原始 IP）
- 投票環偵測（每日 Cron）：A、B 帳號互投對方貼文重疊率 > 70% 且次數 ≥ 5 → 標記
- Shadowban：被 shadowban 的用戶操作照常成功，但權重為 0、貼文只有自己看得到

---

## 5. 技術架構（Cloudflare 全家桶）

```
[Browser / PWA]
      │
      ▼
[Cloudflare Workers]  ← 前端 SSR（框架待定，e.g. React Router v7 / Hono JSX）+ API
      │
      ├── D1           主資料庫
      ├── R2           圖片（前端上傳前先壓縮成 WebP ≤ 1600px + 400px 縮圖，不用付費 Images）
      ├── KV           快取（熱門列表、設定）、session
      ├── Durable Obj  rate limit 計數（若 Rate Limiting binding 不足）
      ├── Queues       非同步：寄信、重算分數
      ├── Cron Trigger */10 重算 hot + ended；每日 karma 結算、反作弊掃描；週四 newsletter 草稿
      └── Turnstile    人機驗證

[外部免費服務]
      ├── 地圖         MapLibre GL + OpenFreeMap 圖磚（免費、免 API key）
      ├── 地址補完     Mapbox Geocoding 免費額度（備援：Nominatim）
      ├── 交易信       Resend 免費方案（magic link、提醒）
      └── Newsletter   Beehiiv 免費方案（≤ 2,500 訂閱者，之後可接其贊助市集）
```

### 5.0 成本（Free tier 策略）
- 目標：MVP 至 ~6–12 個月維持 **$0 / 月**，唯一固定支出為網域（約 £10 / 年）
- 最大限制：Workers Free 每 request CPU 約 10ms → 頁面保持輕量、列表結果放 KV 快取、重運算（hot、Wilson、karma 結算）放 Cron
- 升級觸發點：
  | 觸發 | 動作 | 成本 |
  |---|---|---|
  | CPU 超時 / requests > 10 萬/天 | Workers Paid | ~$5 / 月 |
  | Newsletter > 2,500 人 | Beehiiv 付費或改自建 | 此時應已可接贊助 |
  | 交易信 > 100 封/天 | Resend 付費或 Cloudflare Email Service | 依量計價 |
- ⚠️ 各服務額度以官網最新公告為準，開發前重新確認

### 5.1 地理查詢（D1 無 PostGIS）
- 寫入時計算 `geohash`（precision 7）
- 附近查詢：算出中心點 geohash(5 或 6) 及 8 個鄰格 → `WHERE geohash_prefix IN (...)` → Worker 端用 haversine 精算距離與排序
- 地圖視窗：`lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`（有 index）

### 5.2 D1 注意事項
- 數學運算（log、sqrt）一律在 Worker JS 端完成，結果寫回快取欄位
- 投票寫入用 `db.batch()`：upsert vote + update popup 計數，確保一致
- 時間一律存 Unix ms（INTEGER），顯示時轉 Europe/London
- Migration 用 `wrangler d1 migrations`

---

## 6. 資料模型（D1）

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT,
  avatar_key TEXT,
  role TEXT NOT NULL DEFAULT 'user',          -- user | organizer | admin
  karma INTEGER NOT NULL DEFAULT 0,
  trust INTEGER NOT NULL DEFAULT 0,
  verified_posts INTEGER NOT NULL DEFAULT 0,
  bad_posts INTEGER NOT NULL DEFAULT 0,
  email_verified INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',      -- active | shadowbanned | banned | deleted
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);

CREATE TABLE popups (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,
  price_type TEXT,                             -- free | paid | unknown
  price_text TEXT,
  address TEXT, borough TEXT,
  lat REAL NOT NULL, lng REAL NOT NULL, geohash TEXT NOT NULL,
  start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
  hours_text TEXT,
  source_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_by TEXT NOT NULL REFERENCES users(id),
  exist_pos REAL NOT NULL DEFAULT 0,
  exist_neg REAL NOT NULL DEFAULT 0,
  voter_count INTEGER NOT NULL DEFAULT 0,
  checkin_count INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL DEFAULT 0,
  quality_pos INTEGER NOT NULL DEFAULT 0,
  quality_neg INTEGER NOT NULL DEFAULT 0,
  hot REAL NOT NULL DEFAULT 0,
  report_weight REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_popups_list ON popups(status, end_at, hot DESC);
CREATE INDEX idx_popups_geo  ON popups(geohash);
CREATE INDEX idx_popups_box  ON popups(lat, lng);
CREATE INDEX idx_popups_user ON popups(created_by);

CREATE TABLE popup_images (
  id TEXT PRIMARY KEY, popup_id TEXT NOT NULL REFERENCES popups(id),
  r2_key TEXT NOT NULL, position INTEGER NOT NULL, uploaded_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE votes (
  user_id TEXT NOT NULL, popup_id TEXT NOT NULL,
  kind TEXT NOT NULL,                          -- existence | quality
  value INTEGER NOT NULL,                      -- 1 | -1
  weight REAL NOT NULL,
  ip_hash TEXT,
  settled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, popup_id, kind)
);
CREATE INDEX idx_votes_popup ON votes(popup_id, kind);

CREATE TABLE checkins (
  user_id TEXT NOT NULL, popup_id TEXT NOT NULL,
  lat REAL, lng REAL, distance_m REAL,
  photo_key TEXT, valid INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, popup_id)
);

CREATE TABLE reports (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, popup_id TEXT NOT NULL,
  reason TEXT NOT NULL, note TEXT, weight REAL NOT NULL,
  resolution TEXT,                             -- null | upheld | rejected
  created_at INTEGER NOT NULL
);

CREATE TABLE saves (
  user_id TEXT NOT NULL, popup_id TEXT NOT NULL,
  remind INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, popup_id)
);

CREATE TABLE karma_log (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
  delta INTEGER NOT NULL, reason TEXT NOT NULL, ref_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_karma_user ON karma_log(user_id, created_at);

CREATE TABLE subscribers (
  email TEXT PRIMARY KEY, confirmed INTEGER NOT NULL DEFAULT 0,
  token TEXT NOT NULL, created_at INTEGER NOT NULL, unsubscribed_at INTEGER
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY, admin_id TEXT NOT NULL, action TEXT NOT NULL,
  target_type TEXT, target_id TEXT, detail TEXT, created_at INTEGER NOT NULL
);
```

---

## 7. API（REST，`/api/v1`）

| Method | Path | Auth | 說明 |
|---|---|---|---|
| GET | `/popups` | — | 列表；query: `when, category, borough, free, verified, bbox, near, q, cursor` |
| GET | `/popups/:slug` | — | 詳情 |
| POST | `/popups` | User + Turnstile | 建立；回傳重複候選 |
| PATCH | `/popups/:id` | 上傳者 / Admin | 編輯 |
| POST | `/popups/:id/images` | User | 取得 R2 presigned upload |
| PUT | `/popups/:id/vote` | User | body: `{kind, value}`；value=0 取消 |
| POST | `/popups/:id/checkin` | User | body: `{lat, lng, photo?}` |
| POST | `/popups/:id/report` | User + Turnstile | body: `{reason, note}` |
| PUT/DELETE | `/popups/:id/save` | User | 收藏 |
| GET | `/me` · `/me/saves` · `/me/popups` | User | 個人資料 |
| DELETE | `/me` | User | 刪除帳號 |
| GET | `/users/:id` | — | 公開個人頁 |
| POST | `/auth/magic-link` · GET `/auth/callback` · GET `/auth/google` | — | 登入 |
| POST | `/newsletter/subscribe` · GET `/newsletter/confirm` · GET `/newsletter/unsubscribe` | — | 訂閱 |
| GET | `/admin/queue` | Admin | 審核佇列 |
| POST | `/admin/popups/:id/decision` | Admin | `{action: approve|reject|hide|restore|merge, reason, merge_into?}` |
| POST | `/admin/users/:id/action` | Admin | `{action: shadowban|ban|unban|adjust_karma, delta?}` |
| POST | `/admin/reports/:id/resolve` | Admin | `{resolution}` |

錯誤格式：`{ error: { code, message } }`；列表用 cursor 分頁。

---

## 8. 非功能需求
- **效能**：列表/詳情 API p95 < 300ms；熱門列表 KV 快取 60s
- **可用性**：依賴 Cloudflare SLA；D1 每日自動備份（Time Travel）
- **隱私 / GDPR**（UK GDPR）：不存原始 IP；check-in 座標 30 天後刪除，只保留 distance 與 valid；Cookie 只用必要 session cookie；隱私政策與刪除帳號功能
- **內容政策**：禁止非法活動、仇恨、成人內容；檢舉流程
- **可觀測性**：Workers Logs + Analytics Engine（投票量、上傳量、驗證轉換率）
- **在地化**：UI 英文為主；時區 Europe/London

---

## 9. 營運與冷啟動
1. 上線前 admin 手動建立 100+ 則真實 pop-up（全部 verified_admin）
2. 招募 20–30 位「種子 spotter」（倫敦 IG 帳號、學生），初始 karma 100
3. 推廣管道：r/london、FB/WhatsApp 社群、IG「本週 pop-up」貼文導流至 newsletter
4. Admin 每日審核 SLA：pending < 12 小時

---

## 10. 商業模式路線（參考，非 MVP 開發範圍）
| 階段 | 收入 |
|---|---|
| 0–6 月 | 無，衝內容與訂閱 |
| 6–12 月 | Newsletter 贊助、Featured listing |
| 12 月+ | 主辦方 SaaS（analytics、候補名單）、策展市集、票務抽成、在地店家會員折扣 |
| 長期 | 數據報告（地產/品牌）、空店面媒合、多城市 |

---

## 11. 里程碑

| 週 | 交付 |
|---|---|
| W1 | 專案骨架（wrangler、D1 migration、auth）、UI/UX 設計定稿 |
| W2 | 上傳流程（R2 圖片、geohash、重複偵測）、**AI 貼連結自動填表**、列表 / 詳情 API |
| W3 | 投票 / check-in / 檢舉 + 權重 & Wilson 計算 + Cron |
| W4 | 地圖、篩選、收藏提醒、Admin 後台 |
| W5 | Newsletter、SEO 頁、反作弊、karma 結算 |
| W6 | 冷啟動內容建立、內測（30 人）、修正 → 公開上線 |

---

## 12. 決策紀錄
| 項目 | 決定 |
|---|---|
| 後端 | Cloudflare Workers + D1 + R2 + KV + Cron（全 Free tier） |
| 前端框架 | Vite + React SPA（React Router、TanStack Query），由同一個 Worker 以靜態檔提供；`/p/:slug` 由 Worker 用 HTMLRewriter 注入 SEO / OG / schema.org（不做 React SSR，避免 Free tier 每 request 10ms CPU 上限） |
| 地圖 | MapLibre + OpenFreeMap |
| 地址補完 | Photon（OpenStreetMap，免 API key），經 `/api/v1/geocode` 代理並用 Cache API 快取一天；流量大時再換 Mapbox |
| Newsletter | Beehiiv 免費方案 |
| 交易信 | Resend 免費方案 |
| 圖片處理 | 前端壓縮，不用 Cloudflare Images |
| AI 自動填表 | Workers AI（2026-09-30 接上）。文字：`@cf/meta/llama-3.3-70b-instruct-fp8-fast`；截圖：`@cf/meta/llama-4-scout-17b-16e-instruct`（吃 base64 圖片、支援 JSON schema）。截圖在前端縮成長邊 1600px 的 JPEG 再上傳（≤ 2 MB），伺服器不存圖。免費額度用完回 503 `ai_quota`，請用戶自己填 |
| 表單元件 | 全部自製，不用瀏覽器原生 UI：日期選擇器（英式格式、週一開始、手機為底部 sheet）、搜尋清除鈕、Email 驗證訊息、捲軸、地圖縮放鈕 |
| 部署 | https://spotted-london.zack11712.workers.dev（2026-09-30 上線；Google 登入、照片（R2）已開啟；Email 登入待設定 Resend） |
| 範例資料 | 已於 2026-10-02 用 `seed/clear-examples.sql` 從線上清除（9 個虛構活動、165 個假帳號）。`is_example` 欄位與 Example 標示保留，之後要用範例資料可重新載入 `seed/examples.sql` |
| 設計系統 | "Sketchbook"（紙張 + 墨線 + 硬陰影 + 單一橘色 accent） |
| AI agents | 跑在 **Manyfold**（不在 Cloudflare 上，不吃 Workers AI 額度）。三個：Scout 找新活動送草稿、Triage 幫審核佇列寫判斷、Checker 複查已上架活動。Spotted 用 A2A 啟動（cron 排程或 admin 按 Run now），agent 透過 `/mcp` 用各自的 key 回寫。**只能寫草稿與備註**，發布與否一律 admin 決定。設定頁 `/admin/agent`（2026-09-30） |
| Scout 資料庫 | Scout 有來源清單（`scout_sources`）與讀過頁面的紀錄（`scout_seen`），活動可掛多個連結（`popup_links`）。Scout 只能建議新來源，啟用由 admin 決定；IG/TikTok/小紅書只透過搜尋找公開貼文、存連結當補充證據，不登入不爬取（2026-10-01） |
| MCP | `POST /mcp`，無狀態 Streamable HTTP、手寫 JSON-RPC（不用 SDK）。無 key：`search_popups`、`get_popup` 給任何人的 AI 助手用；有 key：依 agent 角色多開工具 |
| Icons | [Koboyo hand-drawn icons](https://koboyo.com/icons)：手繪風格 SVG，`fill="currentColor"`，商用免費、免標註。限制：不可把 icon 當成產品功能讓用戶挑選或下載，也不可重新散布整套 icon 庫 |
| 分類 | 11 類，每個活動一類：`food`、`dining`（主廚駐店與晚宴）、`market`（市集與藝博會）、`exhibition`（畫廊與美術館展覽）、`art`（一次性裝置與公共藝術）、`event`、`fashion`、`sample`、`beauty`、`tech`、`other`。清單只寫在 `src/shared/categories.ts`；新增一類要同時加 migration、icon、封面圖案。Scout 與 Triage 的判斷規則在 `skills/spotted-london/SKILL.md`。新分類的 icon 是自繪的線條圖，不是 Koboyo。設計：`docs/superpowers/specs/2026-10-02-category-split-design.md` |
| 收錄範圍 | 只要活動本身是限時的就收，不管場地是不是常設：博物館 Lates、常設餐廳的一晚限定晚宴或限期菜單、藝術博覽會都算。不收常駐的東西（固定菜單、常設館藏、沒有結束日的固定派對）。Scout 的 `confidence: high` 改為：主辦或場地頁面確認日期與地點，或兩個獨立頁面一致；缺營業時間或價格不影響。描述裡每個細節都要在讀過的頁面上（2026-10-02） |
| 舊草稿特例 | migration 0007 之前送的 Scout 草稿沒有 `evidence_check`，只要 Triage 自己引用的原文在網頁上找到、日期地點都對，就算 ready，不看 Scout 的原文與信心。這些草稿每天回到 Triage 佇列一次，直到 Triage 的 note 附上自己的引用原文為止（2026-10-02） |

### 待決問題
1. 是否 MVP 就開放「pending 新提交」頁給高 karma 用戶協助審核？
2. 品牌名稱與網域（prototype 暫名 "Spotted"）
3. ~~AI 助手是否納入 MVP~~ → 已決定：貼連結自動填表納入 MVP（§3.8），其他 AI 功能放 Phase 1.5

---

## 13. 背景自動化 / AI 助手

### 13.1 MVP：不需要 AI agent
驗證、karma、排序都是規則明確的計算，用 **Cron Trigger + Queues** 跑確定性程式即可，便宜、可預測、可稽核。

| Job | 頻率 | 內容 |
|---|---|---|
| `recompute-hot` | 每 10 分鐘 | 重算未結束 pop-up 的 hot；end_at 過期 → ended |
| `settle-karma` | 每日 04:00 | 結算已結束/已裁定 pop-up 的投票 karma |
| `abuse-scan` | 每日 | 投票環、同 IP 群組偵測 → 標記給 admin |
| `reminders` | 每小時 | 開始前 24h / 最後一天提醒信 |
| `newsletter-draft` | 週三 | 產生本週末 top 10 草稿給 admin 編輯 |
| `purge-geo` | 每日 | 刪除 30 天前 check-in 座標 |

### 13.2 AI 助手（Workers AI 免費額度）
不是一個自主跑的 agent，而是幾個 **掛在事件上的 LLM 函式**，結果一律給人審：

1. **上傳輔助（MVP，已納入 §3.8）**：貼連結 / 文字 / 截圖 → 自動填表
2. **審核分診（Phase 1.5）**：新 pending 進來時打分 + 標記風險（無來源、日期不合理、疑似廣告、疑似重複），排序 admin 佇列
3. **Newsletter 文案（Phase 1.5）**：把本週 top 10 寫成 newsletter 草稿

### 13.3 Phase 3：內容匯入 agent
定時掃描白名單來源（Eventbrite 公開 API、主辦方官網、合作帳號）→ 產生 draft → 走正常審核流程。可用 Cloudflare Agents SDK + Cron。需注意各平台 ToS（IG 不可爬）。
→ 已由 §13.4 的 Scout agent 取代（改跑在 Manyfold）。

### 13.4 Manyfold agents（2026-09-30 實作）
| Agent | 預設排程 | 做什麼 | 能寫什麼 |
|---|---|---|---|
| Scout | 每天 07:00 | 在公開網頁找新 pop-up（Time Out、Secret London、場地 what's on 頁等） | `pending` 草稿（以「Scout agent」帳號發）＋一則附來源的備註 |
| Triage | 每 6 小時 | 讀審核佇列每則貼文、查來源與重複 | 備註：looks_real / needs_check / likely_fake / duplicate |
| Checker | 每天 09:00 | 複查進行中/即將開始的活動來源頁 | 備註：cancelled / details_changed / needs_check / looks_real（只是紀錄已查過） |

- **流程**：cron（每 10 分鐘）找出到期的 agent → A2A `message/send`（`blocking: false`，非同步）送出 brief（含 run id、上限、admin 指示）→ 立刻拿到 task id（不用連線等；blocking/stream 會被 Manyfold 的 10 分鐘上限砍掉，async 上限為 2 小時）→ 之後用 `tasks/get` 查狀態；3 小時沒結束算失敗。agent 做完呼叫 `finish_run` 留摘要。
- **連線**：每個 agent 卡片的「Connect with Manyfold」走 Manyfold 的 Connect A2A 授權（device-code 流程，類似 OAuth）：Spotted 發起 → admin 在 Manyfold 核對代碼、選 agent、按 Approve → Spotted 輪詢拿到該 agent 的 A2A 網址與 token。device code 只存在 Worker（加密放 KV 15 分鐘）。手動貼網址與 token 保留為備案（2026-09-30）。
- **權限**：每個 agent 有自己的 Spotted key（只存 SHA-256），只能用自己角色的工具；每次 run 有寫入上限（預設 20–30）。Manyfold caller token 用 `AGENTS_KEY` secret 做 AES-GCM 加密存 D1，API 只回傳末四碼。
- **審核佇列**：agent 備註顯示在該 pop-up 底下；已上架活動被標 cancelled / details_changed / likely_fake / duplicate / needs_check 會重新進佇列。admin 做決定或按 Dismiss 後備註結案。
- **安全**：網頁與貼文內容一律當資料不當指令（防 prompt injection，寫在 skill 裡）；不登入任何網站、不爬 IG/TikTok。
- **Agent 的知識**：`skills/spotted-london/SKILL.md`，從 GitHub 匯入 Manyfold 安裝。
- **Scout 的資料庫（2026-10-01，migration 0005）**：
  - `scout_sources` 來源清單：列表網站、場地 what's on 頁、品牌官網、社群帳號、搜尋關鍵字，各自設定幾天查一次。Scout 用 `list_sources` 取到期的來源、查完呼叫 `mark_source_checked`。Scout 只能 `suggest_source` 提建議（狀態 `suggested`），由 admin 決定是否啟用。
  - `scout_seen` 讀過的網址與結果（sent / duplicate / not_popup / ended / no_details…）。`check_seen` 讓 Scout 跳過 30 天內看過的頁面，`skip_url` 記錄沒送出的原因。沒送出的紀錄 90 天後由 cron 清掉；有送出草稿的保留，用來算來源的成績。
  - 來源成績（送出幾篇、上架幾篇、被拒幾篇）從草稿現在的狀態即時計算，不另存計數器。
  - `popup_links` 每個活動可以有多個連結（官網、場地、票務、文章、Instagram、TikTok、小紅書），社群連結從網址自動辨識。
  - 社群平台：只透過搜尋引擎找到公開貼文並存連結，不登入、不爬 feed、不用第三方爬蟲；日期與地點一定要在看得到的頁面（官網、場地、票務、文章）確認。
