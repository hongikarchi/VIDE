import {
  EMPTY_SHEET,
  finishRoomsSchema,
  finishSheetSchema,
  type FinishLibrary,
  type FinishRoom,
  type FinishSheet,
  type FinishState,
} from '../contracts/finish.ts';
import { validateRooms, withUsed } from '../jigs/finish.ts';
import { DomainError, type Store } from './store.ts';

/**
 * A project's 마감 일람표 state (SPEC-11.6, schema 12): the rooms and the sheet. Each save sends
 * the whole list and replaces the project's rows in one transaction; a list that breaks a room
 * rule (unknown code, wrong element, limits) is refused whole (FINISH_CODE_INVALID) and nothing
 * changes. Assigned codes join the adopted list. The library is passed in (vide/finish-codes).
 */
export class FinishStore {
  private readonly store: Store;
  private readonly now: () => Date;
  constructor(store: Store, { now = () => new Date() }: { now?: () => Date } = {}) {
    this.store = store;
    this.now = now;
  }
  state(projectId: string): FinishState {
    this.store.project(projectId);
    const db = this.store.db(projectId);
    const rooms = db
      .prepare('SELECT * FROM finish_rooms WHERE projectId=? ORDER BY ord')
      .all(projectId)
      .map((row) => {
        const r = row as Record<string, string>;
        return {
          id: r.id,
          floor: r.floor,
          no: r.roomNo,
          name: r.name,
          F: JSON.parse(r.floorCodes) as string[],
          W: JSON.parse(r.wallCodes) as string[],
          C: JSON.parse(r.ceilingCodes) as string[],
        };
      });
    const row = db.prepare('SELECT body FROM finish_sheets WHERE projectId=?').get(projectId) as
      | { body: string }
      | undefined;
    let sheet: FinishSheet = EMPTY_SHEET;
    if (row) {
      const parsed = finishSheetSchema.safeParse(JSON.parse(row.body));
      if (parsed.success) sheet = parsed.data;
    }
    return { rooms, sheet };
  }
  /** Replaces the rooms; refused whole when one breaks a rule. Returns the saved state. */
  saveRooms(projectId: string, value: unknown, lib: FinishLibrary): FinishState {
    const input = finishRoomsSchema.safeParse(value);
    if (!input.success) throw new DomainError('INVALID_INPUT');
    const rooms: FinishRoom[] = input.data.rooms;
    if (validateRooms(lib, rooms).length) throw new DomainError('FINISH_CODE_INVALID');
    this.store.project(projectId);
    const db = this.store.db(projectId);
    return this.store.tx(db, () => {
      db.prepare('DELETE FROM finish_rooms WHERE projectId=?').run(projectId);
      const insert = db.prepare(
        'INSERT INTO finish_rooms(id,projectId,ord,floor,roomNo,name,floorCodes,wallCodes,ceilingCodes) VALUES(?,?,?,?,?,?,?,?,?)',
      );
      rooms.forEach((room, ord) =>
        insert.run(
          room.id,
          projectId,
          ord,
          room.floor,
          room.no,
          room.name,
          JSON.stringify(room.F),
          JSON.stringify(room.W),
          JSON.stringify(room.C),
        ),
      );
      // Assigning adopts (SPEC-11.3 1).
      const sheet = this.state(projectId).sheet;
      const adopted = withUsed(sheet.adopted, rooms);
      if (adopted.length !== sheet.adopted.length)
        this.writeSheet(projectId, { ...sheet, adopted });
      return this.state(projectId);
    });
  }
  /** Replaces the sheet (채택, 두께 조절, 표제, 일반사항). Codes must be in the library. */
  saveSheet(projectId: string, value: unknown, lib: FinishLibrary): FinishState {
    const input = finishSheetSchema.safeParse(value);
    if (!input.success) throw new DomainError('INVALID_INPUT');
    const sheet = input.data;
    const known = (code: string) => Boolean(lib.codes[code]);
    if (!sheet.adopted.every(known)) throw new DomainError('FINISH_CODE_INVALID');
    for (const [code, layers] of Object.entries(sheet.thk))
      if (!known(code) || Object.keys(layers).some((i) => !lib.codes[code].layers[Number(i)]))
        throw new DomainError('FINISH_CODE_INVALID');
    this.store.project(projectId);
    const db = this.store.db(projectId);
    return this.store.tx(db, () => {
      const rooms = this.state(projectId).rooms;
      this.writeSheet(projectId, {
        ...sheet,
        adopted: withUsed([...new Set(sheet.adopted)], rooms),
      });
      return this.state(projectId);
    });
  }
  private writeSheet(projectId: string, sheet: FinishSheet) {
    this.store
      .db(projectId)
      .prepare(
        'INSERT INTO finish_sheets(projectId,body,updatedAt) VALUES(?,?,?) ON CONFLICT(projectId) DO UPDATE SET body=excluded.body, updatedAt=excluded.updatedAt',
      )
      .run(projectId, JSON.stringify(sheet), this.now().toISOString());
  }
}
