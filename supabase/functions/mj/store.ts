// 資料存取介面：Bot / API 只透過這裡讀寫，底層可以換成 JSON 檔或 Supabase
import type { Game, Player, Score } from "./logic.ts";

export type Room = {
  id: string;
  code: string;
  name: string;
  line_group_id: string | null;
  admin_line_user_id: string;
};

export interface Store {
  roomByGroup(groupId: string): Promise<Room | null>;
  roomByCode(code: string): Promise<Room | null>;
  createRoom(r: Omit<Room, "id">): Promise<Room>;
  unlinkGroup(groupId: string): Promise<void>;
  /** 刪除房間和裡面所有玩家、對局 */
  deleteRoom(roomId: string): Promise<void>;

  /** 額外的管理員（不含房主） */
  adminsOf(roomId: string): Promise<string[]>;
  addAdmin(roomId: string, lineUserId: string, addedBy: string): Promise<void>;
  removeAdmin(roomId: string, lineUserId: string): Promise<boolean>;

  playersOf(roomId: string): Promise<Player[]>;
  /** 插入不存在的名字，回傳實際新增的名字 */
  insertPlayers(roomId: string, names: string[]): Promise<string[]>;
  claimPlayer(roomId: string, playerId: string, lineUserId: string): Promise<void>;
  setHouse(roomId: string, playerId: string, isHouse: boolean): Promise<void>;

  /** games 由舊到新 */
  gamesOf(roomId: string): Promise<{ games: Game[]; scores: Score[] }>;
  /** 必須檢查：至少 2 人、總和為 0、玩家都屬於該房間；不合法時丟出 Error(訊息給使用者看) */
  /** playedAt 省略＝現在 */
  recordGame(roomId: string, by: string, entries: { player_id: string; points: number }[], note: string, playedAt?: string): Promise<string>;
  deleteGame(roomId: string, gameId: string): Promise<void>;
  setGameDate(roomId: string, gameId: string, playedAt: string): Promise<boolean>;
  /** 把一場換成多場（每桌一場，日期相同、備註加「第N桌」）；呼叫前要先用 validateSplit 檢查 */
  splitGame(roomId: string, gameId: string, tables: { player_id: string; points: number }[][]): Promise<void>;
  /** 刪最後一場，沒有則回傳 false */
  deleteLastGame(roomId: string): Promise<boolean>;
}

export class UserError extends Error {}

/** 房主或被加為管理員的人 */
export async function isRoomAdmin(store: Store, room: Room, lineUserId: string | undefined) {
  if (!lineUserId) return false;
  if (room.admin_line_user_id === lineUserId) return true;
  return (await store.adminsOf(room.id)).includes(lineUserId);
}

export function checkGame(entries: { player_id: string; points: number }[], roomPlayerIds: Set<string>) {
  if (entries.length < 2) throw new UserError("至少需要兩位玩家");
  if (new Set(entries.map((e) => e.player_id)).size !== entries.length) throw new UserError("有玩家重複");
  const sum = entries.reduce((a, e) => a + e.points, 0);
  if (sum !== 0) throw new UserError(`分數總和必須為 0（目前 ${sum}）`);
  if (entries.some((e) => !roomPlayerIds.has(e.player_id))) throw new UserError("有玩家不屬於這個房間");
}

/** 檢查並正規化前端傳來的對局時間；不合理就丟出 UserError */
export function parsePlayedAt(v: unknown): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const t = new Date(String(v));
  if (isNaN(t.getTime())) throw new UserError("日期格式不對");
  if (t.getTime() > Date.now() + 24 * 3600e3) throw new UserError("日期不能是未來");
  if (t.getFullYear() < 2000) throw new UserError("日期太早了");
  return t.toISOString();
}

export async function makeStore(): Promise<Store> {
  // 沒設定 STORE 時：在 Supabase 上（有 service role key）用 supabase，本機用 file
  const kind = (Deno.env.get("STORE") ?? (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ? "supabase" : "file")).toLowerCase();
  if (kind === "supabase") {
    const { SupabaseStore } = await import("./store_supabase.ts");
    return new SupabaseStore();
  }
  const { FileStore } = await import("./store_file.ts");
  return new FileStore(Deno.env.get("DATA_FILE") ?? "./data.json");
}
