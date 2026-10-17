// 本機 JSON 檔儲存：不需要任何雲端服務，適合先試做、少量使用
import type { Game, Player, Score } from "./logic.ts";
import { checkGame, type Room, type Store, UserError } from "./store.ts";

type GameRow = Game & { room_id: string; created_by: string };
type PlayerRow = Player & { room_id: string; created_at: string };
type AdminRow = { room_id: string; line_user_id: string; added_by: string };
type Data = { rooms: Room[]; players: PlayerRow[]; games: GameRow[]; scores: Score[]; admins?: AdminRow[] };

export class FileStore implements Store {
  private data: Data = { rooms: [], players: [], games: [], scores: [] };
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private path: string) {}

  private async load() {
    if (this.loaded) return;
    try {
      this.data = JSON.parse(await Deno.readTextFile(this.path));
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
    this.loaded = true;
  }

  private async save() {
    const tmp = `${this.path}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify(this.data, null, 1));
    await Deno.rename(tmp, this.path); // 先寫暫存檔再換名，避免寫到一半壞檔
  }

  /** 讀寫都排隊執行，避免同時寫入互相覆蓋 */
  private run<T>(fn: () => T | Promise<T>, write = false): Promise<T> {
    const p = this.queue.then(async () => {
      await this.load();
      const out = await fn();
      if (write) await this.save();
      return out;
    });
    this.queue = p.catch(() => {});
    return p;
  }

  roomByGroup(groupId: string) {
    return this.run(() => this.data.rooms.find((r) => r.line_group_id === groupId) ?? null);
  }

  roomByCode(code: string) {
    return this.run(() => this.data.rooms.find((r) => r.code === code.toUpperCase()) ?? null);
  }

  createRoom(r: Omit<Room, "id">) {
    return this.run(() => {
      if (r.line_group_id && this.data.rooms.some((x) => x.line_group_id === r.line_group_id)) {
        throw new UserError("這個群組已經有房間了");
      }
      const room = { id: crypto.randomUUID(), ...r };
      this.data.rooms.push(room);
      return room;
    }, true);
  }

  unlinkGroup(groupId: string) {
    return this.run(() => {
      for (const r of this.data.rooms) if (r.line_group_id === groupId) r.line_group_id = null;
    }, true);
  }

  deleteRoom(roomId: string) {
    return this.run(() => {
      const gameIds = new Set(this.data.games.filter((g) => g.room_id === roomId).map((g) => g.id));
      this.data.scores = this.data.scores.filter((s) => !gameIds.has(s.game_id));
      this.data.games = this.data.games.filter((g) => g.room_id !== roomId);
      this.data.players = this.data.players.filter((p) => p.room_id !== roomId);
      this.data.rooms = this.data.rooms.filter((r) => r.id !== roomId);
      this.data.admins = (this.data.admins ?? []).filter((a) => a.room_id !== roomId);
    }, true);
  }

  adminsOf(roomId: string) {
    return this.run(() => (this.data.admins ?? []).filter((a) => a.room_id === roomId).map((a) => a.line_user_id));
  }

  addAdmin(roomId: string, lineUserId: string, addedBy: string) {
    return this.run(() => {
      const list = (this.data.admins ??= []);
      if (!list.some((a) => a.room_id === roomId && a.line_user_id === lineUserId)) {
        list.push({ room_id: roomId, line_user_id: lineUserId, added_by: addedBy });
      }
    }, true);
  }

  removeAdmin(roomId: string, lineUserId: string) {
    return this.run(() => {
      const before = (this.data.admins ?? []).length;
      this.data.admins = (this.data.admins ?? []).filter((a) => !(a.room_id === roomId && a.line_user_id === lineUserId));
      return this.data.admins.length !== before;
    }, true);
  }

  playersOf(roomId: string) {
    return this.run(() =>
      this.data.players.filter((p) => p.room_id === roomId)
        .map(({ id, name, line_user_id, is_house }) => ({ id, name, line_user_id, is_house: !!is_house }))
    );
  }

  insertPlayers(roomId: string, names: string[]) {
    return this.run(() => {
      const existing = new Set(this.data.players.filter((p) => p.room_id === roomId).map((p) => p.name));
      const added = names.filter((n) => !existing.has(n));
      for (const name of added) {
        this.data.players.push({
          id: crypto.randomUUID(), room_id: roomId, name, line_user_id: null,
          created_at: new Date().toISOString(),
        });
      }
      return added;
    }, true);
  }

  claimPlayer(roomId: string, playerId: string, lineUserId: string) {
    return this.run(() => {
      const inRoom = this.data.players.filter((p) => p.room_id === roomId);
      if (inRoom.some((p) => p.line_user_id === lineUserId)) throw new UserError("你已經認領過了");
      const target = inRoom.find((p) => p.id === playerId);
      if (!target) throw new UserError("找不到這位玩家");
      if (target.line_user_id) throw new UserError("這個名字已經被認領");
      target.line_user_id = lineUserId;
    }, true);
  }

  setHouse(roomId: string, playerId: string, isHouse: boolean) {
    return this.run(() => {
      const p = this.data.players.find((x) => x.id === playerId && x.room_id === roomId);
      if (p) p.is_house = isHouse;
    }, true);
  }

  gamesOf(roomId: string) {
    return this.run(() => {
      const games = this.data.games.filter((g) => g.room_id === roomId)
        .sort((a, b) => a.played_at.localeCompare(b.played_at))
        .map(({ id, played_at, note }) => ({ id, played_at, note }));
      const ids = new Set(games.map((g) => g.id));
      return { games, scores: this.data.scores.filter((s) => ids.has(s.game_id)) };
    });
  }

  recordGame(roomId: string, by: string, entries: { player_id: string; points: number }[], note: string) {
    return this.run(() => {
      checkGame(entries, new Set(this.data.players.filter((p) => p.room_id === roomId).map((p) => p.id)));
      const id = crypto.randomUUID();
      this.data.games.push({ id, room_id: roomId, created_by: by, note: note || null, played_at: new Date().toISOString() });
      for (const e of entries) this.data.scores.push({ game_id: id, player_id: e.player_id, points: e.points });
      return id;
    }, true);
  }

  deleteGame(roomId: string, gameId: string) {
    return this.run(() => {
      const before = this.data.games.length;
      this.data.games = this.data.games.filter((g) => !(g.id === gameId && g.room_id === roomId));
      if (this.data.games.length !== before) this.data.scores = this.data.scores.filter((s) => s.game_id !== gameId);
    }, true);
  }

  deleteLastGame(roomId: string) {
    return this.run(() => {
      const last = this.data.games.filter((g) => g.room_id === roomId)
        .sort((a, b) => b.played_at.localeCompare(a.played_at))[0];
      if (!last) return false;
      this.data.games = this.data.games.filter((g) => g.id !== last.id);
      this.data.scores = this.data.scores.filter((s) => s.game_id !== last.id);
      return true;
    }, true);
  }
}
