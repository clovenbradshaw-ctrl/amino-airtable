# Synapse-Unified Login & Encryption Design

## Goal

Collapse the current three-credential flow (encryption password + API key + optional Synapse login) into a **single Synapse password** at `app.aminoimmigration.com`. The user logs in once with their Matrix credentials and everything else — local encryption, API access, Matrix sync — derives from that single authentication.

---

## Current State (3 screens, 3 credentials)

```
1. Unlock Screen        →  local encryption password (or passkey)
2. Auth Screen          →  API key + optional set filter
3. Synapse Login Screen →  Matrix username/password (optional, sidebar)
```

**Problems:**
- Users manage three separate secrets
- Synapse login is optional — the app works without it, which defeats the purpose of Matrix-based access control
- The encryption password and API key have no relationship to the Synapse identity
- If a user is removed from the Synapse homeserver, their local app still works with a cached API key

---

## Proposed State (1 screen, 1 credential)

```
1. Synapse Login Screen  →  Matrix username/password
   (everything else derived automatically)
```

The Synapse password becomes the single point of entry. Local encryption and API access are derived from or provisioned through the Synapse session.

---

## Architecture

### Phase 1: Synapse Login as the Gate

**Boot sequence changes:**

```
Current:
  initEncryption() → [unlock screen] → initAuthScreen() → [API key screen] → init()

Proposed:
  requireSynapseLogin() → [single login screen] → deriveEncryption() → resolveApiKey() → init()
```

1. On app load, check for a valid Synapse session (existing `verifySynapseSession()` logic).
2. If no valid session, show the Synapse login screen. This is now **mandatory**, not optional.
3. After successful Synapse auth, derive everything else from the session.

### Phase 2: Deriving Local Encryption from the Synapse Password

**Key insight:** The Synapse password is available in memory during `trySynapseLogin()` (line 6337). We can use it as the input to the existing `deriveKeyFromPassword()` PBKDF2 flow before it's discarded.

**Approach — Password-derived key with Synapse password as input:**

```javascript
async function loginAndDeriveEncryption(username, password) {
    // Step 1: Authenticate with Synapse (validates the password is correct)
    var synapseSession = await synapseLogin(username, password);

    // Step 2: Derive local encryption key from the same password
    //   - Use a domain-separated salt: "amino-local-encryption:" + userId
    //   - This ensures the derived key is unique to this app even if the
    //     same password is used elsewhere
    var salt = new TextEncoder().encode('amino-local-encrypt:' + synapseSession.userId);
    var encryptionKey = await deriveKeyFromPassword(password, salt);

    // Step 3: Password is no longer needed — clear it from memory
    password = null;

    // Step 4: Store encryption key in sessionStorage (existing pattern)
    await saveSessionKey(encryptionKey);

    return { synapseSession, encryptionKey };
}
```

