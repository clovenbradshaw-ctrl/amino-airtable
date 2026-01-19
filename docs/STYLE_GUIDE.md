# Client Record UI Style Guide

A design specification for the case management interface, derived from the Client Record view.

---

## Design Philosophy

This interface follows a **card-based, information-dense** approach optimized for legal case workers who need to scan client information quickly. Key principles:

- **Scannable hierarchy**: Most important info (client identity) always visible at top
- **Progressive disclosure**: Counts visible immediately; details expand on interaction
- **Minimal chrome**: Let the data breathe; avoid decorative elements
- **Consistent affordances**: Same patterns for Cases, Events, Notes sections

---

## Color System

### Primary Palette

| Token | Hex | Usage |
|-------|-----|-------|
| `--blue-500` | `#3B82F6` | Primary actions, active states, links, count badges |
| `--blue-100` | `#DBEAFE` | Info banner background, hover states |
| `--blue-50` | `#EFF6FF` | Subtle highlights |

### Semantic Colors

| Token | Hex | Usage |
|-------|-----|-------|
| `--green-500` | `#22C55E` | Events badge, success states |
| `--amber-400` | `#FBBF24` | Warning, pending status |
| `--red-500` | `#EF4444` | Canceled, error, destructive |
| `--gray-900` | `#111827` | Primary text |
| `--gray-600` | `#4B5563` | Secondary text, labels |
| `--gray-400` | `#9CA3AF` | Tertiary text, timestamps |
| `--gray-200` | `#E5E7EB` | Borders, dividers |
| `--gray-50` | `#F9FAFB` | Page background |
| `--white` | `#FFFFFF` | Card backgrounds |

---

## Typography

Use **Inter** (or system sans-serif fallback).

| Element | Size | Weight | Color | Line Height |
|---------|------|--------|-------|-------------|
| Page title | 18px | 600 | `--gray-900` | 1.4 |
| Section header | 16px | 600 | `--gray-900` | 1.4 |
| Client name (banner) | 15px | 500 | `--gray-900` | 1.4 |
| Body text | 14px | 400 | `--gray-900` | 1.5 |
| Secondary/label | 13px | 400 | `--gray-600` | 1.4 |
| Tertiary/meta | 12px | 400 | `--gray-400` | 1.4 |
| Badge count | 13px | 600 | `--white` | 1 |

### Text Hierarchy Example

```
CLIENT NAME          ← 15px/500, gray-900
A#: 246-973-560      ← 14px/400, gray-600
Jan 3, 1992 (34yo)   ← 14px/400, gray-600
```

---

## Spacing System

Use an **8px base unit** with a 4px small increment.

| Token | Value | Usage |
|-------|-------|-------|
| `--space-1` | 4px | Tight gaps (icon to text) |
| `--space-2` | 8px | Inline element spacing |
| `--space-3` | 12px | Small component padding |
| `--space-4` | 16px | Card padding, standard gaps |
| `--space-5` | 20px | Section spacing |
| `--space-6` | 24px | Large section gaps |
| `--space-8` | 32px | Page section margins |

---

## Border & Shadow

| Property | Value |
|----------|-------|
| Border radius (cards) | 8px |
| Border radius (badges) | 9999px (full) |
| Border radius (buttons) | 6px |
| Border color | `--gray-200` |
| Card shadow | `0 1px 3px rgba(0,0,0,0.1)` |
| Card border | 1px solid `--gray-200` |

---

## Components

### 1. Page Header

