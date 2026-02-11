# Offline Access & Permissions Design

## Overview

This document covers three concerns:

1. **User flows** — every path a user takes from first visit through daily use, across all roles
2. **Permissioning & access control** — how Matrix power levels, room membership, and encryption interact, including edge cases and gaps
3. **Offline access** — how users can work without internet, including local-only login that doesn't require reaching the homeserver

---

## Part 1: User Flows

### 1.1 First-Time Login (Cold Start)

```
User opens app.aminoimmigration.com
  │
  ├─ No localStorage session found
  │
  ├─ Show Synapse login screen (username + password)
  │   │
  │   ├─ POST /_matrix/client/v3/login
  │   │   ├─ Success →
  │   │   │   ├─ Save session to localStorage (homeserver, accessToken, userId, deviceId)
  │   │   │   ├─ Derive encryption key: PBKDF2(password, "amino-local-encrypt:" + userId)
  │   │   │   ├─ Create verification token, store in IndexedDB crypto store
  │   │   │   ├─ Save CryptoKey to sessionStorage (survives refresh, not tab close)
  │   │   │   ├─ Cache password-derived material for offline re-auth (see Part 3)
  │   │   │   ├─ Fetch API key from Matrix account data (law.firm.api_config)
  │   │   │   │   ├─ Found → set API_KEY, proceed
  │   │   │   │   └─ Not found → show "Contact admin to provision access"
  │   │   │   ├─ Detect role via org space power levels
  │   │   │   ├─ Fetch table metadata → build table-room map
  │   │   │   ├─ Join table rooms (request invite via bot, then /join)
  │   │   │   ├─ Hydrate all tables (API → IndexedDB, encrypted at rest)
  │   │   │   ├─ Start Matrix realtime sync loop
  │   │   │   └─ Render UI based on role
  │   │   │
  │   │   └─ Failure →
  │   │       ├─ Wrong password → "Invalid credentials"
  │   │       ├─ Account deactivated → "Account disabled. Contact admin."
  │   │       ├─ Homeserver unreachable → attempt offline login (Part 3)
  │   │       └─ Rate limited → show retry timer
```

### 1.2 Returning User — Same Tab (Session Refresh)

```
User refreshes the page (F5) or navigates back
  │
  ├─ sessionStorage has CryptoKey + session
  │   ├─ Restore CryptoKey from sessionStorage (no password needed)
  │   ├─ Restore Matrix session from sessionStorage
  │   ├─ Verify session with /whoami
  │   │   ├─ Valid → incremental sync, resume
  │   │   └─ Invalid → clear session, show login
  │   └─ Load from IndexedDB (instant), then sync delta
```

### 1.3 Returning User — New Tab / Browser Restart

```
User opens app in a new tab (sessionStorage is empty)
  │
  ├─ localStorage has Matrix session (homeserver, accessToken, userId)
  │   ├─ sessionStorage does NOT have CryptoKey (cleared on tab close)
  │   ├─ Verify stored access token with /whoami
  │   │   ├─ Valid session →
  │   │   │   ├─ Show "Enter your password to unlock" (single field)
  │   │   │   ├─ User enters Synapse password
  │   │   │   ├─ Re-derive encryption key from password + userId
  │   │   │   ├─ Verify derived key against stored verification token
  │   │   │   │   ├─ Match → proceed with cached session
  │   │   │   │   └─ Mismatch → password changed; prompt for old password
  │   │   │   │       or wipe local data and re-hydrate
  │   │   │   └─ Resume with incremental sync
  │   │   │
  │   │   └─ Invalid/expired session →
  │   │       ├─ Homeserver reachable → clear session, show full login
  │   │       └─ Homeserver unreachable → attempt offline unlock (Part 3)
  │   │
  │   └─ No localStorage session → full login screen
```

### 1.4 Client Portal User Flow

```
Client user opens app (has Matrix account with CLIENT power level)
  │
  ├─ Login (same flow as above)
  ├─ Detect role: detectUserRole() returns 'client'
  ├─ Client is a member of:
  │   ├─ Org space (invited by admin)
  │   └─ Portal room(s) for their matters (invited by admin)
  │   └─ NOT matter rooms (staff-only, not invited)
  │
  ├─ UI renders in client mode:
  │   ├─ Only portal room data visible
  │   ├─ Only client_visible tables shown
  │   ├─ Only client_visible fields within those tables
  │   ├─ Can send law.firm.client.message events (power level 10)
  │   ├─ Cannot modify records (requires power level 50+)
  │   ├─ Cannot see internal notes (NOTE_INTERNAL requires STAFF)
  │   └─ Cannot see other clients' data (separate rooms)
```

