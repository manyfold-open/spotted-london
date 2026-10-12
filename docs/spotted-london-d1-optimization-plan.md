# spotted-london：降低 D1 讀寫用量計畫

> 範圍：`tldr0810/spotted-london`（Cloudflare Worker + D1 + KV + R2，Workers 免費方案）。
> 本計畫依 2026-10-02 `main` 的程式碼寫成，**沒有看過 D1 實際用量**，所以第 0 步先量測。
> 參考範本：`manyfold-open/manyfold-data` 裡 Ying 的三個 commit（`52f07e3` 邊緣快取、`51e96d3` 整包資料集、`c760bce` 預先存好的資料集）。
> 專案規則（`CLAUDE.md`）：開分支、開 PR，由 Zack merge；有 migration 要在 PR 寫明，並先跑 `npx wrangler d1 migrations apply spotted-db --remote` 再 merge。

---

## 0. 背景與結論

### 免費額度（D1 每天）
- 讀：5,000,000 rows read
- 寫：100,000 rows written（**索引的寫入也算**）
- Worker CPU 約 10 ms／請求（所以不要在 Worker 裡解析大 JSON 或做篩選）
- KV 免費：每天 1,000 次寫入

### 目前的消耗點（從程式碼推估）

| # | 位置 | 問題 | 影響 |
|---|---|---|---|
| A | `src/cron.ts` `recomputeHot`（每 10 分鐘） | 先 `SELECT` 全部進行中的 pop-up，再對**每一筆**跑 `UPDATE popups SET hot = ?`。一天 144 次。`hot` 在索引 `idx_popups_list(status, end_at, hot DESC)` 裡，所以每次 UPDATE 還要寫索引 | N=500 時約 72,000+ 次寫入／天，**最先碰到上限** |
| B | `src/routes/popups.ts` `listPopups`（`GET /popups`） | `status IN (...) AND end_at > ? AND start_at < ? ORDER BY hot DESC`：`end_at` 是範圍條件，`hot` 排序用不上索引，要讀出全部符合的列再排序。`OFFSET` 翻頁會重讀。`q` 用 `LIKE '%…%'` 掃 3 欄。`near` 最多撈 500 筆再用 JS 過濾。每筆還有一個 `cover_key` 子查詢 | 每個請求讀 ≈ N 筆，且與訪客數成正比 |
| C | 同上，登入者 | `myState()` 多 2 條查詢（saves、votes）；`session` middleware 每個帶 cookie 的請求都查一次 users+sessions | 讓列表無法被不同使用者共用快取 |
| D | `src/cron.ts` `endExpired`、`settleKarma` 等 | 目前量小，無需先動 | 觀察即可 |

### 結論
1. **A（寫入）先修**，改動小、效益大。
2. **B/C（列表）改成「公開資料共用一份」**：列表不含個人狀態、改由前端合併；再進一步做快照。
3. 不要照搬 manyfold-data 的做法：這裡有個人化狀態、資料持續被投票改動、Worker CPU 只有 10 ms。

---

## 1. 重要前提（動手前先確認）

1. **`*.workers.dev` 上 Cache API 不生效**（Cloudflare 文件說明；請動手前再核對一次）。目前網址是 `spotted-london.zack11712.workers.dev`，所以「邊緣快取」要等綁**自訂網域**（`CLAUDE.md` 待辦第 4 項）才有用。因此本計畫的主力是 **D1 裡的快照（一行）**，它在 workers.dev 也有效；邊緣快取放在最後當加成。
2. **分支預覽共用 production 的 D1/KV/R2**（`CLAUDE.md` Production 一節）。預覽版跑到會寫入的程式時，寫的是正式資料庫。cron 只在 production 觸發，但手動打預覽網址的寫入路徑要小心。
3. **migration 要能與目前部署的程式共存**：只做新增（新表、新索引），不要改或刪舊欄位。
4. 目前 production 只有虛構範例資料（`is_example = 1`），所以這是上線前的準備，不是救火。

---

## 2. 第 0 步：量測基準（30 分鐘，不改程式）

目的：確認推估，之後才有「改前／改後」可以比。

```bash
cd spotted-london
unset CLOUDFLARE_API_TOKEN   # CLAUDE.md：Zack 的 shell 可能指向公司帳號，先確認 whoami 是個人帳號
npx wrangler whoami
npx wrangler d1 insights spotted-db --timePeriod 7d --sort-type sum --sort-by reads --limit 20
npx wrangler d1 insights spotted-db --timePeriod 7d --sort-type sum --sort-by writes --limit 20
```

