# BlissWork Assets

Centralized location for all shared branding and UI assets.

## Contents

- **logo.png** - BlissWork brand logo (chat bubble "B" mark with blue-to-purple gradient)
  - Used across all apps: web, desktop, API documentation, etc.
  - Source: Single source of truth for brand identity
  - Do not modify without updating all downstream references

## Usage

```typescript
// In React/TypeScript components:
import { ASSETS } from './assets'
const logoUrl = ASSETS.logo

// In HTML:
<img src="/assets/logo.png" alt="BlissWork" />

// In CSS/Tailwind:
background-image: url(/assets/logo.png)
```

## Related Files

- `/apps/desktop/build/icon.svg` - Source SVG (can be regenerated if needed)
- `/packages/ui/src/components/Logo.tsx` - React logo component
