// aminoSync.js - Client-side event sourcing with IndexedDB

const AminoSync = {
  db: null,
  apiBase: 'https://xvkq-pq7i-idtl.n7d.xano.io/api:nrIL-Oi-',

  // Initialize IndexedDB
  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('aminoStore', 1);

      request.onerror = () => reject(request.error);

      request.onupgradeneeded = (e) => {
        const db = e.target.result;

        // Snapshot store - current state of all records
        if (!db.objectStoreNames.contains('snapshot')) {
          const store = db.createObjectStore('snapshot', { keyPath: 'record_id' });
          store.createIndex('source_table', 'source_table');
          store.createIndex('last_amino_event', 'last_amino_event');
        }

        // Metadata store - sync state
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };
    });
  },

  // Bootstrap from Box snapshot file
  async bootstrap(snapshotUrl) {
    const response = await fetch(snapshotUrl);
    const records = await response.json();

    const tx = this.db.transaction(['snapshot', 'meta'], 'readwrite');
    const store = tx.objectStore('snapshot');
    const meta = tx.objectStore('meta');

    let maxEventId = 0;

    for (const record of records) {
      store.put(record);
      if (record.last_amino_event > maxEventId) {
        maxEventId = record.last_amino_event;
      }
    }

    meta.put({ key: 'last_synced_event', value: maxEventId });
    meta.put({ key: 'bootstrap_at', value: Date.now() });

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve({ records: records.length, lastEvent: maxEventId });
      tx.onerror = () => reject(tx.error);
    });
  },

  // Bootstrap from encrypted Box snapshot file
  async bootstrapEncrypted(encryptedSnapshotUrl, password) {
    const response = await fetch(encryptedSnapshotUrl);
    const encryptedData = await response.text();

    const records = await this.decrypt(encryptedData, password);

    const tx = this.db.transaction(['snapshot', 'meta'], 'readwrite');
    const store = tx.objectStore('snapshot');
    const meta = tx.objectStore('meta');

    let maxEventId = 0;

    for (const record of records) {
      store.put(record);
      if (record.last_amino_event > maxEventId) {
        maxEventId = record.last_amino_event;
      }
    }

    meta.put({ key: 'last_synced_event', value: maxEventId });
    meta.put({ key: 'bootstrap_at', value: Date.now() });

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve({ records: records.length, lastEvent: maxEventId });
      tx.onerror = () => reject(tx.error);
    });
  },

  // Incremental sync from Xano
  async sync() {
    const lastSynced = await this.getMeta('last_synced_event') || 0;

    const response = await fetch(
      `${this.apiBase}/aminosnapshot?last_amino_event_gt=${lastSynced}`
    );
    const updates = await response.json();

    if (updates.length === 0) return { updated: 0 };

    const tx = this.db.transaction(['snapshot', 'meta'], 'readwrite');
    const store = tx.objectStore('snapshot');
    const meta = tx.objectStore('meta');

    let maxEventId = lastSynced;

    for (const record of updates) {
      store.put(record);
      if (record.last_amino_event > maxEventId) {
        maxEventId = record.last_amino_event;
      }
    }

    meta.put({ key: 'last_synced_event', value: maxEventId });
    meta.put({ key: 'last_sync_at', value: Date.now() });

    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve({ updated: updates.length, lastEvent: maxEventId });
      tx.onerror = () => reject(tx.error);
    });
  },

  // Write: Create new record
  async create(recordId, sourceTable, data) {
    // 1. Post event to stream
    const event = {
      recordId,
      set: sourceTable,
      operator: 'INS',
      payload: { context: { data } },
      uuid: crypto.randomUUID()
    };

    const streamRes = await fetch(`${this.apiBase}/aminostream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });
    const { id: eventId } = await streamRes.json();

    // 2. Upsert snapshot
    const snapshotRecord = {
      record_id: recordId,
      source_table: sourceTable,
      data,
      last_amino_event: eventId
    };

    await fetch(`${this.apiBase}/aminosnapshot/record/${recordId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshotRecord)
    });

    // 3. Update local IndexedDB
    const tx = this.db.transaction('snapshot', 'readwrite');
    tx.objectStore('snapshot').put(snapshotRecord);

    return snapshotRecord;
  },

  // Write: Update existing record
  async update(recordId, sourceTable, changes) {
    // 1. Get current local state
    const current = await this.get(recordId);
    const newData = { ...(current?.data || {}), ...changes };

    // 2. Post event to stream
    const event = {
      recordId,
      set: sourceTable,
      operator: 'ALT',
      payload: { context: { data: changes } },
      uuid: crypto.randomUUID()
    };

    const streamRes = await fetch(`${this.apiBase}/aminostream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });
    const { id: eventId } = await streamRes.json();

    // 3. Upsert snapshot
    const snapshotRecord = {
      record_id: recordId,
      source_table: sourceTable,
      data: newData,
      last_amino_event: eventId
    };

    await fetch(`${this.apiBase}/aminosnapshot/record/${recordId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshotRecord)
    });

    // 4. Update local IndexedDB
    const tx = this.db.transaction('snapshot', 'readwrite');
    tx.objectStore('snapshot').put(snapshotRecord);

    return snapshotRecord;
  },

  // Write: Delete record
  async delete(recordId, sourceTable) {
    // 1. Post NUL event to stream
    const event = {
      recordId,
      set: sourceTable,
      operator: 'NUL',
      payload: { context: { reason: 'user_delete' } },
      uuid: crypto.randomUUID()
    };

    await fetch(`${this.apiBase}/aminostream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });

    // 2. Delete from snapshot
    await fetch(`${this.apiBase}/aminosnapshot/record/${recordId}`, {
      method: 'DELETE'
    });

    // 3. Remove from local IndexedDB
    const tx = this.db.transaction('snapshot', 'readwrite');
    tx.objectStore('snapshot').delete(recordId);

    return { deleted: recordId };
  },

  // Read: Get single record
  async get(recordId) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('snapshot', 'readonly');
      const request = tx.objectStore('snapshot').get(recordId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },

  // Read: Get all records by source_table
  async getByTable(sourceTable) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('snapshot', 'readonly');
      const index = tx.objectStore('snapshot').index('source_table');
      const request = index.getAll(sourceTable);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },

  // Read: Get all records
  async getAll() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('snapshot', 'readonly');
      const request = tx.objectStore('snapshot').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },

  // Helper: Get metadata
  async getMeta(key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('meta', 'readonly');
      const request = tx.objectStore('meta').get(key);
      request.onsuccess = () => resolve(request.result?.value);
      request.onerror = () => reject(request.error);
    });
  },

  // Start background sync (poll every N ms)
  startAutoSync(intervalMs = 30000) {
    this.syncInterval = setInterval(() => this.sync(), intervalMs);
    return this.sync(); // Run immediately
  },

  stopAutoSync() {
    if (this.syncInterval) clearInterval(this.syncInterval);
  },

  // ============================================
  // ENCRYPTION LAYER
  // ============================================

  // Derive encryption key from password using PBKDF2
  async deriveKey(password, salt) {
    const encoder = new TextEncoder();
    const passwordKey = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    );

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations: 100000,
        hash: 'SHA-256'
      },
      passwordKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  },

  // Encrypt data for Box snapshot file
  // Returns base64 string: salt (16 bytes) + iv (12 bytes) + ciphertext
  async encrypt(data, password) {
    const encoder = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));

    const key = await this.deriveKey(password, salt);

    const plaintext = encoder.encode(JSON.stringify(data));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      plaintext
    );

    // Combine salt + iv + ciphertext
    const combined = new Uint8Array(salt.length + iv.length + ciphertext.byteLength);
    combined.set(salt, 0);
    combined.set(iv, salt.length);
    combined.set(new Uint8Array(ciphertext), salt.length + iv.length);

    // Return as base64
    return btoa(String.fromCharCode(...combined));
  },

  // Decrypt data from encrypted Box snapshot file
  async decrypt(encryptedBase64, password) {
    // Decode base64
    const combined = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));

    // Extract salt, iv, ciphertext
    const salt = combined.slice(0, 16);
    const iv = combined.slice(16, 28);
    const ciphertext = combined.slice(28);

    const key = await this.deriveKey(password, salt);

    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );

    const decoder = new TextDecoder();
    return JSON.parse(decoder.decode(plaintext));
  },

  // Generate encrypted snapshot file content (for server-side export)
  async createEncryptedSnapshot(password) {
    const records = await this.getAll();
    return this.encrypt(records, password);
  }
};

export default AminoSync;