也可以在 Cloudflare Dashboard → Workers & Pages → D1 → spotted-db → Metrics 看 rows read／written 曲線。

記下：
- 讀取前 5 名的查詢（預期是 `listPopups` 那條）與每天總 rows read
- 寫入前 5 名（預期是 `UPDATE popups SET hot = ?`）與每天總 rows written
- 目前有效 pop-up 數 N：`npx wrangler d1 execute spotted-db --remote --command "SELECT status, COUNT(*) FROM popups WHERE end_at >= strftime('%s','now')*1000 GROUP BY status"`

> 如果 insights 回傳空陣列（我試 manyfold-data 時就是），通常是剛過 00:00 UTC 重置、或沒登入對帳號。換看 Dashboard。

---

## 3. PR 1：修 `recomputeHot` 的寫入（約 0.5 小時）

### 現況
`src/cron.ts`：
```ts
case '*/10 * * * *':
  await endExpired(env.DB, now);
  await recomputeHot(env.DB, now);   // ← N 次 UPDATE，每 10 分鐘
```
`src/lib/scoring.ts` 的 `hot()`：時間相關的部分只有
- `decay = (startAt - now) / HOUR / 48`：還沒開始的 pop-up，每 10 分鐘變動約 0.0035
- `live`：開始／結束那一刻 ±1.5

所以大部分更新都是「變動極小的數字」，沒有實質意義。

### 改法
1. `recomputeHot` 的 `SELECT` 多選出 `hot`，算出新值後**只有 `|new - old| >= 0.01` 才 UPDATE**。
2. 把 `recomputeHot` 從 `*/10` 移到整點 cron（`0 * * * *`，已存在，目前只跑 `reminders`），或保留 10 分鐘但有門檻就不太會寫。建議移到整點，風險最低。
3. 注意 `hot` 在投票、打卡、狀態改變時，本來就由 `src/db/popups.ts` 的 `recompute()` 即時更新（約 40–44 行），這部分不用動。

### 範例（示意，非完整）
```ts
const { results } = await db.prepare(
  "SELECT id, status, quality_pos, quality_neg, start_at, end_at, hot FROM popups WHERE end_at >= ? AND status IN ('community','verified_community','verified_admin')",
).bind(now).all<...>();
const stmts = results.flatMap(p => {
  const h = hot({ ... }, now);
  return Math.abs(h - p.hot) >= 0.01
    ? [db.prepare('UPDATE popups SET hot = ? WHERE id = ?').bind(h, p.id)]
    : [];
});
```

### 驗收
- `test/lib.test.ts`（或新增 `test/cron.test.ts`）：建立幾筆資料，跑兩次 `recomputeHot`，第二次寫入數為 0（用 `meta.changes` 或比較 `updated` 計數）。
- 上線一天後，`insights --sort-by writes` 看 `UPDATE popups SET hot` 的寫入量，預期降 90% 以上。

---

## 4. PR 2：讓列表變成「所有人共用同一份」（約 0.5–1 天）

目標：`GET /popups` 的回應**不含任何個人資料**，之後才能快取或做成快照。

### 後端
1. `src/routes/popups.ts`
   - `listPopups(db, q, now, user)` 拿掉 `user` 參數與 `myState()` 呼叫，items 不再帶 `me`。
   - `src/mcp.ts:201` 已經傳 `null`，要一起改簽名。
2. `src/routes/me.ts` 新增 `GET /me/state`（需登入）：
   ```json
   { "saved": ["popId", ...],
     "votes": { "popId": { "existence": 1, "quality": 0 } } }
   ```
   - 只回「還有效」的 pop-up（`JOIN popups ON ... WHERE end_at > now - 7 天`），避免無限增長。
   - 查詢走 `saves` 與 `votes` 的 `user_id` 前綴，確認有索引（`idx_votes_popup` 是 `(popup_id, kind)`，**不含 user_id**；請 `EXPLAIN QUERY PLAN` 檢查，必要時新增 migration `0012`：`CREATE INDEX idx_votes_user ON votes(user_id, popup_id)`）。
3. `src/middleware.ts` 的 `session` 對每個請求都查 DB。**公開的 GET 列表不需要使用者**，可把 `GET /api/v1/popups`（及之後的 snapshot）排除在 `session` 之外（在 `src/index.ts` 的 `app.use('*', session, sameOrigin)` 前面對這條路徑直接回應，或在 `session` 裡對這條路徑略過查詢）。

