// components/model-selector.tsx
"use client";

import type { Session } from "next-auth";

/**
 * ModelSelector is intentionally stubbed out so the model dropdown
 * ("Grok Vision", etc.) never renders. Keeping the same named export
 * avoids having to touch any other files that import it.
 */
type Props = {
  session: Session;
  selectedModelId: string;
  className?: string;
  // Accept any extra props callers might be passing (variant, onClick, etc.)
  // so TypeScript doesn't complain at call sites.
  [key: string]: unknown;
};

export function ModelSelector(_props: Props) {
  return null;
}
