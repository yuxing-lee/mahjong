// Supabase 儲存（保留備用）：設定 STORE=supabase 並先跑 migrations/001_init.sql
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Score } from "./logic.ts";
import type { Expense, Room, Store } from "./store.ts";
import { UserError } from "./store.ts";

export class SupabaseStore implements Store {
  private db: SupabaseClient;

  constructor() {
    this.db = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
      auth: { persistSession: false },
    });
  }

  async roomByGroup(groupId: string) {
    const { data, error } = await this.db.from("rooms").select("*").eq("line_group_id", groupId).maybeSingle();
    if (error) throw error;
    return data as Room | null;
  }

  async roomByCode(code: string) {
    const { data, error } = await this.db.from("rooms").select("*").eq("code", code.toUpperCase()).maybeSingle();
    if (error) throw error;
    return data as Room | null;
  }

  async createRoom(r: Omit<Room, "id">) {
    const { data, error } = await this.db.from("rooms").insert(r).select("*").single();
    if (error) throw error;
    return data as Room;
  }

  async unlinkGroup(groupId: string) {
    const { error } = await this.db.from("rooms").update({ line_group_id: null }).eq("line_group_id", groupId);
    if (error) throw error;
  }

  async deleteRoom(roomId: string) {
    // players / games / scores 都設了 on delete cascade，會一起刪掉
    const { error } = await this.db.from("rooms").delete().eq("id", roomId);
    if (error) throw error;
  }

  async adminsOf(roomId: string) {
    const { data, error } = await this.db.from("room_admins").select("line_user_id").eq("room_id", roomId);
    if (error) throw error;
    return (data ?? []).map((r) => r.line_user_id as string);
  }

  async addAdmin(roomId: string, lineUserId: string, addedBy: string) {
    const { error } = await this.db.from("room_admins")
      .upsert({ room_id: roomId, line_user_id: lineUserId, added_by: addedBy }, { onConflict: "room_id,line_user_id", ignoreDuplicates: true });
    if (error) throw error;
  }

  async removeAdmin(roomId: string, lineUserId: string) {
    const { data, error } = await this.db.from("room_admins").delete()
      .eq("room_id", roomId).eq("line_user_id", lineUserId).select("line_user_id");
    if (error) throw error;
    return (data ?? []).length > 0;
  }

  async playersOf(roomId: string) {
    const { data, error } = await this.db.from("players")
      .select("id,name,line_user_id,is_house").eq("room_id", roomId).order("created_at");
    if (error) throw error;
    return data ?? [];
  }

  async insertPlayers(roomId: string, names: string[]) {
    const existing = new Set((await this.playersOf(roomId)).map((p) => p.name));
    const toAdd = names.filter((n) => !existing.has(n));
    if (toAdd.length) {
      const { error } = await this.db.from("players").insert(toAdd.map((name) => ({ room_id: roomId, name })));
      if (error) throw error;
    }
    return toAdd;
  }

  async claimPlayer(roomId: string, playerId: string, lineUserId: string) {
    const players = await this.playersOf(roomId);
    if (players.some((p) => p.line_user_id === lineUserId)) throw new UserError("你已經認領過了");
    const target = players.find((p) => p.id === playerId);
    if (!target) throw new UserError("找不到這位玩家");
    if (target.line_user_id) throw new UserError("這個名字已經被認領");
    const { error } = await this.db.from("players").update({ line_user_id: lineUserId })
      .eq("id", playerId).is("line_user_id", null);
    if (error) throw error;
  }

  async setHouse(roomId: string, playerId: string, isHouse: boolean) {
    const { error } = await this.db.from("players").update({ is_house: isHouse }).eq("id", playerId).eq("room_id", roomId);
    if (error) throw error;
  }

  async gamesOf(roomId: string) {
    const { data: games, error } = await this.db.from("games")
      .select("id,played_at,note").eq("room_id", roomId).order("played_at", { ascending: true });
    if (error) throw error;
    const ids = (games ?? []).map((g) => g.id);
    const scores: Score[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error: e2 } = await this.db.from("scores")
        .select("game_id,player_id,points").in("game_id", ids.slice(i, i + 200));
      if (e2) throw e2;
      scores.push(...(data ?? []));
    }
    return { games: games ?? [], scores };
  }

  async recordGame(roomId: string, by: string, entries: { player_id: string; points: number }[], note: string, playedAt?: string) {
    // 檢查在資料庫的 record_game_at() 裡做（同一個 transaction）
    const { data, error } = await this.db.rpc("record_game_at", {
      p_room_id: roomId, p_created_by: by, p_note: note, p_scores: entries,
      ...(playedAt ? { p_played_at: playedAt } : {}),
    });
    if (error) throw new UserError(error.message);
    return data as string;
  }

  async deleteGame(roomId: string, gameId: string) {
    const { error } = await this.db.from("games").delete().eq("id", gameId).eq("room_id", roomId);
    if (error) throw error;
  }

  async setGameDate(roomId: string, gameId: string, playedAt: string) {
    const { data, error } = await this.db.from("games").update({ played_at: playedAt })
      .eq("id", gameId).eq("room_id", roomId).select("id");
    if (error) throw error;
    return (data ?? []).length > 0;
  }

  async deleteLastGame(roomId: string) {
    const { data: last } = await this.db.from("games").select("id").eq("room_id", roomId)
      .order("played_at", { ascending: false }).limit(1).maybeSingle();
    if (!last) return false;
    await this.deleteGame(roomId, last.id);
    return true;
  }

  async expensesOf(roomId: string) {
    const { data, error } = await this.db.from("expenses").select("id,item,amount,spent_at")
      .eq("room_id", roomId).order("spent_at", { ascending: false });
    if (error) throw error;
    return (data ?? []) as Expense[];
  }

  async addExpense(roomId: string, by: string, item: string, amount: number, spentAt?: string) {
    const { data, error } = await this.db.from("expenses")
      .insert({ room_id: roomId, created_by: by, item, amount, ...(spentAt ? { spent_at: spentAt } : {}) })
      .select("id").single();
    if (error) throw new UserError(error.message);
    return data.id as string;
  }

  async deleteExpense(roomId: string, expenseId: string) {
    const { data, error } = await this.db.from("expenses").delete()
      .eq("id", expenseId).eq("room_id", roomId).select("id");
    if (error) throw error;
    return (data ?? []).length > 0;
  }
}