**Why this works:**
- The Synapse server validates the password (we don't accept a wrong password)
- PBKDF2 derivation is one-way — the encryption key cannot reverse to the password
- The salt includes the userId, so different users on the same device get different keys
- Existing `encryptForStorage()` / `decryptFromStorage()` continue to work unchanged
- Existing passkey flow can remain as an alternative unlock method for returning sessions

**What changes vs. the current encryption setup:**
- No separate "Set up encryption password" screen
- No "confirm password" step — the Synapse server is the password validator
- The salt is deterministic (based on userId) rather than random — this is intentional so re-login after clearing sessionStorage regenerates the same key
- On first login, a verification token is still created and stored so session key restore works

### Phase 3: API Key Provisioning via Synapse

The API key (Xano) is currently entered manually. There are several strategies to eliminate this:

**Option A: Store API key in Matrix account data (recommended)**

Matrix supports per-user private account data via `PUT /_matrix/client/v3/user/{userId}/account_data/{type}`.

```javascript
// Admin provisions the API key once:
await matrixClient.setAccountData('law.firm.api_config', {
    apiKey: 'xano-api-key-here',
    setFilter: 'optional-filter'
});

// On login, the app reads it:
var config = await matrixClient.getAccountData('law.firm.api_config');
API_KEY = config.apiKey;
SET_FILTER = config.setFilter || null;
```

**Advantages:**
- Account data is private to the user (not visible to other room members)
- Automatically synced across devices via Matrix
- Admin can provision it during user onboarding
- Revokable — admin removes the account data or changes the key
- No additional infrastructure needed

**Option B: Store API key in org space state event**

```javascript
// Store in the org config room as a state event
await sendStateEvent(orgSpaceId, 'law.firm.api.config', '', {
    apiKey: 'shared-org-key',
    setFilter: null
});
```

Simpler but the key is shared across the org and visible to all room members with sufficient power level.

**Option C: Server-side API key issuance**

A small server-side component (could be an n8n workflow) that:
1. Receives a valid Matrix access token
2. Validates it against the homeserver
3. Returns the appropriate API key for that user

This adds infrastructure but provides the most control.

**Recommendation:** Option A for initial implementation. It's zero-infrastructure, per-user, and private. Option C is the long-term ideal if you want per-user API keys with audit logging.

---

## Detailed Login Flow

```
User opens app
  │
  ├─ Check localStorage for Synapse session
  │   ├─ Session exists → verify with /whoami
  │   │   ├─ Valid → restore session key from sessionStorage
  │   │   │   ├─ Session key valid → auto-login (fetch API key from account data, init)
  │   │   │   └─ Session key missing → show "Enter your password to unlock"
  │   │   │       (single password field, same Synapse password, re-derive key)
  │   │   └─ Invalid/expired → clear session, show login screen
  │   └─ No session → show login screen
  │
  ├─ Login screen: username + password
  │   │
  │   ├─ POST /_matrix/client/v3/login
  │   │   ├─ Success →
  │   │   │   ├─ Save Synapse session (access_token, user_id, device_id)
  │   │   │   ├─ Derive encryption key from password + userId salt
  │   │   │   ├─ Save session key to sessionStorage
  │   │   │   ├─ Check for encryption config in localStorage
  │   │   │   │   ├─ Exists → verify derived key against verification token
  │   │   │   │   │   ├─ Match → proceed
  │   │   │   │   │   └─ Mismatch → user changed Synapse password
  │   │   │   │   │       → re-encrypt local data with new key (migration)
  │   │   │   │   └─ First time → create verification token, save config
  │   │   │   ├─ Fetch API key from Matrix account data
  │   │   │   │   ├─ Found → set API_KEY, initSecureEndpoints, init()
  │   │   │   │   └─ Not found → show "Contact admin to provision access"
  │   │   │   └─ Start Matrix sync for real-time updates
  │   │   └─ Failure → show error
  │   │
  │   └─ [Optional: "Use passkey" button for biometric unlock on return visits]
```

---

## Handling Password Changes

If a user changes their Synapse password, the derived encryption key changes. This needs a migration path:

```javascript
async function handlePasswordChange(oldKey, newKey) {
    // 1. Read all encrypted data from IndexedDB using old key
    // 2. Re-encrypt each record with the new key
    // 3. Update the verification token
    // 4. Save new encryption config
}
```

**Detection:** When the user logs in with a new password, the derived key won't match the stored verification token. At that point:

1. Prompt: "It looks like your password changed. Enter your previous password to migrate your local data."
2. Derive old key from previous password, decrypt everything, re-encrypt with new key.
3. **Or**, if they don't have their old password: wipe local IndexedDB and re-sync from server (data is not lost — it's all in Synapse/Xano).

---

## Access Revocation

With Synapse as the gate, revoking access is straightforward:

