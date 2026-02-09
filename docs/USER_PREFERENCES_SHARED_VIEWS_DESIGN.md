# User Preferences & Shared Views Design

## Overview

User preferences are stored per-Synapse-account, making them portable across devices and sessions. Views start as personal (private to the creator) and can be shared with specific people or the entire organization.

---

## Storage Architecture

### Two-Layer Persistence

All user data uses a **local-first, remote-sync** pattern:

| Layer | Technology | Purpose | Availability |
|-------|-----------|---------|-------------|
| **Local** | IndexedDB (`userPreferences`, `sharedViews` stores) | Fast reads, offline access | Always |
| **Remote** | Matrix account data + room state events | Cross-device sync, source of truth | When logged into Synapse |

On boot, the app loads from local first (instant), then merges with remote data when Synapse is available.

---

## User Preferences

**Storage**: Matrix account data type `law.firm.user.preferences`

User preferences are private per-user data stored in Matrix account data. They are never visible to other users.

### Preference Keys

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `theme` | `'dark' \| 'light'` | `'dark'` | UI theme |
| `sidebarCollapsed` | `boolean` | `false` | Sidebar collapsed state |
| `defaultTableId` | `string \| null` | `null` | Table to show on app load |
| `defaultViewId` | `string \| null` | `null` | View to show on app load |
| `tableSettings` | `object` | `{}` | Table visibility, ordering, view public/private flags |
| `recentTables` | `string[]` | `[]` | Recently accessed table IDs |
| `pinnedViews` | `string[]` | `[]` | Pinned view IDs |
| `gridDensity` | `'compact' \| 'comfortable' \| 'spacious'` | `'comfortable'` | Grid row height |
| `pageSize` | `number` | `100` | Records per page |
| `dateFormat` | `'relative' \| 'absolute' \| 'iso'` | `'relative'` | Date display format |
| `timezone` | `string \| null` | `null` | Timezone (null = browser) |

### API

```javascript
// Read
UserPreferences.get('theme')          // → 'dark'
UserPreferences.getAll()              // → { theme: 'dark', ... }

// Write (auto-saves to local + remote after 2s debounce)
UserPreferences.set('theme', 'light')
UserPreferences.setMultiple({ theme: 'light', pageSize: 50 })

// Manual save/load
await UserPreferences.save()
await UserPreferences.load()
```

---

## Shared Views

### Ownership Model

