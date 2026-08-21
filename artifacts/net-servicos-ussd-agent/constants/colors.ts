/**
 * Semantic design tokens for the mobile app.
 *
 * These tokens mirror the naming conventions used in web artifacts (index.css)
 * so that multi-artifact projects share a cohesive visual identity.
 *
 * Replace the placeholder values below with values that match the project's
 * brand. If a sibling web artifact exists, read its index.css and convert the
 * HSL values to hex so both artifacts use the same palette.
 *
 * To add dark mode, add a `dark` key with the same token names.
 * The useColors() hook will automatically pick it up.
 */

const colors = {
  light: {
    // Legacy aliases (kept for backward compatibility)
    text: '#1c1c1e',
    tint: '#cc0000',

    // Core surfaces
    background: '#f2f2f7',
    foreground: '#1c1c1e',

    // Cards / elevated surfaces
    card: '#ffffff',
    cardForeground: '#1c1c1e',

    // Primary action color (buttons, links, active states)
    primary: '#cc0000',
    primaryForeground: '#ffffff',

    // Secondary / less-emphasis interactive surfaces
    secondary: '#fff0f0',
    secondaryForeground: '#cc0000',

    // Muted / subdued elements (dividers, timestamps, placeholders)
    muted: '#f2f2f7',
    mutedForeground: '#636366',

    // Accent highlights (badges, selected items, focus rings)
    accent: '#ffe4e4',
    accentForeground: '#cc0000',

    // Destructive actions (delete, error states)
    destructive: '#cc0000',
    destructiveForeground: '#ffffff',

    // Borders and input outlines
    border: '#e5e5ea',
    input: '#c7c7cc',
  },

  // Border radius (in px). Sync from the sibling web artifact's --radius
  // CSS variable. This value applies to cards, buttons, inputs, and modals.
  radius: 8,
};

export default colors;
