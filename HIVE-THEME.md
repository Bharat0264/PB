# Hive theme: admin portal + warehouse panel

The admin portal (`/admin-preview.html`, `/admin.html`) and the warehouse panel (`/warehouse`)
now use the same "Hive" claymorphism system as the delivery partner portal: white and honey
yellow (Sun Hive) and a designed deep-brown/amber night theme (Moon Hive).

## Theme only

No text, label, menu item, tab, column, field, button, card, chart, data, route, permission or
feature was added, removed, renamed or reordered. No business logic, API call, state, validation,
printer connection, print-on-command behaviour or price/fee editing was touched: `admin-dashboard.js`,
`admin-data.js`, `operations.js`, `warehouse.js`, `portal-login.js` and the existing stylesheets are
unchanged. The theme is a set of override layers loaded after the existing CSS.

Verified by diffing the rendered page text (visible text, aria-labels, placeholders, titles, alt
text, option labels and input values) of 17 views at 1920/1440/1024/768/390 in both themes
(180 captures) before and after: 170 are byte-identical; the other 10 (live admin order rows)
contain the same characters and differ only in a line break, because row buttons are now
right-aligned. All existing `[hidden]` states are respected.

## Files

New
- `hive-theme.css`: shared tokens (Sun + Moon), clay shadow levels, honeycomb background, sun/moon switch, glide indicator, motion keyframes.
- `hive-theme.js`: applies the saved theme before first paint (no flash; pages without a toggle follow the device setting), adds decorative hooks (page class, switch class, gliding nav indicator), and plays a circular View-Transition reveal by replaying the existing toggle's own click. Presentation only.
- `admin-hive.css`: admin dashboard layer (shell, KPI tiles, charts palette, tables, controls, dialogs, skeletons, responsive rail/tab bar).
- `admin-live-hive.css`: live admin layer (sticky bar, 12-column card grid, hero overview, table-like rows, grouped pricing settings card).
- `warehouse-hive.css`: warehouse layer (bigger type, 52px+ targets, status edge accents on order cards, high-visibility printer indicator and print button with a pulsing honey ring while printing).
- `docs/hive-retheme/before`, `docs/hive-retheme/after`: screenshots.

Changed (one line each, no content)
- `admin-preview.html`, `admin.html`, `staff.html`: `<link>`/`<script>` tags for the files above.
- `server.py`: the five new static files added to the allowlist.

## Notes

- The warehouse rail stays a 72px icon rail (its labels are hidden tooltips in the original; a
  264px labelled sidebar would change the rendered text).
- The live admin and warehouse pages have no theme toggle, so they follow the device's light/dark
  setting, or the choice saved in the admin dashboard on the same device.
- Screenshots: every view at 1440 in both themes; Dashboard, Orders, live admin, warehouse Home,
  Print Queue and the open order station at all five widths in both themes. "Before" night shots
  exist only for the admin dashboard; the warehouse and live admin had no night theme.
- Contrast: key text/background pairs measure 5.8:1 to 16.9:1 (WCAG AA) in both themes.