### 前端
1. `web/src/lib/api.ts`：新增 `MyStateMap` 型別與 `getMyState()`。
2. `web/src/lib/hooks.tsx`：新增 `useMyState()`（`useQuery(['me','state'])`，已登入才 `enabled`，`staleTime` 1 分鐘）。
3. `web/src/pages/Explore.tsx` 的 `usePopups`：用 `select`（或在元件裡 `useMemo`）把 `useMyState()` 的資料以 `withMe` 合併進每個 item。
4. **最棘手的地方**：`web/src/lib/cache.ts` 的 `patchPopup` 現在是**改列表快取裡每個 pop-up 的 `me`** 來做 optimistic update。列表不再帶 `me` 之後，要改成同時 patch `['me','state']` 這份快取（投票、收藏、取消）。逐一檢查呼叫 `patchPopup`／`withMe` 的地方（`PopupSheet.tsx`、`PopupBits.tsx`、`Account.tsx`）。
5. 詳情頁 `GET /popups/:id` 仍然帶 `me`（含 `vote_weight`），不動。

### 可選：加快取標頭
- 回應加 `Cache-Control: public, max-age=60`（瀏覽器端快取，workers.dev 也有效），同樣的查詢 60 秒內不重打。
- 邊緣快取（`s-maxage`、Cache API）要等自訂網域，見第 7 節。

### 驗收
- `test/api.test.ts`：登入與未登入打 `GET /popups`，回應完全相同（無 `me`）；`GET /me/state` 回正確的 saved／votes。
- 手動：登入後 Explore、Map、Saved、投票、收藏、取消都正常；開 devtools 確認列表請求在登入與否時相同。

---

## 5. PR 3：公開列表快照（約 1–1.5 天）

### 要做的事（概念，參考 manyfold-data `c760bce`）
**cron 定時把「公開列表」算好，存成 D1 裡的一行；讀者只讀這一行；篩選、搜尋、排序都在瀏覽器裡做。**

### 5.1 Migration `0012_snapshots.sql`（新增，可與舊程式共存）
```sql
CREATE TABLE snapshots (
  key      TEXT PRIMARY KEY,   -- 'popups'
  version  TEXT NOT NULL,      -- 用於 ETag
  json     TEXT NOT NULL,
  built_at INTEGER NOT NULL
);
```
（若 PR 2 需要，另加 `idx_votes_user`。）

### 5.2 建立快照 `src/db/snapshot.ts`（新檔）
- `buildPopupSnapshot(db, now)`：
  - 一條查詢取出：`status IN PUBLIC_STATUSES AND end_at > now AND start_at < now + 90 天`，同時用 `LEFT JOIN`／子查詢一次帶出 `cover_key`（現在是每筆一個子查詢）。
  - 用既有的 `toPublic(row)`（`src/db/popups.ts`）轉成公開格式；**不含 `me`、不含 `posted_by`、不含 `images` 全部**，只留列表和地圖需要的欄位，控制大小。
  - **在 JS 裡用 `hot()` 算出當下的 `hot` 放進快照**（`hot` 是純函式）。這樣之後 DB 欄位 `hot` 就不用被 cron 一直寫（可選的進一步優化，見 5.6）。
  - 寫入：`INSERT ... ON CONFLICT(key) DO UPDATE SET version=?, json=?, built_at=?`。
- 大小保護：`json.length > 1_500_000`（D1 單列約 2 MB 上限）時**不寫入**、記 `console.error`，讀取端退回舊的 SQL 路徑（見 5.4）。
- `version`：用 `${built_at}-${count}` 之類即可，只拿來當 ETag。

### 5.3 何時重建
1. **cron**：`*/10 * * * *` 的最後（`endExpired`、`recomputeHot` 之後）呼叫一次。成本：每次讀 N 筆、寫 1 筆，一天 144 次，遠小於現在。
2. **立即重建**（用 `c.executionCtx.waitUntil(buildPopupSnapshot(...))`），在下列情況：
   - 管理員 hide／remove／approve／publish（`src/routes/admin.ts`、`src/db/publish.ts` 的 publish、undo）
   - `recompute()` 讓 status 進入或離開公開集合（hidden ↔ community 等）。**被檢舉隱藏的內容不該多掛 10 分鐘。**
   - 新增 pop-up 且初始狀態就是公開（`initialStatus` 回 `community` 或 `verified_admin`）。