### 1.5 Staff User Flow

```
Staff user opens app (power level 50 in org space)
  │
  ├─ Login → role = 'staff'
  ├─ Member of:
  │   ├─ Org space
  │   ├─ All table rooms (invited by bot/admin)
  │   ├─ Client matter rooms (staff access)
  │   └─ Portal rooms (can observe client interactions)
  │
  ├─ Can:
  │   ├─ View all tables and records
  │   ├─ Create, update, delete records
  │   ├─ Create and share views
  │   ├─ Write internal notes
  │   ├─ See full field data (including non-client-visible fields)
  │   └─ Access mutation history / changelog
  │
  ├─ Cannot:
  │   ├─ Modify schema (table/field definitions) — requires ADMIN (100)
  │   ├─ Change power levels — requires ADMIN
  │   ├─ Manage org config — requires ADMIN
  │   └─ Provision API keys — requires ADMIN
```

### 1.6 Admin User Flow

```
Admin user opens app (power level 100, or in ADMIN_USERNAMES)
  │
  ├─ Login → role = 'admin'
  ├─ Full access to everything staff can do, plus:
  │   ├─ Create/modify org space configuration
  │   ├─ Create/delete table rooms
  │   ├─ Modify table and field schemas
  │   ├─ Invite/kick users from rooms
  │   ├─ Set user power levels
  │   ├─ Manage bridge configuration
  │   ├─ Enable/disable client portal access
  │   ├─ Provision API keys via account data
  │   └─ Trigger Airtable sync
```

---

## Part 2: Permissioning & Access Control

### 2.1 Permission Model Summary

Access control is enforced at **three layers**:

| Layer | Mechanism | Enforced By |
|-------|-----------|-------------|
| **Room membership** | Users must be invited/joined to a room to see its events | Synapse homeserver |
| **Power levels** | Event types require minimum power level to send | Synapse homeserver |
| **Client-side role checks** | UI hides features based on detected role | Client app |

**Critical insight**: Layers 1 and 2 are server-enforced (trustworthy). Layer 3 is defense-in-depth only — a modified client could bypass UI restrictions, but Synapse still enforces room membership and power levels.

### 2.2 Room Membership Matrix

| Room Type | Admin | Staff | Client | Purpose |
|-----------|-------|-------|--------|---------|
| Org Space | Member (PL 100) | Member (PL 50) | Member (PL 10) | Org-wide config, shared views, schemas |
| Table Rooms | Member (PL 100) | Member (PL 50) | Not member | Data storage per Airtable table |
| Client Space | Member | Member | Member (own) | Organizes a client's rooms |
| Matter Room | Member | Member | Not member | Internal staff data per client |
| Portal Room | Member | Member | Member | Filtered, client-visible data |

### 2.3 Event Type Power Level Requirements

| Event Type | Required PL | Who Can Send |
|------------|------------|-------------|
| `law.firm.org.config` | 100 (ADMIN) | Admin only |
| `law.firm.schema.table` | 100 (ADMIN) | Admin only |
| `law.firm.schema.field` | 100 (ADMIN) | Admin only |
| `law.firm.record` | 50 (STAFF) | Staff, Admin |
| `law.firm.record.create/update/delete` | 50 (STAFF) | Staff, Admin |
| `law.firm.record.mutate` | 50 (STAFF) | Staff, Admin |
| `law.firm.view.share` | 50 (STAFF) | Staff, Admin |
| `law.firm.view.delete` | 50 (STAFF) | Staff, Admin |
| `law.firm.note.internal` | 50 (STAFF) | Staff, Admin |
| `law.firm.client.message` | 10 (CLIENT) | Client, Staff, Admin |
| `m.room.power_levels` | 100 (ADMIN) | Admin only |
| `m.room.member` | 100 (ADMIN) | Admin only (invites/kicks) |

### 2.4 Known Permission Gaps & Issues

#### Gap 1: Hardcoded Admin List

**Current state**: `ADMIN_USERNAMES = ['admin']` in `matrix.js:62`. Any user whose localpart is "admin" is treated as admin regardless of actual power level.