Every view has an owner (the creator's Matrix userId). The owner controls sharing.

```javascript
{
  tableId:     string,    // Table this view belongs to
  viewId:      string,    // View identifier
  ownerId:     string,    // Matrix userId of the creator (e.g., "@alice:amino.im")
  sharing:     string,    // 'private' | 'specific' | 'everyone'
  sharedWith:  string[],  // Matrix userIds (when sharing === 'specific')
  createdAt:   number,    // Unix timestamp
  updatedAt:   number,    // Unix timestamp
  // ... plus full view config (viewName, viewType, filters, sorts, etc.)
}
```

### Sharing Levels

| Level | Icon | Visible To | Storage |
|-------|------|-----------|---------|
| `private` | Lock | Owner only | Matrix account data (`law.firm.user.views`) |
| `specific` | People | Owner + listed users | Matrix room state event in org space |
| `everyone` | Globe | All org members | Matrix room state event in org space |

### Storage Details

**Private views** are stored in the user's Matrix account data under type `law.firm.user.views`. This data is only accessible to the owning user.

**Shared views** (`specific` or `everyone`) are published as Matrix room state events in the organization space:
- Event type: `law.firm.view.share`
- State key: `{tableId}|{viewId}`
- Content: Full view configuration + sharing metadata

This leverages Matrix's built-in visibility model — state events in a room are visible to all room members.

### Visibility Rules

When loading views for a table, the system checks:

1. **Owner always sees their own views** (regardless of sharing level)
2. **`everyone` views are visible to all org space members**
3. **`specific` views are only visible to listed userIds**
4. **`private` views are invisible to other users**

Views shared by others appear in the sidebar alongside the user's own views, with a sharing badge indicating the source.

### API

```javascript
// Set ownership on a newly created view
await SharedViews.setViewOwnership(tableId, viewId, ownerId)

// Share a view
await SharedViews.shareView(tableId, viewId, 'everyone', [])
await SharedViews.shareView(tableId, viewId, 'specific', ['@bob:amino.im', '@carol:amino.im'])

// Revert to private
await SharedViews.unshareView(tableId, viewId)

// Get sharing info
var info = await SharedViews.getViewSharing(tableId, viewId)
// → { ownerId: '@alice:amino.im', sharing: 'everyone', sharedWith: [], ... }

// Get all views visible to current user for a table
var views = await SharedViews.getVisibleViewsForTable(tableId)

// Get org members for the sharing picker
var members = await SharedViews.getOrgMembers()

// Display helpers
SharedViews.getSharingLabel(viewData)  // → "Shared with everyone"
SharedViews.getSharingIcon(viewData)   // → globe icon HTML
```

---

## UI Integration

### Create View Modal

The create view modal now includes a **Visibility** dropdown:
- **Private (only you)** — default
- **Shared with everyone**

For more granular sharing (specific users), use the **Share View** dialog after creation.

### View Context Menu

Right-click a view to see:
- **Share view...** — Opens the Share View modal
- The label dynamically updates to show current sharing status

### Share View Modal

A dedicated modal for managing sharing:
1. **Radio buttons** for Private / Specific People / Everyone
2. **User picker** (when "Specific People" selected) showing all org members
3. Current owner displayed at the top

### Sidebar Badges

Views show a sharing badge in the sidebar:
- No badge = private (default)
- Globe icon = shared with everyone
- People icon = shared with specific users

---

## Data Flow

### Creating a View

```
User clicks "Create View" → submitCreateView()
  → saveView() (IndexedDB)
  → SharedViews.setViewOwnership() (sets creator as owner)
  → SharedViews.shareView() (if sharing !== 'private')
    → If 'everyone'/'specific': publishes state event to org space
    → If 'private': syncs to Matrix account data
  → loadTableViewsAsync() (refreshes sidebar with sharing badges)
```

### Changing Sharing

```
User opens Share View modal → submitShareView()
  → SharedViews.shareView(tableId, viewId, newLevel, userIds)
    → Updates local IndexedDB
    → If was private → now shared: publishes state event to org space
    → If was shared → now private: removes state event from org space
    → Syncs private view list to account data
  → loadTableViewsAsync() (refreshes sidebar)
```

### App Boot (Loading Shared Views)

```
init()
  → UserPreferences.load()
    → Load from IndexedDB (instant)
    → Merge from Matrix account data (when online)
  → SharedViews.load()
    → Load from IndexedDB (instant)
    → Merge private views from account data (law.firm.user.views)
    → Merge shared views from org space state events (law.firm.view.share)
    → Save merged result to IndexedDB
```

---

## Matrix Event Types

| Event Type | Usage | Storage |
|-----------|-------|---------|
| `law.firm.user.preferences` | User preferences | Account data |
| `law.firm.user.views` | Private view list | Account data |
| `law.firm.view.share` | Shared view config | Room state (org space) |

---

## Security Considerations

| Concern | Mitigation |
|---------|-----------|
| Users seeing others' private views | Private views stored in account data (Matrix guarantees per-user privacy) |
| Unauthorized sharing | Only the view owner can change sharing level |
| Shared view tampering | Matrix room state events are governed by power levels; only staff+ can send `law.firm.view.share` events |
| Offline access | Local IndexedDB cache provides offline access to last-synced state |
| Stale shared views | On each boot, shared views are re-fetched from org space state events |

---

## Future Enhancements

1. **View forking**: Allow users to duplicate a shared view and customize it privately
2. **View versioning**: Track changes to shared views over time
3. **Notifications**: Alert users when a shared view they use is modified
4. **Permissions**: Separate "can view" vs "can edit" sharing levels
5. **View templates**: Org-wide default views that auto-apply to new users