3. 一般的投票、打卡只改計數，**不用**立即重建，最多慢 10 分鐘（前端有 optimistic update，自己看不到延遲）。
4. 並發保護：同時多個 waitUntil 重建只是多讀幾次，不會壞；若擔心，可在記憶體裡用一個簡單的「重建中」旗標。

### 5.4 讀取端點
`src/routes/popups.ts`，**放在 `/:id` 之前**（否則 `snapshot` 會被當成 id）：
```ts
popups.get('/snapshot', async c => {
  const row = await c.env.DB.prepare("SELECT version, json FROM snapshots WHERE key='popups'").first<...>();
  if (!row) return c.json(await listPopupsFallback(...)); // 沒有快照時退回 SQL（首次部署、過大時）
  if (c.req.header('if-none-match') === row.version) return c.body(null, 304);
  return c.body(row.json, 200, {
    'content-type': 'application/json; charset=utf-8',
    'etag': row.version,
    'cache-control': 'public, max-age=60',
  });
});
```
- **Worker 不要 `JSON.parse` 這串字**（CPU 10 ms 限制），原樣轉發。
- 一個請求只讀 1 列，和資料量無關。
- 舊的 `GET /popups` 保留給 MCP（`src/mcp.ts` 的搜尋工具）與相容用，並對它加簡單的 rate limit（現有 KV 計數器可重用，注意 KV 寫入每天 1,000 次的免費上限）。

### 5.5 前端引擎
1. 新增共用的純函式 `filterPopups(items, params, now)`，把 `listPopups` 的邏輯搬過去：
   - `when` 視窗：用 `windowFor`（`src/lib/time.ts`，Europe/London、BST 安全）。看 `web/src/lib/format.ts` 是否已有鏡像版本；`CLAUDE.md` 提到兩邊要保持一致。
   - `category`、`borough`（不分大小寫）、`free`、`verified`
   - `q`：對 title／host／borough 做不分大小寫的子字串（跟 SQL 的 `LIKE` 行為一致，包含 `%`、`_` 不特殊處理）
   - `near`／`radius_km`／`sort=distance`：用 `haversine`（`src/lib/geo.ts`）
   - `bbox`
   - 排序：`hot DESC, id`；分頁用 slice
2. 共用方式：`web/` 是獨立 package，要 import `../src/lib/*.ts` 需確認 Vite 的 `server.fs.allow` 與 `tsconfig` 的 `include`（Ying 的 repo 是 `src/shared/` 兩邊共用）。若麻煩就把純函式放 `src/shared/`，兩邊都 import。
3. `web/src/pages/Explore.tsx` 的 `usePopups` 與 `MapPage.tsx`：改成 `useQuery(['popups-snapshot'], …, { staleTime: 60_000 })` 取一次整包，再用 `useMemo(() => filterPopups(...))` 算結果。查詢 key 不再包含篩選條件，所以**改篩選、輸入搜尋都不再發請求**，`useDebounced` 可保留當作輸入緩衝。
4. 保留 PR 2 的 `me` 合併邏輯。

### 5.6（可選）完全移除 cron 對 `hot` 的寫入
快照已經在建立時用 `hot()` 算好，DB 欄位 `hot` 只在投票／狀態改變時由 `recompute()` 更新。若 MCP／舊 SQL 路徑也改用快照或接受稍舊的排序，就可以刪掉 `recomputeHot`，寫入量降到接近 0。這步等 PR 1、PR 3 都穩定後再評估。

### 5.7 驗收（重點）
- **新舊結果比對測試**（Ying 做過，很有效）：在 `test/` 新增一個測試，用 seed／examples 的資料，對 `listPopups`（舊 SQL）和 `filterPopups`（新）跑 30 組以上的參數組合（when × category × verified × free × q × near × bbox × borough），斷言**回傳的 id 與順序一致**。確認一致後才刪舊的 SQL 路徑（或保留給 MCP）。
- `buildPopupSnapshot`：只含公開狀態、不含 pending／hidden／removed／ended、不含 `me`；過大時不寫入。
- `GET /popups/snapshot`：有快照回 200＋ETag；`If-None-Match` 回 304；沒快照退回 SQL。
- 手動：admin 隱藏一個 pop-up，重新整理列表 → 立即消失（waitUntil 重建）；一般投票 → 計數 10 分鐘內更新。
- Dashboard：列表相關查詢的 rows read 從 ≈N／請求降到 ≈1／請求。