**Risk**: If a federated user `@admin:evil.server` somehow joins the org space, they'd be treated as admin by the client. This is client-side only (Synapse still enforces real power levels), but it breaks the trust model for client-side logic.

**Recommendation**: Replace the hardcoded list with a configurable value stored in `law.firm.org.config` state event:

```javascript
// In org config state event:
{
    version: '1',
    name: 'Immigration Firm',
    adminUsers: ['@admin:amino.im'],  // full MXIDs, not localparts
    ...
}
```

This makes admin detection verifiable against the org's own config rather than a code-level assumption.

#### Gap 2: Portal Room Field Filtering is Incomplete

**Current state**: `enablePortalAccess()` at `matrix.js:1556-1564` copies records to portal rooms with a `// TODO: filter fields` comment. Client-visible field filtering is not yet applied to record data when writing to portal rooms.

**Risk**: Client users in portal rooms may see fields that should be staff-only, because the full record data is copied without filtering.

**Fix**: Apply field projection using `writeProjectedRecord()` (which already exists at `matrix.js:899-910`) instead of raw `sendStateEvent`:

```javascript
// Instead of:
await MatrixClient.sendStateEvent(portalRoomId, event.type, event.state_key, event.content);

// Use:
var fieldSchemas = {}; // build from schema events
await MatrixClient.writeProjectedRecord(portalRoomId, tblId, recId, event.content.data, fieldSchemas);
```

#### Gap 3: Room History Visibility

**Current state**: All rooms are created with `history_visibility: 'shared'`, meaning any member can see all events from the point they joined.

