import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Who is asking. Over stdio there is one caller and it owns the machine, so it is the operator. Over HTTP
 * there are as many callers as there are people signed in, and each of them gets their own wallet: a tool
 * must never be able to reach someone else's. The identity is resolved once, at the edge, and carried here.
 */
const store = new AsyncLocalStorage();

export const OPERATOR = { kind: 'operator', id: 'operator', label: 'this machine' };

export const runAs = (actor, fn) => store.run(actor || OPERATOR, fn);
export const currentActor = () => store.getStore() || OPERATOR;

/** The key a wallet is filed under. One per signed-in person, one for the operator. */
export const actorKey = (a = currentActor()) => (a.kind === 'user' ? `x:${a.id}` : 'operator');
export const actorLabel = (a = currentActor()) => (a.kind === 'user' ? `@${a.handle || a.id}` : a.label || 'the operator');
