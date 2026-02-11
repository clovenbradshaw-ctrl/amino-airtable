// ============================================================================
// Matrix CS API Client Module
// Direct Matrix Client-Server API integration for Amino Airtable
// No SDK dependency — uses fetch against the Matrix CS API
// ============================================================================

var MatrixClient = (function() {
    'use strict';

    // ============ Internal State ============
    var _homeserverUrl = null;
    var _accessToken = null;
    var _userId = null;
    var _deviceId = null;
    var _syncToken = null;
    var _syncAbort = null;
    var _syncRunning = false;
    var _rooms = {}; // roomId -> { state: {}, timeline: [] }
    var _listeners = {}; // eventType -> [callback]

    // ============ Rate Limiting ============
    var _rateLimitUntil = 0; // Timestamp: no requests before this time
    var _requestQueue = Promise.resolve(); // Serializes requests to avoid bursts

    // ============ Configuration ============
    var CONFIG_KEY = 'matrix_config';
    var SESSION_KEY = 'matrix_session';

    // Custom event types
    var EVENT_TYPES = {
        ORG_CONFIG: 'law.firm.org.config',
        ORG_MEMBER: 'law.firm.org.member',
        SCHEMA_TABLE: 'law.firm.schema.table',
        SCHEMA_FIELD: 'law.firm.schema.field',
        SCHEMA_OBJECT: 'law.firm.schema.object',
        VAULT_METADATA: 'law.firm.vault.metadata',
        RECORD: 'law.firm.record',
        RECORD_MUTATE: 'law.firm.record.mutate',
        RECORD_CREATE: 'law.firm.record.create',
        RECORD_UPDATE: 'law.firm.record.update',
        RECORD_DELETE: 'law.firm.record.delete',
        VIEW: 'law.firm.view',
        VIEW_SHARE: 'law.firm.view.share',
        USER_PREFERENCES: 'law.firm.user.preferences',
        INTERFACE: 'law.firm.interface',
        CLIENT_MESSAGE: 'law.firm.client.message',
        NOTE_INTERNAL: 'law.firm.note.internal',
        MIGRATION_HISTORY: 'law.firm.migration.history',
        BRIDGE_CONFIG: 'law.firm.bridge.config'
    };

    // Power levels
    var POWER_LEVELS = {
        ADMIN: 100,
        STAFF: 50,
        CLIENT: 10,
        DEFAULT: 0
    };

    // Users that are always treated as admins regardless of room power levels
    var ADMIN_USERNAMES = ['admin'];

    // ============ HTTP Helpers ============

    async function _request(method, path, body, queryParams) {
        if (!_homeserverUrl) throw new Error('Not connected to homeserver');

        var url = _homeserverUrl + '/_matrix/client/v3' + path;
        if (queryParams) {
            var params = new URLSearchParams(queryParams);
            url += '?' + params.toString();
        }

        var headers = { 'Content-Type': 'application/json' };
        if (_accessToken) {
            headers['Authorization'] = 'Bearer ' + _accessToken;
        }

        var opts = { method: method, headers: headers };
        if (body !== undefined && body !== null) {
            opts.body = JSON.stringify(body);
        }

        var response = await fetch(url, opts);

        // Check for non-JSON responses (e.g. HTML error pages from reverse proxies)
        var contentType = response.headers.get('content-type') || '';
        if (contentType && !contentType.includes('application/json')) {
            var preview = '';
            try { preview = (await response.text()).substring(0, 120); } catch (e) {}
            var err = new Error(
                'Matrix API returned non-JSON response for ' + path +
                ' (HTTP ' + response.status + ', content-type: ' + contentType + ').' +
                (preview.indexOf('<html') !== -1 || preview.indexOf('<!DOCTYPE') !== -1
                    ? ' The homeserver may be down or the URL may be incorrect.'
                    : '')
            );
            err.httpStatus = response.status;
            throw err;
        }

        var data;
        try {
            data = await response.json();
        } catch (parseErr) {
            var err = new Error(
                'Invalid JSON from Matrix API for ' + path +
                ' (HTTP ' + response.status + '). The homeserver may be misconfigured.'
            );
            err.httpStatus = response.status;
            throw err;
        }

        if (!response.ok) {
            var err = new Error(data.error || 'Matrix API error');
            err.errcode = data.errcode;
            err.httpStatus = response.status;
            if (data.retry_after_ms !== undefined) {
                err.retryAfterMs = data.retry_after_ms;
            }
            throw err;
        }

        return data;
    }

    async function _requestWithRetry(method, path, body, queryParams, retries) {
        retries = retries || 5;
        // Queue requests so only one is in-flight at a time during bursts
        var result;
        var error;
        _requestQueue = _requestQueue.then(async function() {
            for (var attempt = 0; attempt <= retries; attempt++) {
                // Wait for any global rate-limit cooldown before sending
                var waitUntil = _rateLimitUntil - Date.now();
                if (waitUntil > 0) {
                    await new Promise(function(r) { setTimeout(r, waitUntil); });
                }
                try {
                    result = await _request(method, path, body, queryParams);
                    return;
                } catch (err) {
                    var isRetryable = err.httpStatus >= 500 || !err.httpStatus || err.httpStatus === 429;
                    if (attempt < retries && isRetryable) {
                        var delay = err.retryAfterMs || Math.pow(2, attempt) * 1000;
                        // On 429, set global cooldown so queued requests also wait
                        if (err.httpStatus === 429) {
                            _rateLimitUntil = Date.now() + delay;
                        }
                        await new Promise(function(r) { setTimeout(r, delay); });
                    } else {
                        error = err;
                        return;
                    }
                }
            }
        });
        await _requestQueue;
        if (error) throw error;
        return result;
    }

    // ============ Authentication ============

    async function login(homeserverUrl, username, password) {
        _homeserverUrl = homeserverUrl.replace(/\/$/, '');

        var body = {
            type: 'm.login.password',
            identifier: {
                type: 'm.id.user',
                user: username
            },
            password: password,
            initial_device_display_name: 'Amino Airtable'
        };

        var data = await _request('POST', '/login', body);

        _accessToken = data.access_token;
        _userId = data.user_id;
        _deviceId = data.device_id;

        _saveSession();

        return {
            userId: _userId,
            deviceId: _deviceId,
            accessToken: _accessToken
        };
    }

    async function logout() {
        if (_accessToken) {
            try {
                await _request('POST', '/logout');
            } catch (e) {
                // Ignore logout errors
            }
        }
        _accessToken = null;
        _userId = null;
        _deviceId = null;
        _syncToken = null;
        _rooms = {};
        _clearSession();
    }

    function isLoggedIn() {
        return !!_accessToken;
    }

    function getUserId() {
        return _userId;
    }

    function getHomeserverUrl() {
        return _homeserverUrl;
    }

    function getAccessToken() {
        return _accessToken;
    }

    // ============ Session Persistence ============

    function _saveSession() {
        try {
            sessionStorage.setItem(SESSION_KEY, JSON.stringify({
                homeserverUrl: _homeserverUrl,
                accessToken: _accessToken,
                userId: _userId,
                deviceId: _deviceId,
                syncToken: _syncToken
            }));
        } catch (e) {
            console.warn('[Matrix] Could not save session:', e);
        }
    }

    function _clearSession() {
        sessionStorage.removeItem(SESSION_KEY);
    }

    function restoreSession() {
        try {
            var stored = sessionStorage.getItem(SESSION_KEY);
            if (!stored) return false;
            var session = JSON.parse(stored);
            if (session.accessToken && session.homeserverUrl && session.userId) {
                _homeserverUrl = session.homeserverUrl;
                _accessToken = session.accessToken;
                _userId = session.userId;
                _deviceId = session.deviceId;
                _syncToken = session.syncToken || null;
                return true;
            }
        } catch (e) {
            console.warn('[Matrix] Could not restore session:', e);
        }
        return false;
    }

    function setSession(homeserverUrl, accessToken, userId, deviceId) {
        _homeserverUrl = homeserverUrl.replace(/\/$/, '');
        _accessToken = accessToken;
        _userId = userId;
        _deviceId = deviceId;
        _syncToken = null;
        _saveSession();
    }

    // ============ Persistent Config (survives tab close) ============

    function saveConfig(config) {
        localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    }

    function loadConfig() {
        try {
            var stored = localStorage.getItem(CONFIG_KEY);
            return stored ? JSON.parse(stored) : null;
        } catch (e) {
            return null;
        }
    }

    function clearConfig() {
        localStorage.removeItem(CONFIG_KEY);
    }

    // ============ Room Management ============

    async function createRoom(opts) {
        var body = {
            visibility: 'private',
            preset: opts.preset || 'private_chat',
            name: opts.name,
            topic: opts.topic || undefined,
            initial_state: opts.initialState || [],
            creation_content: opts.creationContent || undefined,
            invite: opts.invite || undefined
        };

        // Clean undefined values
        Object.keys(body).forEach(function(k) {
            if (body[k] === undefined) delete body[k];
        });

        var data = await _requestWithRetry('POST', '/createRoom', body);
        return data.room_id;
    }

    async function createSpace(name, topic) {
        return createRoom({
            name: name,
            topic: topic,
            preset: 'private_chat',
            creationContent: { type: 'm.space' },
            initialState: [{
                type: 'm.room.history_visibility',
                state_key: '',
                content: { history_visibility: 'shared' }
            }]
        });
    }

    async function addChildToSpace(spaceId, childRoomId, suggested) {
        await sendStateEvent(spaceId, 'm.space.child', childRoomId, {
            via: [_userId.split(':')[1]],
            suggested: suggested !== false
        });
    }

    async function setRoomParentSpace(roomId, spaceId) {
        await sendStateEvent(roomId, 'm.space.parent', spaceId, {
            via: [_userId.split(':')[1]],
            canonical: true
        });
    }

    async function inviteUser(roomId, userId) {
        await _requestWithRetry('POST', '/rooms/' + encodeURIComponent(roomId) + '/invite', {
            user_id: userId
        });
    }

    async function kickUser(roomId, userId, reason) {
        await _requestWithRetry('POST', '/rooms/' + encodeURIComponent(roomId) + '/kick', {
            user_id: userId,
            reason: reason || undefined
        });
    }

    async function joinRoom(roomId) {
        await _requestWithRetry('POST', '/join/' + encodeURIComponent(roomId));
    }

    async function leaveRoom(roomId) {
        await _requestWithRetry('POST', '/rooms/' + encodeURIComponent(roomId) + '/leave', {});
    }

    async function forgetRoom(roomId) {
        await _requestWithRetry('POST', '/rooms/' + encodeURIComponent(roomId) + '/forget', {});
    }

    async function removeSpaceChild(spaceId, childRoomId) {
        // Setting empty content effectively removes the child relationship
        await sendStateEvent(spaceId, 'm.space.child', childRoomId, {});
    }

    // ============ Power Levels ============

    async function getRoomPowerLevels(roomId) {
        var data = await _requestWithRetry('GET',
            '/rooms/' + encodeURIComponent(roomId) + '/state/m.room.power_levels/');
        return data;
    }

    async function setUserPowerLevel(roomId, userId, level) {
        var current = await getRoomPowerLevels(roomId);
        if (!current.users) current.users = {};
        current.users[userId] = level;
        await sendStateEvent(roomId, 'm.room.power_levels', '', current);
    }

    async function setRoomPowerLevels(roomId, config) {
        var powerLevels = {
            users: config.users || {},
            users_default: config.usersDefault !== undefined ? config.usersDefault : POWER_LEVELS.DEFAULT,
            events: config.events || {},
            events_default: config.eventsDefault !== undefined ? config.eventsDefault : POWER_LEVELS.STAFF,
            state_default: config.stateDefault !== undefined ? config.stateDefault : POWER_LEVELS.ADMIN,
            ban: POWER_LEVELS.ADMIN,
            kick: POWER_LEVELS.ADMIN,
            invite: POWER_LEVELS.ADMIN,
            redact: POWER_LEVELS.ADMIN
        };
        await sendStateEvent(roomId, 'm.room.power_levels', '', powerLevels);
    }

    function getMatterRoomPowerLevels(adminUserId) {
        var users = {};
        users[adminUserId] = POWER_LEVELS.ADMIN;

        return {
            users: users,
            usersDefault: POWER_LEVELS.DEFAULT,
            events: {
                [EVENT_TYPES.RECORD_CREATE]: POWER_LEVELS.STAFF,
                [EVENT_TYPES.RECORD_UPDATE]: POWER_LEVELS.STAFF,
                [EVENT_TYPES.RECORD_DELETE]: POWER_LEVELS.STAFF,
                [EVENT_TYPES.RECORD]: POWER_LEVELS.STAFF,
                [EVENT_TYPES.VIEW]: POWER_LEVELS.STAFF,
                [EVENT_TYPES.SCHEMA_TABLE]: POWER_LEVELS.ADMIN,
                [EVENT_TYPES.SCHEMA_FIELD]: POWER_LEVELS.ADMIN,
                [EVENT_TYPES.ORG_CONFIG]: POWER_LEVELS.ADMIN,
                [EVENT_TYPES.NOTE_INTERNAL]: POWER_LEVELS.STAFF,
                'm.room.power_levels': POWER_LEVELS.ADMIN,
                'm.room.member': POWER_LEVELS.ADMIN
            },
            eventsDefault: POWER_LEVELS.STAFF,
            stateDefault: POWER_LEVELS.ADMIN
        };
    }

    function getPortalRoomPowerLevels(adminUserId) {
        var users = {};
        users[adminUserId] = POWER_LEVELS.ADMIN;

        return {
            users: users,
            usersDefault: POWER_LEVELS.DEFAULT,
            events: {
                [EVENT_TYPES.RECORD]: POWER_LEVELS.STAFF,
                [EVENT_TYPES.RECORD_UPDATE]: POWER_LEVELS.STAFF,
                [EVENT_TYPES.CLIENT_MESSAGE]: POWER_LEVELS.CLIENT,
                [EVENT_TYPES.SCHEMA_TABLE]: POWER_LEVELS.ADMIN,
                [EVENT_TYPES.SCHEMA_FIELD]: POWER_LEVELS.ADMIN,
                'm.room.power_levels': POWER_LEVELS.ADMIN,
                'm.room.member': POWER_LEVELS.ADMIN
            },
            eventsDefault: POWER_LEVELS.STAFF,
            stateDefault: POWER_LEVELS.ADMIN
        };
    }

    // ============ State Events ============

    async function sendStateEvent(roomId, eventType, stateKey, content) {
        var path = '/rooms/' + encodeURIComponent(roomId) +
            '/state/' + encodeURIComponent(eventType) +
            '/' + encodeURIComponent(stateKey || '');
        return _requestWithRetry('PUT', path, content);
    }

    async function getStateEvent(roomId, eventType, stateKey) {
        var path = '/rooms/' + encodeURIComponent(roomId) +
            '/state/' + encodeURIComponent(eventType) +
            '/' + encodeURIComponent(stateKey || '');
        try {
            return await _request('GET', path);
        } catch (e) {
            if (e.httpStatus === 404) return null;
            throw e;
        }
    }

    async function getRoomState(roomId) {
        var path = '/rooms/' + encodeURIComponent(roomId) + '/state';
        return _requestWithRetry('GET', path);
    }

    // ============ Timeline Events ============

    async function sendEvent(roomId, eventType, content) {
        var txnId = 'm' + Date.now() + '.' + Math.random().toString(36).substr(2, 8);
        var path = '/rooms/' + encodeURIComponent(roomId) +
            '/send/' + encodeURIComponent(eventType) +
            '/' + encodeURIComponent(txnId);
        return _requestWithRetry('PUT', path, content);
    }

    async function getRoomMessages(roomId, opts) {
        opts = opts || {};
        var params = {
            dir: opts.dir || 'b', // backwards from most recent
            limit: opts.limit || 100
        };
        if (opts.from) params.from = opts.from;
        if (opts.filter) params.filter = JSON.stringify(opts.filter);

        return _requestWithRetry('GET',
            '/rooms/' + encodeURIComponent(roomId) + '/messages', null, params);
    }

    // ============ Sync ============

    async function initialSync() {
        var params = {
            timeout: '0',
            filter: JSON.stringify({
                room: {
                    state: { lazy_load_members: true },
                    timeline: { limit: 1 }
                }
            })
        };
        if (_syncToken) params.since = _syncToken;

        var data = await _requestWithRetry('GET', '/sync', null, params);
        _syncToken = data.next_batch;
        _saveSession();

        // Process joined rooms
        if (data.rooms && data.rooms.join) {
            Object.keys(data.rooms.join).forEach(function(roomId) {
                var room = data.rooms.join[roomId];
                if (!_rooms[roomId]) _rooms[roomId] = { state: {}, timeline: [] };

                // Process state events
                if (room.state && room.state.events) {
                    room.state.events.forEach(function(event) {
                        _processStateEvent(roomId, event);
                    });
                }

                // Process timeline events (may include state)
                if (room.timeline && room.timeline.events) {
                    room.timeline.events.forEach(function(event) {
                        if (event.state_key !== undefined) {
                            _processStateEvent(roomId, event);
                        }
                    });
                }
            });
        }

        return data;
    }

    function _processStateEvent(roomId, event) {
        if (!_rooms[roomId]) _rooms[roomId] = { state: {}, timeline: [] };
        var key = event.type + '|' + (event.state_key || '');
        _rooms[roomId].state[key] = event;
    }

    // ============ Room Queries ============

    function getJoinedRooms() {
        return Object.keys(_rooms);
    }

    function getRoomStateFromCache(roomId) {
        return _rooms[roomId] ? _rooms[roomId].state : {};
    }

    function getStateEventsOfType(roomId, eventType) {
        if (!_rooms[roomId]) return [];
        var result = [];
        var state = _rooms[roomId].state;
        Object.keys(state).forEach(function(key) {
            if (key.startsWith(eventType + '|')) {
                result.push(state[key]);
            }
        });
        return result;
    }

    function getCachedStateEvent(roomId, eventType, stateKey) {
        if (!_rooms[roomId]) return null;
        var key = eventType + '|' + (stateKey || '');
        return _rooms[roomId].state[key] || null;
    }

    // Get the room name from state
    function getRoomName(roomId) {
        var nameEvent = getCachedStateEvent(roomId, 'm.room.name', '');
        return nameEvent ? nameEvent.content.name : roomId;
    }

    // Get the room's creation content (to detect spaces)
    function isSpace(roomId) {
        var createEvent = getCachedStateEvent(roomId, 'm.room.create', '');
        return createEvent && createEvent.content && createEvent.content.type === 'm.space';
    }

    // Get child rooms of a space
    function getSpaceChildren(spaceId) {
        return getStateEventsOfType(spaceId, 'm.space.child')
            .filter(function(e) { return e.content && e.content.via; })
            .map(function(e) { return e.state_key; });
    }

    // ============ User Role Detection ============

    function _isHardcodedAdmin() {
        if (!_userId) return false;
        var localpart = _userId.split(':')[0].replace(/^@/, '');
        return ADMIN_USERNAMES.indexOf(localpart) !== -1;
    }

    async function detectUserRole(orgSpaceId) {
        // Hardcoded admin users always get admin role
        if (_isHardcodedAdmin()) return 'admin';

        try {
            var powerLevels = await getRoomPowerLevels(orgSpaceId);
            var level = (powerLevels.users && powerLevels.users[_userId]) || powerLevels.users_default || 0;

            if (level >= POWER_LEVELS.ADMIN) return 'admin';
            if (level >= POWER_LEVELS.STAFF) return 'staff';
            return 'client';
        } catch (e) {
            return 'unknown';
        }
    }

    async function getUserPowerLevel(roomId) {
        // Hardcoded admin users always get full admin power level
        if (_isHardcodedAdmin()) return POWER_LEVELS.ADMIN;

        try {
            var powerLevels = await getRoomPowerLevels(roomId);
            return (powerLevels.users && powerLevels.users[_userId]) || powerLevels.users_default || 0;
        } catch (e) {
            return 0;
        }
    }

    // ============ User Management ============

    async function getProfile(userId) {
        try {
            return await _request('GET', '/profile/' + encodeURIComponent(userId || _userId));
        } catch (e) {
            return null;
        }
    }

    async function setDisplayName(displayName) {
        await _request('PUT', '/profile/' + encodeURIComponent(_userId) + '/displayname', {
            displayname: displayName
        });
    }

    // ============ Account Data (Per-User Private Storage) ============

    async function setAccountData(type, content) {
        if (!_userId) throw new Error('Not logged in');
        var path = '/user/' + encodeURIComponent(_userId) + '/account_data/' + encodeURIComponent(type);
        return _requestWithRetry('PUT', path, content);
    }

    async function getAccountData(type) {
        if (!_userId) throw new Error('Not logged in');
        var path = '/user/' + encodeURIComponent(_userId) + '/account_data/' + encodeURIComponent(type);
        try {
            return await _request('GET', path);
        } catch (e) {
            if (e.httpStatus === 404) return null;
            throw e;
        }
    }

    async function setRoomAccountData(roomId, type, content) {
        if (!_userId) throw new Error('Not logged in');
        var path = '/user/' + encodeURIComponent(_userId) +
            '/rooms/' + encodeURIComponent(roomId) +
            '/account_data/' + encodeURIComponent(type);
        return _requestWithRetry('PUT', path, content);
    }

    async function getRoomAccountData(roomId, type) {
        if (!_userId) throw new Error('Not logged in');
        var path = '/user/' + encodeURIComponent(_userId) +
            '/rooms/' + encodeURIComponent(roomId) +
            '/account_data/' + encodeURIComponent(type);
        try {
            return await _request('GET', path);
        } catch (e) {
            if (e.httpStatus === 404) return null;
            throw e;
        }
    }

    // ============ Room Member Listing ============

    async function getRoomMembers(roomId) {
        var path = '/rooms/' + encodeURIComponent(roomId) + '/members';
        var data = await _requestWithRetry('GET', path);
        return (data.chunk || []).filter(function(e) {
            return e.content && e.content.membership === 'join';
        }).map(function(e) {
            return {
                userId: e.state_key,
                displayName: e.content.displayname || e.state_key,
                avatarUrl: e.content.avatar_url || null
            };
        });
    }

    // ============ Org Space Helpers ============

    async function findOrgSpace() {
        // Look through joined rooms for a space with law.firm.org.config state event
        var rooms = getJoinedRooms();
        for (var i = 0; i < rooms.length; i++) {
            var roomId = rooms[i];
            if (!isSpace(roomId)) continue;
            var orgConfig = getCachedStateEvent(roomId, EVENT_TYPES.ORG_CONFIG, '');
            if (orgConfig) return roomId;
        }
        return null;
    }

    async function createOrgSpace(orgName) {
        var spaceId = await createSpace(orgName, 'Organization space for ' + orgName);

        await sendStateEvent(spaceId, EVENT_TYPES.ORG_CONFIG, '', {
            version: '1',
            name: orgName,
            created_by: _userId,
            created_at: Date.now()
        });

        return spaceId;
    }

    // ============ Client Matter Helpers ============

    async function createClientSpace(orgSpaceId, clientName) {
        var spaceId = await createSpace(clientName, 'Client matter: ' + clientName);

        // Add client space as child of org space
        await addChildToSpace(orgSpaceId, spaceId);
        await setRoomParentSpace(spaceId, orgSpaceId);

        return spaceId;
    }

    async function createMatterRoom(clientSpaceId, clientName) {
        var roomId = await createRoom({
            name: clientName + ' — Matter',
            preset: 'private_chat',
            initialState: [{
                type: 'm.room.history_visibility',
                state_key: '',
                content: { history_visibility: 'shared' }
            }]
        });

        // Set power levels for matter room
        await setRoomPowerLevels(roomId, getMatterRoomPowerLevels(_userId));

        // Add to client space
        await addChildToSpace(clientSpaceId, roomId);
        await setRoomParentSpace(roomId, clientSpaceId);

        // Tag as matter room
        await sendStateEvent(roomId, 'law.firm.room.type', '', {
            type: 'matter',
            client_name: clientName
        });

        return roomId;
    }

    async function createPortalRoom(clientSpaceId, clientName) {
        var roomId = await createRoom({
            name: clientName + ' — Portal',
            preset: 'private_chat',
            initialState: [{
                type: 'm.room.history_visibility',
                state_key: '',
                content: { history_visibility: 'shared' }
            }]
        });

        // Set power levels for portal room
        await setRoomPowerLevels(roomId, getPortalRoomPowerLevels(_userId));

        // Add to client space
        await addChildToSpace(clientSpaceId, roomId);
        await setRoomParentSpace(roomId, clientSpaceId);

        // Tag as portal room
        await sendStateEvent(roomId, 'law.firm.room.type', '', {
            type: 'portal',
            client_name: clientName
        });

        return roomId;
    }

    // ============ Schema Helpers ============

    async function writeTableSchema(roomId, tableId, tableName, icon, clientVisible) {
        await sendStateEvent(roomId, EVENT_TYPES.SCHEMA_TABLE, tableId, {
            table_id: tableId,
            name: tableName,
            icon: icon || '',
            client_visible: clientVisible !== false
        });
    }

    async function writeFieldSchema(roomId, fieldId, fieldMeta) {
        var schemaContent = {
            field_id: fieldId,
            name: fieldMeta.fieldName || fieldId,
            table_id: fieldMeta.tableId,
            type: fieldMeta.fieldType || 'singleLineText',
            options: fieldMeta.options || {},
            client_visible: fieldMeta.client_visible !== false
        };
        if (fieldMeta.readOnly != null) schemaContent.readOnly = fieldMeta.readOnly;
        await sendStateEvent(roomId, EVENT_TYPES.SCHEMA_FIELD, fieldId, schemaContent);
    }

    // ============ Record Helpers ============

    async function writeRecord(roomId, tableId, recordId, data) {
        var stateKey = tableId + '|' + recordId;
        await sendStateEvent(roomId, EVENT_TYPES.RECORD, stateKey, {
            table_id: tableId,
            record_id: recordId,
            data: data
        });
    }

    async function writeRecordUpdate(roomId, tableId, recordId, changes, operator) {
        await sendEvent(roomId, EVENT_TYPES.RECORD_UPDATE, {
            table_id: tableId,
            record_id: recordId,
            fields: changes,
            operator: operator || 'ALT',
            timestamp: Date.now()
        });
    }

    async function getRecordsForTable(roomId, tableId) {
        var prefix = tableId + '|';
        var records = [];
        var stateEvents = getStateEventsOfType(roomId, EVENT_TYPES.RECORD);
        stateEvents.forEach(function(event) {
            if (event.state_key && event.state_key.startsWith(prefix)) {
                records.push(event.content);
            }
        });
        return records;
    }

    // Write projected (client-visible) record to portal room
    async function writeProjectedRecord(portalRoomId, tableId, recordId, fullData, fieldSchemas) {
        // Filter to only client-visible fields
        var projected = {};
        Object.keys(fullData).forEach(function(fieldId) {
            var schema = fieldSchemas[fieldId];
            if (!schema || schema.client_visible !== false) {
                projected[fieldId] = fullData[fieldId];
            }
        });

        await writeRecord(portalRoomId, tableId, recordId, projected);
    }

    // ============ EO Event Helpers (law.firm.schema.object) ============

    // Get vault room metadata (maps room to Airtable table)
    async function getVaultMetadata(roomId) {
        return getStateEvent(roomId, EVENT_TYPES.VAULT_METADATA, '');
    }

    // ============ Event Listener System ============

    function on(eventType, callback) {
        if (!_listeners[eventType]) _listeners[eventType] = [];
        _listeners[eventType].push(callback);
    }

    function off(eventType, callback) {
        if (!_listeners[eventType]) return;
        _listeners[eventType] = _listeners[eventType].filter(function(cb) {
            return cb !== callback;
        });
    }

    function _emit(eventType, data) {
        var cbs = _listeners[eventType] || [];
        cbs.forEach(function(cb) {
            try { cb(data); } catch (e) { console.error('[Matrix] Listener error:', e); }
        });
    }

    // ============ Public API ============

    return {
        // Constants
        EVENT_TYPES: EVENT_TYPES,
        POWER_LEVELS: POWER_LEVELS,

        // Auth
        login: login,
        logout: logout,
        isLoggedIn: isLoggedIn,
        getUserId: getUserId,
        getHomeserverUrl: getHomeserverUrl,
        getAccessToken: getAccessToken,
        restoreSession: restoreSession,
        setSession: setSession,

        // Config
        saveConfig: saveConfig,
        loadConfig: loadConfig,
        clearConfig: clearConfig,

        // Room management
        createRoom: createRoom,
        createSpace: createSpace,
        addChildToSpace: addChildToSpace,
        removeSpaceChild: removeSpaceChild,
        setRoomParentSpace: setRoomParentSpace,
        inviteUser: inviteUser,
        kickUser: kickUser,
        joinRoom: joinRoom,
        leaveRoom: leaveRoom,
        forgetRoom: forgetRoom,

        // Power levels
        getRoomPowerLevels: getRoomPowerLevels,
        setUserPowerLevel: setUserPowerLevel,
        setRoomPowerLevels: setRoomPowerLevels,
        getMatterRoomPowerLevels: getMatterRoomPowerLevels,
        getPortalRoomPowerLevels: getPortalRoomPowerLevels,

        // State events
        sendStateEvent: sendStateEvent,
        getStateEvent: getStateEvent,
        getRoomState: getRoomState,

        // Timeline events
        sendEvent: sendEvent,
        getRoomMessages: getRoomMessages,

        // Sync
        initialSync: initialSync,

        // Room queries
        getJoinedRooms: getJoinedRooms,
        getRoomStateFromCache: getRoomStateFromCache,
        getStateEventsOfType: getStateEventsOfType,
        getCachedStateEvent: getCachedStateEvent,
        getRoomName: getRoomName,
        isSpace: isSpace,
        getSpaceChildren: getSpaceChildren,

        // Role detection
        detectUserRole: detectUserRole,
        getUserPowerLevel: getUserPowerLevel,
        isHardcodedAdmin: _isHardcodedAdmin,
        ADMIN_USERNAMES: ADMIN_USERNAMES,

        // User management
        getProfile: getProfile,
        setDisplayName: setDisplayName,

        // Account data (per-user private storage)
        setAccountData: setAccountData,
        getAccountData: getAccountData,
        setRoomAccountData: setRoomAccountData,
        getRoomAccountData: getRoomAccountData,

        // Room members
        getRoomMembers: getRoomMembers,

        // Org helpers
        findOrgSpace: findOrgSpace,
        createOrgSpace: createOrgSpace,

        // Client matter helpers
        createClientSpace: createClientSpace,
        createMatterRoom: createMatterRoom,
        createPortalRoom: createPortalRoom,

        // Schema helpers
        writeTableSchema: writeTableSchema,
        writeFieldSchema: writeFieldSchema,

        // Record helpers
        writeRecord: writeRecord,
        writeRecordUpdate: writeRecordUpdate,
        getRecordsForTable: getRecordsForTable,
        writeProjectedRecord: writeProjectedRecord,

        // EO Event helpers
        getVaultMetadata: getVaultMetadata,

        // Events
        on: on,
        off: off
    };
})();