**Implication**: If a client user is invited to a portal room, they can see all events that were in the room before they joined. For matter rooms this is fine (clients aren't members), but for portal rooms, this means adding a new record to a portal room and then inviting the client exposes historical records.

**This is actually the correct behavior** for this use case — clients should see their full case history. But it's worth noting that `history_visibility: 'invited'` (only see events from invite time forward) is available if a more restrictive model is needed for specific rooms.

#### Gap 4: No Per-Field Write Permissions

**Current state**: If a user has STAFF power level, they can modify any field in any record they have access to. There's no way to make specific fields read-only for staff while editable for admin.

**Recommendation**: The `readOnly` flag on field schemas (`law.firm.schema.field`) is present but only enforced client-side. For true enforcement, consider a Matrix application service that validates record mutations against field-level ACLs.

#### Gap 5: Cross-Client Data Leakage via Linked Records

**Current state**: Linked record fields can reference records in other tables. If Client A's matter room contains a record with a linked record field pointing to a record in Client B's matter, the reference itself (a record ID) is visible, though the referenced data is not (different room).

**Risk**: Minimal — the record ID alone doesn't reveal data. But for strict data isolation, linked record fields shown in portal rooms should be resolved only against records the client has access to, and unresolvable references should be hidden.

#### Gap 6: Session Token Lifetime

**Current state**: Matrix access tokens are stored in both `sessionStorage` (volatile) and `localStorage` (persistent). The token in `localStorage` persists until explicit logout or token invalidation.

**Risk**: If a user doesn't explicitly log out, their access token remains valid indefinitely (default Synapse behavior). A stolen device with a saved token could access data.

**Recommendation**:
- Set a maximum token lifetime via Synapse config
- Implement periodic `/whoami` checks to detect revoked tokens
- On detected revocation, trigger local cleanup immediately

#### Gap 7: Encryption Key Scope

**Current state**: All users on the same homeserver who know each other's Synapse passwords could derive each other's encryption keys (since the salt is `amino-local-encrypt:` + userId, which is public). The PBKDF2 derivation prevents this in practice (they'd need the password), but the salt isn't secret.

**Assessment**: This is fine. PBKDF2 with a known salt is standard practice. The security comes from the password, not the salt. The salt prevents rainbow tables and ensures per-user uniqueness.

### 2.5 Access Revocation Flow

```
Admin revokes a user's access:
  │
  ├─ Step 1: Deactivate Synapse account (or change password)
  │   → User can no longer authenticate
  │   → Existing access tokens may still work until expired/invalidated
  │
  ├─ Step 2: Invalidate all access tokens via Synapse admin API
  │   POST /_synapse/admin/v1/users/@user:server/logout
  │   → All devices logged out immediately
  │   → Next /sync or API call returns 401
  │   → Client detects 401 → clears session → shows login
  │
  ├─ Step 3: Remove from rooms
  │   → MatrixClient.kickUser(roomId, userId) for each room
  │   → User loses room membership → can't read events
  │
  ├─ Step 4: Remove API key from account data
  │   → Even if user has a cached token, data APIs reject requests
  │
  └─ Result: User's local IndexedDB data remains encrypted
     → Without the Synapse password, the encryption key can't be derived
     → Without the access token, no new data can be synced
     → Without room membership, no Matrix events are visible
     → The user is fully locked out
```

### 2.6 Federation Considerations

**Current state**: The system assumes a single homeserver (all users on the same Synapse instance). Federation introduces risks:

1. **Federated users bypassing power levels**: If a room is accidentally made public or a federated user is invited, they could read events. **Mitigation**: All rooms use `preset: 'private_chat'` and require explicit invites.

2. **Event encryption**: The current approach encrypts event payloads with per-user keys. Federated users wouldn't have the key to decrypt. But unencrypted metadata (record IDs, table IDs, timestamps) would be visible in room state.

3. **Homeserver admin access**: The Synapse admin can read all room events (they're stored unencrypted on the server unless Matrix E2EE is used). This is acceptable when the firm controls the homeserver, but not if hosted by a third party.

**Recommendation**: For law firm deployments, always self-host Synapse. For multi-tenant or hosted deployments, consider enabling Matrix E2EE (megolm) for room events — this is a significant architectural change but would make server-side data unreadable.

---

## Part 3: Offline Access

### 3.1 Design Goals

1. **Offline data access**: Users who have previously logged in can read all their cached data without internet
2. **Offline login**: Users can unlock their local data using their Synapse password even when the homeserver is unreachable
3. **Write queuing**: Changes made offline are queued and synced when connectivity resumes
4. **Session persistence**: The app should survive intermittent connectivity without losing state
5. **Security**: Offline access must not weaken the security model — revoked users should not retain access indefinitely

### 3.2 Offline Login Architecture

The key challenge: deriving the encryption key requires the user's password, but verifying the password currently requires the Synapse homeserver. For offline login, we need a way to verify the password locally.

**Solution: Local password verification via the encryption verification token.**

The verification token (already stored in IndexedDB `crypto` store) is the encryption of the known plaintext `'amino-encryption-verify'` with the user's derived key. During offline login:

1. User enters their Synapse password
2. App derives the encryption key: `PBKDF2(password, "amino-local-encrypt:" + userId)`
3. App attempts to decrypt the stored verification token
4. If decryption succeeds and yields `'amino-encryption-verify'` → password is correct
5. App unlocks IndexedDB data using the derived key
6. App enters **offline mode** (read-only, no sync)

```
Offline Login Flow:
  │
  ├─ User opens app, homeserver unreachable
  │
  ├─ localStorage has saved session (userId, homeserverUrl)
  ├─ IndexedDB has encrypted data + verification token
  │
  ├─ Show offline login screen:
  │   "You appear to be offline. Enter your password to access cached data."
  │   [password field] [Unlock]
  │
  ├─ User enters password →
  │   ├─ Derive key from password + userId
  │   ├─ Attempt to decrypt verification token
  │   │   ├─ Success → password is correct
  │   │   │   ├─ Open IndexedDB
  │   │   │   ├─ Set _cryptoKey in memory
  │   │   │   ├─ Enter offline mode
  │   │   │   │   ├─ All reads work (getTableRecords, getRecord, searchRecords)
  │   │   │   │   ├─ Writes are queued to a pending_mutations store
  │   │   │   │   ├─ UI shows "Offline — changes will sync when online" banner
  │   │   │   │   ├─ Periodically attempt to reach homeserver
  │   │   │   │   └─ On reconnect → flush pending mutations, resume normal sync
  │   │   │   └─ Load cached tables, records, views from IndexedDB
  │   │   │
  │   │   └─ Failure → "Incorrect password"
  │   │
  │   └─ No verification token in IndexedDB → "No cached data. Connect to internet to log in."
```

### 3.3 Implementation: Offline Session Manager

New module to add to `data-layer.js`:

```javascript
// ============ Offline Session Manager ============

// State tracking
var _offlineMode = false;
var _pendingMutations = [];   // queued writes awaiting connectivity
var _connectivityCheckTimer = null;
var CONNECTIVITY_CHECK_INTERVAL = 30000; // 30 seconds

// Check if we can reach the homeserver
async function checkConnectivity() {
    var config = MatrixClient.loadConfig();
    if (!config || !config.bridge || !config.bridge.orgSpaceId) {
        // Try localStorage session for homeserver URL
        try {
            var session = JSON.parse(localStorage.getItem('matrix_session') || '{}');
            if (!session.homeserverUrl) return false;
            var response = await fetch(session.homeserverUrl + '/_matrix/client/versions', {
                signal: AbortSignal.timeout(5000)
            });
            return response.ok;
        } catch (e) {
            return false;
        }
    }
    try {
        var homeserverUrl = MatrixClient.getHomeserverUrl();
        if (!homeserverUrl) return false;
        var response = await fetch(homeserverUrl + '/_matrix/client/versions', {
            signal: AbortSignal.timeout(5000)
        });
        return response.ok;
    } catch (e) {
        return false;
    }
}

// Attempt offline unlock using stored verification token
async function offlineUnlock(password) {
    // 1. Get userId from localStorage session
    var session;
    try {
        session = JSON.parse(localStorage.getItem('matrix_session') || '{}');
    } catch (e) {
        throw new Error('No saved session found');
    }
    if (!session.userId) {
        throw new Error('No saved session found. You must log in online first.');
    }

    // 2. Open IndexedDB
    var db = await openDatabase();

    // 3. Read verification token
    var cryptoTx = db.transaction('crypto', 'readonly');
    var verifyEntry = await idbGet(cryptoTx.objectStore('crypto'), 'verify');
    if (!verifyEntry || !verifyEntry.value) {
        db.close();
        throw new Error('No cached data available. Connect to internet for initial login.');
    }

    // 4. Derive key and verify
    var key = await deriveSynapseKey(password, session.userId);
    var isValid = await verifyEncryptionKey(key, verifyEntry.value);
    if (!isValid) {
        db.close();
        throw new Error('Incorrect password');
    }

    // 5. Success — set up offline session
    _db = db;
    _cryptoKey = key;
    _userId = session.userId;
    _offlineMode = true;

    // 6. Load cached tables from IndexedDB
    var tablesTx = db.transaction('tables', 'readonly');
    _tables = await idbGetAll(tablesTx.objectStore('tables'));
    _tableIds = _tables.map(function(t) { return t.table_id; });

    // Rebuild table-room map from cached tables
    _tableRoomMap = {};
    _roomTableMap = {};
    for (var i = 0; i < _tables.length; i++) {
        var t = _tables[i];
        if (t.matrix_room_id) {
            _tableRoomMap[t.table_id] = t.matrix_room_id;
            _roomTableMap[t.matrix_room_id] = t.table_id;
        }
    }

    _initialized = true;

    // 7. Start connectivity monitoring
    startConnectivityMonitor();

    return {
        userId: session.userId,
        tables: _tables,
        offlineMode: true,
        lastSynced: await getLastSyncTime()
    };
}

// Get the most recent sync timestamp across all tables
async function getLastSyncTime() {
    if (!_db) return null;
    var tx = _db.transaction('sync', 'readonly');
    var allSync = await idbGetAll(tx.objectStore('sync'));
    if (allSync.length === 0) return null;
    var latest = allSync.reduce(function(max, entry) {
        return entry.lastSynced > max ? entry.lastSynced : max;
    }, allSync[0].lastSynced);
    return latest;
}

// Monitor for connectivity restoration
function startConnectivityMonitor() {
    if (_connectivityCheckTimer) return;

    _connectivityCheckTimer = setInterval(async function() {
        if (!_offlineMode) {
            stopConnectivityMonitor();
            return;
        }

        var online = await checkConnectivity();
        if (online) {
            window.dispatchEvent(new CustomEvent('amino:connectivity-restored'));
            // Don't auto-transition — let the UI prompt the user
        }
    }, CONNECTIVITY_CHECK_INTERVAL);

    // Also listen for browser online event
    window.addEventListener('online', function() {
        // Browser thinks we're online — verify with homeserver
        checkConnectivity().then(function(reachable) {
            if (reachable) {
                window.dispatchEvent(new CustomEvent('amino:connectivity-restored'));
            }
        });
    });
}

function stopConnectivityMonitor() {
    if (_connectivityCheckTimer) {
        clearInterval(_connectivityCheckTimer);
        _connectivityCheckTimer = null;
    }
}
```

### 3.4 Offline Write Queue

When offline, writes are queued in a new IndexedDB store and flushed when connectivity returns:

```javascript
// New IndexedDB store (add to DB_VERSION upgrade):
// 'pending_mutations': { id (auto), tableId, recordId, op, fields, timestamp, status }

async function queueOfflineMutation(tableId, recordId, fields, op) {
    if (!_db) throw new Error('Database not open');

    var tx = _db.transaction('pending_mutations', 'readwrite');
    await idbPut(tx.objectStore('pending_mutations'), {
        id: 'mut_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        tableId: tableId,
        recordId: recordId,
        op: op || 'ALT',
        fields: fields,
        timestamp: Date.now(),
        status: 'pending'
    });
    await idbTxDone(tx);

    // Also apply to local IndexedDB immediately (optimistic update)
    await applyLocalMutation(tableId, recordId, fields, op);

    window.dispatchEvent(new CustomEvent('amino:offline-mutation-queued', {
        detail: { tableId, recordId, op, queueDepth: await getPendingMutationCount() }
    }));
}

async function flushPendingMutations() {
    if (!_db || _offlineMode) return { flushed: 0, failed: 0 };

    var tx = _db.transaction('pending_mutations', 'readonly');
    var pending = await idbGetAll(tx.objectStore('pending_mutations'));

    if (pending.length === 0) return { flushed: 0, failed: 0 };

    var flushed = 0;
    var failed = 0;

    // Sort by timestamp (oldest first) to preserve operation order
    pending.sort(function(a, b) { return a.timestamp - b.timestamp; });

    for (var i = 0; i < pending.length; i++) {
        var mutation = pending[i];
        try {
            await sendEncryptedTableRecord(
                mutation.tableId,
                mutation.recordId,
                mutation.fields,
                mutation.op
            );

            // Remove from queue
            var delTx = _db.transaction('pending_mutations', 'readwrite');
            delTx.objectStore('pending_mutations').delete(mutation.id);
            await idbTxDone(delTx);

            flushed++;
        } catch (err) {
            console.error('[AminoData] Failed to flush mutation:', mutation.id, err);
            failed++;
            // Don't remove — will retry on next flush
        }
    }

    if (flushed > 0) {
        window.dispatchEvent(new CustomEvent('amino:offline-mutations-flushed', {
            detail: { flushed, failed, remaining: failed }
        }));
    }

    return { flushed, failed };
}

async function getPendingMutationCount() {
    if (!_db) return 0;
    var tx = _db.transaction('pending_mutations', 'readonly');
    var all = await idbGetAll(tx.objectStore('pending_mutations'));
    return all.length;
}
```

### 3.5 Online/Offline Transition

```
Offline → Online Transition:
  │
  ├─ amino:connectivity-restored event fires
  │
  ├─ UI shows: "Connection restored. [Sync Now] [Stay Offline]"
  │
  ├─ User clicks "Sync Now":
  │   ├─ Verify existing access token with /whoami
  │   │   ├─ Valid →
  │   │   │   ├─ Flush pending mutations (oldest first)
  │   │   │   ├─ Run incremental sync for all tables
  │   │   │   ├─ Resume Matrix realtime sync loop
  │   │   │   ├─ Clear offline mode flag
  │   │   │   └─ UI removes offline banner
  │   │   │
  │   │   └─ Invalid (401) →
  │   │       ├─ Token was revoked while offline
  │   │       ├─ Show full login screen
  │   │       ├─ On successful login → flush pending mutations → resume
  │   │       └─ If account deactivated → pending mutations are lost
  │   │           (UI warns: "Your account has been deactivated. Unsaved
  │   │            changes cannot be synced. Export local data?")

Online → Offline Transition:
  │
  ├─ Detected by:
  │   ├─ Matrix sync loop gets network error (not 429, not 401)
  │   ├─ fetch() throws TypeError (network unreachable)
  │   ├─ Browser 'offline' event
  │
  ├─ App transitions to offline mode:
  │   ├─ Stop Matrix sync loop (will auto-retry on error, but mark offline)
  │   ├─ Stop HTTP polling
  │   ├─ Set _offlineMode = true
  │   ├─ UI shows "Offline — changes will sync when reconnected" banner
  │   ├─ All reads continue working (IndexedDB)
  │   ├─ All writes go to pending_mutations queue
  │   └─ Start connectivity monitor
```

### 3.6 Offline Access Security Constraints

#### Time-Limited Offline Access

Unrestricted offline access means a revoked user could continue reading cached data indefinitely. To mitigate this:

```javascript
// Store the last successful online authentication timestamp
var OFFLINE_ACCESS_MAX_DAYS = 30; // configurable per org

async function checkOfflineAccessExpiry() {
    var cryptoTx = _db.transaction('crypto', 'readonly');
    var lastOnlineAuth = await idbGet(cryptoTx.objectStore('crypto'), 'lastOnlineAuth');

    if (!lastOnlineAuth) return false; // Never authenticated online

    var daysSinceAuth = (Date.now() - lastOnlineAuth.value) / (1000 * 60 * 60 * 24);

    if (daysSinceAuth > OFFLINE_ACCESS_MAX_DAYS) {
        return false; // Offline access expired
    }

    return true; // Still within offline access window
}
```

When offline access expires:
- The app refuses to unlock with just a password
- Shows: "Offline access has expired. Connect to the internet to re-authenticate."
- The encrypted data remains in IndexedDB but is inaccessible until online auth succeeds
- This ensures that revoked users lose access within the configured window

The `OFFLINE_ACCESS_MAX_DAYS` value should be stored in the org config (`law.firm.org.config`) and cached locally, so admins can tighten or loosen the window:

```javascript
{
    version: '1',
    name: 'Immigration Firm',
    offlineAccessMaxDays: 30,  // 0 = no offline access allowed
    ...
}
```

#### Offline Access Doesn't Bypass Encryption

Even in offline mode, all data is read through the encryption layer. If the password is wrong, the verification token check fails and no data is accessible. The encryption key is never stored persistently — it exists only in memory (and optionally `sessionStorage` for same-tab refresh).

#### Pending Mutations and Conflict Resolution

Mutations made offline may conflict with changes made by other users online. The conflict resolution strategy is **last-writer-wins at the field level**:

1. Offline mutations are timestamped when created
2. When flushed, they're sent as `law.firm.record.mutate` events with the original timestamp
3. Other clients process them via the normal Matrix sync loop
4. Since mutations use ALT (merge) semantics, only the specific fields changed offline are affected
5. If the same field was modified both online and offline, the last event in the Matrix timeline wins

For the law firm use case, this is acceptable — simultaneous edits to the same field of the same record are rare, and the full mutation history in Matrix provides an audit trail for resolving disputes.

### 3.7 IndexedDB Schema Changes

The `pending_mutations` store needs to be added in a database version upgrade:

```javascript
var DB_VERSION = 2; // bumped from 1

// In openDatabase() onupgradeneeded:
if (!db.objectStoreNames.contains('pending_mutations')) {
    var mutStore = db.createObjectStore('pending_mutations', { keyPath: 'id' });
    mutStore.createIndex('byTable', 'tableId', { unique: false });
    mutStore.createIndex('byStatus', 'status', { unique: false });
    mutStore.createIndex('byTimestamp', 'timestamp', { unique: false });
}
```

### 3.8 Offline Capabilities by Role

| Capability | Admin (Offline) | Staff (Offline) | Client (Offline) |
|-----------|----------------|-----------------|------------------|
| Read cached records | Yes | Yes | Yes (portal data only) |
| Search cached records | Yes | Yes | Yes (portal data only) |
| View cached views | Yes | Yes | Yes |
| Queue record edits | Yes | Yes | No (clients can't edit) |
| Queue messages | No | No | Yes (client messages queued) |
| Modify schema | No (requires server) | N/A | N/A |
| Manage users | No (requires server) | N/A | N/A |
| See mutation history | Cached only | Cached only | N/A |

### 3.9 Service Worker Consideration

For true offline-first behavior (app loads without internet), a service worker should cache the app shell:

```javascript
// sw.js — caches index.html, matrix.js, data-layer.js, formula engine
var CACHE_NAME = 'amino-v1';
var APP_SHELL = [
    '/',
    '/index.html',
    '/matrix.js',
    '/data-layer.js',
    '/src/formulas/index.js',
    '/src/formulas/parser.js',
    '/src/formulas/compiler.js',
    '/src/formulas/registry.js',
    '/src/formulas/eo-ir.js',
    '/src/formulas/integration.js',
    '/src/formulas/ui.js',
    '/src/formulas/ui.css'
];

self.addEventListener('install', function(event) {
    event.waitUntil(
        caches.open(CACHE_NAME).then(function(cache) {
            return cache.addAll(APP_SHELL);
        })
    );
});

self.addEventListener('fetch', function(event) {
    // Network-first for API calls, cache-first for app shell
    if (event.request.url.includes('/webhook/') || event.request.url.includes('/_matrix/')) {
        event.respondWith(
            fetch(event.request).catch(function() {
                return new Response(JSON.stringify({ error: 'offline' }), {
                    headers: { 'Content-Type': 'application/json' }
                });
            })
        );
    } else {
        event.respondWith(
            caches.match(event.request).then(function(cached) {
                return cached || fetch(event.request);
            })
        );
    }
});
```

Without a service worker, the user must have the app tab already open (or browser-cached) to use offline mode. With the service worker, the app loads from cache and immediately enters offline login flow.

---

## Part 4: Implementation Checklist

### Phase 1: Offline Read Access (Core)

- [ ] Add `offlineUnlock()` to `data-layer.js` — password-based local verification
- [ ] Add `_offlineMode` flag and `isOffline()` getter
- [ ] Add `checkConnectivity()` helper
- [ ] Add connectivity monitor (periodic check + browser events)
- [ ] Modify boot sequence to detect offline state and offer offline login
- [ ] Add offline banner UI component
- [ ] Store `lastOnlineAuth` timestamp on successful online login
- [ ] Add `checkOfflineAccessExpiry()` with configurable window
- [ ] Cache `offlineAccessMaxDays` from org config locally

### Phase 2: Offline Write Queue

- [ ] Bump `DB_VERSION` to 2, add `pending_mutations` store
- [ ] Add `queueOfflineMutation()` with optimistic local apply
- [ ] Add `flushPendingMutations()` with ordered replay
- [ ] Add `getPendingMutationCount()` for UI badge
- [ ] Wire up online/offline transition handlers
- [ ] Add UI for pending mutation count and sync status
- [ ] Handle flush failures (retry logic, user notification)

### Phase 3: Permission Hardening

- [ ] Replace hardcoded `ADMIN_USERNAMES` with org config-driven admin list
- [ ] Fix portal room field filtering (use `writeProjectedRecord`)
- [ ] Add field-level read permission checks in portal data projection
- [ ] Add periodic `/whoami` checks for session validity (every 5 minutes when online)
- [ ] Store max token lifetime and enforce client-side session expiry

### Phase 4: Service Worker & App Shell Caching

- [ ] Create `sw.js` with app shell caching strategy
- [ ] Register service worker from `index.html`
- [ ] Add cache versioning and update flow
- [ ] Test full offline app load (no network at all)

### Phase 5: Conflict Resolution & Edge Cases

- [ ] Implement field-level last-writer-wins for offline mutation conflicts
- [ ] Add "export local data" option for deactivated accounts
- [ ] Handle password change while offline (detection on reconnect)
- [ ] Handle org config changes while offline (role changes, permission changes)
- [ ] Add telemetry for offline session duration and mutation queue depth

---

## Security Summary

| Threat | Mitigation | Layer |
|--------|-----------|-------|
| Stolen device, user logged in | Encryption key only in memory/sessionStorage; tab close clears it; password required for new tab | Client |
| Stolen device, user logged out | IndexedDB encrypted; no key without password; no session to restore | Client |
| Revoked user, still has cached data | Offline access window expires after N days; online re-auth required | Client + Policy |
| Revoked user, has pending offline writes | On reconnect, token is invalid (401); pending writes can't flush; user warned | Server |
| Password changed by admin while user offline | On reconnect, derived key won't match; user prompted for new password or data wipe | Client |
| Federated user joins room | Private rooms require invite; power levels enforced by Synapse | Server |
| Modified client bypasses UI role checks | Synapse enforces room membership and power levels server-side | Server |
| Homeserver admin reads room data | Self-host Synapse; or use Matrix E2EE for room events | Deployment |
| Offline mutation conflicts | Field-level ALT merge; full audit trail in Matrix timeline | Application |
