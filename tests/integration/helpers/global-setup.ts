import { verifyPoolUsers } from './session-pool.js';

// Runs once before any integration file: fail the whole run up front when a pool user is missing.
export default async function setup(): Promise<void> {
  await verifyPoolUsers();
}