// ============================================================================
// Matrix Bridge Module
// Bridges between legacy Amino/Airtable APIs and Matrix rooms
// ============================================================================

var MatrixBridge = (function() {
    'use strict';

    // Bridge configuration (stored in org space config)
    var _config = {
        mode: 'setup', // 'setup' | 'bridge' | 'standalone'
        orgSpaceId: null,
        clientTable: null,       // which table ID represents clients
        clientIdentifierField: null, // which field ID identifies clients
        clientVisibleTables: [],
        clientHiddenTables: [],
        clientVisibleFields: {},  // tableId -> [fieldIds] that clients can see
        linkedRecordTables: {},   // tableId -> fieldId that links to client record
        clientRoomMap: {},        // clientIdentifierValue -> { spaceId, matterRoomId, portalRoomId }
        lastSyncCursor: 0,
        firmRoomId: null          // for non-client-specific data
    };

    function getConfig() { return _config; }

    function setConfig(config) {
        _config = Object.assign(_config, config);
    }

    // ============ Client Grouping ============

    function groupRecordsByClient(records, fields, clientTable, clientIdField, linkedRecordTables) {
        var groups = {}; // clientName -> { clientInfo: record, records: { tableId: [records] } }
        var unassigned = []; // records that don't belong to any client

        // First pass: collect client info records to build a lookup
        var clientLookup = {}; // record_id -> client identifier value
        records.forEach(function(rec) {
            if (rec.tableId === clientTable && rec.fields && rec.fields[clientIdField]) {
                var clientName = rec.fields[clientIdField];
                clientLookup[rec.recordId] = clientName;
                if (!groups[clientName]) {
                    groups[clientName] = { clientInfo: rec, records: {} };
                }
                if (!groups[clientName].records[clientTable]) {
                    groups[clientName].records[clientTable] = [];
                }
                groups[clientName].records[clientTable].push(rec);
            }
        });

        // Second pass: assign other records to clients via linked record fields
        records.forEach(function(rec) {
            if (rec.tableId === clientTable) return; // already handled

            var linkedField = linkedRecordTables[rec.tableId];
            if (!linkedField || !rec.fields) {
                unassigned.push(rec);
                return;
            }

            var linkedValue = rec.fields[linkedField];
            // linked record fields can be arrays of record IDs or a single ID
            var linkedIds = Array.isArray(linkedValue) ? linkedValue : [linkedValue];
            var assigned = false;

            for (var i = 0; i < linkedIds.length; i++) {
                var clientName = clientLookup[linkedIds[i]];
                if (clientName && groups[clientName]) {
                    if (!groups[clientName].records[rec.tableId]) {
                        groups[clientName].records[rec.tableId] = [];
                    }
                    groups[clientName].records[rec.tableId].push(rec);
                    assigned = true;
                    break;
                }
            }

            if (!assigned) {
                unassigned.push(rec);
            }
        });

        return { groups: groups, unassigned: unassigned };
    }

    // ============ Hydration: Legacy Data → Matrix Rooms ============

    async function hydrateToMatrix(amoData, schemas, onProgress) {
        if (!MatrixClient.isLoggedIn()) throw new Error('Not logged in to Matrix');
        if (!_config.orgSpaceId) throw new Error('No org space configured');

        onProgress = onProgress || function() {};

        var tables = schemas.tables; // META_TABLES
        var fields = schemas.fields; // META_FIELDS

        // Flatten records from amoData into a usable list
        var allRecords = [];
        var tableNames = Object.keys(amoData.tables);
        tableNames.forEach(function(fullTableName) {
            var tableId = fullTableName.replace('airtable:', '');
            var rows = amoData.tables[fullTableName];
            rows.forEach(function(row) {
                if (!row.record_id) return;
                var data = {};
                Object.keys(row).forEach(function(k) {
                    if (k !== 'record_id') data[k] = row[k];
                });
                allRecords.push({ tableId: tableId, recordId: row.record_id, fields: data });
            });
        });

        onProgress({ phase: 'grouping', total: allRecords.length });

        // Group records by client
        var grouped = groupRecordsByClient(
            allRecords,
            fields,
            _config.clientTable,
            _config.clientIdentifierField,
            _config.linkedRecordTables
        );

        var clientNames = Object.keys(grouped.groups);
        var totalClients = clientNames.length;
        var completedClients = 0;

        onProgress({ phase: 'creating_rooms', total: totalClients, completed: 0 });

        // Create firm-wide room for unassigned/reference data
        if (grouped.unassigned.length > 0 && !_config.firmRoomId) {
            var firmRoomId = await MatrixClient.createRoom({
                name: 'Firm Reference Data',
                preset: 'private_chat',
                initialState: [{
                    type: 'm.room.history_visibility',
                    state_key: '',
                    content: { history_visibility: 'shared' }
                }]
            });
            await MatrixClient.addChildToSpace(_config.orgSpaceId, firmRoomId);
            _config.firmRoomId = firmRoomId;

            // Write reference records
            for (var u = 0; u < grouped.unassigned.length; u++) {
                var rec = grouped.unassigned[u];
                await MatrixClient.writeRecord(firmRoomId, rec.tableId, rec.recordId, rec.fields);
                if (u % 5 === 4) await new Promise(function(r) { setTimeout(r, 200); });
            }
        }

        // For each client, create space + matter room + write data
        for (var c = 0; c < clientNames.length; c++) {
            var clientName = clientNames[c];
            var clientGroup = grouped.groups[clientName];

            onProgress({
                phase: 'hydrating_client',
                clientName: clientName,
                total: totalClients,
                completed: completedClients,
                recordCount: Object.values(clientGroup.records).reduce(function(sum, arr) { return sum + arr.length; }, 0)
            });

            // Create client space
            var clientSpaceId = await MatrixClient.createClientSpace(_config.orgSpaceId, clientName);

            // Create matter room (staff only)
            var matterRoomId = await MatrixClient.createMatterRoom(clientSpaceId, clientName);

            // Write table schemas to matter room
            var tableIds = Object.keys(clientGroup.records);
            for (var t = 0; t < tableIds.length; t++) {
                var tableId = tableIds[t];
                var tableMeta = tables[tableId] || { tableId: tableId, tableName: tableId };
                var isClientVisible = _config.clientVisibleTables.indexOf(tableId) !== -1;
                await MatrixClient.writeTableSchema(
                    matterRoomId, tableId, tableMeta.tableName, tableMeta.icon, isClientVisible
                );

                // Write field schemas
                var tableFields = fields[tableId] || {};
                var fieldIds = Object.keys(tableFields);
                for (var f = 0; f < fieldIds.length; f++) {
                    await MatrixClient.writeFieldSchema(matterRoomId, fieldIds[f], tableFields[fieldIds[f]]);
                    if (f % 5 === 4) await new Promise(function(r) { setTimeout(r, 200); });
                }
            }

            // Write records to matter room
            var recordTables = Object.keys(clientGroup.records);
            for (var rt = 0; rt < recordTables.length; rt++) {
                var recs = clientGroup.records[recordTables[rt]];
                for (var r = 0; r < recs.length; r++) {
                    await MatrixClient.writeRecord(
                        matterRoomId,
                        recs[r].tableId,
                        recs[r].recordId,
                        recs[r].fields
                    );
                    if (r % 5 === 4) await new Promise(function(r2) { setTimeout(r2, 200); });
                }
            }

            // Store room mapping
            _config.clientRoomMap[clientName] = {
                spaceId: clientSpaceId,
                matterRoomId: matterRoomId,
                portalRoomId: null // created later when admin enables portal access
            };

            completedClients++;
            onProgress({
                phase: 'hydrating_client',
                clientName: clientName,
                total: totalClients,
                completed: completedClients
            });
        }

        // Save bridge config to org space
        await _saveBridgeConfig();

        onProgress({ phase: 'complete', total: totalClients, completed: totalClients });

        return {
            clientsCreated: totalClients,
            unassignedRecords: grouped.unassigned.length
        };
    }

    // ============ Bulk Room Deletion ============

    async function deleteClientRooms(clientNames, onProgress) {
        onProgress = onProgress || function() {};
        var total = clientNames.length;
        var completed = 0;
        var failed = [];

        for (var i = 0; i < clientNames.length; i++) {
            var clientName = clientNames[i];
            var mapping = _config.clientRoomMap[clientName];

            onProgress({
                phase: 'deleting',
                clientName: clientName,
                total: total,
                completed: completed
            });

            if (!mapping) {
                failed.push({ clientName: clientName, error: 'No room mapping found' });
                completed++;
                continue;
            }

            try {
                // 1. Leave + forget portal room if it exists
                if (mapping.portalRoomId) {
                    try {
                        await MatrixClient.leaveRoom(mapping.portalRoomId);
                        await MatrixClient.forgetRoom(mapping.portalRoomId);
                    } catch (e) {
                        console.warn('[MatrixBridge] Could not leave portal room for ' + clientName + ':', e.message);
                    }
                }

                // 2. Leave + forget matter room
                if (mapping.matterRoomId) {
                    try {
                        await MatrixClient.leaveRoom(mapping.matterRoomId);
                        await MatrixClient.forgetRoom(mapping.matterRoomId);
                    } catch (e) {
                        console.warn('[MatrixBridge] Could not leave matter room for ' + clientName + ':', e.message);
                    }
                }

                // 3. Remove client space from org space and leave it
                if (mapping.spaceId) {
                    try {
                        if (_config.orgSpaceId) {
                            await MatrixClient.removeSpaceChild(_config.orgSpaceId, mapping.spaceId);
                        }
                        await MatrixClient.leaveRoom(mapping.spaceId);
                        await MatrixClient.forgetRoom(mapping.spaceId);
                    } catch (e) {
                        console.warn('[MatrixBridge] Could not leave client space for ' + clientName + ':', e.message);
                    }
                }

                // 4. Remove from clientRoomMap
                delete _config.clientRoomMap[clientName];

            } catch (e) {
                console.error('[MatrixBridge] Failed to delete rooms for ' + clientName + ':', e);
                failed.push({ clientName: clientName, error: e.message });
            }

            completed++;
            onProgress({
                phase: 'deleting',
                clientName: clientName,
                total: total,
                completed: completed
            });
        }

        // Save updated bridge config
        await _saveBridgeConfig();

        onProgress({
            phase: 'complete',
            total: total,
            completed: completed,
            failed: failed
        });

        return { deleted: completed - failed.length, failed: failed };
    }

    // ============ Config Persistence ============

    async function _saveBridgeConfig() {
        if (!_config.orgSpaceId || !MatrixClient.isLoggedIn()) return;
        try {
            await MatrixClient.sendStateEvent(
                _config.orgSpaceId,
                MatrixClient.EVENT_TYPES.BRIDGE_CONFIG,
                '',
                _config
            );
        } catch (e) {
            console.warn('[MatrixBridge] Could not save bridge config to Matrix:', e);
        }
        // Also save locally for fast access
        MatrixClient.saveConfig({ bridge: _config });
    }

    async function loadBridgeConfig(orgSpaceId) {
        try {
            var config = await MatrixClient.getStateEvent(
                orgSpaceId,
                MatrixClient.EVENT_TYPES.BRIDGE_CONFIG,
                ''
            );
            if (config) {
                _config = config;
                _config.orgSpaceId = orgSpaceId;
                return true;
            }
        } catch (e) {
            // No config yet
        }
        return false;
    }

    // ============ Portal Access Management ============

    async function enablePortalAccess(clientName, clientUserId) {
        var mapping = _config.clientRoomMap[clientName];
        if (!mapping) throw new Error('Client not found: ' + clientName);

        // Create portal room if it doesn't exist
        if (!mapping.portalRoomId) {
            mapping.portalRoomId = await MatrixClient.createPortalRoom(mapping.spaceId, clientName);

            // Write client-visible schemas to portal room
            var matterState = await MatrixClient.getRoomState(mapping.matterRoomId);
            for (var i = 0; i < matterState.length; i++) {
                var event = matterState[i];
                if (event.type === MatrixClient.EVENT_TYPES.SCHEMA_TABLE) {
                    if (event.content.client_visible) {
                        await MatrixClient.sendStateEvent(
                            mapping.portalRoomId,
                            event.type,
                            event.state_key,
                            event.content
                        );
                    }
                } else if (event.type === MatrixClient.EVENT_TYPES.SCHEMA_FIELD) {
                    if (event.content.client_visible !== false) {
                        await MatrixClient.sendStateEvent(
                            mapping.portalRoomId,
                            event.type,
                            event.state_key,
                            event.content
                        );
                    }
                } else if (event.type === MatrixClient.EVENT_TYPES.RECORD) {
                    var tblId = event.content.table_id;
                    if (_config.clientVisibleTables.indexOf(tblId) !== -1) {
                        // Project only client-visible fields
                        await MatrixClient.sendStateEvent(
                            mapping.portalRoomId,
                            event.type,
                            event.state_key,
                            event.content // TODO: filter fields
                        );
                    }
                }
            }
        }

        // Invite client and set power level
        await MatrixClient.inviteUser(mapping.portalRoomId, clientUserId);
        await MatrixClient.setUserPowerLevel(mapping.portalRoomId, clientUserId, MatrixClient.POWER_LEVELS.CLIENT);

        // Save updated config
        _config.clientRoomMap[clientName] = mapping;
        await _saveBridgeConfig();

        return mapping.portalRoomId;
    }

    async function disablePortalAccess(clientName, clientUserId) {
        var mapping = _config.clientRoomMap[clientName];
        if (!mapping || !mapping.portalRoomId) return;

        await MatrixClient.kickUser(mapping.portalRoomId, clientUserId, 'Portal access revoked');
    }

    // ============ Public API ============

    return {
        getConfig: getConfig,
        setConfig: setConfig,
        groupRecordsByClient: groupRecordsByClient,
        hydrateToMatrix: hydrateToMatrix,
        deleteClientRooms: deleteClientRooms,
        loadBridgeConfig: loadBridgeConfig,
        enablePortalAccess: enablePortalAccess,
        disablePortalAccess: disablePortalAccess
    };
})();
