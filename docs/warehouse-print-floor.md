# Warehouse Print Floor changelog

| File | Changes |
| --- | --- |
| staff.html | Added sidebar controls, the theme toggle, keyboard reference, and print, pickup and arrival dialog markup. |
| warehouse.js | Connected the conveyor, job tickets, order station, printer and history views, display preferences and dialog controls to the existing warehouse data and actions. |
| warehouse-hive.css | Added the responsive grid, clay ticket and device shapes, tablet order drawer, and Sun Hive, Moon Hive and display styles. |

## Warehouse behavior

- The conveyor groups orders by their existing statuses. Handed over includes orders out for delivery and delivered orders.
- Printer progress counts sheets from completed print jobs. The print agent reports file-level completion.
- Live packing labels use the existing protected PDF endpoint. The partner portal confirms live pickup. Sample mode includes its own handover confirmation. Printer testing and pause controls run in Sample mode. For a live printer, use the warehouse workstation.
- The theme uses the existing Hive preference. Large text and High contrast are warehouse display preferences. The reduced-motion preference disables decorative animations.

## Verification

- Python unit suite passed all 15 tests.
- Lighthouse mobile accessibility scored 100 on the Mission control sample page.
- Chrome checks exercised queue filters, keyboard and drag-to-print, progress through Ready, sample handover, label preview, history CSV, printer pause and resume, the incoming-order countdown, display settings and the phone drawer.
- Captured six pages before and after at 2560, 1920, 1440, 1024 and 768 pixels in both themes. After screenshots also cover Large text with High contrast and five interaction states, including the 390-pixel drawer.
