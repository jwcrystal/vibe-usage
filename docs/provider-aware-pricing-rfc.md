# provider 欄位：路由器來源（OpenCode）的按供應商計價

狀態：已於本機 stack（fork CLI + `vibe-usage-local-server`）實作。上游 `vibe-cafe`
尚未處理該欄位，也尚未發布。

## 已驗證的問題

價格的屬性是 **(provider, model)**，但 bucket 契約只帶 `source`（產生資料的 CLI id）。
當 CLI 自己就是計費方時 `source` 與 provider 等價——Command Code 屬於此類，所以
`sources.commandcode.models` 等於以 provider 為鍵。但 OpenCode 是**多供應商路由器**：
同一批資料一律標 `source: 'opencode'`，實際計費方卻可能是 commandcode / openai /
omlx（本地）/ opencode(Zen)。

2026-10-11 對本機 OpenCode 資料庫（`~/.local/share/opencode/opencode.db`，
`session_message.data.model`）只讀驗證，`providerID` 與 `model.id` 對應如下：

| providerID | model.id | 計費 |
|---|---|---|
| `commandcode` | `deepseek/deepseek-v4.1-flash` | Command Code catalog |
| `omlx` | `perplexity-ai--pplx-…-mlx-…` | 本地自架，無 API 價 |
| `openai` | `gpt-6-luna` / `gpt-6.1-sol` | OpenAI |
| `opencode` | `space-bunny-free` | OpenCode Zen，$0 |

`src/parsers/opencode.js` 只取 `data.model.id`（`opencode.js:28` 的
`json_extract(m.data, '$.model.id')`），**丟棄 `providerID`**，於
`entries.push({ source: 'opencode', model, … })`（`opencode.js:118–130`）一律標
`source:'opencode'`。

後果：經 OpenCode → Command Code 的 id 在 `source=opencode` 下只查 canonical
（預設價），而非 Command Code catalog 價。對**已碰撞**的 id 會直接算錯——例如
`gpt-5.6-sol`（Command Code 5/30 vs canonical 4/20）低估 20%。2026-10 已用
「canonical 補齊、`sources.commandcode` 縮到 14 筆真碰撞」暫時繞過**未碰撞**的 id
（見 `vibe-usage-local-server` commit `31533ea` 與 `docs/pricing.md`），但碰撞 id
在 `source=opencode` 下仍無解，因為 bucket 不帶 provider。

`docs/pricing.md`「為什麼覆寫鍵是 `source`，不是 `provider`」已評估過這件事並結論
「現階段不值得」；當時的前提是「同 id、不同 provider」不發生。本提案要求在 OpenCode
（router）情境下改為根治。

## 當前與擬議約束

**當前**：bucket 無 `provider` 欄位；計價為 `sources[source] ?? models`。`source` 是
跨倉庫契約（上游 `USAGE_SOURCES`），**不得**改作 provider。bucket dedup key 為
`source|model|project|hostname|bucketStart`；`state.json` 的增量鍵為
`state.bucketKey()`。

**擬議**：bucket 增加**可選、非身分**的 `provider`；計價改為
`sources[provider] ?? sources[source] ?? models`。**不動** dedup key、`state.json`
增量鍵、`hostname`。也就是 provider 只影響「查哪一層價」，不影響「哪些列是同一列」。

## 本地設計

1. `src/parsers/aggregate.js`：`aggregateToBuckets()` 在 entry 帶 `provider` 時，將其
   帶到輸出的 bucket（**不**加入群組鍵，見下）。缺省時不寫入該欄位，維持既有 bucket
   形狀。
2. `src/parsers/opencode.js`：SQL 增選 `json_extract(m.data, '$.model.providerID')`
   （V2）與 V1 的對應欄位；有值時寫入 entry `provider`。無值時不寫。
3. `vibe-usage-local-server/src/prices.js`：`estimateCost()` 查表順序加一層
   `prices.sources?.[bucket.provider]?.models?.[bucket.model]`，其後才是
   `sources[bucket.source]` 與 `models[bucket.model]`。
4. `prices.json`：`sources.commandcode` 已是正确鍵（OpenCode → Command Code 的
   providerID 恰為 `commandcode`），無需新增。`openai` / `omlx` 落回 canonical /
   null（本地模型刻意無價）。
5. local-server `store.js` 已用 `{ ...b }` 保留額外欄位，`ingestBuckets()` 與
   `bucketKey()` 不變。

## 兼容與歷史遷移

- **欄位可選**：無 `provider` 的既有 bucket 行為不變（canonical 預設）。
- **不改身分**：dedup key / `state.bucketKey()` 不變，因此**不會** double-count；
  這正是 `state.js:125–130` 告誡的風險，本提案明確避開。
- **既有資料**：ingest 對同 key 且 `totalTokens >=` 的桶有保護（`store.js:113`），
  所以歷史 OpenCode → Command Code 的桶不會被補上 provider，仍靠 canonical 計價
  （已於 `31533ea` 補齊）。
- **上游 `vibe-cafe`**：`provider` 是新欄位。本地 stack（local-server + desktop）
  不需要上游；上游是否忽略或加 DB column 另議，不阻塞本提案。
- **殘留限制**：provider 不進 key，所以同一
  `(source, model, project, hostname, 半小時)` 若真的由兩個 provider 產生，仍會合併
  成一列（只有一個 provider 勝出）。這是刻意取捨——換取零遷移與零 double-count。

## 發布順序與回滾

1. 先更新 `vibe-usage-local-server`（`estimateCost` 接受 `provider`；未知欄位已被
   `{ ...b }` 保留）。
2. 再更新 fork `vibe-usage`（`aggregate.js` + `opencode.js`），並 `scripts/sync-cli.sh`
   vendor 進 desktop。
3. 用本機 OpenCode 真實資料做只讀核對：`source=opencode` 下的 Command Code id 應改用
   `sources.commandcode` 價。

回滾：移除 `opencode.js` 寫入 `provider` 即恢復現況，計價自動落回 canonical；
local-server 的查表順序保留無害（無 provider 時不觸發）。

## 觸及 AGENTS.md 的門檻

本提案觸及 `AGENTS.md` 的 **cross-repository API contracts, backend storage/schema**
（line 92）。它**刻意不觸及** dedup keys / incremental-state keys（line 91），
以維持既有身分與遷移語意。依規定，須先取得跨倉庫核准再實作。