1. **Deactivate or lock the user's Synapse account** — they can no longer log in
2. **Remove their API key from account data** — even if they have a cached session, they can't fetch data
3. **Invalidate their access tokens** via Synapse admin API — forces re-login on next app load
4. **Local encrypted data** remains on their device but is useless without the Synapse password to derive the decryption key (and without the API key, they can't sync new data)

---

## Implementation Checklist

### Remove / Consolidate
- [ ] Remove the standalone encryption setup screen (`unlock-setup` UI)
- [ ] Remove the standalone API key auth screen (`auth-screen` UI)
- [ ] Remove `setupEncryptionWithPassword()` as a separate flow
- [ ] Remove `skipEncryption()` option (encryption is now mandatory, derived from Synapse pwd)
- [ ] Remove manual API key input fields

### Modify
- [ ] `trySynapseLogin()` — after successful Matrix auth, derive encryption key from password before clearing it
- [ ] `initEncryption()` — check for Synapse session instead of standalone config; use session-derived key
- [ ] `initAuthScreen()` — replace with API key fetch from Matrix account data
- [ ] Boot sequence — `requireSynapseLogin()` → derive key → fetch API key → `init()`
- [ ] `verifySynapseSession()` — on valid cached session, try to restore sessionStorage key; if missing, prompt for password (not a full re-login, just the Synapse password to re-derive)
- [ ] `logout()` — clear Synapse session, encryption key, API key, endpoints all at once

### Add
- [ ] `deriveEncryptionFromSynapsePassword(password, userId)` — deterministic salt PBKDF2 derivation
- [ ] `fetchApiKeyFromAccountData()` — read `law.firm.api_config` from Matrix account data
- [ ] `provisionApiKey(userId, apiKey)` — admin function to set account data for a user (can be an admin page or n8n workflow)
- [ ] Password change detection and migration flow
- [ ] "Contact your administrator" screen when no API key is provisioned in account data

### Keep Unchanged
- `encryptForStorage()` / `decryptFromStorage()` — still use `encryptionKey`, just derived differently
- `deriveKeyFromPassword()` — same PBKDF2 function, just called with Synapse password + deterministic salt
- `encryptData()` / `decryptData()` — same AES-GCM primitives
- Passkey support — can still be offered as alternative unlock for returning sessions
- `MatrixClient` / `matrix.js` — no changes needed, already supports login and room operations
- IndexedDB structure — unchanged
- All rendering and data sync logic — unchanged

---

## Security Considerations

| Concern | Mitigation |
|---------|-----------|
| Synapse password in memory during login | Cleared immediately after key derivation; same exposure window as current flow |
| Deterministic salt (userId-based) | Acceptable — salt prevents rainbow tables; uniqueness per-user is sufficient |
| Offline access after session expiry | Session key in sessionStorage allows encrypted data access within same tab; new tab requires re-login |
| Compromised device | Same risk as current flow — encrypted IndexedDB is protected by the password-derived key |
| Admin provisioning API keys | Account data is per-user and private; admin uses Synapse admin API or a provisioning workflow |
| Man-in-the-middle | Synapse homeserver is HTTPS; encryption key derivation is local (never transmitted) |

---

## Migration Path for Existing Users

1. **Users with existing encryption passwords:** On first login to the new flow, prompt them to enter their old encryption password to migrate local data to the Synapse-derived key. After migration, the old password is no longer needed.
2. **Users with `type: 'none'` (skipped encryption):** On first Synapse login, encrypt their existing unencrypted IndexedDB data with the new derived key.
3. **Users with passkeys:** Passkey can remain as a session unlock method. On fresh login, Synapse password is still required. Passkey provides a faster unlock on return visits.

---

## Summary

| Before | After |
|--------|-------|
| 3 credentials (encryption pwd, API key, Synapse pwd) | 1 credential (Synapse pwd) |
| 3 screens on first use | 1 screen on first use |
| Synapse login optional | Synapse login required (the gate) |
| Encryption password chosen by user | Encryption derived from Synapse password |
| API key entered manually | API key provisioned via Matrix account data |
| Revoking access requires clearing API key + hoping user doesn't have local data | Revoking Synapse account blocks login, encryption key derivation, and API key access |