```
┌─────────────────────────────────────────────────────────────────┐
│ Client Record          [Structured] Brief  Detailed  Timeline   │
│                                                    🔔  ⚙️       │
│ Last updated: Unknown (refreshing in 4:49)                      │
│                                        ┌────┐ ┌────┐ ┌────────┐ │
│                                        │1 case│1 event│44 notes│ │
│                                        └────┘ └────┘ └────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

**Tab Navigation:**
- Active: `--blue-500` background, white text, rounded-md
- Inactive: transparent background, `--gray-600` text
- Hover: `--gray-100` background

**Stat Pills:**
- Background: `--white`
- Border: 1px solid `--gray-200`
- Border radius: 9999px
- Padding: 4px 12px
- Font: 13px/500

### 2. Client Info Banner

A highlighted bar showing critical identifiers at a glance.

```
┌─────────────────────────────────────────────────────────────────┐
│ Orbegozo Arana, Eder │ A#: 246-973-560 │ Jan 3, 1992 │ Peru │   │
└─────────────────────────────────────────────────────────────────┘
```

- Background: `--blue-100`
- Text: `--gray-900`
- Padding: 12px 16px
- Border radius: 8px
- Separator: `│` character or 1px border in `--blue-200`

### 3. Client Card

```
┌─────────────────────────────────────────────────────────────────┐
│  ┌─┐  Client                                          ↗  ⚠     │
│  │C│  Orbegozo Arana, Eder                                      │
│  └─┘                                                            │
│                                                                 │
│  A#              DOB / AGE           COUNTRY      PHONE         │
│  246-973-560     Jan 3, 1992 (34yo)  Peru         (571) 524-... │
│                                                                 │
│  ADDRESS                                                        │
│  4302 Elliot Ct., Woodbridge, Virginia, 22193                   │
└─────────────────────────────────────────────────────────────────┘
```

**Avatar:**
- Size: 40px
- Background: `--blue-500`
- Text: white, 16px/600
- Border radius: 9999px

**Field Labels:**
- Text: `--gray-400`
- Font: 11px/500, uppercase, letter-spacing 0.5px

**Field Values:**
- Text: `--gray-900`
- Font: 14px/400

### 4. Section Card (Cases, Events, Notes)

```
┌─────────────────────────────────────────────────────────────────┐
│  (1)  Cases                                            ↗   ⚠   │
│       1 type                                                    │
├─────────────────────────────────────────────────────────────────┤
│  Other                                                       1  │
│                                                                 │
│  Sterling IM   Judge Chase Calder Cleveland                     │
└─────────────────────────────────────────────────────────────────┘
```

**Count Badge:**
- Size: 24px
- Border radius: 9999px
- Font: 13px/600, white
- Background: `--blue-500` (Cases, Notes) or `--green-500` (Events)

**Section Header:**
- Title: 16px/600, `--gray-900`
- Subtitle: 13px/400, `--gray-500`

**Action Icons:**
- Size: 20px
- Color: `--gray-400`
- Hover: `--gray-600`

### 5. Event Item

```
┌─────────────────────────────────────────────────────────────────┐
│  ✕ Canceled ○ Individual │ Orbegozo Arana, Eder │      (past)  │
│  01/09/26 01:00 pm EST                                          │
│  When: Jan 9, 2026 at 12:00 PM   Where: Sterling IM   📅        │
└─────────────────────────────────────────────────────────────────┘
```

**Status Indicator:**
- Canceled: `--red-500` × icon
- Type badge: colored circle (Individual = `--amber-400`)

**Meta text:**
- Color: `--gray-400`
- Link color: `--blue-500`

### 6. Note Item

```
┌─────────────────────────────────────────────────────────────────┐
│  credit 33994964                                                │
│  Apr 22, 2024   Contact: Eder Orbegozo Arana                    │
│                                                                 │
│  New Payment amount of $500 to operating from Invoiced in...    │
│  Read more                                                      │
└─────────────────────────────────────────────────────────────────┘
```

**Note Title:** 14px/500, `--gray-900`
**Meta:** 13px/400, `--gray-500`
**Body:** 14px/400, `--gray-700`
**Read more:** 13px/500, `--blue-500`

---

## Iconography

Use **Phosphor Icons** (regular weight, 20px default).

| Function | Icon Name | Usage |
|----------|-----------|-------|
| External link | `ArrowSquareOut` | Open in new tab/window |
| Alert/Flag | `Flag` or `Warning` | Requires attention |
| Settings | `Gear` | Configuration |
| Calendar | `Calendar` | Date-related actions |
| Canceled | `X` | Canceled/removed status |
| Sort | `SortAscending` / `SortDescending` | List ordering |
| Expand | `CaretDown` | Expandable sections |
| Phone | `Phone` | Contact phone |
| Location | `MapPin` | Address |
| User | `User` | Contact/person |
| Case | `Folder` or `Briefcase` | Legal case |
| Notes | `Note` | Notes section |
| Events | `CalendarBlank` | Events/hearings |

### Icon Sizing

| Context | Size |
|---------|------|
| Inline with text | 16px |
| Card actions | 20px |
| Avatar fallback | 20px |
| Empty states | 48px |

### Icon Colors

- Default: `--gray-400`
- Hover: `--gray-600`
- Active: `--blue-500`
- Destructive: `--red-500`

---

## Interactive States

### Buttons

| State | Background | Border | Text |
|-------|------------|--------|------|
| Default | `--white` | `--gray-200` | `--gray-700` |
| Hover | `--gray-50` | `--gray-300` | `--gray-900` |
| Active | `--gray-100` | `--gray-300` | `--gray-900` |
| Primary | `--blue-500` | `--blue-500` | `--white` |
| Primary hover | `--blue-600` | `--blue-600` | `--white` |

### Links

- Default: `--blue-500`
- Hover: `--blue-600`, underline
- Visited: `--blue-700`

### Cards

- Default: white background, `--gray-200` border
- Hover: `box-shadow: 0 2px 8px rgba(0,0,0,0.08)`

---

## Layout Grid

```
┌────────────────────────────────────────────────────────────────────┐
│  HEADER                                                            │
├────────────────────────────────────────────────────────────────────┤
│  CLIENT BANNER (full width)                                        │
├────────────────────────────────────────────────────────────────────┤
│  CLIENT CARD (full width)                                          │
├───────────────────────────────┬────────────────────────────────────┤
│  CASES (50%)                  │  EVENTS (50%)                      │
├───────────────────────────────┴────────────────────────────────────┤
│  NOTES (full width)                                                │
└────────────────────────────────────────────────────────────────────┘
```

- Max content width: 1200px
- Side padding: 24px (desktop), 16px (mobile)
- Section gap: 16px
- Card internal padding: 16px

---

## Responsive Breakpoints

| Breakpoint | Width | Adjustments |
|------------|-------|-------------|
| Desktop | ≥1024px | Two-column Cases/Events |
| Tablet | 768-1023px | Stack Cases above Events |
| Mobile | <768px | Single column, smaller padding |

---

## Accessibility

- Minimum contrast ratio: 4.5:1 for text
- Focus indicators: 2px `--blue-500` outline, 2px offset
- Interactive elements: minimum 44px touch target
- Semantic HTML: proper heading hierarchy, landmark regions
- ARIA: label expandable sections, announce dynamic updates

---

## Code Examples

### Tailwind Config (excerpt)

```js
module.exports = {
  theme: {
    extend: {
      colors: {
        blue: {
          50: '#EFF6FF',
          100: '#DBEAFE',
          500: '#3B82F6',
          600: '#2563EB',
        },
        // ... rest of palette
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
}
```

### Badge Component

```tsx
import { Icon } from '@phosphor-icons/react';

interface BadgeProps {
  count: number;
  variant: 'blue' | 'green';
}

export function CountBadge({ count, variant }: BadgeProps) {
  const bg = variant === 'green' ? 'bg-green-500' : 'bg-blue-500';
  return (
    <span className={`${bg} text-white text-sm font-semibold
      w-6 h-6 rounded-full flex items-center justify-center`}>
      {count}
    </span>
  );
}
```

### Section Header

```tsx
import { ArrowSquareOut, Flag } from '@phosphor-icons/react';

interface SectionHeaderProps {
  title: string;
  subtitle: string;
  count: number;
  variant?: 'blue' | 'green';
}

export function SectionHeader({ title, subtitle, count, variant = 'blue' }: SectionHeaderProps) {
  return (
    <div className="flex items-center justify-between py-3 px-4 border-b border-gray-200">
      <div className="flex items-center gap-3">
        <CountBadge count={count} variant={variant} />
        <div>
          <h3 className="text-base font-semibold text-gray-900">{title}</h3>
          <p className="text-sm text-gray-500">{subtitle}</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button className="p-1 text-gray-400 hover:text-gray-600">
          <ArrowSquareOut size={20} />
        </button>
        <button className="p-1 text-gray-400 hover:text-gray-600">
          <Flag size={20} />
        </button>
      </div>
    </div>
  );
}
```

---

## File Structure Suggestion

```
src/
├── components/
│   ├── ui/
│   │   ├── Badge.tsx
│   │   ├── Card.tsx
│   │   ├── Button.tsx
│   │   └── Avatar.tsx
│   ├── client/
│   │   ├── ClientBanner.tsx
│   │   ├── ClientCard.tsx
│   │   ├── CasesSection.tsx
│   │   ├── EventsSection.tsx
│   │   └── NotesSection.tsx
│   └── layout/
│       ├── PageHeader.tsx
│       └── TabNavigation.tsx
├── styles/
│   └── tokens.css
└── lib/
    └── icons.ts  # Phosphor icon exports
```