### 5.8 資料變大時
- 快照超過約 1.5 MB（或 N 超過約 3,000）時，拆成多個 key：`popups:today`、`popups:week`、或按行政區；前端按目前的篩選取對應那份。
- 這時搜尋和地圖附近查詢仍可在前端做，因為每份資料還是夠小。

---

## 6. 不要動的部分（維持直接查 SQL）

- `GET /popups/:id` 詳情（4 個小查詢、含個人狀態）
- 投票、打卡、檢舉、收藏、新增、編輯（寫入路徑）
- 後台審核隊列、使用者、agent lease（`list_review_queue`、`list_sources`）
- Scout／Triage／Checker 的 MCP 工具

這些是寫入多、個人化強、或量很小的部分，快照沒有好處。

---

## 7. PR 4：綁自訂網域之後加邊緣快取（約 1 小時）

前提：`CLAUDE.md` 待辦第 4 項（自訂網域）完成。

- 新增 `src/cache.ts`（參考 manyfold-data 的 `src/worker/cache.ts`）：對 `GET /api/v1/popups/snapshot`、`GET /api/v1/popups/:slug`（匿名時）用 `caches.default`，key 把 query 參數排序正規化，TTL 60 秒，命中時回 `x-cache: hit`。
- 注意 manyfold-data 踩過的坑：zone 的 Browser Cache TTL 會把 `max-age` 蓋成 14400（4 小時）→ 命中時要重設成自己的 `max-age`（commit `e956789`）。
- 錯誤處理：D1 額度用完時（錯誤訊息含 `D1` 且與 limit 有關），改回**上一份快取（stale-if-error）**或回 503＋`Retry-After`，不要整站 500。manyfold-data 的 `over_daily_limit` 可以參考。
- 在 Cloudflare 對 `/api/*` 加 WAF rate limiting 規則，擋爬蟲。

---

## 8. 建議順序與工作量

| 順序 | PR | 內容 | 風險 | 預估 |
|---|---|---|---|---|
| 0 | — | 量測基準 | 無 | 0.5 h |
| 1 | PR 1 | `recomputeHot` 只寫有變的、改整點 | 低 | 0.5 h |
| 2 | PR 2 | 列表不含 `me`＋`/me/state`＋前端合併 | 中（optimistic update） | 0.5–1 天 |
| 3 | PR 3 | 快照＋前端引擎 | 中高 | 1–1.5 天 |
| 4 | PR 4 | 自訂網域後加邊緣快取 | 低 | 1 h |

PR 1 可以獨立立刻上；PR 2、PR 3 可以分開 merge，PR 2 完成後即使不做 PR 3 也已經有收益（列表可共用快取）。

### 每個 PR 的檢查清單
- [ ] `npm run typecheck && (cd web && npx tsc --noEmit)`
- [ ] `npm test`
- [ ] 有 migration → PR 說明寫明，並先 `npx wrangler d1 migrations apply spotted-db --remote` 再 merge
- [ ] 新增 vars／bindings → 同步加到 `wrangler.jsonc` 的 `previews` 區塊
- [ ] 改了 MCP 工具名稱或輸入 → 同步 `skills/spotted-london/SKILL.md` 與 `src/db/agents.ts` 的 `AGENT_INFO`
- [ ] 手機 375 px 檢查 Explore、Map、Saved、PopupSheet
- [ ] 上線後隔天看 D1 Insights，和第 0 步的基準比較

---

## 9. 風險與取捨

- **新鮮度**：別人的投票數、驗證狀態最多晚 10 分鐘出現（hide／remove／檢舉隱藏除外，會立即重建）。
- **一致性**：搜尋行為要與舊的 `LIKE` 一致（不分大小寫、子字串）；`when` 視窗要用同一份 London 時間邏輯，否則 BST 邊界日會出錯。
- **Optimistic update**：PR 2 最容易出 bug 的地方，要逐個動作手動測。
- **快照大小**：只放列表需要的欄位；超過上限時要退回 SQL，不能整個壞掉。
- **預覽共用 production DB**：預覽版若觸發重建會寫正式的 `snapshots`，這是可接受的（內容相同），但不要在預覽版測試會改資料的流程。
- **KV 寫入**：免費版每天 1,000 次，不要把快照存 KV。
