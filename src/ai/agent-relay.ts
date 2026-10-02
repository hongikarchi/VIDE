// A kept Claude process (ADR-028, T-104) reads its MCP bearer token once, when it starts, from
// VIDE_AGENT_TOKEN. Each turn still gets its own short-lived scope token from AgentTools; the
// process token only stands for the scope of the turn that is running in that process right now.
// Between turns it stands for nothing, so the MCP endpoint answers 401 as for any unknown token.

const relays = new Map<string, string>();
const TOKEN = /^[a-f0-9]{64}$/;

/** While a turn runs in the process: its process token stands for the turn's scope token. */
export function bindAgentRelay(processToken: string, turnToken: string) {
  if (!TOKEN.test(processToken) || !TOKEN.test(turnToken)) throw new Error('INVALID_AGENT_RELAY');
  relays.set(processToken, turnToken);
}
/** The turn ended: the process token stands for nothing until the next turn binds it. */
export function unbindAgentRelay(processToken: string) {
  relays.delete(processToken);
}
/** The scope token a bearer token stands for (itself when it is not a bound process token). */
export function resolveAgentToken(token: string) {
  return relays.get(token) ?? token;
}
