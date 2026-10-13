---
name: Recharge dialog UI
description: User preference for sizing the recharge panel and amount choices.
---

Keep the recharge panel wide, close to the screen edges; shrink the amount-choice buttons rather than their number labels. Keep the numbers at their original visual size. Never use “Depositar” for this flow; use “Recarregar” for actions and “Recarga” for headings. The hosted checkout must not have an extra visible heading or selected amount, and must remain centered with space below it.

**Why:** The user corrected the distinction between quick-amount labels and button size, and explicitly requested the recharge wording and a checkout without extra heading text or edge contact.

**How to apply:** For future recharge-panel changes, preserve the large panel footprint, reduce button height/padding before changing label typography, omit custom checkout headings and the selected amount, and keep the centered layout with side and bottom insets.

When a user says a number was entered but rejected, investigate the system validation before suggesting a different input format. The storefront's inline browser script is embedded in a server-side JavaScript template literal, so verify the rendered script, not just the source.

**Why:** The user clarified that the failure was in the system. A single-backslash `\d` in the source was consumed by the outer template, so the generated browser validator rejected all phone numbers.

**How to apply:** When changing inline storefront JavaScript, test the response HTML and execute the actual submit handler. Prefer `[0-9]` and `[^0-9]` over `\d` and `\D` in embedded regexes.
