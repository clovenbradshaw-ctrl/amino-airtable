#!/usr/bin/env node
/**
 * accept-all-rooms.mjs
 *
 * Invites the admin user to all table rooms via the amino-invite webhook,
 * then auto-joins every room the user has been invited to.
 *
 * Usage:
 *   node accept-all-rooms.mjs
 *
 * Environment variables (or edit the constants below):
 *   MATRIX_HOMESERVER  - e.g. https://app.aminoimmigration.com
 *   MATRIX_USER_ID     - e.g. @admin:app.aminoimmigration.com
 *   MATRIX_ACCESS_TOKEN - the admin user's access token
 *   WEBHOOK_BASE        - e.g. https://n8n.intelechia.com
 */

const HOMESERVER = process.env.MATRIX_HOMESERVER || 'https://app.aminoimmigration.com';
const USER_ID = process.env.MATRIX_USER_ID || '@admin:app.aminoimmigration.com';
const ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN || 'YOUR_ADMIN_ACCESS_TOKEN';
const WEBHOOK_BASE = process.env.WEBHOOK_BASE || 'https://n8n.intelechia.com';

const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 300;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function matrixFetch(path, options = {}) {
  const url = `${HOMESERVER}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  return res.json();
}

// Step 1: Call amino-invite webhook to have the bot invite admin to all rooms
async function requestInvites() {
  console.log(`\n[bot] Requesting bot to invite ${USER_ID} to all rooms...`);
  const res = await fetch(`${WEBHOOK_BASE}/webhook/amino-invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: USER_ID })
  });
  const data = await res.json();
  console.log(`   Result: ${data.message || JSON.stringify(data)}`);
  return data;
}

// Step 2: Initial sync to find all invited rooms
async function getInvitedRooms() {
  console.log(`\n[sync] Syncing to find invited rooms...`);
  const syncData = await matrixFetch(
    '/_matrix/client/v3/sync?filter={"room":{"timeline":{"limit":0}}}&timeout=0'
  );

  const invited = syncData.rooms?.invite || {};
  const joined = syncData.rooms?.join || {};

  const invitedRoomIds = Object.keys(invited);
  const joinedRoomIds = Object.keys(joined);

  console.log(`   Already joined: ${joinedRoomIds.length} rooms`);
  console.log(`   Pending invites: ${invitedRoomIds.length} rooms`);

  return { invitedRoomIds, joinedRoomIds };
}

// Step 3: Join a single room
async function joinRoom(roomId) {
  const encoded = encodeURIComponent(roomId);
  const res = await matrixFetch(`/_matrix/client/v3/join/${encoded}`, {
    method: 'POST',
    body: '{}'
  });
  return res;
}

// Step 4: Join all invited rooms in batches
async function joinAllRooms(roomIds) {
  console.log(`\n[join] Joining ${roomIds.length} rooms (batch size: ${BATCH_SIZE})...\n`);

  let joined = 0;
  let failed = 0;
  const errors = [];

  for (let i = 0; i < roomIds.length; i += BATCH_SIZE) {
    const batch = roomIds.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (roomId) => {
        const res = await joinRoom(roomId);
        if (res.room_id) {
          joined++;
          process.stdout.write(`   + Joined ${roomId}\n`);
          return { roomId, success: true };
        } else {
          failed++;
          process.stdout.write(`   x Failed ${roomId}: ${res.errcode} - ${res.error}\n`);
          errors.push({ roomId, errcode: res.errcode, error: res.error });
          return { roomId, success: false };
        }
      })
    );

    // Rate-limit between batches
    if (i + BATCH_SIZE < roomIds.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  return { joined, failed, errors };
}

// Main
async function main() {
  console.log('='.repeat(60));
  console.log('  Accept All Rooms - Admin Room Membership Setup');
  console.log('='.repeat(60));
  console.log(`  Homeserver: ${HOMESERVER}`);
  console.log(`  User:       ${USER_ID}`);
  console.log(`  Webhook:    ${WEBHOOK_BASE}`);

  // Step 1: Request invites from bot
  await requestInvites();

  // Brief pause for invites to propagate
  console.log('\n[wait] Waiting 2s for invites to propagate...');
  await sleep(2000);

  // Step 2: Sync to see invited rooms
  const { invitedRoomIds, joinedRoomIds } = await getInvitedRooms();

  if (invitedRoomIds.length === 0) {
    console.log('\n[done] No pending invites -- admin is already in all rooms (or no invites were sent).');
    console.log(`   Total joined rooms: ${joinedRoomIds.length}`);
    return;
  }

  // Step 3: Accept all invites
  const result = await joinAllRooms(invitedRoomIds);

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('  SUMMARY');
  console.log('='.repeat(60));
  console.log(`  Previously joined: ${joinedRoomIds.length}`);
  console.log(`  Newly joined:      ${result.joined}`);
  console.log(`  Failed:            ${result.failed}`);
  console.log(`  Total now:         ${joinedRoomIds.length + result.joined}`);

  if (result.errors.length > 0) {
    console.log('\n  Errors:');
    for (const err of result.errors) {
      console.log(`    ${err.roomId}: ${err.errcode} - ${err.error}`);
    }
  }

  console.log('\n[done] Done.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
