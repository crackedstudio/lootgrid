const KEY = 'lootgrid.playerId';

function randomAddress() {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return '0x' + [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Dev-mode identity: a random address kept in localStorage and sent as
 * `x-player`, which the server trusts when AUTH_MODE=dev.
 *
 * PRODUCTION REPLACES THIS. Real auth generates a session keypair here, binds it
 * on-chain once via PlayerRegistry.bind(), and signs every request with it —
 * MiniPay cannot sign messages, so that binding transaction is what stands in
 * for a login. Swapping this file over does not touch anything else.
 */
export function getPlayerId() {
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = randomAddress();
    localStorage.setItem(KEY, id);
  }
  return id;
}

export function resetPlayerId() {
  localStorage.removeItem(KEY);
}
