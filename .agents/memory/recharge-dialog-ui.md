---
name: Recharge dialog UI
description: User preference for sizing the recharge panel and amount choices.
---

Keep the recharge panel wide, close to the screen edges; shrink the amount-choice buttons rather than their number labels. Keep the numbers at their original visual size. Never use “Depositar” for this flow; use “Recarregar” for actions and “Recarga” for headings. The hosted checkout must not have an extra visible heading or selected amount, and must remain centered with space below it.

**Why:** The user corrected the distinction between quick-amount labels and button size, and explicitly requested the recharge wording and a checkout without extra heading text or edge contact.

**How to apply:** For future recharge-panel changes, preserve the large panel footprint, reduce button height/padding before changing label typography, omit custom checkout headings and the selected amount, and keep the centered layout with side and bottom insets.

The storefront's inline browser script is embedded in a server-side JavaScript template literal. Avoid browser regex escapes that the outer template can consume; verify the rendered script, not just the source file.

**Why:** Phone normalization appeared valid in the server source, but the generated browser script lost the `\D` escape and failed to remove spaces and country-code punctuation.

**How to apply:** When changing inline storefront JavaScript, test the response HTML and execute or parse the emitted script. Prefer `[0-9]` over `\D` where appropriate, or escape backslashes for the outer template.
