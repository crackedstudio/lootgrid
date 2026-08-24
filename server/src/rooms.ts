import type { WebSocket } from 'ws';

export interface Client {
  ws: WebSocket;
  playerId: string;
  handle: string;
  /**
   * The session key this socket authenticated with, so the heartbeat can detect
   * that it has since been rotated or cleared. Null in dev mode.
   */
  sessionKey: string | null;
  rooms: Set<string>;
}

const clients = new Map<WebSocket, Client>();
const rooms = new Map<string, Set<Client>>();

export const zoneRoom = (zoneId: string) => `zone:${zoneId}`;
export const huntRoom = (huntId: string) => `hunt:${huntId}`;
export const playerRoom = (playerId: string) => `player:${playerId}`;

export function register(
  ws: WebSocket,
  playerId: string,
  handle: string,
  sessionKey: string | null = null,
): Client {
  const client: Client = { ws, playerId, handle, sessionKey, rooms: new Set() };
  clients.set(ws, client);
  join(ws, playerRoom(playerId));
  return client;
}

export function unregister(ws: WebSocket): void {
  const client = clients.get(ws);
  if (!client) return;
  for (const room of client.rooms) rooms.get(room)?.delete(client);
  clients.delete(ws);
}

export function clientFor(ws: WebSocket): Client | undefined {
  return clients.get(ws);
}

export function join(ws: WebSocket, room: string): void {
  const client = clients.get(ws);
  if (!client) return;
  if (!rooms.has(room)) rooms.set(room, new Set());
  rooms.get(room)!.add(client);
  client.rooms.add(room);
}

export function leave(ws: WebSocket, room: string): void {
  const client = clients.get(ws);
  if (!client) return;
  rooms.get(room)?.delete(client);
  client.rooms.delete(room);
}

export function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(msg));
}

export function broadcast(room: string, msg: unknown): void {
  const set = rooms.get(room);
  if (!set || set.size === 0) return;
  const payload = JSON.stringify(msg);
  for (const c of set) {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(payload);
  }
}

export function toPlayer(playerId: string, msg: unknown): void {
  broadcast(playerRoom(playerId), msg);
}

export function roomSize(room: string): number {
  return rooms.get(room)?.size ?? 0;
}

export const connectionCount = (): number => clients.size;

/** Open sockets for one player — the per-player connection cap uses this. */
export const countForPlayer = (playerId: string): number => roomSize(playerRoom(playerId));

export function allClients(): Iterable<Client> {
  return clients.values();
}
