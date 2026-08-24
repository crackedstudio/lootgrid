export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8787';
export const WS_URL = API_URL.replace(/^http/, 'ws') + '/ws';

/**
 * How long to wait for the referee before declaring the session dead.
 * There is deliberately no offline fallback: a client that quietly drops back to
 * fake local state is exactly how you end up unable to tell whether the server
 * is working.
 */
export const REQUEST_TIMEOUT_MS = 8000;

/**
 * Chain constants. These MUST match the server's RPC_URL and
 * PLAYER_REGISTRY_ADDRESS: the client binds against this registry and the
 * server reads that one, so a mismatch means every signature verifies locally
 * and is rejected remotely.
 */
export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID || 42220);
export const RPC_URL = import.meta.env.VITE_RPC_URL || 'https://forno.celo.org';
export const REGISTRY_ADDRESS =
  import.meta.env.VITE_REGISTRY_ADDRESS || '0xe0dCcC4D8C06C9f7F370C8E4ab94BD9b4bc29E0D';

/**
 * The settlement token.
 *
 * DECIMALS is not decoration. USD₮ on Celo is 6dp, not the 18 that most chains
 * habituate you to, and an amount computed at the wrong scale is wrong by a
 * factor of a trillion in whichever direction hurts most. It must match the
 * server's HINT_TOKEN_DECIMALS / ESCROW_TOKEN_DECIMALS.
 */
export const TOKEN_ADDRESS =
  import.meta.env.VITE_TOKEN_ADDRESS || '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e';
export const TOKEN_DECIMALS = Number(import.meta.env.VITE_TOKEN_DECIMALS || 6);
export const TOKEN_SYMBOL = import.meta.env.VITE_TOKEN_SYMBOL || 'USD₮';
